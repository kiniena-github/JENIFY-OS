/**
 * Append-only, hash-chained evidence log.
 *
 * Every operator decision and execution attempt lands here. Entries are never
 * updated or deleted, and that is held in FOUR independent ways, because the
 * hash chain alone held only one of the four:
 *
 *  1. **The engine refuses the write.** `ensureEvidenceGuards` installs the
 *     same append-only trigger trio every other engine-immutable ledger
 *     carries — no UPDATE of any column, no DELETE of any row, and a BEFORE
 *     INSERT guard that closes REPLACE/UPSERT on `id`/`seq`. Until the Wave 5
 *     correction this table carried NO triggers at all, on the argument that
 *     "its guarantee is the chain rather than the engine"; a raw
 *     `DELETE FROM op_evidence WHERE seq > 1` was therefore simply permitted.
 *  2. **A dropped guard is a census finding.** `op_evidence` is now a member
 *     of `ENGINE_IMMUTABLE_TABLES`, so removing the triggers is
 *     `append_only_guard_missing` — blocking, and safe mode engages on it.
 *  3. **The chain commits to its own LENGTH, not only to its links.**
 *     `verifyEvidenceChain` walks the links, requires the seqs present to be
 *     CONTIGUOUS from 1, and compares the highest `seq` present against the
 *     AUTOINCREMENT high-water mark SQLite maintains in `sqlite_sequence`,
 *     which a DELETE does not lower. Without the high-water half, deleting the
 *     NEWEST entries left a chain that verified perfectly: the walk starts at
 *     the genesis value and had nothing to say about where the chain was
 *     supposed to END. Without the contiguity half, that same commitment was
 *     erased by the very next append — see the check itself.
 *  4. **A commitment that does not live inside the log.** Points 1–3 all read
 *     this table and ask whether it is self-consistent, and a writer that holds
 *     the file open can make a shortened log perfectly self-consistent. HQ
 *     therefore records the log's tip — its length and the hash at that seq —
 *     into `hq_integrity_checkpoints`, a separate append-only ledger that is
 *     itself engine-guarded and in the census, and `verifyEvidenceChain`
 *     refuses a log that contradicts any commitment ever recorded there. See
 *     `recordIntegrityCheckpoint` in `store/integrity.ts`.
 *
 * What is corrected rather than restated, three times:
 *
 *  - the header before the third correction round claimed "silent tampering or
 *    deletion breaks the chain and is detectable by verifyChain()". The
 *    tampering half was true; the deletion half was not, and it was the half an
 *    audit record actually needs (Wave 5 correction round three, High A2);
 *  - the header after it claimed point 3 unqualified while the length
 *    commitment lived only in `sqlite_sequence`, so ONE later append made a
 *    deletion invisible again and the documented remedy — a Founder full
 *    assessment — certified the robbed log as intact (Wave 5 correction round
 *    four, High 2). The contiguity requirement is what makes point 3 hold
 *    against the next write rather than only at the instant before it;
 *  - the header after THAT claimed points 1–3 named a real cost, in three
 *    sentences that were all false (Wave 5 correction round five, High 1). It
 *    said a coherent rewrite required RENUMBERING the survivors, that the
 *    renumbering needs the UPDATE the engine guard refuses, that dropping the
 *    guard is itself a blocking finding, and that a log dropped and re-created
 *    whole is answered by the dropped-ledger census. Executed, none of it held:
 *    `DROP TABLE op_evidence`, re-create it from its own `sqlite_master` SQL,
 *    INSERT a shortened log with explicit seqs rehashed from the genesis value,
 *    re-create the three triggers — no UPDATE anywhere, so that barrier is
 *    never crossed; no write to `sqlite_sequence`, because SQLite rebuilds the
 *    high-water mark from the explicit rowids; no census finding, because the
 *    guards are back before HQ next constructs and the as-found census reads
 *    `sqlite_master` at construction time only; and nothing from the
 *    dropped-ledger detector, because the attacker re-created the table. Two
 *    committed audit entries were erased and both the boot and the Founder's
 *    full assessment read CLEAN. Point 4 is the answer, and it is a commitment
 *    recorded outside this table rather than a fourth reading of the table.
 *
 * The residual is stated rather than glossed, at the CHEAPEST price found and
 * with the version WITHOUT each named barrier executed first. The previous
 * round's sentence here named DROPPING `hq_integrity_checkpoints` as what the
 * surviving attack costs, and that was false in the reassuring direction (Wave
 * 5 correction round six, Medium 1): the drop costs a restart and a second
 * Founder act, while wiping the commitments' ROWS in place — drop the ledger's
 * three triggers, `DELETE`, INSERT one row agreeing with the forged log,
 * re-create the triggers — left the table present, the census silent and the
 * forgery accepted from the very next boot at zero restarts and zero Founder
 * acts. That free version is now blocking: the commitment ledger's row count,
 * greatest rowid and AUTOINCREMENT high-water mark are one number or rows were
 * elided from it (`elidedCommitmentLedgerRows`). Appending a commitment that
 * matches the forgery has never worked on its own, because every commitment
 * ever recorded is checked and the per-ledger comparison takes the maximum.
 *
 * What SURVIVES, executed: the same in-place wipe with that invariant repaired
 * — the replacement inserted at an explicit `seq = 1`, then one `UPDATE
 * sqlite_sequence` for that ledger, which no trigger can guard. Measured
 * `boot=false assess=false release=ADMITTED`. The cheaper one-statement repair,
 * DELETING that `sqlite_sequence` row instead, was tried too and buys only the
 * process that follows: the assessment it was aiming to pass is itself the next
 * commitment, which re-creates the mark and breaks the identity again
 * (`p3 boot=true assess=true release=refused`, permanently). So
 * the cost is one explicit rowid and one extra `UPDATE`, across two
 * engine-guarded ledgers and a census that reports a drop at the boot that
 * observes it — a real cost, and still not a cryptographic boundary. HQ holds
 * no key a foreign writer does not also have; nothing here pretends otherwise.
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { contradictedChainCommitment } from '../store/integrity.js';

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

/**
 * The chain's zero value. Module-private and stays that way: the one
 * enforcement-safe verifier, `verifyEvidenceChain` below, lives in this module
 * and closes over it, so there is exactly ONE spelling of the zero value and no
 * second computation that could drift from it. (A previous correction pass
 * exported this constant so a verifier written elsewhere could share it; the
 * verifier was moved HERE instead, which is strictly better — the export would
 * now be a dead surface inviting exactly that second copy.)
 */
const GENESIS_HASH = 'genesis';

/**
 * The engine-held half of the append-only guarantee, in the exact shape every
 * other engine-immutable ledger already carries.
 *
 * Declared in `ENGINE_IMMUTABLE_TABLES` under the `op_evidence` prefix, so the
 * integrity census reports it if any of the three goes missing. Nothing in HQ
 * updates or deletes an evidence row — `EvidenceLog.append` holds the only
 * write statement against this table in the whole package — so these guards
 * refuse nothing a legitimate writer does.
 */
const EVIDENCE_GUARD_DDL = `
CREATE TRIGGER IF NOT EXISTS trg_op_evidence_no_rewrite
BEFORE UPDATE ON op_evidence
BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_op_evidence_no_erase
BEFORE DELETE ON op_evidence
BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_op_evidence_no_replace
BEFORE INSERT ON op_evidence
WHEN EXISTS (SELECT 1 FROM op_evidence WHERE id = NEW.id)
  OR (TYPEOF(NEW.seq) = 'integer' AND EXISTS (SELECT 1 FROM op_evidence WHERE seq = NEW.seq))
BEGIN SELECT RAISE(ABORT, 'op_evidence is append-only'); END;
`;

/**
 * Install the append-only guards on `op_evidence`. Idempotent; safe on every
 * construction.
 *
 * Called from the facade constructor AFTER the boot-time missing-guard
 * observation, exactly like every other `ensure*Schema`. That ordering is
 * load-bearing: these are `CREATE TRIGGER IF NOT EXISTS`, so a construction
 * RESTORES a dropped guard, and a census run afterwards would find a healthy
 * file and report one. Putting them in `migrateHqDatabase` instead would run
 * them before the facade exists and make the census permanently blind to a
 * drop.
 *
 * Never on a READ-ONLY handle: the snapshot path observes a file, it does not
 * migrate one.
 */
export function ensureEvidenceGuards(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(EVIDENCE_GUARD_DDL);
}

/**
 * The AUTOINCREMENT high-water mark SQLite itself maintains for `op_evidence`.
 *
 * `seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`, so SQLite records the largest
 * value ever assigned in `sqlite_sequence` and — this is the property the check
 * rests on — a DELETE does not lower it. Executed both ways before it was
 * relied on: after `DELETE ... WHERE seq > 2` the mark stayed at 5, and after
 * `DELETE FROM` (all rows) it stayed at 5 as well.
 *
 * Null when there is nothing to compare against: `sqlite_sequence` is created
 * lazily by the first AUTOINCREMENT insert in the whole database, and its row
 * for a table disappears with the table. A dropped `op_evidence` is caught by
 * the census instead (`ENGINE_IMMUTABLE_TABLES`), which is the check that can
 * actually see it.
 */
function evidenceHighWaterMark(db: HqDatabase): number | null {
  try {
    const row = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'op_evidence'`).get() as
      | { seq: unknown }
      | undefined;
    if (!row) return null;
    const value = Number(row.seq);
    return Number.isInteger(value) ? value : null;
  } catch {
    // No `sqlite_sequence` at all: nothing has ever been appended anywhere, so
    // there is no commitment to contradict.
    return null;
  }
}

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
 * entry that does not verify — or the first entry that is ABSENT — and null
 * only when the whole log stands.
 *
 * **The length is part of what is verified** (Wave 5 correction round three,
 * High A2). Walking from the genesis value forward proves that the entries
 * PRESENT link to each other; it says nothing about where the chain was
 * supposed to end, so deleting the newest entries left a log that verified
 * perfectly and a `fullIntegrity` that read clean. The high-water mark closes
 * exactly that: the entries present must reach the largest `seq` SQLite has
 * ever assigned.
 *
 * **And the length commitment has to survive the next write** (Wave 5
 * correction round four, High 2). The high-water comparison alone did not: one
 * further append raised `lastSeq` back to the mark and the missing seqs simply
 * became a hole in the middle. So the seqs present must also be CONTIGUOUS
 * from 1, which is a property of the record rather than of the moment it is
 * read.
 *
 * **And none of that survives a log that was re-created whole** (Wave 5
 * correction round five, High 1). Links, contiguity and the high-water mark are
 * all read out of the same table, so a writer that drops it and inserts a
 * shortened, coherently rehashed replacement satisfies every one of them. The
 * last check is therefore against `hq_integrity_checkpoints` — a commitment HQ
 * recorded elsewhere, in an append-only ledger of its own — and it is the only
 * one of the four that a rewrite of THIS table cannot satisfy.
 *
 * A deletion in the MIDDLE with NO later append was always caught by the links
 * themselves: the following entry's `prev_hash` no longer matches its new
 * predecessor. With a later append it was not — the appended entries chain from
 * the surviving tip, so every present row links to its present neighbour — and
 * the contiguity requirement is what catches it now.
 *
 * A module-level function over a DATABASE HANDLE rather than a method, and
 * deliberately so (Wave 5 review, High finding 1). The Phase 13 safe-mode
 * verdict takes `evidence_chain_broken` from this computation, and an
 * enforcement decision may not be reached through anything a same-realm patch
 * can replace.
 *
 * It is no longer described as "the only blocking finding that detects
 * tampering with HQ's own audit record", because that was both a false claim
 * and a fragile design (Wave 5 correction round three, High A2):
 * `op_evidence` now carries the engine's own append-only guards, so
 * `append_only_guard_missing` detects the removal of those guards, and this
 * check detects a chain whose links or whose LENGTH no longer stand. Two
 * findings, deliberately, because either one alone could be walked around.
 *
 * `EvidenceLog.verifyChain` stays as the public delegate and now
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
  let lastSeq = 0;
  // The seq the next row must carry. `seq` is `INTEGER PRIMARY KEY
  // AUTOINCREMENT` and the only writer is `append()`, so a log that has never
  // lost an entry is 1, 2, 3, … with no gap — see the CONTIGUITY check below.
  let expectedSeq = 1;
  const rows = db.prepare(`SELECT * FROM op_evidence ORDER BY seq`).all() as Record<string, unknown>[];
  for (const row of rows) {
    const seq = row.seq as number;
    // CONTIGUITY, checked before the links (Wave 5 correction round four,
    // High 2). The high-water comparison at the end of this function is a
    // commitment to how far the chain REACHED, and it is erased by the next
    // append: delete the tail, append one more entry, and `lastSeq` catches
    // up with `sqlite_sequence` again while the deleted seqs stay missing in
    // the middle. The links do not object either — the later entries chained
    // from the SURVIVING tip, so every present row links to its present
    // neighbour. Executed against the previous head: a log of [1..6] robbed
    // of 5 and 6 read [1,2,3,4] and was DETECTED, and after HQ's own next two
    // boot appends it read [1,2,3,4,7,8] and verified CLEAN — so the very
    // remedy the residual list tells the Founder to run (one full assessment)
    // certified the robbed log.
    //
    // A missing seq is a fact about the record that no later append can
    // repair, which is what makes the header's "commits to its own LENGTH"
    // true rather than true-until-the-next-write. The first ABSENT seq is
    // reported, the same shape of answer the tail check gives.
    if (seq !== expectedSeq) return expectedSeq;
    expectedSeq = seq + 1;
    // Parsed and re-stringified, exactly as `list()` does it, because that is
    // the encoding `append()` hashed. A raw `row.payload` would differ from it
    // for any payload SQLite stored with different whitespace.
    //
    // An UNPARSEABLE payload is a broken entry, not a passed one, and not an
    // exception either: this function feeds a safe-mode verdict, so a raw
    // writer that stored `payload = 'not json'` must produce a BREAK at that
    // seq rather than a thrown error that the assessment never returns from.
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(JSON.parse(row.payload as string));
    } catch {
      return seq;
    }
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
    lastSeq = seq;
  }
  // The TAIL. Every link above holds and the log still does not stand if
  // entries were removed from the end of it: the mark SQLite maintains is a
  // commitment to how far the chain reached, and a DELETE cannot lower it. The
  // first ABSENT seq is reported, which is the same shape of answer as the
  // first entry that does not verify — "the log stops being true here".
  const highWater = evidenceHighWaterMark(db);
  if (highWater != null && highWater > lastSeq) return lastSeq + 1;
  // The DURABLE COMMITMENT, last (Wave 5 correction round five, High 1). Every
  // check above reads this log and asks whether it is self-consistent, and a
  // writer holding the file open can make a shortened log perfectly
  // self-consistent — drop the table, re-create it from its own schema, insert
  // a rehashed shorter log with explicit seqs, re-create the guards. Links,
  // contiguity and the high-water mark all agree afterwards, because
  // `sqlite_sequence` is rebuilt from the explicit rowids and no UPDATE was
  // ever executed. The checkpoint ledger is the witness that does not live
  // inside the record: see `recordIntegrityCheckpoint`.
  //
  // Checked AFTER the walk, deliberately: a genuine break in the links or a
  // hole in the seqs keeps its own precise answer, and the commitment only
  // speaks when the log has been made to look whole.
  return contradictedChainCommitment(db);
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
