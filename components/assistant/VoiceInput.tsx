"use client";

import { useAui } from "@assistant-ui/react";
import { useDictation } from "@/hooks/useDictation";
import { MicIcon } from "./icons";
import styles from "./chat.module.css";

/**
 * Mic dictation for the composer. Records audio and transcribes it via OpenAI
 * (/api/stt). Tap to start; it auto-stops when you pause (or tap to stop), and the
 * transcript then auto-sends. Hidden where audio recording isn't available.
 */
export function VoiceInput() {
  const aui = useAui();

  const dictation = useDictation({
    onFinal: (transcript) => {
      aui.composer.setText(transcript);
      aui.composer.send();
    },
  });

  if (!dictation.supported) return null;

  return (
    <div className={styles.voiceInput}>
      <button
        type="button"
        className={dictation.isRecording ? styles.micActive : styles.iconButton}
        aria-label={dictation.isRecording ? "Stop recording" : "Speak your question"}
        aria-pressed={dictation.isRecording}
        disabled={dictation.isTranscribing}
        onClick={() => (dictation.isRecording ? dictation.stop() : dictation.start())}
      >
        <MicIcon />
      </button>

      {dictation.isRecording && (
        <span className={styles.listening} role="status">
          <span className={styles.listeningDot} aria-hidden="true" />
          listening…
        </span>
      )}

      {dictation.isTranscribing && (
        <span className={styles.listening} role="status">
          transcribing…
        </span>
      )}

      {!dictation.isRecording && !dictation.isTranscribing && dictation.error && (
        <span role="alert" style={{ color: "var(--danger)", fontSize: "0.78rem" }}>
          {dictation.error}
        </span>
      )}
    </div>
  );
}
