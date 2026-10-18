/** The agent with the REAL spoken-line guard (only the model is mocked). */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { scripted, createMock } = vi.hoisted(() => {
  const queue: unknown[] = [];
  return { scripted: queue, createMock: vi.fn(async (_args?: unknown) => ({ choices: [{ message: queue.shift() }] })) };
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
const finalJson = (reply: string, spoken: string) => ({ role: "assistant", content: JSON.stringify({ reply, spoken }) });

beforeEach(() => {
  scripted.length = 0;
  createMock.mockClear();
});

describe("agent with the real guard", () => {
  it("returns a grounded spoken line", async () => {
    scripted.push(
      toolCall("compare_airports", { iatas: ["LAX", "SNA"], metric: "congestion" }),
      finalJson("**Santa Ana** is more congested than LAX.", "Santa Ana is more congested than LAX."),
    );
    const res = await runAgent("Compare LAX and SNA congestion");
    // Codes are replaced by city names so a voice does not spell them out.
    expect(res.spoken).toBe("Santa Ana is more congested than Los Angeles.");
    expect(res.meta?.spoken_source).toBe("model");
  });

  it("withholds a spoken line with an invented figure and counts the rejection", async () => {
    scripted.push(
      toolCall("compare_airports", { iatas: ["LAX", "SNA"], metric: "congestion" }),
      finalJson("Santa Ana leads.", "Santa Ana handles about forty million passengers a year."),
    );
    const res = await runAgent("Compare LAX and SNA congestion");
    expect(res.spoken).toBeUndefined();
    expect(res.meta?.spoken_source).toBe("template");
    expect(res.meta?.spoken_guard_rejections).toBeGreaterThan(0);
  });

  it("withholds a spoken population when the Census tool is not configured", async () => {
    const saved = process.env.CENSUS_API_KEY;
    delete process.env.CENSUS_API_KEY;
    try {
      scripted.push(
        toolCall("metro_population", { iata: "SEA" }),
        finalJson("I can't look up Seattle's population here.", "Seattle has about four million people."),
      );
      const res = await runAgent("How many people live around SEA?");
      expect(res.spoken).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.CENSUS_API_KEY = saved;
    }
  });
});
