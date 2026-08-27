/**
 * Human principals (HQ lane F, correction after the PR #142 review).
 *
 * The first cut of this lane authorized Founder actions by *elimination*:
 * "any actor the directory does not know as a worker is a human". That is the
 * wrong default — it denies workers but admits every unknown string, so a
 * typo'd or invented id could approve. And it left the Founder unable to
 * originate work at all without being registered as a worker, which would then
 * have barred them from approving.
 *
 * This module fixes both by making human identity its own first-class,
 * deny-by-default seam, deliberately kept SEPARATE from AI worker identity:
 *
 * - A human is authorized because they are in this registry and carry the
 *   grant, never because they failed to look like a worker.
 * - The registry starts EMPTY. No principal, no grant, and no default
 *   authority is invented here; registering one is a Founder-gated,
 *   code-reviewed action exactly like registering a capability.
 *
 * ## Two authorities, deliberately independent
 *
 * `originateCapabilities` — which capabilities this human may *open work for*.
 * `approvalAuthority`     — whether this human may decide Founder approvals
 *                           and operate the kill switch.
 *
 * A principal may hold both, and they still do not collapse into each other:
 *
 * - **Originating is never executing.** A human principal can never claim,
 *   start, or execute anything. Execution belongs to workers with a live
 *   fenced claim; there is no code path that gives a human one.
 * - **Originating is never approving your own work.** The canonical Operator
 *   rule that the requester cannot approve its own action is untouched, so a
 *   human who opens a gated task cannot then approve it — a second
 *   approval-authorized principal must, or (the ordinary Headquarter flow) a
 *   worker originates the task and the Founder approves it. That consequence
 *   is real and is documented rather than papered over with a Founder
 *   exception, which would weaken a canonical guarantee.
 */

import type { HqDatabase } from '../store/db.js';

export interface HumanPrincipal {
  /** Stable id used as the actor in events, evidence and approvals. */
  id: string;
  displayName: string;
  /**
   * Capability ids this human may ORIGINATE work for. Deny by default; an
   * empty list means they can open nothing. Never an execution right.
   */
  originateCapabilities: string[];
  /** May decide Founder approvals and operate the kill switch. */
  approvalAuthority: boolean;
  active: boolean;
}

/** Why a human principal was refused. Deny by default. */
export type PrincipalRejection =
  | 'principal_unknown'
  | 'principal_inactive'
  | 'principal_no_approval_authority';

export interface HumanPrincipalPort {
  get(id: string): HumanPrincipal | null;
}

const PRINCIPAL_DDL = `
CREATE TABLE IF NOT EXISTS hq_human_principals (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  originate_capabilities TEXT NOT NULL,
  approval_authority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
`;

export function ensurePrincipalSchema(db: HqDatabase): void {
  db.exec(PRINCIPAL_DDL);
}

/**
 * Default `HumanPrincipalPort`, backed by its own table. Empty until a Founder
 * explicitly registers someone.
 */
export class HumanPrincipalRegistry implements HumanPrincipalPort {
  constructor(private db: HqDatabase) {
    ensurePrincipalSchema(db);
  }

  register(principal: HumanPrincipal): void {
    this.db
      .prepare(
        `INSERT INTO hq_human_principals (id, display_name, originate_capabilities, approval_authority, active)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           originate_capabilities = excluded.originate_capabilities,
           approval_authority = excluded.approval_authority,
           active = excluded.active`,
      )
      .run(
        principal.id,
        principal.displayName,
        JSON.stringify(principal.originateCapabilities),
        principal.approvalAuthority ? 1 : 0,
        principal.active ? 1 : 0,
      );
  }

  get(id: string): HumanPrincipal | null {
    const row = this.db.prepare(`SELECT * FROM hq_human_principals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      displayName: row.display_name as string,
      originateCapabilities: JSON.parse(row.originate_capabilities as string),
      approvalAuthority: !!row.approval_authority,
      active: !!row.active,
    };
  }

  setActive(id: string, active: boolean): void {
    const res = this.db
      .prepare(`UPDATE hq_human_principals SET active = ? WHERE id = ?`)
      .run(active ? 1 : 0, id);
    if (res.changes === 0) throw new Error(`Unknown human principal: ${id}`);
  }

  list(): HumanPrincipal[] {
    const rows = this.db.prepare(`SELECT id FROM hq_human_principals ORDER BY id`).all() as {
      id: string;
    }[];
    return rows.map((r) => this.get(r.id)!);
  }
}

/** Resolve a human principal for any use. Deny by default. */
export function resolvePrincipal(
  port: HumanPrincipalPort,
  id: string,
): { ok: true; principal: HumanPrincipal } | { ok: false; reason: PrincipalRejection } {
  const principal = port.get(id);
  if (!principal) return { ok: false, reason: 'principal_unknown' };
  if (!principal.active) return { ok: false, reason: 'principal_inactive' };
  return { ok: true, principal };
}

/** Resolve a human principal that must additionally hold approval authority. */
export function resolveApprover(
  port: HumanPrincipalPort,
  id: string,
): { ok: true; principal: HumanPrincipal } | { ok: false; reason: PrincipalRejection } {
  const resolved = resolvePrincipal(port, id);
  if (!resolved.ok) return resolved;
  if (!resolved.principal.approvalAuthority) {
    return { ok: false, reason: 'principal_no_approval_authority' };
  }
  return resolved;
}
