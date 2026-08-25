import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import { stripMarkdown } from "./markdown";

type EndReason = "finished" | "cancelled" | "error";

/**
 * Read-aloud adapter for assistant-ui backed by OpenAI's neural TTS (via /api/tts).
 * It points an <audio> element at the streaming GET endpoint, so the browser plays
 * the speech progressively as it arrives (starts in about a second) instead of
 * waiting for the whole clip.
 */
export class MarkdownSpeechSynthesisAdapter implements SpeechSynthesisAdapter {
  speak(rawText: string): SpeechSynthesisAdapter.Utterance {
    const text = stripMarkdown(rawText);
    const subscribers = new Set<() => void>();
    let audio: HTMLAudioElement | null = null;

    const end = (reason: EndReason, error?: unknown) => {
      if (result.status.type === "ended") return;
      if (audio) {
        audio.pause();
        audio.src = "";
        audio = null;
      }
      result.status = { type: "ended", reason, error };
      subscribers.forEach((cb) => cb());
    };

    const result: SpeechSynthesisAdapter.Utterance = {
      status: { type: "running" },
      cancel: () => end("cancelled"),
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

    if (!text) {
      queueMicrotask(() => end("finished"));
      return result;
    }

    audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}`);
    audio.onended = () => end("finished");
    audio.onerror = () => end("error");
    audio.play().catch((error) => end("error", error));

    return result;
  }
}
