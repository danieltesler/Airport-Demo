import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatModelRunOptions, ThreadMessage } from "@assistant-ui/react";

const player = vi.hoisted(() => ({ speak: vi.fn(), cancel: vi.fn(), autoSpeakAllowed: true }));
vi.mock("./voicePlayback", () => ({ getSpeechPlayer: () => player, warmClipCache: vi.fn(async () => undefined) }));

import { ACK_PHRASES, resetAcknowledgementState } from "./acknowledgement";
import { airportChatAdapter } from "./chatModelAdapter";
import { markVoiceTurn } from "./voiceTurn";

const RANKING_RESPONSE = {
  reply: "Here is the ranking.",
  structured: {
    kind: "ranking",
    columns: ["Rank", "Airport", "Expansion score", "Growth YoY"],
    rows: [[1, "LAX — Los Angeles", 82.4, "4.2%"]],
    caption: "Scope: LA · 3 airports matched · top 1 by expansion score",
  },
  uncertainty: "Score reflects demand-side opportunity only. More.",
};

const userMessage = (text: string): ThreadMessage => ({ role: "user", content: [{ type: "text", text }] }) as unknown as ThreadMessage;
const assistantMessage = (text: string, custom?: Record<string, unknown>): ThreadMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], metadata: { custom } }) as unknown as ThreadMessage;

type RunResult = { content: Array<{ text: string }>; metadata: { custom: { spoken?: string | null; shown?: string | null } } };

function run(text: string, signal = new AbortController().signal, earlier: ThreadMessage[] = []) {
  return airportChatAdapter.run({
    messages: [...earlier, userMessage(text)],
    abortSignal: signal,
  } as unknown as ChatModelRunOptions) as unknown as Promise<RunResult>;
}

function mockChat(body: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  player.speak.mockClear();
  player.cancel.mockClear();
  player.autoSpeakAllowed = true;
  resetAcknowledgementState();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("which line is read aloud", () => {
  it("falls back to the template from the table when the server sent no spoken line", async () => {
    mockChat(RANKING_RESPONSE);
    const result = await run("typed question");
    expect(result.content[0].text).toBe("Here is the ranking.");
    expect(result.metadata.custom.spoken).toBe(
      "In LA, Los Angeles looks strongest for expansion, with traffic up about four percent. Score reflects demand-side opportunity only.",
    );
  });

  it("uses the server's verified spoken line when present, spelled out for the voice", async () => {
    mockChat({ ...RANKING_RESPONSE, spoken: "Sure, Los Angeles stands out. It's near L.A.X. and U.S. hubs" });
    const result = await run("typed question");
    expect(result.metadata.custom.spoken).toBe("Sure, Los Angeles stands out. It's near L A X and U S hubs.");
  });

  it("ignores a blank spoken line and uses the template", async () => {
    mockChat({ ...RANKING_RESPONSE, spoken: "   " });
    expect((await run("q")).metadata.custom.spoken).toContain("Los Angeles looks strongest");
  });

  it("speaks the whole short reply when there is no table and no spoken line", async () => {
    mockChat({ reply: "Hello! I can rank and compare airports. Ask away." });
    markVoiceTurn("hi");
    await run("hi");
    expect(player.speak).toHaveBeenCalledWith("Hello! I can rank and compare airports. Ask away.");
  });

  it("does not speak an error reply", async () => {
    mockChat({ reply: "I hit an error.", error: "agent_error" });
    markVoiceTurn("top airports in LA");
    const result = await run("top airports in LA");
    expect(player.speak).not.toHaveBeenCalled();
    expect(result.metadata.custom.spoken).toBeNull();
  });
});

describe("when it speaks on its own", () => {
  it("speaks the answer to a question that came from the mic", async () => {
    mockChat({ ...RANKING_RESPONSE, spoken: "Sure, Los Angeles stands out." });
    markVoiceTurn("top airports in LA");
    await run("top airports in LA");
    expect(player.speak).toHaveBeenCalledTimes(1);
    expect(player.speak).toHaveBeenCalledWith("Sure, Los Angeles stands out.");
  });

  it("stays silent for typed questions, cancelled turns, and after repeated voice failures", async () => {
    mockChat(RANKING_RESPONSE);
    await run("top airports in LA");
    expect(player.speak).not.toHaveBeenCalled();

    markVoiceTurn("top airports in LA");
    const controller = new AbortController();
    controller.abort();
    await run("top airports in LA", controller.signal);
    expect(player.speak).not.toHaveBeenCalled();

    player.autoSpeakAllowed = false;
    markVoiceTurn("top airports in LA");
    await run("top airports in LA");
    expect(player.speak).not.toHaveBeenCalled();
  });
});

describe("the 'one moment' acknowledgement", () => {
  /** A reply that arrives after `ms` of fake time. */
  function slowChat(ms: number, body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(body))), ms))),
    );
  }

  it("is spoken when the answer is slow, then replaced by the answer", async () => {
    vi.useFakeTimers();
    slowChat(4000, { ...RANKING_RESPONSE, spoken: "Sure, Los Angeles stands out." });
    markVoiceTurn("top airports in LA");
    const pending = run("top airports in LA");

    await vi.advanceTimersByTimeAsync(1499);
    expect(player.speak).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(player.speak).toHaveBeenCalledTimes(1);
    expect(ACK_PHRASES).toContain(player.speak.mock.calls[0][0]);

    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(player.speak).toHaveBeenCalledTimes(2);
    expect(player.speak).toHaveBeenLastCalledWith("Sure, Los Angeles stands out.");
    expect(player.cancel).not.toHaveBeenCalled();
  });

  it("is skipped when the answer arrives first", async () => {
    vi.useFakeTimers();
    slowChat(500, { ...RANKING_RESPONSE, spoken: "Sure, Los Angeles stands out." });
    markVoiceTurn("top airports in LA");
    const pending = run("top airports in LA");
    await vi.advanceTimersByTimeAsync(600);
    await pending;
    await vi.advanceTimersByTimeAsync(5000);
    expect(player.speak).toHaveBeenCalledTimes(1);
    expect(player.speak).toHaveBeenCalledWith("Sure, Los Angeles stands out.");
  });

  it("is cut off, not left hanging, when no answer follows it", async () => {
    vi.useFakeTimers();
    slowChat(3000, { reply: "I hit an error.", error: "agent_error" });
    markVoiceTurn("top airports in LA");
    const pending = run("top airports in LA");
    await vi.advanceTimersByTimeAsync(3100);
    await pending;
    expect(player.speak).toHaveBeenCalledTimes(1);
    expect(player.cancel).toHaveBeenCalledTimes(1);
  });

  it("is never used for a typed question", async () => {
    vi.useFakeTimers();
    slowChat(4000, RANKING_RESPONSE);
    const pending = run("typed");
    await vi.advanceTimersByTimeAsync(4100);
    await pending;
    expect(player.speak).not.toHaveBeenCalled();
  });
});

describe("history carries the 'shown on screen' note", () => {
  it("sends each answer's note back with the assistant turn and keeps the new note in the extras", async () => {
    const fetchMock = mockChat({ ...RANKING_RESPONSE, shown: "Table (ranking): Rows in order: 1 LAX — Los Angeles." });
    const earlier = [
      userMessage("rank LA"),
      assistantMessage("Los Angeles leads.", { shown: "Table (ranking): Rows in order: 1 BOS — Boston; 2 EWR — Newark." }),
      assistantMessage("A greeting.", { shown: null }),
    ];
    const result = await run("what about the second one?", new AbortController().signal, earlier);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("what about the second one?");
    expect(body.history).toEqual([
      { role: "user", content: "rank LA" },
      { role: "assistant", content: "Los Angeles leads.", shown: "Table (ranking): Rows in order: 1 BOS — Boston; 2 EWR — Newark." },
      { role: "assistant", content: "A greeting." },
    ]);
    expect(result.metadata.custom.shown).toBe("Table (ranking): Rows in order: 1 LAX — Los Angeles.");
  });

  it("works against a server that sends no note", async () => {
    mockChat(RANKING_RESPONSE);
    const result = await run("q");
    expect(result.metadata.custom.shown).toBeNull();
  });
});
