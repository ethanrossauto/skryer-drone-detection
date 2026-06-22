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
  ts: number;
}
