"use client";

import React from "react";
import { useReadiumSpeech } from "@/hooks/useReadiumSpeech";

export const SpeechTrigger = () => {
  const { togglePlay, isPlaying, voices, selectedVoice, setSelectedVoice } = useReadiumSpeech();

  // Temp inline styling
  const buttonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "32px",
    height: "24px",
    background: isPlaying ? "#eee" : "#f5f5f5",
    border: "1px solid #ccc",
    borderRadius: "4px",
    cursor: "pointer",
    outline: "none",
    padding: 0,
    fontSize: "14px",
    color: "#333",
    WebkitAppearance: "none",
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "8px", fontFamily: "sans-serif" }}>
      <button 
        onClick={togglePlay} 
        style={buttonStyle}
        title={isPlaying ? "Pauze" : "Voorlezen"}
      >
        {isPlaying ? "⏸" : "▶"}
      </button>
      
      <select 
        value={selectedVoice?.name || ""} 
        onChange={(e) => {
          const v = voices.find(voice => voice.name === e.target.value);
          if (v) setSelectedVoice(v);
        }}
        style={{ 
          fontSize: "11px", 
          height: "24px", 
          borderRadius: "4px", 
          border: "1px solid #ccc", 
          background: "white", 
          color: "#333",
          outline: "none" // Ook hier voor de zekerheid
        }}
      >
        <option value="">Stem...</option>
        {voices
          .filter(v => v.language.startsWith("nl") || v.language.startsWith("en"))
          .map(v => (
            <option key={v.id || v.name} value={v.name}>
              {v.label} ({v.language})
            </option>
          ))
        }
      </select>
    </div>
  );
};
