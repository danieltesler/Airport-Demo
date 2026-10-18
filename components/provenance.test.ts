import { describe, expect, it } from "vitest";
import { hasPanelContent, vintageLine } from "./provenance";

describe("vintageLine", () => {
  it("labels a dataset vintage once", () => {
    expect(vintageLine("BTS T-100 2025", "Data vintage")).toBe("Data vintage: BTS T-100 2025");
  });

  it("does not add a second label to live or mixed footers", () => {
    const live = "Live data: FAA NAS Status · retrieved 2026-10-18 14:32 UTC";
    expect(vintageLine(live, "Data vintage")).toBe(live);
    const mixed = `Dataset: BTS 2025 | ${live}`;
    expect(vintageLine(mixed, "Data vintage")).toBe(mixed);
  });
});

describe("hasPanelContent", () => {
  it("is false for a clarifying turn with nothing but provenance", () => {
    expect(hasPanelContent([], null)).toBe(false);
    expect(hasPanelContent(null, "  ")).toBe(false);
  });
  it("is true with assumptions or an uncertainty note", () => {
    expect(hasPanelContent(["a"], null)).toBe(true);
    expect(hasPanelContent(undefined, "caveat")).toBe(true);
  });
});
