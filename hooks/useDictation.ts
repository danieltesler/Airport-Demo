"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uploadFilename } from "@/lib/audioMime";
import { BARGE_IN, BargeInWatch, type BargeInTrigger, type Frame, type MeterLike } from "@/lib/bargeIn";
import type { ListenOutcome, SessionResult } from "@/lib/conversation";
import { ENDPOINT_DEFAULTS, createEndpointer, type Endpointer } from "@/lib/endpointing";
import { micBlockedMessage } from "@/lib/micBlockedMessage";
import { MicSession } from "@/lib/micSession";
import type { RecorderLike } from "@/lib/preRoll";
import { traceBargeIn, traceVoice } from "@/lib/voiceTrace";
import { isGhostTranscript } from "@/lib/transcript";

interface UseDictationOptions {
  /** Called with the transcribed text once recording stops (drives auto-send in tap-to-talk). */
  onFinal: (transcript: string) => void;
  /** Hands-free mode: the result of each turn, instead of `onFinal`. */
  onOutcome?: (outcome: ListenOutcome) => void;
}

export interface ListenOptions {
  /** Hands-free: report through `onOutcome`, give up after this long without speech, and ignore one-word clips. */
  handsFree?: { noSpeechMs: number };
  /** This turn began with a voice barge-in: adopt the pre-roll recording so the first words are kept. */
  bargedIn?: boolean;
}

export interface Dictation {
  /** Audio recording + transcription is available in this browser. */
  supported: boolean;
  /** The page is not a secure context (plain http on a phone): the microphone cannot be used at all. */
  insecureContext: boolean;
  /** The mic is currently recording. */
  isRecording: boolean;
  /** Audio is being transcribed after recording stopped. */
  isTranscribing: boolean;
  /** A short, user-facing message when dictation can't run (e.g. mic blocked). */
  error: string | null;
  /** The last recording failed to upload and can be sent again without re-speaking. */
  canRetry: boolean;
  /** Tap-to-talk: record one question, stop on silence, transcribe, send. */
  start: () => void;
  /** Stop recording now and transcribe what was said. */
  stop: () => void;
  retry: () => void;
  /** Hands-free: open the microphone and audio context once, inside the user's tap, and keep them. */
  openSession: () => Promise<SessionResult>;
  closeSession: () => void;
  /** Between turns: is the audio context running and the microphone still live? */
  audioReady: () => Promise<boolean>;
  /** Record one turn on the open session. */
  listen: (options?: ListenOptions) => void;
  /** Stop recording and throw the clip away. */
  discard: () => void;
  /**
   * Voice barge-in: while the assistant is audible, read the microphone level and keep a rolling
   * pre-roll recording; call `onTrigger` when the user speaks over it. Hands-free mode only.
   */
  startBargeInWatch: (onTrigger: (trigger: BargeInTrigger) => void) => void;
  stopBargeInWatch: () => void;
  /** The assistant began a new clip: recalibrate the barge-in detector against its echo. */
  noteClipStart: () => void;
}

const POLL_MS = 100;
const STT_TIMEOUT_MS = 10000;
const HANDS_FREE_MIN_WORDS = 2; // a one-word clip in hands-free mode is far more likely a cough than a question

const micBlockedText = (): string => micBlockedMessage(typeof navigator === "undefined" ? "" : navigator.userAgent);
const NOT_CAUGHT = "I didn't catch that. Tap the mic and try again, or type your question.";
const NOT_HEARD = "I didn't hear anything. Tap the mic and try again, or type your question.";
const TRANSCRIBE_FAILED = "Couldn't transcribe that. Retry, or type your question.";

/** Level and zero-crossing rate of the latest audio block, for the barge-in detector. */
function readFrame(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): Frame {
  analyser.getByteTimeDomainData(buffer);
  let sumSquares = 0;
  let crossings = 0;
  let previous = buffer[0] - 128;
  for (let i = 0; i < buffer.length; i++) {
    const centred = buffer[i] - 128;
    sumSquares += (centred / 128) ** 2;
    if (i > 0 && (centred >= 0) !== (previous >= 0)) crossings += 1;
    previous = centred;
  }
  return { rms: Math.sqrt(sumSquares / buffer.length), zcr: crossings / buffer.length };
}

interface Turn {
  recorder: MediaRecorder;
  chunks: Blob[];
  discard: boolean;
  handsFree: boolean;
  /** The microphone was opened just for this turn (tap-to-talk) and closes with it. */
  ownsSession: boolean;
  endpointer: Endpointer | null;
  /** The level-meter nodes for this turn; disconnected whenever the turn ends, however it ends. */
  meter: { source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null;
  /** The level meter is reliable: the audio context was running, so silence means silence. */
  meterReliable: boolean;
  stopReason: string | null;
}

/** The browser's AudioContext constructor, or null where there is no Web Audio. */
function audioContextFactory(): (() => AudioContext) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  return Ctor ? () => new Ctor() : null;
}

const browserSupported = (): boolean =>
  typeof window !== "undefined" && typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

/**
 * Voice dictation that records audio in the browser, auto-stops when the speaker
 * pauses (see lib/endpointing.ts), and transcribes with OpenAI (via /api/stt).
 *
 * Tap-to-talk (`start`) opens the microphone for one question and closes it. Hands-free
 * (`openSession` + `listen`) keeps one microphone stream and audio context across turns: on
 * iOS a context created without a tap starts suspended, so it is made once, inside the tap.
 */
export function useDictation({ onFinal, onOutcome }: UseDictationOptions): Dictation {
  const [supported, setSupported] = useState(false);
  const [insecureContext, setInsecureContext] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const turnRef = useRef<Turn | null>(null);
  const watchRef = useRef<BargeInWatch | null>(null);
  const lastTriggerRef = useRef<BargeInTrigger | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failedBlobRef = useRef<Blob | null>(null);
  /** Set by `start` for the duration of its single turn, so the turn closes the microphone it opened. */
  const ownedByTapToTalk = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;

  useEffect(() => {
    setSupported(browserSupported());
    // getUserMedia only exists on https (or localhost): a phone opening http://<laptop-ip>:3000 gets no microphone.
    setInsecureContext(window.isSecureContext === false);
  }, []);

  const clearMeter = useCallback(() => {
    if (vadTimerRef.current) clearInterval(vadTimerRef.current);
    vadTimerRef.current = null;
  }, []);

  /** Called when the microphone stops by itself: drop any clip in progress and tell the conversation. */
  const handleMicEnded = useCallback(() => {
    const turn = turnRef.current;
    if (turn) {
      turn.discard = true;
      if (turn.recorder.state !== "inactive") turn.recorder.stop();
    }
    onOutcomeRef.current?.({ kind: "mic-lost" });
  }, []);

  const [mic] = useState(
    () =>
      new MicSession(
        {
          getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
          createAudioContext: audioContextFactory(),
          wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        },
        () => handleMicEndedRef.current(),
      ),
  );
  const handleMicEndedRef = useRef(handleMicEnded);
  handleMicEndedRef.current = handleMicEnded;

  const stopBargeInWatch = useCallback(() => {
    watchRef.current?.stop();
    watchRef.current = null;
    // Half-duplex again: the microphone is silent unless a turn is being recorded.
    if (!turnRef.current) mic.setEnabled(false);
  }, [mic]);

  const closeSession = useCallback(() => {
    watchRef.current?.stop();
    watchRef.current = null;
    clearMeter();
    if (mic.stream) traceVoice("mic close");
    mic.close();
  }, [clearMeter, mic]);

  const transcribe = useCallback(async (blob: Blob, handsFree: boolean) => {
    if (blob.size === 0) return;
    setIsTranscribing(true);
    setError(null);
    setCanRetry(false);
    const notify = (outcome: ListenOutcome) => onOutcomeRef.current?.(outcome);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
    try {
      const form = new FormData();
      form.append("audio", blob, uploadFilename(blob.type));
      const response = await fetch("/api/stt", { method: "POST", body: form, signal: controller.signal });
      if (!response.ok) throw new Error(`stt ${response.status}`);
      const { text } = (await response.json()) as { text?: string };
      const clean = (text ?? "").trim();
      failedBlobRef.current = null;
      if (isGhostTranscript(clean, handsFree ? HANDS_FREE_MIN_WORDS : 1)) {
        setError(NOT_CAUGHT);
        if (handsFree) notify({ kind: "empty" });
        return;
      }
      if (handsFree) notify({ kind: "transcript", text: clean });
      else onFinalRef.current(clean);
    } catch {
      // Keep the recording so Retry can resend it; the user shouldn't have to repeat themselves.
      failedBlobRef.current = blob;
      setCanRetry(!handsFree);
      setError(TRANSCRIBE_FAILED);
      if (handsFree) notify({ kind: "failed" });
    } finally {
      clearTimeout(timer);
      setIsTranscribing(false);
    }
  }, []);

  const retry = useCallback(() => {
    if (failedBlobRef.current) void transcribe(failedBlobRef.current, false);
  }, [transcribe]);

  /** A turn ended (silence, tap, cap, no-speech, or discarded): decide what to do with the clip. */
  const finishTurn = useCallback(
    (turn: Turn) => {
      traceVoice("listening end", turn.discard ? "discarded" : (turn.stopReason ?? "stopped"));
      clearMeter();
      // Over a long hands-free session these would pile up if only the silence detector disconnected them.
      turn.meter?.source.disconnect();
      turn.meter?.analyser.disconnect();
      turn.meter = null;
      turnRef.current = null;
      setIsRecording(false);
      // The microphone goes quiet between turns, and stays quiet while the assistant speaks.
      mic.setEnabled(false);
      if (turn.ownsSession) closeSession();
      if (turn.discard) return;

      const notify = (outcome: ListenOutcome) => onOutcomeRef.current?.(outcome);
      if (turn.stopReason === "no-speech") {
        notify({ kind: "no-speech" });
        return;
      }
      const blob = new Blob(turn.chunks, { type: turn.recorder.mimeType || "audio/webm" });
      // A clip with no detected speech is silence or room noise; sent to speech recognition it
      // comes back as a ghost like "Thank you.". Only trusted when the level meter was working.
      if (turn.meterReliable && turn.endpointer && !turn.endpointer.hadSpeech) {
        setError(NOT_HEARD);
        if (turn.handsFree) notify({ kind: "empty" });
        return;
      }
      void transcribe(blob, turn.handsFree);
    },
    [clearMeter, closeSession, mic, transcribe],
  );

  const stop = useCallback(() => {
    const turn = turnRef.current;
    if (turn && turn.recorder.state !== "inactive") turn.recorder.stop();
  }, []);

  const discard = useCallback(() => {
    const turn = turnRef.current;
    if (!turn) return;
    turn.discard = true;
    if (turn.recorder.state !== "inactive") turn.recorder.stop();
    else finishTurn(turn);
  }, [finishTurn]);

  const openSession = useCallback(async (): Promise<SessionResult> => {
    if (!browserSupported()) return "unsupported";
    // The first lines of MicSession.open run synchronously: this must be called inside the user's tap.
    traceVoice("mic open requested");
    const result = await mic.open();
    traceVoice("mic open result", result);
    if (result === "denied") setError(micBlockedText());
    return result;
  }, [mic]);

  const audioReady = useCallback(() => mic.ready(), [mic]);

  const listen = useCallback(
    (options: ListenOptions = {}) => {
      const stream = mic.stream;
      const audioCtx = mic.audioCtx;
      if (!stream || turnRef.current) return;
      setError(null);
      setCanRetry(false);
      failedBlobRef.current = null;

      mic.setEnabled(true);
      // After a voice barge-in the recording that began before the user spoke is adopted (it already
      // holds their first words); otherwise (or if there is none) a fresh recorder starts now.
      const adopted = options.bargedIn ? (watchRef.current?.takePreRoll() ?? null) : null;
      if (options.bargedIn) traceVoice("pre-roll", adopted ? `adopted, ${Date.now() - adopted.startedAt} ms before now` : "none available");
      const recorder = adopted ? (adopted.recorder as unknown as MediaRecorder) : new MediaRecorder(stream);
      const handsFree = Boolean(options.handsFree);
      const turn: Turn = {
        recorder,
        chunks: adopted ? adopted.chunks : [],
        discard: false,
        handsFree,
        ownsSession: !handsFree && ownedByTapToTalk.current,
        endpointer: null,
        meter: null,
        meterReliable: audioCtx?.state === "running",
        stopReason: null,
      };
      if (!adopted) {
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) turn.chunks.push(e.data);
        };
      }
      recorder.onstop = () => finishTurn(turn);
      turnRef.current = turn;
      if (!adopted) recorder.start();
      traceVoice("listening start", options.bargedIn ? (adopted ? "after barge-in, pre-roll kept" : "after barge-in, no pre-roll") : handsFree ? "hands-free" : "tap");
      setIsRecording(true);
      // The pre-roll has been taken (or is not needed): let go of the rest of the watch, keep the microphone on.
      if (options.bargedIn) {
        watchRef.current?.stop();
        watchRef.current = null;
      }

      // Auto-stop on silence. Without Web Audio, recording still works via the button.
      if (!audioCtx) return;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);
      turn.meter = { source, analyser };
      const buffer = new Uint8Array(analyser.fftSize);
      // Speech was already confirmed by the barge-in detector: skip calibrating in the middle of the sentence.
      const trigger = lastTriggerRef.current;
      const seed = adopted && trigger ? { threshold: Math.max(0.03, trigger.threshold * 0.5), speechMs: BARGE_IN.sustainMs } : undefined;
      lastTriggerRef.current = null;
      const endpointer = createEndpointer(Date.now(), { ...ENDPOINT_DEFAULTS, noSpeechMs: options.handsFree?.noSpeechMs ?? 0 }, seed);
      turn.endpointer = endpointer;

      vadTimerRef.current = setInterval(() => {
        analyser.getByteTimeDomainData(buffer);
        let sumSquares = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sumSquares += v * v;
        }
        const reason = endpointer.update(Math.sqrt(sumSquares / buffer.length), Date.now());
        if (!reason) return;
        turn.stopReason = reason;
        stop();
      }, POLL_MS);
    },
    [finishTurn, mic, stop],
  );

  const startBargeInWatch = useCallback(
    (onTrigger: (trigger: BargeInTrigger) => void) => {
      const stream = mic.stream;
      const audioCtx = mic.audioCtx;
      if (!stream || !audioCtx || watchRef.current?.running || turnRef.current) return;
      mic.setEnabled(true); // full duplex while the assistant talks: the browser's echo cancellation keeps its voice out
      const watch = new BargeInWatch(
        {
          createMeter: (): MeterLike => {
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 1024;
            const source = audioCtx.createMediaStreamSource(stream);
            source.connect(analyser);
            const buffer = new Uint8Array(analyser.fftSize);
            return {
              read: () => readFrame(analyser, buffer),
              dispose: () => {
                source.disconnect();
                analyser.disconnect();
              },
            };
          },
          createRecorder: () => new MediaRecorder(stream) as unknown as RecorderLike,
          now: () => Date.now(),
          setTimer: (callback, ms) => setTimeout(callback, ms),
          clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
          setPoll: (callback, ms) => setInterval(callback, ms),
          clearPoll: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
        },
        {
          onTrigger: (trigger) => {
            lastTriggerRef.current = trigger;
            onTrigger(trigger);
          },
          onArmed: (threshold) => traceBargeIn("armed", { threshold }),
        },
      );
      watchRef.current = watch;
      watch.start();
    },
    [mic],
  );

  const noteClipStart = useCallback(() => watchRef.current?.clipStarted(), []);

  const startTurnOnce = useCallback(async () => {
    setError(null);
    setCanRetry(false);
    failedBlobRef.current = null;
    ownedByTapToTalk.current = true;
    const opened = await openSession(); // its first lines run synchronously inside the tap
    if (opened === "denied" || opened === "unsupported") {
      ownedByTapToTalk.current = false;
      return;
    }
    // A suspended context still records; the level meter is flagged unreliable and the clip is kept.
    listen();
    ownedByTapToTalk.current = false;
  }, [listen, openSession]);

  const startingRef = useRef(false);

  const start = useCallback(async () => {
    if (turnRef.current || startingRef.current) return; // a second tap while the microphone is opening does nothing
    startingRef.current = true;
    try {
      await startTurnOnce();
    } finally {
      startingRef.current = false;
    }
  }, [startTurnOnce]);

  useEffect(
    () => () => {
      const turn = turnRef.current;
      if (turn) turn.discard = true;
      closeSession();
    },
    [closeSession],
  );

  return {
    supported,
    insecureContext,
    isRecording,
    isTranscribing,
    error,
    canRetry,
    start,
    stop,
    retry,
    openSession,
    closeSession,
    audioReady,
    listen,
    discard,
    startBargeInWatch,
    stopBargeInWatch,
    noteClipStart,
  };
}
