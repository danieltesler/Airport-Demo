import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACK_DELAY_MS, ACK_PHRASES, pickAcknowledgement, resetAcknowledgementState, scheduleAcknowledgement, warmAcknowledgements } from "./acknowledgement";
import { clearWarmClips, fetchClipFromApi, warmClipCache } from "./voicePlayback";

beforeEach(resetAcknowledgementState);
afterEach(() => {
  vi.useRealTimers();
  clearWarmClips();
});

describe("pickAcknowledgement", () => {
  it("never repeats the previous phrase, whatever the random draw", () => {
    const first = pickAcknowledgement(() => 0);
    const second = pickAcknowledgement(() => 0);
    expect(second).not.toBe(first);
    for (let i = 0; i < 50; i++) {
      const before = pickAcknowledgement(() => 0.5);
      expect(pickAcknowledgement(() => 0.5)).not.toBe(before);
    }
  });

  it("only ever returns one of the fixed phrases", () => {
    for (let i = 0; i < 20; i++) expect(ACK_PHRASES).toContain(pickAcknowledgement());
  });
});

describe("scheduleAcknowledgement", () => {
  it("speaks after the delay and reports that it did", () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    const pending = scheduleAcknowledgement(speak);
    vi.advanceTimersByTime(ACK_DELAY_MS - 1);
    expect(speak).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(pending.stop()).toBe(true);
  });

  it("is silent if stopped before the delay", () => {
    vi.useFakeTimers();
    const speak = vi.fn();
    const pending = scheduleAcknowledgement(speak);
    expect(pending.stop()).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(speak).not.toHaveBeenCalled();
  });
});

describe("warming the clips", () => {
  it("fetches each phrase once, through the normal TTS request, and ignores a failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Blob(["a"])))
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => new Response(new Blob(["c"])));
    await warmClipCache(ACK_PHRASES, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(ACK_PHRASES.length);
    for (const call of fetchImpl.mock.calls) expect(call[0]).toBe("/api/tts");

    // Only the failed one is fetched again.
    fetchImpl.mockClear();
    fetchImpl.mockImplementation(async () => new Response(new Blob(["d"])));
    await warmClipCache(ACK_PHRASES, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("warmAcknowledgements runs only once per page", () => {
    const fetchSpy = vi.fn(async () => new Response(new Blob(["x"])));
    vi.stubGlobal("fetch", fetchSpy);
    warmAcknowledgements();
    warmAcknowledgements();
    expect(fetchSpy).toHaveBeenCalledTimes(ACK_PHRASES.length);
    vi.unstubAllGlobals();
  });

  it("fetchClipFromApi is the request used", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Blob(["x"])));
    await fetchClipFromApi("Hi there", new AbortController().signal, fetchImpl as unknown as typeof fetch);
    expect(JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ text: "Hi there" });
  });
});
