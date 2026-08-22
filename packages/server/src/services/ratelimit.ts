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
// Global per-IP ceiling (red-team H1): a password-spray that varies the
// username never trips the per-username bucket, so cap total failures from one
// source IP across ALL usernames. Higher than the per-username limit so a
// household/office NAT sharing one IP is not locked out by a couple of typos,
// but low enough that spraying dozens of accounts is stopped.
const MAX_FAILURES_PER_SOURCE = 30;

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

/**
 * The source key for a compound `ip|kind|identifier` key: `ip|kind|*`. Failures
 * are counted against both the specific key and this source key, so varying the
 * identifier cannot evade the ceiling.
 */
function sourceKeyOf(key: string): string {
  const firstBar = key.indexOf('|');
  const secondBar = key.indexOf('|', firstBar + 1);
  return secondBar === -1 ? `${key}|*` : `${key.slice(0, secondBar)}|*`;
}

function limitExceeded(key: string, limit: number, now: number): number | null {
  const bucket = buckets.get(key);
  if (bucket && bucket.resetAt > now && bucket.count >= limit) {
    return Math.max(1, Math.ceil((bucket.resetAt - now) / 60_000));
  }
  return null;
}

/** Throws 429 when the key OR its source IP has exhausted its failure budget. */
export function assertNotRateLimited(key: string): void {
  const now = Date.now();
  const minutes =
    limitExceeded(key, MAX_FAILURES, now) ??
    limitExceeded(sourceKeyOf(key), MAX_FAILURES_PER_SOURCE, now);
  if (minutes !== null) {
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
  const now = Date.now();
  bucketFor(key, now).count += 1;
  bucketFor(sourceKeyOf(key), now).count += 1; // also charge the source IP
}

/** Clears the specific key on success. The source-IP ceiling is NOT cleared —
 *  a successful login on one account must not wipe a spray in progress against
 *  others from the same IP. */
export function clearAuthFailures(key: string): void {
  buckets.delete(key);
}

/** Test hook — resets all rate-limit state. */
export function _resetRateLimiter(): void {
  buckets.clear();
}
