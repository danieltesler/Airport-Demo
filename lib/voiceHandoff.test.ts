import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatModelRunOptions, ThreadMessage } from "@assistant-ui/react";

/**
 * The reported symptom on the phone: in Conversation mode the assistant "answers for a quick second,
 * cuts off, then answers nicely". These tests run the real adapter, the real acknowledgement timer
 * and the real SpeechPlayer against a recording fake audio element and fake timers, and assert the
 * exact sequence of what the speaker would do.
 */

const holder = vi.hoisted(() => ({ player: null as unknown }));
vi.mock("./voicePlayback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./voicePlayback")>()),
  getSpeechPlayer: () => holder.player,
}));

import { resetAcknowledgementState, ACK_PHRASES } from "./acknowledgement";
import { airportChatAdapter } from "./chatModelAdapter";
import { SpeechPlayer, type AudioLike } from "./voicePlayback";
import { bumpVoiceEpoch } from "./voiceSession";
import { markVoiceTurn } from "./voiceTurn";

const CLIP_MS = new Map<string, number>(); // how long each clip lasts when played

/** An audio element that records what it was told, and ends clips on the fake clock. */
class RecordingAudio implements AudioLike {
  src = "";
  onended: ((event: Event) => unknown) | null = null;
  onerror: ((event: Event | string) => unknown) | null = null;
  log: string[] = [];
  private playing: { text: string; startedAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Clips stopped before they finished: the audible "cut off". */
  truncated: string[] = [];

  play = vi.fn(async () => {
    const text = this.src.replace("blob:", "");
    if (!text) return; // the silent unlock clip
    const duration = CLIP_MS.get(text) ?? 3000;
    this.log.push(`play ${label(text)}`);
    const timer = setTimeout(() => {
      this.log.push(`ended ${label(text)}`);
      this.playing = null;
      this.onended?.(new Event("ended"));
    }, duration);
    this.playing = { text, startedAt: Date.now(), timer };
  });

  pause = vi.fn(() => {
    if (!this.playing) return;
    clearTimeout(this.playing.timer);
    const elapsed = Date.now() - this.playing.startedAt;
    this.log.push(`pause ${label(this.playing.text)} after ${elapsed}ms`);
    this.truncated.push(this.playing.text);
    this.playing = null;
  });
}

const label = (text: string): string => (ACK_PHRASES as readonly string[]).includes(text) ? "ACK" : `ANSWER(${text.slice(0, 18).trim()})`;

const ANSWER = "Sure, Los Angeles stands out. It is growing fastest.";

function makeWorld(options: { chatDelayMs: number; fetchDelayMs?: number }) {
  const audio = new RecordingAudio();
  const clipRequests: string[] = [];
  const player = new SpeechPlayer({
    fetchClip: (text, signal) =>
      new Promise<Blob>((resolve, reject) => {
        clipRequests.push(text);
        const timer = setTimeout(() => resolve(new Blob([text])), ACK_PHRASES.includes(text as never) ? 0 : (options.fetchDelayMs ?? 700));
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    createAudio: () => audio,
    createObjectUrl: (blob) => `blob:${(blob as unknown as { __text?: string }).__text ?? ""}`,
    revokeObjectUrl: () => undefined,
  });
  holder.player = player;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify({ reply: "Los Angeles leads.", spoken: ANSWER }))), options.chatDelayMs))),
  );
  return { audio, player, clipRequests };
}

const userMessage = (text: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }] }) as unknown as ThreadMessage;
const ask = (text: string) =>
  airportChatAdapter.run({ messages: [userMessage(text)], abortSignal: new AbortController().signal } as unknown as ChatModelRunOptions) as unknown as Promise<unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  resetAcknowledgementState();
  CLIP_MS.clear();
  // The blob text: make Blob carry its text so the fake element can say which clip it is playing.
  const RealBlob = Blob;
  vi.stubGlobal(
    "Blob",
    class extends RealBlob {
      __text: string;
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        this.__text = String(parts?.[0] ?? "");
      }
    },
  );
  for (const phrase of ACK_PHRASES) CLIP_MS.set(phrase, 1500);
  CLIP_MS.set("Sure, Los Angeles stands out.", 2500);
  CLIP_MS.set("It is growing fastest.", 2000);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the answer arrives while the 'one moment' is still being said", () => {
  it("lets the phrase finish, then speaks the whole answer once, with no cut-off", async () => {
    const { audio, clipRequests } = makeWorld({ chatDelayMs: 2500 }); // the answer lands 1 s into the 1.5 s phrase
    markVoiceTurn("top airports in LA");
    const pending = ask("top airports in LA");

    await vi.advanceTimersByTimeAsync(1600); // the acknowledgement began at 1.5 s
    expect(audio.log.filter((entry) => entry.startsWith("play ACK"))).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10_000);
    await pending;

    // Nothing was ever stopped mid-clip.
    expect(audio.truncated).toEqual([]);
    expect(audio.pause).not.toHaveBeenCalled();

    // The exact sequence: the phrase, to its end, then each sentence of the answer in order, to its end.
    expect(audio.log).toEqual([
      "play ACK",
      "ended ACK",
      "play ANSWER(Sure, Los Angeles)",
      "ended ANSWER(Sure, Los Angeles)",
      "play ANSWER(It is growing fast)",
      "ended ANSWER(It is growing fast)",
    ]);

    // Each answer sentence was requested exactly once (no second speak path, no re-request).
    expect(clipRequests.filter((text) => !(ACK_PHRASES as readonly string[]).includes(text))).toEqual(["Sure, Los Angeles stands out.", "It is growing fastest."]);
  });

  it("starts fetching the answer while the phrase plays, so there is no silent gap after it", async () => {
    const { audio, clipRequests } = makeWorld({ chatDelayMs: 2500, fetchDelayMs: 700 });
    markVoiceTurn("q");
    const pending = ask("q");
    await vi.advanceTimersByTimeAsync(2600);
    // The phrase is still playing (until 3000 ms), yet the answer's clips are already requested.
    expect(clipRequests.some((text) => text.startsWith("Sure, Los Angeles"))).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    // The first answer clip began the moment the phrase ended.
    const ackEnd = audio.log.indexOf("ended ACK");
    expect(audio.log[ackEnd + 1]).toBe("play ANSWER(Sure, Los Angeles)");
  });

  it("an answer that arrives before the phrase has started never starts the phrase at all", async () => {
    const { audio } = makeWorld({ chatDelayMs: 1000 });
    markVoiceTurn("q");
    const pending = ask("q");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(audio.log.some((entry) => entry.includes("ACK"))).toBe(false);
    expect(audio.truncated).toEqual([]);
    expect(audio.log).toEqual([
      "play ANSWER(Sure, Los Angeles)",
      "ended ANSWER(Sure, Los Angeles)",
      "play ANSWER(It is growing fast)",
      "ended ANSWER(It is growing fast)",
    ]);
  });

  it("an answer that arrives long after the phrase ended is spoken normally, once", async () => {
    const { audio } = makeWorld({ chatDelayMs: 6000 });
    markVoiceTurn("q");
    const pending = ask("q");
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(audio.truncated).toEqual([]);
    expect(audio.log.filter((entry) => entry.startsWith("play ANSWER"))).toHaveLength(2); // its two sentences, once each
    expect(audio.log.filter((entry) => entry === "play ACK")).toHaveLength(1);
  });

  it("if the answer's first clip was still loading when the phrase had not started, it replaces nothing audible", async () => {
    const { audio } = makeWorld({ chatDelayMs: 1450 });
    markVoiceTurn("q");
    const pending = ask("q");
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(audio.truncated).toEqual([]);
  });
});

describe("when the user moves on, a phrase in progress is stopped", () => {
  it("End (an epoch bump) after the phrase started does not queue the answer behind it", async () => {
    const { audio } = makeWorld({ chatDelayMs: 2500 });
    markVoiceTurn("q");
    const pending = ask("q");
    await vi.advanceTimersByTimeAsync(2000);
    bumpVoiceEpoch(); // End
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(audio.log.some((entry) => entry.startsWith("play ANSWER"))).toBe(false);
  });
});
