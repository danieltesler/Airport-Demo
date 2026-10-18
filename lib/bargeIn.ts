/**
 * Voice barge-in: noticing that the user has started talking over the assistant, without mistaking
 * the assistant's own voice (coming back through the phone speaker) for the user.
 *
 * The microphone requests the browser's echo cancellation, but on some devices it is imperfect, so
 * the detector assumes some echo remains and is built to ignore it:
 *  - Per clip, the first CALIBRATION_MS measure the echo level that is left (its 80th percentile),
 *    and nothing can trigger until ARM_AFTER_MS, so the echo of a clip's first syllable is never taken for speech.
 *  - Speech must beat that echo by MARGIN (2.5x) and an absolute minimum, and must be
 *    voice-like (a zero-crossing rate in the speech band: clicks, hiss and bursts of noise are not).
 *  - It must keep that up for SUSTAIN_MS of voiced time (a short dip between syllables only costs a little),
 *    so a cough, a click or a burst of echo cannot trigger it.
 *  - The echo floor keeps adapting upward while the assistant talks, so a louder passage does not
 *    cross the threshold.
 * Pure and deterministic: frames in, a decision out. The safety net for what this still gets wrong
 * (counting false triggers and switching itself off) lives in lib/conversation.ts.
 */

import { PreRollRecorder, type PreRollCapture, type PreRollDeps } from "./preRoll";

export const BARGE_IN = {
  /** How often the level is read. */
  pollMs: 50,
  /** Per clip: measure the echo that is left over this long... */
  calibrationMs: 400,
  /** ...and do not listen for the user at all until this long after the clip began. */
  armAfterMs: 600,
  /** Speech has to be this many times the echo floor. */
  margin: 2.5,
  /** ...and at least this loud (about 2.5x the tap-to-talk speech floor), so a silent room has a sane threshold. */
  absoluteMin: 0.05,
  /** Voiced time needed to trigger. */
  sustainMs: 400,
  /** An unvoiced frame costs this many frames of voiced credit, so syllable gaps are tolerated and a burst is not enough. */
  dropoutCost: 2,
  /** Speech-band zero-crossing rate per sample (voiced speech is low, hiss and clicks are high). */
  zcrMin: 0.01,
  zcrMax: 0.25,
  /** How fast the echo floor follows the level of frames that were not speech. */
  floorAdapt: 0.03,
};

export type BargeInConfig = typeof BARGE_IN;

export interface Frame {
  rms: number;
  /** Zero-crossing rate of the frame, 0 to 1. Omitted when unknown (then only loudness counts). */
  zcr?: number;
}

export interface BargeInTrigger {
  /** Average level of the voiced frames. */
  level: number;
  /** The level it had to beat. */
  threshold: number;
  /** level / echo floor: how far above the echo it was (trace only). */
  ratio: number;
  voicedMs: number;
}

export interface BargeInDetector {
  /** A new clip began playing: restart the echo calibration and the arming delay. */
  clipStarted(now: number): void;
  /** Feed one frame; returns the trigger when the user is speaking over the assistant. */
  update(frame: Frame, now: number): BargeInTrigger | null;
  readonly armed: boolean;
  readonly threshold: number | null;
}

const percentile = (samples: number[], fraction: number): number => {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * fraction)];
};

export function createBargeInDetector(config: BargeInConfig = BARGE_IN, onArmed?: (threshold: number) => void): BargeInDetector {
  let clipStartedAt: number | null = null;
  let calibration: number[] = [];
  let calibratedFloor: number | null = null;
  let floorEstimate = 0;
  let armed = false;
  let voicedMs = 0;
  let voicedSum = 0;
  let voicedFrames = 0;
  let lastAt = 0;

  const effectiveFloor = (): number => Math.max(calibratedFloor ?? 0, floorEstimate);
  const thresholdNow = (): number => Math.max(config.absoluteMin, config.margin * effectiveFloor());

  return {
    clipStarted(now) {
      clipStartedAt = now;
      calibration = [];
      calibratedFloor = null;
      floorEstimate = 0;
      armed = false;
      voicedMs = 0;
      voicedSum = 0;
      voicedFrames = 0;
      lastAt = now;
    },
    get armed() {
      return armed;
    },
    get threshold() {
      return calibratedFloor === null ? null : thresholdNow();
    },
    update(frame, now) {
      if (clipStartedAt === null) return null;
      const dt = Math.max(0, now - lastAt);
      lastAt = now;
      const age = now - clipStartedAt;

      if (age < config.calibrationMs) {
        calibration.push(frame.rms);
        return null;
      }
      if (calibratedFloor === null) {
        calibratedFloor = percentile(calibration, 0.8);
        floorEstimate = calibratedFloor;
      }
      const threshold = thresholdNow();
      const voiceLike = frame.zcr === undefined || (frame.zcr >= config.zcrMin && frame.zcr <= config.zcrMax);
      const voiced = frame.rms > threshold && voiceLike;

      // The echo floor follows frames that were not speech, slowly, and only upward matters (it is a max with the calibrated floor).
      if (!voiced && frame.rms <= threshold) floorEstimate = floorEstimate * (1 - config.floorAdapt) + frame.rms * config.floorAdapt;

      if (age < config.armAfterMs) return null;
      if (!armed) {
        armed = true;
        onArmed?.(threshold);
      }

      if (voiced) {
        voicedMs += dt;
        voicedSum += frame.rms;
        voicedFrames += 1;
      } else {
        voicedMs = Math.max(0, voicedMs - config.dropoutCost * dt);
        if (voicedMs === 0) {
          voicedSum = 0;
          voicedFrames = 0;
        }
      }
      if (voicedMs < config.sustainMs) return null;

      const level = voicedFrames > 0 ? voicedSum / voicedFrames : frame.rms;
      return { level, threshold, ratio: level / Math.max(effectiveFloor(), 1e-4), voicedMs };
    },
  };
}

// --------------------------------------------------------------------------- //
// The watch: meter + detector + pre-roll, started while the assistant is audible.
// --------------------------------------------------------------------------- //

export interface MeterLike {
  read(): Frame;
  dispose(): void;
}

export interface WatchDeps extends PreRollDeps {
  createMeter(): MeterLike;
  setPoll(callback: () => void, ms: number): unknown;
  clearPoll(handle: unknown): void;
}

export interface WatchHandlers {
  /** The user is talking over the assistant. The pre-roll is still held: take it with `takePreRoll`. */
  onTrigger(trigger: BargeInTrigger): void;
  onArmed?(threshold: number): void;
}

export class BargeInWatch {
  private meter: MeterLike | null = null;
  private poll: unknown = null;
  private preRoll: PreRollRecorder | null = null;
  private readonly detector: BargeInDetector;
  private triggered = false;

  constructor(
    private readonly deps: WatchDeps,
    private readonly handlers: WatchHandlers,
    config: BargeInConfig = BARGE_IN,
  ) {
    this.detector = createBargeInDetector(config, (threshold) => handlers.onArmed?.(threshold));
    this.config = config;
  }

  private readonly config: BargeInConfig;

  get running(): boolean {
    return this.poll !== null || this.preRoll !== null;
  }

  /** Start reading the microphone and recording the rolling pre-roll. */
  start(): void {
    if (this.running) return;
    this.triggered = false;
    this.meter = this.deps.createMeter();
    this.preRoll = new PreRollRecorder(this.deps);
    this.preRoll.start();
    this.poll = this.deps.setPoll(() => this.tick(), this.config.pollMs);
  }

  /** The assistant began a new clip: recalibrate against its echo. */
  clipStarted(): void {
    this.detector.clipStarted(this.deps.now());
  }

  /** After a trigger: the recording that already contains the user's first words. */
  takePreRoll(): PreRollCapture | null {
    return this.preRoll?.adopt() ?? null;
  }

  stop(): void {
    if (this.poll !== null) this.deps.clearPoll(this.poll);
    this.poll = null;
    this.meter?.dispose();
    this.meter = null;
    this.preRoll?.stop();
    this.preRoll = null;
  }

  private tick(): void {
    if (!this.meter || this.triggered) return;
    const trigger = this.detector.update(this.meter.read(), this.deps.now());
    if (!trigger) return;
    this.triggered = true;
    // Stop reading levels, but keep the pre-roll: the caller adopts it straight away.
    if (this.poll !== null) this.deps.clearPoll(this.poll);
    this.poll = null;
    this.meter?.dispose();
    this.meter = null;
    this.handlers.onTrigger(trigger);
  }
}

// --------------------------------------------------------------------------- //
// Debug override
// --------------------------------------------------------------------------- //

/**
 * Voice barge-in is always on during a conversation. For debugging only, ?bargein=off in the URL
 * (or localStorage "bargein" = "off") switches it off. Nothing in the interface offers this.
 */
export function bargeInAllowed(search: string, storedValue: string | null): boolean {
  if (new URLSearchParams(search).get("bargein") === "off") return false;
  return storedValue !== "off";
}
