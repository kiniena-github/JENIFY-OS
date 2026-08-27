/**
 * Routing scoring for AI members (issue #119, order 3).
 *
 * `rankMembers` is a PURE function: no database access, no side effects,
 * and `now` is passed in explicitly so results are fully deterministic and
 * testable without wall-clock flakiness.
 *
 * CRITICAL SECURITY BOUNDARY: routing only SELECTS among members that
 * already hold a granted capability — it can never grant, escalate, or
 * widen any member's permissions. A member missing the required capability
 * is excluded outright (capability-mismatch), even if it advertises that
 * capability; advertised claims are never trusted here (see
 * `registry/members.ts`). There is no code path in this file that writes
 * to `grantedCapabilities` or any other permission state.
 */

import type { AiMember, CostClass, PrivacyClass, WorkerType } from './members.js';

const PRIVACY_ORDER: readonly PrivacyClass[] = ['open', 'internal', 'confidential', 'restricted'];
const COST_ORDER: readonly CostClass[] = ['free', 'low', 'medium', 'high', 'premium'];

const DEFAULT_BENCHMARK_MAX_AGE_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type LocalityPolicy = 'local_only' | 'prefer_local' | 'any';

export interface RoutingRequest {
  requiredCapability: string;
  privacyFloor?: PrivacyClass;
  localityPolicy?: LocalityPolicy;
  maxCostClass?: CostClass;
  roleId?: string;
  /** Also usable to filter by worker type, kept optional/unused by scoring itself. */
  workerType?: WorkerType;
  /** Benchmark evidence older than this is stale and contributes zero score. Default 90. */
  benchmarkMaxAgeDays?: number;
  /** Passed in explicitly so the function stays deterministic. */
  now: Date;
}

export interface RankedMember {
  member: AiMember;
  score: number;
  reasons: string[];
  /** Present, and score/reasons meaningless, when a hard filter excluded this member. */
  excluded?: string;
}

function privacyRank(p: PrivacyClass): number {
  return PRIVACY_ORDER.indexOf(p);
}

function costRank(c: CostClass): number {
  return COST_ORDER.indexOf(c);
}

/** Returns the exclusion reason, or null if the member passes all hard filters. */
function hardFilterReason(member: AiMember, request: RoutingRequest): string | null {
  if (!member.enabled || member.status !== 'active') {
    return `member is not active (status: '${member.status}', enabled: ${member.enabled})`;
  }
  if (member.health === 'unavailable') {
    return `member health is 'unavailable'`;
  }
  if (!member.grantedCapabilities.includes(request.requiredCapability)) {
    return `capability-mismatch: '${request.requiredCapability}' is not in grantedCapabilities (advertised alone is not enough)`;
  }
  if (request.privacyFloor && privacyRank(member.privacyClass) < privacyRank(request.privacyFloor)) {
    return `privacy class '${member.privacyClass}' is below the required floor '${request.privacyFloor}'`;
  }
  if (request.localityPolicy === 'local_only' && member.locality !== 'local') {
    return `locality policy 'local_only' excludes a '${member.locality}' member`;
  }
  if (request.maxCostClass && costRank(member.costClass) > costRank(request.maxCostClass)) {
    return `cost class '${member.costClass}' exceeds the maximum '${request.maxCostClass}'`;
  }
  if (request.roleId && !member.roleEligibility.includes(request.roleId)) {
    return `member is not eligible for role '${request.roleId}'`;
  }
  return null;
}

function scoreMember(member: AiMember, workload: number, request: RoutingRequest): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // Benchmark evidence: best score whose ref matches the required capability.
  const maxAgeDays = request.benchmarkMaxAgeDays ?? DEFAULT_BENCHMARK_MAX_AGE_DAYS;
  const matching = member.benchmarks.filter((b) => b.ref === request.requiredCapability);
  if (matching.length > 0) {
    const best = matching.reduce((a, b) => (b.score > a.score ? b : a));
    const ageDays = (request.now.getTime() - new Date(best.recordedAt).getTime()) / MS_PER_DAY;
    if (ageDays > maxAgeDays) {
      reasons.push(
        `benchmark '${best.ref}' score ${best.score} is stale (${ageDays.toFixed(1)}d > ${maxAgeDays}d) — contributes 0`,
      );
    } else {
      const contribution = best.score / 10; // 0-100 -> 0-10
      score += contribution;
      reasons.push(`benchmark '${best.ref}' score ${best.score} (${ageDays.toFixed(1)}d old) contributes +${contribution.toFixed(1)}`);
    }
  } else {
    reasons.push(`no benchmark evidence for '${request.requiredCapability}'`);
  }

  // Lower workload preferred.
  score -= workload;
  reasons.push(`workload ${workload} contributes -${workload}`);

  // Lower cost class preferred.
  const costBoost = COST_ORDER.length - 1 - costRank(member.costClass);
  score += costBoost;
  reasons.push(`cost class '${member.costClass}' contributes +${costBoost}`);

  // prefer_local boosts local members over otherwise-equal cloud ones.
  if (request.localityPolicy === 'prefer_local' && member.locality === 'local') {
    score += 2;
    reasons.push(`'prefer_local' boosts local member +2`);
  }

  return { score, reasons };
}

/**
 * Ranks candidates for a routing request. Excluded members are returned
 * (with `excluded` set to the reason) but sorted after every ranked member,
 * in their original candidate order, so callers can still see and log why.
 *
 * `workloadOf` supplies each candidate's current active-assignment count —
 * kept out of this pure function's own responsibility (workload is derived
 * state that lives in `registry/members.ts`, not something this function
 * should compute from a database).
 */
export function rankMembers(
  candidates: readonly AiMember[],
  request: RoutingRequest,
  workloadOf: (memberId: string) => number = () => 0,
): RankedMember[] {
  const ranked: RankedMember[] = [];
  const excluded: RankedMember[] = [];

  for (const member of candidates) {
    const reason = hardFilterReason(member, request);
    if (reason) {
      excluded.push({ member, score: 0, reasons: [], excluded: reason });
      continue;
    }
    const { score, reasons } = scoreMember(member, workloadOf(member.id), request);
    ranked.push({ member, score, reasons });
  }

  ranked.sort((a, b) => b.score - a.score);
  return [...ranked, ...excluded];
}
