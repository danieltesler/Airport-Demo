"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { warmAcknowledgements } from "@/lib/acknowledgement";
import { bargeInAllowed } from "@/lib/bargeIn";
import {
  ConversationController,
  PAUSE_REASON_TEXT,
  STATUS_TEXT,
  isConversationModeEnabled,
  type ConversationPhase,
  type ConversationSnapshot,
  type PlaybackFact,
} from "@/lib/conversation";
import { watchPageLifecycle } from "@/lib/pageLifecycle";
import { bumpVoiceEpoch } from "@/lib/voiceSession";
import { traceVoice } from "@/lib/voiceTrace";
import { getSpeechPlayer } from "@/lib/voicePlayback";
import { createScreenWakeLock } from "@/lib/wakeLock";
import type { Dictation } from "./useDictation";

/** Hands-free Conversation mode is on everywhere; NEXT_PUBLIC_CONVERSATION_MODE=off (at build time) hides it. */
export const CONVERSATION_MODE_ENABLED = isConversationModeEnabled(process.env.NEXT_PUBLIC_CONVERSATION_MODE);

/** Seconds of silence before a conversation pauses itself (see lib/conversation.ts for the other limits). */
const NO_SPEECH_MS = 8000;

const OFF: ConversationSnapshot = { phase: "off", pauseReason: null, startFailure: null, bargeInActive: true, tip: null };

/** Voice barge-in is always on; ?bargein=off (or localStorage "bargein" = "off") is a debugging override only. */
function bargeInOverride(): boolean {
  try {
    return bargeInAllowed(window.location.search, window.localStorage.getItem("bargein"));
  } catch {
    return true;
  }
}

interface Options {
  dictation: Dictation;
  /** Send a transcript as a spoken question. */
  send: (text: string) => void;
  /** Stop the chat request that is still running (End). */
  cancelChat: () => void;
  /** The chat turn is running. */
  isThinking: boolean;
  playback: PlaybackFact;
  /** Counts every clip that starts playing (PlaybackSnapshot.clip), so barge-in recalibrates per clip. */
  clip?: number;
}

/**
 * Everything a voice UI needs, as plain state and four functions. Bind to this and nothing else:
 *
 *   ui.phase         "off" | "starting" | "listening" | "thinking" | "speaking" | "paused"
 *   ui.statusText    "Listening" | "Thinking" | "Speaking" | "Paused" (empty when off)
 *   ui.active        a conversation is running (any phase but off)
 *   ui.canInterrupt  the assistant can be interrupted right now (speaking or thinking)
 *   ui.needsContinue the conversation paused and is waiting for the user to carry on
 *   ui.pauseMessage  why it paused, as one short sentence (null unless paused)
 *   ui.tip           one gentle line, shown once, the first time voice interrupt switches itself off
 *   ui.startFailure  "denied" | "unsupported" when starting failed, else null
 *   ui.actions       start(), end(), interrupt(), continue(); each does its audio unlocking inside the tap
 *
 * Voice barge-in has no control: while the assistant speaks, talking over it interrupts it.
 */
export interface ConversationUi {
  phase: ConversationPhase;
  statusText: string;
  active: boolean;
  canInterrupt: boolean;
  needsContinue: boolean;
  pauseMessage: string | null;
  tip: string | null;
  startFailure: ConversationSnapshot["startFailure"];
  actions: {
    start: () => Promise<void>;
    end: () => void;
    interrupt: () => Promise<void>;
    continue: () => Promise<void>;
    /** The old mic button: start, finish talking, interrupt or continue, whichever fits the phase. */
    tap: () => Promise<void>;
  };
}

/** Plain-state view of a snapshot for the UI (pure, so it is tested without React). */
export function conversationUiState(snapshot: ConversationSnapshot): Omit<ConversationUi, "actions"> {
  const { phase, pauseReason, tip, startFailure } = snapshot;
  return {
    phase,
    statusText: STATUS_TEXT[phase],
    active: phase !== "off",
    canInterrupt: phase === "speaking" || phase === "thinking",
    needsContinue: phase === "paused",
    pauseMessage: phase === "paused" && pauseReason ? PAUSE_REASON_TEXT[pauseReason] : null,
    tip,
    startFailure,
  };
}

/**
 * Wires the Conversation controller to the live pieces: the dictation hook (microphone and audio
 * context), the speech player, voice barge-in, the screen wake lock and the page's visibility.
 */
export function useConversation({ dictation, send, cancelChat, isThinking, playback, clip }: Options): {
  controller: ConversationController;
  snapshot: ConversationSnapshot;
  ui: ConversationUi;
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
      new ConversationController(
        {
          openSession: () => dictationRef.current.openSession(),
          closeSession: () => dictationRef.current.closeSession(),
          audioReady: () => dictationRef.current.audioReady(),
          listen: (options) => dictationRef.current.listen({ handsFree: { noSpeechMs: NO_SPEECH_MS }, bargedIn: options?.bargedIn }),
          stopListening: () => dictationRef.current.discard(),
          finishListening: () => dictationRef.current.stop(),
          send: (text) => sendRef.current(text),
          cancelSpeech: () => getSpeechPlayer().cancel("conversation"),
          // An interrupt makes any answer still on its way stale: it may reach the screen, but is not spoken.
          interrupted: () => bumpVoiceEpoch(),
          cancelChat: () => cancelChatRef.current(),
          wakeLock: { acquire: () => wakeLock.acquire(), release: () => wakeLock.release() },
        },
        { bargeIn: bargeInOverride() },
      ),
  );

  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => OFF);

  // Playback first: when the chat turn finishes, the controller must already know whether it is speaking.
  useEffect(() => controller.playbackChanged(playback), [controller, playback]);
  useEffect(() => controller.chatRunning(isThinking), [controller, isThinking]);

  // Voice barge-in: while the assistant is audible (an answer, or the "one moment"), keep the microphone
  // open and watch for the user talking over it. Stops when the voice stops, on End or on a pause.
  const watching = snapshot.bargeInActive && (snapshot.phase === "speaking" || snapshot.phase === "thinking") && playback === "speaking";
  useEffect(() => {
    if (!watching) return;
    dictationRef.current.startBargeInWatch((trigger) => controller.bargeIn(trigger));
    return () => dictationRef.current.stopBargeInWatch();
  }, [controller, watching]);
  useEffect(() => {
    if (watching) dictationRef.current.noteClipStart(); // each clip has its own echo to calibrate against
  }, [watching, clip]);

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
      const { phase, pauseReason } = controller.getSnapshot();
      if (phase !== previous) traceVoice(`conversation ${phase}`, pauseReason ? `reason=${pauseReason}` : undefined);
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

  const actions = useMemo<ConversationUi["actions"]>(() => {
    /** Done synchronously inside the user's tap: a stale answer is dropped, audio is unlocked, the "one moment" clips are fetched. */
    const prepareInsideTap = () => {
      bumpVoiceEpoch();
      getSpeechPlayer().unlock();
      warmAcknowledgements();
    };
    return {
      start: () => {
        prepareInsideTap();
        getSpeechPlayer().cancel("start");
        return controller.start();
      },
      end: () => controller.end(),
      interrupt: () => {
        prepareInsideTap();
        return controller.interrupt();
      },
      continue: () => {
        prepareInsideTap();
        return controller.tap();
      },
      tap: () => {
        prepareInsideTap();
        return controller.tap();
      },
    };
  }, [controller]);

  const ui = useMemo<ConversationUi>(() => ({ ...conversationUiState(snapshot), actions }), [snapshot, actions]);

  return { controller, snapshot, ui };
}

