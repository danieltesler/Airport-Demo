/**
 * Hands-free Conversation mode: a small state machine that turns the tap-to-talk pieces into a
 * loop (listen, send, think, speak, listen again) and stops itself before it can run away.
 *
 *   off -> listening -> thinking -> speaking -> (400 ms gap) -> listening ...
 *                  any phase -> paused (needs a tap)      any phase -> off (End)
 *
 * Half-duplex by design: it only listens while the assistant is silent, so it never hears itself
 * on laptop speakers. Interrupting is a tap, not a voice. Every failure lands in `paused` with a
 * reason the chip can say, and the answer is always on screen, so there is no silent dead state.
 *
 * The controller is framework-free: the browser pieces (microphone, audio context, wake lock,
 * playback) are injected as ports, which is also what lets the safety pauses be tested with fake
 * timers and no browser.
 */

export type ConversationPhase = "off" | "starting" | "listening" | "thinking" | "speaking" | "paused";

export type PauseReason =
  | "silence" //         nobody spoke for 8 s
  | "empty-turns" //     3 empty or ghost transcripts in a row
  | "turn-limit" //      10 turns without a tap
  | "hidden" //          the page was backgrounded or the screen locked
  | "audio-suspended" // the browser would not resume audio without a tap
  | "mic-lost" //        the microphone stopped (unplugged, taken by another app, revoked)
  | "stt-failed" //      speech recognition failed
  | "no-answer" //       the turn produced nothing to say (an error is on screen)
  | "voice-failed"; //   text-to-speech failed

export type SessionResult = "ok" | "denied" | "unsupported" | "suspended";
export type PlaybackFact = "idle" | "loading" | "speaking" | "blocked" | "error";

export type ListenOutcome =
  | { kind: "transcript"; text: string }
  | { kind: "empty" }
  | { kind: "no-speech" }
  | { kind: "failed" }
  | { kind: "mic-lost" };

export interface ConversationSnapshot {
  phase: ConversationPhase;
  pauseReason: PauseReason | null;
  /** Why starting failed, when it did ("denied": microphone blocked). Cleared on the next start. */
  startFailure: Exclude<SessionResult, "ok" | "suspended"> | null;
}

export interface ConversationPorts {
  /**
   * Open (or reuse) the microphone and audio context. Called synchronously inside the user's tap:
   * on mobile browsers that is the only place audio is allowed to start and resume.
   */
  openSession(): Promise<SessionResult>;
  closeSession(): void;
  /** Between turns, with no tap available: is the audio context running and the microphone live? */
  audioReady(): Promise<boolean>;
  /** Record one turn; the result arrives through `outcome()`. */
  listen(): void;
  /** Stop recording and throw the clip away. */
  stopListening(): void;
  /** The user tapped while listening: stop now and transcribe what was said. */
  finishListening(): void;
  /** Send the transcript as a spoken question. */
  send(text: string): void;
  cancelSpeech(): void;
  /** End only: stop the chat request that is still waiting for an answer. */
  cancelChat?(): void;
  wakeLock: { acquire(): Promise<boolean> | boolean; release(): Promise<void> | void };
}

export interface ConversationOptions {
  /** Quiet gap after the assistant finishes before listening resumes. */
  gapMs?: number;
  maxEmptyTurns?: number;
  maxTurnsWithoutTap?: number;
  /** If a sent question is never answered (nothing to say, nothing running), pause after this long. */
  answerTimeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const DEFAULTS = { gapMs: 400, maxEmptyTurns: 3, maxTurnsWithoutTap: 10, answerTimeoutMs: 45_000 };

/** What the chip says while paused (and while a start failed). */
export const PAUSE_MESSAGE: Record<PauseReason, string> = {
  silence: "Paused, I didn't hear anything. Tap the mic to keep talking",
  "empty-turns": "Paused, I'm not catching that. Tap the mic to try again, or type",
  "turn-limit": "Still there? Tap the mic to keep talking",
  hidden: "Paused. Tap the mic to keep talking",
  "audio-suspended": "Paused. Tap the mic to keep talking",
  "mic-lost": "Paused, the microphone stopped. Tap the mic to reconnect",
  "stt-failed": "Paused, couldn't transcribe that. Tap the mic to try again, or type",
  "no-answer": "Paused, the answer is on screen. Tap the mic to keep talking",
  "voice-failed": "Paused, voice is off for now. The answer is on screen",
};

/** Conversation mode is on unless the build sets NEXT_PUBLIC_CONVERSATION_MODE=off. */
export const isConversationModeEnabled = (flag: string | undefined): boolean => flag?.trim().toLowerCase() !== "off";

const OFF: ConversationSnapshot = { phase: "off", pauseReason: null, startFailure: null };

export class ConversationController {
  private snapshot: ConversationSnapshot = OFF;
  private listeners = new Set<() => void>();
  private emptyTurns = 0;
  private turnsSinceTap = 0;
  private gapTimer: unknown = null;
  private answerTimer: unknown = null;
  private chatSeenRunning = false;
  private playback: PlaybackFact = "idle";
  private readonly options: Required<Omit<ConversationOptions, "setTimer" | "clearTimer">>;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  /** Bumped on every end/pause so a slow async step from an earlier session can't act later. */
  private epoch = 0;

  constructor(
    private readonly ports: ConversationPorts,
    options: ConversationOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ConversationSnapshot => this.snapshot;

  get active(): boolean {
    return this.snapshot.phase !== "off";
  }

  /** Turn Conversation on. Call inside the user's tap. */
  start(): Promise<void> {
    if (this.snapshot.phase !== "off") return Promise.resolve();
    this.setSnapshot({ phase: "starting", pauseReason: null, startFailure: null });
    return this.openAndListen(true);
  }

  /** The mic button, whatever the phase: start, finish talking, interrupt, or continue. Call inside the tap. */
  tap(): Promise<void> {
    switch (this.snapshot.phase) {
      case "off":
        return this.start();
      case "listening":
        this.turnsSinceTap = 0;
        this.ports.finishListening();
        return Promise.resolve();
      case "speaking": {
        // Tap to interrupt: stop the voice at once and listen again.
        this.ports.cancelSpeech();
        this.turnsSinceTap = 0;
        this.emptyTurns = 0;
        return this.openAndListen(false);
      }
      case "paused":
        this.turnsSinceTap = 0;
        this.emptyTurns = 0;
        return this.openAndListen(true);
      default:
        return Promise.resolve(); // starting, thinking: nothing to interrupt yet
    }
  }

  /** End: the user pressed End, or left the mode. Always works, from any phase. */
  end(): void {
    // Idempotent: React's development remount (mount, unmount, mount) and a second End both land here
    // with nothing running, and must not touch the ports again.
    if (this.snapshot.phase === "off") return;
    this.epoch += 1;
    this.clearTimers();
    this.ports.cancelSpeech();
    this.cancelChatSafely();
    this.ports.stopListening();
    this.ports.closeSession();
    void this.ports.wakeLock.release();
    this.emptyTurns = 0;
    this.turnsSinceTap = 0;
    this.chatSeenRunning = false;
    this.setSnapshot(OFF);
  }

  /** The page was hidden (tab switched, screen locked): pause cleanly and let go of the microphone. */
  hidden(): void {
    if (!this.running()) return;
    this.pause("hidden", { closeSession: true });
  }

  /** The thread started or stopped running a chat turn. */
  chatRunning(running: boolean): void {
    if (this.snapshot.phase !== "thinking") return;
    if (running) {
      this.chatSeenRunning = true;
      return;
    }
    if (!this.chatSeenRunning) return;
    this.chatSeenRunning = false;
    this.clearAnswerTimer();
    this.afterAnswer();
  }

  /** The playback state changed. */
  playbackChanged(status: PlaybackFact): void {
    this.playback = status;
    if (this.snapshot.phase !== "speaking") return;
    if (status === "idle") this.scheduleNextTurn();
    else if (status === "error") this.pause("voice-failed");
    // loading, speaking and blocked: keep waiting (blocked shows "tap to hear" in the chip)
  }

  /** The result of the turn that `listen()` started. */
  outcome(result: ListenOutcome): void {
    if (this.snapshot.phase !== "listening") return;
    switch (result.kind) {
      case "transcript":
        this.emptyTurns = 0;
        this.turnsSinceTap += 1;
        this.chatSeenRunning = false;
        this.setSnapshot({ ...this.snapshot, phase: "thinking" });
        this.answerTimer = this.setTimer(() => this.pause("no-answer"), this.options.answerTimeoutMs);
        this.ports.send(result.text);
        return;
      case "empty":
        this.emptyTurns += 1;
        if (this.emptyTurns >= this.options.maxEmptyTurns) this.pause("empty-turns");
        else this.scheduleNextTurn();
        return;
      case "no-speech":
        this.pause("silence");
        return;
      case "failed":
        this.pause("stt-failed");
        return;
      case "mic-lost":
        this.pause("mic-lost", { closeSession: true });
        return;
    }
  }

  // ------------------------------------------------------------------------- //

  /** Cleanup must never throw: a failed cancel is logged by name only and End carries on. */
  private cancelChatSafely(): void {
    try {
      this.ports.cancelChat?.();
    } catch (error) {
      console.warn(`Conversation: cancelling the chat request failed (${error instanceof Error ? error.name : "unknown error"})`);
    }
  }

  private running(): boolean {
    return ["starting", "listening", "thinking", "speaking"].includes(this.snapshot.phase);
  }

  /** Open audio inside the tap, then record a turn. `fresh` also takes the screen wake lock. */
  private async openAndListen(fresh: boolean): Promise<void> {
    const epoch = ++this.epoch;
    if (this.snapshot.phase !== "starting") this.setSnapshot({ phase: "starting", pauseReason: null, startFailure: null });
    // Both calls are made before any await: they must run inside the user's tap.
    const opened = this.ports.openSession();
    if (fresh) void this.ports.wakeLock.acquire();

    const result = await opened;
    if (epoch !== this.epoch) {
      // End or a pause happened while the microphone was opening: don't leave it open behind that.
      const phase = this.snapshot.phase;
      if (result === "ok" && (phase === "off" || this.snapshot.pauseReason === "hidden")) this.ports.closeSession();
      return;
    }

    if (result === "denied" || result === "unsupported") {
      void this.ports.wakeLock.release();
      this.setSnapshot({ phase: "off", pauseReason: null, startFailure: result });
      return;
    }
    if (result === "suspended") {
      this.pause("audio-suspended");
      return;
    }
    this.startTurn();
  }

  private startTurn(): void {
    this.clearTimers();
    this.setSnapshot({ phase: "listening", pauseReason: null, startFailure: null });
    this.ports.listen();
  }

  private afterAnswer(): void {
    if (this.playback === "loading" || this.playback === "speaking" || this.playback === "blocked") {
      this.setSnapshot({ ...this.snapshot, phase: "speaking" });
    } else if (this.playback === "error") {
      this.pause("voice-failed");
    } else {
      this.pause("no-answer"); // nothing was said: an error reply or an empty one
    }
  }

  /** After a quiet gap, listen again, unless a safety limit says to stop and wait for a tap. */
  private scheduleNextTurn(): void {
    this.clearGapTimer();
    if (this.turnsSinceTap >= this.options.maxTurnsWithoutTap) {
      this.pause("turn-limit");
      return;
    }
    const epoch = this.epoch;
    this.gapTimer = this.setTimer(async () => {
      this.gapTimer = null;
      const ready = await this.ports.audioReady();
      if (epoch !== this.epoch || !this.running()) return;
      if (!ready) this.pause("audio-suspended");
      else this.startTurn();
    }, this.options.gapMs);
    if (this.snapshot.phase !== "listening") this.setSnapshot({ ...this.snapshot, phase: "listening" });
  }

  private pause(reason: PauseReason, options: { closeSession?: boolean } = {}): void {
    this.epoch += 1;
    this.clearTimers();
    this.ports.cancelSpeech();
    this.ports.stopListening();
    if (options.closeSession) this.ports.closeSession();
    void this.ports.wakeLock.release(); // a paused session must not keep the screen awake
    this.chatSeenRunning = false;
    this.setSnapshot({ phase: "paused", pauseReason: reason, startFailure: null });
  }

  private clearGapTimer(): void {
    if (this.gapTimer !== null) this.clearTimer(this.gapTimer);
    this.gapTimer = null;
  }

  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) this.clearTimer(this.answerTimer);
    this.answerTimer = null;
  }

  private clearTimers(): void {
    this.clearGapTimer();
    this.clearAnswerTimer();
  }

  private setSnapshot(next: ConversationSnapshot): void {
    const current = this.snapshot;
    if (next.phase === current.phase && next.pauseReason === current.pauseReason && next.startFailure === current.startFailure) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}
