"""Eval suite for the LLM threat-briefing layer.

Two tiers:

* **Offline (always run)** — the deterministic grounding logic and the empty-sky path.
  No API key, no network. These are the regression guard.
* **Live (gated by SKRYER_RUN_LLM_EVALS=1)** — actually call the model and assert on
  the generated briefing: no hallucinated ids (the key anti-hallucination check), every
  contact mentioned, highest threat first, and an LLM-as-judge clarity score. Skipped by
  default so the suite runs offline and in CI without spending tokens.

Run offline:   pytest
Run full evals: SKRYER_RUN_LLM_EVALS=1 pytest
"""

from __future__ import annotations

import asyncio
import os
import re

import pytest

from app import briefing
from app.briefing import (
    SKY_CLEAR,
    briefing_text,
    build_messages,
    derive_kinematics,
    picture_signature,
    stream_briefing,
)
from app.models import Contact, ContactKind, Source

LIVE = os.environ.get("SKRYER_RUN_LLM_EVALS") == "1"
live_only = pytest.mark.skipif(
    not LIVE, reason="set SKRYER_RUN_LLM_EVALS=1 to run the live LLM evals"
)

# Ids use a fixed shape so the anti-hallucination scan can recognise contact ids.
_ID_RE = re.compile(r"[A-Z]{2,}-\d+")


def _contact(cid, kind, source, bearing, conf, rng=None, elev=None):
    return Contact(
        id=cid,
        kind=kind,
        source=source,
        bearing_deg=bearing,
        elevation_deg=elev,
        range_m=rng,
        confidence=conf,
        ts=0.0,
    )


def _run(coro):
    return asyncio.run(coro)


# --- Canned scenarios -------------------------------------------------------------

EMPTY: list[Contact] = []

ONE_ACOUSTIC = [
    _contact("UNK-31", ContactKind.UNKNOWN, Source.ACOUSTIC, 310, 0.34, rng=None, elev=12),
]

ONE_VISION = [
    _contact("DRN-07", ContactKind.DRONE, Source.FUSION, 42, 0.91, rng=900, elev=15),
]

MULTI_MIXED = [
    # Acoustic-only but very confident & close — must still rank BELOW the confirmed drone.
    _contact("UNK-03", ContactKind.UNKNOWN, Source.ACOUSTIC, 310, 0.95, rng=200, elev=20),
    _contact("DRN-07", ContactKind.DRONE, Source.FUSION, 42, 0.80, rng=900, elev=15),
    _contact("DRN-11", ContactKind.DRONE, Source.FUSION, 120, 0.80, rng=300, elev=30),
]


# --- Offline: empty-sky path (no API call) ----------------------------------------


def test_empty_sky_no_api_call(monkeypatch):
    """Empty contacts must be answered locally — the client is never constructed."""

    def _boom():
        raise AssertionError("the model must not be called for the empty-sky path")

    monkeypatch.setattr(briefing, "_get_client", _boom)
    text = _run(briefing_text(EMPTY))
    assert text == SKY_CLEAR


# --- Offline: deterministic grounding ---------------------------------------------


def test_vision_confirmed_outranks_confident_acoustic():
    """A vision-confirmed drone is the top threat even when an acoustic-only cue is
    closer and higher-confidence."""
    picture = derive_kinematics(MULTI_MIXED)
    assert picture.count == 3
    assert picture.contacts[0].kind == ContactKind.DRONE
    # The acoustic cue, however confident, is not the lead.
    assert picture.contacts[0].id in {"DRN-07", "DRN-11"}


def test_closer_confirmed_drone_ranks_first():
    """Between two equally-confident confirmed drones, the closer one leads."""
    picture = derive_kinematics(MULTI_MIXED)
    confirmed = [c for c in picture.contacts if c.kind == ContactKind.DRONE]
    assert confirmed[0].id == "DRN-11"  # 300 m beats 900 m


def test_unknown_range_sorts_after_known_range():
    """A confirmed contact with unknown range sorts below one with a known range at the
    same confidence — we never treat 'unknown' as close."""
    contacts = [
        _contact("DRN-01", ContactKind.DRONE, Source.FUSION, 10, 0.7, rng=None),
        _contact("DRN-02", ContactKind.DRONE, Source.FUSION, 20, 0.7, rng=800),
    ]
    picture = derive_kinematics(contacts)
    assert picture.contacts[0].id == "DRN-02"


def test_build_messages_mentions_every_id_and_no_others():
    """The rendered prompt names every input contact and introduces no foreign ids."""
    block = build_messages(MULTI_MIXED)[0]["content"]
    rendered_ids = set(_ID_RE.findall(block))
    assert rendered_ids == {c.id for c in MULTI_MIXED}


def test_build_messages_highest_threat_first():
    """The first listed line in the prompt is the highest-threat contact."""
    block = build_messages(MULTI_MIXED)[0]["content"]
    first_line = [ln for ln in block.splitlines() if ln.startswith("1.")][0]
    assert "DRN-11" in first_line  # closest confirmed drone


def test_unknown_range_rendered_as_unknown():
    block = build_messages(ONE_ACOUSTIC)[0]["content"]
    assert "range=unknown" in block


# --- Offline: throttle signature --------------------------------------------------


def test_signature_stable_under_small_drift():
    """Bearing/confidence drift within a range band does not change the signature."""
    a = [_contact("DRN-07", ContactKind.DRONE, Source.FUSION, 42.0, 0.80, rng=900)]
    b = [_contact("DRN-07", ContactKind.DRONE, Source.FUSION, 44.0, 0.83, rng=880)]
    assert picture_signature(a) == picture_signature(b)


def test_signature_changes_on_kind_flip_and_band_cross():
    base = [_contact("UNK-07", ContactKind.UNKNOWN, Source.ACOUSTIC, 42, 0.5, rng=900)]
    kind_flip = [_contact("UNK-07", ContactKind.DRONE, Source.FUSION, 42, 0.8, rng=900)]
    band_cross = [_contact("UNK-07", ContactKind.UNKNOWN, Source.ACOUSTIC, 42, 0.5, rng=250)]
    assert picture_signature(base) != picture_signature(kind_flip)
    assert picture_signature(base) != picture_signature(band_cross)


def test_signature_changes_on_new_contact():
    one = ONE_VISION
    two = ONE_VISION + ONE_ACOUSTIC
    assert picture_signature(one) != picture_signature(two)


# --- Live: grounded generation (gated) --------------------------------------------


@live_only
def test_live_empty_still_sky_clear():
    assert _run(briefing_text(EMPTY)) == SKY_CLEAR


@live_only
def test_live_no_hallucinated_ids():
    """THE key check: the briefing names no contact id that isn't in the input."""
    text = _run(briefing_text(MULTI_MIXED))
    mentioned = set(_ID_RE.findall(text))
    input_ids = {c.id for c in MULTI_MIXED}
    assert mentioned <= input_ids, f"hallucinated ids: {mentioned - input_ids}"


@live_only
def test_live_mentions_every_contact():
    text = _run(briefing_text(MULTI_MIXED))
    for c in MULTI_MIXED:
        assert c.id in text, f"briefing omitted {c.id}: {text!r}"


@live_only
def test_live_highest_threat_first():
    """The lead (closest confirmed drone) is named before the others."""
    text = _run(briefing_text(MULTI_MIXED))
    assert text.index("DRN-11") < text.index("DRN-07")
    assert text.index("DRN-11") < text.index("UNK-03")


@live_only
def test_live_clarity_judge():
    text = _run(briefing_text(ONE_VISION))
    score = _run(briefing.judge_briefing_clarity(text))
    assert score is not None and score >= 3, f"clarity {score} for: {text!r}"
