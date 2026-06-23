// Client-side mock contact source — drives the public demo's live map + track list
// with NO backend at all.
//
// Scene: a protected critical-infrastructure site at the centre, ringed by three
// perched acoustic nodes (~600 m perimeter). Cheap attack drones ingress from outside
// toward the asset. They don't fly dead-straight beelines and they don't random-walk
// aimlessly — each picks a behaviour (direct run / weaving approach / recon-orbit /
// late-commit) and steers with a real banked turn-rate, so the motion reads as
// *intent*, not noise.
//
// Detection is PER NODE and honest: a node hears a drone only within its own acoustic
// edge. A drone first crossing one node's range shows as a single bearing line
// (range UNKNOWN); once a second node hears it, the bearings cross and the track
// resolves to a triangulated fix WITH range. The mock emits only acoustic cues
// (kind "unknown") — vision confirmation is owned by the PTZ camera (see App.tsx).

import type { Contact } from "../types";
import { NODES, OUTER_RING_M, projectXY } from "./geo";

// Movement envelope for a cheap medium attack drone.
const SPEED_LOITER = 14; // m/s — standoff / orbit
const SPEED_DASH = 30; // m/s — committed run at the asset
const TURN_RATE = 0.6; // rad/s — banked-turn limit; heading eases, never snaps
const SPAWN_MIN = 3600; // m — respawn ring, outside the ~3.25 km detection horizon so each
const SPAWN_MAX = 4300; // m   drone flies a clean inbound approach before it's first heard
const DESPAWN_R = 4700; // m — gone if it runs back out past this
const ARRIVE_R = 110; // m — "reached the asset" → it expires + a fresh one spawns
const STANDOFF_R = 1400; // m — recon/late drones orbit between the inner & outer node rings
// Per-node acoustic edge — kept ABOVE the inner ring (geo.INNER_RING_M = 800 m) so a drone
// at the centre is still heard by the inner ring (no blind spot at the asset).
const ACOUSTIC_MIN = 1000; // m — quietest plausible per-node detection edge
const ACOUSTIC_MAX = 1250; // m — a loud one on a calm day
const HYSTERESIS = 1.1; // drop a node's hearing only past 110% of its edge (anti-chatter)
const MAX_LIFETIME = 400; // s — pure failsafe; must exceed the real fly-in time (~190 s
// across this field) or every drone respawns on the same clock → a synchronized wave.
const AIM_JITTER = 70; // m — spread aim points around the asset so tracks don't stack
const WEAVE_AMP = 0.5; // rad — cross-track weave amplitude
const WEAVE_FREQ = 0.5; // rad/s
// Opening wave: each starting drone is placed just BEYOND its own detection edge so the
// site loads with zero detections, then they fly in and light up, staggered.
const INITIAL_MARGIN_BASE = 15; // m beyond detection for the first drone (~1–2 s of flight)
const INITIAL_MARGIN_STEP = 40; // m extra per drone, so they trickle in over ~25 s
const INITIAL_MARGIN_JITTER = 20; // m random spread so they don't enter in lockstep

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a)); // → (-π, π]

type Profile = "direct" | "weave" | "orbit" | "late";
type Phase = "ingress" | "orbit" | "commit" | "egress";

let nextId = 0;
const newId = () => `UNK-${String(++nextId).padStart(2, "0")}`;

/** The radius (from the asset, along bearing `b`) at which a drone with hearing edge
 *  `edge` first crosses into some node's range — i.e. where its first cone appears. Used
 *  to start the opening wave just OUTSIDE this, accounting for bearing misalignment, so
 *  the map loads empty and the first detection is a fixed flight-time later. */
function detectionRadius(b: number, edge: number): number {
  const sb = Math.sin(b);
  const cb = Math.cos(b);
  let best = 0;
  for (const n of NODES) {
    const B = sb * n.x + cb * n.y; // node projected onto the inbound bearing
    const disc = B * B - (n.x * n.x + n.y * n.y - edge * edge);
    if (disc >= 0) best = Math.max(best, B + Math.sqrt(disc));
  }
  return best || OUTER_RING_M + edge;
}

function pickProfile(): Profile {
  const r = Math.random();
  if (r < 0.4) return "direct";
  if (r < 0.65) return "weave";
  if (r < 0.85) return "late";
  return "orbit";
}

/** A synthetic attack drone ingressing toward the protected asset. */
class Drone {
  id!: string;
  x!: number; // metres east of the asset
  y!: number; // metres north of the asset
  heading!: number; // rad (0 = north, +clockwise)
  speed!: number; // m/s
  alt!: number; // metres AGL
  acousticRange!: number; // m — this drone's per-node detection edge
  profile!: Profile;
  phase!: Phase;
  aimX!: number; // aim point (the asset, jittered) so tracks don't pile on one pixel
  aimY!: number;
  orbitDir!: number; // +1 / -1 — which way it circles at standoff
  orbitUntil!: number; // monotonic seconds: leave the orbit after this
  weavePhase!: number; // rad — per-drone phase offset for the weave
  age!: number; // s alive — failsafe respawn
  heardBy: Record<string, boolean> = {}; // per-node hearing latch (hysteresis)

  constructor(initialMargin?: number) {
    this.spawn(initialMargin);
  }

  /** Respawn from the outer ring inbound. `initialMargin` (constructor only) instead
   *  places the drone just BEYOND its own detection edge by that many metres — so the
   *  map loads with no detections and the staggered opening wave lights up a beat later. */
  spawn(initialMargin?: number): void {
    this.acousticRange = rand(ACOUSTIC_MIN, ACOUSTIC_MAX);
    const b = rand(0, 2 * Math.PI);
    const r =
      initialMargin != null
        ? detectionRadius(b, this.acousticRange) + initialMargin // just outside its first cone
        : rand(SPAWN_MIN, SPAWN_MAX);
    this.x = r * Math.sin(b);
    this.y = r * Math.cos(b);
    this.id = newId();
    this.profile = pickProfile();
    this.phase = "ingress";
    this.aimX = rand(-AIM_JITTER, AIM_JITTER);
    this.aimY = rand(-AIM_JITTER, AIM_JITTER);
    this.heading = Math.atan2(this.aimX - this.x, this.aimY - this.y); // point inbound
    this.speed = rand(SPEED_LOITER, (SPEED_LOITER + SPEED_DASH) / 2);
    this.alt = rand(50, 160);
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.orbitUntil = 0;
    this.weavePhase = rand(0, 2 * Math.PI);
    this.age = 0;
    this.heardBy = {};
  }

  private rangeC(): number {
    return Math.hypot(this.x, this.y);
  }
  /** Heading that aims at the (jittered) asset. */
  private seek(): number {
    return Math.atan2(this.aimX - this.x, this.aimY - this.y);
  }
  /** Heading pointing radially outward from the asset. */
  private radialOut(): number {
    return Math.atan2(this.x, this.y);
  }

  step(dt: number, tNow: number): void {
    this.age += dt;
    const range = this.rangeC();
    const closeFrac = clamp(range / SPAWN_MAX, 0, 1); // 1 far out → 0 at the asset
    let desired = this.seek();
    let targetSpeed = SPEED_LOITER;

    switch (this.profile) {
      case "direct":
        // Straight-ish run; accelerates as it closes.
        desired = this.seek();
        targetSpeed = lerp(SPEED_DASH, SPEED_LOITER, closeFrac);
        break;
      case "weave":
        // Seek with a sinusoidal cross-track weave — an evasive/terrain-masking feel.
        desired = this.seek() + Math.sin(tNow * WEAVE_FREQ + this.weavePhase) * WEAVE_AMP;
        targetSpeed = lerp(SPEED_DASH * 0.85, SPEED_LOITER, closeFrac);
        break;
      case "orbit":
      case "late": {
        const orbitLen = this.profile === "late" ? rand(5, 9) : rand(9, 16);
        if (this.phase === "ingress") {
          desired = this.seek();
          targetSpeed = lerp(SPEED_DASH * 0.8, SPEED_LOITER, closeFrac);
          if (range <= STANDOFF_R + 40) {
            this.phase = "orbit";
            this.orbitUntil = tNow + orbitLen;
          }
        } else if (this.phase === "orbit") {
          // Circle the standoff radius (tangential heading), then decide.
          desired = this.radialOut() + (this.orbitDir * Math.PI) / 2;
          targetSpeed = SPEED_LOITER;
          if (tNow >= this.orbitUntil) {
            const commit = this.profile === "late" || Math.random() < 0.6;
            this.phase = commit ? "commit" : "egress";
          }
        } else if (this.phase === "commit") {
          desired = this.seek();
          targetSpeed = SPEED_DASH;
        } else {
          // egress — break contact back outward
          desired = this.radialOut();
          targetSpeed = SPEED_DASH * 0.8;
        }
        break;
      }
    }

    // Banked turn: ease heading toward the desired bearing, capped per second.
    this.heading += clamp(wrapPi(desired - this.heading), -TURN_RATE * dt, TURN_RATE * dt);
    // Ease speed; gentle altitude drift.
    this.speed += clamp(targetSpeed - this.speed, -8 * dt, 8 * dt);
    this.alt = clamp(this.alt + rand(-6, 6) * dt, 30, 200);

    this.x += Math.sin(this.heading) * this.speed * dt;
    this.y += Math.cos(this.heading) * this.speed * dt;

    // Per-node acoustic detection — each node hears independently, with hysteresis so a
    // track doesn't chatter right at a node's edge.
    for (const n of NODES) {
      const d = Math.hypot(this.x - n.x, this.y - n.y);
      if (!this.heardBy[n.id] && d <= this.acousticRange) this.heardBy[n.id] = true;
      else if (this.heardBy[n.id] && d > this.acousticRange * HYSTERESIS) this.heardBy[n.id] = false;
    }

    // Lifecycle: respawn once it reaches the asset, runs back out, or ages out.
    const r2 = this.rangeC();
    if (r2 < ARRIVE_R || r2 > DESPAWN_R || this.age > MAX_LIFETIME) this.spawn();
  }

  private detectingNodes(): string[] {
    return NODES.filter((n) => this.heardBy[n.id]).map((n) => n.id);
  }

  /** Null when no node hears it → simply not on the picture this tick. */
  toContact(ts: number): Contact | null {
    const nodes = this.detectingNodes();
    if (nodes.length === 0) return null;
    const fused = nodes.length >= 2; // ≥2 crossing bearings → a triangulated fix (the math
    // needs only two; this resolves tracks farther out + more consistently than ≥3)
    const range = this.rangeC();
    const bearing = ((Math.atan2(this.x, this.y) * 180) / Math.PI + 360) % 360;
    const elevation = (Math.atan2(this.alt, range) * 180) / Math.PI;
    // ALWAYS emit a cone per hearing node — the node's bearing lock, drawn until that node
    // loses the drone. A track is bearing-only (no point) until ≥3 cones overlap; then it
    // also gets the triangulated fix (lat/lon + range), and the map recolours the cones
    // from yellow → red. The cones persist through and after triangulation.
    const cones = nodes.map((id) => {
      const n = NODES.find((nn) => nn.id === id) ?? NODES[0];
      const br = ((Math.atan2(this.x - n.x, this.y - n.y) * 180) / Math.PI + 360) % 360;
      return { node: id, bearing_deg: Math.round(br * 10) / 10, range_m: Math.round(this.acousticRange) };
    });
    let lat: number | null = null;
    let lon: number | null = null;
    if (fused) {
      [lat, lon] = projectXY(this.x, this.y);
    }
    // Confidence tracks acoustic SNR at the nearest node (closer = louder).
    const nearest = Math.min(...NODES.map((n) => Math.hypot(this.x - n.x, this.y - n.y)));
    const frac = clamp((this.acousticRange - nearest) / this.acousticRange, 0, 1);
    const confidence = clamp(0.25 + 0.65 * frac + rand(-0.04, 0.04), 0.15, 0.97);
    return {
      id: this.id,
      kind: "unknown", // acoustic cue only; the PTZ owns confirmation
      source: "acoustic",
      bearing_deg: Math.round(bearing * 10) / 10,
      elevation_deg: Math.round(elevation * 10) / 10,
      range_m: fused ? Math.round(range) : null, // no range until ≥3 nodes triangulate
      lat: lat == null ? null : Math.round(lat * 1e5) / 1e5,
      lon: lon == null ? null : Math.round(lon * 1e5) / 1e5,
      confidence: Math.round(confidence * 100) / 100,
      nodes,
      cones,
      ts,
    };
  }
}

/** Advances the ingressing drones and yields the ones currently heard by ≥1 node. */
export class MockContactSource {
  private drones: Drone[];
  private last: number; // monotonic seconds (performance.now)

  constructor(nDrones = 14) {
    // Stagger the opening wave just beyond detection so the site loads EMPTY, then cones
    // start ~1–2 s later and build up over the next ~25 s.
    this.drones = Array.from(
      { length: nDrones },
      (_, i) => new Drone(INITIAL_MARGIN_BASE + i * INITIAL_MARGIN_STEP + rand(0, INITIAL_MARGIN_JITTER)),
    );
    this.last = performance.now() / 1000;
  }

  step(): Contact[] {
    const now = performance.now() / 1000;
    const dt = Math.min(now - this.last, 2); // clamp so a backgrounded tab can't jump
    this.last = now;
    const ts = Date.now() / 1000; // epoch seconds, matches the backend `ts`
    const out: Contact[] = [];
    for (const d of this.drones) {
      d.step(dt, now);
      const c = d.toContact(ts);
      if (c) out.push(c);
    }
    return out;
  }
}
