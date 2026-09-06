/**
 * Phase 9 — the collaboration record survives a real close-and-reopen of the
 * canonical database file, and a read-only handle over a pre-Phase-9 file
 * observes absence truthfully instead of migrating.
 *
 * A FILE database, not `:memory:`: the property under test is that sessions,
 * admissions, contributions, stances, handoff recommendations and every
 * refusal that depends on them are derived identically by a brand-new
 * service instance after the first connection is fully closed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openHqDatabase, openHqDatabaseReadOnly } from '../src/store/db.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import {
  collaborationSchemaPresent,
  ensureCollaborationSchema,
  registerCollaborationCommandCapability,
  registerCollaborationContributeCapability,
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
} from '../src/application/collaboration-command.js';
import { MISSION_COMMAND_CAPABILITY, registerMissionCommandCapability } from '../src/application/mission-command.js';
import { liveSnapshotFromOperations } from '../src/live/snapshot.js';
import { expectOk } from './application.fixture.js';

const CAP = 'repo.read_status';
const FOUNDER = 'durability-founder';

let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

function openOps(path: string) {
  const db = openHqDatabase(path);
  const ops = new HeadquarterOperations(db, { store: new HeadquarterStore(db) });
  return { ops, db, close: () => db.close() };
}

function configure(path: string): void {
  const db = openHqDatabase(path);
  new CapabilityRegistry(db).register({ id: CAP, description: 'Read repo/CI status', riskClass: 'read_only', sideEffect: false, idempotent: true });
  registerMissionCommandCapability(db);
  registerCollaborationCommandCapability(db);
  registerCollaborationContributeCapability(db);
  new HumanPrincipalRegistry(db).register({
    id: FOUNDER,
    displayName: 'F',
    originateCapabilities: [CAP, MISSION_COMMAND_CAPABILITY.id, COLLABORATION_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  const store = new HeadquarterStore(db);
  for (const [id, vendor] of [['claude', 'anthropic'], ['codex', 'openai'], ['jules', 'google']] as const) {
    store.upsertSpecialist({ id, displayName: id, vendor, role: 'build_lead', allowedCapabilities: [CAP, COLLABORATION_CONTRIBUTE_CAPABILITY.id], active: true });
  }
  db.close();
}

function stripClock(room: Record<string, unknown>): Record<string, unknown> {
  const { assembledAt, provenance, ...rest } = room as { assembledAt: string; provenance: { asOf: string } } & Record<string, unknown>;
  void assembledAt;
  const { asOf, ...provenanceRest } = provenance;
  void asOf;
  return { ...rest, provenance: provenanceRest };
}

describe('the collaboration record across a full close and reopen', () => {
  it('sessions, admissions, contributions, stances and handoff recommendations derive identically after restart, and every refusal is identical', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-collab-durability-'));
    const path = join(dir, 'headquarter.sqlite');
    configure(path);

    const writer = openOps(path);
    expectOk(writer.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: FOUNDER }));
    const mission = expectOk(writer.ops.commandMission({ title: 'M', objective: 'O', planItems: ['Work'], requestedBy: FOUNDER })).mission;
    const task = expectOk(writer.ops.createTask({ capabilityId: CAP, payload: { check: 'ci' }, idempotencyKey: 'dur-collab-1', requestedBy: 'claude' })).task;
    expectOk(writer.ops.linkMissionPlanItem({ missionId: mission.id, planItemSeq: 1, taskId: task.id, requestedBy: FOUNDER }));
    const claimed = expectOk(writer.ops.claimNext('claude', CAP, undefined, task.id));
    expectOk(writer.ops.startTask(task.id, 'claude', claimed.fence));
    const session = expectOk(writer.ops.openCollaborationSession({ missionId: mission.id, title: 'Room', requestedBy: FOUNDER })).session;
    expectOk(writer.ops.admitCollaborator({ sessionId: session.id, workerId: 'claude', role: 'builder', requestedBy: FOUNDER }));
    expectOk(writer.ops.admitCollaborator({ sessionId: session.id, workerId: 'codex', role: 'reviewer', requestedBy: FOUNDER }));
    expectOk(writer.ops.admitCollaborator({ sessionId: session.id, workerId: 'jules', role: 'builder', requestedBy: FOUNDER }));
    const finding = expectOk(writer.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'CI is green.', taskId: task.id, requestedBy: 'claude' })).contribution;
    expectOk(writer.ops.recordContribution({ sessionId: session.id, kind: 'critique', content: 'It is not.', requestedBy: 'codex', disagreesWith: [finding.id] }));
    expectOk(writer.ops.recordContribution({
      sessionId: session.id,
      kind: 'handoff_request',
      content: 'Jules should take it.',
      handoff: { taskId: task.id, toWorkerId: 'jules', reason: 'Context.' },
      requestedBy: 'claude',
    }));
    const roomBefore = stripClock(expectOk(writer.ops.getMissionRoom(mission.id)) as unknown as Record<string, unknown>);
    const sessionBefore = writer.ops.getCollaborationSession(session.id)!;
    const summaryBefore = writer.ops.collaborationSummary();
    const contributionsBefore = writer.ops.listContributions(session.id);
    writer.close();

    const reader = openOps(path);
    expect(reader.ops.collaborationStorePresent()).toBe(true);
    expect(stripClock(expectOk(reader.ops.getMissionRoom(mission.id)) as unknown as Record<string, unknown>)).toEqual(roomBefore);
    expect(reader.ops.getCollaborationSession(session.id)).toEqual(sessionBefore);
    expect(reader.ops.collaborationSummary()).toEqual(summaryBefore);
    expect(reader.ops.listContributions(session.id)).toEqual(contributionsBefore);
    const room = expectOk(reader.ops.getMissionRoom(mission.id));
    expect(room.disagreements).toHaveLength(1);
    expect(room.handoffRequests[0]!.canonical).toMatchObject({ status: 'running', claimedBy: 'claude', assignedWorkerId: null });
    expect(room.contributions.items.find((c) => c.id === finding.id)!.standing).toBe('disputed');
    expect(room.contributions.items.find((c) => c.id === finding.id)!.binding).toEqual({ providerId: 'CLAUDE', memberIdentityKey: null, source: 'declared_provider' });
    // The rules refuse identically after the restart, and dedupe still dedupes.
    expect(expectOk(reader.ops.admitCollaborator({ sessionId: session.id, workerId: 'claude', role: 'builder', requestedBy: FOUNDER })).deduplicated).toBe(true);
    expect(expectOk(reader.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'CI is green.', taskId: task.id, requestedBy: 'claude' })).deduplicated).toBe(true);
    const impersonation = reader.ops.recordContribution({ sessionId: session.id, kind: 'finding', content: 'x', requestedBy: 'jules', declaredBinding: { providerId: 'CLAUDE' } });
    expect(impersonation.ok).toBe(false);
    if (!impersonation.ok) expect(impersonation.error.code).toBe('provider_binding_mismatch');
    const stolen = reader.ops.claimNext('jules', CAP, undefined, task.id);
    expect(stolen.ok).toBe(false);
    expect(reader.ops.queue.get(task.id)!.claimedBy).toBe('claude');
    expect(reader.ops.readMeta(task.id)?.assignment ?? null).toBeNull();
    expect(reader.ops.queue.evidence.verifyChain()).toBeNull();
    expect((reader.db.prepare(`SELECT COUNT(*) AS n FROM hq_collab_contributions`).get() as { n: number }).n).toBe(3);
    reader.close();
  });

  it('a read-only handle over a pre-Phase-9 file observes absence; nothing is migrated; the snapshot states the absence', () => {
    dir = mkdtempSync(join(tmpdir(), 'hq-collab-readonly-'));
    const path = join(dir, 'headquarter.sqlite');
    const writer = openHqDatabase(path);
    void new HeadquarterOperations(writer, {});
    writer.exec(
      `DROP TABLE IF EXISTS hq_collab_relations; DROP TABLE IF EXISTS hq_collab_contributions;
       DROP TABLE IF EXISTS hq_collab_participants; DROP TABLE IF EXISTS hq_collab_sessions;`,
    );
    writer.close();

    const readOnly = openHqDatabaseReadOnly(path);
    expect(() => ensureCollaborationSchema(readOnly)).not.toThrow();
    expect(collaborationSchemaPresent(readOnly)).toBe(false);
    const ops = new HeadquarterOperations(readOnly, {});
    expect(ops.collaborationStorePresent()).toBe(false);
    expect(ops.listCollaborationSessions()).toEqual([]);
    expect(ops.getCollaborationSession('anything')).toBeNull();
    expect(ops.listContributions('anything')).toEqual({ contributions: [], total: 0 });
    expect(ops.collaborationSummary()).toEqual({ sessions: 0, activeSessions: 0, workersAdmitted: 0, contributions: 0, disagreements: 0, handoffRequests: 0, recent: [] });
    const snapshot = liveSnapshotFromOperations(ops, { now: '2026-09-06T12:00:00.000Z' });
    expect(snapshot.collaboration!.data.sessions).toBe(0);
    expect(snapshot.collaboration!.provenance.note).toContain('predates the Phase 9 collaboration schema');
    readOnly.close();

    const check = openHqDatabase(path);
    expect(check.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_collab_sessions'`).get()).toBeUndefined();
    check.close();
  });
});
