"""FastAPI application exposing the agent over the API contract (docs/API_CONTRACT.md).

Two endpoints:
  * GET  /api/health — liveness + dataset vintage
  * POST /api/chat   — one conversational turn

The response shape is stable even on error: the frontend always receives a
`reply` it can render.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import config, data
from .agent import run_agent

logger = logging.getLogger("airport_agent")

app = FastAPI(title="Airport Investment Intelligence Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


# --- Request / response models (mirror the API contract) ------------------- #

class ChatTurn(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    history: list[ChatTurn] = Field(default_factory=list)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "data_vintage": data.data_vintage()}


@app.post("/api/chat")
def chat(request: ChatRequest) -> dict[str, object]:
    if not config.has_api_key():
        return {
            "reply": (
                "The agent isn't configured yet: no `ANTHROPIC_API_KEY` was found. "
                "Add it to `backend/.env` and restart the server, then ask again."
            ),
            "error": "missing_api_key",
        }

    history = [turn.model_dump() for turn in request.history]
    try:
        return run_agent(request.message, history)
    except Exception as exc:  # noqa: BLE001 — return a safe reply, log the detail
        logger.exception("Agent turn failed")
        return {
            "reply": (
                "I hit an error while analyzing that. Please try again in a moment, "
                "or rephrase your question."
            ),
            "error": type(exc).__name__,
        }
