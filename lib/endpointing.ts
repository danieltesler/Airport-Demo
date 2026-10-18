/**
 * Decides when the speaker has finished, from a stream of mic-level readings.
 *
 * A fixed level is a lab number: in a noisy room it never reads as silence. So the
 * quietest quarter of the first calibrationMs sets a noise floor, and speech has
 * to rise well above it. Silence only counts after minSpeechMs of real speech, so
 * a cough or a click cannot end the turn before it starts.
 */
export const ENDPOINT_DEFAULTS = {
  calibrationMs: 300,
  minSpeechMs: 300,
  silenceMs: 850,
  maxMs: 20000,
  minThreshold: 0.02,
  maxThreshold: 0.1, // above this, a noisy room would make normal speech undetectable
  floorMultiplier: 3,
  /** Hands-free mode: give up if no speech starts within this long. 0 turns it off (tap-to-talk). */
  noSpeechMs: 0,
};

export type EndpointConfig = typeof ENDPOINT_DEFAULTS;
export type StopReason = "silence" | "max-duration" | "no-speech";

export interface Endpointer {
  /** Feed one reading; returns why to stop, or null to keep recording. */
  update(rms: number, now: number): StopReason | null;
  /** The speech threshold once calibration has finished, else null. */
  readonly threshold: number | null;
  /** At least minSpeechMs of speech has been heard. A clip without it is silence or room noise. */
  readonly hadSpeech: boolean;
}

/** The quietest quarter of the readings; robust if the speaker starts talking during calibration. */
export function noiseFloor(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * 0.25)];
}

export function createEndpointer(startedAt: number, config: EndpointConfig = ENDPOINT_DEFAULTS): Endpointer {
  const calibration: { rms: number; at: number }[] = [];
  let threshold: number | null = null;
  let lastSampleAt = startedAt;
  let lastLoudAt = startedAt;
  let speechMs = 0;

  return {
    get threshold() {
      return threshold;
    },
    get hadSpeech() {
      return speechMs >= config.minSpeechMs;
    },
    update(rms, now) {
      if (now - startedAt > config.maxMs) return "max-duration";
      if (config.noSpeechMs > 0 && speechMs < config.minSpeechMs && now - startedAt > config.noSpeechMs) return "no-speech";

      if (threshold === null) {
        calibration.push({ rms, at: now });
        if (now - startedAt < config.calibrationMs) {
          lastSampleAt = now;
          return null;
        }
        const floor = noiseFloor(calibration.map((sample) => sample.rms));
        threshold = Math.min(config.maxThreshold, Math.max(config.minThreshold, floor * config.floorMultiplier));
        // Someone who starts talking the moment they tap is speaking during calibration: count it.
        let previous = startedAt;
        for (const sample of calibration) {
          if (sample.rms > threshold) {
            speechMs += sample.at - previous;
            lastLoudAt = sample.at;
          }
          previous = sample.at;
        }
        lastSampleAt = now;
        return null;
      }

      if (rms > threshold) {
        speechMs += now - lastSampleAt;
        lastLoudAt = now;
      }
      lastSampleAt = now;

      const hasSpoken = speechMs >= config.minSpeechMs;
      return hasSpoken && now - lastLoudAt > config.silenceMs ? "silence" : null;
    },
  };
}
