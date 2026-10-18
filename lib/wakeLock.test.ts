import { describe, expect, it, vi } from "vitest";
import { createScreenWakeLock, type NavigatorWithWakeLock, type WakeLockSentinelLike } from "./wakeLock";

function fakeSentinel() {
  let onRelease: (() => void) | null = null;
  const sentinel: WakeLockSentinelLike & { fireBrowserRelease(): void; released: number } = {
    released: 0,
    release: vi.fn(async () => {
      sentinel.released += 1;
    }),
    addEventListener: (_type, listener) => {
      onRelease = listener;
    },
    fireBrowserRelease: () => onRelease?.(),
  };
  return sentinel;
}

function fakeNavigator(options: { reject?: boolean } = {}) {
  const sentinels: ReturnType<typeof fakeSentinel>[] = [];
  const request = vi.fn(async (_type: "screen") => {
    if (options.reject) throw new DOMException("not allowed", "NotAllowedError");
    const sentinel = fakeSentinel();
    sentinels.push(sentinel);
    return sentinel;
  });
  return { nav: { wakeLock: { request } } as NavigatorWithWakeLock, request, sentinels };
}

describe("screen wake lock", () => {
  it("is held after acquire and released on release", async () => {
    const { nav, request, sentinels } = fakeNavigator();
    const lock = createScreenWakeLock(nav);
    expect(await lock.acquire()).toBe(true);
    expect(lock.held).toBe(true);
    expect(request).toHaveBeenCalledWith("screen");

    await lock.release();
    expect(lock.held).toBe(false);
    expect(sentinels[0].released).toBe(1);
  });

  it("asking twice holds one lock", async () => {
    const { nav, request } = fakeNavigator();
    const lock = createScreenWakeLock(nav);
    await lock.acquire();
    await lock.acquire();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports false, without throwing, where the API is missing", async () => {
    const lock = createScreenWakeLock({});
    expect(await lock.acquire()).toBe(false);
    expect(lock.held).toBe(false);
    await expect(lock.release()).resolves.toBeUndefined();
    await expect(lock.onVisible()).resolves.toBeUndefined();
  });

  it("reports false when the browser refuses (battery saver, permissions)", async () => {
    const { nav } = fakeNavigator({ reject: true });
    const lock = createScreenWakeLock(nav);
    expect(await lock.acquire()).toBe(false);
    expect(lock.held).toBe(false);
  });

  it("takes the lock again when the page becomes visible after the browser dropped it", async () => {
    const { nav, request, sentinels } = fakeNavigator();
    const lock = createScreenWakeLock(nav);
    await lock.acquire();
    sentinels[0].fireBrowserRelease(); // the page was hidden: the browser released it
    expect(lock.held).toBe(false);

    await lock.onVisible();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);
  });

  it("does not take the lock again after End", async () => {
    const { nav, request, sentinels } = fakeNavigator();
    const lock = createScreenWakeLock(nav);
    await lock.acquire();
    sentinels[0].fireBrowserRelease();
    await lock.release();
    await lock.onVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });

  it("releases a lock granted after End was pressed while the request was in flight", async () => {
    let grant: (sentinel: WakeLockSentinelLike) => void = () => undefined;
    let requested = false;
    const late = fakeSentinel();
    const nav: NavigatorWithWakeLock = {
      wakeLock: {
        request: () =>
          new Promise<WakeLockSentinelLike>((resolve) => {
            requested = true;
            grant = resolve;
          }),
      },
    };
    const lock = createScreenWakeLock(nav);
    const pending = lock.acquire();
    const releasing = lock.release(); // runs after the request settles
    await vi.waitFor(() => expect(requested).toBe(true));
    grant(late);
    expect(await pending).toBe(false);
    await releasing;
    expect(late.released).toBe(1);
    expect(lock.held).toBe(false);
  });

  it("ignores a release failure", async () => {
    const { nav, sentinels } = fakeNavigator();
    const lock = createScreenWakeLock(nav);
    await lock.acquire();
    sentinels[0].release = vi.fn(async () => {
      throw new Error("already released");
    });
    await expect(lock.release()).resolves.toBeUndefined();
  });

  it("acquire, release, acquire in quick succession ends with exactly one lock held and none leaked", async () => {
    const sentinels: ReturnType<typeof fakeSentinel>[] = [];
    const grants: Array<() => void> = [];
    const nav: NavigatorWithWakeLock = {
      wakeLock: {
        request: () =>
          new Promise<WakeLockSentinelLike>((resolve) => {
            const sentinel = fakeSentinel();
            sentinels.push(sentinel);
            grants.push(() => resolve(sentinel));
          }),
      },
    };
    const lock = createScreenWakeLock(nav);
    const first = lock.acquire();
    const released = lock.release();
    const second = lock.acquire();

    await vi.waitFor(() => expect(grants).toHaveLength(1));
    grants[0]();
    await first;
    await vi.waitFor(() => expect(grants).toHaveLength(2)); // the second request starts only after the first settled
    grants[1]();
    await Promise.all([released, second]);

    expect(sentinels).toHaveLength(2);
    expect(sentinels[0].released).toBe(1); // the first lock was let go
    expect(sentinels[1].released).toBe(0); // the second is the one held
    expect(lock.held).toBe(true);
  });

  it("release, acquire, release in quick succession ends with nothing held", async () => {
    const { nav, sentinels } = fakeNavigator();
    const lock = createScreenWakeLock(nav);
    await lock.acquire();
    const operations = [lock.release(), lock.acquire(), lock.release()];
    await Promise.all(operations);
    expect(lock.held).toBe(false);
    expect(sentinels.every((sentinel) => sentinel.released === 1)).toBe(true);
  });
});
