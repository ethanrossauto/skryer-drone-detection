// Abuse protection for the public briefing endpoint. The endpoint calls a paid LLM,
// so a public URL needs a real cap. Two layers, both backed by Upstash Redis (free
// tier, edge-compatible REST):
//   1. per-IP sliding window — stops one client looping the endpoint.
//   2. a global daily budget — a hard ceiling on total briefings/day, so even broad
//      abuse can't run up an unbounded bill.
//
// If Upstash isn't configured (env vars absent) the limiter is a permissive no-op:
// the demo still works, protected only by the client-side material-change throttle
// and the hard max_tokens. Configure Upstash before sharing the link widely.

import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Accept either naming: the Upstash-direct vars, or the KV_REST_API_* vars that
// Vercel's Upstash/Marketplace integration auto-injects (same REST endpoint + a
// read-write token — we need writes for the daily-budget counter).
const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

// Tunables (override via env on Vercel).
const PER_IP = Number(process.env.SKRYER_IP_LIMIT ?? "12"); // requests / window
const WINDOW = (process.env.SKRYER_IP_WINDOW ?? "60 s") as `${number} ${"s" | "m"}`;
const DAILY_BUDGET = Number(process.env.SKRYER_DAILY_BUDGET ?? "500"); // briefings / day

const redis = url && token ? new Redis({ url, token }) : null;
const ipLimiter = redis
  ? new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(PER_IP, WINDOW),
      prefix: "skryer:ip",
      analytics: false,
    })
  : null;

export interface LimitResult {
  ok: boolean;
  reason?: "rate_limited" | "daily_budget";
}

export async function checkLimits(ip: string): Promise<LimitResult> {
  // No store configured → rely on the client throttle + max_tokens. Allow.
  if (!redis || !ipLimiter) return { ok: true };

  const perIp = await ipLimiter.limit(ip);
  if (!perIp.success) return { ok: false, reason: "rate_limited" };

  // Global daily budget — a single counter keyed by UTC date, ~26 h TTL.
  const dayKey = `skryer:budget:${new Date().toISOString().slice(0, 10)}`;
  const used = await redis.incr(dayKey);
  if (used === 1) await redis.expire(dayKey, 60 * 60 * 26);
  if (used > DAILY_BUDGET) return { ok: false, reason: "daily_budget" };

  return { ok: true };
}
