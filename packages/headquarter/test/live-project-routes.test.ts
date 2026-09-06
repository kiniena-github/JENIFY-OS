/**
 * Phase 4 project routes, end to end against the real canonical machinery.
 *
 * The project register writes and read join the control API behind the SAME
 * pipeline as every other route — origin/content-type gate, client-identity
 * scan, Founder resolution, `safe()` on every response. This suite proves
 * the wiring: the acting principal is always the mapped one, refusals carry
 * one status per cause, the session advertises `projectCommand` from exactly
 * the conditions that decide the write, an engaged kill switch stops
 * execution — never the recording of Founder direction — and (the recorded
 * Phase 4 re-evaluation of the Phase 3 step-up decision) no project or
 * mission-linkage write demands step-up, because none of them releases
 * execution authority.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import { CAPS, expectOk } from './application.fixture.js';
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
  if (options.register !== false) registerProjectCommandCapability(fixture.db);
  registerMissionCommandCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities:
      options.grant === false
        ? [MISSION_COMMAND_CAPABILITY.id]
        : [PROJECT_COMMAND_CAPABILITY.id, MISSION_COMMAND_CAPABILITY.id, CAPS.readStatus],
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
          ? { referer: `${ORIGIN}/hq/projects.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.projects, headers, body: request.body },
        deps,
      );
    },
  };
}

const CREATE_BODY = { name: 'JENIFY OS', purpose: 'The platform program', stream: 'jenify-os' };

function created(h: Harness): string {
  const response = h.call({ body: CREATE_BODY });
  expect(response.status).toBe(201);
  return (response.body.project as { id: string }).id;
}

describe('a mapped Founder commands the project register through the facade', () => {
  it('creates, lists, dedupes, and never fabricates a figure', () => {
    const h = harness();
    const projectId = created(h);
    const again = h.call({ body: CREATE_BODY });
    expect(again.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect((again.body.project as { id: string }).id).toBe(projectId);

    const list = h.call({ method: 'GET', path: CONTROL_ROUTES.projects });
    expect(list.status).toBe(200);
    const projects = list.body.projects as Record<string, unknown>[];
    expect(projects).toHaveLength(1);
    expect(projects[0]!.createdBy).toBe('founder');
    const serialized = JSON.stringify(list.body);
    expect(serialized).not.toMatch(/percent|progress|eta|"cost"/i);
    // The internal dedupe key never crosses the boundary.
    expect(serialized).not.toContain('idempotencyKey');
  });

  it('closes and reopens with mandatory notes, one status per refusal cause', () => {
    const h = harness();
    const projectId = created(h);
    const noNote = h.call({
      path: CONTROL_ROUTES.projectTransition,
      body: { projectId, to: 'closed' },
    });
    expect(noNote.status).toBe(400);

    const closed = h.call({
      path: CONTROL_ROUTES.projectTransition,
      body: { projectId, to: 'closed', note: 'wound down' },
    });
    expect(closed.status).toBe(200);
    expect((closed.body.project as { status: string }).status).toBe('closed');

    const stale = h.call({
      path: CONTROL_ROUTES.projectTransition,
      body: { projectId, to: 'closed', note: 'again', expectedStatus: 'active' },
    });
    expect(stale.status).toBe(409);

    const unknown = h.call({
      path: CONTROL_ROUTES.projectTransition,
      body: { projectId: 'project-never', to: 'closed', note: 'x' },
    });
    expect(unknown.status).toBe(404);
  });

  it('updates the register entry as an audited edit, refusing closed entries', () => {
    const h = harness();
    const projectId = created(h);
    const updated = h.call({
      path: CONTROL_ROUTES.projectUpdate,
      body: { projectId, purpose: 'The platform program, plus HQ' },
    });
    expect(updated.status).toBe(200);
    expect((updated.body.project as { purpose: string }).purpose).toBe(
      'The platform program, plus HQ',
    );
    expectOk(
      h.fixture.ops.transitionProject({
        projectId,
        to: 'closed',
        note: 'done',
        requestedBy: 'founder',
      }),
    );
    const refused = h.call({
      path: CONTROL_ROUTES.projectUpdate,
      body: { projectId, name: 'Renamed' },
    });
    expect(refused.status).toBe(409);
    expect((refused.body.error as { code: string }).code).toBe('project_closed');
  });

  it('carries `stream: null` across the wire as a real clear — never silently folded into "not supplied"', () => {
    const h = harness();
    const projectId = created(h); // CREATE_BODY sets stream 'jenify-os'
    expect(
      (h.call({ method: 'GET', path: CONTROL_ROUTES.projects }).body.projects as { stream: string | null }[])[0]!
        .stream,
    ).toBe('jenify-os');

    const cleared = h.call({
      path: CONTROL_ROUTES.projectUpdate,
      body: { projectId, stream: null },
    });
    expect(cleared.status).toBe(200);
    expect((cleared.body.project as { stream: string | null }).stream).toBeNull();

    // Absent stays "unchanged": an update touching only the purpose leaves
    // the cleared stream cleared and does not resurrect anything.
    const untouched = h.call({
      path: CONTROL_ROUTES.projectUpdate,
      body: { projectId, purpose: 'Still the platform program' },
    });
    expect(untouched.status).toBe(200);
    expect((untouched.body.project as { stream: string | null }).stream).toBeNull();

    // A non-string non-null is refused rather than coerced into "absent".
    const refused = h.call({
      path: CONTROL_ROUTES.projectUpdate,
      body: { projectId, stream: 42 },
    });
    expect(refused.status).toBe(400);
    expect((refused.body.error as { code: string }).code).toBe('invalid_input');
  });

  it('assigns a mission to a project and links a plan item to a real task', () => {
    const h = harness();
    const projectId = created(h);
    const commanded = h.call({
      path: CONTROL_ROUTES.missions,
      body: { title: 'Ship it', objective: 'Deliver Phase 4', planItems: ['Build the thing'] },
    });
    expect(commanded.status).toBe(201);
    const missionId = (commanded.body.mission as { id: string }).id;

    const assigned = h.call({
      path: CONTROL_ROUTES.missionAssignProject,
      body: { missionId, projectId },
    });
    expect(assigned.status).toBe(200);
    expect((assigned.body.mission as { projectId: string }).projectId).toBe(projectId);
    expect((assigned.body.mission as { projectName: string }).projectName).toBe('JENIFY OS');

    const taskId = expectOk(
      h.fixture.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { kind: 'build' },
        requestedBy: 'founder',
      }),
    ).task.id;
    const linked = h.call({
      path: CONTROL_ROUTES.missionLinkPlanItem,
      body: { missionId, planItemSeq: 1, taskId },
    });
    expect(linked.status).toBe(200);
    const mission = linked.body.mission as { planItems: { taskId: string | null }[] };
    expect(mission.planItems[0]!.taskId).toBe(taskId);

    // Unknown task: 404, reachable only for a caller holding the grant.
    const unknownTask = h.call({
      path: CONTROL_ROUTES.missionLinkPlanItem,
      body: { missionId, planItemSeq: 1, taskId: 'task-never' },
    });
    expect(unknownTask.status).toBe(400); // already linked wins as invalid_input
    const second = h.call({
      path: CONTROL_ROUTES.missions,
      body: { title: 'Second', objective: 'O', planItems: ['Item'] },
    });
    const secondId = (second.body.mission as { id: string }).id;
    const unknownTask2 = h.call({
      path: CONTROL_ROUTES.missionLinkPlanItem,
      body: { missionId: secondId, planItemSeq: 1, taskId: 'task-never' },
    });
    expect(unknownTask2.status).toBe(404);
  });
});

describe('the pipeline gates every project route exactly like the rest', () => {
  it('refuses anonymous and non-Founder callers without an identity oracle', () => {
    const h = harness();
    const anonymous = h.call({ body: CREATE_BODY }, null);
    expect(anonymous.status).toBe(401);
    const staff = h.call({ body: CREATE_BODY }, STAFF_ACCOUNT);
    expect(staff.status).toBe(403);
    expect(JSON.stringify(staff.body)).not.toContain('user-founder');
    const staffRead = h.call({ method: 'GET', path: CONTROL_ROUTES.projects }, STAFF_ACCOUNT);
    expect(staffRead.status).toBe(403);
  });

  it('refuses a body that names an actor, and an untrusted origin', () => {
    const h = harness();
    const named = h.call({ body: { ...CREATE_BODY, requestedBy: 'someone' } });
    expect(named.status).toBe(400);
    expect((named.body.error as { code: string }).code).toBe('client_identity_supplied');
    const crossOrigin = h.call({
      body: CREATE_BODY,
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
    });
    expect(crossOrigin.status).toBe(403);
    expect(h.fixture.ops.listProjects()).toHaveLength(0);
  });

  it('refuses an ungranted principal and a missing capability with 403s', () => {
    const ungranted = harness({ grant: false });
    const refused = ungranted.call({ body: CREATE_BODY });
    expect(refused.status).toBe(403);
    const unregistered = harness({ register: false });
    const missing = unregistered.call({ body: CREATE_BODY });
    expect(missing.status).toBe(403);
    expect((missing.body.error as { code: string }).code).toBe('unknown_capability');
  });

  it('honors mutations-disabled and refuses credential-looking content', () => {
    const h = harness({ mutationsEnabled: false });
    const refused = h.call({ body: CREATE_BODY });
    expect(refused.status).toBe(403);
    expect((refused.body.error as { code: string }).code).toBe('mutations_disabled');

    const live = harness();
    const unsafe = live.call({
      body: { ...CREATE_BODY, purpose: 'use api_key = wJalrXUtnFEMIK7MDENG here' },
    });
    expect(unsafe.status).toBe(400);
    expect(live.fixture.ops.listProjects()).toHaveLength(0);
  });

  it('advertises projectCommand from exactly the conditions that decide the write', () => {
    const h = harness();
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((session.body.controls as { projectCommand: boolean }).projectCommand).toBe(true);

    const ungranted = harness({ grant: false });
    const off = ungranted.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((off.body.controls as { projectCommand: boolean }).projectCommand).toBe(false);

    const readOnly = harness({ mutationsEnabled: false });
    const disabled = readOnly.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((disabled.body.controls as { projectCommand: boolean }).projectCommand).toBe(false);
  });
});

describe('the recorded Phase 4 postures hold behaviorally', () => {
  it('project writes stay open under an engaged kill switch — the switch stops execution, not direction (decisions item 5, extended)', () => {
    const h = harness();
    expectOk(h.fixture.ops.engageKillSwitch('*', 'founder', 'emergency stop'));
    const response = h.call({ body: CREATE_BODY });
    expect(response.status).toBe(201);
    const closed = h.call({
      path: CONTROL_ROUTES.projectTransition,
      body: {
        projectId: (response.body.project as { id: string }).id,
        to: 'closed',
        note: 'closing during the emergency, which must be possible',
      },
    });
    expect(closed.status).toBe(200);
  });

  it('no project or linkage write demands step-up — the exemption re-evaluated and re-affirmed at Phase 4 (decisions item 4)', () => {
    // A STALE session (older than the step-up freshness window) with no
    // credential verifier configured: an approval of founder_gate risk would
    // refuse step_up_unavailable, but recording direction must not. Phase 4
    // adds no autonomous consumer of mission/project state, so the exemption
    // holds — see the control-api module docstring for the recorded reasoning.
    const stale: AuthenticatedAccount = {
      ...FOUNDER_ACCOUNT,
      authenticatedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
    };
    const h = harness({ account: stale });
    const response = h.call({ body: CREATE_BODY });
    expect(response.status).toBe(201);
    const assigned = h.call({
      path: CONTROL_ROUTES.missionAssignProject,
      body: {
        missionId: (() => {
          const commanded = h.call({
            path: CONTROL_ROUTES.missions,
            body: { title: 'T', objective: 'O' },
          });
          return (commanded.body.mission as { id: string }).id;
        })(),
        projectId: (response.body.project as { id: string }).id,
      },
    });
    expect(assigned.status).toBe(200);
  });
});
