/**
 * Phase 4 — Dynamic AI Workforce: assignment surface, eligibility, member
 * lifecycle, deactivation, and the advisory boundary.
 *
 * These tests pin the issue #262 workforce properties: only real registered
 * workers appear anywhere; eligibility is computed from enforcement truth
 * (grants, assignability, policy) and nominations can never widen it; the
 * `hq.workforce_assign` trio gates the browser-facing assignment and refuses
 * workers outright (no self-assignment, no self-granted capability); the AI
 * member registry is lifecycle/display/advisory ONLY — registering a member
 * changes no execution grant, which is the anti-emptying proof that the
 * narrowing seam stays off; provider health is never fabricated; and
 * deactivation is Founder-gated, narrowing, and refuses while work is in
 * flight.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { openMemoryHqDatabase } from '../src/store/db.js';
import {
  WORKFORCE_ASSIGN_CAPABILITY,
  registerWorkforceAssignCapability,
} from '../src/application/workforce-command.js';
import { MemberRegistryNominationSource } from '../src/application/member-nomination.js';
import { declaredOnlyAdapter } from '../src/providers/declared.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { AiMemberRegistry } from '../src/registry/members.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';

const FOUNDER = 'workforce-founder';

function workforceFixture(): Fixture {
  const fx = setupFixture();
  registerWorkforceAssignCapability(fx.db);
  fx.principals.register({
    id: FOUNDER,
    displayName: 'Workforce Founder',
    originateCapabilities: [WORKFORCE_ASSIGN_CAPABILITY.id, CAPS.readStatus, CAPS.openPr],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

function queuedTask(fx: Fixture): string {
  return expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { kind: 'status' },
      requestedBy: FOUNDER,
    }),
  ).task.id;
}

/** A registry over the same db, providers declared-only (health unknown). */
function memberRegistry(fx: Fixture): AiMemberRegistry {
  const providers = new ProviderDirectory();
  providers.register(
    declaredOnlyAdapter({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'cloud',
      advertisedModels: [
        {
          modelId: 'claude-fable-5',
          modelVersion: '1',
          advertisedCapabilities: ['coding'],
          contextWindowTokens: null,
          defaultCostClass: 'high',
          locality: 'cloud',
        },
      ],
    }),
  );
  return new AiMemberRegistry(fx.db, providers, new MemberCapabilityRegistry(fx.db));
}

/** Ops over the SAME db with the member registry + nomination source wired. */
function opsWithRegistry(fx: Fixture, registry: AiMemberRegistry): HeadquarterOperations {
  return new HeadquarterOperations(fx.db, {
    store: new HeadquarterStore(fx.db),
    aiMemberRegistry: registry,
    nominationSources: [
      new MemberRegistryNominationSource(registry, () => new Date('2026-09-05T12:00:00Z')),
    ],
  });
}

describe('assignTaskAsFounder — the gated advisory assignment', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = workforceFixture();
  });

  it('records the intent, changes no status, dispatches nothing', () => {
    const taskId = queuedTask(fx);
    const intent = expectOk(
      fx.ops.assignTaskAsFounder({
        taskId,
        workerId: 'claude',
        founderId: FOUNDER,
        rationale: 'Build lead holds the capability',
      }),
    );
    expect(intent.workerId).toBe('claude');
    expect(intent.assignedBy).toBe(FOUNDER);
    expect(fx.ops.queue.get(taskId)!.status).toBe('queued'); // advisory: still queued
    expect(fx.ops.readMeta(taskId)!.assignment!.workerId).toBe('claude');
  });

  it('narrows claiming: the head task refuses a different worker', () => {
    const taskId = queuedTask(fx);
    expectOk(fx.ops.assignTaskAsFounder({ taskId, workerId: 'claude', founderId: FOUNDER }));
    const wrong = fx.ops.claimNext('codex', CAPS.readStatus);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('assigned_to_other_worker');
    expect(expectOk(fx.ops.claimNext('claude', CAPS.readStatus)).id).toBe(taskId);
  });

  it('refuses workers, system and ungrated principals outright — no self-assignment', () => {
    const taskId = queuedTask(fx);
    for (const actor of ['claude', 'system', 'coo', 'nobody']) {
      const result = fx.ops.assignTaskAsFounder({ taskId, workerId: 'claude', founderId: actor });
      expect(result.ok, actor).toBe(false);
    }
  });

  it('fails closed while hq.workforce_assign is missing or disabled', () => {
    const bare = setupFixture();
    bare.principals.register({
      id: FOUNDER,
      displayName: 'F',
      originateCapabilities: [WORKFORCE_ASSIGN_CAPABILITY.id],
      approvalAuthority: true,
      active: true,
    });
    const taskId = expectOk(
      bare.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: 'founder' }),
    ).task.id;
    const missing = bare.ops.assignTaskAsFounder({ taskId, workerId: 'claude', founderId: FOUNDER });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe('unknown_capability');

    fx.db
      .prepare(`UPDATE op_capabilities SET enabled = 0 WHERE id = ?`)
      .run(WORKFORCE_ASSIGN_CAPABILITY.id);
    const disabled = fx.ops.assignTaskAsFounder({
      taskId: queuedTask(fx),
      workerId: 'claude',
      founderId: FOUNDER,
    });
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.error.code).toBe('capability_disabled');
  });

  it('refuses an incompatible or inactive worker with the real reason', () => {
    const taskId = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { repo: 'jenify' },
        idempotencyKey: 'wf-pr-1',
        requestedBy: FOUNDER,
      }),
    ).task.id;
    // codex holds only read_status — the policy engine denies openPr.
    const incompatible = fx.ops.assignTaskAsFounder({
      taskId,
      workerId: 'codex',
      founderId: FOUNDER,
    });
    expect(incompatible.ok).toBe(false);
    if (!incompatible.ok) expect(incompatible.error.code).toBe('not_permitted');
    const inactive = fx.ops.assignTaskAsFounder({
      taskId,
      workerId: 'retired-bot',
      founderId: FOUNDER,
    });
    expect(inactive.ok).toBe(false);
    if (!inactive.ok) expect(inactive.error.code).toBe('worker_not_assignable');
  });

  it('scans the rationale BEFORE anything is written', () => {
    const taskId = queuedTask(fx);
    const result = fx.ops.assignTaskAsFounder({
      taskId,
      workerId: 'claude',
      founderId: FOUNDER,
      rationale: 'use api_key = wJalrXUtnFEMIK7MDENG for the run',
    });
    expect(result.ok).toBe(false);
    // No assignment was written (createTask leaves a labels-only meta row).
    expect(fx.ops.readMeta(taskId)!.assignment).toBeNull();
  });

  it('refuses assignment once a live fenced claim exists — nothing changes and nothing is appended (Sol M1)', () => {
    const taskId = queuedTask(fx);
    // Worker A genuinely claims through the atomic fenced claim path.
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expect(claimed.id).toBe(taskId);
    expect(claimed.claimedBy).toBe('claude');
    const eventsBefore = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM hq_events WHERE subject_id = ?`)
      .get(taskId) as { n: number };
    const evidenceBefore = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'assignment_intent_recorded'`)
      .get() as { n: number };

    // The Founder attempts to assign worker B over the live claim.
    const result = fx.ops.assignTaskAsFounder({ taskId, workerId: 'jules', founderId: FOUNDER });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('task_already_claimed');
      expect(result.error.details).toMatchObject({ taskId, claimedBy: 'claude', status: 'assigned' });
    }
    // Canonical claimant unchanged; no advisory meta appeared for jules.
    const task = fx.ops.queue.get(taskId)!;
    expect(task.claimedBy).toBe('claude');
    expect(task.status).toBe('assigned');
    expect(fx.ops.readMeta(taskId)!.assignment).toBeNull();
    // No false assignment event or evidence was appended by the refusal.
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_events WHERE subject_id = ?`).get(taskId) as { n: number }).n,
    ).toBe(eventsBefore.n);
    expect(
      (
        fx.db
          .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'assignment_intent_recorded'`)
          .get() as { n: number }
      ).n,
    ).toBe(evidenceBefore.n);
  });

  it('a running claim refuses the same way — the claim survives into execution', () => {
    const taskId = queuedTask(fx);
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    const result = fx.ops.assignTaskAsFounder({ taskId, workerId: 'jules', founderId: FOUNDER });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('task_already_claimed');
    expect(fx.ops.queue.get(taskId)!.claimedBy).toBe('claude');
  });

  it('refuses a task that can never return to the queue — completed keeps claimed_by, and that is not a live claim', () => {
    const created = expectOk(
      fx.ops.createTask({ capabilityId: CAPS.readStatus, payload: {}, requestedBy: FOUNDER }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    const running = expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(created.task.id, 'claude', running.fence, { ci: 'green' }));
    expect(fx.ops.queue.get(created.task.id)!.status).toBe('completed');
    // complete() leaves claimed_by for attribution — the refusal must come
    // from the queued-unreachable rule, not the live-claim rule.
    const result = fx.ops.assignTaskAsFounder({
      taskId: created.task.id,
      workerId: 'jules',
      founderId: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('task_beyond_claiming');
    expect(fx.ops.readMeta(created.task.id)!.assignment).toBeNull();
  });

  it('a reaped expired lease reopens assignment — the refusal was temporal, not terminal', () => {
    const taskId = queuedTask(fx);
    expectOk(fx.ops.claimNext('claude', CAPS.readStatus, -1_000));
    const blockedWhileClaimed = fx.ops.assignTaskAsFounder({
      taskId,
      workerId: 'jules',
      founderId: FOUNDER,
    });
    expect(blockedWhileClaimed.ok).toBe(false); // still refused: unreaped claim rows stay live truth
    fx.ops.queue.sweepExpiredLeases();
    expect(fx.ops.queue.get(taskId)!.status).toBe('queued');
    // Back in the queue, assignment genuinely narrows future claiming again.
    const intent = expectOk(fx.ops.assignTaskAsFounder({ taskId, workerId: 'jules', founderId: FOUNDER }));
    expect(intent.workerId).toBe('jules');
    const wrong = fx.ops.claimNext('claude', CAPS.readStatus);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('assigned_to_other_worker');
  });
});

describe('evaluateTaskEligibility — enforcement truth per registered worker', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = workforceFixture();
  });

  it('reports every registered worker with real grants, assignability and policy outcome', () => {
    const taskId = queuedTask(fx);
    const report = expectOk(fx.ops.evaluateTaskEligibility(taskId));
    expect(report.capabilityId).toBe(CAPS.readStatus);
    const byId = new Map(report.workers.map((w) => [w.workerId, w]));
    expect([...byId.keys()].sort()).toEqual(['claude', 'codex', 'jules', 'retired-bot']);
    expect(byId.get('claude')!.eligible).toBe(true);
    expect(byId.get('codex')!.eligible).toBe(true); // read-only cap, granted
    expect(byId.get('retired-bot')!.eligible).toBe(false);
    expect(byId.get('retired-bot')!.assignability).toEqual({
      assignable: false,
      reason: 'worker_inactive',
    });
    // Nobody fabricates availability: no provider was declared for anyone.
    expect(report.workers.every((w) => w.providerDeclared === null)).toBe(true);
  });

  it('shows a declared provider verbatim and never infers one from vendor', () => {
    const taskId = queuedTask(fx);
    expectOk(
      fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: FOUNDER }),
    );
    const report = expectOk(fx.ops.evaluateTaskEligibility(taskId));
    const byId = new Map(report.workers.map((w) => [w.workerId, w]));
    expect(byId.get('claude')!.providerDeclared).toBe('CLAUDE');
    // codex's vendor string is 'openai' — no declaration, so null, not CODEX.
    expect(byId.get('codex')!.providerDeclared).toBeNull();
  });

  it('answers unknown_task for a task that does not exist', () => {
    const result = fx.ops.evaluateTaskEligibility('task-never');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unknown_task');
  });

  it('carries the canonical task state, computed by the same predicate the assign write refuses with', () => {
    const taskId = queuedTask(fx);
    const open = expectOk(fx.ops.evaluateTaskEligibility(taskId));
    expect(open.taskState).toEqual({
      status: 'queued',
      claimedBy: null,
      assignmentOpen: true,
      reason: null,
    });

    expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    const closed = expectOk(fx.ops.evaluateTaskEligibility(taskId));
    expect(closed.taskState.assignmentOpen).toBe(false);
    expect(closed.taskState.claimedBy).toBe('claude');
    expect(closed.taskState.status).toBe('assigned');
    expect(closed.taskState.reason).toContain('already claimed by claude');
    // And the write path agrees — the whole point of the shared predicate.
    const write = fx.ops.assignTaskAsFounder({ taskId, workerId: 'jules', founderId: FOUNDER });
    expect(write.ok).toBe(false);
    if (!write.ok) expect(write.error.message).toBe(closed.taskState.reason);
  });
});

describe('the AI member registry facade — lifecycle, not authority', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = workforceFixture();
  });

  it('states unconfigured truthfully when no registry is wired', () => {
    expect(fx.ops.listAiMembers()).toEqual({ configured: false, members: [] });
    const result = fx.ops.registerAiMember({
      id: 'model-x',
      displayName: 'Model X',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      modelVersion: '1',
      workerType: 'execution',
      locality: 'cloud',
      privacyClass: 'internal',
      costClass: 'high',
      founderId: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('workforce_registry_unconfigured');
  });

  it('registers a member with health unknown by default and full evidence', () => {
    const registry = memberRegistry(fx);
    const ops = opsWithRegistry(fx, registry);
    const { member, enrichesExecutionWorker } = expectOk(
      ops.registerAiMember({
        id: 'fable-main',
        displayName: 'Fable Main Builder',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        founderId: FOUNDER,
      }),
    );
    expect(member.identityKey).toBe('anthropic:claude-fable-5:1');
    expect(member.health).toBe('unknown'); // nothing probed, nothing claimed
    expect(member.status).toBe('active');
    expect(enrichesExecutionWorker).toBe(false);
    expect(ops.listAiMembers().members.map((m) => m.id)).toEqual(['fable-main']);
    const evidence = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'ai_member_registered'`)
      .get() as { n: number };
    expect(evidence.n).toBe(1);
  });

  it("refuses a HUMAN principal's id — the identity-flip guard", () => {
    const ops = opsWithRegistry(fx, memberRegistry(fx));
    const result = ops.registerAiMember({
      id: 'founder', // a registered human principal in the fixture
      displayName: 'Impostor',
      providerId: 'anthropic',
      modelId: 'claude-fable-5',
      modelVersion: '1',
      workerType: 'execution',
      locality: 'cloud',
      privacyClass: 'internal',
      costClass: 'high',
      founderId: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_permitted');
  });

  it('registering a member under a worker id changes NO execution grant (anti-emptying)', () => {
    const registry = memberRegistry(fx);
    const ops = opsWithRegistry(fx, registry);
    const taskId = queuedTask(fx);
    const before = expectOk(ops.evaluateTaskEligibility(taskId));
    const claudeBefore = before.workers.find((w) => w.workerId === 'claude')!;
    expect(claudeBefore.eligible).toBe(true);

    // Same id as the live execution worker, with grants from the DISJOINT
    // member vocabulary (none at all here). If the narrowing seam were
    // silently active, claude's operator grants would intersect to empty.
    const { enrichesExecutionWorker } = expectOk(
      ops.registerAiMember({
        id: 'claude',
        displayName: 'Claude (member record)',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        founderId: FOUNDER,
      }),
    );
    expect(enrichesExecutionWorker).toBe(true);

    const after = expectOk(ops.evaluateTaskEligibility(taskId));
    const claudeAfter = after.workers.find((w) => w.workerId === 'claude')!;
    expect(claudeAfter.holdsCapability).toBe(true);
    expect(claudeAfter.eligible).toBe(true);
    // And the real claim path is untouched (FIFO hands the same task over).
    expect(expectOk(ops.claimNext('claude', CAPS.readStatus)).id).toBe(taskId);
  });

  it('disables a member and declares health only by explicit Founder statement', () => {
    const registry = memberRegistry(fx);
    const ops = opsWithRegistry(fx, registry);
    expectOk(
      ops.registerAiMember({
        id: 'fable-main',
        displayName: 'Fable',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        founderId: FOUNDER,
      }),
    );
    const healthy = expectOk(
      ops.setAiMemberHealth({ memberId: 'fable-main', health: 'healthy', founderId: FOUNDER }),
    );
    expect(healthy.health).toBe('healthy');
    expect(healthy.healthCheckedAt).not.toBeNull();
    expect(
      ops.setAiMemberHealth({ memberId: 'fable-main', health: 'excellent', founderId: FOUNDER }).ok,
    ).toBe(false);

    const disabled = expectOk(
      ops.disableAiMember({ memberId: 'fable-main', reason: 'model retired', founderId: FOUNDER }),
    );
    expect(disabled.member.status).toBe('disabled');
    expect(disabled.handoverRequired).toEqual([]);
    // Lifecycle is Founder-gated: a worker identity is refused outright.
    expect(
      ops.setAiMemberHealth({ memberId: 'fable-main', health: 'degraded', founderId: 'claude' }).ok,
    ).toBe(false);
  });
});

describe('the member registry as an advisory nomination source', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = workforceFixture();
  });

  it('nominates nobody from an empty registry, and never maps domains to operator ids', () => {
    const registry = memberRegistry(fx);
    const ops = opsWithRegistry(fx, registry);
    const empty = expectOk(ops.routeTask(queuedTask(fx)));
    expect(empty.nominations).toEqual([]);

    // A member granted a DOMAIN-vocabulary capability is still not nominated
    // for an operator capability id — there is no mapping, by design.
    new MemberCapabilityRegistry(fx.db).register({
      id: 'coding.general',
      domain: 'coding',
      description: 'General coding work',
      riskClass: 'reversible',
    });
    expectOk(
      ops.registerAiMember({
        id: 'coder-member',
        displayName: 'Coder',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        grantedCapabilities: ['coding.general'],
        founderId: FOUNDER,
      }),
    );
    const stillEmpty = expectOk(ops.routeTask(queuedTask(fx)));
    expect(stillEmpty.nominations).toEqual([]);
  });

  it('nominates on the EXACT operator capability id, and advice never widens eligibility', () => {
    const registry = memberRegistry(fx);
    const ops = opsWithRegistry(fx, registry);
    // The deliberate bridge: the operator capability id registered AS a
    // member capability, then granted. This is a configuration act.
    new MemberCapabilityRegistry(fx.db).register({
      id: CAPS.readStatus,
      domain: 'coding',
      description: 'Bridged operator capability id',
      riskClass: 'read_only',
    });
    expectOk(
      ops.registerAiMember({
        id: 'registry-only-model',
        displayName: 'Registry-only model',
        providerId: 'anthropic',
        modelId: 'claude-fable-5',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'high',
        grantedCapabilities: [CAPS.readStatus],
        founderId: FOUNDER,
      }),
    );
    const routed = expectOk(ops.routeTask(queuedTask(fx)));
    expect(routed.nominations).toHaveLength(1);
    const nomination = routed.nominations[0]!;
    expect(nomination.workerId).toBe('registry-only-model');
    expect(nomination.nominatedBy).toEqual(['ai-member-registry']);
    // Nominated, but NOT eligible: the id is unknown to the execution
    // directory, and advice cannot enrol anybody (issue #182).
    expect(nomination.eligible).toBe(false);
    expect(nomination.assignability).toEqual({ assignable: false, reason: 'worker_unknown' });
  });
});

describe('deactivateExecutionWorker — narrowing only, work protected', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = workforceFixture();
  });

  it('deactivates an idle worker; the worker then cannot claim', () => {
    const worker = expectOk(
      fx.ops.deactivateExecutionWorker({
        workerId: 'jules',
        reason: 'Lane closed for Phase 4',
        founderId: FOUNDER,
      }),
    );
    expect(worker.active).toBe(false);
    const taskId = queuedTask(fx);
    void taskId;
    const claim = fx.ops.claimNext('jules', CAPS.readStatus);
    expect(claim.ok).toBe(false);
    const evidence = fx.db
      .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'execution_worker_deactivated'`)
      .get() as { n: number };
    expect(evidence.n).toBe(1);
  });

  it('refuses while the worker holds in-flight work', () => {
    const taskId = queuedTask(fx);
    void taskId;
    expectOk(fx.ops.claimNext('claude', CAPS.readStatus));
    const result = fx.ops.deactivateExecutionWorker({
      workerId: 'claude',
      reason: 'attempted mid-flight',
      founderId: FOUNDER,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('replacement_blocked');
  });

  it('refuses unknown and already-inactive workers, and non-Founder actors', () => {
    expect(
      fx.ops.deactivateExecutionWorker({ workerId: 'nobody', reason: 'x', founderId: FOUNDER }).ok,
    ).toBe(false);
    expect(
      fx.ops.deactivateExecutionWorker({ workerId: 'retired-bot', reason: 'x', founderId: FOUNDER })
        .ok,
    ).toBe(false);
    expect(
      fx.ops.deactivateExecutionWorker({ workerId: 'jules', reason: 'x', founderId: 'claude' }).ok,
    ).toBe(false);
    expect(
      fx.ops.deactivateExecutionWorker({ workerId: 'jules', reason: 'x', founderId: 'analyst' }).ok,
    ).toBe(false);
  });

  it('exposes NO reactivation path — widening stays a deliberate act', () => {
    const surface = Object.getOwnPropertyNames(HeadquarterOperations.prototype);
    expect(surface.filter((name) => /reactivate|activateWorker|enableWorker/i.test(name))).toEqual(
      [],
    );
  });
});
