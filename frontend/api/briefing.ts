// Serverless briefing endpoint (Vercel Edge) — the public-demo replacement for the
// backend `/ws/briefing`. It streams a real claude-haiku-4-5 narration of the posted
// contacts, grounded exactly like the Python version, behind rate-limit + budget caps.
//
// Calls the Anthropic API directly over fetch + SSE rather than the Node SDK: the SDK
// pulls in Node built-ins (node:fs / node:path) the Edge runtime can't load, and the
// Node runtime doesn't accept this Web-standard Request -> streamed Response handler.
// Raw fetch keeps us on Edge (native streaming + Web Response, tiny bundle).
//
// Same guarantees as the backend: empty sky answered locally (no model call); the
// LLM only narrates the structured contacts; failures degrade to "keep last good"
// on the client (the map/track list never depend on this endpoint).

import { buildMessages, sanitize, SYSTEM_PROMPT, type Contact } from "./_grounding";
import { checkLimits } from "./_ratelimit";
import { isAllowedRequest } from "./_origin";

export const config = { runtime: "edge" };

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 300; // ~60 words of operator phrasing; caps cost + runaway output
const SKY_CLEAR = "Sky clear, no contacts.";
const MAX_CONTACTS = 24; // sane upper bound on a single posted picture
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405, headers: TEXT });
  }

  // Access gate: only answer requests from the Skryer demo site itself. Invisible
  // to real users (browsers always send Origin on a POST); blocks direct curl/script
  // hits on the paid endpoint. The rate-limit + daily budget below are the hard cap.
  if (!isAllowedRequest(req)) {
    return new Response("forbidden", { status: 403, headers: TEXT });
  }

  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "anon";
  const limit = await checkLimits(ip);
  if (!limit.ok) {
    return new Response(limit.reason ?? "rate_limited", { status: 429, headers: TEXT });
  }

  let contacts: Contact[] = [];
  try {
    const body = (await req.json()) as { contacts?: unknown };
    const raw = Array.isArray(body?.contacts) ? body.contacts.slice(0, MAX_CONTACTS) : [];
    contacts = raw.map(sanitize).filter((c): c is Contact => c !== null);
  } catch {
    return new Response("bad request", { status: 400, headers: TEXT });
  }

  // Empty sky: answer locally, no model call (can't fail, costs nothing).
  if (contacts.length === 0) {
    return new Response(SKY_CLEAR, { headers: TEXT });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response("narration unavailable", { status: 503, headers: TEXT });
  }

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: buildMessages(contacts),
      stream: true,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    // Surface nothing useful to abusers; the client keeps its last good briefing.
    return new Response("narration unavailable", { status: 502, headers: TEXT });
  }

  // Parse Anthropic's SSE stream and re-emit just the text deltas.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // keep the trailing partial line
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue; // skip "event:" + keepalives
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const evt = JSON.parse(data);
              if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
                controller.enqueue(encoder.encode(evt.delta.text as string));
              }
            } catch {
              // ignore partial/non-JSON lines
            }
          }
        }
      } catch {
        // Best effort: close the stream. A partial briefing simply stops; the client
        // keeps the last good one.
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: TEXT });
}
