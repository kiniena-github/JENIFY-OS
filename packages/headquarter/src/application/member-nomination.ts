/**
 * The AI Member Registry as an ADVISORY nomination source (Phase 4, #262).
 *
 * This is the one production bridge between lane C's rich member model
 * (`registry/members.ts`, `registry/routing.ts`) and the Operator's routing
 * evaluation — and it is advisory BY CONTRACT: `NominationSourcePort` can
 * only suggest. `routeTask` recomputes `eligible` from the worker directory
 * and the policy engine alone, a throwing source is recorded and ignored,
 * and nothing a nomination says can grant a capability, mark a worker
 * assignable, or reorder the strictly-FIFO claim path.
 *
 * NO VOCABULARY MAPPING, EVER. The Operator's capability ids
 * (`github.open_pr`) and the member registry's capability domains
 * (`coding`) are deliberately disjoint vocabularies, and guessing a bridge
 * ("a member granted 'coding' can surely open PRs") would be an invented
 * business rule. This source asks the member registry for the EXACT
 * Operator capability id of the task: a member is nominated only if a
 * registrar explicitly registered that id as a member capability AND
 * granted it to the member (effective, not advertised). Until that
 * configuration act happens, this source truthfully nominates nobody.
 */

import type { AiMemberRegistry } from '../registry/members.js';
import { rankMembers } from '../registry/routing.js';
import type { NominationContext, NominationSourcePort, WorkerNomination } from './ports.js';

/** Nominations are suggestions; a shortlist is enough. */
const DEFAULT_TOP_N = 5;

const MAX_RATIONALE_LENGTH = 300;

export class MemberRegistryNominationSource implements NominationSourcePort {
  readonly id = 'ai-member-registry';

  constructor(
    private readonly registry: AiMemberRegistry,
    /** Injectable for deterministic tests; production uses the wall clock. */
    private readonly clock: () => Date = () => new Date(),
    private readonly topN: number = DEFAULT_TOP_N,
  ) {}

  nominate(ctx: NominationContext): readonly WorkerNomination[] {
    const candidates = this.registry.list({ status: 'active' });
    if (candidates.length === 0) return [];
    const ranked = rankMembers(
      candidates,
      { requiredCapability: ctx.capabilityId, now: this.clock() },
      (memberId) => this.registry.workloadOf(memberId),
    );
    return ranked
      .filter((r) => !r.excluded)
      .slice(0, this.topN)
      .map((r) => {
        const rationale = `score ${r.score.toFixed(1)}: ${r.reasons.join('; ')}`;
        return {
          workerId: r.member.id,
          rationale:
            rationale.length > MAX_RATIONALE_LENGTH
              ? `${rationale.slice(0, MAX_RATIONALE_LENGTH - 1)}…`
              : rationale,
        };
      });
  }
}
