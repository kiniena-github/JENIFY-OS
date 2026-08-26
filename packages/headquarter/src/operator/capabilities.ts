/**
 * Capability registry — the ONLY source of truth for what the Universal
 * Operator can do and how risky each action is.
 *
 * Security properties (war room #41, order E; issue #42, orders 4–5):
 * - Deny by default: a task can only be enqueued for a registered, enabled
 *   capability.
 * - No arbitrary command execution: there is deliberately no capability
 *   whose payload is a shell command; every capability is a named, typed
 *   action implemented by an execution worker behind the control plane.
 * - Workers may not self-declare risk: risk class and side-effect flags are
 *   fixed at registration time (a Founder-gated, code-reviewed change), and
 *   the policy engine reads them from here — never from the task payload.
 */

import type { HqDatabase } from '../store/db.js';

export const RISK_CLASSES = [
  'read_only',
  'reversible',
  'external_side_effect',
  'destructive',
  'founder_gate',
] as const;

export type RiskClass = (typeof RISK_CLASSES)[number];

export interface Capability {
  /** Stable id, e.g. 'github.open_pr', 'archive.index_document'. */
  id: string;
  description: string;
  riskClass: RiskClass;
  /** True when executing it changes anything outside the control plane. */
  sideEffect: boolean;
  /** True when executing twice with the same idempotency key is safe. */
  idempotent: boolean;
  enabled: boolean;
}

export class CapabilityRegistry {
  constructor(private db: HqDatabase) {}

  register(cap: Omit<Capability, 'enabled'> & { enabled?: boolean }): void {
    if (!RISK_CLASSES.includes(cap.riskClass)) {
      throw new Error(`Unknown risk class: ${cap.riskClass}`);
    }
    if (cap.sideEffect && cap.riskClass === 'read_only') {
      throw new Error(`Capability ${cap.id}: side-effect capability cannot be read_only`);
    }
    this.db
      .prepare(
        `INSERT INTO op_capabilities (id, description, risk_class, side_effect, idempotent, enabled)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description,
           risk_class = excluded.risk_class,
           side_effect = excluded.side_effect,
           idempotent = excluded.idempotent,
           enabled = excluded.enabled`,
      )
      .run(
        cap.id,
        cap.description,
        cap.riskClass,
        cap.sideEffect ? 1 : 0,
        cap.idempotent ? 1 : 0,
        (cap.enabled ?? true) ? 1 : 0,
      );
  }

  get(id: string): Capability | null {
    const row = this.db.prepare(`SELECT * FROM op_capabilities WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      description: row.description as string,
      riskClass: row.risk_class as RiskClass,
      sideEffect: !!row.side_effect,
      idempotent: !!row.idempotent,
      enabled: !!row.enabled,
    };
  }

  setEnabled(id: string, enabled: boolean): void {
    const res = this.db
      .prepare(`UPDATE op_capabilities SET enabled = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, id);
    if (res.changes === 0) throw new Error(`Unknown capability: ${id}`);
  }

  list(): Capability[] {
    const rows = this.db.prepare(`SELECT id FROM op_capabilities ORDER BY id`).all() as {
      id: string;
    }[];
    return rows.map((r) => this.get(r.id)!) ;
  }
}
