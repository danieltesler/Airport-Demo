"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ConversationController, type ConversationSnapshot, type PlaybackFact } from "@/lib/conversation";
import { createScreenWakeLock } from "@/lib/wakeLock";
import { getSpeechPlayer } from "@/lib/voicePlayback";
import type { Dictation } from "./useDictation";

/** Hands-free Conversation mode is off by default in production; the owner turns it on per deployment. */
export const CONVERSATION_MODE_ENABLED =
  process.env.NEXT_PUBLIC_CONVERSATION_MODE === "on" ||
  (process.env.NEXT_PUBLIC_CONVERSATION_MODE !== "off" && process.env.NODE_ENV !== "production");

/** Seconds of silence before a conversation pauses itself (see lib/conversation.ts for the other limits). */
const NO_SPEECH_MS = 8000;

const OFF: ConversationSnapshot = { phase: "off", pauseReason: null, startFailure: null };

interface Options {
  dictation: Dictation;
  /** Send a transcript as a spoken question. */
  send: (text: string) => void;
  /** The chat turn is running. */
  isThinking: boolean;
  playback: PlaybackFact;
}

/**
 * Wires the Conversation controller to the live pieces: the dictation hook (microphone and audio
 * context), the speech player, the screen wake lock and the page's visibility.
 */
export function useConversation({ dictation, send, isThinking, playback }: Options): {
  controller: ConversationController;
  snapshot: ConversationSnapshot;
} {
  const dictationRef = useRef(dictation);
  dictationRef.current = dictation;
  const sendRef = useRef(send);
  sendRef.current = send;

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
        wakeLock: { acquire: () => wakeLock.acquire(), release: () => wakeLock.release() },
      }),
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => OFF);

  // Playback first: when the chat turn finishes, the controller must already know whether it is speaking.
  useEffect(() => controller.playbackChanged(playback), [controller, playback]);
  useEffect(() => controller.chatRunning(isThinking), [controller, isThinking]);

  useEffect(() => {
    // A backgrounded tab or a locked screen suspends audio and the microphone: pause instead of dying silently.
    const onVisibility = () => {
      if (document.visibilityState === "hidden") controller.hidden();
      else void wakeLock.onVisible();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onVisibility);
    };
  }, [controller, wakeLock]);

  useEffect(() => () => controller.end(), [controller]);

  return { controller, snapshot };
}
