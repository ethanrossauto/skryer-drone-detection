// Threat ranking + material-change signature — client-side ports of the backend
// `derive_kinematics` / `_threat_key` / `picture_signature` (app/briefing.py).
//
// Used to (a) order the track list highest-threat-first and (b) decide when the
// picture has *materially* changed enough to ask for a fresh briefing — the same
// throttle the Python `/ws/briefing` loop applies, so the demo doesn't hammer the
// LLM on every tick.

import type { Contact } from "../types";

// Range bands (metres). A contact crossing a band is a material change; drift
// within a band is not.
const RANGE_BANDS = [100, 300, 600, 1000];

export function rangeBand(rangeM: number | null): number {
  if (rangeM == null) return -1;
  for (let i = 0; i < RANGE_BANDS.length; i++) {
    if (rangeM <= RANGE_BANDS[i]) return i;
  }
  return RANGE_BANDS.length;
}

// Larger tuple == higher threat: vision-confirmed > acoustic-only; then higher
// confidence; then shorter range (unknown range sorts last).
function threatKey(c: Contact): [number, number, number] {
  const confirmed = c.kind === "drone" ? 1 : 0;
  const rangePriority = c.range_m != null ? -c.range_m : -Infinity;
  return [confirmed, Math.round(c.confidence * 1000) / 1000, rangePriority];
}

export function rankContacts(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => {
    const ka = threatKey(a);
    const kb = threatKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  });
}

/** A stable string signature that changes only on a *material* move: a new/dropped
 *  contact, a kind change (acoustic cue -> confirmed drone), or a range-band cross. */
export function pictureSignature(contacts: Contact[]): string {
  return contacts
    .map((c) => `${c.id}:${c.kind}:${rangeBand(c.range_m)}`)
    .sort()
    .join("|");
}
