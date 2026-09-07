/**
 * Phase 10 command-centre routes, end to end against the real canonical
 * machinery.
 *
 * The two reads and the one write join the control API behind the SAME
 * pipeline as every other route — origin/content-type gate, client-identity
 * scan of body AND query, Founder resolution, `safe()` on every response.
 * What this suite proves: the acting principal is always the mapped one, a
 * body naming an actor is refused, there is NO route that takes a
 * recommendation, the reads carry no fabricated number, refusals carry one
 * status per cause, and the session advertises the brief control from exactly
 * the conditions that decide the write.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { count } from './collaboration.fixture.js';
import { commandCenterFixture, taskAwaitingApproval, type CommandCenterFixture } from './command-center.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { FOUNDER_BRIEF_CAPABILITY } from '../src/application/chief-of-staff.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-07T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-analyst', principalId: 'analyst' },
];

function account(accountId: string, authenticatedAt = FRESH): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt };
}
const STAFF = account('user-staff');

interface Harness {
  fixture: CommandCenterFixture;
  audit: ControlAuditEvent[];
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null; mutationsEnabled?: boolean } = {}): Harness {
  const fixture = commandCenterFixture();
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null = options.account !== undefined ? options.account : account('user-founder');
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    audit: { record: (event) => audit.push(event) },
    mutationsEnabled: options.mutationsEnabled,
    now: () => NOW,
  };
  return {
    fixture,
    audit,
    deps,
    call(request, next) {
      if (next !== undefined) current = next;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/index.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.commandCenter, headers, body: request.body, query: request.query },
        deps,
      );
    },
  };
}

function get(h: Harness, path: string, query?: Record<string, string>, next?: AuthenticatedAccount | null): ControlResponse {
  return h.call({ method: 'GET', path, query }, next);
}

describe('the command-centre write surface', () => {
  it('states the brief receipt as the phase’s one write and both reads as reads', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.commandCenterBrief);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.commandCenter);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.commandCenterInbox);
  });

  it('has no route that takes a recommendation, under any method', () => {
    const paths = Object.values(CONTROL_ROUTES);
    expect(paths.filter((path) => /recommend/i.test(path))).toEqual([]);
    const h = harness();
    for (const method of ['GET', 'POST'] as const) {
      const response = h.call({ method, path: `${CONTROL_ROUTES.commandCenter}/recommendation`, body: { id: 'rec:x' } });
      expect(response.status).toBe(404);
      expect((response.body.error as { code: string }).code).toBe('not_found');
    }
  });
});

describe('GET /command-center — the whole derived briefing', () => {
  it('carries the six questions, the recommendations and the departments, and writes nothing', () => {
    const h = harness();
    taskAwaitingApproval(h.fixture, 'routes-briefing');
    const before = { events: count(h.fixture, 'hq_events'), evidence: count(h.fixture, 'op_evidence'), briefs: count(h.fixture, 'hq_briefs') };
    const response = get(h, CONTROL_ROUTES.commandCenter);
    expect(response.status).toBe(200);
    const briefing = response.body.briefing as Record<string, unknown>;
    expect(Object.keys(briefing).sort()).toEqual([
      'assembledAt',
      'blocked',
      'briefs',
      'changed',
      'departments',
      'needsMe',
      'provenance',
      'recommendations',
      'safeNext',
      'unknown',
      'verified',
    ]);
    expect(response.body.briefStorePresent).toBe(true);
    expect(count(h.fixture, 'hq_events')).toBe(before.events);
    expect(count(h.fixture, 'op_evidence')).toBe(before.evidence);
    expect(count(h.fixture, 'hq_briefs')).toBe(before.briefs);
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'allowed', detail: 'command_center' });
  });

  it('puts no priority, score, confidence, percentage, ETA or cost on the wire', () => {
    const h = harness();
    taskAwaitingApproval(h.fixture, 'routes-no-fabrication');
    const wire = JSON.stringify(get(h, CONTROL_ROUTES.commandCenter).body);
    expect(wire).not.toMatch(/"(priority|score|confidence|percent|percentage|eta|rank|weight|urgency|cost|tokens|progress)[A-Za-z]*"\s*:/i);
  });

  it('names the canonical row behind every item it carries', () => {
    const h = harness();
    const { taskId } = taskAwaitingApproval(h.fixture, 'routes-traceable');
    const briefing = get(h, CONTROL_ROUTES.commandCenter).body.briefing as {
      needsMe: { items: { source: { table: string; id: string }; provenance: string }[] };
      recommendations: { items: { executable: boolean; sourceFacts: { table: string; id: string }[] }[] };
    };
    for (const item of briefing.needsMe.items) {
      expect(item.source.table).toMatch(/^(hq_|op_)/);
      expect(item.source.id.length).toBeGreaterThan(0);
      expect(item.provenance.length).toBeGreaterThan(0);
    }
    expect(briefing.needsMe.items.some((item) => item.source.id === taskId)).toBe(true);
    for (const recommendation of briefing.recommendations.items) {
      expect(recommendation.executable).toBe(false);
      expect(recommendation.sourceFacts.length).toBeGreaterThan(0);
    }
  });

  it('carries founder_only-derived material past the Founder gate, exactly as GET /truth does', () => {
    const h = harness();
    const record = expectOk(
      h.fixture.ops.recordTruth({
        entityKind: 'mission',
        entityId: h.fixture.missionId,
        statement: 'The private review found nothing.',
        bornState: 'observed',
        evidenceRefs: [h.fixture.evidenceId],
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    expectOk(
      h.fixture.ops.verifyTruth({
        truthId: record.id,
        method: 'tested',
        verdict: 'confirmed',
        evidenceRefs: [h.fixture.evidenceId],
        limitations: 'one reviewer',
        requestedBy: 'codex',
      }),
    );
    const briefing = get(h, CONTROL_ROUTES.commandCenter).body.briefing as {
      needsMe: { items: { source: { id: string } }[]; withheldFounderOnly: number };
    };
    expect(briefing.needsMe.items.some((item) => item.source.id === record.id)).toBe(true);
    expect(briefing.needsMe.withheldFounderOnly).toBe(0);
  });
});

describe('GET /command-center/inbox — the attention queue alone', () => {
  it('answers the same items the briefing carries, with the stated ordering and no ranking', () => {
    const h = harness();
    taskAwaitingApproval(h.fixture, 'routes-inbox');
    const response = get(h, CONTROL_ROUTES.commandCenterInbox);
    expect(response.status).toBe(200);
    expect(h.audit.at(-1)).toMatchObject({ outcome: 'allowed', detail: 'founder_inbox' });
    const inbox = response.body.inbox as { items: { id: string }[]; ordering: string; byKind: Record<string, number> };
    const briefing = get(h, CONTROL_ROUTES.commandCenter).body.briefing as { needsMe: { items: { id: string }[] } };
    expect(inbox.items.map((item) => item.id)).toEqual(briefing.needsMe.items.map((item) => item.id));
    expect(inbox.ordering).toContain('A grouping, not a ranking');
    expect(Object.values(inbox.byKind).reduce((sum, value) => sum + value, 0)).toBe(inbox.items.length);
  });
});

describe('POST /command-center/brief — the one write', () => {
  it('records a receipt attributed to the MAPPED principal, and 201 then 200 on the repeat', () => {
    const h = harness();
    const created = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(created.status).toBe(201);
    expect((created.body.brief as { issuedBy: string }).issuedBy).toBe('founder');
    expect(created.body.deduplicated).toBe(false);
    const repeat = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(repeat.status).toBe(200);
    expect(repeat.body.deduplicated).toBe(true);
    expect((repeat.body.brief as { id: string }).id).toBe((created.body.brief as { id: string }).id);
    expect(count(h.fixture, 'hq_briefs')).toBe(1);
  });

  it('refuses a body that names an actor, before anything is written', () => {
    const h = harness();
    for (const key of ['requestedBy', 'actor', 'principalId', 'founderId', 'by', 'role']) {
      const response = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: { [key]: 'mallory' } });
      expect(response.status, key).toBe(400);
      expect((response.body.error as { code: string }).code, key).toBe('client_identity_supplied');
    }
    // `issuedBy` is not on the identity allow-list and is simply ignored: the
    // receipt is attributed to the mapped principal regardless of the body.
    const attributed = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: { issuedBy: 'mallory' } });
    expect(attributed.status).toBe(201);
    expect((attributed.body.brief as { issuedBy: string }).issuedBy).toBe('founder');
    expect(count(h.fixture, 'hq_briefs')).toBe(1);
  });

  it('puts no idempotency key on the wire and never lets a client key name another receipt', () => {
    const h = harness();
    const first = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: { idempotencyKey: 'mine' } });
    expect(first.status).toBe(201);
    expect(JSON.stringify(first.body)).not.toContain('idempotencyKey');
    expect(JSON.stringify(first.body)).not.toContain('founder-brief:');
    // A different client key over the same canonical position is a different
    // brief: the client value is an INPUT to the derived key, never the key.
    const second = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: { idempotencyKey: 'other' } });
    expect(second.status).toBe(201);
    expect((second.body.brief as { id: string }).id).not.toBe((first.body.brief as { id: string }).id);
  });

  it('refuses a non-Founder account, a staff account and no identity at all', () => {
    const h = harness();
    const analyst = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} }, account('user-analyst'));
    expect(analyst.status).toBe(403);
    expect((analyst.body.error as { code: string }).code).toBe('not_permitted');
    const staff = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} }, STAFF);
    expect(staff.status).toBe(403);
    const nobody = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} }, null);
    expect(nobody.status).toBe(401);
    expect(count(h.fixture, 'hq_briefs')).toBe(0);
  });

  it('refuses every command-centre route to a staff account and to no identity, reads included', () => {
    const h = harness();
    for (const path of [CONTROL_ROUTES.commandCenter, CONTROL_ROUTES.commandCenterInbox]) {
      expect(get(h, path, undefined, STAFF).status, path).toBe(403);
      expect(get(h, path, undefined, null).status, path).toBe(401);
    }
  });

  it('refuses the write when browser mutations are off, and still answers the reads', () => {
    const h = harness({ mutationsEnabled: false });
    const write = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(write.status).toBe(403);
    expect((write.body.error as { code: string }).code).toBe('mutations_disabled');
    expect(get(h, CONTROL_ROUTES.commandCenter).status).toBe(200);
    expect(count(h.fixture, 'hq_briefs')).toBe(0);
  });

  it('carries one status per cause when the capability is missing, disabled or drifted', () => {
    const missing = harness();
    missing.fixture.db.prepare(`DELETE FROM op_capabilities WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    const notRegistered = missing.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(notRegistered.status).toBe(403);
    expect((notRegistered.body.error as { code: string }).code).toBe('unknown_capability');

    const disabled = harness();
    disabled.fixture.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    const off = disabled.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(off.status).toBe(403);
    expect((off.body.error as { code: string }).code).toBe('capability_disabled');

    const drifted = harness();
    drifted.fixture.db.prepare(`UPDATE op_capabilities SET side_effect = 1 WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    const altered = drifted.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(altered.status).toBe(403);
    expect((altered.body.error as { code: string }).code).toBe('not_permitted');
    expect(count(drifted.fixture, 'hq_briefs')).toBe(0);
  });
});

describe('the session advertises the brief control from the conditions that decide the write', () => {
  it('grants it to a Founder holding the grant with an intact row, and withdraws it when either fails', () => {
    const granted = harness();
    const session = granted.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((session.body.controls as Record<string, unknown>).founderBrief).toBe(true);

    const disabled = harness();
    disabled.fixture.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`).run(FOUNDER_BRIEF_CAPABILITY.id);
    expect(
      ((disabled.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, unknown>).founderBrief),
    ).toBe(false);

    const ungranted = commandCenterFixture({ grantBrief: false });
    const h = harness();
    h.deps.ops = ungranted.ops;
    expect(((h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, unknown>).founderBrief)).toBe(
      false,
    );

    // A principal who is not the Founder is advertised nothing at all.
    const analyst = granted.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-analyst'));
    expect((analyst.body.controls as Record<string, unknown>).founderBrief).toBe(false);
  });

  it('never advertises a control for reading the command centre — reading takes no capability', () => {
    const h = harness();
    const controls = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, unknown>;
    expect(Object.keys(controls).filter((key) => /commandCenter|inbox|recommend/i.test(key))).toEqual([]);
    // And the read genuinely works for a Founder with no brief grant.
    const ungranted = commandCenterFixture({ grantBrief: false });
    h.deps.ops = ungranted.ops;
    expect(get(h, CONTROL_ROUTES.commandCenter).status).toBe(200);
  });
});

describe('the reads honour the canonical stop levers they describe', () => {
  it('still answers while a kill switch is engaged, and shows the stop as an incident', () => {
    const h = harness();
    expectOk(h.fixture.ops.engageKillSwitch('*', 'founder', 'incident 42'));
    const briefing = get(h, CONTROL_ROUTES.commandCenter).body.briefing as {
      needsMe: { items: { reason: string; source: { table: string; id: string } }[] };
      blocked: { killSwitches: { scope: string }[] };
      safeNext: { claimableTasks: { total: number } };
    };
    expect(briefing.needsMe.items.some((item) => item.reason === 'kill_switch_engaged')).toBe(true);
    expect(briefing.blocked.killSwitches.map((entry) => entry.scope)).toEqual(['*']);
    expect(briefing.safeNext.claimableTasks.total).toBe(0);
  });

  it('keeps the brief receipt available under a stop, because a record executes nothing', () => {
    // The memory/truth intake-parity rule: recording what the company record
    // held is exactly what an emergency stop must not erase.
    const h = harness();
    expectOk(h.fixture.ops.engageKillSwitch('*', 'founder', 'incident 42'));
    const response = h.call({ path: CONTROL_ROUTES.commandCenterBrief, body: {} });
    expect(response.status).toBe(201);
    expect(count(h.fixture, 'hq_briefs')).toBe(1);
  });
});

describe('the query string is scanned like the body', () => {
  it('refuses a read whose query names an actor', () => {
    const h = harness();
    const response = get(h, CONTROL_ROUTES.commandCenter, { principalId: 'mallory' });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('client_identity_supplied');
  });

  it('ignores an unknown query parameter rather than acting on it', () => {
    const h = harness();
    taskAwaitingApproval(h.fixture, 'routes-unknown-query');
    const plain = get(h, CONTROL_ROUTES.commandCenterInbox);
    const noisy = get(h, CONTROL_ROUTES.commandCenterInbox, { includeFounderOnly: 'false', limit: '0', kind: 'approval' });
    expect((noisy.body.inbox as { items: unknown[] }).items).toEqual((plain.body.inbox as { items: unknown[] }).items);
  });
});

describe('the derived layer reflects a canonical act made through another route', () => {
  it('loses the approval item once the approval route decides it', () => {
    const h = harness();
    const { taskId } = taskAwaitingApproval(h.fixture, 'routes-approve');
    const cards = h.call({ method: 'GET', path: CONTROL_ROUTES.approvals }).body.approvals as {
      taskId: string;
      actionDigest: string;
    }[];
    const digest = cards.find((card) => card.taskId === taskId)!.actionDigest;
    const approved = h.call({ path: CONTROL_ROUTES.approve, body: { taskId, expectedActionDigest: digest } });
    expect(approved.status).toBe(200);
    const inbox = get(h, CONTROL_ROUTES.commandCenterInbox).body.inbox as { items: { source: { id: string } }[] };
    expect(inbox.items.some((item) => item.source.id === taskId)).toBe(false);
    expect(h.fixture.ops.queue.get(taskId)!.status).toBe('queued');
    expect(CAPS.indexDoc).toBe('archive.index_document');
  });
});
