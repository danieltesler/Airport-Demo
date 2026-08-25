import type { SpeechSynthesisAdapter } from "@assistant-ui/react";
import { stripMarkdown } from "./markdown";

type EndReason = "finished" | "cancelled" | "error";

/**
 * Read-aloud adapter for assistant-ui backed by OpenAI's neural TTS (via /api/tts),
 * rather than the browser's robotic speechSynthesis. The reply is Markdown, so we
 * strip the syntax, POST the plain text to /api/tts, and play the returned audio.
 * The server picks the voice from the text's language, so Hebrew and English each
 * get their own natural voice.
 */
export class MarkdownSpeechSynthesisAdapter implements SpeechSynthesisAdapter {
  speak(rawText: string): SpeechSynthesisAdapter.Utterance {
    const text = stripMarkdown(rawText);
    const subscribers = new Set<() => void>();
    let audio: HTMLAudioElement | null = null;
    let objectUrl: string | null = null;

    const cleanup = () => {
      if (audio) {
        audio.pause();
        audio.src = "";
        audio = null;
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
    };

    const end = (reason: EndReason, error?: unknown) => {
      if (result.status.type === "ended") return;
      cleanup();
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

    void (async () => {
      try {
        const response = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!response.ok) throw new Error(`tts ${response.status}`);

        const blob = await response.blob();
        if (result.status.type === "ended") return; // cancelled while fetching

        objectUrl = URL.createObjectURL(blob);
        audio = new Audio(objectUrl);
        audio.onended = () => end("finished");
        audio.onerror = () => end("error");
        await audio.play();
      } catch (error) {
        end("error", error);
      }
    })();

    return result;
  }
}
