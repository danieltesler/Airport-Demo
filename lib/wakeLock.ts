/**
 * Keeps the screen on during a hands-free session. A phone that dims and locks suspends the page,
 * the microphone and audio, which ends a conversation silently. The Screen Wake Lock API (Chrome
 * on Android, Safari 16.4+) prevents that. It is feature-detected: where it is missing or refused,
 * the conversation still works until the screen locks, and then pauses (see lib/conversation.ts).
 *
 * The browser releases the lock whenever the page is hidden, so it is requested again when the
 * page becomes visible, but only while a session still wants it.
 */

export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface NavigatorWithWakeLock {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

export interface ScreenWakeLock {
  /** Ask for the lock; true if held, false if unsupported or refused. Safe to call twice. */
  acquire(): Promise<boolean>;
  /** Give the lock up for good (End, or leaving the conversation). */
  release(): Promise<void>;
  /** Call when the page becomes visible again: re-request the lock if a session still wants it. */
  onVisible(): Promise<void>;
  readonly held: boolean;
}

export function createScreenWakeLock(nav: NavigatorWithWakeLock | undefined = typeof navigator === "undefined" ? undefined : navigator): ScreenWakeLock {
  let sentinel: WakeLockSentinelLike | null = null;
  let wanted = false;
  // Requests and releases run one after another: an acquire, release, acquire in quick succession
  // must not leave the first lock held with nothing pointing at it.
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };

  async function request(): Promise<boolean> {
    if (!nav?.wakeLock) return false;
    if (sentinel) return true;
    try {
      const lock = await nav.wakeLock.request("screen");
      // Released by the browser (page hidden, low battery): forget it so onVisible can ask again.
      lock.addEventListener("release", () => {
        if (sentinel === lock) sentinel = null;
      });
      if (!wanted) {
        // Released while the request was in flight.
        await lock.release().catch(() => undefined);
        return false;
      }
      sentinel = lock;
      return true;
    } catch {
      return false; // refused (battery saver, no permission): the conversation just won't stop the screen sleeping
    }
  }

  return {
    acquire() {
      wanted = true;
      return enqueue(request);
    },
    release() {
      wanted = false;
      return enqueue(async () => {
        const lock = sentinel;
        sentinel = null;
        await lock?.release().catch(() => undefined);
      });
    },
    async onVisible() {
      await enqueue(async () => {
        if (wanted && !sentinel) await request();
      });
    },
    get held() {
      return sentinel !== null;
    },
  };
}
