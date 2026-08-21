import { AppError } from '../util.js';

/**
 * Minimal in-memory abuse protection for the UNAUTHENTICATED auth surface
 * (login, recovery). Fixed window, per ip+kind+identifier, counting FAILED
 * attempts only — successful sign-ins reset the bucket, so normal use is
 * never throttled. In-memory is correct for JENIFY's local-first single-
 * process deployment; a restart clears state, which is acceptable because
 * the codes/passwords being protected have large keyspaces.
 */

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 10;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function bucketFor(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing && existing.resetAt > now) return existing;
  const fresh: Bucket = { count: 0, resetAt: now + WINDOW_MS };
  buckets.set(key, fresh);
  return fresh;
}

/** Throws 429 when the key has exhausted its failure budget for this window. */
export function assertNotRateLimited(key: string): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt > now && bucket.count >= MAX_FAILURES) {
    const minutes = Math.max(1, Math.ceil((bucket.resetAt - now) / 60_000));
    throw new AppError(
      429,
      'rate_limited',
      `Too many failed attempts. Try again in about ${minutes} minute(s).`,
    );
  }
  // opportunistic cleanup so the map never grows unbounded
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
}

export function recordAuthFailure(key: string): void {
  bucketFor(key, Date.now()).count += 1;
}

export function clearAuthFailures(key: string): void {
  buckets.delete(key);
}

/** Test hook — resets all rate-limit state. */
export function _resetRateLimiter(): void {
  buckets.clear();
}
