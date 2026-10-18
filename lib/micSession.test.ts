import { describe, expect, it, vi } from "vitest";
import { MicSession, type MicDeps } from "./micSession";

class FakeTrack {
  readyState: "live" | "ended" = "live";
  enabled = true;
  stopped = 0;
  private endedListener: (() => void) | null = null;
  addEventListener(_type: string, listener: () => void) {
    this.endedListener = listener;
  }
  stop() {
    this.stopped += 1;
    this.readyState = "ended";
  }
  /** The browser or OS took the microphone away. */
  hardwareEnded() {
    this.readyState = "ended";
    this.endedListener?.();
  }
}

class FakeStream {
  track = new FakeTrack();
  getAudioTracks = () => [this.track];
  getTracks = () => [this.track];
}

/** `resumable: false` models iOS refusing to resume a context without a gesture. */
class FakeAudioContext {
  state: "running" | "suspended" | "closed" = "suspended";
  resumeCalls = 0;
  closed = false;
  constructor(private readonly behaviour: { startsRunning: boolean; resumable: boolean }) {
    this.state = behaviour.startsRunning ? "running" : "suspended";
  }
  resume = vi.fn(async () => {
    this.resumeCalls += 1;
    if (this.behaviour.resumable) this.state = "running";
    else await new Promise<void>(() => undefined); // like iOS: the promise just never settles without a gesture
  });
  close = vi.fn(async () => {
    this.closed = true;
    this.state = "closed";
  });
}

function setup(behaviour = { startsRunning: false, resumable: true }, options: { deny?: boolean; noWebAudio?: boolean } = {}) {
  const streams: FakeStream[] = [];
  const contexts: FakeAudioContext[] = [];
  const deps: MicDeps = {
    getUserMedia: vi.fn(async () => {
      if (options.deny) throw new DOMException("denied", "NotAllowedError");
      const stream = new FakeStream();
      streams.push(stream);
      return stream as unknown as MediaStream;
    }),
    createAudioContext: options.noWebAudio
      ? null
      : () => {
          const ctx = new FakeAudioContext(behaviour);
          contexts.push(ctx);
          return ctx as unknown as AudioContext;
        },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const onEnded = vi.fn();
  return { session: new MicSession(deps, onEnded), deps, streams, contexts, onEnded };
}

describe("MicSession.open", () => {
  it("creates and resumes the audio context before it asks for the microphone (inside the tap)", async () => {
    const { session, contexts, deps } = setup();
    const opening = session.open();
    // Synchronous part: the context exists and resume() was already called, before getUserMedia resolved.
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resumeCalls).toBe(1);
    expect(deps.getUserMedia).toHaveBeenCalledTimes(1);
    expect(await opening).toBe("ok");
  });

  it("is 'denied' when the microphone is blocked, and closes the context it made", async () => {
    const { session, contexts } = setup(undefined, { deny: true });
    expect(await session.open()).toBe("denied");
    expect(contexts[0].closed).toBe(true);
    expect(session.stream).toBeNull();
  });

  it("is 'unsupported' where there is no Web Audio (no level meter, so no hands-free)", async () => {
    const { session, deps } = setup(undefined, { noWebAudio: true });
    expect(await session.open()).toBe("unsupported");
    expect(deps.getUserMedia).not.toHaveBeenCalled();
  });

  it("iOS: a context that will not resume is 'suspended', never a silent dead state", async () => {
    vi.useFakeTimers();
    try {
      const { session } = setup({ startsRunning: false, resumable: false });
      const opening = session.open();
      await vi.advanceTimersByTimeAsync(600);
      expect(await opening).toBe("suspended");
      // The stream is still held, so a later tap can resume the same context.
      expect(session.stream).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second open reuses the stream and context, and resumes it synchronously inside the new tap", async () => {
    const { session, streams, contexts, deps } = setup();
    await session.open();
    const reopening = session.open();
    expect(contexts[0].resumeCalls).toBeGreaterThanOrEqual(2);
    expect(await reopening).toBe("ok");
    expect(streams).toHaveLength(1);
    expect(contexts).toHaveLength(1);
    expect(deps.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("iOS: a suspended session recovers on the next tap when the browser allows the resume", async () => {
    vi.useFakeTimers();
    try {
      const behaviour = { startsRunning: false, resumable: false };
      const { session, contexts } = setup(behaviour);
      const first = session.open();
      await vi.advanceTimersByTimeAsync(600);
      expect(await first).toBe("suspended");

      behaviour.resumable = true; // this time the call is inside a real gesture
      contexts[0].resume.mockImplementation(async () => {
        contexts[0].state = "running";
      });
      expect(await session.open()).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a fresh session when the earlier microphone has ended", async () => {
    const { session, streams } = setup();
    await session.open();
    streams[0].track.readyState = "ended";
    await session.open();
    expect(streams).toHaveLength(2);
  });
});

describe("MicSession between turns", () => {
  it("is ready while live and running, and not once the microphone ended or it was closed", async () => {
    const { session, streams } = setup({ startsRunning: true, resumable: true });
    expect(await session.ready()).toBe(false); // nothing open yet
    await session.open();
    expect(await session.ready()).toBe(true);
    streams[0].track.readyState = "ended";
    expect(await session.ready()).toBe(false);
  });

  it("is not ready when the context cannot be resumed without a tap", async () => {
    vi.useFakeTimers();
    try {
      const { session, contexts } = setup({ startsRunning: true, resumable: false });
      await session.open();
      contexts[0].state = "suspended"; // the OS suspended it between turns
      const check = session.ready();
      await vi.advanceTimersByTimeAsync(600);
      expect(await check).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the microphone ending by itself, once, and forgets the session", async () => {
    const { session, streams, onEnded, contexts } = setup();
    await session.open();
    streams[0].track.hardwareEnded();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(session.stream).toBeNull();
    expect(contexts[0].closed).toBe(true);
  });

  it("does not report an end it caused itself by closing", async () => {
    const { session, streams, onEnded } = setup();
    await session.open();
    session.close();
    streams[0].track.hardwareEnded();
    expect(onEnded).not.toHaveBeenCalled();
  });

  it("switches the microphone off between turns and on for the next", async () => {
    const { session, streams } = setup();
    await session.open();
    session.setEnabled(false);
    expect(streams[0].track.enabled).toBe(false);
    await session.open();
    expect(streams[0].track.enabled).toBe(true);
  });

  it("close() stops every track and the context", async () => {
    const { session, streams, contexts } = setup();
    await session.open();
    session.close();
    expect(streams[0].track.stopped).toBe(1);
    expect(contexts[0].closed).toBe(true);
    session.close(); // closing twice is harmless
  });
});
