import { describe, expect, it } from "vitest";
import { consumeVoiceTurn, markVoiceTurn } from "./voiceTurn";

describe("voice turn marker", () => {
  it("is true once for the spoken question and false afterwards", () => {
    markVoiceTurn("  top airports in LA ");
    expect(consumeVoiceTurn("top airports in LA")).toBe(true);
    expect(consumeVoiceTurn("top airports in LA")).toBe(false);
  });

  it("is false for a typed message that differs from the spoken one", () => {
    markVoiceTurn("top airports in LA");
    expect(consumeVoiceTurn("compare LAX and SNA")).toBe(false);
    expect(consumeVoiceTurn("top airports in LA")).toBe(false);
  });

  it("is false when nothing was spoken", () => {
    expect(consumeVoiceTurn("hello")).toBe(false);
  });
});
