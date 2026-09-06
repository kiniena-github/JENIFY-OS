/**
 * Phase 7 truth routes, end to end against the real canonical machinery.
 *
 * The truth reads and the three truth writes join the control API behind
 * the SAME pipeline as every other route — origin/content-type gate,
 * client-identity scan (body AND query), Founder resolution, `safe()` on
 * every response. This suite proves the wiring: the acting principal is
 * always the mapped one, accept demands STEP-UP always, founder_only rows
 * are readable ONLY through the Founder gate (and withheld from the
 * unauthenticated artifact), refusals carry one status per cause, and the
 * session advertises each truth control from the conditions that decide it.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk } from './application.fixture.js';
import { truthFixture, type TruthFixture } from './truth.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-06T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
const STALE = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();

const MAP = [
  { realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' },
  { realmId: 'tenant-1', accountId: 'user-analyst', principalId: 'analyst' },
  { realmId: 'tenant-1', accountId: 'user-auditor', principalId: 'auditor' },
  { realmId: 'tenant-1', accountId: 'user-coo', principalId: 'coo' },
];

function account(accountId: string, authenticatedAt = FRESH): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId, displayName: accountId, authenticatedAt };
}
const STAFF = account('user-staff');

interface Harness {
  fixture: TruthFixture;
  audit: ControlAuditEvent[];
  deps: ControlApiDeps;
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null; mutationsEnabled?: boolean } = {}): Harness {
  const fixture = truthFixture();
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : account('user-founder');
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    credentials: { verify: (_a, password) => (password === 'correct-password' ? 'ok' : 'rejected') },
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
          ? { referer: `${ORIGIN}/hq/archive.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.truth, headers, body: request.body, query: request.query },
        deps,
      );
    },
  };
}

function claimBody(h: Harness, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    entityKind: 'task',
    entityId: h.fixture.taskId,
    statement: 'CI is green on the release branch.',
    evidenceRefs: [h.fixture.evidenceId],
    ...over,
  };
}

function rows(h: Harness, table: string): number {
  return (h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('the truth write surface', () => {
  it('names the three writes and keeps the entity read off it', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.truth);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.truthVerify);
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.truthAccept);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.truthEntity);
  });

  it('records attributed to the mapped principal, 201 then 200 deduplicated, no idempotency key on the wire', () => {
    const h = harness();
    const first = h.call({ body: claimBody(h) });
    expect(first.status).toBe(201);
    const record = first.body.record as Record<string, unknown>;
    expect(record.recordedBy).toBe('founder');
    expect(record.state).toBe('claimed');
    expect(JSON.stringify(first.body)).not.toContain('idempotencyKey');
    const second = h.call({ body: claimBody(h) });
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(rows(h, 'hq_truth_records')).toBe(1);
  });

  it('a body asserting verified/accepted at birth is refused at the boundary', () => {
    const h = harness();
    for (const bornState of ['verified', 'accepted']) {
      const response = h.call({ body: claimBody(h, { bornState }) });
      expect(response.status).toBe(400);
    }
    expect(rows(h, 'hq_truth_records')).toBe(0);
  });
});

describe('the claim → verify → accept arc through the routes', () => {
  it('verifies as an independent mapped principal and accepts with STEP-UP — always, even for a fresh session with no password? no: a fresh session satisfies it', () => {
    const h = harness();
    const recorded = h.call({ body: claimBody(h) });
    const truthId = (recorded.body.record as { id: string }).id;
    // The author (founder) cannot verify its own claim through the route either.
    const self = h.call({
      path: CONTROL_ROUTES.truthVerify,
      body: { truthId, method: 'inspected_evidence', verdict: 'confirmed', evidenceRefs: [h.fixture.evidenceId], limitations: 'none known' },
    });
    expect(self.status).toBe(403);
    expect((self.body.error as { code: string }).code).toBe('not_permitted');
    // The auditor (holds hq.truth_verify, no approval authority) verifies.
    const verified = h.call(
      {
        path: CONTROL_ROUTES.truthVerify,
        body: { truthId, method: 'inspected_evidence', verdict: 'confirmed', evidenceRefs: [h.fixture.evidenceId], limitations: 'Evidence entry only.' },
      },
      account('user-auditor'),
    );
    expect(verified.status).toBe(201);
    const view = verified.body.record as { state: string; acceptanceDigest: string };
    expect(view.state).toBe('verified');
    expect((verified.body.verification as { verifiedBy: string }).verifiedBy).toBe('auditor');
    // The auditor may not accept (no approval authority) — 403.
    const noAuthority = h.call({
      path: CONTROL_ROUTES.truthAccept,
      body: { truthId, expectedDigest: view.acceptanceDigest },
    });
    expect(noAuthority.status).toBe(403);
    // The founder is the author — refused; the coo (approval authority, independent) accepts on a fresh session.
    const asAuthor = h.call(
      { path: CONTROL_ROUTES.truthAccept, body: { truthId, expectedDigest: view.acceptanceDigest } },
      account('user-founder'),
    );
    expect(asAuthor.status).toBe(403);
    const accepted = h.call(
      { path: CONTROL_ROUTES.truthAccept, body: { truthId, expectedDigest: view.acceptanceDigest } },
      account('user-coo'),
    );
    expect(accepted.status).toBe(201);
    expect((accepted.body.record as { state: string }).state).toBe('accepted');
    expect((accepted.body.acceptance as { acceptedBy: string }).acceptedBy).toBe('coo');
    expect(h.audit.some((e) => e.detail === 'truth_accepted' && e.principalId === 'coo')).toBe(true);
  });

  it('demands STEP-UP on accept for a stale session — record and verify never do', () => {
    const h = harness({ account: account('user-founder', STALE) });
    const recorded = h.call({ body: claimBody(h) });
    expect(recorded.status).toBe(201);
    const truthId = (recorded.body.record as { id: string }).id;
    const verified = h.call(
      {
        path: CONTROL_ROUTES.truthVerify,
        body: { truthId, method: 'reviewed', verdict: 'confirmed', evidenceRefs: [h.fixture.evidenceId], limitations: 'none known' },
      },
      account('user-auditor', STALE),
    );
    expect(verified.status).toBe(201);
    const digest = (verified.body.record as { acceptanceDigest: string }).acceptanceDigest;
    const bare = h.call({ path: CONTROL_ROUTES.truthAccept, body: { truthId, expectedDigest: digest } }, account('user-coo', STALE));
    expect(bare.status).toBe(401);
    expect((bare.body.error as { code: string }).code).toBe('step_up_required');
    const wrong = h.call({ path: CONTROL_ROUTES.truthAccept, body: { truthId, expectedDigest: digest, stepUpPassword: 'nope' } });
    expect(wrong.status).toBe(403);
    expect((wrong.body.error as { code: string }).code).toBe('step_up_failed');
    expect(rows(h, 'hq_truth_acceptances')).toBe(0);
    const confirmed = h.call({
      path: CONTROL_ROUTES.truthAccept,
      body: { truthId, expectedDigest: digest, stepUpPassword: 'correct-password' },
    });
    expect(confirmed.status).toBe(201);
    expect(rows(h, 'hq_truth_acceptances')).toBe(1);
    // The password never lands anywhere: not in the audit, not in evidence, not in the response.
    expect(JSON.stringify([h.audit, confirmed.body])).not.toContain('correct-password');
    expect(JSON.stringify(h.fixture.ops.queue.evidence.list())).not.toContain('correct-password');
  });

  it('maps facade refusals one status per cause: 404 unknown evidence/entity/truth, 409 not verified/contested/conflict', () => {
    const h = harness();
    const phantomEvidence = h.call({ body: claimBody(h, { evidenceRefs: ['ghost'] }) });
    expect(phantomEvidence.status).toBe(404);
    expect((phantomEvidence.body.error as { code: string }).code).toBe('unknown_evidence');
    const phantomEntity = h.call({ body: claimBody(h, { entityId: 'ghost' }) });
    expect(phantomEntity.status).toBe(404);
    expect((phantomEntity.body.error as { code: string }).code).toBe('unknown_entity');
    const truthId = (h.call({ body: claimBody(h) }).body.record as { id: string }).id;
    const unknownTruth = h.call({
      path: CONTROL_ROUTES.truthVerify,
      body: { truthId: 'ghost', method: 'reviewed', verdict: 'confirmed', evidenceRefs: [h.fixture.evidenceId], limitations: 'x' },
    }, account('user-auditor'));
    expect(unknownTruth.status).toBe(404);
    const notVerified = h.call({ path: CONTROL_ROUTES.truthAccept, body: { truthId, expectedDigest: 'x' } }, account('user-coo'));
    expect(notVerified.status).toBe(409);
    expect((notVerified.body.error as { code: string }).code).toBe('truth_not_verified');
    // Contest it, verify it, and acceptance is 409 truth_contested.
    h.call({ body: claimBody(h, { statement: 'CI is red.', contradicts: [truthId] }) }, account('user-analyst'));
    const verified = h.call(
      { path: CONTROL_ROUTES.truthVerify, body: { truthId, method: 'reviewed', verdict: 'confirmed', evidenceRefs: [h.fixture.evidenceId], limitations: 'x' } },
      account('user-auditor'),
    );
    expect((verified.body.record as { contested: boolean }).contested).toBe(true);
    const contested = h.call({ path: CONTROL_ROUTES.truthAccept, body: { truthId, expectedDigest: 'x' } }, account('user-coo'));
    expect(contested.status).toBe(409);
    expect((contested.body.error as { code: string }).code).toBe('truth_contested');
    // A second supersession of one record is a 409 conflict.
    h.call({ body: claimBody(h, { statement: 'v2', supersedes: truthId }) }, account('user-founder'));
    const again = h.call({ body: claimBody(h, { statement: 'v2b', supersedes: truthId }) });
    expect(again.status).toBe(409);
    expect((again.body.error as { code: string }).code).toBe('truth_conflict');
  });
});

describe('every hostile caller is refused, and nothing is written', () => {
  it('refuses the anonymous and the non-Founder alike on every truth route', () => {
    for (const [acct, status] of [
      [null, 401],
      [STAFF, 403],
    ] as const) {
      const h = harness({ account: acct });
      expect(h.call({ body: claimBody(h) }).status).toBe(status);
      expect(h.call({ path: CONTROL_ROUTES.truthVerify, body: {} }).status).toBe(status);
      expect(h.call({ path: CONTROL_ROUTES.truthAccept, body: {} }).status).toBe(status);
      expect(h.call({ method: 'GET', path: CONTROL_ROUTES.truth }).status).toBe(status);
      expect(h.call({ method: 'GET', path: CONTROL_ROUTES.truthEntity, query: { kind: 'task', id: h.fixture.taskId } }).status).toBe(status);
      expect(rows(h, 'hq_truth_records')).toBe(0);
    }
  });

  it('refuses a body naming an actor and a QUERY naming one', () => {
    const h = harness();
    const viaBody = h.call({ body: claimBody(h, { requestedBy: 'coo' }) });
    expect(viaBody.status).toBe(400);
    expect((viaBody.body.error as { code: string }).code).toBe('client_identity_supplied');
    const viaQuery = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.truthEntity,
      query: { kind: 'task', id: h.fixture.taskId, principalId: 'coo' },
    });
    expect(viaQuery.status).toBe(400);
    expect(rows(h, 'hq_truth_records')).toBe(0);
  });

  it('refuses when mutations are disabled, reads staying open; refuses secret-like statements before anything persists', () => {
    const off = harness({ mutationsEnabled: false });
    expect(off.call({ body: claimBody(off) }).status).toBe(403);
    expect(off.call({ method: 'GET', path: CONTROL_ROUTES.truth }).status).toBe(200);
    const h = harness();
    const leak = h.call({ body: claimBody(h, { statement: 'token is ghp_0123456789abcdef0123456789abcdef012345' }) });
    expect(leak.status).toBe(400);
    expect((leak.body.error as { code: string }).code).toBe('unsafe_truth_content');
    expect(rows(h, 'hq_truth_records')).toBe(0);
  });

  it('keeps unknown truth sub-routes a 404 that reveals nothing', () => {
    const h = harness();
    expect(h.call({ method: 'GET', path: `${CONTROL_ROUTES.truth}/anything` }).status).toBe(404);
    expect(h.call({ path: `${CONTROL_ROUTES.truth}/relate`, body: {} }).status).toBe(404);
  });
});

describe('the Founder-gated reads and the privacy boundary', () => {
  it('GET /truth includes founder_only rows with unresolved contradictions alongside; the unauthenticated artifact withholds and counts them', () => {
    const h = harness();
    const memory = expectOk(
      h.fixture.ops.recordMemory({
        kind: 'decision',
        title: 'Private decision',
        body: 'Kept private.',
        project: 'QOS',
        privacy: 'founder_only',
        requestedBy: 'founder',
      }),
    ).record;
    h.call({ body: claimBody(h) });
    const privateRecord = h.call({
      body: { entityKind: 'memory', entityId: memory.id, statement: 'The private decision was made.', privacy: 'founder_only' },
    });
    expect(privateRecord.status).toBe(201);
    const privateId = (privateRecord.body.record as { id: string }).id;
    h.call({
      body: { entityKind: 'memory', entityId: memory.id, statement: 'It was not made.', privacy: 'founder_only', contradicts: [privateId] },
    }, account('user-analyst'));

    const read = h.call({ method: 'GET', path: CONTROL_ROUTES.truth }, account('user-founder'));
    expect(read.status).toBe(200);
    const records = read.body.records as { privacy: string; statement: string }[];
    expect(records.filter((r) => r.privacy === 'founder_only')).toHaveLength(2);
    expect(read.body.total).toBe(3);
    expect(read.body.unresolvedContradictions as unknown[]).toHaveLength(1);

    // The Founder-gated /state carries founder_only; the unauthenticated artifact does not, and says so.
    const state = h.call({ method: 'GET', path: CONTROL_ROUTES.state });
    expect(state.status).toBe(200);
    const gated = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString(), includeFounderOnlyMemory: true });
    expect(gated.truth!.data.records).toHaveLength(3);
    expect(gated.truth!.data.withheldFounderOnly).toBe(0);
    expect(gated.truth!.data.unresolvedContradictions).toBe(1);
    expect(gated.truth!.data.byState).toEqual({ claimed: 3, observed: 0, verified: 0, accepted: 0 });
    const artifact = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
    expect(artifact.truth!.data.records).toHaveLength(1);
    expect(artifact.truth!.data.records[0]!.privacy).toBe('internal');
    expect(artifact.truth!.data.total).toBe(3);
    expect(artifact.truth!.data.withheldFounderOnly).toBe(2);
    // Review round 2: the aggregate counts span the CARRIED set only — a dispute
    // between two founder_only records is an internal dispute, and its count
    // said one existed. `total` + `withheldFounderOnly` still state the omission.
    expect(artifact.truth!.data.unresolvedContradictions).toBe(0);
    expect(artifact.truth!.data.byState).toEqual({ claimed: 1, observed: 0, verified: 0, accepted: 0 });
    expect(artifact.truth!.data.contradictions).toEqual([]);
    expect(artifact.truth!.provenance.note).toContain('2 founder_only record(s)');
    const blob = JSON.stringify(artifact);
    expect(blob).not.toContain('The private decision was made.');
    expect(blob).not.toContain(privateId);
    for (const r of gated.truth!.data.records.filter((v) => v.privacy === 'founder_only')) expect(blob).not.toContain(r.id);
  });

  it('the unauthenticated artifact carries no founder_only id through a PUBLIC record\'s relations either; the Founder-gated state keeps them', () => {
    const h = harness();
    const open = (h.call({ body: claimBody(h, { statement: 'The release shipped on time.' }) }).body.record as { id: string }).id;
    const secret = h.call(
      {
        body: claimBody(h, {
          statement: 'CONFIDENTIAL: the release slipped and legal was notified.',
          privacy: 'founder_only',
          contradicts: [open],
        }),
      },
      account('user-analyst'),
    );
    expect(secret.status).toBe(201);
    const secretId = (secret.body.record as { id: string }).id;

    const gated = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString(), includeFounderOnlyMemory: true });
    const gatedOpen = gated.truth!.data.records.find((r) => r.id === open)!;
    expect(gatedOpen.contradictedBy).toEqual([secretId]);
    expect(gatedOpen.contradictions).toEqual([{ withId: secretId, direction: 'stated_by', resolution: 'unresolved' }]);
    expect(gated.truth!.data.withheldFounderOnlyRelations).toBe(0);
    expect(gated.truth!.data.unresolvedContradictions).toBe(1);

    const artifact = liveSnapshotFromOperations(h.fixture.ops, { now: NOW.toISOString() });
    const blob = JSON.stringify(artifact);
    expect(blob).not.toContain('CONFIDENTIAL');
    expect(blob).not.toContain(secretId);
    const carried = artifact.truth!.data.records.find((r) => r.id === open)!;
    expect(carried.contradictedBy).toEqual([]);
    expect(carried.contradictions).toEqual([]);
    // The public record's own categorical standing is not laundered: it IS
    // contested. What is withheld is who by, in which direction, and how
    // that stands — the private record's identity and substance.
    expect(carried.contested).toBe(true);
    expect(artifact.truth!.data.withheldFounderOnly).toBe(1);
    expect(artifact.truth!.data.withheldFounderOnlyRelations).toBe(1);
    // The pair count matches the pair list it summarises (both scoped to the
    // carried set since review round 2); the record's own `contested` stays true.
    expect(artifact.truth!.data.unresolvedContradictions).toBe(0);
    expect(artifact.truth!.data.contradictions).toEqual([]);
    expect(artifact.truth!.provenance.note).toContain('1 relation(s)');
  });

  it('GET /truth/entity answers history and 404s an unknown entity only after the gate', () => {
    const h = harness();
    const first = (h.call({ body: claimBody(h) }).body.record as { id: string }).id;
    h.call({ body: claimBody(h, { statement: 'v2', supersedes: first }) });
    const entity = h.call({ method: 'GET', path: CONTROL_ROUTES.truthEntity, query: { kind: 'task', id: h.fixture.taskId } });
    expect(entity.status).toBe(200);
    const truth = entity.body.truth as { history: { id: string }[]; current: { id: string }[]; currentState: string; total: number };
    expect(truth.history.map((r) => r.id)[0]).toBe(first);
    expect(truth.current).toHaveLength(1);
    expect(truth.currentState).toBe('claimed');
    expect(truth.total).toBe(2);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.truthEntity, query: { kind: 'task', id: 'ghost' } }).status).toBe(404);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.truthEntity, query: { kind: 'planet', id: 'x' } }).status).toBe(400);
    expect(h.call({ method: 'GET', path: CONTROL_ROUTES.truthEntity }).status).toBe(400);
  });
});

describe('the session advertises the truth controls from the deciding conditions', () => {
  it('truthRecord/truthVerify need the grant and the intact row; truthAccept is approval authority', () => {
    const h = harness();
    const founder = h.call({ method: 'GET', path: CONTROL_ROUTES.session }).body.controls as Record<string, boolean>;
    expect(founder.truthRecord).toBe(true);
    expect(founder.truthVerify).toBe(true);
    expect(founder.truthAccept).toBe(true);
    const analyst = h.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-analyst')).body.controls as Record<string, boolean>;
    expect(analyst.truthRecord).toBe(true);
    expect(analyst.truthVerify).toBe(false);
    expect(analyst.truthAccept).toBe(false);
    const coo = h.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-coo')).body.controls as Record<string, boolean>;
    expect(coo.truthRecord).toBe(false);
    expect(coo.truthAccept).toBe(true);
    // A disabled registry row withdraws the advertisement exactly as it refuses the write.
    h.fixture.db.prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = 'hq.truth_record'`).run();
    const withdrawn = h.call({ method: 'GET', path: CONTROL_ROUTES.session }, account('user-founder')).body.controls as Record<string, boolean>;
    expect(withdrawn.truthRecord).toBe(false);
    expect(h.call({ body: claimBody(h) }).status).toBe(403);
    void CAPS;
  });
});
