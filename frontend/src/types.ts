// Mirror of the backend `Contact` model (app/models.py). Keep in sync.

export type ContactKind = "unknown" | "drone";
export type Source = "acoustic" | "vision" | "fusion";

export interface Contact {
  id: string;
  kind: ContactKind;
  source: Source;
  bearing_deg: number;
  elevation_deg: number | null;
  range_m: number | null;
  lat: number | null;
  lon: number | null;
  confidence: number;
  // Ids of the sensor nodes currently hearing this contact (demo/fusion metadata; the
  // backend may omit it). <3 nodes → not yet triangulated; ≥3 → a fused fix with range.
  nodes?: string[];
  // One acoustic cone per node currently hearing this contact: the bearing the node
  // measured (± a fixed DoA uncertainty) out to its hearing range. Emitted for EVERY
  // detected contact and kept until a node loses it. The map draws these as translucent
  // wedges — yellow (bearing lock only) until ≥3 overlap, then red (range lock /
  // triangulated, with lat/lon + range_m set).
  cones?: Array<{ node: string; bearing_deg: number; range_m: number }>;
  ts: number;
}
