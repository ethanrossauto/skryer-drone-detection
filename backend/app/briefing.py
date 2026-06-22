"""LLM threat-briefing layer — turns the structured contact list into a short,
streamed, spoken-style operator narration.

This is the *narration layer only*. It is grounded entirely on the `Contact` objects
the deterministic acoustic/vision/fusion pipeline produces; it never detects, scores,
or invents anything. The LLM is passed the exact contacts and instructed to describe
only those — so it cannot hallucinate a drone that isn't on the board.

Crucially, this layer is NOT on the operator's critical path. The map, bearing rays,
contact panel, and any alert are driven by `/ws/contacts` (deterministic, sub-second).
The briefing arrives a beat later on `/ws/briefing` as colour on top — if the model is
slow, rate-limited, or down, the operator still sees the threat immediately. Never let
a briefing call gate an alert.

Model: claude-haiku-4-5 — cheap and fast, plenty for narration (the per-update default
chosen in FEATURE-llm-briefing.md). Richer prioritisation reasoning would move to
claude-sonnet-4-6; the agentic *query* feature (v2) is where claude-opus-4-8 belongs.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Optional

from dotenv import load_dotenv

from app.models import Contact, ContactKind

# Load .env (gitignored) so ANTHROPIC_API_KEY is available in local dev.
load_dotenv()

MODEL = "claude-haiku-4-5"
# ~60 words of operator phrasing fits comfortably under this; caps cost/runaway output.
MAX_TOKENS = 300

_PROMPT_PATH = Path(__file__).parent / "prompts" / "briefing_system.txt"
SYSTEM_PROMPT = _PROMPT_PATH.read_text(encoding="utf-8")

# Spoken when there are no contacts — answered locally, with no model call (saves
# tokens + latency, and means the empty-sky case can never fail on the API).
SKY_CLEAR = "Sky clear, no contacts."

_client = None  # lazily constructed AsyncAnthropic; see _get_client()


def _get_client():
    """Return a cached AsyncAnthropic client (created on first use).

    Isolated in a function so tests can monkeypatch it, and so importing this module
    never requires an API key (the empty-sky path doesn't touch the client at all).
    """
    global _client
    if _client is None:
        # Imported lazily so the package imports cleanly even if `anthropic` isn't
        # installed yet (e.g. running the deterministic-only tests).
        from anthropic import AsyncAnthropic

        _client = AsyncAnthropic()
    return _client


# --- Grounding: rank + render the structured contacts ----------------------------


@dataclass
class ThreatPicture:
    """The contacts sorted highest-threat first, plus a count."""

    count: int
    contacts: list[Contact]


def _threat_key(c: Contact) -> tuple:
    """Sort key (use with reverse=True) — larger tuple == higher threat.

    Priority, per FEATURE-llm-briefing.md: vision-confirmed drones outrank acoustic-only
    cues; then higher confidence; then shorter range (closer is more threatening). A
    contact with unknown range sorts below any contact with a known range at the same
    confirmation/confidence — we won't pretend an unknown range is close.
    """
    confirmed = 1 if c.kind == ContactKind.DRONE else 0
    # Closer == higher threat, so negate range; unknown range == least known, sort last.
    range_priority = -c.range_m if c.range_m is not None else float("-inf")
    return (confirmed, round(c.confidence, 3), range_priority)


def derive_kinematics(contacts: list[Contact]) -> ThreatPicture:
    """Compute the display-useful fields the model shouldn't have to infer: the count
    and a highest-threat-first ordering. Closing-speed/ETA need track history and are
    deferred to v2 — we don't make the model guess at them."""
    ranked = sorted(contacts, key=_threat_key, reverse=True)
    return ThreatPicture(count=len(ranked), contacts=ranked)


def _render_contact(c: Contact) -> str:
    """Render one contact as a compact, unambiguous key=value line for the model."""
    kind = "vision-confirmed drone" if c.kind == ContactKind.DRONE else "acoustic-only, unconfirmed"
    parts = [
        f"id={c.id}",
        f"kind={kind}",
        f"source={c.source.value}",
        f"bearing={c.bearing_deg:.0f}deg",
    ]
    if c.elevation_deg is not None:
        parts.append(f"elevation={c.elevation_deg:.0f}deg")
    parts.append(f"range={f'{c.range_m:.0f} m' if c.range_m is not None else 'unknown'}")
    parts.append(f"confidence={c.confidence:.2f}")
    return " | ".join(parts)


def build_messages(contacts: list[Contact]) -> list[dict]:
    """Render the sorted contacts into the `messages` payload for the model. Pairs with
    SYSTEM_PROMPT. Only ever contains ids/values from the input contacts."""
    picture = derive_kinematics(contacts)
    lines = [f"{i + 1}. {_render_contact(c)}" for i, c in enumerate(picture.contacts)]
    block = (
        f"Current threat picture — {picture.count} contact(s), highest threat first. "
        "Brief the operator:\n" + "\n".join(lines)
    )
    return [{"role": "user", "content": block}]


# --- Throttle: detect a materially-changed picture --------------------------------

# Range bands (metres). A contact moving between bands is a material change worth
# re-briefing; drift within a band is not.
_RANGE_BANDS = (100.0, 300.0, 600.0, 1000.0)


def _range_band(range_m: Optional[float]) -> int:
    """Bucket a range into a coarse band index (or -1 if range is unknown)."""
    if range_m is None:
        return -1
    for i, edge in enumerate(_RANGE_BANDS):
        if range_m <= edge:
            return i
    return len(_RANGE_BANDS)


def picture_signature(contacts: list[Contact]) -> frozenset:
    """A hashable signature of the threat picture that changes only on *material*
    moves: a new or dropped contact, a kind change (acoustic cue -> confirmed drone),
    or a contact crossing a range band. Bearing/confidence drift within a band does
    not change it — that's what keeps us from re-briefing every tick."""
    return frozenset((c.id, c.kind.value, _range_band(c.range_m)) for c in contacts)


# --- Streaming narration ----------------------------------------------------------


async def stream_briefing(contacts: list[Contact]) -> AsyncIterator[str]:
    """Yield the briefing text delta-by-delta.

    Empty contacts are answered locally (no model call). Otherwise the structured
    contacts are streamed through Claude and text deltas are yielded as they arrive.
    """
    if not contacts:
        yield SKY_CLEAR
        return

    client = _get_client()
    async with client.messages.stream(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=SYSTEM_PROMPT,
        messages=build_messages(contacts),
    ) as stream:
        async for text in stream.text_stream:
            yield text


async def briefing_text(contacts: list[Contact]) -> str:
    """Convenience: run the stream to completion and return the full briefing string.
    Used by the eval suite and the LLM-as-judge check."""
    return "".join([delta async for delta in stream_briefing(contacts)])


# --- Eval support: LLM-as-judge (optional, gated by the caller) -------------------


async def judge_briefing_clarity(briefing: str) -> Optional[int]:
    """Score a briefing's clarity 1-5 with a second Claude call. Returns the integer
    score, or None if it couldn't be parsed. Used only by the live eval suite — the
    offline tests never call this (it makes an API request)."""
    client = _get_client()
    msg = await client.messages.create(
        model=MODEL,
        max_tokens=8,
        system=(
            "You grade air-defense operator briefings for clarity on a 1-5 scale "
            "(5 = crisp, unambiguous, leads with the priority threat). "
            "Reply with ONLY the integer, nothing else."
        ),
        messages=[{"role": "user", "content": briefing}],
    )
    text = next((b.text for b in msg.content if b.type == "text"), "").strip()
    return int(text) if text[:1].isdigit() else None
