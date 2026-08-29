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

export class EvidenceLog {
  constructor(private db: HqDatabase) {}

  append(entry: {
    taskId?: string | null;
    actor: string;
    kind: string;
    payload: Record<string, unknown>;
  }): EvidenceEntry {
    assertNoSecretLikeContent(entry.payload);
    const last = this.db
      .prepare(`SELECT hash FROM op_evidence ORDER BY seq DESC LIMIT 1`)
      .get() as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const id = uuid();
    const at = nowIso();
    const payloadJson = JSON.stringify(entry.payload);
    const hash = createHash('sha256')
      .update([prevHash, id, at, entry.taskId ?? '', entry.actor, entry.kind, payloadJson].join('|'))
      .digest('hex');
    const res = this.db
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
    return this.db.transaction(fn).immediate();
  }

  list(taskId?: string): EvidenceEntry[] {
    const rows = (
      taskId
        ? this.db.prepare(`SELECT * FROM op_evidence WHERE task_id = ? ORDER BY seq`).all(taskId)
        : this.db.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all()
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

  /** Recompute the chain; returns the seq of the first bad entry, or null if intact. */
  verifyChain(): number | null {
    let prevHash = GENESIS_HASH;
    for (const e of this.list()) {
      const expected = createHash('sha256')
        .update(
          [prevHash, e.id, e.at, e.taskId ?? '', e.actor, e.kind, JSON.stringify(e.payload)].join('|'),
        )
        .digest('hex');
      if (e.prevHash !== prevHash || e.hash !== expected) return e.seq;
      prevHash = e.hash;
    }
    return null;
  }
}
