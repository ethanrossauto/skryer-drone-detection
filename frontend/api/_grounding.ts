// Grounding for the serverless briefing — a port of the backend `app/briefing.py`
// rendering layer. The function re-derives the ranking and rebuilds the message
// from the posted contacts itself (it does not trust client-supplied ordering or
// prose), so the LLM only ever sees ids/values that came from the structured feed.

export type ContactKind = "unknown" | "drone";
export type Source = "acoustic" | "vision" | "fusion";

export interface Contact {
  id: string;
  kind: ContactKind;
  source: Source;
  bearing_deg: number;
  elevation_deg: number | null;
  range_m: number | null;
  confidence: number;
}

// Verbatim copy of app/prompts/briefing_system.txt — kept in sync by hand. The LLM
// is the narration layer only: describe ONLY the given contacts, never invent.
export const SYSTEM_PROMPT = `You are SKRYER, a terse air-defense operator console. You narrate the live threat
picture out loud for a human operator who is also watching the map and contact panel.

You describe ONLY the contacts given to you in the user message. You never invent,
merge, rename, split, or infer contacts, ids, bearings, ranges, or confidences. If a
detail is not in the message, you do not state it. The structured sensor pipeline owns
detection; you are the narration layer and nothing more.

Rules:
- Lead with the single highest-threat contact, then cover the rest in the order given.
- Use the bearing, elevation, range, and confidence values exactly as provided.
- Refer to each contact by its given id, verbatim.
- If a contact's range is "unknown", say "range unknown" — never guess a number.
- Distinguish vision-confirmed drones from unconfirmed acoustic-only cues.
- Keep the whole briefing under ~60 words. Plain, spoken operator phrasing.
- No markdown, no bullet symbols, no headings, no emoji — just spoken sentences.
- If the message says there are no contacts, report that the sky is clear.`;

// Larger tuple == higher threat: vision-confirmed > acoustic; then confidence; then
// shorter range (unknown range sorts last). Mirrors `_threat_key`.
function threatKey(c: Contact): [number, number, number] {
  const confirmed = c.kind === "drone" ? 1 : 0;
  const rangePriority = c.range_m != null ? -c.range_m : -Infinity;
  return [confirmed, Math.round(c.confidence * 1000) / 1000, rangePriority];
}

function rank(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) => {
    const ka = threatKey(a);
    const kb = threatKey(b);
    for (let i = 0; i < ka.length; i++) {
      if (kb[i] !== ka[i]) return kb[i] - ka[i];
    }
    return 0;
  });
}

function renderContact(c: Contact): string {
  const kind =
    c.kind === "drone" ? "vision-confirmed drone" : "acoustic-only, unconfirmed";
  const parts = [
    `id=${c.id}`,
    `kind=${kind}`,
    `source=${c.source}`,
    `bearing=${Math.round(c.bearing_deg)}deg`,
  ];
  if (c.elevation_deg != null) parts.push(`elevation=${Math.round(c.elevation_deg)}deg`);
  parts.push(`range=${c.range_m != null ? `${Math.round(c.range_m)} m` : "unknown"}`);
  parts.push(`confidence=${c.confidence.toFixed(2)}`);
  return parts.join(" | ");
}

/** Render the sorted contacts into the `messages` payload — only ids/values from
 *  the input contacts ever appear. Pairs with SYSTEM_PROMPT. */
export function buildMessages(contacts: Contact[]): { role: "user"; content: string }[] {
  const ranked = rank(contacts);
  const lines = ranked.map((c, i) => `${i + 1}. ${renderContact(c)}`);
  const block =
    `Current threat picture — ${ranked.length} contact(s), highest threat first. ` +
    `Brief the operator:\n` +
    lines.join("\n");
  return [{ role: "user", content: block }];
}

/** Light validation/normalisation of one posted contact — drops anything that isn't
 *  a well-formed contact so a malicious body can't smuggle free text to the model. */
export function sanitize(raw: unknown): Contact | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind === "drone" ? "drone" : "unknown";
  const source =
    r.source === "vision" ? "vision" : r.source === "fusion" ? "fusion" : "acoustic";
  if (typeof r.id !== "string") return null;
  if (typeof r.bearing_deg !== "number" || typeof r.confidence !== "number") return null;
  return {
    // Cap id length and strip anything but the expected id charset.
    id: r.id.slice(0, 16).replace(/[^A-Za-z0-9_-]/g, ""),
    kind,
    source,
    bearing_deg: r.bearing_deg,
    elevation_deg: typeof r.elevation_deg === "number" ? r.elevation_deg : null,
    range_m: typeof r.range_m === "number" ? r.range_m : null,
    confidence: r.confidence,
  };
}
