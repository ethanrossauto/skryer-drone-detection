import type { Contact } from "../types";
import { useBriefing } from "../hooks/useBriefing";

/** Format an epoch-seconds timestamp as HH:MM:SS for the "as of" staleness label. */
function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * Streamed natural-language operator briefing. Deliberately rendered as a distinct,
 * subordinate block beneath the live track list — it narrates the picture, it is not
 * the picture. The "as of" timestamp makes its lag relative to the map explicit.
 */
export function BriefingPanel({ contacts }: { contacts: Contact[] }) {
  const { text, streaming, asOf, error } = useBriefing(contacts);

  return (
    <section className="briefing">
      <header className="briefing__head">
        <h2>Briefing</h2>
        <span className="briefing__meta">
          {streaming ? "narrating…" : asOf ? `as of ${clock(asOf)}` : ""}
        </span>
      </header>

      <p className="briefing__body">
        {text || <span className="briefing__placeholder">Awaiting first briefing…</span>}
        {streaming && <span className="briefing__cursor">▍</span>}
      </p>

      {error && (
        <p className="briefing__error">Narration unavailable — showing last briefing.</p>
      )}
    </section>
  );
}
