"use client";

import { useEffect, useState } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { VoiceOverlay } from "./VoiceOverlay";
import type { OrbPhase } from "./orbState";
import styles from "./voiceOrb.module.css";

const PHASES: OrbPhase[] = ["off", "listening", "thinking", "speaking", "paused"];

/** Dev-only harness: the orb in every state, plus the overlay, with a state switcher. Not linked from the app. */
export function VoicePreview() {
  const [phase, setPhase] = useState<OrbPhase>("listening");
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [level, setLevel] = useState(0);
  const [showTranscript, setShowTranscript] = useState(true);
  const [live, setLive] = useState(true);

  // A fake speech level so the speaking state can be seen with level modulation.
  useEffect(() => {
    if (phase !== "speaking") return setLevel(0);
    const timer = setInterval(() => setLevel(Math.random()), 120);
    return () => clearInterval(timer);
  }, [phase]);

  return (
    <main className={styles.preview}>
      <h1>Voice orb preview</h1>
      <div className={styles.previewSwitcher} role="group" aria-label="Orb state">
        {PHASES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            className={candidate === phase ? `${styles.previewButton} ${styles.previewButtonActive}` : styles.previewButton}
            aria-pressed={candidate === phase}
            onClick={() => setPhase(candidate)}
          >
            {candidate === "off" ? "idle" : candidate}
          </button>
        ))}
      </div>

      <div className={styles.previewSwitcher}>
        <button type="button" className={styles.previewButton} aria-pressed={showTranscript} onClick={() => setShowTranscript((v) => !v)}>
          Transcript {showTranscript ? "on" : "off"}
        </button>
        <button type="button" className={styles.previewButton} aria-pressed={live} onClick={() => setLive((v) => !v)}>
          {live ? "Live words" : "Finished sentence"}
        </button>
      </div>

      <VoiceOrb phase={phase} level={level} />
      <VoiceOrb phase={phase} small />

      <button type="button" className={styles.previewButton} onClick={() => setOverlayOpen(true)}>
        Open overlay in this state
      </button>

      <VoiceOverlay
        open={overlayOpen}
        phase={phase}
        transcript={showTranscript ? "Which New England airports look strongest for terminal expansion this year" : undefined}
        transcriptIsLive={live}
        pauseReason="I did not hear an answer, so I paused."
        level={level}
        onInterrupt={() => setPhase("listening")}
        onContinue={() => setPhase("listening")}
        onEnd={() => setOverlayOpen(false)}
      />
    </main>
  );
}
