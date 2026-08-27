/**
 * HQ lane F (issue #139) — application/service layer lifecycle tests.
 *
 * These cover the happy paths and the read model. The security properties
 * (approval mutation/replay, expiry, fence/nonce, disabled worker,
 * self-review, idempotency, outcome_unknown, kill switch, prompt injection)
 * live in `application.hostile.test.ts`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { latestTaskStates } from '../src/ui/model.js';
import { createOrganizationEngine } from '../src/organization/engine.js';
import {
  createHeadquarterOperations,
  operationsSnapshot,
  organizationNominationSource,
} from '../src/application/index.js';
import { claimAndStart, makeHarness, type Harness } from './helpers/application-harness.js';

describe('HQ operations service — lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('creates a pre-approved read-only task straight into the queue', () => {
    const created = h.ops.createTask({
      capabilityId: 'repo.read_status',
      payload: { repo: 'JENIFY-OS' },
      requestedBy: 'claude',
      project: 'jenify-os',
      title: 'Check CI',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.task.status).toBe('queued');
    expect(created.data.meta.project).toBe('jenify-os');
    expect(created.data.meta.title).toBe('Check CI');
  });

  it('routes a risky capability to needs_approval, never straight to queued', () => {
    const created = h.ops.createTask({
      capabilityId: 'infra.delete_bucket',
      payload: { bucket: 'scratch' },
      idempotencyKey: 'delete-scratch-1',
      requestedBy: 'claude',
    });
    expect(created.ok && created.data.task.status).toBe('needs_approval');
  });

  it('denies a task for a capability outside the requester directory allow-list', () => {
    const created = h.ops.createTask({
      capabilityId: 'github.open_pr',
      payload: {},
      idempotencyKey: 'pr-1',
      requestedBy: 'codex',
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('policy_denied');
  });

  it('denies a task from an actor with no directory entry (deny by default)', () => {
    const created = h.ops.createTask({
      capabilityId: 'repo.read_status',
      payload: {},
      requestedBy: 'ghost-worker',
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe('policy_denied');
  });

  it('runs the full create → approve → claim → start → review → complete lifecycle', () => {
    const created = h.ops.createTask({
      capabilityId: 'github.open_pr',
      payload: { branch: 'claude/lane-f' },
      idempotencyKey: 'pr-lane-f',
      requestedBy: 'claude',
      project: 'jenify-os',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.task.id;
    expect(created.data.task.status).toBe('needs_approval');

    const digest = h.ops.displayDigest(taskId);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;

    const approved = h.ops.founderApprove({
      taskId,
      actionDigest: digest.data,
      decidedBy: 'founder',
    });
    expect(approved.ok && approved.data.status).toBe('queued');

    const { fence } = claimAndStart(h, taskId, 'claude', 'github.open_pr');
    expect(h.ops.getTask(taskId)!.status).toBe('running');

    const submitted = h.ops.submitResult(taskId, 'claude', fence, { prUrl: 'https://example/pr/1' });
    expect(submitted.ok).toBe(true);
    // A side-effect worker never reaches completed on its own.
    expect(h.ops.getTask(taskId)!.status).toBe('running');
    expect(h.ops.getTask(taskId)!.reviewState).toBe('pending');

    const reviewed = h.ops.review(taskId, 'codex', 'pass', 'verified the PR');
    expect(reviewed.ok && reviewed.data.status).toBe('completed');
    expect(h.queue.evidence.verifyChain()).toBeNull();
  });

  it('classification relabels a task without moving its approval digest', () => {
    const created = h.ops.createTask({
      capabilityId: 'infra.delete_bucket',
      payload: { bucket: 'scratch' },
      idempotencyKey: 'delete-scratch-2',
      requestedBy: 'claude',
    });
    if (!created.ok) throw new Error('setup failed');
    const taskId = created.data.task.id;
    const before = h.ops.displayDigest(taskId);
    if (!before.ok) throw new Error('setup failed');

    const classified = h.ops.classify(
      taskId,
      { project: 'company-infra', title: 'Retire scratch bucket' },
      'founder',
    );
    expect(classified.ok && classified.data.project).toBe('company-infra');

    const after = h.ops.displayDigest(taskId);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.data).toBe(before.data);
  });

  it('nominates only workers the Operator itself would allow', () => {
    const created = h.ops.createTask({
      capabilityId: 'github.open_pr',
      payload: {},
      idempotencyKey: 'pr-nominate',
      requestedBy: 'claude',
    });
    if (!created.ok) throw new Error('setup failed');
    const proposal = h.ops.nominateWorkers(created.data.task.id);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    expect(proposal.data.nominated.map((n) => n.workerId)).toEqual(['claude']);
    expect(proposal.data.nominated[0].policyOutcome).toBe('needs_approval');
  });

  it('an organization nomination cannot grant Operator rights the directory withholds', () => {
    // Lane B org state says jules occupies a role requiring github.open_pr…
    const engine = createOrganizationEngine({ capabilityIds: ['github.open_pr'] });
    engine.defineDepartment({ id: 'eng', name: 'Engineering' }, 'founder', 'setup');
    engine.defineRole(
      {
        id: 'shipper',
        name: 'Shipper',
        departmentId: 'eng',
        teamSizeTarget: 1,
        eligibleOccupantTypes: ['ai'],
        requiredCapabilities: ['github.open_pr'],
      },
      'founder',
      'setup',
    );
    engine.registerWorker(
      {
        id: 'jules',
        displayName: 'Jules',
        occupantType: 'ai',
        active: true,
        allowedCapabilities: ['github.open_pr'],
      },
      'founder',
      'setup',
    );
    engine.assignRole('shipper', 'jules', 'founder', 'setup');

    const ops = createHeadquarterOperations({
      db: h.db,
      store: h.store,
      queue: h.queue,
      policyContext: { preApprovedCapabilities: new Set(['repo.read_status']) },
      nominationSource: organizationNominationSource(engine),
    });
    const created = ops.createTask({
      capabilityId: 'github.open_pr',
      payload: {},
      idempotencyKey: 'pr-org',
      requestedBy: 'claude',
    });
    if (!created.ok) throw new Error('setup failed');

    const proposal = ops.nominateWorkers(created.data.task.id);
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    // …but the specialist directory does not grant it, so the Operator refuses.
    expect(proposal.data.nominated).toEqual([]);
    expect(proposal.data.rejected.map((r) => r.workerId)).toEqual(['jules']);

    // And the refusal is real, not cosmetic: jules still cannot claim.
    const claim = ops.claimNext('jules', 'github.open_pr');
    expect(claim.ok).toBe(false);
    if (claim.ok) return;
    expect(claim.error.code).toBe('capability_not_allowed');
  });

  it('withholds a claim from a worker the task is not intended for, and never grants one', () => {
    const created = h.ops.createTask({
      capabilityId: 'repo.read_status',
      payload: {},
      requestedBy: 'claude',
    });
    if (!created.ok) throw new Error('setup failed');
    const assigned = h.ops.assign(created.data.task.id, 'codex', 'founder');
    expect(assigned.ok).toBe(true);

    const wrongWorker = h.ops.claimNext('jules', 'repo.read_status');
    expect(wrongWorker.ok).toBe(false);
    if (wrongWorker.ok) return;
    expect(wrongWorker.error.code).toBe('reserved_for_other_worker');

    // Assignment is deny-only: it cannot admit a worker the Operator refuses.
    const notAllowed = h.ops.assign(created.data.task.id, 'idle-bot', 'founder');
    expect(notAllowed.ok).toBe(false);
    if (notAllowed.ok) return;
    expect(notAllowed.error.code).toBe('capability_not_allowed');

    const intended = h.ops.claimNext('codex', 'repo.read_status');
    expect(intended.ok).toBe(true);
  });

  it('surfaces in-flight, awaiting-review and pending-approval work in one snapshot', () => {
    const risky = h.ops.createTask({
      capabilityId: 'infra.delete_bucket',
      payload: { bucket: 'old' },
      idempotencyKey: 'delete-old',
      requestedBy: 'claude',
    });
    const shipping = h.ops.createTask({
      capabilityId: 'repo.read_status',
      payload: {},
      requestedBy: 'claude',
    });
    if (!risky.ok || !shipping.ok) throw new Error('setup failed');
    claimAndStart(h, shipping.data.task.id, 'claude', 'repo.read_status');

    const snapshot = operationsSnapshot(h.db, h.ops);
    expect(snapshot.waitingForFounder.map((a) => a.taskId)).toContain(risky.data.task.id);
    expect(snapshot.waitingForFounder[0].riskClass).toBe('destructive');
    expect(snapshot.waitingForFounder[0].staleDigest).toBe(false);
    expect(snapshot.inFlight.map((t) => t.taskId)).toContain(shipping.data.task.id);
    expect(snapshot.killSwitches).toEqual([]);
  });

  it('derived UI state always equals canonical Operator state', () => {
    const created = h.ops.createTask({
      capabilityId: 'github.open_pr',
      payload: { branch: 'x' },
      idempotencyKey: 'pr-consistency',
      requestedBy: 'claude',
      project: 'jenify-os',
    });
    if (!created.ok) throw new Error('setup failed');
    const taskId = created.data.task.id;

    const digest = h.ops.displayDigest(taskId);
    if (!digest.ok) throw new Error('setup failed');
    h.ops.founderApprove({ taskId, actionDigest: digest.data, decidedBy: 'founder' });
    const { fence } = claimAndStart(h, taskId, 'claude', 'github.open_pr');
    // Annotations must stay history, never state.
    h.ops.classify(taskId, { title: 'Ship lane F' }, 'founder');
    h.ops.submitResult(taskId, 'claude', fence, { ok: true });
    h.ops.review(taskId, 'codex', 'pass', 'looks right');

    const events = h.store.eventsFor('task', taskId);
    const [derived] = latestTaskStates(events);
    expect(derived.status).toBe(h.ops.getTask(taskId)!.status);
    expect(derived.status).toBe('completed');
    // The annotation events are present in history but changed no state.
    expect(events.some((e) => e.status === null)).toBe(true);
  });
});
