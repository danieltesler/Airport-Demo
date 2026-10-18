"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { bumpVoiceEpoch } from "@/lib/voiceSession";
import { ConversationController, isConversationModeEnabled, type ConversationSnapshot, type PlaybackFact } from "@/lib/conversation";
import { watchPageLifecycle } from "@/lib/pageLifecycle";
import { createScreenWakeLock } from "@/lib/wakeLock";
import { getSpeechPlayer } from "@/lib/voicePlayback";
import type { Dictation } from "./useDictation";

/** Hands-free Conversation mode is on everywhere; NEXT_PUBLIC_CONVERSATION_MODE=off (at build time) hides it. */
export const CONVERSATION_MODE_ENABLED = isConversationModeEnabled(process.env.NEXT_PUBLIC_CONVERSATION_MODE);

/** Seconds of silence before a conversation pauses itself (see lib/conversation.ts for the other limits). */
const NO_SPEECH_MS = 8000;

const OFF: ConversationSnapshot = { phase: "off", pauseReason: null, startFailure: null };

interface Options {
  dictation: Dictation;
  /** Send a transcript as a spoken question. */
  send: (text: string) => void;
  /** Stop the chat request that is still running (End). */
  cancelChat: () => void;
  /** The chat turn is running. */
  isThinking: boolean;
  playback: PlaybackFact;
}

/**
 * Wires the Conversation controller to the live pieces: the dictation hook (microphone and audio
 * context), the speech player, the screen wake lock and the page's visibility.
 */
export function useConversation({ dictation, send, cancelChat, isThinking, playback }: Options): {
  controller: ConversationController;
  snapshot: ConversationSnapshot;
} {
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  const sendRef = useRef(send);
  sendRef.current = send;
  const cancelChatRef = useRef(cancelChat);
  cancelChatRef.current = cancelChat;

  const [wakeLock] = useState(() => createScreenWakeLock());
  const [controller] = useState(
    () =>
      new ConversationController({
        openSession: () => dictationRef.current.openSession(),
        closeSession: () => dictationRef.current.closeSession(),
        audioReady: () => dictationRef.current.audioReady(),
        listen: () => dictationRef.current.listen({ handsFree: { noSpeechMs: NO_SPEECH_MS } }),
        stopListening: () => dictationRef.current.discard(),
        finishListening: () => dictationRef.current.stop(),
        send: (text) => sendRef.current(text),
        cancelSpeech: () => getSpeechPlayer().cancel(),
        cancelChat: () => cancelChatRef.current(),
        wakeLock: { acquire: () => wakeLock.acquire(), release: () => wakeLock.release() },
      }),
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => OFF);

  // Playback first: when the chat turn finishes, the controller must already know whether it is speaking.
  useEffect(() => controller.playbackChanged(playback), [controller, playback]);
  useEffect(() => controller.chatRunning(isThinking), [controller, isThinking]);

  useEffect(
    // A backgrounded tab, a frozen page or a locked screen suspends audio and the microphone: pause
    // instead of dying silently (see lib/pageLifecycle.ts).
    () =>
      watchPageLifecycle({
        document,
        window,
        onHidden: () => controller.hidden(),
        onVisible: () => void wakeLock.onVisible(),
      }),
    [controller, wakeLock],
  );

  // End and every pause make a pending spoken answer stale: it may still arrive on screen, but it is not spoken.
  useEffect(() => {
    let previous = controller.getSnapshot().phase;
    return controller.subscribe(() => {
      const phase = controller.getSnapshot().phase;
      if ((phase === "off" || phase === "paused") && phase !== previous) bumpVoiceEpoch();
      previous = phase;
    });
  }, [controller]);

  useEffect(
    () => () => {
      controller.end();
      bumpVoiceEpoch();
    },
    [controller],
  );

  return { controller, snapshot };
}
