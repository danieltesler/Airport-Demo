"""Deterministic scoring engine for airport investment analysis.

This module is the analytical core of the agent. It contains **no LLM calls and
no I/O** — just pure functions over airport metric dictionaries. That separation
is deliberate: the numbers an analyst sees must be reproducible and auditable,
independent of any language-model output.

Design choices (see docs/DESIGN.md for the full rationale):

* Every sub-metric is normalized to 0-1 against a **fixed, documented reference
  scale** (e.g. "30 min average delay = fully congested"), not against the
  current dataset's distribution. Fixed scales make a score mean the same thing
  regardless of which airports happen to be loaded, and keep results stable.
* Composite scores are simple **transparent weighted sums** of those components,
  reported on a 0-100 scale. Weights live in one place and are easy to defend.
* Each scoring function returns not just a number but its **components** and the
  **assumptions** behind it, so the agent can explain its reasoning and surface
  uncertainty honestly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# --------------------------------------------------------------------------- #
# Reference scales — the anchors that turn raw metrics into 0-1 components.
# Chosen from domain norms; documented so a reviewer can challenge any one value.
# --------------------------------------------------------------------------- #

# Congestion anchors
FULL_CONGESTION_DELAY_MIN = 30.0        # avg departure delay treated as "saturated"
FULL_CONGESTION_DELAYED_SHARE = 0.35    # share of flights >15 min late at saturation
FULL_CONGESTION_CANCEL_RATE = 0.05      # cancellation rate at saturation
LOAD_FACTOR_FLOOR = 0.70                # below this, seats are not a constraint
LOAD_FACTOR_CEILING = 0.90              # at/above this, effectively sold out

# Expansion / demand anchors
STRONG_GROWTH_YOY = 0.10                # 10% YoY passenger growth = maximal demand signal
LARGE_AIRPORT_PAX = 50_000_000          # passengers at which "volume upside" maxes out
HIGH_THROUGHPUT_PER_RUNWAY = 60_000     # annual departures/runway treated as runway-constrained


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    """Constrain a value to [low, high]."""
    return max(low, min(high, value))


def normalize(value: float, full_scale: float) -> float:
    """Map a raw value onto 0-1 where `full_scale` maps to 1.0."""
    if full_scale <= 0:
        return 0.0
    return clamp(value / full_scale)


def load_factor_pressure(load_factor: float) -> float:
    """Seat-supply pressure on 0-1.

    Below LOAD_FACTOR_FLOOR there is spare capacity (0); at/above the ceiling the
    airport is effectively full (1); linear in between.
    """
    span = LOAD_FACTOR_CEILING - LOAD_FACTOR_FLOOR
    return clamp((load_factor - LOAD_FACTOR_FLOOR) / span)


@dataclass
class ScoreResult:
    """A score plus the components and assumptions that produced it."""

    score: float                                   # 0-100
    components: dict[str, float]                    # named 0-1 contributions
    assumptions: list[str] = field(default_factory=list)
    uncertainty: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "score": round(self.score, 1),
            "components": {k: round(v, 3) for k, v in self.components.items()},
            "assumptions": self.assumptions,
            "uncertainty": self.uncertainty,
        }


# --------------------------------------------------------------------------- #
# Congestion
# --------------------------------------------------------------------------- #

CONGESTION_WEIGHTS = {
    "delayed_share": 0.35,
    "avg_delay": 0.30,
    "cancellations": 0.15,
    "load_pressure": 0.20,
}

CONGESTION_ASSUMPTIONS = [
    "Congestion is proxied by operational strain: departure delays, the share of "
    "flights delayed >15 min, cancellations, and seat load factor.",
    "Metrics are compared as rates (per-flight / per-seat), not totals, so large "
    "hubs and small airports are judged on the same footing.",
]


def congestion_score(airport: dict[str, Any]) -> ScoreResult:
    """Composite congestion index (0-100). Higher = more congested."""
    components = {
        "delayed_share": normalize(airport["delayed_share"], FULL_CONGESTION_DELAYED_SHARE),
        "avg_delay": normalize(airport["avg_dep_delay_min"], FULL_CONGESTION_DELAY_MIN),
        "cancellations": normalize(airport["cancel_rate"], FULL_CONGESTION_CANCEL_RATE),
        "load_pressure": load_factor_pressure(airport["load_factor"]),
    }
    score = 100.0 * sum(CONGESTION_WEIGHTS[k] * v for k, v in components.items())
    return ScoreResult(
        score=score,
        components=components,
        assumptions=CONGESTION_ASSUMPTIONS,
        uncertainty=(
            "Delay data reflects annual averages; short-term peaks (holidays, "
            "weather events) are smoothed out. Delays also mix weather with true "
            "capacity saturation."
        ),
    )


# --------------------------------------------------------------------------- #
# Long-haul mix
# --------------------------------------------------------------------------- #

def haul_breakdown(airport: dict[str, Any]) -> dict[str, float]:
    """Return the short/medium/long share of departures as percentages (0-100)."""
    mix = airport["haul_mix"]
    return {
        "short": round(100.0 * mix["short"], 1),
        "medium": round(100.0 * mix["medium"], 1),
        "long": round(100.0 * mix["long"], 1),
    }


# --------------------------------------------------------------------------- #
# Unmet demand
# --------------------------------------------------------------------------- #

UNMET_DEMAND_WEIGHTS = {
    "load_pressure": 0.40,     # high load factor => spilled demand
    "congestion": 0.35,        # delay/throughput gap => demand above capacity
    "growth_vs_capacity": 0.25,  # fast growth against fixed runways => widening gap
}

UNMET_DEMAND_ASSUMPTIONS = [
    "'Unmet demand' has no direct public measurement (bookings that never happened "
    "aren't observable in free data). We estimate it as a composite lower-bound proxy.",
    "Load factor is the primary signal: sustained high seat utilization implies "
    "demand that current supply cannot absorb.",
    "Growth measured against roughly fixed runway capacity indicates a widening gap.",
]


def growth_vs_capacity(airport: dict[str, Any]) -> float:
    """0-1: fast passenger growth relative to runway throughput headroom."""
    growth = normalize(airport["pax_growth_yoy"], STRONG_GROWTH_YOY)
    throughput_per_runway = airport["annual_departures"] / max(airport["runways"], 1)
    runway_pressure = normalize(throughput_per_runway, HIGH_THROUGHPUT_PER_RUNWAY)
    # A widening gap needs BOTH growing demand and limited headroom.
    return clamp(0.6 * growth + 0.4 * runway_pressure)


def unmet_demand_score(airport: dict[str, Any]) -> ScoreResult:
    """Composite unmet-demand proxy (0-100). Higher = more likely spilled demand."""
    congestion = congestion_score(airport).score / 100.0
    components = {
        "load_pressure": load_factor_pressure(airport["load_factor"]),
        "congestion": congestion,
        "growth_vs_capacity": growth_vs_capacity(airport),
    }
    score = 100.0 * sum(UNMET_DEMAND_WEIGHTS[k] * v for k, v in components.items())
    return ScoreResult(
        score=score,
        components=components,
        assumptions=UNMET_DEMAND_ASSUMPTIONS,
        uncertainty=(
            "This is a lower-bound proxy. True unmet demand (searches that didn't "
            "convert, fares that priced people out) requires proprietary GDS/OAG "
            "data not available for free."
        ),
    )


# --------------------------------------------------------------------------- #
# Expansion attractiveness — the headline investment score
# --------------------------------------------------------------------------- #

EXPANSION_WEIGHTS = {
    "demand_growth": 0.30,      # future demand to justify the build
    "congestion": 0.30,         # today's strain that expansion would relieve
    "load_pressure": 0.25,      # seats already scarce
    "volume_upside": 0.15,      # scale of passengers who benefit
}

EXPANSION_ASSUMPTIONS = [
    "Investment thesis: terminal expansion is most profitable where strong, growing "
    "demand meets a capacity-constrained airport — so renovation unlocks revenue "
    "rather than adding idle space.",
    "Score blends demand growth, current congestion, seat load pressure, and "
    "passenger volume; weights are documented and adjustable.",
    "Airport scope is limited to the bundled dataset (major + selected mid-size "
    "U.S. airports).",
]


def expansion_score(airport: dict[str, Any]) -> ScoreResult:
    """Composite terminal-expansion attractiveness (0-100). Higher = stronger candidate."""
    components = {
        "demand_growth": normalize(airport["pax_growth_yoy"], STRONG_GROWTH_YOY),
        "congestion": congestion_score(airport).score / 100.0,
        "load_pressure": load_factor_pressure(airport["load_factor"]),
        "volume_upside": normalize(airport["annual_passengers"], LARGE_AIRPORT_PAX),
    }
    score = 100.0 * sum(EXPANSION_WEIGHTS[k] * v for k, v in components.items())
    return ScoreResult(
        score=score,
        components=components,
        assumptions=EXPANSION_ASSUMPTIONS,
        uncertainty=(
            "Score reflects demand-side opportunity only. It does not model "
            "construction cost, land/gate availability, or local regulatory limits "
            "(e.g. noise curfews), which a full investment case would weigh."
        ),
    )


# Registry so tools can look up a scorer by name without a big if/elif ladder.
METRIC_SCORERS = {
    "congestion": congestion_score,
    "unmet_demand": unmet_demand_score,
    "expansion": expansion_score,
}
