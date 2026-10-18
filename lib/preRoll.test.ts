import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRE_ROLL_PERIOD_MS, PreRollRecorder, type PreRollDeps, type RecorderLike } from "./preRoll";

class FakeRecorder implements RecorderLike {
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  startedAt = 0;
  stopCalls = 0;
  start() {
    this.state = "recording";
    this.startedAt = Date.now();
  }
  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
    // Like MediaRecorder: the data arrives at stop.
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

function setup() {
  const recorders: FakeRecorder[] = [];
  const deps: PreRollDeps = {
    createRecorder: () => {
      const recorder = new FakeRecorder();
      recorders.push(recorder);
      return recorder;
    },
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  return { preRoll: new PreRollRecorder(deps), recorders };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PreRollRecorder", () => {
  it("runs two recorders half a period apart", async () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    expect(recorders).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS / 2);
    expect(recorders).toHaveLength(2);
    expect(recorders[1].startedAt - recorders[0].startedAt).toBe(PRE_ROLL_PERIOD_MS / 2);
  });

  it("restarts each recorder every period, discarding the old one, so memory stays bounded", async () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS * 5);
    expect(recorders.length).toBeGreaterThanOrEqual(10);
    const live = recorders.filter((recorder) => recorder.state === "recording");
    expect(live).toHaveLength(2); // never more than two at once
    expect(recorders.filter((recorder) => recorder.state === "inactive").every((recorder) => recorder.stopCalls === 1)).toBe(true);
  });

  it("at every moment the older recording is at least half a period old (so it holds the first words)", async () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS / 2); // both are running from here on
    for (let step = 0; step < 100; step++) {
      await vi.advanceTimersByTimeAsync(50);
      const ages = recorders.filter((recorder) => recorder.state === "recording").map((recorder) => Date.now() - recorder.startedAt);
      expect(Math.max(...ages)).toBeGreaterThanOrEqual(PRE_ROLL_PERIOD_MS / 2);
      expect(Math.max(...ages)).toBeLessThanOrEqual(PRE_ROLL_PERIOD_MS);
    }
  });

  it("adopt() hands over the older recorder still recording, and stops and discards the other", async () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS / 2 + 100);
    const capture = preRoll.adopt()!;
    expect(capture.recorder.state).toBe("recording");
    expect(capture.startedAt).toBe(recorders[0].startedAt);
    const other = recorders.find((recorder) => recorder !== capture.recorder && recorder.startedAt > capture.startedAt)!;
    expect(other.state).toBe("inactive");

    // The adopted recording is left alone: no restart timer will stop it.
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS * 3);
    expect(capture.recorder.state).toBe("recording");
    expect(preRoll.adopt()).toBeNull();
  });

  it("the adopted chunks array keeps filling as the recording continues", async () => {
    const { preRoll } = setup();
    preRoll.start();
    await vi.advanceTimersByTimeAsync(800);
    const capture = preRoll.adopt()!;
    expect(capture.chunks).toHaveLength(0); // MediaRecorder delivers at stop
    capture.recorder.stop();
    expect(capture.chunks).toHaveLength(1);
  });

  it("with only one recorder running (just started), adopt() still returns it", () => {
    const { preRoll } = setup();
    preRoll.start();
    expect(preRoll.adopt()?.recorder.state).toBe("recording");
  });

  it("data from a recorder that was discarded is ignored, and stop() discards everything", async () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS / 2);
    preRoll.stop();
    expect(recorders.every((recorder) => recorder.state === "inactive")).toBe(true);
    expect(preRoll.adopt()).toBeNull();
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS * 3);
    expect(recorders).toHaveLength(2); // nothing restarts after stop
  });

  it("start() twice does not start twice", () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    preRoll.start();
    expect(recorders).toHaveLength(1);
  });

  it("a recorder that throws on stop does not break the rolling", async () => {
    const { preRoll, recorders } = setup();
    preRoll.start();
    recorders[0].stop = () => {
      throw new Error("already stopped");
    };
    await vi.advanceTimersByTimeAsync(PRE_ROLL_PERIOD_MS * 2); // would throw if the failure escaped
    expect(recorders.filter((recorder) => recorder.state === "recording").length).toBeGreaterThanOrEqual(1);
  });
});
