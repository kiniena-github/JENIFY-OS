/**
 * Append-only, hash-chained evidence log.
 *
 * Every operator decision and execution attempt lands here. Entries are
 * never updated or deleted; each entry's hash covers its content plus the
 * previous entry's hash, so silent tampering or deletion breaks the chain
 * and is detectable by verifyChain().
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';

export interface EvidenceEntry {
  seq: number;
  id: string;
  at: string;
  taskId: string | null;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS_HASH = 'genesis';

/**
 * Best-effort guard: refuse evidence payloads that look like they carry
 * secret material. This is a backstop, not the primary defense — the primary
 * rule is that credentials never enter the control plane at all.
 */
const SECRET_PATTERN =
  /(api[_-]?key|secret|password|passwd|bearer\s+[a-z0-9._-]{16,}|token)\s*[:=]\s*['"]?[^\s'"]{8,}/i;

export function assertNoSecretLikeContent(payload: Record<string, unknown>): void {
  const text = JSON.stringify(payload);
  if (SECRET_PATTERN.test(text)) {
    throw new Error('Evidence payload rejected: contains secret-like content');
  }
}

/**
 * Recompute the whole chain over a handle; returns the `seq` of the first
 * entry that does not verify, or null when the chain is intact.
 *
 * A module-level function over a DATABASE HANDLE rather than a method, and
 * deliberately so (Wave 5 review, High finding 1). The Phase 13 safe-mode
 * verdict takes `evidence_chain_broken` — the only blocking finding that
 * detects tampering with HQ's own audit record — from this computation, and an
 * enforcement decision may not be reached through anything a same-realm patch
 * can replace. `EvidenceLog.verifyChain` stays as the public delegate and now
 * calls this; `HeadquarterOperations` calls this directly through a `#private`
 * closure over its own handle, so patching `queue.evidence.verifyChain`, or
 * `EvidenceLog.prototype.verifyChain`, or `EvidenceLog.prototype.list`,
 * changes what the patcher sees and nothing about what safe mode decides.
 *
 * One computation, not two: duplicating the hash formula at the enforcement
 * site would let the two drift, and a drifted verifier reports a false break —
 * which under safe mode is an outage, not a warning.
 */
export function verifyEvidenceChain(db: HqDatabase): number | null {
  let prevHash = GENESIS_HASH;
  const rows = db.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const seq = row.seq as number;
    // Parsed and re-stringified, exactly as `list()` does it, because that is
    // the encoding `append()` hashed. A raw `row.payload` would differ from it
    // for any payload SQLite stored with different whitespace.
    const payloadJson = JSON.stringify(JSON.parse(row.payload as string));
    const expected = createHash('sha256')
      .update(
        [
          prevHash,
          row.id as string,
          row.at as string,
          (row.task_id as string | null) ?? '',
          row.actor as string,
          row.kind as string,
          payloadJson,
        ].join('|'),
      )
      .digest('hex');
    if (row.prev_hash !== prevHash || row.hash !== expected) return seq;
    prevHash = row.hash as string;
  }
  return null;
}

export class EvidenceLog {
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

  append(entry: {
    taskId?: string | null;
    actor: string;
    kind: string;
    payload: Record<string, unknown>;
  }): EvidenceEntry {
    assertNoSecretLikeContent(entry.payload);
    const last = this.#db
      .prepare(`SELECT hash FROM op_evidence ORDER BY seq DESC LIMIT 1`)
      .get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const id = uuid();
    const at = nowIso();
    const payloadJson = JSON.stringify(entry.payload);
    const hash = createHash('sha256')
      .update([prevHash, id, at, entry.taskId ?? '', entry.actor, entry.kind, payloadJson].join('|'))
      .digest('hex');
    const res = this.#db
      .prepare(
        `INSERT INTO op_evidence (id, at, task_id, actor, kind, payload, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, at, entry.taskId ?? null, entry.actor, entry.kind, payloadJson, prevHash, hash);
    return {
      seq: Number(res.lastInsertRowid),
      id,
      at,
      taskId: entry.taskId ?? null,
      actor: entry.actor,
      kind: entry.kind,
      payload: entry.payload,
      prevHash,
      hash,
    };
  }

  /**
   * Run `fn` inside an IMMEDIATE write transaction (issue #221, Codex P1 on
   * `1d5b3bf`).
   *
   * For a caller that must READ the log and then APPEND to it as one indivisible
   * decision — "has this already been done? if not, claim it" — the two halves
   * cannot be separate statements. Two processes holding the same database file
   * both read "not done", both append, and both go on to perform an irreversible
   * side effect. That is not hypothetical for the dispatch lane: the side effect
   * is a public GitHub issue, and the CLI has no process-level exclusion.
   *
   * IMMEDIATE, not deferred: the write lock is taken at BEGIN rather than at the
   * first write, so the second caller blocks BEFORE its read instead of reading
   * a stale answer and discovering the conflict too late to matter. A caller
   * that cannot acquire the lock gets SQLITE_BUSY — an exception, which is the
   * fail-closed outcome — rather than a duplicate.
   *
   * The log itself is unchanged: still append-only, still hash-chained. This
   * only decides when the append happens relative to a read.
   */
  reserve<T>(fn: () => T): T {
    return this.#db.transaction(fn).immediate();
  }

  list(taskId?: string): EvidenceEntry[] {
    const rows = (
      taskId
        ? this.#db.prepare(`SELECT * FROM op_evidence WHERE task_id = ? ORDER BY seq`).all(taskId)
        : this.#db.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: r.seq as number,
      id: r.id as string,
      at: r.at as string,
      taskId: (r.task_id as string | null) ?? null,
      actor: r.actor as string,
      kind: r.kind as string,
      payload: JSON.parse(r.payload as string),
      prevHash: r.prev_hash as string,
      hash: r.hash as string,
    }));
  }

  /**
   * Recompute the chain; returns the seq of the first bad entry, or null if
   * intact.
   *
   * A thin delegate over the module-level `verifyEvidenceChain`, so the READ
   * surface and the enforcement path share one computation and cannot drift.
   * This method is the patchable half of that pair by design — nothing decides
   * anything on it.
   */
  verifyChain(): number | null {
    return verifyEvidenceChain(this.#db);
  }
}
