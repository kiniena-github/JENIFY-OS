/**
 * Housekeeping and boundedness on the HQ bridge (Phase 2, Stage 2, THIRD Codex
 * correction round).
 *
 * Two findings, one theme: an operation that is correct but unbounded.
 *
 * P1 — every authorize INSERTED a ticket row and nothing ever deleted one.
 * `pruneExpiredTickets` existed and had no caller, so consumed, invalidated and
 * expired tickets accumulated for the life of a deployment on a table the
 * sign-in path reads — carrying a realm, an account, a display name and an
 * identity session id with them.
 *
 * P2 — revocation propagation awaited one notifier call per session in a
 * straight line, each with its own five-second timeout. An account with many
 * sessions, on an HQ that had stopped answering, made a password reset hang for
 * minutes AFTER the local transaction had committed.
 *
 * Both are asserted here against the shapes that actually bite: a table with a
 * backlog, a live ticket that must survive it, and an HQ that never answers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { _resetRateLimiter } from '../src/services/ratelimit.js';
import { testDb, makeTestTenant, type TestTenant } from './helpers.js';
import type { Db } from '../src/db/index.js';
import { ssoHqTickets } from '../src/db/schema.js';
import {
  mintTicket,
  pruneExpiredTickets,
  redeemTicket,
  TICKET_PRUNE_BATCH,
  TICKET_PRUNE_RETENTION_MS,
  SSO_TICKET_TTL_MS,
} from '../src/services/sso-hq.js';
import {
  invalidateTicketsForOriginSession,
  propagateIdentityRevocation,
  REVOCATION_PROPAGATION_CONCURRENCY,
  type HqLogoutNotifier,
  type IdentityRevocation,
} from '../src/services/identity-revocation.js';
import { SSO_HQ_ROUTES, type SsoHqPlane } from '../src/routes/sso-hq.js';
import type { SessionRecord } from '../src/services/auth.js';

const SERVICE_SECRET = 'stage2-dev-test-secret-not-production';
const HQ_ORIGIN = 'https://hq.example';
const HQ_CALLBACK = `${HQ_ORIGIN}/sso/callback`;

let db: Db;
let tenant: TestTenant;

beforeEach(() => {
  _resetRateLimiter();
  db = testDb();
  tenant = makeTestTenant(db, 'SALTA');
  createUser(tenant.sysCtx, {
    username: 'founder.salta',
    displayName: 'The Founder',
    password: 'test-password',
    roleId: tenant.ownerRoleId,
  });
});

function ticketCount(): number {
  return db.select({ id: ssoHqTickets.id }).from(ssoHqTickets).all().length;
}

/** A session shape for the mint path. The prune path never reads the session table. */
function fakeSession(id: string, at: Date): SessionRecord {
  return {
    id,
    user: {
      id: 'acc-1',
      tenantId: tenant.tenantId,
      displayName: 'The Founder',
    } as SessionRecord['user'],
    establishedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + 3_600_000).toISOString(),
  };
}

/** Write a ticket row directly, so a backlog can be built without minting one by one. */
function insertTicketRow(input: {
  id: string;
  expiresAt: Date;
  consumedAt?: Date | null;
  createdAt?: Date;
}): void {
  db.insert(ssoHqTickets)
    .values({
      id: input.id,
      ticketHash: `hash-${input.id}`,
      audience: HQ_ORIGIN,
      redirectUri: HQ_CALLBACK,
      state: 'state-value',
      realmId: tenant.tenantId,
      accountId: 'acc-1',
      displayName: 'The Founder',
      sessionEstablishedAt: (input.createdAt ?? new Date()).toISOString(),
      originSessionId: 'identity-session-1',
      createdAt: (input.createdAt ?? new Date()).toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      consumedAt: input.consumedAt ? input.consumedAt.toISOString() : null,
    })
    .run();
}

describe('dead HQ tickets are collected (third round, Codex P1)', () => {
  it('removes rows that can no longer be redeemed, once the grace window has passed', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    const longAgo = new Date(now.getTime() - 60 * 60_000);
    insertTicketRow({ id: 'expired-long-ago', expiresAt: longAgo });
    insertTicketRow({
      id: 'consumed-long-ago',
      expiresAt: new Date(now.getTime() + 60_000),
      consumedAt: longAgo,
    });
    expect(ticketCount()).toBe(2);

    expect(pruneExpiredTickets(db, now)).toBe(2);
    expect(ticketCount()).toBe(0);
  });

  it('NEVER removes a live ticket', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    // Unconsumed, and still inside its one-minute window: the only kind of row
    // a sign-in in flight depends on.
    insertTicketRow({ id: 'live', expiresAt: new Date(now.getTime() + 30_000) });
    insertTicketRow({ id: 'dead', expiresAt: new Date(now.getTime() - 60 * 60_000) });

    expect(pruneExpiredTickets(db, now)).toBe(1);
    const remaining = db.select({ id: ssoHqTickets.id }).from(ssoHqTickets).all();
    expect(remaining.map((r) => r.id)).toEqual(['live']);
  });

  it('keeps a just-consumed row for the grace window, so a replay is still named exactly', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    insertTicketRow({
      id: 'consumed-a-moment-ago',
      expiresAt: new Date(now.getTime() + 30_000),
      consumedAt: new Date(now.getTime() - 1_000),
    });

    // Inside the retention window: kept, so `redeemTicket` can still answer
    // `ticket_consumed` rather than the vaguer `ticket_unknown`.
    expect(pruneExpiredTickets(db, now)).toBe(0);
    expect(ticketCount()).toBe(1);

    // Past it: collected.
    const later = new Date(now.getTime() + TICKET_PRUNE_RETENTION_MS + 1_000);
    expect(pruneExpiredTickets(db, later)).toBe(1);
    expect(ticketCount()).toBe(0);
  });

  it('collects tickets invalidated by trap E once they are cold', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    insertTicketRow({ id: 'in-flight', expiresAt: new Date(now.getTime() + 30_000) });
    // Sign-out kills unconsumed tickets by marking them consumed.
    expect(invalidateTicketsForOriginSession(db, 'identity-session-1', now)).toBe(1);

    expect(pruneExpiredTickets(db, now)).toBe(0);
    expect(pruneExpiredTickets(db, new Date(now.getTime() + TICKET_PRUNE_RETENTION_MS + 1))).toBe(1);
    expect(ticketCount()).toBe(0);
  });

  it('is bounded: one sweep removes at most its batch size', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    const longAgo = new Date(now.getTime() - 60 * 60_000);
    for (let i = 0; i < 25; i += 1) insertTicketRow({ id: `dead-${i}`, expiresAt: longAgo });

    expect(pruneExpiredTickets(db, now, { limit: 10 })).toBe(10);
    expect(ticketCount()).toBe(15);
    expect(pruneExpiredTickets(db, now, { limit: 10 })).toBe(10);
    expect(pruneExpiredTickets(db, now, { limit: 10 })).toBe(5);
    expect(ticketCount()).toBe(0);
    // The shipped bound is a real number, not an accident of the default.
    expect(TICKET_PRUNE_BATCH).toBeGreaterThan(0);
  });

  it('a collected ticket is still refused if it is presented afterwards', () => {
    const now = new Date('2026-09-02T12:00:00.000Z');
    const session = fakeSession('identity-session-1', new Date(now.getTime() - 5_000));
    const ticket = mintTicket(db, {
      session,
      audience: HQ_ORIGIN,
      redirectUri: HQ_CALLBACK,
      state: 'round-trip-state',
      now,
    });

    // Long after it died, and after housekeeping has removed the row.
    const later = new Date(now.getTime() + SSO_TICKET_TTL_MS + TICKET_PRUNE_RETENTION_MS + 1_000);
    expect(pruneExpiredTickets(db, later)).toBe(1);
    expect(redeemTicket(db, ticket, HQ_ORIGIN, 'round-trip-state', later)).toEqual({
      ok: false,
      error: 'ticket_unknown',
    });
  });

  it('minting sweeps, so the table cannot grow without bound', () => {
    const start = new Date('2026-09-02T12:00:00.000Z');
    // Twenty handoffs, each two minutes after the last: every ticket but the
    // newest is long dead by the time the next one is minted.
    for (let i = 0; i < 20; i += 1) {
      const at = new Date(start.getTime() + i * 120_000);
      mintTicket(db, {
        session: fakeSession(`identity-session-${i}`, at),
        audience: HQ_ORIGIN,
        redirectUri: HQ_CALLBACK,
        state: `state-${i}`,
        now: at,
      });
    }
    // Before the fix this was 20 and would have kept climbing forever.
    expect(ticketCount()).toBe(1);
  });

  it('sweeps on the real authorize route, not only when called directly', async () => {
    const plane: SsoHqPlane = {
      audience: HQ_ORIGIN,
      allowedRedirectUris: [HQ_CALLBACK],
      serviceSecret: SERVICE_SECRET,
    };
    const app: FastifyInstance = buildApp({ db, ssoHq: plane });
    await app.ready();

    const backlog = new Date(Date.now() - 60 * 60_000);
    for (let i = 0; i < 5; i += 1) insertTicketRow({ id: `stale-${i}`, expiresAt: backlog });
    expect(ticketCount()).toBe(5);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'founder.salta', password: 'test-password' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = `fos_session=${login.cookies.find((c) => c.name === 'fos_session')!.value}`;

    const authorize = await app.inject({
      method: 'GET',
      url: `${SSO_HQ_ROUTES.authorize}?redirect_uri=${encodeURIComponent(HQ_CALLBACK)}&state=abc`,
      headers: { cookie },
    });
    expect(authorize.statusCode).toBe(302);

    // The five stale rows are gone; the ticket this authorize just minted is not.
    expect(ticketCount()).toBe(1);
    await app.close();
  });
});

describe('revocation propagation is bounded (third round, Codex P2)', () => {
  const audit: string[] = [];
  beforeEach(() => {
    audit.length = 0;
  });

  function revocation(count: number): IdentityRevocation {
    return {
      reason: 'password_reset',
      originSessionIds: Array.from({ length: count }, (_, i) => `identity-session-${i}`),
      ticketsInvalidated: 0,
    };
  }

  function sink(notifier: HqLogoutNotifier) {
    return { logoutNotifier: notifier, audit: (line: string) => audit.push(line) };
  }

  it('returns within the deadline when HQ never answers, however many sessions there are', async () => {
    // The finding's shape: a compromised account with many sessions, and an HQ
    // that accepts the connection and then says nothing. Serially, with the
    // shipped five-second per-call timeout, this was minutes.
    const notifier: HqLogoutNotifier = {
      revokeSessionsFor: () => new Promise(() => {}),
    };
    const started = Date.now();
    await propagateIdentityRevocation(sink(notifier), revocation(200), { deadlineMs: 120 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3_000);
    const summary = audit.at(-1)!;
    expect(summary).toContain('0 of 200');
    expect(summary).toContain('not confirmed');
    // The operator is told what is still live rather than told it succeeded.
    expect(summary).toContain('remains valid at HQ until its own expiry');
  });

  it('never leaves more than the configured number of calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const notifier: HqLogoutNotifier = {
      async revokeSessionsFor() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return { ok: true, detail: 'status 200' };
      },
    };
    await propagateIdentityRevocation(sink(notifier), revocation(50), { deadlineMs: 5_000 });

    expect(peak).toBeLessThanOrEqual(REVOCATION_PROPAGATION_CONCURRENCY);
    expect(peak).toBeGreaterThan(1); // it really is concurrent, not a serial walk
    expect(audit.at(-1)).toContain('50 of 50');
  });

  it('notifies every session exactly once when HQ is healthy', async () => {
    const seen: string[] = [];
    const notifier: HqLogoutNotifier = {
      async revokeSessionsFor(id) {
        seen.push(id);
        return { ok: true, detail: 'status 200' };
      },
    };
    await propagateIdentityRevocation(sink(notifier), revocation(12));

    expect(seen.slice().sort()).toEqual(revocation(12).originSessionIds.slice().sort());
    expect(new Set(seen).size).toBe(12);
    const summary = audit.at(-1)!;
    expect(summary).toContain('12 of 12');
    expect(summary).toContain('0 refused or unreachable');
    // Nothing is outstanding, so nothing is claimed to be.
    expect(summary).not.toContain('remains valid at HQ');
  });

  it('reports a slow HQ honestly: what got through, and what did not', async () => {
    // Half answer immediately, half never. The result must name both.
    const notifier: HqLogoutNotifier = {
      revokeSessionsFor(id) {
        const index = Number(id.split('-').at(-1));
        return index % 2 === 0
          ? Promise.resolve({ ok: true, detail: 'status 200' })
          : new Promise(() => {});
      },
    };
    await propagateIdentityRevocation(sink(notifier), revocation(4), {
      deadlineMs: 120,
      concurrency: 4,
    });

    const summary = audit.at(-1)!;
    expect(summary).toMatch(/2 of 4 identity session\(s\) confirmed/);
    expect(summary).toContain('2 not confirmed');
    expect(summary).toContain('identity-session-1');
  });

  it('contains a notifier that throws, and still finishes the rest', async () => {
    const notifier: HqLogoutNotifier = {
      async revokeSessionsFor(id) {
        if (id.endsWith('-0')) throw new Error('socket hang up');
        return { ok: true, detail: 'status 200' };
      },
    };
    await expect(
      propagateIdentityRevocation(sink(notifier), revocation(3)),
    ).resolves.toBeUndefined();

    expect(audit.join('\n')).toContain('socket hang up');
    expect(audit.at(-1)).toContain('2 of 3');
    expect(audit.at(-1)).toContain('1 refused or unreachable');
  });

  it('does nothing at all when there is nothing to propagate', async () => {
    let called = false;
    const notifier: HqLogoutNotifier = {
      async revokeSessionsFor() {
        called = true;
        return { ok: true, detail: 'status 200' };
      },
    };
    await propagateIdentityRevocation(sink(notifier), {
      reason: 'logout',
      originSessionIds: [],
      ticketsInvalidated: 0,
    });
    expect(called).toBe(false);
    expect(audit).toEqual([]);
  });
});
