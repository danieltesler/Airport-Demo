/**
 * An opt-in, in-memory trace of what the voice did, for debugging on a phone.
 *
 * Off unless the page URL has ?debug=voice; when off, recording costs one boolean check and keeps
 * nothing. It holds the last 30 events: an event name, a short detail and the time since the current
 * turn started. Only event names and timings go in: never what the user said, never the answer text.
 */

export interface VoiceTraceEvent {
  /** Milliseconds since the turn started (or since the page, before the first turn). */
  at: number;
  event: string;
  detail?: string;
}

export const MAX_TRACE_EVENTS = 30;

export interface VoiceTrace {
  readonly enabled: boolean;
  record(event: string, detail?: string): void;
  /** A new question was sent: restart the clock. */
  startTurn(): void;
  events(): readonly VoiceTraceEvent[];
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export function createVoiceTrace(options: { enabled: boolean; now?: () => number }): VoiceTrace {
  const now = options.now ?? (() => performance.now());
  let turnStart = now();
  let list: readonly VoiceTraceEvent[] = [];
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());

  return {
    enabled: options.enabled,
    record(event, detail) {
      if (!options.enabled) return;
      const entry: VoiceTraceEvent = { at: Math.round(now() - turnStart), event, ...(detail ? { detail } : {}) };
      list = [...list, entry].slice(-MAX_TRACE_EVENTS);
      notify();
    },
    startTurn() {
      turnStart = now();
    },
    events: () => list,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear() {
      list = [];
      notify();
    },
  };
}

export const traceEnabledFromUrl = (search: string): boolean => new URLSearchParams(search).get("debug") === "voice";

let shared: VoiceTrace | null = null;

/** The page's trace. Created on first use, so the URL is read in the browser, never during server rendering. */
export function voiceTrace(): VoiceTrace {
  shared ??= createVoiceTrace({ enabled: typeof window !== "undefined" && traceEnabledFromUrl(window.location.search) });
  return shared;
}

/** Record one event on the page's trace (a no-op unless ?debug=voice). */
export const traceVoice = (event: string, detail?: string): void => voiceTrace().record(event, detail);

export type BargeInTraceKind = "armed" | "trigger" | "accepted" | "rejected as false" | "auto-off";

/** Round a number to three significant figures so the panel stays readable. */
const short = (value: number): string => String(Number(value.toPrecision(3)));

/**
 * One barge-in event for the debug panel: numbers only (levels, thresholds, ratios, counts) and short
 * fixed reasons. `ratio` is how many times above the echo floor the user's voice was: the figure to look
 * at when tuning (a real interrupt should show well over 2.5; a false one that slipped through, barely).
 */
export function traceBargeIn(kind: BargeInTraceKind, info: Record<string, number | string> = {}): void {
  traceVoice(`barge-in ${kind}`, formatBargeInDetail(info) || undefined);
}

/** "level=0.31 threshold=0.195 ratio=3.9": numbers to three figures, strings as given. */
export function formatBargeInDetail(info: Record<string, number | string>): string {
  return Object.entries(info)
    .map(([key, value]) => `${key}=${typeof value === "number" ? short(value) : value}`)
    .join(" ");
}
