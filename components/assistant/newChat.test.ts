import { describe, expect, it, vi } from "vitest";
import { startNewChat, threadWasCleared } from "./newChat";

function fakeThread(isRunning: boolean) {
  const calls: string[] = [];
  return {
    calls,
    thread: {
      getState: () => ({ isRunning }),
      cancelRun: vi.fn(() => calls.push("cancelRun")),
      reset: vi.fn(() => calls.push("reset")),
    },
  };
}

describe("startNewChat", () => {
  it("resets an idle thread without cancelling anything", () => {
    const { thread } = fakeThread(false);
    const stopSpeech = vi.fn();
    startNewChat(thread, stopSpeech);
    expect(thread.cancelRun).not.toHaveBeenCalled();
    expect(thread.reset).toHaveBeenCalledOnce();
    expect(stopSpeech).toHaveBeenCalledOnce();
  });

  it("cancels a running answer before it resets, and stops speech", () => {
    const { thread, calls } = fakeThread(true);
    const stopSpeech = vi.fn(() => calls.push("stopSpeech"));
    startNewChat(thread, stopSpeech);
    expect(calls).toEqual(["cancelRun", "stopSpeech", "reset"]);
  });
});

describe("threadWasCleared", () => {
  it("is true only when messages went from some to none", () => {
    expect(threadWasCleared(2, 0)).toBe(true);
    expect(threadWasCleared(0, 0)).toBe(false);
    expect(threadWasCleared(0, 1)).toBe(false);
    expect(threadWasCleared(3, 2)).toBe(false);
  });
});
