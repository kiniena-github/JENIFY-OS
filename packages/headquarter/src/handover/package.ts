/**
 * Handover package generation (issue #120, HQ special lane D).
 *
 * generateHandoverPackage() is a PURE READ: it never mutates op_tasks or
 * hq_memory. It reads op_tasks/op_capabilities directly (read-only, per the
 * ownership constraint — this module never writes to those tables) and an
 * injected MemoryStore (packages/headquarter/src/memory) for company
 * knowledge. Reconciling any uncertain state (outcome_unknown, a stuck
 * side-effect review) happens only through the existing operator queue
 * (operator/queue.ts) — never here.
 */

import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { assertNoSecretLikeContent } from '../operator/evidence.js';
import type { MemoryRecord } from '../memory/schema.js';
import type { MemoryStore } from '../memory/store.js';

export interface HandoverTaskRef {
  id: string;
  capabilityId: string;
  status: string;
  reviewState: string;
}

export interface HandoverPackage {
  workerId: string;
  generatedAt: string;
  /** claimed_by = worker AND status in (assigned, running). */
  activeAssignments: HandoverTaskRef[];
  /**
   * claimed_by = worker AND status = outcome_unknown, OR a side-effect
   * capability task still running / with a review pending — the set that
   * must be resolved (via the operator queue, not here) before a
   * replacement can be verified complete.
   */
  unresolvedSideEffects: HandoverTaskRef[];
  /** CURRENT memory recorded by, or tagged with, this worker. */
  decisions: MemoryRecord[];
  /** Collected from memory `related.pullRequests`/`related.commits`. */
  branchesAndPrs: string[];
  /** Collected from memory `related.artifacts`. */
  files: string[];
  /** Collected from memory `sourceRefs` and any `refs` array inside a task's stored result. */
  evidence: string[];
  blockers: MemoryRecord[];
  dependencies: MemoryRecord[];
  nextActions: MemoryRecord[];
  outcomeUnknownTaskIds: string[];
}

interface TaskRow {
  id: string;
  capability_id: string;
  status: string;
  review_state: string;
  result: string | null;
  side_effect: number;
}

function toRef(row: TaskRow): HandoverTaskRef {
  return { id: row.id, capabilityId: row.capability_id, status: row.status, reviewState: row.review_state };
}

/**
 * "Tagged to the worker's projects" (issue #120 wording): Headquarter has no
 * separate worker-to-project ownership model elsewhere in this codebase, so
 * this treats a memory record as belonging to the worker when either
 * `recordedBy` is the worker, or the worker's id appears in `tags`. This is
 * a deliberate, documented interpretation rather than an invented business
 * rule — flagged as an open question in docs/JENIFY_HQ_MEMORY_HANDOVER.md.
 */
function ownedBy(record: MemoryRecord, workerId: string): boolean {
  return record.recordedBy === workerId || record.tags.includes(workerId);
}

function collectRefs(records: MemoryRecord[]): { branchesAndPrs: string[]; files: string[]; evidence: string[] } {
  const branchesAndPrs = new Set<string>();
  const files = new Set<string>();
  const evidence = new Set<string>();
  for (const r of records) {
    for (const pr of r.related.pullRequests ?? []) branchesAndPrs.add(`pr:${pr}`);
    for (const commit of r.related.commits ?? []) branchesAndPrs.add(`commit:${commit}`);
    for (const artifact of r.related.artifacts ?? []) files.add(artifact);
    for (const ref of r.sourceRefs) evidence.add(ref);
  }
  return { branchesAndPrs: [...branchesAndPrs], files: [...files], evidence: [...evidence] };
}

export function generateHandoverPackage(db: HqDatabase, memoryStore: MemoryStore, workerId: string): HandoverPackage {
  const taskRows = db
    .prepare(
      `SELECT t.id, t.capability_id, t.status, t.review_state, t.result, c.side_effect AS side_effect
       FROM op_tasks t JOIN op_capabilities c ON c.id = t.capability_id
       WHERE t.claimed_by = ?
       ORDER BY t.created_at`,
    )
    .all(workerId) as TaskRow[];

  const activeAssignments = taskRows.filter((r) => r.status === 'assigned' || r.status === 'running').map(toRef);
  const unresolvedSideEffects = taskRows
    .filter((r) => r.status === 'outcome_unknown' || (r.side_effect === 1 && (r.status === 'running' || r.review_state === 'pending')))
    .map(toRef);
  const outcomeUnknownTaskIds = taskRows.filter((r) => r.status === 'outcome_unknown').map((r) => r.id);

  const decisions = memoryStore.listCurrent().filter((r) => ownedBy(r, workerId));
  const blockers = memoryStore.listCurrent('blocker').filter((r) => ownedBy(r, workerId));
  const dependencies = memoryStore.listCurrent('dependency').filter((r) => ownedBy(r, workerId));
  const nextActions = memoryStore.listCurrent('next_action').filter((r) => ownedBy(r, workerId));

  const refs = collectRefs(decisions);
  const evidence = new Set(refs.evidence);
  for (const row of taskRows) {
    if (!row.result) continue;
    try {
      const parsed = JSON.parse(row.result);
      if (Array.isArray(parsed?.refs)) {
        for (const ref of parsed.refs) evidence.add(String(ref));
      }
    } catch {
      // Malformed/legacy result payload — ignore rather than fail the handover.
    }
  }

  const pkg: HandoverPackage = {
    workerId,
    generatedAt: nowIso(),
    activeAssignments,
    unresolvedSideEffects,
    decisions,
    branchesAndPrs: refs.branchesAndPrs,
    files: refs.files,
    evidence: [...evidence],
    blockers,
    dependencies,
    nextActions,
    outcomeUnknownTaskIds,
  };

  // Issue #120: "no copying secrets into memory" applies equally to the
  // handover package, which is itself persisted (replacement.ts).
  assertNoSecretLikeContent(pkg as unknown as Record<string, unknown>);
  return pkg;
}
