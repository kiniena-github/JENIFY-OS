/**
 * `--check-only` must check the executor gate too (issue #224, ChatGPT P2 on
 * `83e146b`).
 *
 * ## The defect
 *
 * The approved local proof starts with `hq:dispatch-claude --check-only`, so
 * what it prints is what the operator believes. It reported task eligibility,
 * dispatch history and transport state — every question that mattered BEFORE
 * the handoff started claiming the task, and no longer all of them.
 *
 * It never looked at the designated executor. So it could print
 * `eligibility: ELIGIBLE` and `transport: authenticated` for a dispatch that
 * fails on its very next step, because the worker is missing, deactivated,
 * lacks the capability, or was never declared as CLAUDE. A preflight that is
 * silent about the gate most likely to be unsatisfied on a fresh workstation is
 * worse than no preflight, because it is believed.
 *
 * ## What is asserted
 *
 * Each way the claim can refuse is visible BEFORE anything is published — and
 * the check remains strictly read-only, which is what makes it safe to run
 * first: it must not consume the single-use approval it is reporting on.
 */

import { describe, expect, it } from 'vitest';
import { setupFixture, CAPS, type Fixture } from './application.fixture.js';
import { taskActionDigest } from '../src/operator/approvals.js';
import { DIRECT_ORDER_CAPABILITY, registerDirectOrderCapability, submitDirectOrder } from '../src/live/orders.js';
import { claudeDispatchEligibility, executorReadiness } from '../src/providers/claude/dispatch.js';

const EXECUTOR = 'claude-executor';
const CLAUDE_ROUTING = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present' };

const ORDER = {
  instruction: 'Draft the Q3 maintenance plan for the Mesob line.',
  project: 'mesob',
  route: 'CLAUDE' as const,
  requestedBy: 'founder',
};

function ordersFixture(): Fixture {
  const fixture = setupFixture();
  registerDirectOrderCapability(fixture.ops);
  fixture.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [DIRECT_ORDER_CAPABILITY.id],
    approvalAuthority: true,
    active: true,
  });
  fixture.principals.register({
    id: 'chair',
    displayName: 'Chair',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });
  return fixture;
}

/** An approved, CLAUDE-bound order — eligible in every respect but the executor. */
function approvedOrder(fixture: Fixture): string {
  const placed = submitDirectOrder(fixture.ops, ORDER, CLAUDE_ROUTING);
  if (!placed.ok) throw new Error(`expected the order to be placed: ${placed.error.code}`);
  const approved = fixture.ops.approveTask({
    taskId: placed.data.task.id,
    founderId: 'chair',
    expectedActionDigest: taskActionDigest(placed.data.task),
  });
  expect(approved.ok).toBe(true);
  return placed.data.task.id;
}

function registerExecutor(fixture: Fixture, capabilities: string[] = [DIRECT_ORDER_CAPABILITY.id]): void {
  const result = fixture.ops.registerExecutionWorker({
    workerId: EXECUTOR,
    displayName: 'Claude GitHub workflow',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: capabilities,
    founderId: 'chair',
  });
  if (!result.ok) throw new Error(`expected registration: ${result.error.code}`);
}

describe('the executor gate is visible before anything is published', () => {
  it('is the ONLY thing wrong when the task itself is perfectly eligible', () => {
    // The exact shape of the defect: eligibility says go, the executor says no.
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);

    expect(claudeDispatchEligibility(fixture.ops, taskId).eligible).toBe(true);
    const readiness = executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.registered).toBe(false);
    expect(readiness.problems.join(' ')).toContain('not registered');
  });

  it('reports an inactive worker', () => {
    const fixture = ordersFixture();
    registerExecutor(fixture);
    fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'chair' });
    const registered = fixture.store.getSpecialist(EXECUTOR)!;
    fixture.store.upsertSpecialist({ ...registered, active: false });

    const readiness = executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.active).toBe(false);
    expect(readiness.problems.join(' ')).toContain('INACTIVE');
  });

  it('reports a worker that lacks the task capability', () => {
    const fixture = ordersFixture();
    registerExecutor(fixture, [CAPS.readStatus]);
    fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'chair' });

    const readiness = executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.hasCapability).toBe(false);
    expect(readiness.problems.join(' ')).toContain(DIRECT_ORDER_CAPABILITY.id);
  });

  it('reports a worker with no provider declaration', () => {
    const fixture = ordersFixture();
    registerExecutor(fixture);

    const readiness = executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.declaredProvider).toBeNull();
    expect(readiness.problems.join(' ')).toContain('no declared provider');
  });

  it('reports a worker declared as a DIFFERENT provider, without offering to substitute', () => {
    const fixture = ordersFixture();
    registerExecutor(fixture);
    fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CODEX', founderId: 'chair' });

    const readiness = executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id);
    expect(readiness.ready).toBe(false);
    expect(readiness.declaredProvider).toBe('CODEX');
    expect(readiness.problems.join(' ')).toContain('refuses rather than substituting');
  });

  it('is ready only when both Founder-gated configuration acts have happened', () => {
    const fixture = ordersFixture();
    registerExecutor(fixture);
    expect(executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id).ready).toBe(false);

    fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'chair' });
    const readiness = executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id);
    expect(readiness).toMatchObject({
      ready: true,
      registered: true,
      active: true,
      hasCapability: true,
      declaredProvider: 'CLAUDE',
      problems: [],
    });
  });
});

describe('the check reserves nothing', () => {
  it('leaves the task queued, its approval unconsumed and the log unchanged', () => {
    // This runs BEFORE a dispatch, on a task carrying a single-use Founder
    // approval. If the preflight consumed or claimed anything, running it would
    // itself require a fresh Founder decision — and nobody would run it.
    const fixture = ordersFixture();
    const taskId = approvedOrder(fixture);
    registerExecutor(fixture);
    fixture.ops.declareWorkerProvider({ workerId: EXECUTOR, providerId: 'CLAUDE', founderId: 'chair' });

    const before = fixture.ops.queue.get(taskId)!;
    const evidenceBefore = fixture.ops.queue.evidence.list(taskId).length;

    expect(executorReadiness(fixture.ops, EXECUTOR, DIRECT_ORDER_CAPABILITY.id).ready).toBe(true);

    const after = fixture.ops.queue.get(taskId)!;
    expect(after.status).toBe(before.status);
    expect(after.fence).toBe(before.fence);
    expect(after.claimedBy).toBeNull();
    expect(after.approvalId).toBe(before.approvalId);
    expect(fixture.ops.queue.evidence.list(taskId).length).toBe(evidenceBefore);
    // And the task is still dispatchable afterwards, which is the practical
    // form of "nothing was reserved".
    expect(claudeDispatchEligibility(fixture.ops, taskId).eligible).toBe(true);
  });

  it('answers for an unregistered worker without creating one', () => {
    const fixture = ordersFixture();
    executorReadiness(fixture.ops, 'ghost-worker', DIRECT_ORDER_CAPABILITY.id);
    expect(fixture.store.getSpecialist('ghost-worker')).toBeNull();
  });
});
