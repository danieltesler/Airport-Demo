import { describe, expect, it } from "vitest";
import type { StructuredResult } from "@/lib/types";
import { buildChart, columnKind, columnKinds, displayCell, unscoredLabels } from "./tableModel";

const ranking: StructuredResult = {
  kind: "ranking",
  columns: ["Rank", "Airport", "Expansion score", "Growth YoY", "Avg delay (min)"],
  rows: [
    [1, "BOS — Boston", 63.8, "7.1%", 15.5],
    [2, "PVD — Providence", 48.4, "6.1%", 12.5],
  ],
};

const comparison: StructuredResult = {
  kind: "comparison",
  columns: ["Airport", "Congestion score", "Avg delay (min)", "Cancel rate"],
  rows: [
    ["LAX — Los Angeles", 59.4, 14.2, "1.5%"],
    ["SNA — Santa Ana", "insufficient data", 8.1, "0.9%"],
  ],
};

describe("columnKind", () => {
  it("aligns by cell type, not index: Airport is text, Rank and scores are numbers", () => {
    expect(ranking.columns.map((_, i) => columnKind(ranking.rows, i))).toEqual([
      "number",
      "text",
      "number",
      "percent",
      "number",
    ]);
  });

  it("ignores missing placeholders when deciding a column's kind", () => {
    expect(columnKind(comparison.rows, 1)).toBe("number");
    expect(columnKind([["a", "n/a"], ["b", "n/a"]], 1)).toBe("text");
  });
});

describe("numeric placeholders", () => {
  it("keeps a percent column right-aligned when some rows say new or ended", () => {
    const rows = [["LAX", "+4.2%"], ["MIA", "new"], ["ORD", "ended"], ["SFO", "-1.0%"]];
    expect(columnKind(rows, 1)).toBe("percent");
    expect(columnKind([["a", 3], ["b", "new"], ["c", "n/a"]], 1)).toBe("number");
  });

  it("keeps the declared score column numeric even when every cell is insufficient data", () => {
    const columns = ["Airport", "Congestion score"];
    const rows = [["SNA", "insufficient data"], ["ANC", "insufficient data"]];
    expect(columnKinds(columns, rows)).toEqual(["text", "number"]);
  });
});

describe("buildChart", () => {
  it("charts the declared score column, labelled by the airport", () => {
    const chart = buildChart(ranking)!;
    expect(chart.measureLabel).toBe("Expansion score");
    expect(chart.bars.map((b) => b.label)).toEqual(["BOS — Boston", "PVD — Providence"]);
    expect(chart.bars[0].widthPct).toBe(100);
  });

  it("skips a row with insufficient data instead of charting another column", () => {
    const chart = buildChart(comparison)!;
    expect(chart.measureLabel).toBe("Congestion score");
    expect(chart.bars).toHaveLength(1);
    expect(chart.skippedLabels).toEqual(["SNA — Santa Ana"]);
  });

  it("draws nothing without a score column, for metric tables, or when nothing is scored", () => {
    const shares: StructuredResult = { kind: "ranking", columns: ["Carrier", "Share"], rows: [["AA", "21%"]] };
    expect(buildChart(shares)).toBeNull();
    expect(buildChart({ ...ranking, kind: "metric" })).toBeNull();
    const none = { ...comparison, rows: [["SNA", "insufficient data", 8.1, "0.9%"]] };
    expect(buildChart(none)).toBeNull();
  });
});

describe("displayCell", () => {
  it("never prints null or NaN", () => {
    expect(displayCell(null, "Congestion score", true)).toBe("insufficient data");
    expect(displayCell(Number.NaN, "Avg delay", false)).toBe("n/a");
  });

  it("signs positive deltas only in change-like columns", () => {
    expect(displayCell(3.25, "Seats change", false)).toBe("+3.25");
    expect(displayCell(-3.25, "Seats change", false)).toBe("-3.25");
    expect(displayCell(3.25, "Avg delay", false)).toBe("3.25");
  });
});

describe("unscoredLabels", () => {
  it("lists airports without a score", () => {
    expect(unscoredLabels(comparison)).toEqual(["SNA — Santa Ana"]);
    expect(unscoredLabels(ranking)).toEqual([]);
  });
});
