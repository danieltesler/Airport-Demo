"""Data access layer over the bundled airport dataset.

Loads the curated public-data snapshot once and exposes small, focused query
helpers. This is the only module that knows how the dataset is stored, so the
scoring engine and tools stay independent of the storage format.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

from .config import DATA_FILE


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    """Read and cache the dataset file (meta + airports)."""
    with open(DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def data_vintage() -> str:
    """Human-readable description of the dataset's source and time period."""
    return _load()["meta"]["vintage"]


def new_england_states() -> list[str]:
    return _load()["meta"]["new_england_states"]


def haul_thresholds() -> dict[str, int]:
    return _load()["meta"]["haul_thresholds_miles"]


@lru_cache(maxsize=1)
def _by_iata() -> dict[str, dict[str, Any]]:
    return {a["iata"]: a for a in _load()["airports"]}


def all_airports() -> list[dict[str, Any]]:
    return list(_load()["airports"])


def get_airport(iata: str) -> dict[str, Any] | None:
    """Look up one airport by IATA code (case-insensitive). None if unknown."""
    return _by_iata().get(iata.strip().upper())


def known_iatas() -> list[str]:
    return sorted(_by_iata().keys())


def airports_in_scope(scope: str | None, states: list[str] | None = None) -> list[dict[str, Any]]:
    """Resolve a named scope to a list of airports.

    Scopes:
      * "new_england" -> airports in ME/NH/VT/MA/RI/CT
      * "all" or None -> every airport in the dataset
      * a 2-letter state code (e.g. "CA") -> that state
    An explicit `states` list, if given, overrides `scope`.
    """
    airports = all_airports()

    if states:
        wanted = {s.strip().upper() for s in states}
        return [a for a in airports if a["state"] in wanted]

    if not scope or scope.lower() == "all":
        return airports

    key = scope.strip().lower()
    if key in {"new_england", "new-england", "newengland"}:
        ne = set(new_england_states())
        return [a for a in airports if a["state"] in ne]

    # Treat anything else as a state code.
    return [a for a in airports if a["state"] == scope.strip().upper()]
