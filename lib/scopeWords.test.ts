import { describe, expect, it } from "vitest";
import { resolveToolScope } from "./toolScope";

const codes = (r: ReturnType<typeof resolveToolScope>): string[] => r.airports.map((a) => a.iata).sort();

describe("a scope the model settled on is not widened by the user's wider words", () => {
  // The first and third place have no covered airport within 50 miles: that is the honest answer.
  const repros: [string, string, string[], string][] = [
    ["near Springfield, IL", "Illinois", [], "empty"],
    ["near Kansas City, MO", "Missouri", ["MCI"], "matched"],
    ["near Columbia, SC", "South Carolina", [], "empty"],
  ];
  for (const [scope, words, expected, status] of repros) {
    it(`'${scope}' with user_words '${words}' stays the narrower area (${status})`, () => {
      const kept = resolveToolScope(scope, words);
      const wide = resolveToolScope(words);
      expect(kept.status).toBe(status);
      expect(codes(kept)).toEqual(expected);
      expect(wide.airports.length).toBeGreaterThan(expected.length);
      expect(kept.label).not.toBe(wide.label);
      expect(kept.notes.join(" ")).toContain("narrower scope was kept");
      expect(kept.notes.join(" ")).not.toContain(`Describe the area as ${wide.label}`);
    });
  }

  it("still prefers the user's words when the passed scope is a rewrite, not a point inside it", () => {
    expect(resolveToolScope("new england", "northeast").label).toBe("Northeast");
    expect(resolveToolScope("California", "Texas").label).toBe("Texas"); // not contained: words win
    expect(resolveToolScope("near Boston", "Texas").label).toBe("Texas");
  });

  it("uses the user's words when the passed scope is unknown", () => {
    expect(resolveToolScope("nowhereville", "Illinois").label).toBe("Illinois");
  });
});

describe("scope wording the docs promise", () => {
  const label = (words: string) => resolveToolScope(undefined, words);

  it("ignores trailing punctuation and diacritics", () => {
    expect(label("Texas?").resolvedAs).toBe("state");
    expect(label("Texas ?! ").label).toBe("Texas");
    expect(label("near San José").status).not.toBe("unknown");
    expect(label("near San José").label).toMatch(/San Jose/);
  });

  it("reads 'airport' and 'area' suffixes after a radius anchor", () => {
    expect(label("near JFK airport").status).toBe("matched");
    expect(codes(label("near JFK airport"))).toContain("JFK");
    expect(label("near Boston area").status).toBe("matched");
    expect(codes(label("near Boston area"))).toContain("BOS");
    expect(label("near Bay Area").label).toMatch(/Bay Area/); // the alias is still found as typed
  });

  it("keeps trying trimmed phrases after an unknown radius request", () => {
    // The radius reading of the whole phrase is unknown; its leading phrase "near Boston" is not.
    const r = label("near Boston including New York");
    expect(r.status).toBe("matched");
    expect(r.reinterpreted).toBe(true);
    expect(codes(r)).toContain("BOS");
  });

  it("still reports an invalid radius as unknown, with its explanation", () => {
    const r = label("within 99999 miles of Boston");
    expect(r.status).toBe("unknown");
    expect(r.notes.join(" ")).toMatch(/radius must be greater than 0/);
  });
});
