"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { VoiceOrb } from "./VoiceOrb";
import { WaveformButton } from "./WaveformButton";
import { ORB_ACTION_LABEL, orbAction, splitTranscript, statusFor, type OrbPhase } from "./orbState";
import { ChatIcon, CloseIcon } from "./icons";
import styles from "./voiceOrb.module.css";

export interface VoiceOverlayProps {
  open: boolean;
  phase: OrbPhase;
  statusText?: string;
  /** Large transcript line, if the caller has one. */
  transcript?: string;
  /** True when words arrive live (newest words dark); false shows a finished sentence in full dark. */
  transcriptIsLive?: boolean;
  /** One calm sentence shown while paused. */
  pauseReason?: string;
  level?: number;
  canInterrupt?: boolean;
  needsContinue?: boolean;
  onInterrupt: () => void;
  onContinue: () => void;
  onEnd: () => void;
  /** Leave the voice view for the text chat; defaults to ending the conversation. */
  onBackToChat?: () => void;
}

const EXIT_MS = 220; // keep in step with --overlay-fade-s
const WORDMARK = "Airport Investment Intelligence";

/** Stays mounted through the fade-out so closing is as smooth as opening. */
function useTransitionState(open: boolean): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  return { mounted, shown };
}

/**
 * Full-screen voice view: wordmark, the orb, one italic status line, a large transcript and
 * three controls (back to chat, a live waveform, End). Tapping the orb interrupts (while
 * speaking or thinking) or continues (while paused). Escape ends; Tab stays inside the controls.
 */
export function VoiceOverlay(props: VoiceOverlayProps) {
  const { open, phase, statusText, transcript, transcriptIsLive = true, pauseReason, level, canInterrupt, needsContinue } = props;
  const { mounted, shown } = useTransitionState(open);
  const endRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const action = orbAction(phase, { canInterrupt, needsContinue });

  // The dialog is only in the DOM once `mounted` is true (one commit after `open`), so focus has to wait for it.
  const active = open && mounted;
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    endRef.current?.focus();
    return () => previous?.focus?.();
  }, [active]);

  if (!mounted) return null;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onEnd();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = rootRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const handleOrb = action === "interrupt" ? props.onInterrupt : props.onContinue;
  const status = `${statusFor(phase, statusText)}${phase === "off" ? "" : "…"}`;
  const words = transcript ? splitTranscript(transcript, transcriptIsLive ? undefined : Infinity) : null;
  const pausedHint = [pauseReason, action === "continue" ? "Tap the orb to continue." : null].filter(Boolean).join(" ");

  return (
    <div
      ref={rootRef}
      className={shown ? `${styles.overlay} ${styles.overlayShown}` : styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Voice conversation"
      onKeyDown={handleKeyDown}
    >
      <p className={styles.wordmark}>{WORDMARK}</p>

      <div className={styles.stage}>
        {action ? (
          <button type="button" className={styles.orbButton} aria-label={ORB_ACTION_LABEL[action]} onClick={handleOrb}>
            <VoiceOrb phase={phase} level={level} />
          </button>
        ) : (
          <VoiceOrb phase={phase} level={level} />
        )}

        <p key={status} className={styles.status} role="status" aria-live="polite">
          {status}
        </p>

        {/* A fixed-height slot: the orb stays put when a caption appears or goes away between phases. */}
        <div className={styles.captionSlot}>
          {phase === "paused" && pausedHint ? (
            <p className={styles.hint}>{pausedHint}</p>
          ) : (
            words && (
              <p className={styles.transcript} aria-live="off">
                {words.said && <span className={styles.said}>{words.said} </span>}
                <span>{words.newest}</span>
              </p>
            )
          )}
        </div>
      </div>

      <div className={styles.controls}>
        <button type="button" className={styles.controlButton} aria-label="Back to text chat" onClick={props.onBackToChat ?? props.onEnd}>
          <ChatIcon width={22} height={22} />
        </button>
        <span aria-hidden="true">
          <WaveformButton label="Conversation active" large disabled />
        </span>
        <button ref={endRef} type="button" className={styles.controlButton} aria-label="End conversation" onClick={props.onEnd}>
          <CloseIcon width={22} height={22} />
        </button>
      </div>
    </div>
  );
}
