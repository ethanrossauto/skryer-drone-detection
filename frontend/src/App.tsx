import { useEffect, useRef, useState } from "react";
import { BriefingPanel } from "./components/BriefingPanel";
import { MapView } from "./components/MapView";
import { useContacts } from "./hooks/useContacts";
import { rankContacts } from "./lib/threat";
import { ICONS, iconDataUrl } from "./lib/icons";
import { SLEW_DEG_PER_S } from "./lib/ptz";
import { PTZ_RANGE_M } from "./lib/geo";
import type { Contact } from "./types";

// The premium ($50K-class) PTZ can positively ID a small drone out to the outer node ring
// (geo.PTZ_RANGE_M). A track beyond this is heard/tracked but stays an unconfirmed
// acoustic cue until it closes inside camera range.

const LEGEND: Array<{ icon: string; label: string }> = [
  { icon: ICONS.asset, label: "Protected site — critical infrastructure" },
  { icon: ICONS.droneUnknown, label: "Triangulated track — range lock (red)" },
  { icon: ICONS.droneConfirmed, label: "Visual ID — confirmed drone (green)" },
  { icon: ICONS.array, label: "Sensor node — 4-mic array (hover to expand)" },
  { icon: ICONS.camera, label: "PTZ camera — visual ID (◂ ▸)" },
];

function Legend() {
  return (
    <div className="legend">
      {LEGEND.map((row) => (
        <div className="legend__row" key={row.icon}>
          <img className="legend__icon" src={iconDataUrl(row.icon)} alt="" />
          <span>{row.label}</span>
        </div>
      ))}
    </div>
  );
}

const CONN_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  open: "Live",
  closed: "Offline",
};

const KIND_LABEL: Record<string, string> = {
  unknown: "Acoustic cue",
  drone: "Drone — confirmed",
};

// Realistic cue-to-ID budget for the PTZ to positively identify ONE drone in AUTO. A
// real cheap 20× PTZ (Sunba 405-D20X class) cued to a fused track must: slew to the
// bearing, drive the optical zoom in + refocus, then hold a stable frame long enough
// for a confident ID. We model that total, then move on to the next target — the camera
// sweeps and confirms rather than staying glued to the closest drone forever.
// Closed-loop visual servoing (no dependable AbsoluteMove), so these are conservative.
// SLEW_DEG_PER_S is shared with the map's pointing-ray animation (lib/ptz).
const ZOOM_FOCUS_MS = 2200; // drive the 20× optical zoom in + autofocus settle
const ID_HOLD_MS = 1600; // hold a stable frame for a confident classification
const MIN_SLEW_MS = 400; // even an on-axis target needs a beat to settle
// e.g. a 90° swing ≈ 2.0 s slew + 2.2 s zoom + 1.6 s hold ≈ 5.8 s to confirm one drone.

// AUTO target cost = slew-time(s) − range_m / FAR_BONUS_SCALE. The range bonus (~0–2 s
// across 0–2 km) only ever breaks ties between similarly-cheap slews, so slew dominates
// (the camera won't pan far for a slightly-closer track) while still preferring to ID the
// farther-out track first when the angular cost is comparable.
const FAR_BONUS_SCALE = 1000;

/** How long the camera needs to slew + zoom + ID a target, given where it was last
 *  pointed (degrees). Returns the full cue-to-confirm budget in ms. */
function confirmBudgetMs(fromBearing: number | null, toBearing: number): number {
  const slewDeg = fromBearing == null ? 0 : Math.abs(((toBearing - fromBearing + 540) % 360) - 180);
  const slewMs = Math.max(MIN_SLEW_MS, (slewDeg / SLEW_DEG_PER_S) * 1000);
  return slewMs + ZOOM_FOCUS_MS + ID_HOLD_MS;
}

type PtzMode = "auto" | "manual";

/** Detected contacts (have a fix), closest first — the camera's natural priority. */
function byRange(contacts: Contact[]): Contact[] {
  return contacts
    .filter((c) => c.range_m != null && c.lat != null && c.lon != null)
    .sort((a, b) => (a.range_m as number) - (b.range_m as number));
}

export default function App() {
  const { contacts, conn } = useContacts();

  // PTZ control: auto-tracks the closest drone; arrow keys take manual control of the
  // slew; "a" returns to auto.
  const [mode, setMode] = useState<PtzMode>("auto");
  const [manualId, setManualId] = useState<string | null>(null);
  const [activePtzId, setActivePtzId] = useState<string | null>(null);
  // Ids the PTZ has confirmed by dwell (sticky until the track drops out of detection).
  const [confirmed, setConfirmed] = useState<Set<string>>(() => new Set());

  // Refs so the stable key handler + the target picker always see the latest values
  // without re-subscribing.
  const modeRef = useRef(mode);
  const manualIdRef = useRef(manualId);
  const activeRef = useRef(activePtzId);
  const orderRef = useRef<string[]>([]);
  const confirmedRef = useRef(confirmed);
  const contactsRef = useRef(contacts);
  // Where the PTZ is currently pointed (bearing °), so the next slew's duration scales
  // with how far it has to swing. Null = at rest / home.
  const lastBearingRef = useRef<number | null>(null);
  modeRef.current = mode;
  manualIdRef.current = manualId;
  activeRef.current = activePtzId;
  confirmedRef.current = confirmed;
  contactsRef.current = contacts;
  orderRef.current = byRange(contacts).map((c) => c.id);

  // Is the PTZ's current target close enough to actually be identified? Gates both the
  // confirm timer and how long AUTO stays locked on a target.
  const activeContact = activePtzId ? contacts.find((c) => c.id === activePtzId) : undefined;
  const activeInRange =
    activeContact?.range_m != null && (activeContact.range_m as number) <= PTZ_RANGE_M;

  // Pick the PTZ target each time the picture updates.
  useEffect(() => {
    const detected = byRange(contacts); // fused tracks, closest first

    if (mode === "manual") {
      // Hold the manual lock until that target drops out, then resume auto.
      if (manualId && detected.some((c) => c.id === manualId)) {
        setActivePtzId(manualId);
        return;
      }
      setMode("auto");
    }

    // AUTO efficient sweep: the goal is to maximize visual IDs and grab them as FAR out
    // as possible, so the camera sweeps the FOV path — confirming tracks it's already
    // pointed near (cheap slew), preferring farther ones — instead of chasing whichever
    // is marginally closest and wasting time panning back and forth.
    // - Finish an ID in progress first (stay on current while unconfirmed AND in range).
    // - Else pick the unconfirmed, in-range track with the lowest cost = slew-time to it
    //   MINUS a range bonus: low slew dominates (don't pan far for a slightly-closer track
    //   behind you), and among similar slews the farther-out track wins (ID it early).
    // - If none are confirmable in range, pre-track the nearest unconfirmed track.
    // - If nothing is left unconfirmed, park (don't revisit confirmed drones).
    const cur = activeRef.current;
    const curC = cur ? detected.find((c) => c.id === cur) : undefined;
    const curInRange = curC?.range_m != null && (curC.range_m as number) <= PTZ_RANGE_M;
    if (curC && !confirmedRef.current.has(cur as string) && curInRange) {
      setActivePtzId(cur);
      return;
    }

    const aim = curC?.bearing_deg ?? lastBearingRef.current; // where the camera is pointed now
    const cost = (c: Contact) => {
      const slewDeg = aim == null ? 0 : Math.abs((((c.bearing_deg - aim) % 360) + 540) % 360 - 180);
      return slewDeg / SLEW_DEG_PER_S - (c.range_m as number) / FAR_BONUS_SCALE;
    };
    const confirmable = detected.filter(
      (c) => !confirmedRef.current.has(c.id) && (c.range_m as number) <= PTZ_RANGE_M,
    );
    if (confirmable.length) {
      const next = confirmable.reduce((b, c) => (cost(c) < cost(b) ? c : b));
      setActivePtzId(next.id);
      return;
    }
    const nextUnconfirmed = detected.find((c) => !confirmedRef.current.has(c.id));
    setActivePtzId(nextUnconfirmed?.id ?? null);
  }, [contacts, mode, manualId]);

  // Vision confirm: the PTZ can only positively ID a drone once it's within camera range.
  // When the target is in range, run a realistic cue-to-ID budget (slew + zoom + hold);
  // when it elapses, confirm — but only if the drone is STILL the target and STILL in
  // range. Out-of-range targets are tracked but never confirmed. The effect re-runs when
  // the target changes or when it crosses the range threshold (activeInRange), so the
  // timer starts the moment an approaching drone enters PTZ range.
  useEffect(() => {
    const id = activePtzId;
    if (!id || confirmedRef.current.has(id) || !activeInRange) return;
    const target = contactsRef.current.find((c) => c.id === id);
    const toBearing = target ? target.bearing_deg : (lastBearingRef.current ?? 0);
    const budget = confirmBudgetMs(lastBearingRef.current, toBearing);
    const t = setTimeout(() => {
      const now = contactsRef.current.find((c) => c.id === id);
      if (!now || now.range_m == null || now.range_m > PTZ_RANGE_M) return; // drifted out / dropped
      lastBearingRef.current = toBearing; // camera is now pointed here
      setConfirmed((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }, budget);
    return () => clearTimeout(t);
  }, [activePtzId, activeInRange]);

  // Drop confirmations for tracks that have left the picture (so a re-acquired drone
  // must be visually re-confirmed).
  useEffect(() => {
    const present = new Set(contacts.map((c) => c.id));
    setConfirmed((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => (present.has(id) ? next.add(id) : (changed = true)));
      return changed ? next : prev;
    });
  }, [contacts]);

  // Keyboard: ◂ ▸ slews the PTZ manually (closest-first cycle); "a" returns to auto.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "a" || e.key === "A") {
        setMode("auto");
        setManualId(null);
        return;
      }
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const order = orderRef.current;
      if (order.length === 0) return;
      const cur = activeRef.current;
      const i = cur ? order.indexOf(cur) : -1;
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = i < 0 ? (step > 0 ? 0 : order.length - 1) : (i + step + order.length) % order.length;
      setMode("manual");
      setManualId(order[next]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The picture the rest of the UI sees: a track is a confirmed drone only if the PTZ
  // has confirmed it; everything else is an acoustic cue.
  const display: Contact[] = contacts.map((c) =>
    confirmed.has(c.id)
      ? { ...c, kind: "drone", source: "fusion" }
      : { ...c, kind: "unknown", source: "acoustic" },
  );
  const sorted = rankContacts(display);

  return (
    <div className="app">
      <MapView contacts={display} ptzTargetId={activePtzId} />
      <Legend />

      <aside className="panel">
        <header className="panel__head">
          <h1>SKRYER</h1>
          <span className={`status status--${conn}`}>● {CONN_LABEL[conn]}</span>
        </header>

        <div className="panel__ptz">
          <span className="panel__ptz-cam">◉ PTZ</span>
          <span className="panel__ptz-target">{activePtzId ? `▸ ${activePtzId}` : "— scanning"}</span>
          <span className={`panel__ptz-mode panel__ptz-mode--${mode}`}>
            {mode === "auto" ? "AUTO" : "MANUAL"}
          </span>
          <span className="panel__ptz-hint">◂ ▸ slew · A auto</span>
        </div>

        <div className="panel__count">{display.length} contacts</div>

        <ul className="tracklist">
          {sorted.map((c) => (
            <li
              key={c.id}
              className={`track${c.id === activePtzId ? " track--ptz" : ""}`}
              onClick={() => {
                setMode("manual");
                setManualId(c.id);
              }}
            >
              <span className={`track__kind track__kind--${c.kind}`} />
              <span className="track__id">{c.id}</span>
              <span className="track__meta">
                {KIND_LABEL[c.kind]} · brg {Math.round(c.bearing_deg)}°
                {c.range_m != null ? ` · ${Math.round(c.range_m)} m` : ""} ·{" "}
                {Math.round(c.confidence * 100)}%
              </span>
            </li>
          ))}
        </ul>

        <BriefingPanel contacts={display} />
      </aside>
    </div>
  );
}
