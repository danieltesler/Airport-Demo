"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { stripMarkdown } from "@/lib/markdown";

interface UseSpeechResult {
  /** True when SpeechRecognition (mic dictation) is available in this browser. */
  recognitionSupported: boolean;
  /** True when speechSynthesis (read aloud) is available in this browser. */
  synthesisSupported: boolean;
  /** True while the mic is actively listening. */
  isListening: boolean;
  /** True while text is being spoken aloud. */
  isSpeaking: boolean;
  /** Start dictation; recognized text is delivered via the onResult callback. */
  startListening: () => void;
  stopListening: () => void;
  /** Speak Markdown text aloud (markdown is stripped first). */
  speak: (markdown: string) => void;
  /** Stop any in-progress speech. */
  cancelSpeaking: () => void;
}

/**
 * Wraps the browser Web Speech API for both directions:
 *  - SpeechRecognition -> dictate into the input (onResult callback)
 *  - speechSynthesis    -> read the assistant reply aloud
 *
 * Everything is feature-detected. On unsupported browsers the `*Supported`
 * flags are false and the action methods are safe no-ops, so the UI can hide
 * the controls without any risk of a crash.
 */
export function useSpeech(onResult: (transcript: string) => void): UseSpeechResult {
  const [recognitionSupported, setRecognitionSupported] = useState(false);
  const [synthesisSupported, setSynthesisSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  // Keep the latest callback without re-creating the recognizer each render.
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  // Detect capabilities and build the recognizer once, on the client only.
  useEffect(() => {
    if (typeof window === "undefined") return;

    setSynthesisSupported("speechSynthesis" in window);

    const RecognitionCtor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!RecognitionCtor) return;

    const recognition = new RecognitionCtor();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) onResultRef.current(transcript);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    setRecognitionSupported(true);

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.abort();
    };
  }, []);

  // Stop speech synthesis if the component unmounts mid-utterance.
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && "speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const startListening = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition || isListening) return;
    try {
      recognition.start();
      setIsListening(true);
    } catch {
      // start() throws if already started; keep state consistent.
      setIsListening(false);
    }
  }, [isListening]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  const speak = useCallback(
    (markdown: string) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const text = stripMarkdown(markdown);
      if (!text) return;

      window.speechSynthesis.cancel(); // replace any current utterance
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 1;
      utterance.onstart = () => setIsSpeaking(true);
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
    },
    []
  );

  const cancelSpeaking = useCallback(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, []);

  return {
    recognitionSupported,
    synthesisSupported,
    isListening,
    isSpeaking,
    startListening,
    stopListening,
    speak,
    cancelSpeaking,
  };
}
