"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  WebSpeechReadAloudNavigator,
  WebSpeechVoiceManager,
  type ReadiumSpeechVoice,
  type ReadiumSpeechUtterance,
} from "@readium/speech";
import { 
  getPiperEngine, 
  loadVoicesConfig,
  type PiperVoiceConfig 
} from "@/lib/PiperEngine";

type PlaybackState = "idle" | "loading" | "playing" | "paused";

export const useReadiumSpeech = () => {
  const [voices, setVoices] = useState<ReadiumSpeechVoice[]>([]);
  const [selectedVoice, setSelectedVoiceState] = useState<ReadiumSpeechVoice | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");

  const navigatorRef = useRef<WebSpeechReadAloudNavigator | null>(null);
  const utterancesRef = useRef<ReadiumSpeechUtterance[]>([]);
  const selectedVoiceRef = useRef<ReadiumSpeechVoice | null>(null);
  const piperSpeakingRef = useRef(false);
  const piperConfigsRef = useRef<PiperVoiceConfig[]>([]);

  // ── Setup ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    const setup = async () => {
      // 1. Load Piper Config
      const configData = await loadVoicesConfig();
      piperConfigsRef.current = configData.voices;

      const piperVoices: ReadiumSpeechVoice[] = configData.voices.map((cfg) => ({
        id: cfg.id,
        name: cfg.name,
        label: cfg.name,
        lang: cfg.lang,
        language: cfg.lang,
        localService: true,
        default: cfg.id === configData.defaultVoiceId,
      } as unknown as ReadiumSpeechVoice));

      const initialVoice = piperVoices.find(v => (v as any).default) || piperVoices[0];
      setSelectedVoiceState(initialVoice);
      selectedVoiceRef.current = initialVoice;

      // 2. Load WebSpeech
      try {
        const voiceManager = await WebSpeechVoiceManager.initialize({ languages: ["nl", "en"] });
        const webVoices = voiceManager.getVoices({ removeDuplicates: true });
        setVoices([...piperVoices, ...webVoices]);
      } catch (e) {
        setVoices(piperVoices);
      }

      const nav = new WebSpeechReadAloudNavigator();

      nav.on("start", () => { if (!piperSpeakingRef.current) setPlaybackState("playing"); });
      nav.on("pause", () => { if (!piperSpeakingRef.current) setPlaybackState("paused"); });
      nav.on("resume", () => { if (!piperSpeakingRef.current) setPlaybackState("playing"); });
      nav.on("stop", () => { if (!piperSpeakingRef.current) { setPlaybackState("idle"); clearAllHighlights(); } });
      nav.on("end", () => { if (!piperSpeakingRef.current) { setPlaybackState("idle"); clearAllHighlights(); } });
      nav.on("boundary", (event) => {
        if (!piperSpeakingRef.current && event.detail?.name === "word") {
          highlightWord(event.detail.charIndex, event.detail.charLength);
        }
      });

      navigatorRef.current = nav;
    };

    setup();

    return () => {
      navigatorRef.current?.destroy();
      piperConfigsRef.current.forEach(async (cfg) => {
        try { (await getPiperEngine(cfg.id)).stop(); } catch (_) {}
      });
    };
  }, []);

  const isPiperVoice = (voice: ReadiumSpeechVoice | null): boolean => {
    const id = (voice as any)?.id;
    return !!id && piperConfigsRef.current.some((cfg) => cfg.id === id);
  };

  const loadUtterancesFromIframe = (): ReadiumSpeechUtterance[] => {
    const iframe = document.querySelector("iframe");
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
    if (!doc) return [];

    const utterances: ReadiumSpeechUtterance[] = [];
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node: Node) => {
        const el = node as HTMLElement;
        const text = el.textContent?.trim();
        if (!text || text.length < 1) return NodeFilter.FILTER_SKIP;
        const hasDirectText = Array.from(el.childNodes).some(
          (child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim() !== ""
        );
        return hasDirectText ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });

    let currentNode = walker.nextNode() as HTMLElement | null;
    while (currentNode) {
      const id = currentNode.id || `tts-node-${utterances.length}`;
      currentNode.id = id;
      utterances.push({
        id,
        text: currentNode.textContent?.trim() || "",
        language: doc.documentElement.lang || "nl",
      } as ReadiumSpeechUtterance);
      currentNode = walker.nextNode() as HTMLElement | null;
    }
    return utterances;
  };

  const ensureIframeStyles = useCallback(() => {
    const iframe = document.querySelector("iframe");
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
    if (!doc || doc.getElementById("tts-styles")) return;

    const style = doc.createElement("style");
    style.id = "tts-styles";
    style.textContent = `
      ::highlight(current-word) { background-color: #fff34d; color: #000; }
      ::highlight(current-sentence) { background-color: #fff34d; color: #000; }
      .tts-active-sentence { background-color: rgba(255, 243, 77, 0.3) !important; border-radius: 2px; transition: background-color 0.2s; }
    `;
    doc.head.appendChild(style);
  }, []);

  const clearAllHighlights = useCallback(() => {
    const iframe = document.querySelector("iframe");
    const win = iframe?.contentWindow as any;
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
    if (win?.CSS?.highlights) {
      win.CSS.highlights.delete("current-word");
      win.CSS.highlights.delete("current-sentence");
    }
    doc?.querySelectorAll(".tts-active-sentence").forEach((el) =>
      el.classList.remove("tts-active-sentence")
    );
  }, []);

  const highlightSentence = useCallback((id: string, charIndex?: number, fullText?: string) => {
    const iframe = document.querySelector("iframe");
    const win = iframe?.contentWindow as any;
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
    if (!doc) return;

    doc.querySelectorAll(".tts-active-sentence").forEach((el) => el.classList.remove("tts-active-sentence"));
    const el = doc.getElementById(id);
    if (el) {
      el.classList.add("tts-active-sentence");
      el.scrollIntoView({ behavior: "smooth", block: "center" });

      if (charIndex !== undefined && win?.Highlight && win?.CSS?.highlights && fullText) {
        const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode();
        if (textNode) {
          try {
            const range = doc.createRange();
            range.setStart(textNode, charIndex);
            const remainingText = fullText.substring(charIndex);
            const sentenceMatch = remainingText.match(/([.?!۔؟]\s+|[\n׃。．။།।॥]\s*)/);
            const endOffset = sentenceMatch ? charIndex + sentenceMatch.index! + sentenceMatch[0].length : textNode.textContent?.length || charIndex;
            range.setEnd(textNode, Math.min(endOffset, textNode.textContent?.length || endOffset));
            win.CSS.highlights.set("current-sentence", new win.Highlight(range));
          } catch (e) { console.warn("[useReadiumSpeech] Range error:", e); }
        }
      }
    }
  }, []);

  const highlightWord = (charIndex: number, charLength: number) => {
    const iframe = document.querySelector("iframe");
    const win = iframe?.contentWindow as any;
    const doc = iframe?.contentDocument || iframe?.contentWindow?.document;
    if (!win?.Highlight || !win?.CSS?.highlights || !doc) return;

    const nav = navigatorRef.current;
    const currentIndex = nav?.getCurrentUtteranceIndex?.() ?? -1;
    if (currentIndex === -1) return;

    const utterance = utterancesRef.current[currentIndex];
    const el = utterance ? doc.getElementById(utterance.id) : null;
    if (!el) return;

    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const textNode = walker.nextNode();
    if (!textNode) return;

    try {
      const range = doc.createRange();
      range.setStart(textNode, charIndex);
      range.setEnd(textNode, charIndex + charLength);
      win.CSS.highlights.set("current-word", new win.Highlight(range));
    } catch (_) {}
  };

  const stop = useCallback(async () => {
    for (const cfg of piperConfigsRef.current) {
      try { (await getPiperEngine(cfg.id)).stop(); } catch (_) {}
    }
    piperSpeakingRef.current = false;
    navigatorRef.current?.stop();
    setPlaybackState("idle");
    clearAllHighlights();
  }, [clearAllHighlights]);

  const startPlayback = useCallback(async (startIndex = 0) => {
    const nav = navigatorRef.current;
    if (!nav || !selectedVoiceRef.current) return;

    // Prevent double initiation if Piper is already active
    if (piperSpeakingRef.current) return;

    const utterances = loadUtterancesFromIframe();
    if (utterances.length === 0) {
      setPlaybackState("idle");
      return;
    }

    utterancesRef.current = utterances;
    ensureIframeStyles();

    if (isPiperVoice(selectedVoiceRef.current)) {
      const voiceId = (selectedVoiceRef.current as any).id;
      const engine = await getPiperEngine(voiceId);

      let currentUtteranceIndex = startIndex;

      engine.setEvents({
        onStateChange: (state) => { if (piperSpeakingRef.current && state === "loading") setPlaybackState("loading"); },
        onSentenceStart: (charIndex) => {
          const u = utterancesRef.current[currentUtteranceIndex];
          if (u) highlightSentence(u.id, charIndex, u.text);
        },
        onError: (err) => { console.error("[PiperEngine] Error:", err); stop(); },
      });

      piperSpeakingRef.current = true;
      setPlaybackState("loading");
      await engine.ensureReady();

      const speakAll = async () => {
        for (let i = startIndex; i < utterancesRef.current.length; i++) {
          if (!piperSpeakingRef.current) break;
          currentUtteranceIndex = i;
          const u = utterancesRef.current[i];
          setPlaybackState("playing");
          highlightSentence(u.id);
          await engine.speak(u.text);
        }
        if (piperSpeakingRef.current) stop();
      };
      speakAll().catch((err) => { console.error("Piper loop error:", err); stop(); });
    } else {
      nav.stop();
      await nav.setVoice(selectedVoiceRef.current);
      nav.loadContent(utterances);
      nav.play(startIndex);
    }
  }, [stop, ensureIframeStyles, highlightSentence]);

  const togglePlay = useCallback(async () => {
    // Prevent actions while loading
    if (playbackState === "loading") return;

    if (playbackState === "playing") {
      if (isPiperVoice(selectedVoiceRef.current)) {
        const voiceId = (selectedVoiceRef.current as any).id;
        (await getPiperEngine(voiceId)).pause();
      } else { navigatorRef.current?.pause(); }
      setPlaybackState("paused");
    } else if (playbackState === "paused") {
      if (isPiperVoice(selectedVoiceRef.current)) {
        const voiceId = (selectedVoiceRef.current as any).id;
        (await getPiperEngine(voiceId)).resume();
      } else { navigatorRef.current?.play(); }
      setPlaybackState("playing");
    } else { 
      // Start immediately with loading state to block double clicks
      setPlaybackState("loading");
      await startPlayback(0); 
    }
  }, [playbackState, startPlayback]);

  const changeVoice = useCallback(async (voice: ReadiumSpeechVoice) => {
    await stop();
    setSelectedVoiceState(voice);
    selectedVoiceRef.current = voice;
    if (!isPiperVoice(voice) && navigatorRef.current) {
      await navigatorRef.current.setVoice(voice);
    }
  }, [stop]);

  return {
    togglePlay, stop,
    isPlaying: playbackState === "playing",
    isPaused: playbackState === "paused",
    isLoading: playbackState === "loading",
    playbackState, voices, selectedVoice,
    setSelectedVoice: changeVoice,
    navigator: navigatorRef.current,
  };
};