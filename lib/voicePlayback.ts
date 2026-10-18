/**
 * Speech playback engine: turns text into spoken audio, one sentence at a time.
 *
 * - One persistent <audio> element, unlocked by the user's tap, so replies that
 *   start later (after an async answer) are still allowed to play on mobile Safari.
 * - Sentences are synthesised through POST /api/tts (text never goes in a URL),
 *   up to MAX_CONCURRENT_CLIPS at a time, and played strictly in order, so the
 *   first short clip starts sooner than one long clip would.
 * - cancel() aborts in-flight requests and stops audio; if the browser refuses
 *   autoplay the player says so ("blocked") and waits for resume() from a tap.
 *
 * Browser access is injected (PlayerDeps) so the queue logic is unit-tested without a DOM.
 */

import { splitIntoSentences } from "./sentences";

export type PlaybackStatus = "idle" | "loading" | "speaking" | "blocked" | "error";

export interface PlaybackSnapshot {
  status: PlaybackStatus;
  /** The text being spoken, so a message can tell whether the player is reading it. */
  text: string | null;
  /** Which TTS provider produced the audio (from the server's X-TTS-Provider header). */
  provider?: string | null;
}

export interface AudioLike {
  src: string;
  onended: ((event: Event) => unknown) | null;
  onerror: ((event: Event | string) => unknown) | null;
  play(): Promise<void>;
  pause(): void;
}

export interface PlayerDeps {
  /** `first` is the clip the listener is waiting on in silence, so it gets the shorter patience. */
  fetchClip(text: string, signal: AbortSignal, hints?: { first: boolean }): Promise<Blob>;
  createAudio(): AudioLike;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

const MAX_CONCURRENT_CLIPS = 4;
const MIN_SENTENCE_CHARS = 20; // shorter fragments ("U.S.", "Hi.") are merged into the next sentence
// Covers the slow path: ElevenLabs gives up after 2.5 s, then the OpenAI fallback clip took 9-12 s
// when measured. The normal ElevenLabs clip arrives in about 0.7 s, so this only bounds a dead server.
const CLIP_TIMEOUT_MS = 15000;
// The first clip is the one the listener waits on in silence. ElevenLabs answers in about 0.7 s, and
// the OpenAI fallback sends its headers after the 2.5 s ElevenLabs timeout plus its own start, so 6 s
// to the response headers covers both. Once headers arrive (the server has produced audio, with or
// without X-TTS-Fallback), the body gets the long window above. Past 6 s with nothing: voice is off.
export const FIRST_CLIP_HEADER_TIMEOUT_MS = 6000;
const MAX_FAILURES_BEFORE_MUTE = 2;

const IDLE: PlaybackSnapshot = { status: "idle", text: null };

/** Split speech text into sentences (see lib/sentences.ts), merging fragments too short to be worth a request. */
export function splitSentences(text: string): string[] {
  const raw = splitIntoSentences(text);
  const sentences: string[] = [];
  let carry = "";
  for (const piece of raw) {
    const joined = `${carry} ${piece}`.trim();
    if (joined.length < MIN_SENTENCE_CHARS) {
      carry = joined;
      continue;
    }
    sentences.push(joined);
    carry = "";
  }
  if (carry) {
    if (sentences.length > 0) sentences[sentences.length - 1] += ` ${carry}`;
    else sentences.push(carry);
  }
  return sentences;
}

/** A short silent WAV, built in code, played inside the user's tap to unlock the element. */
function silentWavDataUri(): string {
  const samples = 200;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples * 2, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

const isAutoplayBlock = (error: unknown): boolean =>
  error instanceof Error && error.name === "NotAllowedError";

export class SpeechPlayer {
  private audio: AudioLike | null = null;
  private snapshot: PlaybackSnapshot = IDLE;
  private listeners = new Set<() => void>();
  private runId = 0;
  private controller: AbortController | null = null;
  private resumeWaiter: (() => void) | null = null;
  /** Ends the clip that is playing, so a cancel never leaves its promise (and object URL) hanging. */
  private settleCurrentClip: (() => void) | null = null;
  private consecutiveFailures = 0;

  constructor(private readonly deps: PlayerDeps) {}

  /** After repeated failures, auto-speak stops for the session; the tap-to-read button still works. */
  get autoSpeakAllowed(): boolean {
    return this.consecutiveFailures < MAX_FAILURES_BEFORE_MUTE;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  /** Call synchronously inside a click handler: it is what lets later audio play. */
  unlock(): void {
    const audio = this.ensureAudio();
    if (this.snapshot.status !== "idle") return;
    audio.src = silentWavDataUri();
    audio.play().catch(() => {
      // An unlock that is refused just means the first spoken clip may need a tap.
    });
  }

  speak(text: string): void {
    this.cancel();
    const sentences = splitSentences(text);
    if (sentences.length === 0) return;

    const runId = this.runId;
    const controller = new AbortController();
    this.controller = controller;
    this.setSnapshot({ status: "loading", text });

    const clips = this.requestClips(sentences, controller.signal);
    void this.playInOrder(runId, clips);
  }

  /** Stop everything: abort requests, silence the element, drop the queue. */
  cancel(): void {
    this.runId += 1;
    this.controller?.abort();
    this.controller = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.pause();
    }
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.settleCurrentClip?.();
    this.setSnapshot(IDLE);
  }

  /** Record which provider spoke the current answer, for the UI and logs. */
  noteProvider(provider: string): void {
    if (this.snapshot.status === "idle") return;
    this.setSnapshot({ ...this.snapshot, provider });
  }

  /** Retry playback after the browser blocked autoplay; call from a tap. */
  resume(): void {
    this.resumeWaiter?.();
    this.resumeWaiter = null;
  }

  /** Clear an error state once the user has seen it. */
  dismissError(): void {
    if (this.snapshot.status === "error") this.setSnapshot(IDLE);
  }

  /** Sliding window: clip i is requested once clip i - MAX_CONCURRENT_CLIPS has arrived. */
  private requestClips(sentences: string[], signal: AbortSignal): Promise<Blob>[] {
    const clips: Promise<Blob>[] = [];
    sentences.forEach((sentence, i) => {
      // A clip behind the concurrency window is requested later; by then the answer may be cancelled.
      const request = () =>
        signal.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : this.deps.fetchClip(sentence, signal, { first: i === 0 });
      clips.push(
        i < MAX_CONCURRENT_CLIPS ? request() : clips[i - MAX_CONCURRENT_CLIPS].catch(() => null).then(request),
      );
      // Failures surface where the clip is awaited; this only avoids an unhandled rejection
      // for clips that are never reached after a cancel.
      clips[i].catch(() => undefined);
    });
    return clips;
  }

  private async playInOrder(runId: number, clips: Promise<Blob>[]): Promise<void> {
    try {
      for (let i = 0; i < clips.length; i++) {
        const blob = await clips[i];
        if (runId !== this.runId) return;
        this.consecutiveFailures = 0;
        await this.playClip(runId, blob);
        if (runId !== this.runId) return;
      }
      this.setSnapshot(IDLE);
    } catch {
      if (runId !== this.runId) return;
      this.consecutiveFailures += 1;
      this.audio?.pause();
      this.setSnapshot({ ...this.snapshot, status: "error" });
    }
  }

  private async playClip(runId: number, blob: Blob): Promise<void> {
    const audio = this.ensureAudio();
    const url = this.deps.createObjectUrl(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        this.settleCurrentClip = () => resolve();
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("playback failed"));
        audio.src = url;
        this.startPlaying(runId, audio).catch(reject);
      });
    } finally {
      this.settleCurrentClip = null;
      this.deps.revokeObjectUrl(url);
    }
  }

  private async startPlaying(runId: number, audio: AudioLike): Promise<void> {
    for (;;) {
      try {
        await audio.play();
        if (runId === this.runId) this.setSnapshot({ ...this.snapshot, status: "speaking" });
        return;
      } catch (error) {
        if (!isAutoplayBlock(error)) throw error;
        if (runId !== this.runId) return;
        this.setSnapshot({ ...this.snapshot, status: "blocked" });
        await new Promise<void>((resolve) => {
          this.resumeWaiter = resolve;
        });
        if (runId !== this.runId) return;
      }
    }
  }

  private ensureAudio(): AudioLike {
    if (!this.audio) this.audio = this.deps.createAudio();
    return this.audio;
  }

  private setSnapshot(next: PlaybackSnapshot): void {
    if (
      next.status === this.snapshot.status &&
      next.text === this.snapshot.text &&
      (next.provider ?? null) === (this.snapshot.provider ?? null)
    ) {
      return;
    }
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

/**
 * POST one sentence to /api/tts and return its audio. It gives up if no response arrives within
 * `headerTimeoutMs`, and, once one has, if the audio takes longer than CLIP_TIMEOUT_MS to read.
 */
export async function fetchClipFromApi(
  text: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  onProvider?: (provider: string) => void,
  headerTimeoutMs: number = CLIP_TIMEOUT_MS,
): Promise<Blob> {
  // An abort event that already happened is never delivered to a listener added now.
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
  const timeout = new AbortController();
  let timer = setTimeout(() => timeout.abort(), headerTimeoutMs);
  const abortBoth = () => timeout.abort();
  signal.addEventListener("abort", abortBoth);
  try {
    const response = await fetchImpl("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: timeout.signal,
    });
    clearTimeout(timer);
    timer = setTimeout(() => timeout.abort(), CLIP_TIMEOUT_MS); // headers are in: the body gets the long window
    if (!response.ok) throw new Error(`tts ${response.status}`);
    const provider = response.headers.get("X-TTS-Provider");
    if (provider) onProvider?.(provider);
    return await response.blob();
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abortBoth);
  }
}

/** Clips fetched ahead of time (the acknowledgement phrases), keyed by their exact text. */
const warmClips = new Map<string, Blob>();

/** Fetch these texts now so playing them later is instant. A failure is ignored: playback fetches live instead. */
export async function warmClipCache(texts: readonly string[], fetchImpl: typeof fetch = fetch): Promise<void> {
  await Promise.all(
    texts
      .filter((text) => !warmClips.has(text))
      .map(async (text) => {
        try {
          warmClips.set(text, await fetchClipFromApi(text, new AbortController().signal, fetchImpl));
        } catch {
          // Not cached; the first use fetches it like any other clip.
        }
      }),
  );
}

/** For tests. */
export const clearWarmClips = (): void => warmClips.clear();

let sharedPlayer: SpeechPlayer | null = null;

/** The one player for the page, created on first use so nothing touches `Audio` during SSR. */
export function getSpeechPlayer(): SpeechPlayer {
  sharedPlayer ??= new SpeechPlayer({
    fetchClip: (text, signal, hints) => {
      const warm = warmClips.get(text);
      return warm
        ? Promise.resolve(warm)
        : fetchClipFromApi(
            text,
            signal,
            fetch,
            (provider) => sharedPlayer?.noteProvider(provider),
            hints?.first ? FIRST_CLIP_HEADER_TIMEOUT_MS : CLIP_TIMEOUT_MS,
          );
    },
    createAudio: () => new Audio(),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  });
  return sharedPlayer;
}
