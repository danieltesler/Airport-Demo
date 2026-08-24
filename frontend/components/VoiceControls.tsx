import styles from "./VoiceControls.module.css";

interface VoiceControlsProps {
  recognitionSupported: boolean;
  synthesisSupported: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  /** True when there is a latest assistant reply available to read aloud. */
  canSpeak: boolean;
  onToggleMic: () => void;
  onToggleSpeak: () => void;
}

/**
 * Voice affordances: a mic button that dictates into the input, and a speaker
 * toggle that reads the latest assistant reply aloud. Each button is rendered
 * only when its underlying Web Speech API is available, so unsupported browsers
 * simply see fewer controls (no crashes, no dead buttons).
 */
export function VoiceControls({
  recognitionSupported,
  synthesisSupported,
  isListening,
  isSpeaking,
  canSpeak,
  onToggleMic,
  onToggleSpeak,
}: VoiceControlsProps) {
  if (!recognitionSupported && !synthesisSupported) return null;

  return (
    <div className={styles.group}>
      {recognitionSupported && (
        <button
          type="button"
          className={`${styles.btn} ${isListening ? styles.active : ""}`}
          onClick={onToggleMic}
          aria-pressed={isListening}
          aria-label={isListening ? "Stop dictation" : "Dictate a message"}
          title={isListening ? "Stop dictation" : "Dictate a message"}
        >
          <MicIcon />
          {isListening && <span className={styles.pulse} aria-hidden="true" />}
        </button>
      )}

      {synthesisSupported && (
        <button
          type="button"
          className={`${styles.btn} ${isSpeaking ? styles.active : ""}`}
          onClick={onToggleSpeak}
          disabled={!canSpeak && !isSpeaking}
          aria-pressed={isSpeaking}
          aria-label={
            isSpeaking ? "Stop reading answer" : "Read latest answer aloud"
          }
          title={isSpeaking ? "Stop reading answer" : "Read latest answer aloud"}
        >
          {isSpeaking ? <StopIcon /> : <SpeakerIcon />}
        </button>
      )}
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9v6h4l5 4V5L8 9H4z"
        fill="currentColor"
      />
      <path
        d="M16 8.5a4 4 0 0 1 0 7M18.5 6a7.5 7.5 0 0 1 0 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
