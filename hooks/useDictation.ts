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

/**
 * Voice dictation that records audio in the browser and transcribes it with
 * OpenAI (via /api/stt). Transcription auto-detects the spoken language, so the
 * user can talk in English or Hebrew with no language toggle: the transcript comes
 * back in whatever they spoke, the agent replies in that language, and read-aloud
 * follows suit.
 */
export function useDictation({ onFinal }: UseDictationOptions): Dictation {
  const [supported, setSupported] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    setSupported(
      typeof window !== "undefined" &&
        typeof MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia),
    );
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

    const recorder = new MediaRecorder(stream);
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      void transcribe(blob);
    };

    recorderRef.current = recorder;
    recorder.start();
    setIsRecording(true);
  }, [isRecording, transcribe]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    recorderRef.current = null;
    setIsRecording(false);
  }, []);

  return { supported, isRecording, isTranscribing, error, start, stop };
}
