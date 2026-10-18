import { describe, expect, it } from "vitest";
import { DATA_DISCLOSURE } from "./disclosure";

describe("data disclosure wording", () => {
  it("names both providers, both kinds of input, and the no-storage claim", () => {
    expect(DATA_DISCLOSURE).toMatch(/questions and voice recordings/);
    expect(DATA_DISCLOSURE).toMatch(/OpenAI and ElevenLabs/);
    expect(DATA_DISCLOSURE).toMatch(/nothing is stored by this demo/);
  });
});
