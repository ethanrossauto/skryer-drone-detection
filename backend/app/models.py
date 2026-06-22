"""Shared data models for drone contacts and alerts.

A *contact* is the unified representation the UI consumes, regardless of which
sensor produced it: an acoustic direction-of-arrival cue, a vision confirmation,
or the two fused together. Acoustic gives a *bearing* (and optionally elevation);
vision confirms and identifies. There is no cooperative/transponder data here —
the targets are non-cooperative drones that announce nothing.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class ContactKind(str, Enum):
    UNKNOWN = "unknown"  # acoustic-cued but not yet visually confirmed
    DRONE = "drone"  # vision-confirmed drone


class Source(str, Enum):
    ACOUSTIC = "acoustic"  # mic-array DoA bearing
    VISION = "vision"  # camera + small-object detector
    FUSION = "fusion"  # acoustic + vision combined


class Contact(BaseModel):
    """A single non-cooperative contact on the operator's threat board."""

    id: str = Field(..., description="Stable contact id")
    kind: ContactKind
    source: Source

    # Acoustic DoA is bearing-first; elevation comes from a 3-D mic array.
    bearing_deg: float = Field(..., ge=0, lt=360, description="Compass bearing from the node")
    elevation_deg: Optional[float] = Field(None, ge=-10, le=90, description="Above-horizon angle")
    range_m: Optional[float] = Field(None, description="Estimated slant range (coarse)")

    # Approximate map position, derived from bearing + estimated range for display.
    lat: Optional[float] = None
    lon: Optional[float] = None

    confidence: float = Field(..., ge=0, le=1, description="0–1 detection confidence")
    ts: float = Field(..., description="Unix epoch seconds of last update")


class Alert(BaseModel):
    """A raised alert tied to a contact."""

    id: str
    contact_id: str
    severity: str = Field("info", description="info | warning | critical")
    message: str
    ts: float
