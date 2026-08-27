/**
 * Worker replacement / handover lifecycle (issue #120, HQ special lane D).
 *
 * Lifecycle: frozen -> inventoried -> package_ready -> acknowledged ->
 * verified -> completed, with 'aborted' reachable from any pre-completed
 * state. HANDOVER_TRANSITIONS + assertHandoverTransition mirror the style
 * of contracts/events.ts's ALLOWED_TRANSITIONS/assertTransition — a table
 * checked on every state change, not ad-hoc if/else.
 *
 * Owns its own DDL (hq_handovers), applied idempotently via
 * ensureHandoverTables() — this module does NOT touch store/db.ts's DDL.
 *
 * History preservation: rows are only ever INSERTed once then UPDATEd in
 * place for their own lifecycle columns — never deleted — mirroring the
 * immutability rule for posted transactions (JENIFY-OS CLAUDE.md rule 5)
 * and for hq_events. A completed or aborted handover's row, and every
 * hq_events entry it produced, stay readable forever.
 *
 * op_tasks/op_capabilities are READ-ONLY from this module (per the issue's
 * ownership boundary): verify() re-checks task state but never writes to
 * op_tasks. Reconciling an outcome_unknown or stuck side-effect task happens
 * only through the existing operator queue (operator/queue.ts:reconcile()/
 * reviewPass()/reviewFail()) — issue #120's rule that a worker cannot be
 * removed/replaced mid-side-effect without reconciliation, and that an
 * uncertain external result remains outcome_unknown rather than being
 * silently resolved by the handover flow.
 *
 * hq_specialists writes (deactivating a predecessor on complete(), reading
 * a successor's active flag on acknowledge()) go through the EXISTING
 * HeadquarterStore (store/headquarter.ts) rather than duplicate raw SQL
 * against that table — this module still never edits store/headquarter.ts
 * itself, only imports and uses it, per the ownership constraint.
 *
 * Every worker-lifecycle transition here writes an hq_events entry
 * (subjectKind 'worker') via HeadquarterStore.appendEvent — this is done
 * unconditionally rather than through an optional callback, because
 * JENIFY-OS CLAUDE.md rule 4 requires an audit event for every important
 * action, and worker freeze/replacement is exactly that kind of action.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { HeadquarterStore } from '../store/headquarter.js';
import type { MemoryStore } from '../memory/store.js';
import { generateHandoverPackage, type HandoverPackage } from './package.js';

export const HANDOVER_STATES = [
  'frozen',
  'inventoried',
  'package_ready',
  'acknowledged',
  'verified',
  'completed',
  'aborted',
] as const;

export type HandoverState = (typeof HANDOVER_STATES)[number];

/**
 * Allowed handover state transitions. 'completed' and 'aborted' are
 * terminal. Verification/completion without a prior acknowledgement is
 * structurally impossible: 'verified' is reachable only from 'acknowledged',
 * and 'completed' only from 'verified'.
 */
export const HANDOVER_TRANSITIONS: Record<HandoverState, readonly HandoverState[]> = {
  frozen: ['inventoried', 'aborted'],
  inventoried: ['package_ready', 'aborted'],
  package_ready: ['acknowledged', 'aborted'],
  acknowledged: ['verified', 'aborted'],
  verified: ['completed', 'aborted'],
  completed: [],
  aborted: [],
};

export function isHandoverState(value: unknown): value is HandoverState {
  return typeof value === 'string' && (HANDOVER_STATES as readonly string[]).includes(value);
}

export function canTransitionHandover(from: HandoverState, to: HandoverState): boolean {
  return HANDOVER_TRANSITIONS[from].includes(to);
}

export function assertHandoverTransition(from: HandoverState, to: HandoverState): void {
  if (!canTransitionHandover(from, to)) {
    throw new Error(`Illegal handover transition: ${from} -> ${to}`);
  }
}

export interface HandoverRecord {
  id: string;
  predecessorId: string;
  successorId: string | null;
  state: HandoverState;
  package: HandoverPackage | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  verifiedAt: string | null;
  verifiedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
}

const DDL = `
CREATE TABLE IF NOT EXISTS hq_handovers (
  id TEXT PRIMARY KEY,
  predecessor_id TEXT NOT NULL,
  successor_id TEXT,
  state TEXT NOT NULL,
  package TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  verified_at TEXT,
  verified_by TEXT,
  revoked_at TEXT,
  revoked_by TEXT,
  revoked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_handovers_predecessor ON hq_handovers(predecessor_id, state);
`;

/** Idempotent — safe to call on every HandoverStore construction. */
export function ensureHandoverTables(db: HqDatabase): void {
  db.exec(DDL);
}

function rowToHandover(r: Record<string, unknown>): HandoverRecord {
  return {
    id: r.id as string,
    predecessorId: r.predecessor_id as string,
    successorId: (r.successor_id as string | null) ?? null,
    state: r.state as HandoverState,
    package: r.package ? (JSON.parse(r.package as string) as HandoverPackage) : null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    acknowledgedAt: (r.acknowledged_at as string | null) ?? null,
    acknowledgedBy: (r.acknowledged_by as string | null) ?? null,
    verifiedAt: (r.verified_at as string | null) ?? null,
    verifiedBy: (r.verified_by as string | null) ?? null,
    revokedAt: (r.revoked_at as string | null) ?? null,
    revokedBy: (r.revoked_by as string | null) ?? null,
    revokedReason: (r.revoked_reason as string | null) ?? null,
  };
}

interface OpenTaskRow {
  id: string;
  status: string;
  review_state: string;
  side_effect: number;
}

export class HandoverStore {
  private hq: HeadquarterStore;

  constructor(private db: HqDatabase) {
    ensureHandoverTables(db);
    this.hq = new HeadquarterStore(db);
  }

  /** Freezes the predecessor (via state 'frozen') and opens a new handover. Only one active handover per predecessor at a time. */
  initiate(predecessorId: string, initiatedBy: string): HandoverRecord {
    const active = this.activeFor(predecessorId);
    if (active) {
      throw new Error(
        `Worker ${predecessorId} already has an active handover (${active.id}, state: ${active.state})`,
      );
    }
    const id = uuid();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO hq_handovers (id, predecessor_id, successor_id, state, package, created_at, updated_at)
         VALUES (?, ?, NULL, 'frozen', NULL, ?, ?)`,
      )
      .run(id, predecessorId, at, at);
    this.hq.appendEvent({
      subjectKind: 'worker',
      subjectId: predecessorId,
      status: null,
      actor: initiatedBy,
      summary: `Handover initiated; worker ${predecessorId} frozen`,
      detail: { handoverId: id, toState: 'frozen' },
    });
    return this.get(id)!;
  }

  /** Snapshots (read-only) how many tasks are currently active under the predecessor, then moves to 'inventoried'. */
  inventory(handoverId: string): HandoverRecord {
    const h = this.requireState(handoverId, 'frozen');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM op_tasks WHERE claimed_by = ? AND status IN ('assigned','running','outcome_unknown')`,
      )
      .get(h.predecessorId) as { n: number };
    return this.transition(handoverId, 'inventoried', h.predecessorId, `Active ownership inventoried (${row.n} task(s))`, {
      activeTaskCount: row.n,
    });
  }

  /** Builds and stores the HandoverPackage (see package.ts), then moves to 'package_ready'. */
  generatePackage(handoverId: string, memoryStore: MemoryStore): HandoverRecord {
    const h = this.requireState(handoverId, 'inventoried');
    const pkg = generateHandoverPackage(this.db, memoryStore, h.predecessorId);
    const at = nowIso();
    this.db.transaction(() => {
      this.db.prepare(`UPDATE hq_handovers SET package = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(pkg), at, handoverId);
    })();
    return this.transition(handoverId, 'package_ready', h.predecessorId, 'Handover package generated', {
      activeAssignments: pkg.activeAssignments.length,
      unresolvedSideEffects: pkg.unresolvedSideEffects.length,
    });
  }

  /**
   * Successor acknowledges the handover. The successor must be a KNOWN,
   * ACTIVE entry in hq_specialists (read via the existing HeadquarterStore),
   * must differ from the predecessor, and must be ASSIGNABLE.
   *
   * Accepting the handover transfers the predecessor's entire workload, so it
   * is an assignment of new work and is bound by the same canonical invariant
   * as OperatorQueue.claim(): a worker that is itself frozen (being replaced)
   * or deactivated must not be handed a workload. Without the
   * assertAssignable() check below, Headquarter would happily replace Claude
   * with a Gemini that was itself mid-replacement.
   */
  acknowledge(handoverId: string, successorId: string, acknowledgedBy: string = successorId): HandoverRecord {
    const h = this.requireState(handoverId, 'package_ready');
    if (successorId === h.predecessorId) {
      throw new Error(`Handover ${handoverId}: successor ${successorId} must differ from predecessor`);
    }
    const specialist = this.hq.getSpecialist(successorId);
    if (!specialist || !specialist.active) {
      throw new Error(`Handover ${handoverId}: successor ${successorId} is not an active specialist`);
    }
    // Same guard as the assignment boundary — one source of truth, so a
    // successor cannot be frozen/deactivated by any route the queue honours.
    assertAssignable(this.db, successorId);
    const at = nowIso();
    this.db
      .prepare(
        `UPDATE hq_handovers SET successor_id = ?, acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?`,
      )
      .run(successorId, at, acknowledgedBy, at, handoverId);
    return this.transition(handoverId, 'acknowledged', acknowledgedBy, `Handover acknowledged by successor ${successorId}`, {
      successorId,
    });
  }

  /**
   * Re-checks (never mutates) op_tasks: every formerly-active assignment
   * must by now be either completed, reassigned (claimed_by no longer the
   * predecessor), or — for outcome_unknown / a side-effect task still
   * running or with a review pending — explicitly reconciled. Any task
   * still claimed by the predecessor in 'assigned', 'running', or
   * 'outcome_unknown' therefore blocks verification, naming the offending
   * task ids. Reconciliation happens through the existing operator queue
   * (reconcile()/reviewPass()/reviewFail()), never here — this is a
   * read-only re-check.
   */
  verify(handoverId: string, verifiedBy: string): HandoverRecord {
    const h = this.requireState(handoverId, 'acknowledged');
    const rows = this.db
      .prepare(
        `SELECT t.id, t.status, t.review_state, c.side_effect AS side_effect
         FROM op_tasks t JOIN op_capabilities c ON c.id = t.capability_id
         WHERE t.claimed_by = ?`,
      )
      .all(h.predecessorId) as OpenTaskRow[];

    const blocking = rows.filter((r) => r.status === 'assigned' || r.status === 'running' || r.status === 'outcome_unknown');
    if (blocking.length > 0) {
      throw new Error(
        `Handover ${handoverId}: reconciliation required before verification — task(s) still claimed by ` +
          `${h.predecessorId} in an unresolved state: ${blocking.map((r) => r.id).join(', ')}. Resolve by ` +
          `reassignment/completion, or via the operator queue's reconcile()/reviewPass()/reviewFail() for ` +
          `outcome_unknown or side-effect-under-review tasks, before verifying (issue #120).`,
      );
    }

    const at = nowIso();
    this.db.prepare(`UPDATE hq_handovers SET verified_at = ?, verified_by = ?, updated_at = ? WHERE id = ?`).run(at, verifiedBy, at, handoverId);
    return this.transition(handoverId, 'verified', verifiedBy, 'Handover verified: no unresolved assignments remain');
  }

  /**
   * Deactivates the predecessor in hq_specialists via the existing
   * HeadquarterStore.upsertSpecialist (active flag only — the row and its
   * full history are preserved, never deleted).
   */
  complete(handoverId: string): HandoverRecord {
    const h = this.requireState(handoverId, 'verified');
    const specialist = this.hq.getSpecialist(h.predecessorId);
    if (specialist) {
      this.hq.upsertSpecialist({ ...specialist, active: false });
    }
    const result = this.transition(
      handoverId,
      'completed',
      h.successorId ?? h.predecessorId,
      `Handover completed; predecessor ${h.predecessorId} deactivated (specialist row and history preserved)`,
    );
    this.hq.appendEvent({
      subjectKind: 'worker',
      subjectId: h.predecessorId,
      status: null,
      actor: h.successorId ?? 'system',
      summary: `Worker ${h.predecessorId} deactivated after completed handover to ${h.successorId ?? 'unknown'}`,
      detail: { handoverId },
    });
    return result;
  }

  /** Any pre-completed state -> 'aborted'. Unfreezes the worker (assertAssignable stops blocking once state is terminal). */
  abort(handoverId: string, reason: string, by: string): HandoverRecord {
    const h = this.get(handoverId);
    if (!h) throw new Error(`Unknown handover: ${handoverId}`);
    if (h.state === 'completed' || h.state === 'aborted') {
      throw new Error(`Handover ${handoverId} is already terminal (${h.state}); cannot abort`);
    }
    const at = nowIso();
    this.db
      .prepare(`UPDATE hq_handovers SET revoked_at = ?, revoked_by = ?, revoked_reason = ?, updated_at = ? WHERE id = ?`)
      .run(at, by, reason, at, handoverId);
    return this.transition(handoverId, 'aborted', by, `Handover aborted: ${reason}`, { reason });
  }

  get(id: string): HandoverRecord | null {
    const row = this.db.prepare(`SELECT * FROM hq_handovers WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? rowToHandover(row) : null;
  }

  listByPredecessor(predecessorId: string): HandoverRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM hq_handovers WHERE predecessor_id = ? ORDER BY created_at`)
      .all(predecessorId) as Record<string, unknown>[];
    return rows.map(rowToHandover);
  }

  private activeFor(predecessorId: string): HandoverRecord | null {
    const row = this.db
      .prepare(
        `SELECT id FROM hq_handovers WHERE predecessor_id = ? AND state NOT IN ('completed','aborted') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(predecessorId) as { id: string } | undefined;
    return row ? this.get(row.id) : null;
  }

  private requireState(handoverId: string, expected: HandoverState): HandoverRecord {
    const h = this.get(handoverId);
    if (!h) throw new Error(`Unknown handover: ${handoverId}`);
    if (h.state !== expected) {
      throw new Error(`Handover ${handoverId} is ${h.state}, expected ${expected}`);
    }
    return h;
  }

  private transition(
    handoverId: string,
    to: HandoverState,
    actor: string,
    summary: string,
    detail?: Record<string, unknown>,
  ): HandoverRecord {
    const h = this.get(handoverId);
    if (!h) throw new Error(`Unknown handover: ${handoverId}`);
    assertHandoverTransition(h.state, to);
    const at = nowIso();
    this.db.prepare(`UPDATE hq_handovers SET state = ?, updated_at = ? WHERE id = ?`).run(to, at, handoverId);
    this.hq.appendEvent({
      subjectKind: 'worker',
      subjectId: h.predecessorId,
      status: null,
      actor,
      summary,
      detail: { handoverId, toState: to, ...detail },
    });
    return this.get(handoverId)!;
  }
}

/**
 * THE canonical worker-assignability guard: throws if the worker is
 * deactivated in hq_specialists, or has an active (non-completed,
 * non-aborted) handover — including a plain freeze that never progressed
 * further.
 *
 * This is wired into operator/queue.ts's claim() — the only code path that
 * writes a worker id into op_tasks.claimed_by — so the replacement-safety
 * invariant ("a worker being replaced receives no new work") is enforced at
 * the assignment boundary itself rather than in individual callers or a UI.
 * Anything that grows a new way to hand work to a worker must call this too;
 * do not re-derive freeze state from a second source.
 *
 * Reads state straight from the database (not from any in-memory handle), so
 * it holds across process restarts and for callers that never construct a
 * HandoverStore. Self-sufficient: ensures its own tables first.
 */
export function assertAssignable(db: HqDatabase, workerId: string): void {
  ensureHandoverTables(db); // callable independently of HandoverStore construction
  const specialist = new HeadquarterStore(db).getSpecialist(workerId);
  if (specialist && !specialist.active) {
    throw new Error(`Worker ${workerId} is deactivated and cannot be assigned new work`);
  }
  const active = db
    .prepare(
      `SELECT id, state FROM hq_handovers WHERE predecessor_id = ? AND state NOT IN ('completed','aborted') ORDER BY created_at DESC LIMIT 1`,
    )
    .get(workerId) as { id: string; state: string } | undefined;
  if (active) {
    throw new Error(
      `Worker ${workerId} has an active handover (${active.id}, state: ${active.state}) and cannot be assigned new work`,
    );
  }
}
