"""Tests for the deterministic scoring engine and data layer.

These pin down the behavior of the analytical core — the part that must be
reproducible and defensible independent of any LLM.
"""

from __future__ import annotations

import pytest

from app import data, scoring


# --- Helpers to build airport fixtures ------------------------------------- #

def make_airport(**overrides):
    base = {
        "iata": "TST", "icao": "KTST", "name": "Test", "city": "Test", "state": "CA",
        "lat": 0.0, "lon": 0.0, "runways": 2,
        "annual_passengers": 10_000_000, "pax_growth_yoy": 0.05, "load_factor": 0.80,
        "avg_dep_delay_min": 12.0, "delayed_share": 0.15, "cancel_rate": 0.02,
        "annual_departures": 60_000,
        "haul_mix": {"short": 0.6, "medium": 0.3, "long": 0.1},
    }
    base.update(overrides)
    return base


# --- Primitives ------------------------------------------------------------ #

def test_clamp_bounds():
    assert scoring.clamp(-1.0) == 0.0
    assert scoring.clamp(2.0) == 1.0
    assert scoring.clamp(0.5) == 0.5


def test_normalize_maps_full_scale_to_one():
    assert scoring.normalize(30, 30) == 1.0
    assert scoring.normalize(15, 30) == 0.5
    assert scoring.normalize(60, 30) == 1.0  # clamped


def test_load_factor_pressure_floor_and_ceiling():
    assert scoring.load_factor_pressure(0.70) == 0.0
    assert scoring.load_factor_pressure(0.90) == 1.0
    assert scoring.load_factor_pressure(0.80) == pytest.approx(0.5)


# --- Congestion ------------------------------------------------------------ #

def test_congestion_score_in_range():
    result = scoring.congestion_score(make_airport())
    assert 0.0 <= result.score <= 100.0
    assert set(result.components) == set(scoring.CONGESTION_WEIGHTS)


def test_more_delays_means_more_congestion():
    calm = make_airport(avg_dep_delay_min=8, delayed_share=0.10, cancel_rate=0.01, load_factor=0.75)
    busy = make_airport(avg_dep_delay_min=25, delayed_share=0.30, cancel_rate=0.04, load_factor=0.88)
    assert scoring.congestion_score(busy).score > scoring.congestion_score(calm).score


def test_congestion_weights_sum_to_one():
    assert sum(scoring.CONGESTION_WEIGHTS.values()) == pytest.approx(1.0)
    assert sum(scoring.EXPANSION_WEIGHTS.values()) == pytest.approx(1.0)
    assert sum(scoring.UNMET_DEMAND_WEIGHTS.values()) == pytest.approx(1.0)


# --- Haul mix -------------------------------------------------------------- #

def test_haul_breakdown_percentages():
    mix = scoring.haul_breakdown(make_airport(haul_mix={"short": 0.5, "medium": 0.3, "long": 0.2}))
    assert mix == {"short": 50.0, "medium": 30.0, "long": 20.0}


# --- Expansion ------------------------------------------------------------- #

def test_expansion_prefers_growing_constrained_airport():
    weak = make_airport(pax_growth_yoy=0.01, load_factor=0.72, avg_dep_delay_min=8,
                        delayed_share=0.10, cancel_rate=0.01, annual_passengers=2_000_000)
    strong = make_airport(pax_growth_yoy=0.10, load_factor=0.88, avg_dep_delay_min=20,
                          delayed_share=0.28, cancel_rate=0.03, annual_passengers=50_000_000)
    assert scoring.expansion_score(strong).score > scoring.expansion_score(weak).score


def test_unmet_demand_components_present_and_bounded():
    result = scoring.unmet_demand_score(make_airport())
    assert 0.0 <= result.score <= 100.0
    for value in result.components.values():
        assert 0.0 <= value <= 1.0
    assert result.uncertainty  # unmet demand must always carry a caveat


# --- Data layer ------------------------------------------------------------ #

def test_dataset_loads_and_has_key_airports():
    codes = set(data.known_iatas())
    for expected in ("SFO", "LAX", "SNA", "ANC", "BOS"):
        assert expected in codes


def test_new_england_scope():
    ne = data.airports_in_scope("new_england")
    states = {a["state"] for a in ne}
    assert states <= {"ME", "NH", "VT", "MA", "RI", "CT"}
    assert any(a["iata"] == "BOS" for a in ne)
    # SFO must not leak into a New England scope.
    assert all(a["iata"] != "SFO" for a in ne)


def test_get_airport_is_case_insensitive():
    assert data.get_airport("sfo")["iata"] == "SFO"
    assert data.get_airport("SFO")["iata"] == "SFO"
    assert data.get_airport("ZZZ") is None
