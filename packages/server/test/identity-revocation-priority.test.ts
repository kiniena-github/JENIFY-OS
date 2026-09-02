import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sessions } from '../src/db/schema.js';
import {
  propagateIdentityRevocation,
  revokeIdentitySessions,
  type HqLogoutNotifier,
} from '../src/services/identity-revocation.js';
import { testDb } from './helpers.js';

const NOW = '2026-09-02T21:00:00.000Z';
const USER_ID = 'priority-user';
const TENANT_ID = 'priority-tenant';

function addSession(
  db: ReturnType<typeof testDb>,
  id: string,
  expiresAt: string,
  createdAt = '2026-09-01T00:00:00.000Z',
): void {
  db.insert(sessions)
    .values({
      id,
      tenantId: TENANT_ID,
      userId: USER_ID,
      token: `token-${id}`,
      createdAt,
      expiresAt,
      revokedAt: null,
      userAgent: null,
    })
    .run();
}

describe('HQ revocation priority under a stale identity-session backlog', () => {
  it('revokes every local session but orders HQ notifications by newest expiry first', () => {
    const db = testDb();

    // A large backlog of naturally expired, never-revoked sessions. Before this
    // fix their unspecified DB order could consume the bounded notifier workers
    // before a session that may still back a live HQ cookie was even attempted.
    for (let i = 0; i < 120; i += 1) {
      addSession(db, `stale-${String(i).padStart(3, '0')}`, '2026-09-02T17:00:00.000Z');
    }

    // Redemption can only happen while the identity session is live. Because an
    // HQ cookie lasts 60 minutes, this recently-expired origin may still back a
    // live HQ session and must beat the ancient backlog.
    addSession(db, 'recent-expired', '2026-09-02T20:30:00.000Z');
    addSession(db, 'still-live', '2026-09-03T03:00:00.000Z');

    const revocation = revokeIdentitySessions(
      db,
      { userId: USER_ID },
      'password_reset',
      NOW,
    );

    expect(revocation.originSessionIds.slice(0, 2)).toEqual(['still-live', 'recent-expired']);
    expect(revocation.originSessionIds).toHaveLength(122);

    // Priority affects only notification order. Local identity authority is
    // still revoked exhaustively, including every ancient row.
    const rows = db.select().from(sessions).where(eq(sessions.userId, USER_ID)).all();
    expect(rows).toHaveLength(122);
    expect(rows.every((row) => row.revokedAt === NOW)).toBe(true);
  });

  it('does not let hung stale notifications starve recent/live-relevant sessions', async () => {
    const db = testDb();
    for (let i = 0; i < 80; i += 1) {
      addSession(db, `stale-${String(i).padStart(3, '0')}`, '2026-09-02T12:00:00.000Z');
    }
    addSession(db, 'recent-expired', '2026-09-02T20:45:00.000Z');
    addSession(db, 'still-live', '2026-09-03T03:00:00.000Z');

    const revocation = revokeIdentitySessions(
      db,
      { userId: USER_ID },
      'account_deactivated',
      NOW,
    );

    const attempted: string[] = [];
    const notifier: HqLogoutNotifier = {
      async revokeSessionsFor(originSessionId) {
        attempted.push(originSessionId);
        if (originSessionId.startsWith('stale-')) {
          // Simulate an HQ call that never answers. With concurrency=1, a stale
          // row at the front would consume the whole deadline and reproduce the
          // Codex P1 exactly.
          return await new Promise<{ ok: boolean; detail: string }>(() => {});
        }
        return { ok: true, detail: 'revoked' };
      },
    };

    const audit: string[] = [];
    await propagateIdentityRevocation(
      { logoutNotifier: notifier, audit: (line) => audit.push(line) },
      revocation,
      { concurrency: 1, deadlineMs: 25 },
    );

    expect(attempted.slice(0, 2)).toEqual(['still-live', 'recent-expired']);
    expect(attempted[2]).toMatch(/^stale-/);
    expect(audit.some((line) => line.includes('still-live') && line.includes('revoked'))).toBe(true);
    expect(audit.some((line) => line.includes('recent-expired') && line.includes('revoked'))).toBe(true);
  });

  it('treats an unparseable expiry as high risk instead of burying it behind known-stale rows', () => {
    const db = testDb();
    addSession(db, 'known-stale', '2026-09-01T00:00:00.000Z');
    addSession(db, 'unknown-expiry', 'not-a-timestamp');

    const revocation = revokeIdentitySessions(db, { userId: USER_ID }, 'recovery', NOW);
    expect(revocation.originSessionIds[0]).toBe('unknown-expiry');
  });
});
