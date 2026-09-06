/**
 * Shared fixture for the Phase 7 truth/evidence suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up. Builds on the lane F fixture and adds: both truth capabilities
 * registered, a claimant worker (`claude`, holds `hq.truth_record`), an
 * independent verifier worker (`codex`, holds `hq.truth_verify`), a Founder
 * holding both grants plus approval authority, and a real `op_evidence`
 * entry to reference — because a truth record may only point at evidence
 * that exists.
 */

import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  TRUTH_RECORD_CAPABILITY,
  TRUTH_VERIFY_CAPABILITY,
  registerTruthRecordCapability,
  registerTruthVerifyCapability,
} from '../src/application/truth-command.js';
import {
  MISSION_COMMAND_CAPABILITY,
  registerMissionCommandCapability,
} from '../src/application/mission-command.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  registerMemoryCommandCapability,
} from '../src/application/memory-command.js';

export interface TruthFixture extends Fixture {
  /** A real op_evidence id (the `task_created` entry of a real task). */
  evidenceId: string;
  /** A second real op_evidence id, from a second task. */
  evidenceId2: string;
  /** The task both evidence entries are about — a real canonical subject. */
  taskId: string;
}

export function truthFixture(
  options: { registerRecord?: boolean; registerVerify?: boolean } = {},
): TruthFixture {
  const fx = setupFixture();
  if (options.registerRecord !== false) registerTruthRecordCapability(fx.db);
  if (options.registerVerify !== false) registerTruthVerifyCapability(fx.db);
  registerMissionCommandCapability(fx.db);
  registerMemoryCommandCapability(fx.db);

  // The Founder: approval authority AND both truth grants (so the self-upgrade
  // pins can show that holding every grant still buys no shortcut).
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.indexDoc,
      MISSION_COMMAND_CAPABILITY.id,
      MEMORY_COMMAND_CAPABILITY.id,
      TRUTH_RECORD_CAPABILITY.id,
      TRUTH_VERIFY_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
  // A human who may record truth but holds no approval authority.
  fx.principals.register({
    id: 'analyst',
    displayName: 'Operations Analyst',
    originateCapabilities: [CAPS.readStatus, TRUTH_RECORD_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  // A human verifier with no approval authority.
  fx.principals.register({
    id: 'auditor',
    displayName: 'Independent Auditor',
    originateCapabilities: [TRUTH_VERIFY_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  // Workers: the builder claims, the reviewer verifies. Neither holds the other's grant.
  fx.store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex, TRUTH_RECORD_CAPABILITY.id],
    active: true,
  });
  fx.store.upsertSpecialist({
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    role: 'reviewer_gatekeeper',
    allowedCapabilities: [CAPS.readStatus, TRUTH_VERIFY_CAPABILITY.id],
    active: true,
  });

  // Two real canonical tasks → two real evidence entries to reference.
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { check: 'ci' },
      idempotencyKey: 'truth-fixture-1',
      requestedBy: 'claude',
      title: 'Read CI status',
    }),
  );
  const created2 = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { check: 'lint' },
      idempotencyKey: 'truth-fixture-2',
      requestedBy: 'claude',
      title: 'Read lint status',
    }),
  );
  const evidenceId = fx.ops.queue.evidence.list(created.task.id)[0]!.id;
  const evidenceId2 = fx.ops.queue.evidence.list(created2.task.id)[0]!.id;
  return { ...fx, evidenceId, evidenceId2, taskId: created.task.id };
}

/** Record a claim about the fixture task by `claude` (default) — the common starting point. */
export function claim(
  fx: TruthFixture,
  over: Partial<Parameters<TruthFixture['ops']['recordTruth']>[0]> = {},
) {
  return expectOk(
    fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'CI is green on the release branch.',
      evidenceRefs: [fx.evidenceId],
      requestedBy: 'claude',
      ...over,
    }),
  ).record;
}

/** Confirm a record by `codex` (default) with real evidence. */
export function confirm(
  fx: TruthFixture,
  truthId: string,
  over: Partial<Parameters<TruthFixture['ops']['verifyTruth']>[0]> = {},
) {
  return expectOk(
    fx.ops.verifyTruth({
      truthId,
      method: 'inspected_evidence',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'Inspected the recorded evidence entry only; did not rerun CI.',
      requestedBy: 'codex',
      ...over,
    }),
  );
}

export function count(fx: Fixture, table: string): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
