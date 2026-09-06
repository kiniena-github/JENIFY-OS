/**
 * Phase 5 memory routes, end to end against the real canonical machinery
 * (issue #265).
 *
 * The memory write and the three memory reads join the control API behind
 * the SAME pipeline as every other route — origin/content-type gate,
 * client-identity scan (body AND query), Founder resolution, `safe()` on
 * every response. This suite proves the wiring: the acting principal is
 * always the mapped one, founder_only rows are readable ONLY through the
 * Founder gate, refusals carry one status per cause, and secret-like content
 * never persists.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  CONTROL_WRITE_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-06T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

const FOUNDER_ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-founder',
  displayName: 'Founder',
  authenticatedAt: FRESH,
};
const STAFF_ACCOUNT: AuthenticatedAccount = {
  realmId: 'tenant-1',
  accountId: 'user-staff',
  displayName: 'Warehouse Lead',
  authenticatedAt: FRESH,
};
const MAP = [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }];

interface Harness {
  fixture: Fixture;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
  deps: ControlApiDeps;
}

function harness(
  options: {
    account?: AuthenticatedAccount | null;
    mutationsEnabled?: boolean;
    grant?: boolean;
    register?: boolean;
  } = {},
): Harness {
  const fixture = setupFixture();
  if (options.register !== false) registerMemoryCommandCapability(fixture.db);
  registerMissionCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities:
      options.grant === false
        ? [MISSION_COMMAND_CAPABILITY.id]
        : [MEMORY_COMMAND_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });

  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : FOUNDER_ACCOUNT;
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
    call(request, account) {
      if (account !== undefined) current = account;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/archive.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        {
          method,
          path: request.path ?? CONTROL_ROUTES.memory,
          headers,
          body: request.body,
          query: request.query,
        },
        deps,
      );
    },
  };
}

const RECORD_BODY = {
  kind: 'founder_note',
  title: 'Salt line 2 stays manual',
  body: 'Do not automate line 2 until the QC gate is live.',
  project: 'JENIFY-OS',
};

function memoryRowCount(fx: Fixture): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_memory`).get() as { n: number }).n;
}

describe('the memory write surface', () => {
  it('is on CONTROL_WRITE_ROUTES; the two parameterized reads are not', () => {
    expect(CONTROL_WRITE_ROUTES).toContain(CONTROL_ROUTES.memory);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.memorySearch);
    expect(CONTROL_WRITE_ROUTES).not.toContain(CONTROL_ROUTES.memoryContext);
  });

  it('records attributed to the mapped principal, 201 with the browser view', () => {
    const h = harness();
    const response = h.call({ body: RECORD_BODY });
    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    const record = response.body.record as Record<string, unknown>;
    expect(record.recordedBy).toBe('founder');
    expect(record.kind).toBe('founder_note');
    // The canonical record agrees, and no idempotency key crossed the wire.
    expect(h.fixture.ops.getMemoryRecord(record.id as string)!.recordedBy).toBe('founder');
    expect(JSON.stringify(response.body)).not.toContain('idempotencyKey');
  });

  it('dedupes an identical re-record with 200', () => {
    const h = harness();
    const first = h.call({ body: RECORD_BODY });
    const second = h.call({ body: RECORD_BODY });
    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect((second.body.record as { id: string }).id).toBe((first.body.record as { id: string }).id);
  });
});

describe('every hostile caller is refused, and nothing is written', () => {
  it('refuses the anonymous, the non-Founder and the unmapped alike', () => {
    for (const [account, status] of [
      [null, 401],
      [STAFF_ACCOUNT, 403],
    ] as const) {
      const h = harness({ account });
      const response = h.call({ body: RECORD_BODY });
      expect(response.status).toBe(status);
      expect(memoryRowCount(h.fixture)).toBe(0);
    }
  });

  it('refuses a body naming an actor — and a QUERY naming one too', () => {
    const h = harness();
    const viaBody = h.call({ body: { ...RECORD_BODY, requestedBy: 'someone-else' } });
    expect(viaBody.status).toBe(400);
    expect((viaBody.body.error as { code: string }).code).toBe('client_identity_supplied');

    const viaQuery = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.memorySearch,
      query: { text: 'anything', principalId: 'someone-else' },
    });
    expect(viaQuery.status).toBe(400);
    expect((viaQuery.body.error as { code: string }).code).toBe('client_identity_supplied');
    expect(memoryRowCount(h.fixture)).toBe(0);
  });

  it('refuses a POST with no origin evidence and a wrong content type', () => {
    const h = harness();
    const noOrigin = h.call({ body: RECORD_BODY, headers: { 'content-type': 'application/json' } });
    expect(noOrigin.status).toBe(403);
    const wrongType = h.call({
      body: RECORD_BODY,
      headers: { origin: ORIGIN, 'content-type': 'text/plain' },
    });
    expect(wrongType.status).toBe(403);
    expect(memoryRowCount(h.fixture)).toBe(0);
  });

  it('refuses when mutations are disabled, reads staying open', () => {
    const h = harness({ mutationsEnabled: false });
    const write = h.call({ body: RECORD_BODY });
    expect(write.status).toBe(403);
    expect((write.body.error as { code: string }).code).toBe('mutations_disabled');
    const read = h.call({ method: 'GET', path: CONTROL_ROUTES.memory });
    expect(read.status).toBe(200);
  });

  it('fails closed on missing capability and missing grant, one status per cause', () => {
    const missing = harness({ register: false });
    const noCapability = missing.call({ body: RECORD_BODY });
    expect(noCapability.status).toBe(403);
    expect((noCapability.body.error as { code: string }).code).toBe('unknown_capability');

    const ungranted = harness({ grant: false });
    const noGrant = ungranted.call({ body: RECORD_BODY });
    expect(noGrant.status).toBe(403);
    expect((noGrant.body.error as { code: string }).code).toBe('not_permitted');
  });

  it('refuses secret-like memory content before anything persists', () => {
    const h = harness();
    const response = h.call({
      body: { ...RECORD_BODY, body: 'the token is ghp_0123456789abcdef0123456789abcdef012345' },
    });
    expect(response.status).toBe(400);
    expect((response.body.error as { code: string }).code).toBe('unsafe_memory_content');
    expect(memoryRowCount(h.fixture)).toBe(0);
  });

  it('keeps unknown routes a 404 that reveals nothing', () => {
    const h = harness();
    const response = h.call({ method: 'GET', path: `${CONTROL_ROUTES.memory}/anything` });
    expect(response.status).toBe(404);
  });
});

describe('the Founder-gated reads', () => {
  it('GET /memory includes founder_only rows — this route IS the privacy-enforcing layer', () => {
    const h = harness();
    h.call({ body: { ...RECORD_BODY, title: 'Public note' } });
    h.call({ body: { ...RECORD_BODY, title: 'Private note', privacy: 'founder_only' } });
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.memory });
    expect(response.status).toBe(200);
    const records = response.body.records as { title: string; privacy: string }[];
    expect(records.map((r) => r.title).sort()).toEqual(['Private note', 'Public note']);
    // And the same read refuses a non-Founder outright.
    const refused = h.call({ method: 'GET', path: CONTROL_ROUTES.memory }, STAFF_ACCOUNT);
    expect(refused.status).toBe(403);
  });

  it('GET /memory/search answers over the archive engine with honest totals', () => {
    const h = harness();
    h.call({ body: { ...RECORD_BODY, title: 'Iodine dosing decision', kind: 'decision' } });
    h.call({ body: { ...RECORD_BODY, title: 'Packaging note' } });
    const hit = h.call({ method: 'GET', path: CONTROL_ROUTES.memorySearch, query: { text: 'iodine' } });
    expect(hit.status).toBe(200);
    expect(hit.body.total).toBe(1);
    const none = h.call({ method: 'GET', path: CONTROL_ROUTES.memorySearch, query: { text: 'zzz' } });
    expect(none.body.total).toBe(0);
    const empty = h.call({ method: 'GET', path: CONTROL_ROUTES.memorySearch, query: {} });
    expect(empty.status).toBe(400);
  });

  it('GET /memory/context assembles mission scope and 404s an unknown entity after the gate', () => {
    const h = harness();
    const commanded = h.call({
      path: CONTROL_ROUTES.missions,
      body: { title: 'T', objective: 'O' },
    });
    expect(commanded.status).toBe(201);
    const missionId = (commanded.body.mission as { id: string }).id;
    h.call({ body: { ...RECORD_BODY, title: 'Mission note', missionId } });
    h.call({ body: { ...RECORD_BODY, title: 'Unrelated note' } });

    const context = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.memoryContext,
      query: { scope: 'mission', id: missionId },
    });
    expect(context.status).toBe(200);
    const view = context.body.context as {
      scope: string;
      memory: { data: { linkage: string; records: { title: string }[] }[] };
    };
    expect(view.scope).toBe('mission');
    const titles = view.memory.data.flatMap((g) => g.records.map((r) => r.title));
    expect(titles).toContain('Mission note');
    expect(titles).not.toContain('Unrelated note');

    const unknown = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.memoryContext,
      query: { scope: 'mission', id: 'ghost' },
    });
    expect(unknown.status).toBe(404);
    const badScope = h.call({
      method: 'GET',
      path: CONTROL_ROUTES.memoryContext,
      query: { scope: 'everything', id: missionId },
    });
    expect(badScope.status).toBe(400);
  });

  it('a host sending no query leaves the parameterized reads failing closed', () => {
    const h = harness();
    const response = h.call({ method: 'GET', path: CONTROL_ROUTES.memoryContext });
    expect(response.status).toBe(400);
  });
});

describe('the session advertises the memory control from the deciding conditions', () => {
  it('advertises memoryCommand true only for the granted, registered, writable case', () => {
    const h = harness();
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((session.body.controls as { memoryCommand: boolean }).memoryCommand).toBe(true);

    const ungranted = harness({ grant: false });
    const noGrant = ungranted.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((noGrant.body.controls as { memoryCommand: boolean }).memoryCommand).toBe(false);

    const unregistered = harness({ register: false });
    const noCapability = unregistered.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((noCapability.body.controls as { memoryCommand: boolean }).memoryCommand).toBe(false);
  });
});
