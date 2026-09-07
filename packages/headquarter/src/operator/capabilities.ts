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
import { deepFreeze } from '../contracts/freeze.js';

export const RISK_CLASSES = deepFreeze([
  'read_only',
  'reversible',
  'external_side_effect',
  'destructive',
  'founder_gate',
] as const);

export type RiskClass = (typeof RISK_CLASSES)[number];

export function isRiskClass(value: unknown): value is RiskClass {
  return typeof value === 'string' && (RISK_CLASSES as readonly string[]).includes(value);
}

/**
 * Read a STORED `op_capabilities.risk_class` back through the vocabulary,
 * never by assertion (Wave 5 Medium 5).
 *
 * `op_capabilities` carries no immutability triggers — enabling and disabling
 * a capability is a legitimate UPDATE — so the column is writable by anything
 * holding the file. Every read of it used to be a bare
 * `row.risk_class as RiskClass`, which turned one raw
 * `UPDATE op_capabilities SET risk_class = 'totally_harmless'` into a typed
 * member: the Phase 14 routing floor fell from `high` to `deterministic_local`
 * and the review requirement became `undefined`, which reads as "no reviewer
 * required". An unreadable risk class is the STRICTEST one — the same
 * fail-closed rule already applied to a capability row that is missing
 * entirely.
 */
export function readStoredRiskClass(value: unknown): RiskClass {
  return isRiskClass(value) ? value : 'founder_gate';
}

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
  /**
   * ECMAScript `#private`. TypeScript `private` erases to a public property, so
   * this database was reachable from the exported operations object and could
   * be written directly — bypassing every authority gate above it (issue #200,
   * Codex exact-head finding on `135ae58`, plus three further routes the
   * object-graph test found that the review did not name).
   */
  readonly #db: HqDatabase;

  constructor(db: HqDatabase) {
    this.#db = db;
  }

  /**
   * Register a capability, or update the definition of one that already exists.
   *
   * `enabled` is deliberately NOT part of that update unless the caller says so
   * explicitly (issue #200, Codex P1 #2). An earlier version wrote
   * `enabled = excluded.enabled`, which defaults to 1 — so any code path that
   * re-registered a capability on its way to using it silently turned a
   * DISABLED capability back on. Disabling a capability is a deliberate
   * containment action; re-registration is a routine one, and a routine action
   * must never undo a containment action.
   *
   * The split this enforces: registration/definition is one thing, and
   * enabled/disabled state is a separate, explicit configuration decision
   * (`setEnabled`, or passing `enabled` here on purpose). Invocation paths must
   * do neither — see `live/orders.ts`.
   */
  register(cap: Omit<Capability, 'enabled'> & { enabled?: boolean }): void {
    if (!RISK_CLASSES.includes(cap.riskClass)) {
      throw new Error(`Unknown risk class: ${cap.riskClass}`);
    }
    if (cap.sideEffect && cap.riskClass === 'read_only') {
      throw new Error(`Capability ${cap.id}: side-effect capability cannot be read_only`);
    }
    // null => "do not state an opinion": a new row defaults to enabled, and an
    // existing row keeps whatever state it already had.
    const enabled = cap.enabled == null ? null : cap.enabled ? 1 : 0;
    this.#db
      .prepare(
        `INSERT INTO op_capabilities (id, description, risk_class, side_effect, idempotent, enabled)
         VALUES (?, ?, ?, ?, ?, COALESCE(?, 1))
         ON CONFLICT(id) DO UPDATE SET
           description = excluded.description,
           risk_class = excluded.risk_class,
           side_effect = excluded.side_effect,
           idempotent = excluded.idempotent,
           enabled = COALESCE(?, op_capabilities.enabled)`,
      )
      .run(
        cap.id,
        cap.description,
        cap.riskClass,
        cap.sideEffect ? 1 : 0,
        cap.idempotent ? 1 : 0,
        enabled,
        enabled,
      );
  }

  get(id: string): Capability | null {
    const row = this.#db.prepare(`SELECT * FROM op_capabilities WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      description: row.description as string,
      riskClass: readStoredRiskClass(row.risk_class),
      sideEffect: !!row.side_effect,
      idempotent: !!row.idempotent,
      enabled: !!row.enabled,
    };
  }

  setEnabled(id: string, enabled: boolean): void {
    const res = this.#db
      .prepare(`UPDATE op_capabilities SET enabled = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, id);
    if (res.changes === 0) throw new Error(`Unknown capability: ${id}`);
  }

  list(): Capability[] {
    const rows = this.#db.prepare(`SELECT id FROM op_capabilities ORDER BY id`).all() as {
      id: string;
    }[];
    return rows.map((r) => this.get(r.id)!) ;
  }
}
