// Client-side mock contact source — a direct port of the backend `app/mock.py`,
// so the public demo runs the live map + track list with NO backend at all.
//
// It tells the same perch-and-listen story: a contact first appears as an acoustic
// cue (UNKNOWN, bearing-only, lower confidence), then — as it closes and confidence
// rises — flips to a vision-confirmed DRONE (FUSION). The output (`Contact` objects)
// matches the backend model exactly, so the rest of the UI is unaffected by the swap.

import type { Contact } from "../types";

// The node's perch — Fitzroy Harbour, ON (rural west Ottawa: clear horizon, quiet RF).
const NODE_LAT = 45.481;
const NODE_LON = -76.209;
const METRES_PER_DEG_LAT = 111_320;

// Confidence at/above which an acoustic cue is treated as a vision-confirmed drone.
const CONFIRM_THRESHOLD = 0.7;

const rand = (a: number, b: number) => a + Math.random() * (b - a);

function metresPerDegLon(latDeg: number): number {
  return METRES_PER_DEG_LAT * Math.cos((latDeg * Math.PI) / 180);
}

/** Approximate lat/lon of a point at (bearing, range) from the node. */
function project(bearingDeg: number, rangeM: number): [number, number] {
  const rad = (bearingDeg * Math.PI) / 180;
  const dlat = (rangeM * Math.cos(rad)) / METRES_PER_DEG_LAT;
  const dlon = (rangeM * Math.sin(rad)) / metresPerDegLon(NODE_LAT);
  return [NODE_LAT + dlat, NODE_LON + dlon];
}

/** A synthetic drone closing on the node along a slowly drifting bearing. */
class Drone {
  id: string;
  bearing: number;
  bearingRate: number; // deg/s of lateral drift
  range: number;
  closing: number; // m/s, slowly approaching
  elevation: number;
  confidence: number;

  constructor(idx: number) {
    this.id = `UNK-${String(idx).padStart(2, "0")}`;
    this.bearing = rand(0, 360);
    this.bearingRate = rand(-1.5, 1.5);
    this.range = rand(300, 800);
    this.closing = rand(3, 9);
    this.elevation = rand(5, 25);
    this.confidence = rand(0.25, 0.4);
  }

  step(dt: number): void {
    this.bearing = ((this.bearing + this.bearingRate * dt) % 360 + 360) % 360;
    this.range = Math.max(60, this.range - this.closing * dt);
    // Closer + more dwell time => higher confidence (acoustic SNR + vision lock).
    this.confidence = Math.min(1, this.confidence + 0.02 * dt + (800 - this.range) / 12_000);
    this.elevation = Math.min(80, this.elevation + 0.3 * dt);
  }

  toContact(ts: number): Contact {
    const confirmed = this.confidence >= CONFIRM_THRESHOLD;
    const [lat, lon] = project(this.bearing, this.range);
    return {
      id: this.id,
      kind: confirmed ? "drone" : "unknown",
      source: confirmed ? "fusion" : "acoustic",
      bearing_deg: (Math.round(this.bearing * 10) / 10) % 360,
      elevation_deg: Math.round(this.elevation * 10) / 10,
      range_m: Math.round(this.range),
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      confidence: Math.round(this.confidence * 100) / 100,
      ts,
    };
  }
}

/** Advances a few approaching drones and yields their contacts each tick. */
export class MockContactSource {
  private drones: Drone[];
  private last: number; // monotonic seconds (performance.now)

  constructor(nDrones = 3) {
    this.drones = Array.from({ length: nDrones }, (_, i) => new Drone(i + 1));
    this.last = performance.now() / 1000;
  }

  step(): Contact[] {
    const now = performance.now() / 1000;
    const dt = now - this.last;
    this.last = now;
    const ts = Date.now() / 1000; // epoch seconds, matches the backend `ts`
    return this.drones.map((d) => {
      d.step(dt);
      return d.toContact(ts);
    });
  }
}
