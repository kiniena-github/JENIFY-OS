/**
 * Phase 4 — Projects + Tasks + Dynamic AI Workforce: the Project register.
 *
 * These tests pin the properties issue #262 requires as evidence: Founder-only
 * creation through the `hq.project_command` trio (deny by default, fail closed
 * on missing/altered/disabled, never repairs), idempotent duplicate commands,
 * the two-state lifecycle with mandatory notes in both directions, audited
 * register edits, the '' <-> null stream encoding of the adopted column,
 * engine-enforced append-only project history (REPLACE/UPSERT included), and —
 * because a project organizes and never executes — that project writes touch
 * no task, approval or worker table.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  projectCommandCapabilityState,
  registerProjectCommandCapability,
} from '../src/application/project-command.js';

const FOUNDER = 'project-founder';

function projectFixture(): Fixture {
  const fx = setupFixture();
  registerProjectCommandCapability(fx.db);
  fx.principals.register({
    id: FOUNDER,
    displayName: 'Project Founder',
    originateCapabilities: [PROJECT_COMMAND_CAPABILITY.id, CAPS.readStatus],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function create(fx: Fixture, overrides: Record<string, unknown> = {}) {
  return fx.ops.createProject({
    name: 'JENIFY OS',
    purpose: 'The business operating platform and its manufacturing pilot',
    requestedBy: FOUNDER,
    ...overrides,
  });
}

function count(fx: Fixture, sql: string): number {
  return (fx.db.prepare(sql).get() as { n: number }).n;
}

describe('creating a project (Founder-gated register entry)', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = projectFixture();
  });

  it('creates one canonical register entry from a Founder command', () => {
    const { project, deduplicated } = expectOk(create(fx, { stream: 'jenify-os' }));
    expect(deduplicated).toBe(false);
    expect(project.id).toMatch(/^project-/);
    expect(project.status).toBe('active');
    expect(project.name).toBe('JENIFY OS');
    expect(project.purpose).toBe('The business operating platform and its manufacturing pilot');
    expect(project.stream).toBe('jenify-os');
    expect(project.createdBy).toBe(FOUNDER);
    expect(project.statusChangedBy).toBe(FOUNDER);
    expect(project.missions).toEqual([]);
    expect(project.taskCounts).toEqual([]);
    expect(project.authority).toEqual({
      riskClass: 'founder_gate',
      founderOnly: true,
      approvalFlow: 'originate_gated_no_approval_row',
    });
    expect(project.history.map((e) => e.kind)).toEqual(['created']);
    // No fabricated figure anywhere on the record.
    expect(JSON.stringify(project)).not.toMatch(/percent|progress|eta|cost/i);
  });

  it('zero means zero: an empty register lists nothing', () => {
    expect(fx.ops.listProjects()).toEqual([]);
    expect(fx.ops.getProject('project-nope')).toBeNull();
  });

  it('an unstated stream is stored as the adopted column demands and read back as null', () => {
    const { project } = expectOk(create(fx));
    expect(project.stream).toBeNull();
    // The wart is pinned exactly: NOT NULL column, '' in storage, null in the record.
    const raw = fx.db.prepare(`SELECT stream FROM hq_projects WHERE id = ?`).get(project.id) as {
      stream: string;
    };
    expect(raw.stream).toBe('');
  });

  it('dedupes an identical command onto the existing entry, writing nothing new', () => {
    const first = expectOk(create(fx));
    const eventsBefore = count(fx, 'SELECT COUNT(*) AS n FROM hq_project_events');
    const again = expectOk(create(fx));
    expect(again.deduplicated).toBe(true);
    expect(again.project.id).toBe(first.project.id);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_project_events')).toBe(eventsBefore);
    expect(fx.ops.listProjects()).toHaveLength(1);
  });

  it('the client idempotency key is an input to the derived key, never the key', () => {
    const a = expectOk(create(fx, { idempotencyKey: 'client-key' }));
    const b = expectOk(create(fx, { idempotencyKey: 'client-key', name: 'Different name' }));
    // Same client key, different command => different projects.
    expect(b.project.id).not.toBe(a.project.id);
    const c = expectOk(create(fx, { idempotencyKey: 'other-key' }));
    // Same command, different client key => different identity too.
    expect(c.project.id).not.toBe(a.project.id);
  });

  it('bounds every field and refuses a credential-looking command with nothing written', () => {
    expect(create(fx, { name: '' }).ok).toBe(false);
    expect(create(fx, { name: 'x'.repeat(121) }).ok).toBe(false);
    expect(create(fx, { purpose: 'x'.repeat(501) }).ok).toBe(false);
    expect(create(fx, { stream: 'x'.repeat(121) }).ok).toBe(false);
    const before = count(fx, 'SELECT COUNT(*) AS n FROM hq_projects');
    const result = create(fx, {
      purpose: 'Set api_key = wJalrXUtnFEMIK7MDENG before the rollout',
    });
    expect(result.ok).toBe(false);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_projects')).toBe(before);
  });

  it('creating a project touches no task, approval or worker table', () => {
    expectOk(create(fx));
    expect(count(fx, 'SELECT COUNT(*) AS n FROM op_tasks')).toBe(0);
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_approvals')).toBe(0);
    // The fixture registered 4 specialists; a project changes nobody.
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_specialists')).toBe(4);
  });
});

describe('who may command the project register (deny by default)', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = projectFixture();
  });

  it('refuses a registered worker outright', () => {
    const result = create(fx, { requestedBy: 'claude' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_permitted');
      expect(result.error.message).toMatch(/Founder act/);
    }
  });

  it("refuses 'system' and unknown actors", () => {
    const system = create(fx, { requestedBy: 'system' });
    expect(system.ok).toBe(false);
    const unknown = create(fx, { requestedBy: 'nobody-registered' });
    expect(unknown.ok).toBe(false);
  });

  it('refuses a principal without the project grant — even the approvals-holding COO', () => {
    const result = create(fx, { requestedBy: 'coo' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('not_permitted');
      expect(result.error.message).toContain(PROJECT_COMMAND_CAPABILITY.id);
    }
  });

  it('fails closed while the capability is missing, altered or disabled — and never repairs', () => {
    const bare = setupFixture();
    bare.principals.register({
      id: FOUNDER,
      displayName: 'Project Founder',
      originateCapabilities: [PROJECT_COMMAND_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    // Missing: never registered.
    const missing = create(bare);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('unknown_capability');
    expect(
      bare.db.prepare(`SELECT 1 FROM op_capabilities WHERE id = ?`).get(PROJECT_COMMAND_CAPABILITY.id),
    ).toBeUndefined();

    // Altered: a weakened row is refused even though it exists and is enabled.
    new CapabilityRegistry(bare.db).register({
      ...PROJECT_COMMAND_CAPABILITY,
      riskClass: 'read_only',
    });
    const altered = create(bare);
    expect(altered.ok).toBe(false);
    if (!altered.ok) expect(altered.error.code).toBe('not_permitted');

    // Disabled: registered correctly but switched off.
    const fresh = projectFixture();
    fresh.db
      .prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`)
      .run(PROJECT_COMMAND_CAPABILITY.id);
    const disabled = create(fresh);
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe('capability_disabled');
    expect(
      projectCommandCapabilityState({
        ...PROJECT_COMMAND_CAPABILITY,
        enabled: false,
      }),
    ).toBe('disabled');
  });
});

describe('the project lifecycle (two states, notes both ways)', () => {
  let fx: Fixture;
  let projectId: string;
  beforeEach(() => {
    fx = projectFixture();
    projectId = expectOk(create(fx)).project.id;
  });

  it('closes with a mandatory note and reopens with a mandatory note', () => {
    const noNote = fx.ops.transitionProject({ projectId, to: 'closed', requestedBy: FOUNDER });
    expect(noNote.ok).toBe(false);
    if (!noNote.ok) expect(noNote.error.message).toMatch(/requires a note/);

    const closed = expectOk(
      fx.ops.transitionProject({
        projectId,
        to: 'closed',
        note: 'Superseded by the Phase 4 program',
        requestedBy: FOUNDER,
      }),
    );
    expect(closed.status).toBe('closed');
    expect(closed.statusChangedBy).toBe(FOUNDER);

    const reopenNoNote = fx.ops.transitionProject({ projectId, to: 'active', requestedBy: FOUNDER });
    expect(reopenNoNote.ok).toBe(false);

    const reopened = expectOk(
      fx.ops.transitionProject({
        projectId,
        to: 'active',
        note: 'Program resumed after the review',
        requestedBy: FOUNDER,
      }),
    );
    expect(reopened.status).toBe('active');
    expect(reopened.history.map((e) => e.kind)).toEqual(['created', 'transitioned', 'transitioned']);
    expect(reopened.history[1]!.note).toBe('Superseded by the Phase 4 program');
  });

  it('refuses a replayed same-status move and an optimistic-guard mismatch', () => {
    const replay = fx.ops.transitionProject({
      projectId,
      to: 'active',
      note: 'no-op',
      requestedBy: FOUNDER,
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe('project_status_changed');

    const stale = fx.ops.transitionProject({
      projectId,
      to: 'closed',
      note: 'closing',
      expectedStatus: 'closed',
      requestedBy: FOUNDER,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe('project_status_changed');
  });

  it('refuses an unknown project only AFTER the authority gates', () => {
    // A caller without the grant learns nothing about which projects exist.
    const unauthorized = fx.ops.transitionProject({
      projectId: 'project-never-existed',
      to: 'closed',
      note: 'x',
      requestedBy: 'coo',
    });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) expect(unauthorized.error.code).toBe('not_permitted');

    const unknown = fx.ops.transitionProject({
      projectId: 'project-never-existed',
      to: 'closed',
      note: 'x',
      requestedBy: FOUNDER,
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('unknown_project');
  });

  it('filters the list by status, failing closed on an unknown filter', () => {
    expectOk(
      fx.ops.transitionProject({ projectId, to: 'closed', note: 'done', requestedBy: FOUNDER }),
    );
    expectOk(create(fx, { name: 'Second project' }));
    expect(fx.ops.listProjects('active').map((p) => p.name)).toEqual(['Second project']);
    expect(fx.ops.listProjects('closed')).toHaveLength(1);
    expect(fx.ops.listProjects('running' as never)).toEqual([]);
  });
});

describe('updating the register entry (audited, never history)', () => {
  let fx: Fixture;
  let projectId: string;
  beforeEach(() => {
    fx = projectFixture();
    projectId = expectOk(create(fx, { stream: 'jenify-os' })).project.id;
  });

  it('records exactly which fields changed', () => {
    const updated = expectOk(
      fx.ops.updateProject({
        projectId,
        purpose: 'The platform, its pilot, and the HQ control plane',
        requestedBy: FOUNDER,
      }),
    );
    expect(updated.purpose).toBe('The platform, its pilot, and the HQ control plane');
    expect(updated.name).toBe('JENIFY OS');
    const event = updated.history.find((e) => e.kind === 'updated');
    expect(event).toBeDefined();
    const detail = fx.db
      .prepare(`SELECT detail FROM hq_project_events WHERE id = ?`)
      .get(event!.id) as { detail: string };
    expect(JSON.parse(detail.detail)).toEqual({ changed: ['purpose'] });
  });

  it('clears the stream label explicitly, back to the honest null', () => {
    const updated = expectOk(fx.ops.updateProject({ projectId, stream: null, requestedBy: FOUNDER }));
    expect(updated.stream).toBeNull();
  });

  it('an update that changes nothing writes nothing', () => {
    const before = count(fx, 'SELECT COUNT(*) AS n FROM hq_project_events');
    const result = expectOk(fx.ops.updateProject({ projectId, name: 'JENIFY OS', requestedBy: FOUNDER }));
    expect(result.name).toBe('JENIFY OS');
    expect(count(fx, 'SELECT COUNT(*) AS n FROM hq_project_events')).toBe(before);
  });

  it('refuses to edit a closed entry — reopen first', () => {
    expectOk(
      fx.ops.transitionProject({ projectId, to: 'closed', note: 'done', requestedBy: FOUNDER }),
    );
    const result = fx.ops.updateProject({ projectId, name: 'Renamed', requestedBy: FOUNDER });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project_closed');
  });

  it('demands at least one field and refuses a worker', () => {
    expect(fx.ops.updateProject({ projectId, requestedBy: FOUNDER }).ok).toBe(false);
    expect(fx.ops.updateProject({ projectId, name: 'X', requestedBy: 'claude' }).ok).toBe(false);
  });
});

describe('the engine holds project history append-only', () => {
  let fx: Fixture;
  let projectId: string;
  beforeEach(() => {
    fx = projectFixture();
    projectId = expectOk(create(fx)).project.id;
  });

  it('SQLite itself aborts UPDATE, DELETE, REPLACE and UPSERT against hq_project_events', () => {
    const eventId = (
      fx.db
        .prepare(`SELECT id FROM hq_project_events WHERE project_id = ? ORDER BY seq LIMIT 1`)
        .get(projectId) as { id: string }
    ).id;
    expect(() =>
      fx.db.prepare(`UPDATE hq_project_events SET actor = 'forged' WHERE id = ?`).run(eventId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db.prepare(`DELETE FROM hq_project_events WHERE id = ?`).run(eventId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(
          `REPLACE INTO hq_project_events (id, project_id, at, actor, kind)
           VALUES (?, ?, 'now', 'attacker', 'forged')`,
        )
        .run(eventId, projectId),
    ).toThrow(/append-only/);
    expect(() =>
      fx.db
        .prepare(
          `INSERT INTO hq_project_events (id, project_id, at, actor, kind)
           VALUES (?, ?, 'now', 'attacker', 'forged')
           ON CONFLICT (id) DO UPDATE SET actor = 'attacker'`,
        )
        .run(eventId, projectId),
    ).toThrow(/append-only/);
    const event = fx.db
      .prepare(`SELECT actor, kind FROM hq_project_events WHERE id = ?`)
      .get(eventId) as { actor: string; kind: string };
    expect(event.actor).toBe(FOUNDER);
    expect(event.kind).toBe('created');
  });

  it('every project mutation lands its evidence entry atomically', () => {
    expectOk(
      fx.ops.transitionProject({ projectId, to: 'closed', note: 'done', requestedBy: FOUNDER }),
    );
    expectOk(
      fx.ops.transitionProject({ projectId, to: 'active', note: 'resumed', requestedBy: FOUNDER }),
    );
    expectOk(fx.ops.updateProject({ projectId, name: 'Renamed', requestedBy: FOUNDER }));
    const kinds = (
      fx.db
        .prepare(`SELECT kind FROM op_evidence WHERE kind LIKE 'project_%' ORDER BY seq`)
        .all() as { kind: string }[]
    ).map((r) => r.kind);
    expect(kinds).toEqual([
      'project_created',
      'project_transitioned',
      'project_transitioned',
      'project_updated',
    ]);
    // The chain still verifies with the project entries in it (null = intact).
    expect(fx.ops.queue.evidence.verifyChain()).toBeNull();
  });
});
