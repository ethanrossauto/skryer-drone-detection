// First-line access control for the public briefing endpoint. The endpoint calls a
// paid LLM, so we only answer requests that actually originate from the Skryer demo
// site. A real browser fetch POST always sends an `Origin` header (the Fetch spec
// requires it on non-GET/HEAD requests), so this is invisible to legitimate users
// but blocks the lazy abuse vector — someone curling /api/briefing directly to burn
// the API budget.
//
// This is NOT a substitute for the rate-limit + daily budget (a determined attacker
// can spoof Origin from a script). It's the cheap first filter; the Upstash limiter
// in _ratelimit.ts is the hard ceiling on the bill. Defence in depth.
//
// Allowed origins default to the known prod domains + localhost (any port) for dev,
// and Skryer's own Vercel preview deployments. Override with a comma-separated
// SKRYER_ALLOWED_ORIGINS env var (exact origins, e.g. "https://foo.com,https://bar.com").

const DEFAULT_ALLOWED = [
  "https://skryer.ca",
  "https://www.skryer.ca",
  "https://skryer.vercel.app",
];

const extra = (process.env.SKRYER_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED = new Set([...DEFAULT_ALLOWED, ...extra]);

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED.has(origin)) return true;
  const host = hostnameOf(origin);
  if (!host) return false;
  // Local dev on any port.
  if (host === "localhost" || host === "127.0.0.1") return true;
  // Skryer's own Vercel preview deployments (e.g. skryer-abc123.vercel.app).
  if (/^skryer[a-z0-9-]*\.vercel\.app$/.test(host)) return true;
  return false;
}

/**
 * True if the request looks like it came from the Skryer demo site. Checks the
 * Origin header (always present on a browser POST), falling back to the Referer's
 * origin. A request with neither — e.g. a bare curl — is rejected.
 */
export function isAllowedRequest(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return isAllowedOrigin(origin);

  // No Origin (unusual for a POST) — fall back to the Referer's origin.
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return isAllowedOrigin(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return false;
}
