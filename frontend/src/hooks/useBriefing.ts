import { useEffect, useRef, useState } from "react";
import type { Contact } from "../types";
import type { ConnState } from "./useContacts";
import { pictureSignature, rankContacts } from "../lib/threat";

const WS_URL =
  import.meta.env.VITE_BRIEFING_WS_URL ?? "ws://localhost:8000/ws/briefing";

// Demo mode: the briefing comes from a serverless function (default /api/briefing)
// driven by the client's own contacts, instead of the backend WebSocket.
const DEMO = import.meta.env.VITE_DEMO_MODE === "1";
const HTTP_URL = import.meta.env.VITE_BRIEFING_URL ?? "/api/briefing";

// Don't re-brief on every tick: only on a material picture change, debounced to
// this interval (≥10 s between briefings) — keeps the panel readable and the API
// spend low.
const MIN_INTERVAL_MS = 10_000;
const SKY_CLEAR = "Sky clear, no contacts.";

export interface BriefingState {
  text: string; // the latest (or streaming) briefing
  streaming: boolean; // true while tokens are arriving
  asOf: number | null; // epoch seconds the briefing was generated (for staleness)
  error: string | null; // last model error, if any (panel keeps the last good text)
  conn: ConnState;
}

interface Frame {
  type: "briefing_start" | "briefing_delta" | "briefing_end" | "briefing_error";
  text?: string;
  ts?: number;
  message?: string;
}

/**
 * Subscribe to the streamed LLM operator briefing. This is the narration layer —
 * it lags the map slightly and is purely additive; the contact feed (useContacts)
 * is the source of truth.
 *
 * In demo mode it POSTs the live contacts to a serverless function and streams the
 * response; otherwise it subscribes to the backend `/ws/briefing` WebSocket (which
 * runs its own mock source, so `contacts` is ignored on that path).
 */
export function useBriefing(contacts: Contact[]): BriefingState {
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>(DEMO ? "open" : "connecting");

  // --- WebSocket path (local backend dev) -------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  useEffect(() => {
    if (DEMO) return;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      setConn("connecting");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConn("open");
      ws.onmessage = (ev) => {
        let frame: Frame;
        try {
          frame = JSON.parse(ev.data) as Frame;
        } catch {
          return; // ignore malformed frames
        }
        switch (frame.type) {
          case "briefing_start":
            setError(null);
            setStreaming(true);
            setText("");
            if (frame.ts != null) setAsOf(frame.ts);
            break;
          case "briefing_delta":
            setText((t) => t + (frame.text ?? ""));
            break;
          case "briefing_end":
            setStreaming(false);
            break;
          case "briefing_error":
            // Keep the last good briefing on screen; just record the error.
            setStreaming(false);
            setError(frame.message ?? "narration unavailable");
            break;
        }
      };
      ws.onclose = () => {
        setConn("closed");
        setStreaming(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  // --- Serverless path (public demo) ------------------------------------------
  const sigRef = useRef<string | null>(null);
  const lastGenRef = useRef(0); // performance.now() ms of the last request
  const busyRef = useRef(false);
  useEffect(() => {
    if (!DEMO) return;

    // Empty sky is answered locally — no request, can never fail on the API.
    if (contacts.length === 0) {
      if (sigRef.current !== "") {
        sigRef.current = "";
        setError(null);
        setStreaming(false);
        setText(SKY_CLEAR);
        setAsOf(Date.now() / 1000);
      }
      return;
    }

    const sig = pictureSignature(contacts);
    const now = performance.now();
    if (sig === sigRef.current) return; // not a material change
    if (busyRef.current) return; // a briefing is already streaming
    if (lastGenRef.current !== 0 && now - lastGenRef.current < MIN_INTERVAL_MS) return;

    sigRef.current = sig;
    lastGenRef.current = now;
    const ranked = rankContacts(contacts);

    void (async () => {
      busyRef.current = true;
      setStreaming(true);
      setError(null);
      setAsOf(Date.now() / 1000);
      // Keep the previous briefing on screen until the first new token arrives.
      let started = false;
      try {
        const res = await fetch(HTTP_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contacts: ranked }),
        });
        if (!res.ok || !res.body) {
          throw new Error(res.status === 429 ? "rate limited" : `briefing ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let acc = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          if (!started) {
            started = true;
            setText("");
          }
          setText(acc);
        }
        setStreaming(false);
      } catch (e) {
        // Degrade gracefully: keep the last good briefing, just record the error.
        setStreaming(false);
        setError(e instanceof Error ? e.message : "narration unavailable");
      } finally {
        busyRef.current = false;
      }
    })();
  }, [contacts]);

  return { text, streaming, asOf, error, conn };
}
