/**
 * Shared fixture for the Phase 10 Chief of Staff / Command Center suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up. Builds on the Phase 9 collaboration fixture — which already
 * carries the mission/memory/workforce/truth/collaboration trios, a Founder,
 * a grantless `analyst` human, four workers of different shapes and one
 * commanded mission with a real linked task — and adds the ONE capability
 * Phase 10 introduces (`hq.founder_brief`) plus the Founder grant for it.
 */

import { collaborationFixture, type CollaborationFixture } from './collaboration.fixture.js';
import { CAPS, expectOk } from './application.fixture.js';
import { MISSION_COMMAND_CAPABILITY } from '../src/application/mission-command.js';
import { MEMORY_COMMAND_CAPABILITY } from '../src/application/memory-command.js';
import { WORKFORCE_ASSIGN_CAPABILITY } from '../src/application/workforce-command.js';
import { TRUTH_RECORD_CAPABILITY, TRUTH_VERIFY_CAPABILITY } from '../src/application/truth-command.js';
import { COLLABORATION_COMMAND_CAPABILITY } from '../src/application/collaboration-command.js';
import { FOUNDER_BRIEF_CAPABILITY, registerFounderBriefCapability } from '../src/application/chief-of-staff.js';

export type CommandCenterFixture = CollaborationFixture;

/**
 * `registerBrief: false` leaves `hq.founder_brief` unregistered so a suite can
 * prove the gate fails closed; `grantBrief: false` registers the capability
 * but withholds the Founder's originate grant, which is the other half of the
 * same fail-closed pair.
 */
export function commandCenterFixture(
  options: { registerBrief?: boolean; grantBrief?: boolean } = {},
): CommandCenterFixture {
  const fx = collaborationFixture();
  if (options.registerBrief !== false) registerFounderBriefCapability(fx.db);
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
      ...(options.grantBrief === false ? [] : [FOUNDER_BRIEF_CAPABILITY.id]),
    ],
    approvalAuthority: true,
    active: true,
  });
  return fx;
}

/** Every inbox item id the fixture's ops derive right now, past the Founder gate. */
export function inboxIds(fx: CommandCenterFixture): string[] {
  return fx.ops.founderInbox({ includeFounderOnly: true }).items.map((item) => item.id);
}

/** The one item of a given reason, or null — the shape most assertions want. */
export function itemFor(fx: CommandCenterFixture, reason: string) {
  return fx.ops.founderInbox({ includeFounderOnly: true }).items.find((item) => item.reason === reason) ?? null;
}

/**
 * A canonical task held at the Founder gate (`op_tasks.status =
 * needs_approval`).
 *
 * Note what is deliberately NOT returned: an approval id. HQ writes the
 * `hq_approvals` row when the decision is MADE — `approveTask` and `denyTask`
 * each insert one — so a task that is still waiting has no approval row at
 * all, and the canonical "this needs the Founder" fact is the task status.
 */
export function taskAwaitingApproval(fx: CommandCenterFixture, idempotencyKey: string): { taskId: string } {
  const created = expectOk(
    fx.ops.createTask({
      capabilityId: CAPS.indexDoc,
      payload: { doc: idempotencyKey },
      idempotencyKey,
      requestedBy: 'claude',
      title: 'Index a document',
    }),
  );
  if (created.task.status !== 'needs_approval') {
    throw new Error(`fixture: expected a task held at the Founder gate, got ${created.task.status}`);
  }
  return { taskId: created.task.id };
}
