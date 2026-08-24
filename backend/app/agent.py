"""The conversational agent: Claude orchestrating the deterministic tools.

Responsibility split (this is the "where AI is used" answer for the design doc):

  * Claude decides *which* tool to call and *how to explain* the result in plain
    language, and it carries the conversation (follow-up questions).
  * The tools (and the scoring engine behind them) produce *every number*. Claude
    is instructed never to invent figures.
  * Assumptions, uncertainty, and the structured table shown in the UI come from
    the deterministic layer, not from the model — so the transparency the exam
    asks for is guaranteed, not left to the model's discretion.
"""

from __future__ import annotations

from typing import Any

from anthropic import Anthropic

from . import config, data
from .tools import TOOL_SCHEMAS, run_tool

SYSTEM_PROMPT = """You are an Airport Investment Intelligence analyst assistant for a \
firm that invests in U.S. airport modernization. Your job is to help analysts find \
airports where terminal renovation would be most profitable, driven by growing flight \
and passenger demand meeting constrained capacity.

How you work:
- You have tools that run a transparent, deterministic scoring engine over public \
aviation data. ALWAYS get numbers from the tools. NEVER invent or estimate figures \
yourself. If a needed airport is not in the dataset, say so plainly.
- Choose the right tool: rank_airports for "which airports are best candidates" \
(metric='expansion'), compare_airports for head-to-head questions, \
long_haul_breakdown for haul-mix questions, unmet_demand for demand-gap questions, \
airport_profile for a single-airport deep dive.
- Explain your reasoning clearly and concisely: state the headline answer first, then \
the key drivers behind the score in plain English. Refer to the metrics the tools return.
- Be explicit about assumptions, uncertainty, and scope. The scoring is a demand-side \
proxy on a curated public-data snapshot — never overclaim precision.
- Support natural follow-up questions using the conversation so far.

Formatting: reply in concise Markdown. Use short paragraphs and, where helpful, a \
compact list. Do not paste large tables in your text — the UI renders the structured \
table separately; refer to it (e.g. "see the ranking below")."""


def _client() -> Anthropic:
    return Anthropic(api_key=config.ANTHROPIC_API_KEY)


def _to_messages(history: list[dict[str, str]], message: str) -> list[dict[str, Any]]:
    """Build the Anthropic message list from prior turns plus the new user turn."""
    messages: list[dict[str, Any]] = []
    for turn in history:
        role = turn.get("role")
        content = turn.get("content", "")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": message})
    return messages


def run_agent(message: str, history: list[dict[str, str]] | None = None) -> dict[str, Any]:
    """Run one conversational turn and return a response matching the API contract."""
    history = history or []
    client = _client()
    messages = _to_messages(history, message)

    # Accumulators for the deterministic transparency layer.
    structured: dict[str, Any] | None = None
    assumptions: list[str] = []
    uncertainty_notes: list[str] = []
    tools_used: list[str] = []

    def remember(note_list: list[str], note: str | None) -> None:
        if note and note not in note_list:
            note_list.append(note)

    final_text = ""
    for _ in range(config.MAX_AGENT_STEPS):
        response = client.messages.create(
            model=config.ANTHROPIC_MODEL,
            max_tokens=config.MAX_TOKENS,
            system=SYSTEM_PROMPT,
            tools=TOOL_SCHEMAS,
            messages=messages,
        )

        # Collect any assistant text from this step.
        text_parts = [b.text for b in response.content if b.type == "text"]
        if text_parts:
            final_text = "\n\n".join(text_parts).strip()

        if response.stop_reason != "tool_use":
            break

        # Execute every tool call in this step and feed results back.
        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            tools_used.append(block.name)
            output = run_tool(block.name, block.input or {})

            if output.structured is not None:
                structured = output.structured
            for a in output.assumptions:
                remember(assumptions, a)
            remember(uncertainty_notes, output.uncertainty)

            tool_results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": _json_text(output.result),
            })
        messages.append({"role": "user", "content": tool_results})

    return {
        "reply": final_text or "I wasn't able to produce an answer for that. Could you rephrase?",
        "structured": structured,
        "assumptions": assumptions or None,
        "uncertainty": " ".join(uncertainty_notes) if uncertainty_notes else None,
        "meta": {
            "tools_used": list(dict.fromkeys(tools_used)),  # de-duped, order preserved
            "data_vintage": data.data_vintage(),
        },
    }


def _json_text(obj: Any) -> str:
    import json
    return json.dumps(obj, ensure_ascii=False)
