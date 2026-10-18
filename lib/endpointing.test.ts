import { describe, expect, it } from "vitest";
import { ENDPOINT_DEFAULTS, createEndpointer, noiseFloor, type Endpointer, type StopReason } from "./endpointing";

const STEP = 100;

/** Feed a script of [rms, durationMs] segments; returns when and why it stopped. */
function run(script: Array<[number, number]>): { stoppedAt: number | null; reason: StopReason | null; endpointer: Endpointer } {
  const endpointer = createEndpointer(0);
  let now = 0;
  for (const [rms, duration] of script) {
    for (let elapsed = 0; elapsed < duration; elapsed += STEP) {
      now += STEP;
      const reason = endpointer.update(rms, now);
      if (reason) return { stoppedAt: now, reason, endpointer };
    }
  }
  return { stoppedAt: null, reason: null, endpointer };
}

describe("noiseFloor", () => {
  it("is the quietest quarter, so early speech does not inflate it", () => {
    expect(noiseFloor([0.01, 0.01, 0.2, 0.2])).toBe(0.01);
    expect(noiseFloor([])).toBe(0);
  });
});

describe("createEndpointer", () => {
  it("stops about 850 ms after speech ends in a quiet room", () => {
    const { stoppedAt, reason } = run([[0.003, 300], [0.1, 1000], [0.003, 3000]]);
    expect(reason).toBe("silence");
    // speech ends at 1300 ms; the stop lands just after the 850 ms wait
    expect(stoppedAt).toBeGreaterThanOrEqual(1300 + ENDPOINT_DEFAULTS.silenceMs);
    expect(stoppedAt).toBeLessThanOrEqual(1300 + ENDPOINT_DEFAULTS.silenceMs + 2 * STEP);
  });

  it("raises the threshold in a noisy room so room noise still reads as silence", () => {
    // Steady 0.03 noise is above the old fixed 0.02 and would never have stopped.
    const noisy = run([[0.03, 300], [0.2, 1000], [0.03, 3000]]);
    expect(noisy.endpointer.threshold).toBeCloseTo(0.09, 5);
    expect(noisy.reason).toBe("silence");
  });

  it("never lets the threshold fall below the quiet-room minimum or above the cap", () => {
    expect(run([[0, 400]]).endpointer.threshold).toBe(ENDPOINT_DEFAULTS.minThreshold);
    expect(run([[0.5, 400]]).endpointer.threshold).toBe(ENDPOINT_DEFAULTS.maxThreshold);
  });

  it("ignores a blip shorter than the minimum speech guard", () => {
    const { reason } = run([[0.003, 300], [0.1, 100], [0.003, 5000]]);
    expect(reason).toBeNull();
  });

  it("does not cut a speaker off during a short mid-sentence pause", () => {
    const { reason } = run([[0.003, 300], [0.1, 800], [0.003, 600], [0.1, 800], [0.003, 600]]);
    expect(reason).toBeNull();
  });

  it("stops at the hard cap if the room never goes quiet", () => {
    const { reason, stoppedAt } = run([[0.003, 300], [0.1, 30000]]);
    expect(reason).toBe("max-duration");
    expect(stoppedAt).toBeLessThanOrEqual(ENDPOINT_DEFAULTS.maxMs + STEP);
  });

  it("counts speech that starts the instant the speaker taps, during calibration", () => {
    expect(run([[0.15, 600], [0.003, 3000]]).endpointer.hadSpeech).toBe(true);
    expect(run([[0.003, 300], [0.003, 3000]]).endpointer.hadSpeech).toBe(false);
  });

  it("knows whether any real speech was heard, so a silent clip can be dropped", () => {
    expect(run([[0.003, 300], [0.1, 1000], [0.003, 3000]]).endpointer.hadSpeech).toBe(true);
    expect(run([[0.003, 300], [0.003, 3000]]).endpointer.hadSpeech).toBe(false);
    expect(run([[0.003, 300], [0.1, 100], [0.003, 3000]]).endpointer.hadSpeech).toBe(false);
  });

  it("in hands-free mode gives up when nobody starts speaking, but never cuts off someone who did", () => {
    const handsFree = { ...ENDPOINT_DEFAULTS, noSpeechMs: 8000 };
    const silent = createEndpointer(0, handsFree);
    let reason: StopReason | null = null;
    let now = 0;
    while (!reason && now < 20000) reason = silent.update(0.003, (now += STEP));
    expect(reason).toBe("no-speech");
    expect(now).toBeGreaterThan(8000);
    expect(now).toBeLessThanOrEqual(8000 + STEP);

    const speaker = createEndpointer(0, handsFree);
    now = 0;
    reason = null;
    for (let i = 0; i < 30 && !reason; i++) reason = speaker.update(i < 3 ? 0.003 : 0.1, (now += STEP));
    expect(reason).toBeNull();
  });

  it("tap-to-talk never gives up early", () => {
    expect(run([[0.003, 300], [0.003, 15000]]).reason).toBeNull();
  });

  it("copes with speech that starts during calibration", () => {
    const { reason } = run([[0.15, 600], [0.003, 3000]]);
    expect(reason).toBe("silence");
  });
});
