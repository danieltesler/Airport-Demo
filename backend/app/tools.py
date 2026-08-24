"""Agent tools: the bridge between the LLM and the deterministic engine.

Each tool is a small, well-typed function that pulls data (data.py) and runs
scoring (scoring.py). The LLM may only obtain numbers by calling these tools —
it never invents figures. Every tool returns a `ToolOutput` carrying:

  * result       — compact JSON the LLM reads to write its answer
  * structured   — optional table/chart payload for the UI (per the API contract)
  * assumptions  — the deterministic assumptions behind the numbers
  * uncertainty  — honest caveats to surface to the user

`TOOL_SCHEMAS` is the Anthropic tool-definition list; `run_tool` dispatches a
call by name.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import data, scoring


@dataclass
class ToolOutput:
    result: dict[str, Any]
    structured: dict[str, Any] | None = None
    assumptions: list[str] = field(default_factory=list)
    uncertainty: str | None = None


# --------------------------------------------------------------------------- #
# Tool implementations
# --------------------------------------------------------------------------- #

def _score_columns(metric: str) -> str:
    return {
        "congestion": "Congestion score",
        "unmet_demand": "Unmet-demand score",
        "expansion": "Expansion score",
    }[metric]


def _unknown(iata: str) -> ToolOutput:
    return ToolOutput(
        result={
            "error": f"'{iata}' is not in the dataset.",
            "known_airports": data.known_iatas(),
        }
    )


def list_airports(scope: str | None = None, states: list[str] | None = None) -> ToolOutput:
    airports = data.airports_in_scope(scope, states)
    rows = [
        {"iata": a["iata"], "name": a["name"], "city": a["city"], "state": a["state"]}
        for a in airports
    ]
    return ToolOutput(
        result={"count": len(rows), "airports": rows, "scope": scope or "all"},
        assumptions=[f"Dataset scope is limited to {len(data.all_airports())} U.S. airports."],
    )


def airport_profile(iata: str) -> ToolOutput:
    airport = data.get_airport(iata)
    if not airport:
        return _unknown(iata)

    congestion = scoring.congestion_score(airport)
    unmet = scoring.unmet_demand_score(airport)
    expansion = scoring.expansion_score(airport)

    return ToolOutput(
        result={
            "iata": airport["iata"],
            "name": airport["name"],
            "city": airport["city"],
            "state": airport["state"],
            "metrics": {
                "annual_passengers": airport["annual_passengers"],
                "pax_growth_yoy": airport["pax_growth_yoy"],
                "load_factor": airport["load_factor"],
                "avg_dep_delay_min": airport["avg_dep_delay_min"],
                "delayed_share": airport["delayed_share"],
                "cancel_rate": airport["cancel_rate"],
                "annual_departures": airport["annual_departures"],
                "runways": airport["runways"],
            },
            "haul_mix_pct": scoring.haul_breakdown(airport),
            "scores": {
                "congestion": congestion.as_dict(),
                "unmet_demand": unmet.as_dict(),
                "expansion": expansion.as_dict(),
            },
        },
        assumptions=scoring.EXPANSION_ASSUMPTIONS[:1],
    )


def rank_airports(scope: str | None = "all", metric: str = "expansion", top_n: int = 5) -> ToolOutput:
    if metric not in scoring.METRIC_SCORERS:
        return ToolOutput(result={"error": f"Unknown metric '{metric}'.",
                                  "valid_metrics": list(scoring.METRIC_SCORERS)})

    airports = data.airports_in_scope(scope)
    if not airports:
        return ToolOutput(result={"error": f"No airports found for scope '{scope}'."})

    scorer = scoring.METRIC_SCORERS[metric]
    ranked = sorted(
        ((a, scorer(a)) for a in airports),
        key=lambda pair: pair[1].score,
        reverse=True,
    )[:max(1, top_n)]

    columns = ["Rank", "Airport", _score_columns(metric), "Growth YoY", "Load factor", "Avg delay (min)"]
    rows = [
        [
            i + 1,
            f'{a["iata"]} — {a["city"]}',
            round(res.score, 1),
            f'{a["pax_growth_yoy"] * 100:.1f}%',
            round(a["load_factor"], 2),
            a["avg_dep_delay_min"],
        ]
        for i, (a, res) in enumerate(ranked)
    ]

    sample = scorer(ranked[0][0])
    return ToolOutput(
        result={
            "metric": metric,
            "scope": scope,
            "ranking": [
                {"iata": a["iata"], "city": a["city"], "score": round(res.score, 1),
                 "components": res.as_dict()["components"]}
                for a, res in ranked
            ],
        },
        structured={"kind": "ranking", "columns": columns, "rows": rows},
        assumptions=sample.assumptions,
        uncertainty=sample.uncertainty,
    )


def compare_airports(iatas: list[str], metric: str = "congestion") -> ToolOutput:
    if metric not in scoring.METRIC_SCORERS:
        return ToolOutput(result={"error": f"Unknown metric '{metric}'.",
                                  "valid_metrics": list(scoring.METRIC_SCORERS)})

    resolved = [(code, data.get_airport(code)) for code in iatas]
    missing = [code for code, a in resolved if a is None]
    if missing:
        return ToolOutput(result={"error": f"Unknown airport(s): {', '.join(missing)}.",
                                  "known_airports": data.known_iatas()})

    scorer = scoring.METRIC_SCORERS[metric]
    scored = [(a, scorer(a)) for _, a in resolved]

    columns = ["Airport", _score_columns(metric), "Avg delay (min)", "Delayed >15m", "Load factor", "Cancel rate"]
    rows = [
        [
            f'{a["iata"]} — {a["city"]}',
            round(res.score, 1),
            a["avg_dep_delay_min"],
            f'{a["delayed_share"] * 100:.0f}%',
            round(a["load_factor"], 2),
            f'{a["cancel_rate"] * 100:.1f}%',
        ]
        for a, res in scored
    ]

    return ToolOutput(
        result={
            "metric": metric,
            "comparison": [
                {"iata": a["iata"], "score": round(res.score, 1),
                 "components": res.as_dict()["components"]}
                for a, res in scored
            ],
        },
        structured={"kind": "comparison", "columns": columns, "rows": rows},
        assumptions=scored[0][1].assumptions,
        uncertainty=scored[0][1].uncertainty,
    )


def long_haul_breakdown(iata: str) -> ToolOutput:
    airport = data.get_airport(iata)
    if not airport:
        return _unknown(iata)

    mix = scoring.haul_breakdown(airport)
    thresholds = data.haul_thresholds()
    columns = ["Haul type", "Share of departures"]
    rows = [
        [f'Short (<{thresholds["short_max"]} mi)', f'{mix["short"]}%'],
        [f'Medium ({thresholds["short_max"]}-{thresholds["long_min"]} mi)', f'{mix["medium"]}%'],
        [f'Long (>{thresholds["long_min"]} mi)', f'{mix["long"]}%'],
    ]
    return ToolOutput(
        result={"iata": airport["iata"], "name": airport["name"], "haul_mix_pct": mix,
                "thresholds_miles": thresholds},
        structured={"kind": "breakdown", "columns": columns, "rows": rows},
        assumptions=[
            "Haul class is by great-circle route distance from T-100 segment data: "
            f'short <{thresholds["short_max"]} mi, medium {thresholds["short_max"]}-'
            f'{thresholds["long_min"]} mi, long >{thresholds["long_min"]} mi.',
            "Percentages are shares of departures performed, not passengers or seats.",
        ],
    )


def unmet_demand(iata: str) -> ToolOutput:
    airport = data.get_airport(iata)
    if not airport:
        return _unknown(iata)

    res = scoring.unmet_demand_score(airport)
    comp = res.as_dict()["components"]
    columns = ["Driver", "Contribution (0-1)"]
    rows = [
        ["Load-factor pressure", comp["load_pressure"]],
        ["Congestion (delay/throughput)", comp["congestion"]],
        ["Growth vs. capacity", comp["growth_vs_capacity"]],
    ]
    return ToolOutput(
        result={
            "iata": airport["iata"],
            "name": airport["name"],
            "unmet_demand_score": round(res.score, 1),
            "drivers": comp,
            "context": {
                "load_factor": airport["load_factor"],
                "pax_growth_yoy": airport["pax_growth_yoy"],
                "runways": airport["runways"],
                "avg_dep_delay_min": airport["avg_dep_delay_min"],
            },
        },
        structured={"kind": "metric", "columns": columns, "rows": rows},
        assumptions=res.assumptions,
        uncertainty=res.uncertainty,
    )


# --------------------------------------------------------------------------- #
# Dispatch + schemas
# --------------------------------------------------------------------------- #

_DISPATCH = {
    "list_airports": list_airports,
    "airport_profile": airport_profile,
    "rank_airports": rank_airports,
    "compare_airports": compare_airports,
    "long_haul_breakdown": long_haul_breakdown,
    "unmet_demand": unmet_demand,
}


def run_tool(name: str, tool_input: dict[str, Any]) -> ToolOutput:
    """Execute a tool by name with the LLM-supplied arguments."""
    func = _DISPATCH.get(name)
    if not func:
        return ToolOutput(result={"error": f"Unknown tool '{name}'."})
    try:
        return func(**tool_input)
    except TypeError as exc:
        return ToolOutput(result={"error": f"Bad arguments for '{name}': {exc}"})


TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "list_airports",
        "description": "List airports available in the dataset, optionally filtered by "
                       "scope ('new_england', 'all', or a 2-letter state code) or an explicit "
                       "list of state codes. Use this to discover which airports exist before ranking.",
        "input_schema": {
            "type": "object",
            "properties": {
                "scope": {"type": "string", "description": "'new_england', 'all', or a state code like 'CA'."},
                "states": {"type": "array", "items": {"type": "string"}, "description": "Explicit state codes; overrides scope."},
            },
        },
    },
    {
        "name": "airport_profile",
        "description": "Full metric profile for one airport by IATA code (e.g. 'SFO'): traffic, "
                       "delays, load factor, haul mix, and all deterministic scores.",
        "input_schema": {
            "type": "object",
            "properties": {"iata": {"type": "string", "description": "IATA code, e.g. 'BOS'."}},
            "required": ["iata"],
        },
    },
    {
        "name": "rank_airports",
        "description": "Rank airports within a scope by a deterministic metric. Use for questions "
                       "like 'best candidates for terminal expansion'. metric='expansion' for "
                       "expansion candidates, 'congestion', or 'unmet_demand'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "scope": {"type": "string", "description": "'new_england', 'all', or a state code."},
                "metric": {"type": "string", "enum": ["expansion", "congestion", "unmet_demand"]},
                "top_n": {"type": "integer", "description": "How many to return (default 5)."},
            },
            "required": ["metric"],
        },
    },
    {
        "name": "compare_airports",
        "description": "Compare two or more airports (by IATA code) on a metric. Use for "
                       "'compare X and Y congestion'. metric='congestion', 'unmet_demand', or 'expansion'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "iatas": {"type": "array", "items": {"type": "string"}, "description": "IATA codes, e.g. ['LAX','SNA']."},
                "metric": {"type": "string", "enum": ["congestion", "unmet_demand", "expansion"]},
            },
            "required": ["iatas"],
        },
    },
    {
        "name": "long_haul_breakdown",
        "description": "Short/medium/long-haul share of departures for one airport by IATA code. "
                       "Use for 'percentage of long-haul flights out of X'.",
        "input_schema": {
            "type": "object",
            "properties": {"iata": {"type": "string"}},
            "required": ["iata"],
        },
    },
    {
        "name": "unmet_demand",
        "description": "Estimate unmet flight demand for one airport by IATA code, with the "
                       "drivers behind it. Use for 'unmet demand at X and why'.",
        "input_schema": {
            "type": "object",
            "properties": {"iata": {"type": "string"}},
            "required": ["iata"],
        },
    },
]
