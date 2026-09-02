import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions, ssoHqTickets } from '../db/schema.js';
import { nowIso } from '../util.js';

/** Tell HQ that an identity session has ended (trap C). */
export interface HqLogoutNotifier {
  revokeSessionsFor(originSessionId: string): Promise<{ ok: boolean; detail: string }>;
}

/** Kill every unconsumed HQ handoff ticket minted from one identity session. */
export function invalidateTicketsForOriginSession(
  db: Db,
  originSessionId: string,
  now: Date = new Date(),
): number {
  if (!originSessionId) return 0;
  const result = db
    .update(ssoHqTickets)
    .set({ consumedAt: now.toISOString() })
    .where(and(eq(ssoHqTickets.originSessionId, originSessionId), isNull(ssoHqTickets.consumedAt)))
    .run();
  return result.changes;
}

export type IdentityRevocationReason =
  | 'logout'
  | 'password_reset'
  | 'recovery'
  | 'account_deactivated';

export type IdentitySessionFilter = { sessionId: string } | { userId: string };

export interface IdentityRevocation {
  reason: IdentityRevocationReason;
  /** Ordered for HQ propagation: sessions most likely to back a live HQ cookie first. */
  originSessionIds: string[];
  ticketsInvalidated: number;
}

export function noIdentityRevocation(reason: IdentityRevocationReason): IdentityRevocation {
  return { reason, originSessionIds: [], ticketsInvalidated: 0 };
}

interface RevokedSessionCandidate {
  id: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * Order notifications by the identity session's expiry, newest first.
 *
 * A derived HQ session can only be created while its origin identity session is
 * still live: ticket redemption checks origin-session liveness. HQ's own cookie
 * then lives at most 60 minutes. Therefore an identity session that expired a
 * long time ago cannot be more urgent than one that is live now or expired only
 * recently. Sorting by `expiresAt` guarantees the bounded notifier workers and
 * deadline are spent on the sessions that can still back live HQ authority
 * before an unbounded backlog of ancient, naturally-expired rows.
 *
 * We intentionally do NOT drop old rows from local revocation: every selected
 * identity session is still marked revoked and has its unconsumed tickets
 * invalidated. This function only controls the order in which HQ is notified.
 *
 * An unparseable timestamp is treated as highest risk and goes first. Unknown
 * state must fail safe, never be buried behind rows we know are stale.
 */
function compareHqRevocationPriority(a: RevokedSessionCandidate, b: RevokedSessionCandidate): number {
  const aExpiry = Date.parse(a.expiresAt);
  const bExpiry = Date.parse(b.expiresAt);
  const aExpiryKnown = Number.isFinite(aExpiry);
  const bExpiryKnown = Number.isFinite(bExpiry);

  if (aExpiryKnown !== bExpiryKnown) return aExpiryKnown ? 1 : -1;
  if (aExpiryKnown && bExpiryKnown && aExpiry !== bExpiry) return bExpiry - aExpiry;

  const aCreated = Date.parse(a.createdAt);
  const bCreated = Date.parse(b.createdAt);
  const aCreatedKnown = Number.isFinite(aCreated);
  const bCreatedKnown = Number.isFinite(bCreated);

  if (aCreatedKnown !== bCreatedKnown) return aCreatedKnown ? 1 : -1;
  if (aCreatedKnown && bCreatedKnown && aCreated !== bCreated) return bCreated - aCreated;

  return a.id.localeCompare(b.id);
}

/**
 * End identity sessions and everything derived from them on THIS side.
 *
 * Local revocation remains exhaustive. The returned ids are priority-ordered so
 * the bounded HQ propagation step cannot let an ancient stale-session backlog
 * starve sessions that may still back live HQ cookies.
 */
export function revokeIdentitySessions(
  db: Db,
  filter: IdentitySessionFilter,
  reason: IdentityRevocationReason,
  now: string = nowIso(),
): IdentityRevocation {
  const selected = db
    .select({ id: sessions.id, createdAt: sessions.createdAt, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(
      and(
        'sessionId' in filter
          ? eq(sessions.id, filter.sessionId)
          : eq(sessions.userId, filter.userId),
        isNull(sessions.revokedAt),
      ),
    )
    .all();

  if (selected.length === 0) return noIdentityRevocation(reason);

  let ticketsInvalidated = 0;
  for (const row of selected) {
    db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, row.id)).run();
    ticketsInvalidated += invalidateTicketsForOriginSession(db, row.id, new Date(now));
  }

  const prioritized = [...selected].sort(compareHqRevocationPriority);
  return {
    reason,
    originSessionIds: prioritized.map((row) => row.id),
    ticketsInvalidated,
  };
}

export interface IdentityRevocationSink {
  logoutNotifier?: HqLogoutNotifier;
  audit?: (line: string) => void;
}

export const REVOCATION_PROPAGATION_CONCURRENCY = 8;
export const REVOCATION_PROPAGATION_DEADLINE_MS = 10_000;

export interface IdentityRevocationPropagationOptions {
  concurrency?: number;
  deadlineMs?: number;
}

const AUDIT_ID_SAMPLE = 20;

function sampleIds(ids: readonly string[]): string {
  if (ids.length <= AUDIT_ID_SAMPLE) return ids.join(', ');
  return `${ids.slice(0, AUDIT_ID_SAMPLE).join(', ')}, and ${ids.length - AUDIT_ID_SAMPLE} more`;
}

/**
 * Tell HQ that these identity sessions are dead.
 *
 * At most `concurrency` calls are in flight and one deadline bounds the entire
 * operation. `revokeIdentitySessions` supplies ids in security-priority order,
 * so old stale rows cannot consume the bounded worker slots before sessions that
 * may still back a live HQ cookie.
 */
export async function propagateIdentityRevocation(
  ssoHq: IdentityRevocationSink | undefined,
  revocation: IdentityRevocation,
  options: IdentityRevocationPropagationOptions = {},
): Promise<void> {
  const audit = ssoHq?.audit ?? (() => {});
  if (revocation.ticketsInvalidated > 0) {
    audit(
      `[sso] ${revocation.ticketsInvalidated} unredeemed HQ ticket(s) invalidated by ` +
        `${revocation.reason}`,
    );
  }

  const notifier = ssoHq?.logoutNotifier;
  if (!notifier) return;
  const ids = revocation.originSessionIds;
  if (ids.length === 0) return;

  const deadlineMs = Math.max(1, options.deadlineMs ?? REVOCATION_PROPAGATION_DEADLINE_MS);
  const concurrency = Math.max(1, options.concurrency ?? REVOCATION_PROPAGATION_CONCURRENCY);

  let expired = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<{ kind: 'deadline' }>((resolve) => {
    deadlineTimer = setTimeout(() => {
      expired = true;
      resolve({ kind: 'deadline' });
    }, deadlineMs);
    deadlineTimer.unref?.();
  });

  const attempt = async (originSessionId: string): Promise<{ ok: boolean; detail: string }> => {
    try {
      return await notifier.revokeSessionsFor(originSessionId);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : 'notifier threw' };
    }
  };

  let next = 0;
  let confirmed = 0;
  let failed = 0;
  const unconfirmed: string[] = [];

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= ids.length) return;
      const originSessionId = ids[index]!;
      if (expired) {
        unconfirmed.push(originSessionId);
        continue;
      }

      const outcome = await Promise.race([
        attempt(originSessionId).then((result) => ({ kind: 'settled' as const, result })),
        deadlineReached,
      ]);

      if (outcome.kind === 'deadline') {
        unconfirmed.push(originSessionId);
        continue;
      }

      const { result } = outcome;
      if (result.ok) {
        confirmed += 1;
        audit(
          `[sso] HQ sessions revoked for identity session ${originSessionId} (${revocation.reason})`,
        );
      } else {
        failed += 1;
        audit(
          `[sso] WARNING: could not revoke HQ sessions for ${originSessionId} ` +
            `(${revocation.reason}: ${result.detail}). They remain valid until their own expiry.`,
        );
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()),
    );
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }

  const clean = confirmed === ids.length;
  audit(
    `[sso] HQ revocation propagation (${revocation.reason}): ${confirmed} of ${ids.length} ` +
      `identity session(s) confirmed, ${failed} refused or unreachable, ${unconfirmed.length} ` +
      `not confirmed within ${deadlineMs}ms` +
      (clean
        ? '.'
        : '. Anything not confirmed remains valid at HQ until its own expiry.' +
          (unconfirmed.length > 0 ? ` Not confirmed: ${sampleIds(unconfirmed)}.` : '')),
  );
}
