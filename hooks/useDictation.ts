"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UseDictationOptions {
  /** Called with the transcribed text once recording stops (drives auto-send). */
  onFinal: (transcript: string) => void;
}

export interface Dictation {
  /** Audio recording + transcription is available in this browser. */
  supported: boolean;
  /** The mic is currently recording. */
  isRecording: boolean;
  /** Audio is being transcribed after recording stopped. */
  isTranscribing: boolean;
  /** A short, user-facing message when dictation can't run (e.g. mic blocked). */
  error: string | null;
  start: () => void;
  stop: () => void;
}

// Voice-activity thresholds for the auto-stop.
const SPEECH_RMS = 0.02; // loud enough to count as speech
const SILENCE_MS = 1500; // stop this long after the last speech
const MAX_MS = 20000; // hard cap on a single utterance

/**
 * Voice dictation that records audio in the browser, auto-stops when the speaker
 * pauses, and transcribes with OpenAI (via /api/stt). No second click to send: it
 * stops on silence and the transcript auto-sends.
 */
export function useDictation({ onFinal }: UseDictationOptions): Dictation {
  const [supported, setSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const vadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        typeof MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
  }, []);

  const teardownListening = useCallback(() => {
    if (vadTimerRef.current) {
      clearInterval(vadTimerRef.current);
      vadTimerRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const transcribe = useCallback(async (blob: Blob) => {
    if (blob.size === 0) return;
    setIsTranscribing(true);
    try {
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
      const response = await fetch("/api/stt", { method: "POST", body: form });
      if (!response.ok) throw new Error(`stt ${response.status}`);
      const { text } = (await response.json()) as { text?: string };
      const clean = (text ?? "").trim();
      if (clean) onFinalRef.current(clean);
    } catch {
      setError("Couldn't transcribe that — please try again.");
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
    teardownListening();
    setIsRecording(false);
  }, [teardownListening]);

  const start = useCallback(async () => {
    if (isRecording) return;
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access is blocked. Allow it in your browser, then try again.");
      return;
    }
    streamRef.current = stream;

    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      void transcribe(blob);
    };
    recorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);

    // Auto-stop on silence: watch the mic level and stop once the speaker pauses.
    // If the Web Audio API isn't available, recording still works via the button.
    const AudioCtxCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxCtor) return;

    const audioCtx = new AudioCtxCtor();
    audioCtxRef.current = audioCtx;
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const buffer = new Uint8Array(analyser.fftSize);

    const startedAt = Date.now();
    let lastLoudAt = startedAt;
    let hasSpoken = false;

    vadTimerRef.current = setInterval(() => {
      analyser.getByteTimeDomainData(buffer);
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i++) {
        const v = (buffer[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / buffer.length);
      const now = Date.now();

      if (rms > SPEECH_RMS) {
        hasSpoken = true;
        lastLoudAt = now;
      }
      const silentLongEnough = hasSpoken && now - lastLoudAt > SILENCE_MS;
      const tooLong = now - startedAt > MAX_MS;
      if (silentLongEnough || tooLong) stop();
    }, 150);
  }, [isRecording, transcribe, stop]);

  useEffect(() => teardownListening, [teardownListening]);

  return { supported, isRecording, isTranscribing, error, start, stop };
}
