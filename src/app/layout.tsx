import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";

import { ThStoreProvider } from "@/lib/ThStoreProvider";
import { ThPreferencesProvider } from "@/preferences/ThPreferencesProvider";
import { ThI18nProvider } from "@/i18n/ThI18nProvider";

import "./reset.css";

export const runtime = "edge";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Thorium Web",
  description: "Play with the capabilities of the Readium Web Toolkit",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={ inter.className }>
        <ThStoreProvider>
          <ThPreferencesProvider>
            <ThI18nProvider>
              { children }
            </ThI18nProvider>
          </ThPreferencesProvider>
        </ThStoreProvider>

        {/*
          Piper WASM phonemizer — must be loaded globally before PiperEngine 
          initializes. Defines window.createPiperPhonemize().
          strategy="beforeInteractive" is not compatible with `export const runtime = "edge"`, 
          so we use afterInteractive + manual check in PiperEngine.
        */}
        <Script src="/tts/piper_phonemize.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
