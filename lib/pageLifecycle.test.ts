import { describe, expect, it, vi } from "vitest";
import { watchPageLifecycle, type LifecycleDocument, type LifecycleTarget } from "./pageLifecycle";

class FakeTarget implements LifecycleTarget {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, listener: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: () => void) {
    this.listeners.get(type)?.delete(listener);
  }
  fire(type: string) {
    this.listeners.get(type)?.forEach((listener) => listener());
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeDocument extends FakeTarget implements LifecycleDocument {
  visibilityState = "visible";
}

function setup() {
  const doc = new FakeDocument();
  const win = new FakeTarget();
  const onHidden = vi.fn();
  const onVisible = vi.fn();
  const stop = watchPageLifecycle({ document: doc, window: win, onHidden, onVisible });
  return { doc, win, onHidden, onVisible, stop };
}

describe("watchPageLifecycle", () => {
  it("visibilitychange pauses when the page is hidden and only wakes when it is visible again", () => {
    const { doc, onHidden, onVisible } = setup();
    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(onVisible).not.toHaveBeenCalled();

    doc.visibilityState = "visible";
    doc.fire("visibilitychange");
    expect(onVisible).toHaveBeenCalledTimes(1);
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("pagehide pauses whatever visibilityState says (it can still read 'visible' as the page leaves)", () => {
    const { win, doc, onHidden } = setup();
    doc.visibilityState = "visible";
    win.fire("pagehide");
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("Chrome Android's freeze pauses even though visibilitychange never fired, and resume wakes", () => {
    const { doc, onHidden, onVisible } = setup();
    doc.fire("freeze");
    expect(onHidden).toHaveBeenCalledTimes(1);
    doc.fire("resume");
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it("stopping removes every listener", () => {
    const { doc, win, stop, onHidden, onVisible } = setup();
    stop();
    for (const type of ["visibilitychange", "freeze", "resume"]) expect(doc.count(type)).toBe(0);
    expect(win.count("pagehide")).toBe(0);
    doc.fire("freeze");
    win.fire("pagehide");
    doc.fire("resume");
    expect(onHidden).not.toHaveBeenCalled();
    expect(onVisible).not.toHaveBeenCalled();
  });
});

describe("a conversation pausing from a page lifecycle event releases the wake lock", () => {
  it("freeze and pagehide drive controller.hidden(), which pauses and releases the lock", async () => {
    const { ConversationController } = await import("./conversation");
    const ports = {
      openSession: vi.fn(async () => "ok" as const),
      closeSession: vi.fn(),
      audioReady: vi.fn(async () => true),
      listen: vi.fn(),
      stopListening: vi.fn(),
      finishListening: vi.fn(),
      send: vi.fn(),
      cancelSpeech: vi.fn(),
      wakeLock: { acquire: vi.fn(async () => true), release: vi.fn(async () => undefined) },
    };
    for (const event of ["freeze", "pagehide"] as const) {
      const controller = new ConversationController(ports);
      await controller.start();
      const doc = new FakeDocument();
      const win = new FakeTarget();
      ports.wakeLock.release.mockClear();
      watchPageLifecycle({ document: doc, window: win, onHidden: () => controller.hidden(), onVisible: () => undefined });
      (event === "freeze" ? doc : win).fire(event);
      expect(controller.getSnapshot()).toMatchObject({ phase: "paused", pauseReason: "hidden" });
      expect(ports.wakeLock.release).toHaveBeenCalled();
      expect(ports.closeSession).toHaveBeenCalled();
    }
  });
});
