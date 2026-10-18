import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { runTool } from "../../../lib/tools";
import { FIXTURE_CASES, fixturePath, loadFixture } from "./cases";

const record = process.env.RECORD_FIXTURES === "1";

describe("recorded tool outputs", () => {
  for (const c of FIXTURE_CASES) {
    it(`${c.name} matches what the tool returns now`, async () => {
      // JSON round trip so undefined fields compare the way they were stored.
      const output = JSON.parse(JSON.stringify(await runTool(c.tool, c.args)));
      if (record) fs.writeFileSync(fixturePath(c.name), JSON.stringify({ tool: c.tool, args: c.args, output }, null, 2) + "\n");
      expect(loadFixture(c.name)).toEqual({ tool: c.tool, args: c.args, output });
    });
  }

  it("covers a table, a refusal, an ambiguity and a no-service result", () => {
    const outputs = FIXTURE_CASES.map((c) => loadFixture(c.name).output);
    expect(outputs.some((o) => o.structured)).toBe(true);
    expect(outputs.some((o) => o.result.status === "ambiguous")).toBe(true);
    expect(outputs.some((o) => o.result.status === "unknown")).toBe(true);
    expect(outputs.some((o) => o.result.no_service === true)).toBe(true);
    expect(FIXTURE_CASES.length).toBeGreaterThanOrEqual(10);
  });
});
