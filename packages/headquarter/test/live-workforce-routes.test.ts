/**
 * Phase 4 workforce routes, end to end against the real canonical machinery.
 *
 * GET /workforce composes the three truths this layer alone holds together —
 * enforcement (grants/assignability), transport (declared provider +
 * connectivity, three-valued dispatchability) and member enrichment — with
 * nothing inferred and nothing fabricated. The two POSTs record evidence and
 * execute nothing: /workforce/route evaluates eligibility, /workforce/assign
 * records the ADVISORY intent behind the `hq.workforce_assign` trio.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import {
  WORKFORCE_ASSIGN_CAPABILITY,
  registerWorkforceAssignCapability,
} from '../src/application/workforce-command.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { AiMemberRegistry } from '../src/registry/members.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { declaredOnlyAdapter } from '../src/providers/declared.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-05T16:00:00.000Z');
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
  ops: HeadquarterOperations;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
  deps: ControlApiDeps;
}

function harness(
  options: {
    account?: AuthenticatedAccount | null;
    grant?: boolean;
    withMemberRegistry?: boolean;
  } = {},
): Harness {
  const fixture = setupFixture();
  registerWorkforceAssignCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities:
      options.grant === false
        ? [CAPS.readStatus]
        : [WORKFORCE_ASSIGN_CAPABILITY.id, CAPS.readStatus],
    approvalAuthority: true,
    active: true,
  });

  let ops = fixture.ops;
  if (options.withMemberRegistry) {
    const providers = new ProviderDirectory();
    providers.register(
      declaredOnlyAdapter({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        kind: 'cloud',
        advertisedModels: [],
      }),
    );
    ops = new HeadquarterOperations(fixture.db, {
      store: new HeadquarterStore(fixture.db),
      aiMemberRegistry: new AiMemberRegistry(
        fixture.db,
        providers,
        new MemberCapabilityRegistry(fixture.db),
      ),
    });
  }

  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : FOUNDER_ACCOUNT;
  const deps: ControlApiDeps = {
    ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    audit: { record: (event) => audit.push(event) },
    now: () => NOW,
  };
  return {
    fixture,
    ops,
    audit,
    deps,
    call(request, account) {
      if (account !== undefined) current = account;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/specialists.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.workforce, headers, body: request.body },
        deps,
      );
    },
  };
}

function queuedTask(h: Harness): string {
  return expectOk(
    h.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { kind: 'status' },
      requestedBy: 'founder',
    }),
  ).task.id;
}

describe('GET /workforce — real workers, real truth, nothing invented', () => {
  it('lists only the registered specialists, with declared-or-null providers', () => {
    const h = harness();
    const response = h.call({ method: 'GET' });
    expect(response.status).toBe(200);
    const workers = response.body.workers as Record<string, unknown>[];
    expect(workers.map((worker) => worker.id).sort()).toEqual([
      'claude',
      'codex',
      'jules',
      'retired-bot',
    ]);
    // Nobody declared a provider, so nobody has one — vendor strings like
    // 'openai' are never turned into a provider claim.
    expect(workers.every((worker) => worker.providerDeclared === null)).toBe(true);
    expect(workers.every((worker) => worker.transport === null)).toBe(true);
    expect(workers.every((worker) => worker.member === null)).toBe(true);
    expect(response.body.memberRegistryConfigured).toBe(false);
    expect(response.body.membersNotEnrolledForExecution).toEqual([]);
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/utilization|successRate|"cost"|eta/i);
  });

  it('composes declared transport truth without claiming a connection it cannot see', () => {
    const h = harness();
    expectOk(
      h.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'founder' }),
    );
    const response = h.call({ method: 'GET' });
    const claude = (response.body.workers as Record<string, unknown>[]).find(
      (worker) => worker.id === 'claude',
    )!;
    expect(claude.providerDeclared).toBe('CLAUDE');
    const transport = claude.transport as {
      connected: boolean;
      dispatchable: boolean | null;
      missingSecrets: string[];
    };
    // Empty secrets environment: the routing contract answers NOT connected,
    // names the missing FACTS (never values), and dispatchability is null
    // because no transport seam was supplied to observe it.
    expect(transport.connected).toBe(false);
    expect(transport.missingSecrets.length).toBeGreaterThan(0);
    expect(transport.dispatchable).toBeNull();
  });

  it('labels registry-only members as not enrolled for execution', () => {
    const h = harness({ withMemberRegistry: true });
    expectOk(
      h.ops.registerAiMember({
        id: 'catalog-model',
        displayName: 'Catalog Model',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'review',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        founderId: 'founder',
      }),
    );
    const response = h.call({ method: 'GET' });
    expect(response.body.memberRegistryConfigured).toBe(true);
    const membersOnly = response.body.membersNotEnrolledForExecution as Record<string, unknown>[];
    expect(membersOnly).toHaveLength(1);
    expect(membersOnly[0]!.id).toBe('catalog-model');
    expect(membersOnly[0]!.executionWorker).toBe(false);
    expect(membersOnly[0]!.health).toBe('unknown');
    // And it does NOT appear among the execution workers.
    const workers = response.body.workers as Record<string, unknown>[];
    expect(workers.some((worker) => worker.id === 'catalog-model')).toBe(false);
  });
});

describe('POST /workforce/route — eligibility with real refusal reasons', () => {
  it('reports per-worker enforcement truth and records the evaluation', () => {
    const h = harness();
    const taskId = queuedTask(h);
    const response = h.call({ path: CONTROL_ROUTES.workforceRoute, body: { taskId } });
    expect(response.status).toBe(200);
    const report = response.body.report as {
      capabilityId: string;
      workers: { workerId: string; eligible: boolean; assignability: { reason?: string } }[];
    };
    expect(report.capabilityId).toBe(CAPS.readStatus);
    const byId = new Map(report.workers.map((worker) => [worker.workerId, worker]));
    expect(byId.get('claude')!.eligible).toBe(true);
    expect(byId.get('retired-bot')!.eligible).toBe(false);
    expect(byId.get('retired-bot')!.assignability.reason).toBe('worker_inactive');
    const evidence = h.fixture.db
      .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'routing_evaluated'`)
      .get() as { n: number };
    expect(evidence.n).toBe(1);
  });

  it('404s an unknown task and refuses anonymous callers', () => {
    const h = harness();
    expect(
      h.call({ path: CONTROL_ROUTES.workforceRoute, body: { taskId: 'task-never' } }).status,
    ).toBe(404);
    expect(h.call({ path: CONTROL_ROUTES.workforceRoute, body: { taskId: 'x' } }, null).status).toBe(
      401,
    );
  });
});

describe('POST /workforce/assign — advisory, gated, honest', () => {
  it('records the intent without changing the task, and narrows claiming', () => {
    const h = harness();
    const taskId = queuedTask(h);
    const response = h.call({
      path: CONTROL_ROUTES.workforceAssign,
      body: { taskId, workerId: 'claude', rationale: 'Build lead' },
    });
    expect(response.status).toBe(200);
    const assignment = response.body.assignment as { workerId: string; assignedBy: string };
    expect(assignment.workerId).toBe('claude');
    expect(assignment.assignedBy).toBe('founder');
    expect(h.ops.queue.get(taskId)!.status).toBe('queued');
    const wrong = h.ops.claimNext('codex', CAPS.readStatus);
    expect(wrong.ok).toBe(false);
  });

  it('refuses non-Founder sessions, ungranted principals and incompatible workers', () => {
    const h = harness();
    const taskId = queuedTask(h);
    expect(
      h.call(
        { path: CONTROL_ROUTES.workforceAssign, body: { taskId, workerId: 'claude' } },
        STAFF_ACCOUNT,
      ).status,
    ).toBe(403);

    const ungranted = harness({ grant: false });
    const refused = ungranted.call({
      path: CONTROL_ROUTES.workforceAssign,
      body: { taskId: queuedTask(ungranted), workerId: 'claude' },
    });
    expect(refused.status).toBe(403);

    const inactive = h.call(
      { path: CONTROL_ROUTES.workforceAssign, body: { taskId, workerId: 'retired-bot' } },
      FOUNDER_ACCOUNT,
    );
    expect(inactive.status).toBe(409);
    expect((inactive.body.error as { code: string }).code).toBe('worker_not_assignable');
  });

  it('advertises workforceAssign from exactly the conditions that decide the write', () => {
    const h = harness();
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((session.body.controls as { workforceAssign: boolean }).workforceAssign).toBe(true);
    const ungranted = harness({ grant: false });
    const off = ungranted.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((off.body.controls as { workforceAssign: boolean }).workforceAssign).toBe(false);
  });
});
