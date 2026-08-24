"use client";

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import styles from "./Composer.module.css";

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  /** Voice buttons rendered inside the action row (may be null). */
  voiceSlot?: ReactNode;
}

/**
 * The message input. Enter submits, Shift+Enter inserts a newline. The input
 * and Send button are disabled while a request is in flight. Presentation only:
 * all state lives in the parent so voice dictation and example chips can write
 * to the same value.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  voiceSlot,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canSend = value.trim().length > 0 && !disabled;

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <div className={styles.composer}>
      <textarea
        ref={textareaRef}
        className={styles.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about airport capacity, congestion, or demand…"
        rows={1}
        disabled={disabled}
        aria-label="Message"
      />
      <div className={styles.actions}>
        {voiceSlot}
        <button
          type="button"
          className={styles.send}
          onClick={onSubmit}
          disabled={!canSend}
        >
          Send
        </button>
      </div>
    </div>
  );
}
