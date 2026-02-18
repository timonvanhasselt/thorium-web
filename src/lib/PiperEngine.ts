/**
 * PiperEngine.ts
 */

declare function createPiperPhonemize(options: {
  print: (line: string) => void;
  locateFile?: (filename: string, prefix: string) => string;
}): Promise<{ callMain: (args: string[]) => number }>;

interface PcmData {
  samples: Float32Array;
  sampleRate: number;
  numChannels: number;
}

export interface PiperPhrase {
  phonemes: string[];
  silenceSeconds: number;
  textIndex: number;
}

export type PiperEngineState = "idle" | "loading" | "ready" | "error";

export interface PiperEngineEvents {
  onStateChange?: (state: PiperEngineState) => void;
  onSentenceStart?: (index: number) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
}

const DEFAULTS = {
  sentenceSilenceSeconds: 0.2,
  paragraphSilenceSeconds: 0.5,
  phonemeIdConfig: {
    pad: "_", bos: "^", eos: "$",
    interspersePad: true, addBos: true, addEos: true,
  },
};

// ─── PATH CONFIG ──────────────────────────────────────────────────────
const TTS_ROOT = "/tts/";
const TTS_VOICES = "/tts/voices/"; // Subdirectory for models
const VOICES_CONFIG_URL = "/tts/voices.json"; // Config is located in the root
const WORKER_URL = "/tts/inference-worker.js"; // Worker is located in the root

// ─── Worker RPC ───────────────────────────────────────────────────────────────

function makeWorkerRpc(worker: Worker) {
  const pending = new Map<string, {
    fulfill: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();

  worker.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || msg.type !== "response" || !msg.id) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error
      ? p.reject(typeof msg.error === "string" ? new Error(msg.error) : msg.error)
      : p.fulfill(msg.result);
  });

  return {
    request<T>(method: string, args: unknown, transfer: Transferable[] = []): Promise<T> {
      const id = String(Math.random());
      worker.postMessage(
        { to: "piper-worker", type: "request", id, method, args },
        transfer
      );
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { fulfill: resolve as (v: unknown) => void, reject });
      });
    },
  };
}

// ─── Audio playback ───────────────────────────────────────────────────────────

function playPcmData(
  pcmData: PcmData,
  ctx: AudioContext,
  gainNode: GainNode,
  silenceSeconds: number
) {
  const { samples, sampleRate, numChannels } = pcmData;
  const frameCount = samples.length / numChannels;
  const totalFrames = frameCount + Math.floor(silenceSeconds * sampleRate);
  const buffer = ctx.createBuffer(numChannels, totalFrames, sampleRate);

  let peak = 0;
  for (let ch = 0; ch < numChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < frameCount; i++) {
      const s = samples[i * numChannels + ch];
      channelData[i] = s;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
  }
  gainNode.gain.value = 1.0 / Math.max(0.01, peak);

  return playBuffer(ctx, gainNode, buffer, 1.0, 0);
}

function playBuffer(
  ctx: AudioContext,
  gainNode: GainNode,
  buffer: AudioBuffer,
  playbackRate: number,
  offset: number
) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = playbackRate;
  source.connect(gainNode);

  const startTime = ctx.currentTime - offset;
  const completePromise = new Promise<void>((resolve) => {
    source.onended = () => resolve();
  });
  source.start(0, offset);

  return {
    completePromise,
    pause() {
      source.onended = null;
      try { source.stop(); } catch (_) {}
      source.disconnect();
      const pausedAt = ctx.currentTime - startTime;
      return { resume: () => playBuffer(ctx, gainNode, buffer, playbackRate, pausedAt) };
    },
  };
}

// ─── PiperEngine ──────────────────────────────────────────────────────────────

export class PiperEngine {
  private worker: Worker | null = null;
  private rpc: ReturnType<typeof makeWorkerRpc> | null = null;
  private engineId: string | null = null;
  private modelConfig: Record<string, unknown> | null = null;

  private callMain: ((args: string[]) => number) | null = null;
  private currentOutput: unknown[] = [];

  private audioCtx: AudioContext | null = null;
  private gainNode: GainNode | null = null;

  private _state: PiperEngineState = "idle";
  private _readyPromise: Promise<void> | null = null;
  private cancelRequested = false;
  private isPaused = false;
  private currentPlayback: ReturnType<typeof playBuffer> | null = null;
  private events: PiperEngineEvents = {};

  readonly lang: string;
  private readonly workerUrl: string;
  private readonly onnxUrl: string;
  private readonly configUrl: string;

  constructor(options: {
    workerUrl: string;
    onnxUrl: string;
    configUrl: string;
    lang?: string;
  }) {
    this.workerUrl = options.workerUrl;
    this.onnxUrl = options.onnxUrl;
    this.configUrl = options.configUrl;
    this.lang = options.lang ?? "nl";
  }

  setEvents(events: PiperEngineEvents) { this.events = events; }
  getState() { return this._state; }

  private setState(s: PiperEngineState) {
    this._state = s;
    this.events.onStateChange?.(s);
  }

  async ensureReady(): Promise<void> {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = this._init().catch((err) => {
      this._readyPromise = null;
      this.setState("error");
      throw err;
    });
    return this._readyPromise;
  }

  private async _init(): Promise<void> {
    this.setState("loading");

    const [onnxBlob, configText] = await Promise.all([
      fetch(this.onnxUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to load model: ${this.onnxUrl} (${r.status})`);
        return r.blob();
      }),
      fetch(this.configUrl).then((r) => {
        if (!r.ok) throw new Error(`Failed to load config: ${this.configUrl} (${r.status})`);
        return r.text();
      }),
    ]);
    this.modelConfig = JSON.parse(configText);

    this.worker = new Worker(this.workerUrl);
    this.worker.onerror = (e) => console.error("[PiperEngine] Worker error:", e);
    this.rpc = makeWorkerRpc(this.worker);

    await new Promise((r) => setTimeout(r, 200));

    this.engineId = await this.rpc.request<string>(
      "makeInferenceEngine",
      { model: onnxBlob, modelConfig: this.modelConfig }
    );

    await this._initPhonemizer();

    this.audioCtx = new AudioContext();
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.connect(this.audioCtx.destination);

    this.setState("ready");
    console.log("[PiperEngine] Ready.");
  }

  private async _initPhonemizer(): Promise<void> {
    await this._waitForCreatePiperPhonemize();
    const engine = this;

    const module = await createPiperPhonemize({
      print(line: string) {
        try {
          engine.currentOutput.push(JSON.parse(line));
        } catch (_) {}
      },
      // The WASM data files are located in the root (/tts/)
      locateFile: (filename: string) => `${TTS_ROOT}${filename}`,
    });

    this.callMain = module.callMain.bind(module);
    console.log("[PiperEngine] Phonemizer initialized.");
  }

  private async _waitForCreatePiperPhonemize(maxMs = 10000): Promise<void> {
    const start = Date.now();
    while (typeof createPiperPhonemize !== "function") {
      if (Date.now() - start > maxMs) {
        throw new Error(`[PiperEngine] createPiperPhonemize not available after ${maxMs}ms.`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private phonemize(sentences: string[]): Array<{ phonemes: string[] }[]> {
    if (!this.callMain) throw new Error("Phonemizer not initialized");
    this.currentOutput = [];
    const exitCode = this.callMain([
      "--espeak_data", "/espeak-ng-data",
      "--language", this.lang,
      "--input", JSON.stringify(sentences.map((text) => ({ text }))),
    ]);
    if (exitCode !== 0) throw new Error(`Piper phonemization failed (exit code ${exitCode})`);
    return this.currentOutput as Array<{ phonemes: string[] }[]>;
  }

  private splitSentences(text: string): { text: string; index: number }[] {
    const regex = /([.?!۔؟]\s+|[\n׃。．။།।॥]\s*)/g;
    const results: { text: string; index: number }[] = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const sentence = text.substring(lastIndex, regex.lastIndex).trim();
      if (sentence) {
        results.push({ text: sentence, index: lastIndex });
      }
      lastIndex = regex.lastIndex;
    }

    const remaining = text.substring(lastIndex).trim();
    if (remaining) {
      results.push({ text: remaining, index: lastIndex });
    }

    return results;
  }

  async phonemizeText(text: string): Promise<PiperPhrase[]> {
    await this.ensureReady();

    const sentenceData = this.splitSentences(text);
    if (sentenceData.length === 0) return [];

    const sentences = sentenceData.map(s => s.text);
    const results = this.phonemize(sentences);
    const phrases: PiperPhrase[] = [];

    for (let sentIdx = 0; sentIdx < results.length; sentIdx++) {
      const r = results[sentIdx] as unknown as {
        phoneme_ids: number[][];
        text: string;
      };

      const idGroups = r.phoneme_ids ?? [];
      const isLastSentence = sentIdx === results.length - 1;
      const charIndex = sentenceData[sentIdx].index;

      for (let phraseIdx = 0; phraseIdx < idGroups.length; phraseIdx++) {
        const ids = idGroups[phraseIdx];
        if (!ids || ids.length === 0) continue;

        const isLast = isLastSentence && phraseIdx === idGroups.length - 1;
        phrases.push({
          phonemes: [],
          _phonemeIds: BigInt64Array.from(ids, BigInt),
          textIndex: charIndex,
          silenceSeconds: isLast && /\n\s*$/.test(sentences[sentIdx])
            ? DEFAULTS.paragraphSilenceSeconds
            : DEFAULTS.sentenceSilenceSeconds,
        } as unknown as PiperPhrase);
      }
    }

    return phrases;
  }

  async synthesize(phrase: PiperPhrase): Promise<PcmData> {
    await this.ensureReady();
    if (!this.rpc || !this.engineId) throw new Error("Engine not initialized");

    const phonemeIds = (phrase as unknown as { _phonemeIds: BigInt64Array })._phonemeIds;
    if (!phonemeIds || phonemeIds.length === 0) throw new Error("No phoneme IDs provided");

    const phonemeIdsCopy = new BigInt64Array(phonemeIds);
    return this.rpc.request<PcmData>(
      "infer",
      { engineId: this.engineId, phonemeIds: phonemeIdsCopy },
      [phonemeIdsCopy.buffer]
    );
  }

  async speak(text: string): Promise<void> {
    await this.ensureReady();
    this.cancelRequested = false;
    this.isPaused = false;

    if (this.audioCtx?.state === "suspended") await this.audioCtx.resume();

    const phrases = await this.phonemizeText(text);
    if (phrases.length === 0) {
      this.events.onEnd?.();
      return;
    }

    for (let i = 0; i < phrases.length; i++) {
      if (this.cancelRequested) break;
      while (this.isPaused && !this.cancelRequested) await new Promise((r) => setTimeout(r, 50));
      if (this.cancelRequested) break;

      this.events.onSentenceStart?.(phrases[i].textIndex);

      const pcmData = await this.synthesize(phrases[i]);
      if (this.cancelRequested) break;
      while (this.isPaused && !this.cancelRequested) await new Promise((r) => setTimeout(r, 50));
      if (this.cancelRequested) break;

      const playback = playPcmData(pcmData, this.audioCtx!, this.gainNode!, phrases[i].silenceSeconds);
      this.currentPlayback = playback;

      await new Promise<void>((resolve) => {
        let paused = false;
        let resumable = playback;

        const tick = setInterval(() => {
          if (this.cancelRequested) {
            clearInterval(tick);
            try { resumable.pause(); } catch (_) {}
            resolve();
          } else if (this.isPaused && !paused) {
            paused = true;
            const { resume } = resumable.pause();
            const waitTick = setInterval(() => {
              if (!this.isPaused || this.cancelRequested) {
                clearInterval(waitTick);
                if (!this.cancelRequested) {
                  paused = false;
                  resumable = resume();
                  this.currentPlayback = resumable;
                  resumable.completePromise.then(() => {
                    clearInterval(tick);
                    resolve();
                  });
                } else {
                  clearInterval(tick);
                  resolve();
                }
              }
            }, 50);
          }
        }, 50);

        playback.completePromise.then(() => {
          clearInterval(tick);
          resolve();
        });
      });
      this.currentPlayback = null;
    }

    if (!this.cancelRequested) this.events.onEnd?.();
  }

  pause() { this.isPaused = true; }
  resume() { this.isPaused = false; }
  stop() {
    this.cancelRequested = true;
    this.isPaused = false;
    if (this.currentPlayback) {
      try { this.currentPlayback.pause(); } catch (_) {}
      this.currentPlayback = null;
    }
  }

  async dispose() {
    this.stop();
    if (this.engineId && this.rpc) {
      try { await this.rpc.request("dispose", { engineId: this.engineId }); } catch (_) {}
    }
    this.worker?.terminate();
    this.worker = null;
    if (this.audioCtx) {
      await this.audioCtx.close();
      this.audioCtx = null;
    }
    this.engineId = null;
    this._readyPromise = null;
    this.setState("idle");
  }
}

// ─── Voice Configuration & Registry ──────────────────────────────────────────────

export interface PiperVoiceConfig {
  id: string;
  name: string;
  lang: string;
  onnxFile: string;
  configFile?: string;
  speakerId?: number;
}

interface VoicesJson {
  defaultVoiceId: string;
  voices: PiperVoiceConfig[];
}

export const PIPER_VOICE_CONFIGS: PiperVoiceConfig[] = []; 
export const DEFAULT_VOICE_ID: string = ""; 

const _engineRegistry = new Map<string, PiperEngine>();
let _cachedConfig: VoicesJson | null = null;

/**
 * Loads the external voice configuration from the root (/tts/)
 */
export async function loadVoicesConfig(): Promise<VoicesJson> {
  if (_cachedConfig) return _cachedConfig;
  const res = await fetch(VOICES_CONFIG_URL);
  if (!res.ok) throw new Error(`[PiperEngine] Could not load voice configuration: ${res.status}`);
  _cachedConfig = await res.json();
  return _cachedConfig!;
}

/**
 * Retrieves a PiperEngine instance for the specified voice.
 * Models are loaded from /tts/voices/
 */
export async function getPiperEngine(voiceId?: string): Promise<PiperEngine> {
  const configData = await loadVoicesConfig();
  const idToUse = voiceId || configData.defaultVoiceId;

  if (_engineRegistry.has(idToUse)) {
    return _engineRegistry.get(idToUse)!;
  }

  const voice = configData.voices.find((v) => v.id === idToUse);
  if (!voice) {
    throw new Error(`[PiperEngine] Voice not found in configuration: ${idToUse}`);
  }

  const configFile = voice.configFile ?? voice.onnxFile + ".json";
  
  const engine = new PiperEngine({
    workerUrl: WORKER_URL,
    // Models and their configs are located under /tts/voices/
    onnxUrl: `${TTS_VOICES}${voice.onnxFile}`,
    configUrl: `${TTS_VOICES}${configFile}`,
    lang: voice.lang.split("-")[0],
  });

  _engineRegistry.set(idToUse, engine);
  return engine;
}