import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BARGE_IN,
  BargeInWatch,
  bargeInAllowed,
  createBargeInDetector,
  type BargeInTrigger,
  type Frame,
  type MeterLike,
  type WatchDeps,
} from "./bargeIn";
import type { PreRollCapture, RecorderLike } from "./preRoll";

const STEP = BARGE_IN.pollMs;

/** A scripted microphone: the frame at time t (ms since the clip began). */
type Script = (t: number) => Frame;

/** Echo of the assistant's own voice: syllable-by-syllable level variation around `base`, with the odd short peak. */
const echo = (base: number): Script => (t) => {
  const syllable = Math.floor(t / 100) % 2 === 0 ? 0.7 : 1.3;
  const peak = Math.floor(t / 1000) % 3 === 1 && t % 1000 < 150 ? 1.6 : 1;
  return { rms: base * syllable * peak, zcr: 0.08 };
};

/** Echo plus the user speaking from `from` for `length` ms at `level` (their voice adds in quadrature). */
const withUser = (under: Script, from: number, length: number, level: number, zcr = 0.1): Script => (t) => {
  const base = under(t);
  if (t < from || t >= from + length) return base;
  return { rms: Math.sqrt(base.rms ** 2 + level ** 2), zcr };
};

/** Run a script through a fresh detector for `durationMs`; returns when (ms into the clip) it triggered. */
function run(script: Script, durationMs: number, options: { clipRestarts?: number[] } = {}): { at: number | null; trigger: BargeInTrigger | null } {
  const detector = createBargeInDetector();
  let clipStart = 0;
  detector.clipStarted(0);
  const restarts = [...(options.clipRestarts ?? [])];
  for (let t = STEP; t <= durationMs; t += STEP) {
    if (restarts.length && t >= restarts[0]) {
      restarts.shift();
      clipStart = t;
      detector.clipStarted(t);
    }
    const trigger = detector.update(script(t - clipStart), t);
    if (trigger) return { at: t, trigger };
  }
  return { at: null, trigger: null };
}

describe("echo alone never triggers, at three echo levels", () => {
  it.each([0.01, 0.03, 0.06])("echo level %f over 12 seconds and several clips", (base) => {
    const result = run(echo(base), 12_000, { clipRestarts: [3000, 6500, 9000] });
    expect(result.at).toBeNull();
  });

  it("a mild drift in the echo level (1.5x) does not trigger either", () => {
    const drifting: Script = (t) => ({ rms: echo(0.03)(t).rms * (1 + (0.5 * t) / 10_000), zcr: 0.08 });
    expect(run(drifting, 10_000).at).toBeNull();
  });

  it("a short burst of echo (3x for 200 ms) is not sustained", () => {
    const burst: Script = (t) => ({ rms: t >= 2000 && t < 2200 ? 0.03 * 3 * 1.3 : echo(0.03)(t).rms, zcr: 0.08 });
    expect(run(burst, 6000).at).toBeNull();
  });
});

describe("the user speaking over the assistant triggers", () => {
  it("over a loud echo, within the sustain time of the speech starting", () => {
    const onset = 2000;
    const result = run(withUser(echo(0.06), onset, 3000, 0.3), 6000);
    expect(result.at).not.toBeNull();
    const delay = (result.at as number) - onset;
    expect(delay).toBeGreaterThanOrEqual(BARGE_IN.sustainMs - STEP);
    expect(delay).toBeLessThanOrEqual(BARGE_IN.sustainMs + 3 * STEP);
    expect(result.trigger!.level).toBeGreaterThan(result.trigger!.threshold);
    expect(result.trigger!.ratio).toBeGreaterThan(BARGE_IN.margin);
  });

  it("a quiet speaker over a low echo", () => {
    const result = run(withUser(echo(0.01), 1500, 3000, 0.08), 6000);
    expect(result.at).not.toBeNull();
    expect((result.at as number) - 1500).toBeLessThanOrEqual(BARGE_IN.sustainMs + 3 * STEP);
  });

  it("natural speech with short dips between syllables still triggers", () => {
    const syllables = withUser(echo(0.02), 1500, 4000, 0.25);
    const dipped: Script = (t) => (t >= 1500 && Math.floor((t - 1500) / 100) % 5 === 4 ? echo(0.02)(t) : syllables(t));
    const result = run(dipped, 6000);
    expect(result.at).not.toBeNull();
    expect((result.at as number) - 1500).toBeLessThanOrEqual(1200);
  });

  it("re-calibrates on every clip: speech over the second clip of an answer triggers too", () => {
    const result = run(withUser(echo(0.04), 800, 4000, 0.3), 9000, { clipRestarts: [4000] });
    // The user speaks 800 ms into the second clip (clip time), i.e. at 4800 ms overall.
    const secondClip = withUser(echo(0.04), 800, 4000, 0.3);
    const detector = createBargeInDetector();
    let triggerAt: number | null = null;
    detector.clipStarted(0);
    for (let t = STEP; t <= 9000 && triggerAt === null; t += STEP) {
      if (t === 4000) detector.clipStarted(4000);
      const clipTime = t < 4000 ? t : t - 4000;
      if (detector.update(t < 4000 ? echo(0.04)(clipTime) : secondClip(clipTime), t)) triggerAt = t;
    }
    expect(triggerAt).not.toBeNull();
    expect(triggerAt as number).toBeGreaterThanOrEqual(4000 + 800 + BARGE_IN.sustainMs - STEP);
    void result;
  });
});

describe("what must not trigger", () => {
  it("a cough (250 ms), a click (50 ms) and a door slam (400 ms of broadband noise)", () => {
    const cough = withUser(echo(0.02), 2000, 250, 0.4);
    const click = withUser(echo(0.02), 2000, 50, 0.8, 0.5);
    const slam = withUser(echo(0.02), 2000, 400, 0.5, 0.45);
    expect(run(cough, 6000).at).toBeNull();
    expect(run(click, 6000).at).toBeNull();
    expect(run(slam, 6000).at).toBeNull();
  });

  it("sustained broadband noise (hiss, wind, a truck) is not a voice: the zero-crossing gate rejects it", () => {
    expect(run(withUser(echo(0.02), 1500, 4000, 0.3, 0.5), 6000).at).toBeNull();
  });

  it("two coughs close together do not add up", () => {
    const script: Script = (t) =>
      (t >= 2000 && t < 2250) || (t >= 2600 && t < 2850) ? { rms: 0.4, zcr: 0.1 } : echo(0.02)(t);
    expect(run(script, 6000).at).toBeNull();
  });

  it("a quiet speaker over a LOUD echo does not trigger (the known limit: use headphones)", () => {
    // Echo 0.06 puts the threshold near 0.2; a 0.15 voice adds to ~0.16 and stays under it.
    expect(run(withUser(echo(0.06), 2000, 4000, 0.15), 8000).at).toBeNull();
  });

  it("speech already under way when the clip starts raises the calibration, so it does not trigger", () => {
    expect(run(withUser(echo(0.02), 0, 8000, 0.3), 8000).at).toBeNull();
  });

  it("nothing can trigger before it is armed, 600 ms into the clip", () => {
    // The user's voice begins right after calibration (450 ms): the earliest trigger is armAfterMs + sustainMs.
    const result = run(withUser(echo(0.01), 450, 5000, 0.3), 4000);
    expect(result.at).not.toBeNull();
    expect(result.at as number).toBeGreaterThanOrEqual(BARGE_IN.armAfterMs + BARGE_IN.sustainMs - STEP);
  });

  it("does nothing until a clip has started", () => {
    const detector = createBargeInDetector();
    for (let t = 0; t < 3000; t += STEP) expect(detector.update({ rms: 0.5, zcr: 0.1 }, t)).toBeNull();
  });

  it("reports when it arms, with the threshold it will use", () => {
    const onArmed = vi.fn();
    const detector = createBargeInDetector(BARGE_IN, onArmed);
    detector.clipStarted(0);
    for (let t = STEP; t <= 1000; t += STEP) detector.update(echo(0.03)(t), t);
    expect(onArmed).toHaveBeenCalledTimes(1);
    expect(onArmed.mock.calls[0][0]).toBeGreaterThanOrEqual(BARGE_IN.absoluteMin);
    expect(detector.armed).toBe(true);
  });

  it("a silent room has a sane threshold: the absolute minimum", () => {
    const detector = createBargeInDetector();
    detector.clipStarted(0);
    for (let t = STEP; t <= 800; t += STEP) detector.update({ rms: 0, zcr: 0.1 }, t);
    expect(detector.threshold).toBe(BARGE_IN.absoluteMin);
  });
});

// --------------------------------------------------------------------------- //
// The watch: detector + meter + pre-roll with fake timers
// --------------------------------------------------------------------------- //

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

function makeWatch(script: Script, options: { autoAdopt?: boolean } = {}) {
  const autoAdopt = options.autoAdopt ?? true;
  const clipStartAt = 0;
  const captures: Array<PreRollCapture | null> = [];
  const recorders: FakeRecorder[] = [];
  const meters: { disposed: boolean }[] = [];
  const triggers: BargeInTrigger[] = [];
  const armed: number[] = [];
  const startedAt = Date.now();
  const deps: WatchDeps = {
    createMeter: (): MeterLike => {
      const meter = { disposed: false };
      meters.push(meter);
      return { read: () => script(Date.now() - startedAt - clipStartAt), dispose: () => void (meter.disposed = true) };
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
  // Like the hook: on a trigger the pre-roll is adopted in the same breath, before anything else can restart it.
  const watch: BargeInWatch = new BargeInWatch(deps, {
    onTrigger: (trigger) => {
      triggers.push(trigger);
      if (autoAdopt) captures.push(watch.takePreRoll());
    },
    onArmed: (threshold) => armed.push(threshold),
  });
  return { watch, recorders, meters, triggers, armed, captures };
}

describe("BargeInWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("triggers when the user speaks, and the pre-roll already holds the first words", async () => {
    const onset = 2300;
    const { watch, recorders, triggers, captures } = makeWatch(withUser(echo(0.03), onset, 5000, 0.3));
    watch.start();
    watch.clipStarted();
    await vi.advanceTimersByTimeAsync(onset + 1000);

    expect(triggers).toHaveLength(1);
    const capture = captures[0]!;
    expect(capture).not.toBeNull();
    // The recording began before the user's first word, and is still recording.
    expect(capture.startedAt).toBeLessThanOrEqual(onset);
    expect(capture.recorder.state).toBe("recording");
    // Only the adopted recorder is left running.
    expect(recorders.filter((recorder) => recorder.state === "recording")).toEqual([capture.recorder]);
  });

  it("property: the first words are in the pre-roll whatever moment in the recording cycle the user starts", async () => {
    for (let onset = 700; onset <= 3100; onset += 50) {
      vi.setSystemTime(0);
      const { watch, triggers, captures } = makeWatch(withUser(echo(0.03), onset, 5000, 0.3));
      watch.start();
      watch.clipStarted();
      await vi.advanceTimersByTimeAsync(onset + 1000);
      expect(triggers, `onset ${onset}`).toHaveLength(1);
      const capture = captures[0]!;
      expect(capture.startedAt, `onset ${onset}`).toBeLessThanOrEqual(onset);
      watch.stop();
    }
  });

  it("echo only: never triggers, and keeps rolling the pre-roll without growing", async () => {
    const { watch, recorders, triggers, armed } = makeWatch(echo(0.04));
    watch.start();
    watch.clipStarted();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(triggers).toEqual([]);
    expect(armed).toHaveLength(1);
    expect(recorders.filter((recorder) => recorder.state === "recording")).toHaveLength(2);
  });

  it("stop() releases the meter and every recorder", async () => {
    const { watch, recorders, meters } = makeWatch(echo(0.04));
    watch.start();
    await vi.advanceTimersByTimeAsync(2000);
    watch.stop();
    expect(meters.every((meter) => meter.disposed)).toBe(true);
    expect(recorders.every((recorder) => recorder.state === "inactive")).toBe(true);
    expect(watch.running).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(recorders.filter((recorder) => recorder.state === "recording")).toHaveLength(0);
  });

  it("start() twice, and a StrictMode start, stop, start, behave", async () => {
    const { watch, recorders } = makeWatch(echo(0.04));
    watch.start();
    watch.start();
    watch.stop();
    watch.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(recorders.filter((recorder) => recorder.state === "recording")).toHaveLength(2);
    watch.stop();
  });

  it("after a trigger it stops reading levels (no second trigger) but keeps the pre-roll until adopted", async () => {
    const { watch, triggers, meters } = makeWatch(withUser(echo(0.03), 1500, 9000, 0.3), { autoAdopt: false });
    watch.start();
    watch.clipStarted();
    await vi.advanceTimersByTimeAsync(6000);
    expect(triggers).toHaveLength(1);
    expect(meters[0].disposed).toBe(true);
    expect(watch.takePreRoll()).not.toBeNull();
  });
});

describe("the debug override", () => {
  it("is always allowed unless ?bargein=off or localStorage says off", () => {
    expect(bargeInAllowed("", null)).toBe(true);
    expect(bargeInAllowed("?debug=voice", null)).toBe(true);
    expect(bargeInAllowed("?bargein=off", null)).toBe(false);
    expect(bargeInAllowed("?x=1&bargein=off", null)).toBe(false);
    expect(bargeInAllowed("", "off")).toBe(false);
    expect(bargeInAllowed("?bargein=on", "on")).toBe(true);
  });
});
