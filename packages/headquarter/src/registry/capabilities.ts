/**
 * AI Member capability records — the domains an AI worker can be granted
 * permission to act in (issue #119, order 1).
 *
 * Deliberately separate from `operator/capabilities.ts`: the Universal
 * Operator's capability registry governs named, typed ACTIONS a task queue
 * dispatches (`github.open_pr`, `archive.index_document`, ...). This
 * registry governs DOMAINS an AI member is trusted to work in at all
 * (`coding`, `image`, `browser_computer_use`, ...) — a coarser, upstream
 * question of "should this member ever be routed this kind of work." A
 * granted domain here does not, by itself, authorize any operator action;
 * it is one more upstream check that composes with the operator's own
 * deny-by-default rules.
 *
 * `MEMBER_RISK_CLASSES` intentionally uses the same string values as
 * `operator/RISK_CLASSES` (so risk vocabulary reads the same everywhere the
 * Founder looks) but is defined independently here rather than imported —
 * this registry must not reach into operator internals (issue #119 scope
 * rule), and the two registries are allowed to diverge later without
 * coupling.
 *
 * Core security rule (advertised vs. granted): a capability record here
 * only describes what CAN exist to be granted. Whether a given AI member
 * actually holds a capability is a separate, per-member fact tracked in
 * `registry/members.ts` as `grantedCapabilities` — never inferred from a
 * provider's own advertised claims. See that file for the enforcement.
 */

import type { HqDatabase } from '../store/db.js';
import { ensureRegistrySchema } from './db.js';

export const MEMBER_CAPABILITY_DOMAINS = [
  'coding',
  'research',
  'design',
  'browser_computer_use',
  'documents',
  'image',
  'video',
  'audio',
  'reasoning',
  'retrieval',
  'connectors',
  'local_execution',
  'translation',
  'data_analysis',
] as const;

export type MemberCapabilityDomain = (typeof MEMBER_CAPABILITY_DOMAINS)[number];

/** Same values as `operator/RISK_CLASSES` — see module doc comment for why this is a separate copy. */
export const MEMBER_RISK_CLASSES = [
  'read_only',
  'reversible',
  'external_side_effect',
  'destructive',
  'founder_gate',
] as const;

export type MemberRiskClass = (typeof MEMBER_RISK_CLASSES)[number];

export interface MemberCapability {
  /** Stable id, e.g. 'coding.general', 'image.generation'. */
  id: string;
  domain: MemberCapabilityDomain;
  description: string;
  riskClass: MemberRiskClass;
  enabled: boolean;
}

function rowToCapability(row: Record<string, unknown>): MemberCapability {
  return {
    id: row.id as string,
    domain: row.domain as MemberCapabilityDomain,
    description: row.description as string,
    riskClass: row.risk_class as MemberRiskClass,
    enabled: !!row.enabled,
  };
}

/** Standalone reader, independent of any class instance — reused by `registry/serialization.ts`. */
export function listAllCapabilities(db: HqDatabase): MemberCapability[] {
  const rows = db.prepare(`SELECT * FROM hq_member_capabilities ORDER BY id`).all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToCapability);
}

/**
 * The only source of truth for which capability domains exist and whether
 * each is currently enabled. `AiMemberRegistry` consults this — never a
 * member's own advertised claims — before honoring any grant.
 */
export class MemberCapabilityRegistry {
  constructor(private db: HqDatabase) {
    ensureRegistrySchema(db);
  }

  register(cap: Omit<MemberCapability, 'enabled'> & { enabled?: boolean }): MemberCapability {
    if (!MEMBER_CAPABILITY_DOMAINS.includes(cap.domain)) {
      throw new Error(`Unknown capability domain: ${cap.domain}`);
    }
    if (!MEMBER_RISK_CLASSES.includes(cap.riskClass)) {
      throw new Error(`Unknown risk class: ${cap.riskClass}`);
    }
    const enabled = cap.enabled ?? true;
    this.db
      .prepare(
        `INSERT INTO hq_member_capabilities (id, domain, description, risk_class, enabled)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           domain = excluded.domain,
           description = excluded.description,
           risk_class = excluded.risk_class,
           enabled = excluded.enabled`,
      )
      .run(cap.id, cap.domain, cap.description, cap.riskClass, enabled ? 1 : 0);
    return { id: cap.id, domain: cap.domain, description: cap.description, riskClass: cap.riskClass, enabled };
  }

  get(id: string): MemberCapability | null {
    const row = this.db.prepare(`SELECT * FROM hq_member_capabilities WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToCapability(row) : null;
  }

  setEnabled(id: string, enabled: boolean): void {
    const res = this.db
      .prepare(`UPDATE hq_member_capabilities SET enabled = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, id);
    if (res.changes === 0) throw new Error(`Unknown capability: ${id}`);
  }

  list(): MemberCapability[] {
    return listAllCapabilities(this.db);
  }

  /**
   * Whether `id` may currently be granted to a member: it must be
   * registered AND enabled. Disabled/unknown capabilities are never
   * grantable, regardless of what any member advertises.
   */
  isGrantable(id: string): { ok: boolean; reason?: string; capability?: MemberCapability } {
    const capability = this.get(id);
    if (!capability) return { ok: false, reason: `Unregistered capability: ${id}` };
    if (!capability.enabled) return { ok: false, reason: `Capability is disabled: ${id}`, capability };
    return { ok: true, capability };
  }
}
