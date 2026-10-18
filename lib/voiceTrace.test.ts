import { describe, expect, it, vi } from "vitest";
import { MAX_TRACE_EVENTS, createVoiceTrace, traceEnabledFromUrl } from "./voiceTrace";

describe("voice trace", () => {
  it("is on only for ?debug=voice", () => {
    expect(traceEnabledFromUrl("?debug=voice")).toBe(true);
    expect(traceEnabledFromUrl("?a=1&debug=voice")).toBe(true);
    expect(traceEnabledFromUrl("")).toBe(false);
    expect(traceEnabledFromUrl("?debug=other")).toBe(false);
    expect(traceEnabledFromUrl("?debug=")).toBe(false);
  });

  it("when off, records nothing and notifies nobody", () => {
    const trace = createVoiceTrace({ enabled: false });
    const listener = vi.fn();
    trace.subscribe(listener);
    trace.record("ack start");
    expect(trace.events()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("records the time since the turn started, and restarts the clock on a new turn", () => {
    let clock = 1000;
    const trace = createVoiceTrace({ enabled: true, now: () => clock });
    trace.startTurn();
    clock = 1250;
    trace.record("speak start", "kind=answer");
    clock = 2000;
    trace.record("clip 0 end");
    expect(trace.events()).toEqual([
      { at: 250, event: "speak start", detail: "kind=answer" },
      { at: 1000, event: "clip 0 end" },
    ]);
    clock = 5000;
    trace.startTurn();
    clock = 5100;
    trace.record("mic open");
    expect(trace.events().at(-1)).toEqual({ at: 100, event: "mic open" });
  });

  it("keeps only the last 30 events, oldest dropped", () => {
    const trace = createVoiceTrace({ enabled: true, now: () => 0 });
    for (let i = 0; i < 45; i++) trace.record(`event ${i}`);
    expect(trace.events()).toHaveLength(MAX_TRACE_EVENTS);
    expect(trace.events()[0].event).toBe("event 15");
    expect(trace.events().at(-1)?.event).toBe("event 44");
  });

  it("notifies subscribers, gives a new array on every change, and can be cleared", () => {
    const trace = createVoiceTrace({ enabled: true, now: () => 0 });
    const listener = vi.fn();
    const unsubscribe = trace.subscribe(listener);
    const before = trace.events();
    trace.record("a");
    expect(trace.events()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    trace.record("b");
    expect(listener).toHaveBeenCalledTimes(1);
    trace.clear();
    expect(trace.events()).toEqual([]);
  });
});

describe("barge-in trace detail", () => {
  it("shows numbers to three figures and fixed reasons, nothing else", async () => {
    const { formatBargeInDetail } = await import("./voiceTrace");
    expect(formatBargeInDetail({ level: 0.31234, threshold: 0.19512, ratio: 3.9876 })).toBe("level=0.312 threshold=0.195 ratio=3.99");
    expect(formatBargeInDetail({ reason: "no usable speech", consecutive: 2, total: 2 })).toBe("reason=no usable speech consecutive=2 total=2");
    expect(formatBargeInDetail({})).toBe("");
  });

  it("the helpers record nothing when the trace is off", async () => {
    const { traceBargeIn, voiceTrace } = await import("./voiceTrace");
    traceBargeIn("trigger", { level: 0.3 });
    expect(voiceTrace().events()).toEqual([]);
  });
});
