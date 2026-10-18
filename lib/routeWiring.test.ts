/** Agent loop with a scripted model calling a route tool (no network, no real model). */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { scripted, createMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  return { scripted: queue, createMock: vi.fn(async () => ({ choices: [{ message: queue.shift() }] })) };
});
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

import { runAgent } from "./agent";

const toolCall = (name: string, args: object) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const finalText = (content: string) => ({ role: "assistant", content });

type Call = [{ messages: { role: string; content: string }[] }];
const messagesOfCall = (index: number) => (createMock.mock.calls[index] as unknown as Call)[0].messages;

beforeEach(() => {
  scripted.length = 0;
  createMock.mockClear();
});

describe("agent loop with a route tool", () => {
  it("answers 'why did OAK fall' from capacity_trend and surfaces its table, assumptions and caveat", async () => {
    scripted.push(
      toolCall("capacity_trend", { origin: "OAK", group_by: "carrier", top_n: 3 }),
      finalText("Southwest, Spirit and Delta cut the most seats."),
    );
    const res = await runAgent("Why did OAK's traffic fall?");

    expect(res.reply).toBe("Southwest, Spirit and Delta cut the most seats.");
    expect(res.meta?.tools_used).toEqual(["capacity_trend"]);
    expect(res.structured?.kind).toBe("metric");
    expect(res.structured?.caption).toContain("flights from OAK");
    expect(res.structured?.rows[0][0]).toBe("Total");
    expect(res.assumptions?.join(" ")).toMatch(/enplaned passengers per segment/);
    expect(res.uncertainty).toMatch(/underserved/);
    expect(res.uncertainty).toMatch(/not why/);

    // The model saw the capped, aggregated result, not the table payload or raw rows.
    const toolMessage = messagesOfCall(1).find((m) => m.role === "tool")!;
    const seen = JSON.parse(toolMessage.content);
    expect(seen.biggest_cuts.map((c: { key: string }) => c.key)).toEqual(["WN", "NK", "DL"]);
    expect(toolMessage.content.length).toBeLessThan(8_000);
    expect(toolMessage.content).not.toContain(res.structured!.caption!);
  });

  it("returns a validation error to the model for an airport outside the dataset, with no table", async () => {
    scripted.push(toolCall("route_search", { origin: "ZZZ" }), finalText("ZZZ is not in the dataset."));
    const res = await runAgent("Top routes from ZZZ?");
    expect(res.structured).toBeNull();
    const seen = JSON.parse(messagesOfCall(1).find((m) => m.role === "tool")!.content);
    expect(seen.error).toMatch(/not in the dataset/);
  });

  it("tells the model when to use each route tool and never to invent routes, carriers or numbers", async () => {
    scripted.push(finalText("hi"));
    await runAgent("hello");
    const system = messagesOfCall(0)[0].content;
    for (const name of ["route_search", "carrier_share", "capacity_trend", "airport_search"]) expect(system).toContain(name);
    expect(system).toMatch(/NEVER invent routes, carriers or figures/);
    expect(system).toMatch(/destination_words/);
    expect(system).toMatch(/must not call a market underserved/);
    expect(system).toMatch(/user_words/);
  });
});
