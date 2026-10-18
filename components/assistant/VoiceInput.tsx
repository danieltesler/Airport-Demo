"use client";

import { useRef } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { CONVERSATION_MODE_ENABLED, useConversation } from "@/hooks/useConversation";
import { useDictation } from "@/hooks/useDictation";
import { useSpeechPlayback } from "@/hooks/useSpeechPlayback";
import { warmAcknowledgements } from "@/lib/acknowledgement";
import type { ConversationController } from "@/lib/conversation";
import { deriveVoiceState, voiceChipText } from "@/lib/voiceStatus";
import { markVoiceTurn } from "@/lib/voiceTurn";
import { MicIcon, StopIcon } from "./icons";
import styles from "./chat.module.css";

/**
 * Voice input for the composer.
 *
 * Tap-to-talk (the mic): records one question, stops when you pause, sends the transcript, and
 * reads the answer aloud. Conversation (hands-free, behind a flag): the same loop repeats on its
 * own while you talk and it answers, with an End button always showing and automatic pauses.
 * A status chip shows the one current stage; every failure ends in text on screen, with a retry
 * or a "tap the mic" where one helps. Hidden where audio recording isn't available.
 */
export function VoiceInput() {
  const aui = useAui();
  const isThinking = useAuiState((state) => state.thread.isRunning);
  const { playback, player } = useSpeechPlayback();

  const sendSpoken = (transcript: string) => {
    markVoiceTurn(transcript);
    aui.composer.setText(transcript);
    aui.composer.send();
  };

  // The dictation hook reports hands-free turns to the controller, which is created after it.
  const controllerRef = useRef<ConversationController | null>(null);
  const dictation = useDictation({
    onFinal: sendSpoken,
    onOutcome: (outcome) => controllerRef.current?.outcome(outcome),
  });
  const { controller, snapshot } = useConversation({ dictation, send: sendSpoken, isThinking, playback: playback.status });
  controllerRef.current = controller;

  if (dictation.insecureContext) {
    return <span className={styles.voiceError}>Voice needs a secure (https) connection. You can still type.</span>;
  }
  if (!dictation.supported) return null;

  const conversationActive = snapshot.phase !== "off";
  const state = deriveVoiceState({
    isRecording: dictation.isRecording,
    isTranscribing: dictation.isTranscribing,
    micError: dictation.error,
    isThinking,
    playback: playback.status,
    conversation: CONVERSATION_MODE_ENABLED ? snapshot : null,
  });

  /** Everything a tap needs, done synchronously inside it: unlock audio, warm the "one moment" clips. */
  const prepareInsideTap = () => {
    player.unlock();
    warmAcknowledgements();
  };

  const handleMicClick = () => {
    prepareInsideTap();
    if (conversationActive) {
      void controller.tap(); // finish talking, interrupt, or continue, depending on the phase
      return;
    }
    if (dictation.isRecording) return dictation.stop();
    player.cancel(); // cut off any reply still playing
    dictation.start();
  };

  const handleStartConversation = () => {
    prepareInsideTap();
    player.cancel();
    void controller.start();
  };

  const listening = dictation.isRecording || (conversationActive && snapshot.phase === "listening");
  const chipText = voiceChipText(state, snapshot);

  return (
    <div className={styles.voiceInput}>
      <button
        type="button"
        className={listening ? styles.micActive : styles.iconButton}
        aria-label={dictation.isRecording ? "Stop recording" : "Speak your question"}
        aria-pressed={dictation.isRecording}
        disabled={dictation.isTranscribing}
        onClick={handleMicClick}
      >
        <MicIcon />
      </button>

      {CONVERSATION_MODE_ENABLED && !conversationActive && (
        <button type="button" className={styles.chipButton} onClick={handleStartConversation} aria-label="Start a hands-free conversation">
          Conversation
        </button>
      )}
      {conversationActive && (
        <button type="button" className={styles.endButton} onClick={() => controller.end()} aria-label="End conversation">
          <StopIcon />
          <span>End</span>
        </button>
      )}

      <span
        className={styles.voiceChip}
        role="status"
        aria-live="polite"
        title={playback.provider ? `Voice provider: ${playback.provider}` : undefined}
      >
        {state === "listening" && <span className={styles.listeningDot} aria-hidden="true" />}
        {state === "error" && dictation.error ? (
          <span role="alert" className={styles.voiceError}>
            {dictation.error}
          </span>
        ) : (
          chipText
        )}
        {state === "blocked" && (
          <button type="button" className={styles.chipButton} onClick={() => player.resume()}>
            Play
          </button>
        )}
        {state === "speaking" && (
          <button
            type="button"
            className={styles.chipButton}
            onClick={() => (conversationActive ? void controller.tap() : player.cancel())}
          >
            {conversationActive ? "Interrupt" : "Stop"}
          </button>
        )}
        {state === "paused" && (
          <button type="button" className={styles.chipButton} onClick={handleMicClick}>
            Continue
          </button>
        )}
        {state === "error" && dictation.canRetry && (
          <button type="button" className={styles.chipButton} onClick={dictation.retry}>
            Retry
          </button>
        )}
      </span>
    </div>
  );
}
