"use client";

import { useState } from "react";
import { useAui } from "@assistant-ui/react";
import { useDictation } from "@/hooks/useDictation";
import { MicIcon } from "./icons";
import styles from "./chat.module.css";

type RecognitionLang = "en-US" | "he-IL";

const LANGUAGES: { code: RecognitionLang; label: string }[] = [
  { code: "en-US", label: "EN" },
  { code: "he-IL", label: "עב" },
];

/**
 * Mic dictation for the composer. Uses the Web Speech API directly (the
 * built-in adapter was unreliable and locked to en-US) and drives the
 * assistant-ui composer through its runtime: interim speech lands live in the
 * input via `setText`, and the final transcript auto-sends via `send` when the
 * user stops speaking. A small EN / עב toggle switches the recognition language.
 * The whole control hides itself where SpeechRecognition is unavailable.
 */
export function VoiceInput() {
  const aui = useAui();
  const [lang, setLang] = useState<RecognitionLang>("en-US");

  const dictation = useDictation({
    lang,
    onInterim: (transcript) => aui.composer.setText(transcript),
    onFinal: (transcript) => {
      aui.composer.setText(transcript);
      aui.composer.send();
    },
  });

  if (!dictation.supported) return null;

  return (
    <div className={styles.voiceInput}>
      <div
        className={styles.langToggle}
        role="group"
        aria-label="Dictation language"
      >
        {LANGUAGES.map(({ code, label }) => (
          <button
            key={code}
            type="button"
            className={code === lang ? styles.langActive : styles.langOption}
            aria-pressed={code === lang}
            disabled={dictation.isListening}
            onClick={() => setLang(code)}
          >
            {label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className={dictation.isListening ? styles.micActive : styles.iconButton}
        aria-label={dictation.isListening ? "Stop recording" : "Dictate with your microphone"}
        aria-pressed={dictation.isListening}
        onClick={() => (dictation.isListening ? dictation.stop() : dictation.start())}
      >
        <MicIcon />
      </button>

      {dictation.isListening && (
        <span className={styles.listening} role="status">
          <span className={styles.listeningDot} aria-hidden="true" />
          listening…
        </span>
      )}
    </div>
  );
}
