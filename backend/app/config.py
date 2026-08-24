"""Application configuration, loaded from environment variables.

Secrets (the Anthropic API key) come only from the environment / a local .env
file that is never committed. Everything else has a sensible default so the app
runs out of the box.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()  # read a local .env if present; real env vars still take precedence

# --- Paths ----------------------------------------------------------------- #
BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = BACKEND_DIR / "data" / "airports.json"

# --- LLM ------------------------------------------------------------------- #
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
# Sonnet is the right default here: strong tool-use and reasoning at low cost.
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5")
MAX_TOKENS = int(os.getenv("ANTHROPIC_MAX_TOKENS", "1500"))
# Cap on tool-use round-trips per turn — a safety bound against runaway loops.
MAX_AGENT_STEPS = int(os.getenv("MAX_AGENT_STEPS", "6"))

# --- CORS ------------------------------------------------------------------ #
# Comma-separated list of allowed origins for the browser frontend.
ALLOWED_ORIGINS = os.getenv(
    "ALLOWED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
).split(",")


def has_api_key() -> bool:
    return bool(ANTHROPIC_API_KEY)
