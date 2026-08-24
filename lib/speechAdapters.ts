import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import { stripMarkdown } from "./markdown";

/** Hebrew Unicode block (ְ֐–׿). Presence of any Hebrew letter picks he-IL. */
const HEBREW_PATTERN = /[֐-׿]/;

type SpeechLang = "he-IL" | "en-US";
type EndReason = "finished" | "cancelled" | "error";

/**
 * Read-aloud adapter for assistant-ui, with two refinements over the built-in
 * one: the reply is Markdown so we strip syntax first, and the spoken language
 * is chosen per-utterance from the actual text (Hebrew → he-IL, otherwise
 * en-US) with a matching voice when the browser offers one. Everything is
 * feature-detected; if speech synthesis is unavailable the utterance ends
 * immediately instead of throwing.
 */
export class MarkdownSpeechSynthesisAdapter implements SpeechSynthesisAdapter {
  speak(rawText: string): SpeechSynthesisAdapter.Utterance {
    const text = stripMarkdown(rawText);
    const subscribers = new Set<() => void>();

    const result: SpeechSynthesisAdapter.Utterance = {
      status: { type: "running" },
      cancel: () => {
        if (isSupported()) window.speechSynthesis.cancel();
        end("cancelled");
      },
      subscribe: (callback) => {
        if (result.status.type === "ended") {
          queueMicrotask(callback);
          return () => {};
        }
        subscribers.add(callback);
        return () => {
          subscribers.delete(callback);
        };
      },
    };

    const end = (reason: EndReason, error?: unknown) => {
      if (result.status.type === "ended") return;
      result.status = { type: "ended", reason, error };
      subscribers.forEach((callback) => callback());
    };

    if (!isSupported()) {
      queueMicrotask(() => end("error"));
      return result;
    }

    const lang = detectLanguage(text);
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;

    utterance.addEventListener("end", () => end("finished"));
    utterance.addEventListener("error", (event) => end("error", event.error));

    window.speechSynthesis.speak(utterance);
    return result;
  }
}

function isSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    "SpeechSynthesisUtterance" in window
  );
}

/** Choose the spoken language from the text itself, not a fixed default. */
function detectLanguage(text: string): SpeechLang {
  return HEBREW_PATTERN.test(text) ? "he-IL" : "en-US";
}

/** Prefer an exact locale match, then any voice sharing the base language. */
function pickVoice(lang: SpeechLang): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.split("-")[0];
  return (
    voices.find((voice) => voice.lang === lang) ??
    voices.find((voice) => voice.lang.startsWith(base))
  );
}
