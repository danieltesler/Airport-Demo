"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Minimal, module-local typings for the Web Speech `SpeechRecognition` API.
 * TypeScript's DOM lib does not ship these, and we deliberately avoid a global
 * `Window` augmentation so we don't clash with the one @assistant-ui provides.
 */
interface SpeechAlternative {
  readonly transcript: string;
}
interface SpeechResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechAlternative;
}
interface SpeechResultList {
  readonly length: number;
  readonly [index: number]: SpeechResult;
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: ((event: Event) => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognitionConstructor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  return (ctor as unknown as SpeechRecognitionCtor | undefined) ?? null;
}

interface UseDictationOptions {
  /** BCP-47 recognition language, e.g. "en-US" or "he-IL". */
  lang: string;
  /** Live partial transcript, for showing text landing in the input. */
  onInterim: (transcript: string) => void;
  /** Final transcript once the user stops speaking (drives auto-send). */
  onFinal: (transcript: string) => void;
}

export interface Dictation {
  /** SpeechRecognition is available in this browser. */
  supported: boolean;
  /** Recording is in progress. */
  isListening: boolean;
  start: () => void;
  stop: () => void;
}

/**
 * Wraps the Web Speech `SpeechRecognition` API for one-shot dictation.
 *
 * Recognition runs non-continuously with interim results, so it stops on its
 * own when the speaker pauses; the accumulated final transcript is delivered via
 * `onFinal` (the caller uses that to auto-send). Everything is feature-detected
 * and the recognizer is rebuilt when the language changes, so Hebrew speech is
 * recognized as Hebrew rather than silently returning nothing under en-US.
 */
export function useDictation({ lang, onInterim, onFinal }: UseDictationOptions): Dictation {
  const [supported, setSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const finalTranscriptRef = useRef("");

  // Keep the latest callbacks/lang without rebuilding the recognizer each render.
  const onInterimRef = useRef(onInterim);
  const onFinalRef = useRef(onFinal);
  const langRef = useRef(lang);
  onInterimRef.current = onInterim;
  onFinalRef.current = onFinal;
  langRef.current = lang;

  useEffect(() => {
    const RecognitionCtor = getRecognitionConstructor();
    if (!RecognitionCtor) return;

    const recognition = new RecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) final += text;
        else interim += text;
      }
      if (final) finalTranscriptRef.current += final;
      onInterimRef.current((finalTranscriptRef.current + interim).trim());
    };

    recognition.onerror = () => setIsListening(false);

    recognition.onend = () => {
      setIsListening(false);
      const transcript = finalTranscriptRef.current.trim();
      finalTranscriptRef.current = "";
      if (transcript) onFinalRef.current(transcript);
    };

    recognitionRef.current = recognition;
    setSupported(true);

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
      recognitionRef.current = null;
    };
  }, []);

  const start = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || isListening) return;
    finalTranscriptRef.current = "";
    recognition.lang = langRef.current;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      // start() throws if called while already active; keep state consistent.
      setIsListening(false);
    }
  }, [isListening]);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  return { supported, isListening, start, stop };
}
