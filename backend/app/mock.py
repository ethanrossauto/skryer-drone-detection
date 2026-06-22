"""Mock contact source: synthetic drones approaching the perched node, so the
UI shell is live before any hardware exists.

It tells the perch-and-listen story: a contact first appears as an acoustic cue
(UNKNOWN, bearing-only, lower confidence), then — as it closes and confidence
rises — flips to a vision-confirmed DRONE (FUSION). Replace this with the real
acoustic DoA + vision pipeline once the mic array and camera are connected; the
output (`Contact` objects) stays the same, so the rest of the stack is unaffected.
"""

from __future__ import annotations

import math
import random
import time

from app.models import Contact, ContactKind, Source

# The node's perch — Fitzroy Harbour, ON (rural west Ottawa: clear horizon, quiet RF/ambient).
NODE_LAT = 45.4810
NODE_LON = -76.2090

_METRES_PER_DEG_LAT = 111_320.0

# Confidence at/above which an acoustic cue is treated as a vision-confirmed drone.
_CONFIRM_THRESHOLD = 0.7


def _metres_per_deg_lon(lat_deg: float) -> float:
    return _METRES_PER_DEG_LAT * math.cos(math.radians(lat_deg))


def _project(bearing_deg: float, range_m: float) -> tuple[float, float]:
    """Approximate lat/lon of a point at (bearing, range) from the node."""
    rad = math.radians(bearing_deg)
    dlat = (range_m * math.cos(rad)) / _METRES_PER_DEG_LAT
    dlon = (range_m * math.sin(rad)) / _metres_per_deg_lon(NODE_LAT)
    return NODE_LAT + dlat, NODE_LON + dlon


class _Drone:
    """A synthetic drone closing on the node along a slowly drifting bearing."""

    def __init__(self, idx: int) -> None:
        self.id = f"UNK-{idx:02d}"
        self.bearing_deg = random.uniform(0, 360)
        self.bearing_rate = random.uniform(-1.5, 1.5)  # deg/s of lateral drift
        self.range_m = random.uniform(300, 800)
        self.closing_mps = random.uniform(3, 9)  # slowly approaching
        self.elevation_deg = random.uniform(5, 25)
        self.confidence = random.uniform(0.25, 0.4)

    def step(self, dt: float) -> None:
        self.bearing_deg = (self.bearing_deg + self.bearing_rate * dt) % 360
        self.range_m = max(60.0, self.range_m - self.closing_mps * dt)
        # Closer + more dwell time => higher confidence (acoustic SNR + vision lock).
        self.confidence = min(1.0, self.confidence + 0.02 * dt + (800 - self.range_m) / 12_000)
        self.elevation_deg = min(80.0, self.elevation_deg + 0.3 * dt)

    def to_contact(self) -> Contact:
        confirmed = self.confidence >= _CONFIRM_THRESHOLD
        lat, lon = _project(self.bearing_deg, self.range_m)
        return Contact(
            id=self.id,
            kind=ContactKind.DRONE if confirmed else ContactKind.UNKNOWN,
            source=Source.FUSION if confirmed else Source.ACOUSTIC,
            # round can bump 359.96 -> 360.0, which violates the model's lt=360; wrap it.
            bearing_deg=round(self.bearing_deg, 1) % 360,
            elevation_deg=round(self.elevation_deg, 1),
            range_m=round(self.range_m, 0),
            lat=round(lat, 5),
            lon=round(lon, 5),
            confidence=round(self.confidence, 2),
            ts=time.time(),
        )


class MockContactSource:
    """Advances a few approaching drones and yields their contacts each tick."""

    def __init__(self, n_drones: int = 3) -> None:
        self._drones = [_Drone(i + 1) for i in range(n_drones)]
        self._last = time.monotonic()

    def step(self) -> list[Contact]:
        now = time.monotonic()
        dt = now - self._last
        self._last = now
        contacts: list[Contact] = []
        for d in self._drones:
            d.step(dt)
            contacts.append(d.to_contact())
        return contacts
