import { useEffect, useRef, useState } from "react";
import type { Contact } from "../types";
import { MockContactSource } from "../lib/mockSource";

const WS_URL = import.meta.env.VITE_WS_URL ?? "ws://localhost:8000/ws/contacts";

// Demo mode (set VITE_DEMO_MODE=1 on the public deploy): run the mock contact
// source entirely in the browser — no backend, nothing to keep alive. When the
// flag is off, behaviour is unchanged: connect to the Python `/ws/contacts`.
const DEMO = import.meta.env.VITE_DEMO_MODE === "1";

// Tick rate for the in-browser demo source (matches the backend's 1 Hz feed).
const TICK_MS = 1000;

export type ConnState = "connecting" | "open" | "closed";

/**
 * Subscribe to the live contact feed. In demo mode this is a client-side mock;
 * otherwise it's the backend WebSocket (auto-reconnecting with a short backoff so
 * the UI survives backend restarts during development).
 */
export function useContacts(): { contacts: Contact[]; conn: ConnState } {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [conn, setConn] = useState<ConnState>("connecting");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (DEMO) {
      const source = new MockContactSource();
      setConn("open");
      setContacts(source.step());
      const id = setInterval(() => setContacts(source.step()), TICK_MS);
      return () => clearInterval(id);
    }

    let closed = false;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      setConn("connecting");
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConn("open");
      ws.onmessage = (ev) => {
        try {
          setContacts(JSON.parse(ev.data) as Contact[]);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConn("closed");
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

  return { contacts, conn };
}
