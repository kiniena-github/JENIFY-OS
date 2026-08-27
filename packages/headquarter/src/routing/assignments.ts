/**
 * ROLE → PROVIDER assignments (Founder mission Phase 6).
 *
 * The whole point of this file is that it is the ONLY place a role/provider
 * preference lives. Roles are permanent architecture; providers are current
 * staffing. Moving `REVIEWER` from Codex to Jules — or to Gemini, xAI,
 * Microsoft, a local open-source model, or a future JENIFY AI — is a data edit
 * here (or a runtime override), never a redesign of Headquarter.
 *
 * Two deliberate non-features:
 *
 *  1. `backup` is NOT an automatic fallback. If the primary provider for a role
 *     is not connected, the task FAILS CLOSED. JENIFY never silently swaps one
 *     vendor for another — that is exactly the impersonation bug this whole
 *     lane exists to prevent. A backup is a provider the Founder may explicitly
 *     dispatch to (or run as an independent second opinion), nothing more.
 *
 *  2. Nothing here grants capability. An assignment expresses preference; the
 *     provider still has to prove real connectivity in providers.ts and still
 *     has to produce real provenance in providers/codex/evidence.ts.
 */

import { ROLES, isProviderId, isRole, type ProviderId, type Role } from './providers.js';

export interface RoleAssignment {
  role: Role;
  /**
   * The provider a role-tagged task routes to when the task names a role but
   * NO explicit provider.
   */
  primary: ProviderId;
  /**
   * Additional providers that hold this role for independent/second-opinion
   * work. NEVER auto-substituted for `primary`.
   */
  backup: ProviderId[];
  /** Why this staffing choice currently stands. Shown in Headquarter. */
  rationale: string;
}

export type RoleAssignments = Record<Role, RoleAssignment>;

/**
 * Current staffing, 2026-08-27.
 *
 * REVIEWER intentionally still names JULES as primary. The Founder's target
 * structure is Codex as Primary Fast Reviewer, but the standing instruction is
 * that the default reviewer does not move until genuine Codex execution is
 * PROVEN and benchmarked. Codex is registered here as a connected backup
 * reviewer, so the switch is a one-value edit once the Founder approves it:
 *
 *     REVIEWER: { primary: 'CODEX', backup: ['JULES', 'GEMINI'], ... }
 *
 * or at runtime, with no code change at all:
 *
 *     JENIFY_ROLE_REVIEWER=CODEX
 */
export const DEFAULT_ROLE_ASSIGNMENTS: RoleAssignments = {
  MANAGER: {
    role: 'MANAGER',
    primary: 'CLAUDE',
    backup: [],
    rationale:
      'The single Team Lead / Orchestrator session is a Claude session today. Configurable: ' +
      'any provider able to hold the orchestrator contract may take this role.',
  },
  BUILDER: {
    role: 'BUILDER',
    primary: 'CLAUDE',
    backup: [],
    rationale: 'Claude is the current primary builder and the only provider with a repo-write execution lane.',
  },
  REVIEWER: {
    role: 'REVIEWER',
    primary: 'JULES',
    backup: ['CODEX', 'GEMINI'],
    rationale:
      'Jules remains the default independent reviewer of record. Codex is connected and ' +
      'benchmark-eligible as primary fast reviewer, but the default does not move until the ' +
      'Founder approves the switch on the evidence.',
  },
  RESEARCHER: {
    role: 'RESEARCHER',
    primary: 'GEMINI',
    backup: [],
    rationale: 'Gemini holds the zero-cost research/alternative-review lane.',
  },
};

/**
 * Runtime override, so the Founder can restaff a role without editing code:
 * `JENIFY_ROLE_REVIEWER=CODEX`, `JENIFY_ROLE_BUILDER=GEMINI`, and so on.
 *
 * An override naming something that is not a real provider is REJECTED rather
 * than ignored — a typo must never silently fall back to the old staffing.
 */
export interface AssignmentOverrideResult {
  assignments: RoleAssignments;
  applied: Array<{ role: Role; provider: ProviderId }>;
  rejected: Array<{ role: Role; value: string; reason: string }>;
}

export function applyAssignmentOverrides(
  base: RoleAssignments,
  env: Record<string, string | undefined>,
): AssignmentOverrideResult {
  const assignments: RoleAssignments = { ...base };
  const applied: AssignmentOverrideResult['applied'] = [];
  const rejected: AssignmentOverrideResult['rejected'] = [];

  for (const role of ROLES) {
    const raw = env[`JENIFY_ROLE_${role}`];
    if (raw == null || String(raw).trim() === '') continue;
    const value = String(raw).trim().toUpperCase();
    if (!isProviderId(value)) {
      rejected.push({
        role,
        value,
        reason: `'${value}' is not a known provider. Role staffing unchanged; refusing to guess.`,
      });
      continue;
    }
    const current = base[role];
    // The outgoing primary stays available as an explicitly dispatchable backup.
    const backup = [current.primary, ...current.backup].filter((p) => p !== value);
    assignments[role] = {
      ...current,
      primary: value,
      backup,
      rationale: `Overridden at runtime by JENIFY_ROLE_${role}. Previous primary: ${current.primary}.`,
    };
    applied.push({ role, provider: value });
  }

  return { assignments, applied, rejected };
}

/** Parse a role name defensively (used by CLI entry points). */
export function parseRole(value: string | undefined | null): Role | null {
  if (value == null) return null;
  const v = String(value).trim().toUpperCase();
  return isRole(v) ? v : null;
}

/**
 * Which provider currently holds a role. Pure lookup — it says nothing about
 * whether that provider is connected; the caller still applies the fail-closed
 * connectivity check.
 */
export function providerForRole(role: Role, assignments: RoleAssignments = DEFAULT_ROLE_ASSIGNMENTS): ProviderId {
  return assignments[role].primary;
}

/** Every provider holding a role, primary first. Order is stable. */
export function providersForRole(role: Role, assignments: RoleAssignments = DEFAULT_ROLE_ASSIGNMENTS): ProviderId[] {
  const a = assignments[role];
  return [a.primary, ...a.backup.filter((b) => b !== a.primary)];
}

/** Founder-facing staffing table, for Headquarter and for reports. */
export function renderAssignments(assignments: RoleAssignments = DEFAULT_ROLE_ASSIGNMENTS): string {
  const rows = ROLES.map((r) => {
    const a = assignments[r];
    return `| ${r} | ${a.primary} | ${a.backup.length > 0 ? a.backup.join(', ') : '_none_'} | ${a.rationale} |`;
  });
  return ['| Role | Primary provider | Backup (explicit dispatch only) | Rationale |', '|---|---|---|---|', ...rows].join('\n');
}
