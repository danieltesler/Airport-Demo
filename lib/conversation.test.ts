import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationController, PAUSE_MESSAGE, type PauseReason, type SessionResult } from "./conversation";

function setup(options: { session?: SessionResult; ready?: boolean } = {}) {
  const calls: string[] = [];
  const log = (name: string) => () => void calls.push(name);
  const ports = {
    openSession: vi.fn(async (): Promise<SessionResult> => {
      calls.push("openSession");
      return options.session ?? "ok";
    }),
    closeSession: vi.fn(log("closeSession")),
    audioReady: vi.fn(async () => options.ready ?? true),
    listen: vi.fn(log("listen")),
    stopListening: vi.fn(log("stopListening")),
    finishListening: vi.fn(log("finishListening")),
    send: vi.fn((text: string) => void calls.push(`send:${text}`)),
    cancelSpeech: vi.fn(log("cancelSpeech")),
    wakeLock: { acquire: vi.fn(async () => true), release: vi.fn(async () => undefined) },
  };
  const controller = new ConversationController(ports);
  const snapshots: string[] = [];
  controller.subscribe(() => snapshots.push(controller.getSnapshot().phase));
  const phase = () => controller.getSnapshot().phase;
  const reason = () => controller.getSnapshot().pauseReason;
  return { controller, ports, calls, snapshots, phase, reason };
}

/** Run one whole question: speak, get a transcript, the chat runs, an answer is spoken. */
async function askAndGetAnswerSpoken(c: ReturnType<typeof setup>, text = "top airports in LA") {
  c.controller.outcome({ kind: "transcript", text });
  c.controller.chatRunning(true);
  c.controller.playbackChanged("loading");
  c.controller.chatRunning(false);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("starting", () => {
  it("opens audio inside the tap (before any await), takes the wake lock and starts listening", async () => {
    const c = setup();
    const started = c.controller.start();
    // Synchronously, before the microphone promise resolved: this is what keeps it inside the user gesture.
    expect(c.ports.openSession).toHaveBeenCalledTimes(1);
    expect(c.ports.wakeLock.acquire).toHaveBeenCalledTimes(1);
    expect(c.phase()).toBe("starting");
    expect(c.ports.listen).not.toHaveBeenCalled();

    await started;
    expect(c.phase()).toBe("listening");
    expect(c.ports.listen).toHaveBeenCalledTimes(1);
  });

  it("a blocked microphone leaves it off with the reason, and releases the wake lock", async () => {
    const c = setup({ session: "denied" });
    await c.controller.start();
    expect(c.phase()).toBe("off");
    expect(c.controller.getSnapshot().startFailure).toBe("denied");
    expect(c.ports.listen).not.toHaveBeenCalled();
    expect(c.ports.wakeLock.release).toHaveBeenCalled();
  });

  it("an unsupported browser leaves it off with the reason", async () => {
    const c = setup({ session: "unsupported" });
    await c.controller.start();
    expect(c.controller.getSnapshot()).toMatchObject({ phase: "off", startFailure: "unsupported" });
  });

  it("iOS: audio that will not resume pauses with 'Tap the mic to keep talking', never a silent dead state", async () => {
    const c = setup({ session: "suspended" });
    await c.controller.start();
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("audio-suspended");
    expect(PAUSE_MESSAGE["audio-suspended"]).toMatch(/Tap the mic to keep talking/);
    expect(c.ports.listen).not.toHaveBeenCalled();
  });

  it("iOS: a second tap retries inside the new gesture and recovers", async () => {
    const c = setup({ session: "suspended" });
    await c.controller.start();
    c.ports.openSession.mockResolvedValueOnce("ok");
    const tapped = c.controller.tap();
    expect(c.ports.openSession).toHaveBeenCalledTimes(2); // synchronously inside the tap
    await tapped;
    expect(c.phase()).toBe("listening");
  });

  it("ignores a second start while running", async () => {
    const c = setup();
    await c.controller.start();
    await c.controller.start();
    expect(c.ports.openSession).toHaveBeenCalledTimes(1);
  });
});

describe("the turn loop", () => {
  it("listen -> thinking -> speaking -> a 400 ms gap -> listening again", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "transcript", text: "top airports in LA" });
    expect(c.phase()).toBe("thinking");
    expect(c.ports.send).toHaveBeenCalledWith("top airports in LA");

    c.controller.chatRunning(true);
    c.controller.playbackChanged("loading");
    c.controller.chatRunning(false);
    expect(c.phase()).toBe("speaking");

    c.controller.playbackChanged("speaking");
    c.controller.playbackChanged("idle"); // the answer finished
    expect(c.ports.listen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(399);
    expect(c.ports.listen).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(c.ports.listen).toHaveBeenCalledTimes(2);
    expect(c.phase()).toBe("listening");
  });

  it("the 'one moment' acknowledgement during thinking does not count as the answer", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "transcript", text: "q" });
    c.controller.chatRunning(true);
    c.controller.playbackChanged("loading"); // the acknowledgement
    c.controller.playbackChanged("speaking");
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.phase()).toBe("thinking");
    expect(c.ports.listen).toHaveBeenCalledTimes(1);
  });

  it("a blocked autoplay keeps waiting in 'speaking' for the user's tap on Play", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "transcript", text: "q" });
    c.controller.chatRunning(true);
    c.controller.playbackChanged("blocked");
    c.controller.chatRunning(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.phase()).toBe("speaking");
    c.controller.playbackChanged("speaking");
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("listening");
    expect(c.ports.listen).toHaveBeenCalledTimes(2);
  });

  it("an answer with nothing to say (an error reply) pauses with the answer on screen", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "transcript", text: "q" });
    c.controller.chatRunning(true);
    c.controller.chatRunning(false); // playback stayed idle: nothing was spoken
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("no-answer");
    expect(c.ports.wakeLock.release).toHaveBeenCalled();
  });

  it("a text-to-speech failure pauses with a clear reason", async () => {
    const c = setup();
    await c.controller.start();
    await askAndGetAnswerSpoken(c);
    c.controller.playbackChanged("error");
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("voice-failed");
  });

  it("a question that is never answered pauses after the watchdog, instead of waiting forever", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "transcript", text: "q" });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(c.phase()).toBe("thinking");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("no-answer");
  });

  it("the watchdog is cancelled by a real answer", async () => {
    const c = setup();
    await c.controller.start();
    await askAndGetAnswerSpoken(c);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.phase()).toBe("speaking");
  });

  it("if audio cannot be resumed between turns, it pauses instead of listening to nothing", async () => {
    const c = setup({ ready: false });
    await c.controller.start();
    await askAndGetAnswerSpoken(c);
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("audio-suspended");
    expect(c.ports.listen).toHaveBeenCalledTimes(1);
  });
});

describe("safety pauses", () => {
  it("8 seconds of silence pauses (the recorder reports no-speech)", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "no-speech" });
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("silence");
    expect(c.ports.stopListening).toHaveBeenCalled();
    expect(c.ports.wakeLock.release).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.ports.listen).toHaveBeenCalledTimes(1); // it does not quietly start again
  });

  it("3 empty or ghost transcripts in a row pause; two do not", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "empty" });
    await vi.advanceTimersByTimeAsync(401);
    c.controller.outcome({ kind: "empty" });
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("listening");
    expect(c.ports.listen).toHaveBeenCalledTimes(3);

    c.controller.outcome({ kind: "empty" });
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("empty-turns");
  });

  it("a good transcript resets the empty count", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.outcome({ kind: "empty" });
    await vi.advanceTimersByTimeAsync(401);
    c.controller.outcome({ kind: "empty" });
    await vi.advanceTimersByTimeAsync(401);
    await askAndGetAnswerSpoken(c);
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(401);
    c.controller.outcome({ kind: "empty" });
    await vi.advanceTimersByTimeAsync(401);
    c.controller.outcome({ kind: "empty" });
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("listening");
  });

  it("10 turns without a tap pause before the 11th, and a tap starts the count again", async () => {
    const c = setup();
    await c.controller.start();
    for (let turn = 1; turn <= 9; turn++) {
      await askAndGetAnswerSpoken(c, `question ${turn}`);
      c.controller.playbackChanged("idle");
      await vi.advanceTimersByTimeAsync(401);
      expect(c.phase()).toBe("listening");
    }
    await askAndGetAnswerSpoken(c, "question 10");
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("turn-limit");
    expect(PAUSE_MESSAGE["turn-limit"]).toMatch(/Tap the mic/);

    await c.controller.tap();
    expect(c.phase()).toBe("listening");
    await askAndGetAnswerSpoken(c, "question 11");
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("listening");
  });

  it("a stopped microphone pauses and releases the session; a transcription failure pauses with its own reason", async () => {
    const lost = setup();
    await lost.controller.start();
    lost.controller.outcome({ kind: "mic-lost" });
    expect(lost.reason()).toBe("mic-lost");
    expect(lost.ports.closeSession).toHaveBeenCalled();

    const failed = setup();
    await failed.controller.start();
    failed.controller.outcome({ kind: "failed" });
    expect(failed.reason()).toBe("stt-failed");
    expect(failed.ports.closeSession).not.toHaveBeenCalled(); // the session is still good: a tap retries
  });

  it("every pause reason has a message that says what to do", () => {
    const reasons: PauseReason[] = ["silence", "empty-turns", "turn-limit", "hidden", "audio-suspended", "mic-lost", "stt-failed", "no-answer", "voice-failed"];
    for (const reason of reasons) expect(PAUSE_MESSAGE[reason]).toMatch(/Tap the mic|answer is on screen/);
  });
});

describe("interrupt (tap, not voice)", () => {
  it("tapping while it speaks cuts the voice and listens straight away", async () => {
    const c = setup();
    await c.controller.start();
    await askAndGetAnswerSpoken(c);
    c.controller.playbackChanged("speaking");
    expect(c.phase()).toBe("speaking");

    const tapped = c.controller.tap();
    expect(c.ports.cancelSpeech).toHaveBeenCalled();
    expect(c.ports.openSession).toHaveBeenCalledTimes(2); // re-opened inside the tap, so iOS keeps audio alive
    await tapped;
    expect(c.phase()).toBe("listening");
    expect(c.ports.listen).toHaveBeenCalledTimes(2);

    c.controller.playbackChanged("idle"); // the cancelled clip reports idle late: ignored
    await vi.advanceTimersByTimeAsync(2000);
    expect(c.ports.listen).toHaveBeenCalledTimes(2);
  });

  it("an interrupt resets the turn counters", async () => {
    const c = setup();
    await c.controller.start();
    for (let turn = 1; turn <= 9; turn++) {
      await askAndGetAnswerSpoken(c);
      c.controller.playbackChanged("idle");
      await vi.advanceTimersByTimeAsync(401);
    }
    await askAndGetAnswerSpoken(c);
    c.controller.playbackChanged("speaking");
    await c.controller.tap(); // interrupt the tenth answer
    expect(c.phase()).toBe("listening");
    await askAndGetAnswerSpoken(c);
    c.controller.playbackChanged("idle");
    await vi.advanceTimersByTimeAsync(401);
    expect(c.phase()).toBe("listening");
  });

  it("tapping while listening finishes the turn now; tapping while thinking does nothing", async () => {
    const c = setup();
    await c.controller.start();
    await c.controller.tap();
    expect(c.ports.finishListening).toHaveBeenCalledTimes(1);
    c.controller.outcome({ kind: "transcript", text: "q" });
    await c.controller.tap();
    expect(c.phase()).toBe("thinking");
    expect(c.ports.cancelSpeech).not.toHaveBeenCalled();
  });
});

describe("End", () => {
  it.each(["starting", "listening", "thinking", "speaking", "paused"] as const)("always works from %s", async (from) => {
    const c = setup();
    if (from === "starting") {
      void c.controller.start();
    } else {
      await c.controller.start();
      if (from === "thinking" || from === "speaking") c.controller.outcome({ kind: "transcript", text: "q" });
      if (from === "speaking") {
        c.controller.chatRunning(true);
        c.controller.playbackChanged("loading");
        c.controller.chatRunning(false);
      }
      if (from === "paused") c.controller.outcome({ kind: "no-speech" });
    }
    expect(c.phase()).toBe(from);

    c.controller.end();
    expect(c.phase()).toBe("off");
    expect(c.ports.cancelSpeech).toHaveBeenCalled();
    expect(c.ports.stopListening).toHaveBeenCalled();
    expect(c.ports.closeSession).toHaveBeenCalled();
    expect(c.ports.wakeLock.release).toHaveBeenCalled();

    // Nothing the earlier session had scheduled may fire afterwards.
    const listenCalls = c.ports.listen.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.ports.listen.mock.calls.length).toBe(listenCalls);
    expect(c.phase()).toBe("off");
  });

  it("an End pressed while the microphone is still opening leaves nothing open", async () => {
    const c = setup();
    const started = c.controller.start();
    c.controller.end();
    await started;
    expect(c.phase()).toBe("off");
    expect(c.ports.listen).not.toHaveBeenCalled();
    expect(c.ports.closeSession.mock.calls.length).toBeGreaterThanOrEqual(2); // once by End, once for the late result
  });

  it("can start again after End", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.end();
    await c.controller.start();
    expect(c.phase()).toBe("listening");
  });
});

describe("page hidden (backgrounded, screen locked)", () => {
  it.each(["listening", "thinking", "speaking"] as const)("pauses cleanly from %s and lets go of the microphone", async (from) => {
    const c = setup();
    await c.controller.start();
    if (from !== "listening") c.controller.outcome({ kind: "transcript", text: "q" });
    if (from === "speaking") {
      c.controller.chatRunning(true);
      c.controller.playbackChanged("loading");
      c.controller.chatRunning(false);
    }
    c.controller.hidden();
    expect(c.phase()).toBe("paused");
    expect(c.reason()).toBe("hidden");
    expect(c.ports.cancelSpeech).toHaveBeenCalled();
    expect(c.ports.stopListening).toHaveBeenCalled();
    expect(c.ports.closeSession).toHaveBeenCalled();
    expect(c.ports.wakeLock.release).toHaveBeenCalled();
  });

  it("does not start by itself when the page comes back: it waits for a tap, which reopens the microphone", async () => {
    const c = setup();
    await c.controller.start();
    c.controller.hidden();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(c.phase()).toBe("paused");

    await c.controller.tap();
    expect(c.ports.openSession).toHaveBeenCalledTimes(2);
    expect(c.ports.wakeLock.acquire).toHaveBeenCalledTimes(2);
    expect(c.phase()).toBe("listening");
  });

  it("does nothing when it was never running", () => {
    const c = setup();
    c.controller.hidden();
    expect(c.phase()).toBe("off");
    expect(c.ports.closeSession).not.toHaveBeenCalled();
  });

  it("closes a microphone that finished opening after the page was hidden", async () => {
    const c = setup();
    const started = c.controller.start();
    c.controller.hidden();
    await started;
    expect(c.phase()).toBe("paused");
    expect(c.ports.closeSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(c.ports.listen).not.toHaveBeenCalled();
  });
});

describe("wake lock lifecycle", () => {
  it("is taken on start, dropped on every pause and End, and taken again on resume", async () => {
    const c = setup();
    await c.controller.start();
    expect(c.ports.wakeLock.acquire).toHaveBeenCalledTimes(1);

    c.controller.outcome({ kind: "no-speech" });
    expect(c.ports.wakeLock.release).toHaveBeenCalledTimes(1);

    await c.controller.tap();
    expect(c.ports.wakeLock.acquire).toHaveBeenCalledTimes(2);

    c.controller.end();
    expect(c.ports.wakeLock.release).toHaveBeenCalledTimes(2);
  });

  it("is not retaken for an interrupt, which never let go of it", async () => {
    const c = setup();
    await c.controller.start();
    await askAndGetAnswerSpoken(c);
    await c.controller.tap();
    expect(c.ports.wakeLock.acquire).toHaveBeenCalledTimes(1);
  });
});

describe("snapshot", () => {
  it("notifies subscribers only on a real change and keeps the same object otherwise", async () => {
    const c = setup();
    const before = c.controller.getSnapshot();
    await c.controller.start();
    expect(c.snapshots).toEqual(["starting", "listening"]);
    const during = c.controller.getSnapshot();
    c.controller.playbackChanged("idle"); // no effect while listening
    expect(c.controller.getSnapshot()).toBe(during);
    expect(before.phase).toBe("off");
  });
});
