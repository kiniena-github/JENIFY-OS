/**
 * Shared fixture for the Phase 9 Mission Room / collaboration suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up. Builds on the lane F fixture and adds: the mission-command and
 * both truth trios registered, both collaboration trios registered, a Founder
 * holding the collaboration command grant, an `analyst` human who does not,
 * three real execution workers holding `hq.collaboration_contribute` (one
 * with a declared provider AND a registered model identity, one with a
 * declared provider only, one undeclared), one worker WITHOUT the contribute
 * grant, the inactive `retired-bot`, and one commanded mission with a real
 * canonical task linked to its plan.
 */

import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import {
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
  registerCollaborationCommandCapability,
  registerCollaborationContributeCapability,
  type CollaborationRole,
} from '../src/application/collaboration-command.js';
import { MISSION_COMMAND_CAPABILITY, registerMissionCommandCapability } from '../src/application/mission-command.js';
import { MEMORY_COMMAND_CAPABILITY, registerMemoryCommandCapability } from '../src/application/memory-command.js';
import { WORKFORCE_ASSIGN_CAPABILITY, registerWorkforceAssignCapability } from '../src/application/workforce-command.js';
import {
  TRUTH_RECORD_CAPABILITY,
  TRUTH_VERIFY_CAPABILITY,
  registerTruthRecordCapability,
  registerTruthVerifyCapability,
} from '../src/application/truth-command.js';
import { declaredOnlyAdapter } from '../src/providers/declared.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { AiMemberRegistry } from '../src/registry/members.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';

export interface CollaborationFixture extends Fixture {
  missionId: string;
  /** The real canonical task linked to plan item 1 of the mission. */
  taskId: string;
  /** A real op_evidence id (the linked task's `task_created` entry). */
  evidenceId: string;
  /** The registry the model identity of `claude` was registered in. */
  members: AiMemberRegistry;
}

/** Registered model identity for the `claude` worker: what the registry vocabulary binds. */
export const CLAUDE_MODEL = { providerId: 'anthropic', modelId: 'claude-fable-5', modelVersion: '1' } as const;

export function collaborationFixture(
  options: { registerCommand?: boolean; registerContribute?: boolean } = {},
): CollaborationFixture {
  const fx = setupFixture();
  if (options.registerCommand !== false) registerCollaborationCommandCapability(fx.db);
  if (options.registerContribute !== false) registerCollaborationContributeCapability(fx.db);
  registerMissionCommandCapability(fx.db);
  registerMemoryCommandCapability(fx.db);
  registerWorkforceAssignCapability(fx.db);
  registerTruthRecordCapability(fx.db);
  registerTruthVerifyCapability(fx.db);

  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.indexDoc,
      MISSION_COMMAND_CAPABILITY.id,
      MEMORY_COMMAND_CAPABILITY.id,
      WORKFORCE_ASSIGN_CAPABILITY.id,
      TRUTH_RECORD_CAPABILITY.id,
      TRUTH_VERIFY_CAPABILITY.id,
      COLLABORATION_COMMAND_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
  // A human who may command missions and record truth but holds no collaboration command grant.
  fx.principals.register({
    id: 'analyst',
    displayName: 'Operations Analyst',
    originateCapabilities: [CAPS.readStatus, MISSION_COMMAND_CAPABILITY.id, TRUTH_RECORD_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });

  // Workers. `claude` and `jules` build; `codex` reviews/verifies. All three hold the contribute grant.
  fx.store.upsertSpecialist({
    id: 'claude',
    displayName: 'Claude',
    vendor: 'anthropic',
    role: 'build_lead',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex, TRUTH_RECORD_CAPABILITY.id, COLLABORATION_CONTRIBUTE_CAPABILITY.id],
    active: true,
  });
  fx.store.upsertSpecialist({
    id: 'codex',
    displayName: 'Codex',
    vendor: 'openai',
    role: 'reviewer_gatekeeper',
    allowedCapabilities: [CAPS.readStatus, TRUTH_VERIFY_CAPABILITY.id, COLLABORATION_CONTRIBUTE_CAPABILITY.id],
    active: true,
  });
  fx.store.upsertSpecialist({
    id: 'jules',
    displayName: 'Jules',
    vendor: 'google',
    role: 'parallel_implementer',
    allowedCapabilities: [CAPS.readStatus, CAPS.openPr, COLLABORATION_CONTRIBUTE_CAPABILITY.id],
    active: true,
  });
  // Active, registered, but never granted the contribute capability.
  fx.store.upsertSpecialist({
    id: 'mute-bot',
    displayName: 'Mute Bot',
    vendor: 'internal',
    role: 'specialist_tool',
    allowedCapabilities: [CAPS.readStatus],
    active: true,
  });
  fx.store.upsertSpecialist({
    id: 'retired-bot',
    displayName: 'Retired Bot',
    vendor: 'internal',
    role: 'specialist_tool',
    allowedCapabilities: [CAPS.readStatus, COLLABORATION_CONTRIBUTE_CAPABILITY.id],
    active: false,
  });

  // Canonical provider declarations (routing vocabulary): claude and codex
  // declared, jules deliberately undeclared.
  expectOk(fx.ops.declareWorkerProvider({ workerId: 'claude', providerId: 'CLAUDE', founderId: 'founder' }));
  expectOk(fx.ops.declareWorkerProvider({ workerId: 'codex', providerId: 'CODEX', founderId: 'founder' }));

  // Registered model identity (registry vocabulary) for claude only.
  const providers = new ProviderDirectory();
  providers.register(
    declaredOnlyAdapter({
      providerId: CLAUDE_MODEL.providerId,
      displayName: 'Anthropic',
      kind: 'cloud',
      advertisedModels: [
        {
          modelId: CLAUDE_MODEL.modelId,
          modelVersion: CLAUDE_MODEL.modelVersion,
          advertisedCapabilities: ['coding'],
          contextWindowTokens: null,
          defaultCostClass: 'high',
          locality: 'cloud',
        },
      ],
    }),
  );
  const members = new AiMemberRegistry(fx.db, providers, new MemberCapabilityRegistry(fx.db));
  members.register({
    id: 'claude',
    displayName: 'Claude',
    providerId: CLAUDE_MODEL.providerId,
    modelId: CLAUDE_MODEL.modelId,
    modelVersion: CLAUDE_MODEL.modelVersion,
    workerType: 'execution',
    locality: 'cloud',
    privacyClass: 'internal',
    costClass: 'high',
  });

  // One commanded mission with a real canonical task linked to plan item 1.
  const mission = expectOk(
    fx.ops.commandMission({
      title: 'Faster QOS site',
      objective: 'Reduce page load times without changing the visual design',
      constraints: ['Do not change the visual design', 'Do not deploy production'],
      planItems: ['Measure the current load time', 'Optimize the largest asset'],
      requestedBy: 'founder',
    }),
  ).mission;
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.readStatus,
      payload: { check: 'lighthouse' },
      idempotencyKey: 'collab-fixture-task',
      requestedBy: 'claude',
      title: 'Measure load time',
    }),
  );
  expectOk(fx.ops.linkMissionPlanItem({ missionId: mission.id, planItemSeq: 1, taskId: created.task.id, requestedBy: 'founder' }));
  const evidenceId = fx.ops.queue.evidence.list(created.task.id)[0]!.id;
  return { ...fx, missionId: mission.id, taskId: created.task.id, evidenceId, members };
}

/** Open a session on the fixture mission as the Founder (default). */
export function openSession(
  fx: CollaborationFixture,
  over: Partial<Parameters<CollaborationFixture['ops']['openCollaborationSession']>[0]> = {},
) {
  return expectOk(
    fx.ops.openCollaborationSession({
      missionId: fx.missionId,
      title: 'Speed war room',
      purpose: 'Plan and review the load-time work',
      requestedBy: 'founder',
      ...over,
    }),
  ).session;
}

/** Admit a worker under a role, as the Founder. */
export function admit(fx: CollaborationFixture, sessionId: string, workerId: string, role: CollaborationRole) {
  return expectOk(fx.ops.admitCollaborator({ sessionId, workerId, role, requestedBy: 'founder' }));
}

/** Record a contribution by `claude` (default) — the common starting point. */
export function contribute(
  fx: CollaborationFixture,
  sessionId: string,
  over: Partial<Parameters<CollaborationFixture['ops']['recordContribution']>[0]> = {},
) {
  return expectOk(
    fx.ops.recordContribution({
      sessionId,
      kind: 'finding',
      content: 'The hero image is 4 MB and blocks first paint.',
      requestedBy: 'claude',
      ...over,
    }),
  ).contribution;
}

/** A session with claude (builder), codex (reviewer) and jules (builder) admitted. */
export function roomWithThree(fx: CollaborationFixture): string {
  const session = openSession(fx);
  admit(fx, session.id, 'claude', 'builder');
  admit(fx, session.id, 'codex', 'reviewer');
  admit(fx, session.id, 'jules', 'builder');
  return session.id;
}

export function count(fx: Fixture, table: string): number {
  return (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

export function errorCode(result: { ok: boolean; error?: { code: string } }): string | null {
  return result.ok ? null : (result.error?.code ?? null);
}
