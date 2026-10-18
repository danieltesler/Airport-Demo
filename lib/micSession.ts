/**
 * One microphone stream plus one audio context, opened once inside the user's tap and reused across
 * turns of a hands-free conversation.
 *
 * Why once, inside the tap: mobile browsers only let audio start and resume during a user gesture.
 * iOS Safari starts a context made later suspended, and a suspended level meter reads flat silence,
 * so auto-stop never fires. Chrome on Android is more forgiving but follows the same rule. If the
 * context will not run, `open()` says "suspended" and the caller asks for another tap rather than
 * listening to nothing.
 *
 * Browser access is injected so this is tested with fakes.
 */

import type { SessionResult } from "./conversation";

export interface MicDeps {
  getUserMedia: () => Promise<MediaStream>;
  /** Undefined where there is no Web Audio: hands-free needs the level meter, so that is "unsupported". */
  createAudioContext: (() => AudioContext) | null;
  wait: (ms: number) => Promise<void>;
}

const RESUME_WAIT_MS = 500;

const streamIsLive = (stream: MediaStream): boolean => stream.getAudioTracks().some((track) => track.readyState === "live");

export class MicSession {
  private current: { stream: MediaStream; audioCtx: AudioContext } | null = null;

  constructor(
    private readonly deps: MicDeps,
    /** The microphone stopped by itself (unplugged, taken by another app, permission revoked). */
    private readonly onEnded: () => void,
  ) {}

  get stream(): MediaStream | null {
    return this.current?.stream ?? null;
  }

  get audioCtx(): AudioContext | null {
    return this.current?.audioCtx ?? null;
  }

  /** Open (or reuse) the session. The first lines run synchronously, so call this inside the tap. */
  async open(): Promise<SessionResult> {
    if (!this.deps.createAudioContext) return "unsupported";

    const existing = this.current;
    if (existing && streamIsLive(existing.stream)) {
      this.setEnabled(true);
      void existing.audioCtx.resume().catch(() => undefined); // before any await: still inside the gesture
      return (await this.runningSoon(existing.audioCtx)) ? "ok" : "suspended";
    }
    this.close();

    const audioCtx = this.deps.createAudioContext();
    void audioCtx.resume().catch(() => undefined);

    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia();
    } catch {
      void audioCtx.close().catch(() => undefined);
      return "denied";
    }
    this.current = { stream, audioCtx };
    stream.getAudioTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (this.current?.stream !== stream) return;
        this.current = null;
        void audioCtx.close().catch(() => undefined);
        this.onEnded();
      }),
    );
    return (await this.runningSoon(audioCtx)) ? "ok" : "suspended";
  }

  /** Between turns, without a tap: still live and running (or resumable right now)? */
  async ready(): Promise<boolean> {
    const session = this.current;
    if (!session || !streamIsLive(session.stream)) return false;
    return this.runningSoon(session.audioCtx);
  }

  /** The microphone is only on while a turn is being recorded. */
  setEnabled(enabled: boolean): void {
    this.current?.stream.getAudioTracks().forEach((track) => (track.enabled = enabled));
  }

  close(): void {
    const session = this.current;
    this.current = null;
    if (!session) return;
    void session.audioCtx.close().catch(() => undefined);
    session.stream.getTracks().forEach((track) => track.stop());
  }

  private async runningSoon(audioCtx: AudioContext): Promise<boolean> {
    if (audioCtx.state === "running") return true;
    await Promise.race([audioCtx.resume().catch(() => undefined), this.deps.wait(RESUME_WAIT_MS)]);
    return (audioCtx.state as AudioContextState) === "running";
  }
}
