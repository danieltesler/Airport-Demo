"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import { useAui, useAuiState } from "@assistant-ui/react";
import { CONVERSATION_MODE_ENABLED, useConversation } from "@/hooks/useConversation";
import { useDictation } from "@/hooks/useDictation";
import { useSpeechPlayback } from "@/hooks/useSpeechPlayback";
import { warmAcknowledgements } from "@/lib/acknowledgement";
import type { ConversationController } from "@/lib/conversation";
import { deriveVoiceState } from "@/lib/voiceStatus";
import { bumpVoiceEpoch } from "@/lib/voiceSession";
import { voiceTrace } from "@/lib/voiceTrace";
import { markVoiceTurn } from "@/lib/voiceTurn";
import { MicIcon, PlayIcon, RetryIcon, StopIcon } from "./icons";
import { threadWasCleared } from "./newChat";
import { useVoiceNotice } from "./VoiceNoticeContext";
import { VoiceOverlay } from "./VoiceOverlay";
import { WaveformButton } from "./WaveformButton";
import { voiceNotice } from "./voiceNotice";
import styles from "./chat.module.css";

// Loaded only when the URL asks for it (?debug=voice), so it ships to nobody else.
const VoiceDebugPanel = dynamic(() => import("./VoiceDebugPanel"), { ssr: false });

/** The user's latest question, shown in the voice view while the answer is on its way. */
function useLastUserText(): string {
  return useAuiState((state) => {
    const last = [...state.thread.messages].reverse().find((message) => message.role === "user");
    if (!last) return "";
    return last.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" ")
      .trim();
  });
}

/**
 * Voice controls for the composer: a mic (dictate one question), a waveform button that starts a
 * hands-free conversation, and contextual icon buttons (play, retry, stop) only when they apply.
 * While a conversation is active the full-screen voice view takes over; messages and problems
 * go to the calm line above the composer. Hidden where audio recording isn't available.
 */
export function VoiceInput({ hideConversationStart = false }: { hideConversationStart?: boolean }) {
  const aui = useAui();
  const isThinking = useAuiState((state) => state.thread.isRunning);
  const lastUserText = useLastUserText();
  const { playback, player } = useSpeechPlayback();
  const { setNotice } = useVoiceNotice();

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
  const { controller, snapshot, ui } = useConversation({
    dictation,
    send: sendSpoken,
    // The thread is only a placeholder until it is ready (and during a development remount); cancelling it then throws.
    cancelChat: () => {
      const thread = aui.thread();
      if (thread.getState().isRunning) thread.cancelRun();
    },
    isThinking,
    playback: playback.status,
    clip: playback.clip,
  });
  controllerRef.current = controller;

  // New chat clears the thread: a hands-free conversation that was running belongs to the old chat, so end it.
  const messageCount = useAuiState((state) => state.thread.messages.length);
  const previousMessageCount = useRef(messageCount);
  useEffect(() => {
    if (threadWasCleared(previousMessageCount.current, messageCount) && ui.active) ui.actions.end();
    previousMessageCount.current = messageCount;
  }, [messageCount, ui]);

  const [debug, setDebug] = useState(false);
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => {
    setDebug(voiceTrace().enabled);
    setClientReady(true);
  }, []);

  const state = deriveVoiceState({
    isRecording: dictation.isRecording,
    isTranscribing: dictation.isTranscribing,
    micError: dictation.error,
    isThinking,
    playback: playback.status,
    conversation: CONVERSATION_MODE_ENABLED ? snapshot : null,
  });

  const notice = voiceNotice({
    insecureContext: dictation.insecureContext,
    startFailure: ui.startFailure,
    micError: state === "error" ? dictation.error : null,
    playbackBlocked: state === "blocked",
    tip: ui.tip,
  });
  const noticeMessage = notice?.message ?? null;
  const noticeTone = notice?.tone ?? "info";
  useEffect(() => {
    setNotice(noticeMessage ? { message: noticeMessage, tone: noticeTone } : null);
    return () => setNotice(null);
  }, [noticeMessage, noticeTone, setNotice]);

  const debugPanel = debug ? <VoiceDebugPanel /> : null;
  if (dictation.insecureContext || !dictation.supported) return debugPanel;

  /** Everything a tap needs, done synchronously inside it: unlock audio, warm the "one moment" clips. */
  const prepareInsideTap = () => {
    bumpVoiceEpoch(); // the user is talking again: an answer still on its way is stale
    player.unlock();
    warmAcknowledgements();
  };

  const handleMicClick = () => {
    if (ui.active) {
      void ui.actions.tap(); // finish talking, interrupt, or continue, depending on the phase
      return;
    }
    prepareInsideTap();
    if (dictation.isRecording) return dictation.stop();
    player.cancel(); // cut off any reply still playing
    dictation.start();
  };

  const listening = dictation.isRecording || (ui.active && ui.phase === "listening");
  const showStop = !ui.active && (state === "speaking" || state === "preparing");
  const showPlay = state === "blocked";
  const showRetry = state === "error" && dictation.canRetry;
  const caption = ui.phase === "thinking" || ui.phase === "speaking" ? lastUserText : "";

  return (
    <>
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

      {showPlay && (
        <button type="button" className={styles.iconButton} aria-label="Play the answer" onClick={() => player.resume()}>
          <PlayIcon />
        </button>
      )}
      {showRetry && (
        <button type="button" className={styles.iconButton} aria-label="Send the recording again" onClick={dictation.retry}>
          <RetryIcon />
        </button>
      )}
      {showStop && (
        <button type="button" className={styles.iconButton} aria-label="Stop speaking" onClick={() => player.cancel()}>
          <StopIcon />
        </button>
      )}

      {CONVERSATION_MODE_ENABLED && !ui.active && !hideConversationStart && (
        <WaveformButton label="Start conversation" onClick={() => void ui.actions.start()} />
      )}

      {clientReady &&
        createPortal(
          <VoiceOverlay
            open={ui.active}
            phase={ui.phase}
            statusText={ui.statusText}
            transcript={caption || undefined}
            transcriptIsLive={false}
            pauseReason={ui.pauseMessage ?? undefined}
            canInterrupt={ui.canInterrupt}
            needsContinue={ui.needsContinue}
            onInterrupt={() => void ui.actions.interrupt()}
            onContinue={() => void ui.actions.continue()}
            onEnd={ui.actions.end}
          />,
          document.body,
        )}
      {debugPanel}
    </>
  );
}
