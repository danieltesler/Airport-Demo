import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationUiState } from "../hooks/useConversation";
import { BARGE_IN, BargeInWatch, type Frame, type MeterLike, type WatchDeps } from "./bargeIn";
import { BARGE_IN_TIP, ConversationController, PAUSE_REASON_TEXT, STATUS_TEXT, type ConversationOptions } from "./conversation";
import type { PreRollCapture, RecorderLike } from "./preRoll";

/**
 * Voice barge-in end to end, with fake timers: the real controller, the real detector and pre-roll, a
 * scripted microphone, and a recording fake player. The harness wires them the way hooks/useConversation
 * does: the watch runs while the assistant is audible and the conversation is thinking or speaking.
 */

type Script = (t: number) => Frame;

const echo = (base: number): Script => (t) => ({ rms: base * (Math.floor(t / 100) % 2 === 0 ? 0.7 : 1.3), zcr: 0.08 });
const over = (under: Script, from: number, length: number, level: number, zcr = 0.1): Script => (t) => {
  const base = under(t);
  return t >= from && t < from + length ? { rms: Math.sqrt(base.rms ** 2 + level ** 2), zcr } : base;
};

class FakeRecorder implements RecorderLike {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  startedAt = 0;
  start() {
    this.state = "recording";
    this.startedAt = Date.now();
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

function makeWorld(options: ConversationOptions = {}) {
  /** What the microphone hears, as a function of time since the current clip began. */
  let script: Script = echo(0.03);
  let clipStart = 0;
  const recorders: FakeRecorder[] = [];
  const meters: { disposed: boolean }[] = [];
  const captures: Array<PreRollCapture | null> = [];
  const listenCalls: Array<{ bargedIn?: boolean } | undefined> = [];
  const player = { cancel: vi.fn(), speak: vi.fn() };
  let watch: BargeInWatch | null = null;
  let controllerRef!: ConversationController;

  const deps: WatchDeps = {
    createMeter: (): MeterLike => {
      const meter = { disposed: false };
      meters.push(meter);
      return { read: () => script(Date.now() - clipStart), dispose: () => void (meter.disposed = true) };
    },
    createRecorder: () => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder;
    },
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setPoll: (callback, ms) => setInterval(callback, ms),
    clearPoll: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  };

  const ports = {
    openSession: vi.fn(async () => "ok" as const),
    closeSession: vi.fn(() => {
      watch?.stop();
      watch = null;
    }),
    audioReady: vi.fn(async () => true),
    listen: vi.fn((o?: { bargedIn?: boolean }) => {
      listenCalls.push(o);
      if (o?.bargedIn) {
        captures.push(watch?.takePreRoll() ?? null); // adopted in the same breath, as the hook does
        watch?.stop();
        watch = null;
      }
    }),
    stopListening: vi.fn(),
    finishListening: vi.fn(),
    send: vi.fn(),
    cancelSpeech: vi.fn(() => player.cancel()),
    interrupted: vi.fn(),
    cancelChat: vi.fn(),
    wakeLock: { acquire: vi.fn(async () => true), release: vi.fn(async () => undefined) },
  };
  const controller = new ConversationController(ports, options);
  controllerRef = controller;

  let playback: "idle" | "loading" | "speaking" = "idle";
  /** The effect in useConversation: the watch runs only while the assistant is audible. */
  const syncWatch = () => {
    const snapshot = controller.getSnapshot();
    const wanted = snapshot.bargeInActive && (snapshot.phase === "speaking" || snapshot.phase === "thinking") && playback === "speaking";
    if (wanted && !watch) {
      watch = new BargeInWatch(deps, { onTrigger: (trigger) => controllerRef.bargeIn(trigger) });
      watch.start();
      watch.clipStarted();
    } else if (!wanted && watch) {
      watch.stop();
      watch = null;
    }
  };
  // React runs effects after the synchronous controller code has finished (so a barge-in adopts the
  // pre-roll before the effect stops the watch): a microtask models that.
  controller.subscribe(() => queueMicrotask(syncWatch));

  return {
    controller,
    ports,
    player,
    recorders,
    meters,
    captures,
    listenCalls,
    get watching() {
      return watch !== null;
    },
    /** Make the world sound like this from now on (time zero is the moment of this call). */
    hear(next: Script) {
      script = next;
      clipStart = Date.now();
    },
    setPlayback(next: "idle" | "loading" | "speaking") {
      playback = next;
      controller.playbackChanged(next);
      syncWatch();
    },
    /** A whole question: the user speaks, it is sent, and the assistant starts to speak. */
    async askAndStartSpeaking(under: Script = echo(0.03)) {
      controller.outcome({ kind: "transcript", text: "which airports are best" });
      controller.chatRunning(true);
      this.hear(under);
      this.setPlayback("speaking");
      controller.chatRunning(false);
      syncWatch();
    },
    /** The ack phase: still thinking while a phrase plays. */
    startAcknowledgement(under: Script = echo(0.03)) {
      controller.outcome({ kind: "transcript", text: "which airports are best" });
      controller.chatRunning(true);
      this.hear(under);
      this.setPlayback("speaking");
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("speaking over the assistant interrupts it with no tap", () => {
  it("stops the voice, listens, and the captured recording holds the first words", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    expect(world.controller.getSnapshot().phase).toBe("speaking");
    expect(world.watching).toBe(true);

    const onset = 2000; // the user starts talking 2 s into the answer
    world.hear(over(echo(0.03), onset, 6000, 0.3));
    const startOfClip = Date.now();
    await vi.advanceTimersByTimeAsync(onset + 700);

    // Playback stopped, once, and the conversation is listening for the new question.
    expect(world.player.cancel).toHaveBeenCalledTimes(1);
    expect(world.ports.interrupted).toHaveBeenCalledTimes(1);
    expect(world.controller.getSnapshot().phase).toBe("listening");
    expect(world.listenCalls.at(-1)).toEqual({ bargedIn: true });

    // It took no longer than the sustain time after the first word.
    const interruptedAfter = world.player.cancel.mock.invocationCallOrder.length; // called
    expect(interruptedAfter).toBe(1);

    // The recording that was adopted started before the user's first word, and is still recording.
    const capture = world.captures.at(-1)!;
    expect(capture).not.toBeNull();
    expect(capture.startedAt - startOfClip).toBeLessThanOrEqual(onset);
    expect(capture.recorder.state).toBe("recording");
    // Nothing else is left recording or reading levels.
    expect(world.recorders.filter((recorder) => recorder.state === "recording")).toEqual([capture.recorder]);
    expect(world.meters.every((meter) => meter.disposed)).toBe(true);
    expect(world.watching).toBe(false);
  });

  it("interrupts within a fraction of a second of the speech reaching the minimum duration", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    const onset = 1500;
    world.hear(over(echo(0.03), onset, 6000, 0.3));
    await vi.advanceTimersByTimeAsync(onset + BARGE_IN.sustainMs - 100);
    expect(world.player.cancel).not.toHaveBeenCalled(); // not before it is sure
    await vi.advanceTimersByTimeAsync(300 + 2 * BARGE_IN.pollMs);
    expect(world.player.cancel).toHaveBeenCalledTimes(1);
  });

  it("an answer still waiting is dropped: the interrupt tells the voice session (epoch) and nothing stays queued", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.hear(over(echo(0.03), 1500, 6000, 0.3));
    await vi.advanceTimersByTimeAsync(2600);
    expect(world.ports.interrupted).toHaveBeenCalled();
    // Once listening, the cancelled clip reporting idle changes nothing.
    world.setPlayback("idle");
    await vi.advanceTimersByTimeAsync(2000);
    expect(world.controller.getSnapshot().phase).toBe("listening");
    expect(world.listenCalls).toHaveLength(2); // the first turn, and the barged-in turn: no extra listen
  });

  it("barge-in during the 'one moment' acknowledgement interrupts it too, and cancels the pending chat request", async () => {
    const world = makeWorld();
    await world.controller.start();
    world.startAcknowledgement();
    expect(world.controller.getSnapshot().phase).toBe("thinking");
    expect(world.watching).toBe(true);

    world.hear(over(echo(0.03), 1200, 6000, 0.3));
    await vi.advanceTimersByTimeAsync(2200);
    expect(world.player.cancel).toHaveBeenCalledTimes(1);
    expect(world.ports.cancelChat).toHaveBeenCalledTimes(1); // the old question is superseded
    expect(world.controller.getSnapshot().phase).toBe("listening");
    expect(world.listenCalls.at(-1)).toEqual({ bargedIn: true });
  });
});

describe("what must not interrupt", () => {
  it.each([0.01, 0.03, 0.06])("the assistant's own echo at level %f, through a whole answer, never interrupts", async (level) => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking(echo(level));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(world.player.cancel).not.toHaveBeenCalled();
    expect(world.controller.getSnapshot().phase).toBe("speaking");
  });

  it("a cough does not interrupt", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.hear(over(echo(0.03), 2000, 250, 0.4));
    await vi.advanceTimersByTimeAsync(6000);
    expect(world.player.cancel).not.toHaveBeenCalled();
  });

  it("a click and a noise burst do not interrupt", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.hear((t) => (t >= 2000 && t < 2050 ? { rms: 0.8, zcr: 0.5 } : t >= 3000 && t < 3500 ? { rms: 0.4, zcr: 0.45 } : echo(0.03)(t)));
    await vi.advanceTimersByTimeAsync(7000);
    expect(world.player.cancel).not.toHaveBeenCalled();
  });

  it("nothing watches the microphone when the conversation is not running", async () => {
    const world = makeWorld();
    world.setPlayback("speaking"); // audio playing, but no conversation (tap-to-talk, or a Read-aloud)
    await vi.advanceTimersByTimeAsync(5000);
    expect(world.watching).toBe(false);
    expect(world.ports.openSession).not.toHaveBeenCalled();
    expect(world.recorders).toHaveLength(0);
    world.controller.bargeIn(); // and a stray call does nothing
    expect(world.player.cancel).not.toHaveBeenCalled();
  });

  it("barge-in is ignored in other phases", async () => {
    const world = makeWorld();
    await world.controller.start();
    world.controller.bargeIn(); // listening
    expect(world.listenCalls).toHaveLength(1);
    world.controller.outcome({ kind: "no-speech" }); // paused
    world.controller.bargeIn();
    expect(world.controller.getSnapshot().phase).toBe("paused");
    expect(world.player.cancel).toHaveBeenCalledTimes(1); // only the pause's own cancel
  });
});

describe("the safety net: barge-in switches itself off after false triggers", () => {
  it("two barged-in turns in a row that come back empty turn barge-in off, with one gentle tip", async () => {
    const world = makeWorld();
    await world.controller.start();

    for (let attempt = 1; attempt <= 2; attempt++) {
      await world.askAndStartSpeaking();
      world.hear(over(echo(0.03), 1500, 6000, 0.3));
      await vi.advanceTimersByTimeAsync(2600);
      expect(world.listenCalls.at(-1)).toEqual({ bargedIn: true });
      world.controller.outcome({ kind: "empty" });
      // The empty turn relistens after a gap; the next question is typed by the test harness as a transcript.
      await vi.advanceTimersByTimeAsync(500);
      if (attempt === 1) expect(world.controller.getSnapshot().bargeInActive).toBe(true);
    }
    const snapshot = world.controller.getSnapshot();
    expect(snapshot.bargeInActive).toBe(false);
    expect(snapshot.tip).toBe(BARGE_IN_TIP);
  });

  it("after it is off, speaking over the assistant does nothing, but a tap interrupts", async () => {
    const world = makeWorld({ maxConsecutiveFalseBargeIns: 1 });
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.hear(over(echo(0.03), 1500, 6000, 0.3));
    await vi.advanceTimersByTimeAsync(2600);
    world.controller.outcome({ kind: "empty" });
    expect(world.controller.getSnapshot().bargeInActive).toBe(false);

    await vi.advanceTimersByTimeAsync(500);
    world.player.cancel.mockClear();
    await world.askAndStartSpeaking();
    expect(world.watching).toBe(false); // no microphone watch at all now
    world.hear(over(echo(0.03), 500, 6000, 0.4));
    await vi.advanceTimersByTimeAsync(5000);
    expect(world.player.cancel).not.toHaveBeenCalled(); // talking over it does nothing

    await world.controller.interrupt(); // the tap still works
    expect(world.player.cancel).toHaveBeenCalledTimes(1);
    expect(world.controller.getSnapshot().phase).toBe("listening");
    expect(world.listenCalls.at(-1)).toEqual({ bargedIn: false });
  });

  it("an accepted barge-in resets the consecutive count, and three in a session still switch it off", async () => {
    const world = makeWorld();
    await world.controller.start();
    const bargeAndResult = async (result: { kind: "empty" } | { kind: "transcript"; text: string }) => {
      await world.askAndStartSpeaking();
      world.hear(over(echo(0.03), 1500, 6000, 0.3));
      await vi.advanceTimersByTimeAsync(2600);
      world.controller.outcome(result);
      await vi.advanceTimersByTimeAsync(500);
      // finish the turn the transcript started, as the app would
      if (result.kind === "transcript") {
        world.controller.chatRunning(true);
        world.setPlayback("idle");
        world.controller.chatRunning(false);
        world.controller.outcome({ kind: "no-speech" }); // ignored (phase is paused)
        await world.controller.tap();
      }
    };
    await bargeAndResult({ kind: "empty" }); // false 1
    await bargeAndResult({ kind: "transcript", text: "what about Boston" }); // accepted: consecutive back to 0
    expect(world.controller.getSnapshot().bargeInActive).toBe(true);
    await bargeAndResult({ kind: "empty" }); // false 2 (total), not consecutive
    expect(world.controller.getSnapshot().bargeInActive).toBe(true);
    await bargeAndResult({ kind: "empty" }); // false 3 (total): off
    expect(world.controller.getSnapshot().bargeInActive).toBe(false);
  });

  it("the debug override (barge-in off from the start) never watches or interrupts", async () => {
    const world = makeWorld({ bargeIn: false });
    await world.controller.start();
    await world.askAndStartSpeaking();
    expect(world.watching).toBe(false);
    world.controller.bargeIn();
    expect(world.player.cancel).not.toHaveBeenCalled();
    expect(world.controller.getSnapshot().tip).toBeNull(); // no tip: it was never on
  });

  it("the tip goes away when the conversation ends, and barge-in stays off for the session", async () => {
    const world = makeWorld({ maxConsecutiveFalseBargeIns: 1 });
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.hear(over(echo(0.03), 1500, 6000, 0.3));
    await vi.advanceTimersByTimeAsync(2600);
    world.controller.outcome({ kind: "no-speech" });
    expect(world.controller.getSnapshot().tip).toBe(BARGE_IN_TIP);
    world.controller.end();
    expect(world.controller.getSnapshot().tip).toBeNull();
    expect(world.controller.getSnapshot().bargeInActive).toBe(false);
  });
});

describe("tap interrupt still works, and the other guarantees hold", () => {
  it("interrupt() while speaking cuts the voice and listens (not a barge-in turn)", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    await world.controller.interrupt();
    expect(world.player.cancel).toHaveBeenCalledTimes(1);
    expect(world.ports.interrupted).toHaveBeenCalledTimes(1);
    expect(world.controller.getSnapshot().phase).toBe("listening");
    expect(world.listenCalls.at(-1)).toEqual({ bargedIn: false });
    expect(world.watching).toBe(false);
  });

  it("interrupt() while thinking cancels the request too; with nothing to interrupt it does nothing", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.controller.interrupt(); // listening: nothing to interrupt
    expect(world.ports.interrupted).not.toHaveBeenCalled();
    world.controller.outcome({ kind: "transcript", text: "q" });
    await world.controller.interrupt();
    expect(world.ports.cancelChat).toHaveBeenCalledTimes(1);
    expect(world.controller.getSnapshot().phase).toBe("listening");
  });

  it("End while watching releases the microphone watch, the pre-roll recorders and the wake lock", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    await vi.advanceTimersByTimeAsync(3000);
    expect(world.recorders.some((recorder) => recorder.state === "recording")).toBe(true);

    world.controller.end();
    expect(world.watching).toBe(false);
    expect(world.recorders.every((recorder) => recorder.state === "inactive")).toBe(true);
    expect(world.meters.every((meter) => meter.disposed)).toBe(true);
    expect(world.ports.closeSession).toHaveBeenCalled();
    expect(world.ports.wakeLock.release).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.recorders.filter((recorder) => recorder.state === "recording")).toHaveLength(0);
  });

  it("a pause (the page hidden) releases the watch too", async () => {
    const world = makeWorld();
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.controller.hidden();
    expect(world.watching).toBe(false);
    expect(world.recorders.every((recorder) => recorder.state === "inactive")).toBe(true);
  });

  it("StrictMode's mount, unmount, mount around a running conversation is safe", async () => {
    const world = makeWorld();
    world.controller.end(); // simulated unmount of a controller that never started
    await world.controller.start();
    await world.askAndStartSpeaking();
    world.controller.end();
    world.controller.end(); // and a second End
    expect(world.watching).toBe(false);
    await world.controller.start();
    expect(world.controller.getSnapshot().phase).toBe("listening");
  });
});

describe("what the voice UI binds to", () => {
  const base = { startFailure: null, bargeInActive: true, tip: null } as const;

  it.each([
    ["off", "", false, false, false],
    ["starting", "Listening", true, false, false],
    ["listening", "Listening", true, false, false],
    ["thinking", "Thinking", true, true, false],
    ["speaking", "Speaking", true, true, false],
    ["paused", "Paused", true, false, true],
  ] as const)("%s: statusText %j, active %s, canInterrupt %s, needsContinue %s", (phase, text, active, canInterrupt, needsContinue) => {
    const ui = conversationUiState({ ...base, phase, pauseReason: phase === "paused" ? "silence" : null });
    expect(ui).toMatchObject({ phase, statusText: text, active, canInterrupt, needsContinue });
    expect(STATUS_TEXT[phase]).toBe(text);
  });

  it("gives the pause reason as a short human sentence, with no mention of buttons", () => {
    for (const reason of Object.keys(PAUSE_REASON_TEXT) as Array<keyof typeof PAUSE_REASON_TEXT>) {
      const ui = conversationUiState({ ...base, phase: "paused", pauseReason: reason });
      expect(ui.pauseMessage).toBe(PAUSE_REASON_TEXT[reason]);
      expect(ui.pauseMessage).not.toMatch(/\btap\b|\bmic\b|\bbutton\b/i);
      expect((ui.pauseMessage as string).length).toBeLessThan(60);
    }
    expect(conversationUiState({ ...base, phase: "listening", pauseReason: null }).pauseMessage).toBeNull();
  });

  it("passes the one-time tip and a start failure through", () => {
    expect(conversationUiState({ ...base, phase: "speaking", pauseReason: null, tip: BARGE_IN_TIP }).tip).toBe(BARGE_IN_TIP);
    expect(conversationUiState({ ...base, phase: "off", pauseReason: null, startFailure: "denied" }).startFailure).toBe("denied");
  });
});
