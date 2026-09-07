/**
 * Shared fixture for the Phase 14 Cost + Intelligence Optimization suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up.
 *
 * Builds on the lane-F application fixture — which already carries the Founder,
 * the approval-authority-only `coo`, the grantless `analyst`, four workers and
 * the four capabilities — and adds only what an intelligence suite needs:
 *
 *  - `hq.intelligence_command` registered and granted to the Founder, so the
 *    two Founder acts of the phase (record an observation, set a budget) are
 *    reachable; both switches are available so the fail-closed halves can be
 *    proven too;
 *  - a live fenced claim on the pre-approved SIDE-EFFECT capability, because
 *    every decision/outcome/cost write is authorized by exactly that claim.
 *    `github.open_pr` is `external_side_effect`, so its work carries a
 *    required review tier — which is what the "a cheaper tier cannot bypass a
 *    reviewer tier" proofs turn on;
 *  - a live fenced claim on the READ-ONLY capability, whose work requires no
 *    review at all and can legitimately route to the free local tier;
 *  - a helper that records a deployment budget, because with NO budget the
 *    permitted tier set is the free local tier alone and almost nothing is
 *    routable — which is itself a property the suites prove.
 */

import { CAPS, expectOk, setupFixture, type Fixture } from './application.fixture.js';
import { claimReadOnlyTask, claimSideEffectTask } from './reliability.fixture.js';
import {
  INTELLIGENCE_COMMAND_CAPABILITY,
  registerIntelligenceCommandCapability,
  type BudgetScope,
  type BudgetWindow,
  type IntelligenceTier,
} from '../src/application/intelligence-command.js';

export interface IntelligenceFixture extends Fixture {
  /** A live fenced claim on `github.open_pr` — external_side_effect, idempotent. */
  claim: { taskId: string; workerId: string; fence: number };
  /** A live fenced claim on `repo.read_status` — read_only, no review required. */
  readOnlyClaim: { taskId: string; workerId: string; fence: number };
  /** Record a deployment-wide ceiling and permitted tier set. */
  budget(
    permittedTiers: readonly IntelligenceTier[],
    over?: {
      ceilingMinorUnits?: number;
      currency?: string;
      scopeKind?: BudgetScope;
      scopeId?: string;
      window?: BudgetWindow;
    },
  ): void;
}

/**
 * `registerIntelligence: false` leaves `hq.intelligence_command` unregistered
 * so a suite can prove the capability gate fails closed; `grantIntelligence:
 * false` registers it but withholds the Founder's originate grant, which is
 * the other half of the same fail-closed pair.
 */
export function intelligenceFixture(
  options: { registerIntelligence?: boolean; grantIntelligence?: boolean } = {},
): IntelligenceFixture {
  const fx = setupFixture();
  if (options.registerIntelligence !== false) registerIntelligenceCommandCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      CAPS.indexDoc,
      ...(options.grantIntelligence === false ? [] : [INTELLIGENCE_COMMAND_CAPABILITY.id]),
    ],
    approvalAuthority: true,
    active: true,
  });
  // An approval-authority principal that does NOT hold the intelligence grant,
  // so "approval authority is not intelligence authority" is provable.
  fx.principals.register({
    id: 'coo',
    displayName: 'Chief Operating Officer',
    originateCapabilities: [],
    approvalAuthority: true,
    active: true,
  });

  return {
    ...fx,
    claim: claimSideEffectTask(fx, 'intel-side-effect'),
    readOnlyClaim: claimReadOnlyTask(fx, 'intel-read-only'),
    budget(permittedTiers, over = {}) {
      expectOk(
        fx.ops.setIntelligenceBudget({
          scopeKind: over.scopeKind ?? 'deployment',
          scopeId: over.scopeId ?? 'deployment',
          window: over.window ?? 'total',
          ceilingMinorUnits: over.ceilingMinorUnits ?? 100_000,
          currency: over.currency ?? 'USD',
          permittedTiers,
          setBy: 'founder',
        }),
      );
    },
  };
}
