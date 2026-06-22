import { BriefingPanel } from "./components/BriefingPanel";
import { MapView } from "./components/MapView";
import { useContacts } from "./hooks/useContacts";
import { rankContacts } from "./lib/threat";

const CONN_LABEL: Record<string, string> = {
  connecting: "Connecting…",
  open: "Live",
  closed: "Offline",
};

const KIND_LABEL: Record<string, string> = {
  unknown: "Acoustic cue",
  drone: "Drone — confirmed",
};

export default function App() {
  const { contacts, conn } = useContacts();
  // Highest-threat first (vision-confirmed > acoustic, then confidence, then range).
  const sorted = rankContacts(contacts);

  return (
    <div className="app">
      <MapView contacts={contacts} />

      <aside className="panel">
        <header className="panel__head">
          <h1>SKRYER</h1>
          <span className={`status status--${conn}`}>● {CONN_LABEL[conn]}</span>
        </header>

        <div className="panel__count">{contacts.length} contacts</div>

        <ul className="tracklist">
          {sorted.map((c) => (
            <li key={c.id} className="track">
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

        <BriefingPanel contacts={contacts} />
      </aside>
    </div>
  );
}
