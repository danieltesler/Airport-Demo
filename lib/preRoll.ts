/**
 * Pre-roll for voice barge-in: the user's first words, captured before anyone knew they were
 * talking.
 *
 * A MediaRecorder cannot back-fill, and the chunks of a running recording cannot be cut in the
 * middle and decoded on their own (only the first holds the header). So two recorders run during
 * playback, started half a period apart, each thrown away and restarted every `periodMs`. At any
 * moment the older one has been recording for between periodMs/2 and periodMs, which is longer than
 * the time the detector needs to be sure someone is speaking, so its recording contains the first
 * word. When barge-in fires, the older recorder is adopted as the utterance recording and carries
 * straight on; the other is discarded. Plain MediaRecorder output, no encoder, no AudioWorklet.
 */

export interface RecorderLike {
  start(): void;
  stop(): void;
  readonly state: string;
  readonly mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export interface PreRollCapture {
  recorder: RecorderLike;
  /** The recorder keeps pushing into this array while it records. */
  chunks: Blob[];
  /** When this recorder began, so a test (or a trace) can say how much pre-roll there is. */
  startedAt: number;
}

export interface PreRollDeps {
  createRecorder(): RecorderLike;
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Long enough that the older recorder always covers the detector's sustain time with margin (see BARGE_IN.sustainMs). */
export const PRE_ROLL_PERIOD_MS = 1200;

interface Slot {
  recorder: RecorderLike;
  chunks: Blob[];
  startedAt: number;
  timer: unknown;
  discarded: boolean;
}

export class PreRollRecorder {
  private slots: [Slot | null, Slot | null] = [null, null];
  private staggerTimer: unknown = null;
  private running = false;

  constructor(
    private readonly deps: PreRollDeps,
    private readonly periodMs: number = PRE_ROLL_PERIOD_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.beginSlot(0);
    this.staggerTimer = this.deps.setTimer(() => {
      this.staggerTimer = null;
      if (this.running) this.beginSlot(1);
    }, this.periodMs / 2);
  }

  /** Take the older recording for the utterance; stop and drop everything else. Null if nothing is recording. */
  adopt(): PreRollCapture | null {
    const live = this.slots.filter((slot): slot is Slot => slot !== null);
    if (live.length === 0) return null;
    const older = live.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    this.deps.clearTimer(older.timer);
    this.slots = this.slots.map((slot) => (slot === older ? null : slot)) as [Slot | null, Slot | null];
    this.stop();
    return { recorder: older.recorder, chunks: older.chunks, startedAt: older.startedAt };
  }

  /** Stop and discard everything still recording. */
  stop(): void {
    this.running = false;
    if (this.staggerTimer !== null) this.deps.clearTimer(this.staggerTimer);
    this.staggerTimer = null;
    this.slots.forEach((slot, index) => {
      if (!slot) return;
      this.discard(slot);
      this.slots[index] = null;
    });
  }

  private beginSlot(index: 0 | 1): void {
    const recorder = this.deps.createRecorder();
    const slot: Slot = { recorder, chunks: [], startedAt: this.deps.now(), timer: null, discarded: false };
    recorder.ondataavailable = (event) => {
      if (!slot.discarded && event.data.size > 0) slot.chunks.push(event.data);
    };
    recorder.onstop = null;
    recorder.start();
    slot.timer = this.deps.setTimer(() => this.restart(index), this.periodMs);
    this.slots[index] = slot;
  }

  private restart(index: 0 | 1): void {
    const old = this.slots[index];
    if (old) this.discard(old);
    if (this.running) this.beginSlot(index);
  }

  private discard(slot: Slot): void {
    slot.discarded = true;
    this.deps.clearTimer(slot.timer);
    if (slot.recorder.state !== "inactive") {
      try {
        slot.recorder.stop();
      } catch {
        // already stopped: nothing to discard
      }
    }
  }
}
