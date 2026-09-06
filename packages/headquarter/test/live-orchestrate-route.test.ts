/**
 * Phase 6 — the orchestrate route, end to end against the real canonical
 * machinery (issue #265).
 *
 * What only the route layer can prove: STEP-UP is demanded on apply (the
 * recorded Phase>=6 re-evaluation, resolved as a demand) and never on
 * preview; a stale session applies only with a fresh credential; the acting
 * principal is always the mapped one; refusals carry one status per cause;
 * spec payloads never cross back to the browser; and the kill switch refuses
 * apply wholesale through the same pipeline as everything else.
 */

import { describe, expect, it } from 'vitest';
import { CAPS, setupFixture, type Fixture } from './application.fixture.js';
import {
  handleControlRequest,
  CONTROL_ROUTES,
  type ControlApiDeps,
  type ControlResponse,
} from '../src/live/control-api.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  registerMissionOrchestrateCapability,
} from '../src/application/orchestrator-command.js';
import type { AuthenticatedAccount, ControlAuditEvent, ControlRequest } from '../src/live/auth.js';

const ORIGIN = 'https://hq.example';
const NOW = new Date('2026-09-06T16:00:00.000Z');
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();
/** Older than the step-up window: apply must demand a password. */
const STALE = new Date(NOW.getTime() - 12 * 60 * 60 * 1000).toISOString();

const MAP = [{ realmId: 'tenant-1', accountId: 'user-founder', principalId: 'founder' }];

function account(authenticatedAt: string): AuthenticatedAccount {
  return { realmId: 'tenant-1', accountId: 'user-founder', displayName: 'Founder', authenticatedAt };
}

interface Harness {
  fixture: Fixture;
  audit: ControlAuditEvent[];
  call(request: Partial<ControlRequest>, account?: AuthenticatedAccount | null): ControlResponse;
}

function harness(options: { account?: AuthenticatedAccount | null; password?: string } = {}): Harness {
  const fixture = setupFixture();
  registerMissionCommandCapability(fixture.db);
  registerMissionOrchestrateCapability(fixture.db);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [MISSION_COMMAND_CAPABILITY.id, MISSION_ORCHESTRATE_CAPABILITY.id, CAPS.readStatus],
    approvalAuthority: true,
    active: true,
  });
  const audit: ControlAuditEvent[] = [];
  let current: AuthenticatedAccount | null =
    options.account !== undefined ? options.account : account(FRESH);
  const deps: ControlApiDeps = {
    ops: fixture.ops,
    founderMap: MAP,
    allowedOrigins: [ORIGIN],
    secretsEnv: {},
    sessions: { resolve: () => current },
    credentials: {
      verify: (_account, password) => (password === (options.password ?? 'correct-password') ? 'ok' : 'rejected'),
    },
    audit: { record: (event) => audit.push(event) },
    now: () => NOW,
  };
  return {
    fixture,
    audit,
    call(request, nextAccount) {
      if (nextAccount !== undefined) current = nextAccount;
      const method = request.method ?? 'POST';
      const headers: Record<string, string | undefined> =
        request.headers ??
        (method === 'GET'
          ? { referer: `${ORIGIN}/hq/projects.html`, host: 'hq.example' }
          : { origin: ORIGIN, 'content-type': 'application/json' });
      return handleControlRequest(
        { method, path: request.path ?? CONTROL_ROUTES.missionOrchestrate, headers, body: request.body },
        deps,
      );
    },
  };
}

function commandSpecced(h: Harness): string {
  const response = h.call({
    path: CONTROL_ROUTES.missions,
    body: {
      title: 'Faster QOS site',
      objective: 'Reduce page load times',
      plan: [
        {
          summary: 'Measure load times',
          capabilityId: CAPS.readStatus,
          payload: { intent: 'measure', secretHandling: 'none' },
        },
      ],
    },
  });
  expect(response.status).toBe(201);
  return (response.body.mission as { id: string }).id;
}

describe('the orchestrate route', () => {
  it('previews and applies for a fresh Founder session, principal from the map only', () => {
    const h = harness();
    const missionId = commandSpecced(h);
    const preview = h.call({ body: { missionId, mode: 'preview' } });
    expect(preview.status).toBe(200);
    const previewReport = preview.body.report as { fingerprint: string; decisions: { decision: string }[] };
    expect(previewReport.decisions.map((d) => d.decision)).toEqual(['ready']);

    const apply = h.call({ body: { missionId, mode: 'apply', fingerprint: previewReport.fingerprint } });
    expect(apply.status).toBe(200);
    const applied = apply.body.report as { decisions: { decision: string }[] };
    expect(applied.decisions.map((d) => d.decision)).toEqual(['task_created', 'item_linked']);
    const task = h.fixture.db.prepare(`SELECT created_by FROM op_tasks`).get() as { created_by: string };
    expect(task.created_by).toBe('founder');
  });

  it('spec payloads never cross back to the browser — id and provenance only', () => {
    const h = harness();
    const missionId = commandSpecced(h);
    for (const response of [
      h.call({ method: 'GET', path: CONTROL_ROUTES.missions }),
      h.call({ body: { missionId, mode: 'preview' } }),
      h.call({ body: { missionId, mode: 'apply' } }),
    ]) {
      expect(response.status).toBe(200);
      const wire = JSON.stringify(response.body);
      expect(wire).not.toContain('secretHandling');
      expect(wire).not.toContain('specPayload');
    }
  });

  it('demands STEP-UP on apply for a stale session — and never on preview', () => {
    const h = harness({ account: account(STALE) });
    const missionId = commandSpecced(h);
    // Preview: a pure read, no step-up whatever the session age.
    expect(h.call({ body: { missionId, mode: 'preview' } }).status).toBe(200);
    // Apply without a password: step_up_required, nothing written.
    const bare = h.call({ body: { missionId, mode: 'apply' } });
    expect(bare.status).toBe(401);
    expect((bare.body.error as { code: string }).code).toBe('step_up_required');
    expect((h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
    // A wrong password is a 403 and still writes nothing.
    const wrong = h.call({ body: { missionId, mode: 'apply', stepUpPassword: 'nope' } });
    expect(wrong.status).toBe(403);
    expect((wrong.body.error as { code: string }).code).toBe('step_up_failed');
    expect((h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
    // The correct password applies.
    const confirmed = h.call({ body: { missionId, mode: 'apply', stepUpPassword: 'correct-password' } });
    expect(confirmed.status).toBe(200);
    expect((h.fixture.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(1);
  });

  it('refuses the anonymous and the non-Founder alike, and an actor-naming body', () => {
    const h = harness();
    const missionId = commandSpecced(h);
    expect(h.call({ body: { missionId, mode: 'preview' } }, null).status).toBe(401);
    const staff: AuthenticatedAccount = {
      realmId: 'tenant-1',
      accountId: 'user-staff',
      displayName: 'Staff',
      authenticatedAt: FRESH,
    };
    expect(h.call({ body: { missionId, mode: 'preview' } }, staff).status).toBe(403);
    const injected = h.call({ body: { missionId, mode: 'apply', requestedBy: 'someone-else' } }, account(FRESH));
    expect(injected.status).toBe(400);
    expect((injected.body.error as { code: string }).code).toBe('client_identity_supplied');
  });

  it('maps facade refusals one status per cause: 404 unknown, 409 stale fingerprint/state, 403 kill switch', () => {
    const h = harness();
    const missionId = commandSpecced(h);
    const unknown = h.call({ body: { missionId: 'ghost', mode: 'preview' } });
    expect(unknown.status).toBe(404);

    const preview = h.call({ body: { missionId, mode: 'preview' } });
    const fingerprint = (preview.body.report as { fingerprint: string }).fingerprint;
    h.call({
      path: CONTROL_ROUTES.missionAmend,
      body: { missionId, amendment: 'Moved since the preview.', addPlanItems: ['More work'] },
    });
    const stale = h.call({ body: { missionId, mode: 'apply', fingerprint } });
    expect(stale.status).toBe(409);
    expect((stale.body.error as { code: string }).code).toBe('orchestrate_fingerprint_mismatch');

    h.fixture.ops.engageKillSwitch('*', 'founder', 'stop');
    const blocked = h.call({ body: { missionId, mode: 'apply' } });
    expect(blocked.status).toBe(403);
    expect((blocked.body.error as { code: string }).code).toBe('kill_switch_engaged');
  });

  it('advertises missionOrchestrate from the deciding conditions', () => {
    const h = harness();
    const session = h.call({ method: 'GET', path: CONTROL_ROUTES.session });
    expect((session.body.controls as { missionOrchestrate: boolean }).missionOrchestrate).toBe(true);
  });
});
