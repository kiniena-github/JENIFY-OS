/**
 * Phase 3 Mission Core against the real canonical machinery (issue #253).
 *
 * `mission-domain.test.ts` proves the pure rules. This suite proves what can
 * only be wrong once those rules are wired to the authority layer and the
 * durable store: that a Founder command becomes ONE canonical mission with
 * stable tasks, that a retry dedupes onto it, that intent is fenced and
 * do-not rules cannot vanish, that opening task work is an ordinary gated
 * `createTask` whose authority never widens past the plan, that a stale
 * execution cannot be approved after the intent moves, that no-self-approval
 * still holds underneath all of it, that cancellation is honest about what it
 * can stop, and that everything survives a full close/reopen of the store.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { openHqDatabase } from '../src/store/db.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import {
  FOUNDER_COMMAND_CAPABILITY,
  MISSION_BINDING_KEY,
  registerFounderCommandCapability,
  type MissionResult,
} from '../src/application/mission-core.js';

const EXAMPLE = 'Improve the QOS website speed without changing the design or deploying production.';

/** A fixture with the Founder Command capability registered and granted to `founder`. */
function commandFixture(): Fixture {
  const fx = setupFixture();
  registerFounderCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, FOUNDER_COMMAND_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function missionOk<T>(result: MissionResult<T>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.data;
}

function refused<T>(result: MissionResult<T>): string {
  if (result.ok) throw new Error(`expected a refusal, got ${JSON.stringify(result.data)}`);
  return result.error.code;
}

describe('Founder command → canonical mission', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = commandFixture();
  });

  it('creates one mission with a locked objective, constraints, a plan and provenance', () => {
    const { mission, deduplicated } = missionOk(
      fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', project: 'qos-ethiopia-platform' }),
    );
    expect(deduplicated).toBe(false);
    expect(mission.status).toBe('planned');
    expect(mission.lifecycle).toBe('open');
    expect(mission.intent.objective).toBe('Improve the QOS website speed');
    expect(mission.intent.doNot).toEqual(['changing the design', 'deploying production']);
    expect(mission.project).toBe('qos-ethiopia-platform');
    expect(mission.priority).toBe('p2');
    expect(mission.riskCeiling).toBe('reversible');
    expect(mission.createdBy).toBe('founder');
    expect(mission.actorAuthentication).toBe('unauthenticated');
    expect(mission.intentVersion).toBe(1);
    expect(mission.planner).toBe('hq.deterministic-baseline.v1');
    expect(mission.decisions).toEqual([]);
    expect(mission.blockReason).toBeNull();
    // Stable, canonical task ids derived from the mission and the planner key.
    expect(mission.tasks.map((task) => task.id)).toEqual([`${mission.id}/measure`, `${mission.id}/change`, `${mission.id}/verify`]);
    expect(mission.tasks.map((task) => task.dependsOn)).toEqual([[], ['measure'], ['change']]);
    expect(mission.tasks.every((task) => task.state === 'waiting' && task.execution === null)).toBe(true);
    expect(mission.tasks.every((task) => task.doNot.includes('deploying production'))).toBe(true);
    // Evidence names the digest, never the command.
    const created = fx.ops.queue.evidence.list().find((entry) => entry.kind === 'mission_created')!;
    expect(created.actor).toBe('founder');
    expect(created.payload.commandDigest).toBe(mission.commandDigest);
    expect(JSON.stringify(created.payload)).not.toContain('QOS website');
    // No Operator task was created: a mission executes nothing by itself.
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
    // The canonical event log carries an annotation, not a task status.
    const events = fx.store.eventsFor('mission', mission.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBeNull();
    expect(events[0]!.detail?.missionStatus).toBe('planned');
  });

  it('never publishes the raw command through the read model, and never derives the title from it', () => {
    const { mission } = missionOk(
      fx.ops.missions.createFromCommand({
        instruction: 'Speed up checkout. Context note RAW-MARKER-7731 must not be shown. Keep the design.',
        requestedBy: 'founder',
      }),
    );
    const serialized = JSON.stringify([mission, fx.ops.missions.list()]);
    expect(serialized).not.toContain('RAW-MARKER-7731');
    expect(mission.title).toBe('Founder mission');
    expect(mission.commandLength).toBe('Speed up checkout. Context note RAW-MARKER-7731 must not be shown. Keep the design.'.length);
    // The manifest — server-side, for a future worker prompt — is where the
    // original command lives, and only there.
    expect(fx.ops.missions.manifest(mission.id)!.originalInstruction).toContain('RAW-MARKER-7731');
  });

  it('dedupes an identical retry onto the same mission instead of creating a second one', () => {
    const first = missionOk(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', idempotencyKey: 'k1' }));
    const second = missionOk(fx.ops.missions.createFromCommand({ instruction: `  ${EXAMPLE} `, requestedBy: 'founder', idempotencyKey: 'k1' }));
    expect(second.deduplicated).toBe(true);
    expect(second.mission.id).toBe(first.mission.id);
    expect(fx.ops.missions.list()).toHaveLength(1);
    // A different caller key is a deliberate second mission.
    const third = missionOk(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', idempotencyKey: 'k2' }));
    expect(third.deduplicated).toBe(false);
    expect(fx.ops.missions.list()).toHaveLength(2);
  });

  it('records a Founder-gate decision as BLOCKED truth rather than planning around it', () => {
    const { mission } = missionOk(
      fx.ops.missions.createFromCommand({ instruction: 'Fix the header and deploy it to production.', requestedBy: 'founder' }),
    );
    expect(mission.status).toBe('blocked');
    expect(mission.decisions).toHaveLength(1);
    expect(mission.decisions[0]!.kind).toBe('founder_gate');
    expect(mission.blockReason).toContain('1 Founder decision(s) open');
    // Nothing works around it: no task may be opened while it is open.
    const opened = fx.ops.missions.openTaskWork({
      missionId: mission.id,
      missionTaskId: mission.tasks[0]!.id,
      requestedBy: 'claude',
      expectedIntentVersion: 1,
      capabilityId: CAPS.readStatus,
      payload: {},
    });
    expect(refused(opened)).toBe('mission_status_forbids');
    // Resolving it authorizes nothing, but the mission is no longer blocked.
    const resolved = missionOk(
      fx.ops.missions.resolveDecision({
        missionId: mission.id,
        decisionId: mission.decisions[0]!.id,
        founderId: 'founder',
        expectedIntentVersion: 1,
        resolution: 'No deployment: prepare the change only.',
      }),
    );
    expect(resolved.status).toBe('planned');
    expect(resolved.decisions[0]!.status).toBe('resolved');
  });

  it('accepts a structured planner result and enforces the invariants on it', () => {
    const accepted = missionOk(
      fx.ops.missions.createFromCommand({
        instruction: EXAMPLE,
        requestedBy: 'founder',
        plan: {
          planner: 'external-planner-under-test',
          tasks: [
            { key: 'audit', title: 'Audit', summary: 'Measure', dependsOn: [], riskClass: 'read_only' },
            { key: 'images', title: 'Compress images', summary: 'Reversible', dependsOn: ['audit'], riskClass: 'reversible' },
            { key: 'cache', title: 'Cache headers', summary: 'Reversible', dependsOn: ['audit'], riskClass: 'reversible' },
            { key: 'verify', title: 'Verify', summary: 'Measure again', dependsOn: ['images', 'cache'], riskClass: 'read_only' },
          ],
        },
      }),
    );
    expect(accepted.mission.planner).toBe('external-planner-under-test');
    expect(accepted.mission.tasks.map((task) => task.key)).toEqual(['audit', 'cache', 'images', 'verify']);

    const cyclic = fx.ops.missions.createFromCommand({
      instruction: 'Another speed mission.',
      requestedBy: 'founder',
      plan: {
        planner: 'external',
        tasks: [
          { key: 'a', title: 'A', summary: '', dependsOn: ['b'], riskClass: 'read_only' },
          { key: 'b', title: 'B', summary: '', dependsOn: ['a'], riskClass: 'read_only' },
        ],
      },
    });
    expect(refused(cyclic)).toBe('plan_rejected');
    expect(!cyclic.ok && cyclic.error.details?.rejection).toBe('dependency_cycle');

    const tooMuchAuthority = fx.ops.missions.createFromCommand({
      instruction: 'Yet another speed mission.',
      requestedBy: 'founder',
      plan: { planner: 'external', tasks: [{ key: 'drop', title: 'Drop', summary: '', dependsOn: [], riskClass: 'destructive' }] },
    });
    expect(refused(tooMuchAuthority)).toBe('plan_rejected');
    expect(!tooMuchAuthority.ok && tooMuchAuthority.error.details?.rejection).toBe('authority_exceeds_mission');
    // A refused plan creates nothing.
    expect(fx.ops.missions.list()).toHaveLength(1);
  });

  it('refuses a command carrying credential-shaped text before anything is written', () => {
    const result = fx.ops.missions.createFromCommand({ instruction: 'Rotate nothing; api_key: sk-abcdefghijklmnopqrstuvwxyz', requestedBy: 'founder' });
    expect(refused(result)).toBe('unsafe_command');
    expect(fx.ops.missions.list()).toEqual([]);
  });

  it('refuses an empty or oversized command and a bad priority', () => {
    expect(refused(fx.ops.missions.createFromCommand({ instruction: '   ', requestedBy: 'founder' }))).toBe('empty_command');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: 'x'.repeat(4001), requestedBy: 'founder' }))).toBe('command_too_long');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', priority: 'urgent' as never }))).toBe('invalid_input');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', title: 't'.repeat(121) }))).toBe('title_too_long');
  });
});

describe('who may command HQ (deny by default)', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = commandFixture();
  });

  it('refuses an unknown principal, an inactive one, a human without the grant and a worker', () => {
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'nobody' }))).toBe('unknown_principal');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'former-cto' }))).toBe('unknown_principal');
    // `coo` holds approval authority and NO originate grant: approving is not commanding.
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'coo' }))).toBe('not_permitted');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'analyst' }))).toBe('not_permitted');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'claude' }))).toBe('not_permitted');
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'system' }))).toBe('unknown_principal');
    expect(fx.ops.missions.list()).toEqual([]);
  });

  it('fails closed when the capability is missing, disabled or altered, and never repairs it', () => {
    const plain = setupFixture();
    plain.principals.register({ id: 'founder', displayName: 'Founder', originateCapabilities: [FOUNDER_COMMAND_CAPABILITY.id], approvalAuthority: true, active: true });
    expect(refused(plain.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder' }))).toBe('capability_not_registered');
    expect(plain.ops.missions.capabilityState()).toBe('missing');

    registerFounderCommandCapability(plain.db);
    new CapabilityRegistry(plain.db).setEnabled(FOUNDER_COMMAND_CAPABILITY.id, false);
    expect(refused(plain.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder' }))).toBe('capability_disabled');
    // Re-registering does not re-enable a containment decision.
    registerFounderCommandCapability(plain.db);
    expect(plain.ops.missions.capabilityState()).toBe('disabled');

    new CapabilityRegistry(plain.db).register({ ...FOUNDER_COMMAND_CAPABILITY, riskClass: 'read_only', enabled: true });
    expect(plain.ops.missions.capabilityState()).toBe('altered');
    expect(refused(plain.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder' }))).toBe('capability_definition_altered');
  });

  it('refuses while the kill switch is engaged for it', () => {
    expectOk(fx.ops.engageKillSwitch(FOUNDER_COMMAND_CAPABILITY.id, 'coo', 'containment drill'));
    expect(refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder' }))).toBe('kill_switch_engaged');
  });

  it('refuses a caller asserting the earned trust marker, and records the interface-supplied one', () => {
    expect(
      refused(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', actorAuthentication: 'authenticated_os_session' })),
    ).toBe('invalid_input');
    const { mission } = missionOk(
      fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder' }, { resolvedActorAuthentication: 'authenticated_os_session' }),
    );
    expect(mission.actorAuthentication).toBe('authenticated_os_session');
  });
});

describe('Goal Lock: versioned intent, fencing, and constraints that cannot vanish', () => {
  let fx: Fixture;
  let missionId: string;
  beforeEach(() => {
    fx = commandFixture();
    missionId = missionOk(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', project: 'qos' })).mission.id;
  });

  it('refuses a stale intent version on every fenced write', () => {
    expect(refused(fx.ops.missions.reviseIntent({ missionId, founderId: 'founder', expectedIntentVersion: 0, note: 'x' }))).toBe('stale_intent_version');
    expect(refused(fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 2, reason: 'x' }))).toBe('stale_intent_version');
    expect(refused(fx.ops.missions.decideOutcome({ missionId, founderId: 'founder', expectedIntentVersion: 7, decision: 'failed', note: 'x' }))).toBe('stale_intent_version');
    expect(
      refused(
        fx.ops.missions.openTaskWork({
          missionId,
          missionTaskId: `${missionId}/measure`,
          requestedBy: 'claude',
          expectedIntentVersion: 0,
          capabilityId: CAPS.readStatus,
          payload: {},
        }),
      ),
    ).toBe('stale_intent_version');
    expect(fx.ops.missions.get(missionId)!.intentVersion).toBe(1);
  });

  it('revises as a new version, keeps the history immutable, and detects scope expansion', () => {
    const v2 = missionOk(
      fx.ops.missions.reviseIntent({
        missionId,
        founderId: 'founder',
        expectedIntentVersion: 1,
        objective: 'Improve the QOS website speed by at least 30%',
        scope: ['project:qos', 'product:qos-portal'],
        note: 'Target and product named after the call with Kiniena',
      }),
    );
    expect(v2.intentVersion).toBe(2);
    expect(v2.intent.objective).toBe('Improve the QOS website speed by at least 30%');
    expect(v2.intent.doNot).toEqual(['changing the design', 'deploying production']);
    const history = fx.ops.missions.intentHistory(missionId);
    expect(history.map((entry) => entry.version)).toEqual([1, 2]);
    expect(history[0]!.intent.objective).toBe('Improve the QOS website speed');
    expect(history[1]!.scopeExpanded).toBe(true);
    const evidence = fx.ops.queue.evidence.list().find((entry) => entry.kind === 'mission_intent_revised')!;
    expect(evidence.payload).toMatchObject({ fromVersion: 1, toVersion: 2, scopeExpanded: true, removedDoNot: [] });
    // The original command row never moved.
    expect(fx.ops.missions.manifest(missionId)!.originalInstruction).toBe(EXAMPLE);
    // An old reading is now stale.
    expect(refused(fx.ops.missions.reviseIntent({ missionId, founderId: 'founder', expectedIntentVersion: 1, note: 'late' }))).toBe('stale_intent_version');
  });

  it('refuses to let a do-not rule disappear silently, and records an explicit removal', () => {
    const silent = fx.ops.missions.reviseIntent({
      missionId,
      founderId: 'founder',
      expectedIntentVersion: 1,
      doNot: ['changing the design'],
      note: 'oops',
    });
    expect(refused(silent)).toBe('constraint_removed');
    expect(!silent.ok && silent.error.details?.removed).toEqual(['deploying production']);
    expect(fx.ops.missions.get(missionId)!.intentVersion).toBe(1);

    const explicit = missionOk(
      fx.ops.missions.reviseIntent({
        missionId,
        founderId: 'founder',
        expectedIntentVersion: 1,
        doNot: ['changing the design'],
        removeDoNot: ['deploying production'],
        note: 'Founder decided a staging deploy is in scope',
      }),
    );
    expect(explicit.intent.doNot).toEqual(['changing the design']);
    expect(fx.ops.missions.intentHistory(missionId)[1]!.removedDoNot).toEqual(['deploying production']);
  });

  it('requires Founder authority to revise, resolve, cancel or decide', () => {
    expect(refused(fx.ops.missions.reviseIntent({ missionId, founderId: 'analyst', expectedIntentVersion: 1, note: 'x' }))).toBe('not_permitted');
    expect(refused(fx.ops.missions.reviseIntent({ missionId, founderId: 'claude', expectedIntentVersion: 1, note: 'x' }))).toBe('not_permitted');
    expect(refused(fx.ops.missions.cancel({ missionId, founderId: 'nobody', expectedIntentVersion: 1, reason: 'x' }))).toBe('not_permitted');
    expect(refused(fx.ops.missions.decideOutcome({ missionId, founderId: 'system', expectedIntentVersion: 1, decision: 'failed', note: 'x' }))).toBe('not_permitted');
  });

  it('refuses to narrow the risk ceiling below a task the plan already holds', () => {
    const result = fx.ops.missions.reviseIntent({ missionId, founderId: 'founder', expectedIntentVersion: 1, riskCeiling: 'read_only', note: 'tighten' });
    expect(refused(result)).toBe('plan_rejected');
    expect(!result.ok && result.error.details?.tasks).toEqual(['change']);
  });
});

describe('opening canonical work for a mission task', () => {
  let fx: Fixture;
  let missionId: string;
  beforeEach(() => {
    fx = commandFixture();
    // A reversible, no-side-effect capability for the `change` task.
    new CapabilityRegistry(fx.db).register({ id: 'repo.apply_patch', description: 'Apply a patch on an isolated branch', riskClass: 'reversible', sideEffect: false, idempotent: true });
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex, 'repo.apply_patch'],
      active: true,
    });
    missionId = missionOk(fx.ops.missions.createFromCommand({ instruction: EXAMPLE, requestedBy: 'founder', project: 'qos' })).mission.id;
  });

  function measureId(): string {
    return `${missionId}/measure`;
  }

  it('creates an ordinary gated Operator task bound to the mission and intent version', () => {
    const opened = missionOk(
      fx.ops.missions.openTaskWork({
        missionId,
        missionTaskId: measureId(),
        requestedBy: 'claude',
        expectedIntentVersion: 1,
        capabilityId: CAPS.readStatus,
        payload: { repo: 'qos-ethiopia-platform' },
      }),
    );
    expect(opened.task.capabilityId).toBe(CAPS.readStatus);
    expect(opened.task.status).toBe('queued');
    expect(opened.task.payload[MISSION_BINDING_KEY]).toEqual({
      missionId,
      missionTaskId: measureId(),
      intentVersion: 1,
      intentDigest: fx.ops.missions.get(missionId)!.intentDigest,
    });
    expect(opened.task.idempotencyKey).toBe(`mission-task:${measureId()}:v1`);
    expect(opened.missionTask.state).toBe('waiting');
    expect(opened.missionTask.execution).toMatchObject({ taskId: opened.task.id, status: 'queued', stale: false });
    // The mission is now WORKING: canonical work exists.
    expect(fx.ops.missions.get(missionId)!.status).toBe('working');
    // The console label is a mission label, never the command.
    expect(fx.ops.readMeta(opened.task.id)?.title).toBe('Founder mission → qos — Establish the current state and a baseline');
    // Opening it again is refused rather than duplicated.
    expect(
      refused(
        fx.ops.missions.openTaskWork({
          missionId,
          missionTaskId: measureId(),
          requestedBy: 'claude',
          expectedIntentVersion: 1,
          capabilityId: CAPS.readStatus,
          payload: {},
        }),
      ),
    ).toBe('mission_task_already_opened');
  });

  it('never lets task authority widen past the plan, whatever capability is offered', () => {
    const result = fx.ops.missions.openTaskWork({
      missionId,
      missionTaskId: measureId(),
      requestedBy: 'claude',
      expectedIntentVersion: 1,
      // read_only task, external_side_effect capability
      capabilityId: CAPS.indexDoc,
      payload: {},
    });
    expect(refused(result)).toBe('authority_exceeds_task');
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n).toBe(0);
  });

  it('refuses to open a task whose dependencies are not completed, and refuses the reserved payload key', () => {
    const early = fx.ops.missions.openTaskWork({
      missionId,
      missionTaskId: `${missionId}/change`,
      requestedBy: 'claude',
      expectedIntentVersion: 1,
      capabilityId: 'repo.apply_patch',
      payload: {},
    });
    expect(refused(early)).toBe('dependencies_incomplete');
    const reserved = fx.ops.missions.openTaskWork({
      missionId,
      missionTaskId: measureId(),
      requestedBy: 'claude',
      expectedIntentVersion: 1,
      capabilityId: CAPS.readStatus,
      payload: { [MISSION_BINDING_KEY]: { missionId: 'forged' } },
    });
    expect(refused(reserved)).toBe('reserved_payload_key');
  });

  it('applies the registry allow-list to whoever opens the work — a caller cannot hand in its own', () => {
    // `jules` is not granted repo.apply_patch; `nobody` is not anyone.
    expect(
      refused(fx.ops.missions.openTaskWork({ missionId, missionTaskId: measureId(), requestedBy: 'nobody', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} })),
    ).toBe('unknown_principal');
    expect(
      refused(fx.ops.missions.openTaskWork({ missionId, missionTaskId: measureId(), requestedBy: 'retired-bot', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} })),
    ).toBe('worker_not_assignable');
  });

  it('follows canonical task truth through to READY FOR REVIEW, then needs explicit Founder outcomes', () => {
    const measure = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: measureId(), requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expect(fx.ops.missions.get(missionId)!.tasks[0]!.state).toBe('working');
    expectOk(fx.ops.submitResult(claimed.id, 'claude', claimed.fence, { baseline: 'recorded' }, ['https://example.test/evidence/baseline']));
    expect(fx.ops.missions.get(missionId)!.tasks[0]!.state).toBe('completed');
    expect(fx.ops.missions.get(missionId)!.evidenceRefs).toEqual(['https://example.test/evidence/baseline']);
    expect(measure.task.id).toBe(claimed.id);

    const change = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/change`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: 'repo.apply_patch', payload: {} }),
    );
    const claimedChange = expectOk(fx.ops.claimNext('claude', 'repo.apply_patch', undefined, change.task.id));
    expectOk(fx.ops.startTask(claimedChange.id, 'claude', claimedChange.fence));
    expectOk(fx.ops.submitResult(claimedChange.id, 'claude', claimedChange.fence, { patched: true }));

    const verify = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/verify`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} }),
    );
    const claimedVerify = expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, verify.task.id));
    expectOk(fx.ops.startTask(claimedVerify.id, 'claude', claimedVerify.fence));
    expectOk(fx.ops.submitResult(claimedVerify.id, 'claude', claimedVerify.fence, { verified: true }));

    // Every task completed is READY FOR REVIEW — not complete.
    const ready = fx.ops.missions.get(missionId)!;
    expect(ready.tasks.every((task) => task.state === 'completed')).toBe(true);
    expect(ready.status).toBe('ready_review');
    expect(ready.lifecycle).toBe('open');

    // Completion is refused until verified; verification is an explicit decision.
    expect(refused(fx.ops.missions.decideOutcome({ missionId, founderId: 'founder', expectedIntentVersion: 1, decision: 'complete', note: 'ship it' }))).toBe('mission_status_forbids');
    const verified = missionOk(fx.ops.missions.decideOutcome({ missionId, founderId: 'founder', expectedIntentVersion: 1, decision: 'verified', note: 'Evidence reviewed' }));
    expect(verified.status).toBe('verified');
    const complete = missionOk(fx.ops.missions.decideOutcome({ missionId, founderId: 'founder', expectedIntentVersion: 1, decision: 'complete', note: 'Done' }));
    expect(complete.status).toBe('complete');
    expect(complete.outcome).toMatchObject({ decision: 'complete', by: 'founder', note: 'Done' });
    // A closed mission takes no new intent or work.
    expect(refused(fx.ops.missions.reviseIntent({ missionId, founderId: 'founder', expectedIntentVersion: 1, note: 'x' }))).toBe('mission_not_open');
  });

  it('cannot be marked verified before the work exists', () => {
    expect(refused(fx.ops.missions.decideOutcome({ missionId, founderId: 'founder', expectedIntentVersion: 1, decision: 'verified', note: 'trust me' }))).toBe('mission_status_forbids');
  });

  it('reports a worker-reported failure as a failed task and a blocked mission', () => {
    missionOk(fx.ops.missions.openTaskWork({ missionId, missionTaskId: measureId(), requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} }));
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.failTask(claimed.id, 'claude', claimed.fence, 'repository unreachable'));
    const mission = fx.ops.missions.get(missionId)!;
    expect(mission.tasks[0]!.state).toBe('failed');
    expect(mission.status).toBe('blocked');
    expect(mission.blockReason).toContain('measure: failed');
  });
});

describe('approvals under a mission keep every canonical rule, and gain one', () => {
  let fx: Fixture;
  let missionId: string;
  beforeEach(() => {
    fx = commandFixture();
    // A mission whose ceiling admits an external side effect, with one such task.
    missionId = missionOk(
      fx.ops.missions.createFromCommand({
        instruction: 'Index the QOS launch notes into the archive.',
        requestedBy: 'founder',
        riskCeiling: 'external_side_effect',
        plan: { planner: 'test', tasks: [{ key: 'index', title: 'Index', summary: '', dependsOn: [], riskClass: 'external_side_effect' }] },
      }),
    ).mission.id;
  });

  it('a changed mission intent refuses the stale execution’s approval, even with the right digest', () => {
    const opened = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.indexDoc, payload: { doc: 'launch-notes' } }),
    );
    expect(opened.task.status).toBe('needs_approval');
    expect(fx.ops.missions.get(missionId)!.tasks[0]!.state).toBe('needs_approval');
    missionOk(fx.ops.missions.reviseIntent({ missionId, founderId: 'founder', expectedIntentVersion: 1, objective: 'Index ONLY the public launch notes into the archive', note: 'narrowed' }));
    expect(fx.ops.missions.get(missionId)!.tasks[0]!.execution!.stale).toBe(true);

    const digest = taskActionDigest(fx.ops.queue.get(opened.task.id)!);
    const result = fx.ops.approveTask({ taskId: opened.task.id, founderId: 'coo', expectedActionDigest: digest });
    expect(!result.ok && result.error.code).toBe('mission_intent_changed');
    expect(fx.ops.queue.get(opened.task.id)!.status).toBe('needs_approval');
    expect(fx.ops.queue.get(opened.task.id)!.approvalId).toBeNull();
    expect(fx.ops.queue.evidence.list(opened.task.id).some((entry) => entry.kind === 'approval_refused_mission_intent_changed')).toBe(true);
    // Reopening under the current intent is a NEW action with its own key.
    expect(refused(fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'claude', expectedIntentVersion: 2, capabilityId: CAPS.indexDoc, payload: {} }))).toBe('mission_task_already_opened');
  });

  it('supersedes an approval it already granted when the intent moves, and re-opens the task under the new one', () => {
    const opened = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.indexDoc, payload: { doc: 'launch-notes' } }),
    );
    const digest = taskActionDigest(fx.ops.queue.get(opened.task.id)!);
    expectOk(fx.ops.approveTask({ taskId: opened.task.id, founderId: 'coo', expectedActionDigest: digest }));
    expect(fx.ops.queue.get(opened.task.id)!.status).toBe('queued');

    // The gap this closes: the approval above was granted under v1 and is
    // unexpired, so `approveTask`'s refusal never runs again and the next claim
    // would consume it against a goal the Founder has since replaced.
    missionOk(
      fx.ops.missions.reviseIntent({
        missionId,
        founderId: 'founder',
        expectedIntentVersion: 1,
        doNot: ['touching the public site'],
        note: 'narrowed after the approval was granted',
      }),
    );
    const superseded = fx.ops.queue.get(opened.task.id)!;
    expect(superseded.status).toBe('blocked');
    expect(superseded.blockReason).toContain('intent revised to v2');
    // Nothing had been claimed and nothing ran.
    expect(superseded.claimedBy).toBeNull();
    const revised = fx.ops.queue.evidence.list().find((entry) => entry.kind === 'mission_intent_revised')!;
    expect(revised.payload.supersededExecutions).toEqual([opened.task.id]);

    // And the revision is not a dead end: the mission task re-opens under v2 as
    // a NEW action with its own idempotency key and its own approval to come.
    const reopened = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'claude', expectedIntentVersion: 2, capabilityId: CAPS.indexDoc, payload: { doc: 'launch-notes' } }),
    );
    expect(reopened.task.id).not.toBe(opened.task.id);
    expect(reopened.task.idempotencyKey).toBe(`mission-task:${missionId}/index:v2`);
    expect(reopened.task.status).toBe('needs_approval');
    expect(reopened.missionTask.execution).toMatchObject({ taskId: reopened.task.id, stale: false });
    expect(
      fx.ops.queue.evidence.list(reopened.task.id).find((entry) => entry.kind === 'mission_task_work_opened')!.payload
        .supersededOpTaskId,
    ).toBe(opened.task.id);
    // The superseded row is history, never edited away.
    expect(fx.ops.queue.get(opened.task.id)!.status).toBe('blocked');
  });

  it('a current execution is approvable by an independent Founder-authority principal, with the digest', () => {
    const opened = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.indexDoc, payload: { doc: 'launch-notes' } }),
    );
    const digest = taskActionDigest(fx.ops.queue.get(opened.task.id)!);
    expect(fx.ops.approveTask({ taskId: opened.task.id, founderId: 'coo', expectedActionDigest: 'not-the-digest' }).ok).toBe(false);
    expectOk(fx.ops.approveTask({ taskId: opened.task.id, founderId: 'coo', expectedActionDigest: digest }));
    expect(fx.ops.queue.get(opened.task.id)!.status).toBe('queued');
  });

  it('no-self-approval still holds: the principal who opened the work cannot approve it', () => {
    // The Founder holds the originate grant for indexDoc, so opens the work
    // directly as a human principal…
    const opened = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'founder', expectedIntentVersion: 1, capabilityId: CAPS.indexDoc, payload: { doc: 'launch-notes' } }),
    );
    expect(opened.task.createdBy).toBe('founder');
    const digest = taskActionDigest(fx.ops.queue.get(opened.task.id)!);
    // …and is exactly the one principal who may not approve it.
    const self = fx.ops.approveTask({ taskId: opened.task.id, founderId: 'founder', expectedActionDigest: digest });
    expect(self.ok).toBe(false);
    expect(!self.ok && self.error.code).toBe('operator_rejected');
    expect(fx.ops.queue.get(opened.task.id)!.status).toBe('needs_approval');
    // A second approval-authorized principal may.
    expectOk(fx.ops.approveTask({ taskId: opened.task.id, founderId: 'coo', expectedActionDigest: digest }));
  });
});

describe('cancellation is a real, honest path', () => {
  let fx: Fixture;
  let missionId: string;
  beforeEach(() => {
    fx = commandFixture();
    missionId = missionOk(
      fx.ops.missions.createFromCommand({
        instruction: 'Index the QOS launch notes into the archive.',
        requestedBy: 'founder',
        riskCeiling: 'external_side_effect',
        plan: {
          planner: 'test',
          tasks: [
            { key: 'read', title: 'Read', summary: '', dependsOn: [], riskClass: 'read_only' },
            { key: 'index', title: 'Index', summary: '', dependsOn: [], riskClass: 'external_side_effect' },
          ],
        },
      }),
    ).mission.id;
  });

  it('cancels a planned mission with a reason, fenced, and closes it to further writes', () => {
    const cancelled = missionOk(fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 1, reason: 'Superseded by the platform rewrite' }));
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.outcome).toMatchObject({ decision: 'cancelled', by: 'founder', note: 'Superseded by the platform rewrite' });
    expect(refused(fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 1, reason: 'again' }))).toBe('mission_not_open');
    expect(refused(fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/read`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} }))).toBe('mission_not_open');
    expect(fx.ops.queue.evidence.list().some((entry) => entry.kind === 'mission_cancelled')).toBe(true);
  });

  it('denies executions still waiting at the Founder gate as part of the cancellation', () => {
    const opened = missionOk(
      fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/index`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.indexDoc, payload: {} }),
    );
    expect(opened.task.status).toBe('needs_approval');
    const cancelled = missionOk(fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 1, reason: 'Not needed after all' }));
    expect(cancelled.status).toBe('cancelled');
    const task = fx.ops.queue.get(opened.task.id)!;
    expect(task.status).toBe('blocked');
    expect(task.blockReason).toContain('cancelled: Not needed after all');
  });

  it('refuses to cancel over canonical work it cannot honestly stop, and names it', () => {
    missionOk(fx.ops.missions.openTaskWork({ missionId, missionTaskId: `${missionId}/read`, requestedBy: 'claude', expectedIntentVersion: 1, capabilityId: CAPS.readStatus, payload: {} }));
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    const result = fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 1, reason: 'stop' });
    expect(refused(result)).toBe('cancellation_blocked');
    expect(!result.ok && result.error.details?.tasks).toEqual([{ key: 'read', taskId: claimed.id, status: 'running' }]);
    expect(fx.ops.missions.get(missionId)!.lifecycle).toBe('open');
  });

  it('requires a reason and refuses a credential-shaped one', () => {
    expect(refused(fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 1, reason: '  ' }))).toBe('invalid_input');
    expect(refused(fx.ops.missions.cancel({ missionId, founderId: 'founder', expectedIntentVersion: 1, reason: 'password: hunter2hunter2' }))).toBe('invalid_input');
    expect(fx.ops.missions.get(missionId)!.lifecycle).toBe('open');
  });
});

describe('the mission survives a full close and reopen of the store', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function openAt(path: string): { ops: HeadquarterOperations; db: ReturnType<typeof openHqDatabase> } {
    const db = openHqDatabase(path);
    const store = new HeadquarterStore(db);
    const ops = new HeadquarterOperations(db, { store });
    return { ops, db };
  }

  it('reads back objective, scope, constraints, tasks, decisions and version after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hq-mission-persist-'));
    dirs.push(dir);
    const path = join(dir, 'hq.sqlite');

    const first = openAt(path);
    registerFounderCommandCapability(first.db);
    new CapabilityRegistry(first.db).register({ id: CAPS.readStatus, description: 'Read', riskClass: 'read_only', sideEffect: false, idempotent: true });
    new HumanPrincipalRegistry(first.db).register({
      id: 'founder',
      displayName: 'Founder',
      originateCapabilities: [FOUNDER_COMMAND_CAPABILITY.id, CAPS.readStatus],
      approvalAuthority: true,
      active: true,
    });
    const created = missionOk(
      first.ops.missions.createFromCommand({
        instruction: 'Fix the header and deploy it to production without changing the design.',
        requestedBy: 'founder',
        project: 'qos',
        title: 'Header fix',
      }),
    );
    missionOk(first.ops.missions.reviseIntent({ missionId: created.mission.id, founderId: 'founder', expectedIntentVersion: 1, constraints: ['Keep the current colour palette'], note: 'palette' }));
    const before = first.ops.missions.get(created.mission.id)!;
    expect(before.intentVersion).toBe(2);
    expect(before.status).toBe('blocked');
    first.db.close();

    const second = openAt(path);
    const after = second.ops.missions.get(created.mission.id)!;
    expect(after).toEqual(before);
    expect(after.intent.doNot).toEqual(['changing the design']);
    expect(after.intent.constraints).toEqual(['Keep the current colour palette']);
    expect(after.decisions[0]!.kind).toBe('founder_gate');
    expect(second.ops.missions.intentHistory(created.mission.id)).toHaveLength(2);
    // Idempotency survives too: the same command dedupes onto the persisted row.
    const again = missionOk(
      second.ops.missions.createFromCommand({
        instruction: 'Fix the header and deploy it to production without changing the design.',
        requestedBy: 'founder',
        project: 'qos',
        title: 'Header fix',
      }),
    );
    expect(again.deduplicated).toBe(true);
    expect(again.mission.id).toBe(created.mission.id);
    // Fencing survives: the pre-restart version is what is enforced.
    expect(refused(second.ops.missions.cancel({ missionId: created.mission.id, founderId: 'founder', expectedIntentVersion: 1, reason: 'x' }))).toBe('stale_intent_version');
    second.db.close();
  });
});
