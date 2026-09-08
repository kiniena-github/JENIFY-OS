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
 *  2. **A dropped guard is a census finding.** `op_evidence` is a member of
 *     `ENGINE_IMMUTABLE_TABLES`, so removing the triggers is
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
 * **Holds 3 and 4 answer different questions, and neither subsumes the other.**
 * The concurrent Wave 5 round-four lanes each closed one of the two ways the
 * length commitment failed, and both closures are kept:
 *
 *  - CONTIGUITY (hold 3) is a property of the record that no later write
 *    repairs, so it holds with no prior commitment on the file at all. It is
 *    silent on a log DROPPED and re-created whole, because the seqs then
 *    restart at 1 with no gap;
 *  - the DURABLE COMMITMENT (hold 4) survives that drop, because it lives in a
 *    different ledger — but it says nothing until HQ has recorded one, so a
 *    file nothing has happened on yet has only holds 1–3.
 *
 * Together they leave no window: a tail delete followed by any number of
 * appends fails contiguity, and a whole-log rebuild that restores contiguity
 * fails the commitment.
 *
 * **There was a second candidate for hold 4, and it is gone rather than kept
 * beside this one.** The round-four lane recorded the same tip on every
 * VERDICT row (`evidence_tip_seq` / `evidence_tip_hash` on
 * `hq_reliability_verdicts`) and read the strongest back with a MAX. Both
 * mechanisms answer one question — "how far did this log reach, according to a
 * record kept outside it" — and two answers to one question is the thing this
 * package does not keep. The MAX is the reason this one survived: appending to
 * the verdict ledger is a write its trio deliberately permits, so a writer that
 * rebuilt `op_evidence` as a LONGER coherent forgery could append a verdict
 * committing to the forged tip and the MAX would select it, retiring the
 * genuine commitment behind it. `contradictedChainCommitment` checks EVERY
 * commitment ever recorded and takes the per-ledger maximum, so the same
 * appended row adds a satisfied row and removes nothing. The checkpoint is also
 * written at every construction that finds nothing blocking, not only when a
 * Founder assessment records a verdict, which bounds the forger's window to one
 * process lifetime rather than to the gap between two Founder acts. What was
 * lost with the verdict-row version is stated rather than glossed: the two
 * commitments lived in two different ledgers, so an attacker now has to drop
 * ONE ledger rather than two — see the residual at the end of this header.
 *
 * **Hold 4 is not decoration, and it corrects four shipped claims** (Wave 5
 * correction rounds four High H1 and five High 1). Holds 1–3 all live INSIDE
 * the thing being checked: the triggers, the rows and the `sqlite_sequence`
 * entry all disappear with `DROP TABLE op_evidence`, which is DDL that no
 * BEFORE trigger refuses. And the census that hold 2 rests on runs AFTER
 * `migrateHqDatabase` has already re-created the table, empty.
 *
 *  - the header before the fourth round said "a dropped `op_evidence` is caught
 *    by the census … the check that can actually see it". It was NOT: executed,
 *    raw-view `absentImmutableTables` returned `["op_evidence"]` and, after
 *    `openHqDatabase()`, `[]`. A drop plus a rebuild carrying its own three
 *    declared guards read `safeMode: false`, `observations: []`,
 *    `chainVerified: true` at both depths over a destroyed audit log — and
 *    CLEARED an already-latched safe mode. The ordering is fixed at the
 *    ordering (`tableNamesBeforeMigration`), and the commitment closes the
 *    rebuild case that no ordering can;
 *  - that header also called the `sqlite_sequence` step a real barrier because
 *    "the first of them is itself a blocking finding". It is not: a dropped
 *    trigger that is RECREATED before the next boot observation is never
 *    observed missing, so drop-trigger / delete-tail / recreate-trigger /
 *    `UPDATE sqlite_sequence` read clean. `sqlite_sequence` carries no triggers
 *    and cannot be brought under the census — it is an internal SQLite table —
 *    so what closes that is the commitment, which lives in a ledger that DOES
 *    carry the guards. **"And IS censused" was the half that did not hold**
 *    (Wave 5 correction round six, High 1): the census reads `sqlite_master` at
 *    construction time, and this header's own sentence two lines up says a
 *    trigger dropped and re-created before the next boot is never observed
 *    missing — so the SAME three statements emptied the witness ledger, and
 *    both of its readers read the very rows deleted. Executed: boot clean, full
 *    Founder assessment clean, `releaseKillSwitch` admitted. What makes the
 *    ledger genuinely censused is `truncatedImmutableLedgers`, which generalises
 *    the `MAX(rowid)` versus `sqlite_sequence` comparison this function already
 *    makes for `op_evidence` to EVERY declared AUTOINCREMENT ledger and reports
 *    `append_only_ledger_truncated`, blocking, at both depths.
 *
 * **And two further claims are corrected, from the other round-four lane:**
 *
 *  - the header before the third correction round claimed "silent tampering or
 *    deletion breaks the chain and is detectable by verifyChain()". The
 *    tampering half was true; the deletion half was not, and it was the half an
 *    audit record actually needs (Wave 5 correction round three, High A2);
 *  - the header after it claimed point 3 unqualified while the length
 *    commitment lived only in `sqlite_sequence`, so ONE later append made a
 *    deletion invisible again — HQ's OWN boot appends being the laundering
 *    write — and the documented remedy, a Founder full assessment, certified
 *    the robbed log as intact (Wave 5 correction round four, High 2). The
 *    contiguity requirement is what makes point 3 hold against the next write
 *    rather than only at the instant before it, and no `sqlite_sequence`
 *    rewrite was ever needed for that route;
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
 * with the version WITHOUT each named barrier executed first. HQ holds no key a
 * foreign writer does not also have, so a writer that already holds the database
 * file open can still APPEND a correctly-hashed entry of its own; nothing here
 * is a signature.
 *
 * Beyond that, TWO prices stated here in earlier rounds were both wrong in the
 * reassuring direction, and both are corrected rather than left standing:
 *
 *  - the round-five sentence named DROPPING `hq_integrity_checkpoints` as what
 *    the surviving attack costs (Wave 5 correction round six, Medium 1). The
 *    drop reproduces exactly as written — a restart and a second Founder act —
 *    but it was never the cheap path: wiping the commitments' ROWS in place —
 *    drop the ledger's three triggers, `DELETE`, INSERT one row agreeing with
 *    the forged log, re-create the triggers — left the table present, so the
 *    as-found census had nothing to observe and the forgery was accepted from
 *    the very next boot at zero restarts and zero Founder acts. That free
 *    version is now blocking: the commitment ledger's row count, its greatest
 *    rowid and its AUTOINCREMENT high-water mark are one number, or rows were
 *    elided from it (`elidedCommitmentLedgerRows`);
 *  - the round-five reconciliation recorded the cost of retiring the concurrent
 *    lane's SECOND commitment (the verdict-row `evidence_tip_seq` /
 *    `evidence_tip_hash` pair) as "there is now ONE ledger to drop" rather than
 *    two. The trade itself was taken on the merits and stands — a barrier a
 *    PERMITTED write can retire is not a second barrier — but its price was
 *    understated in the same reassuring direction, because until the row check
 *    above existed the surviving ledger did not have to be DROPPED at all. The
 *    honest re-pricing is one ledger to drop OR to wipe in place and re-seat,
 *    and the second of those is exactly what `elidedCommitmentLedgerRows`
 *    closes; what remains of it is priced immediately below.
 *
 * Appending a commitment that matches the forgery has never worked on its own,
 * because every commitment ever recorded is checked and the per-ledger
 * comparison takes the maximum.
 *
 * What SURVIVES, executed: the same in-place wipe with that invariant repaired
 * — the replacement inserted at an explicit `seq = 1`, then one `UPDATE
 * sqlite_sequence` for that ledger, which no trigger can guard. Measured
 * `boot=false assess=false release=ADMITTED`. The cheaper one-statement repair,
 * DELETING that `sqlite_sequence` row instead, was tried too and buys only the
 * process that follows: the assessment it was aiming to pass is itself the next
 * commitment, which re-creates the mark from the surviving rowid and breaks the
 * identity again (`p3 boot=true assess=true release=refused`, permanently). So
 * the cost is one explicit rowid and one extra `UPDATE`, across two
 * engine-guarded ledgers and a census that reports a drop at the boot that
 * observes it — a real cost, and still not a cryptographic boundary. Dropping
 * `hq_integrity_checkpoints` outright is still the other route, and still costs
 * the restart and the second Founder act the round-five text priced it at.
 *
 * The other round-six lane reproduced the SAME in-place wipe independently and
 * closed it with a second, weaker rule that is kept beside the row-count
 * identity because it is not the same rule:
 * `truncatedImmutableLedgers` asserts `MAX(rowid) >= sqlite_sequence` over EVERY
 * declared AUTOINCREMENT ledger and reports `append_only_ledger_truncated`,
 * blocking, at both depths. It is what closes the identical attack on the
 * twenty-odd ledgers this ledger's own invariant says nothing about — most
 * sharply `hq_reliability_run_events`, where emptying the ledger returned a
 * correctly refused duplicate attempt to generation 1 and ADMITTED it, making
 * `RUN_RETRY_STATEMENT`'s "an interrupted attempt is NEVER retried
 * automatically" false. The row-count identity is strictly stronger for the
 * commitment ledger, because a replacement row can restore the greatest rowid;
 * neither subsumes the other.
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
 * for a table disappears with the table.
 *
 * A dropped `op_evidence` is therefore INVISIBLE here, and the claim that used
 * to stand in this comment — that the census catches it, being "the check that
 * can actually see it" — was false (Wave 5 correction round four, High H1). The
 * census ran after `migrateHqDatabase` had already re-created the table. What
 * sees it now is the pre-migration observation and the durable chain-tip
 * commitment; see the module header.
 *
 * `sqlite_sequence` is also UNGUARDED and uncensused — it is an internal SQLite
 * table, so no trigger can be put on it and `tableNames` excludes it by
 * construction. One `UPDATE sqlite_sequence` therefore defeats this check on
 * its own. It is kept because it is free and catches a careless truncation; the
 * commitment is what catches a deliberate one.
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
 * Neither of them detects DESTRUCTION, and that is stated here rather than
 * left to be discovered: this walk sees only what the table now contains, so
 * over a log dropped and rebuilt it returns null — "the chain stands" — about a
 * chain that no longer exists. `contradictedChainCommitment` is the check for
 * that; it is the LAST step of this function and the structural pass reads it
 * directly as well, so it speaks at both depths (Wave 5 correction round four,
 * High H1; round five, High 1).
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

/**
 * **The chain's TIP is deliberately not exported from this module.**
 *
 * The concurrent round-four lane exported an `evidenceChainTip` here so the
 * verdict ledger could store the tip on every verdict row. That mechanism was
 * retired in favour of `hq_integrity_checkpoints` (see hold 4 in the module
 * header), and `store/integrity.ts` reads the tip through its own module-private
 * helper as part of writing a checkpoint. Re-exporting the read here would leave
 * exactly the dead surface the `GENESIS_HASH` note above warns about: a second
 * place to read the same two columns, inviting a second spelling of what a
 * commitment is.
 */

/**
 * Does the entry at `seq` LINK soundly — its own hash correct over its stored
 * fields, and its `prev_hash` equal to the hash of the entry before it?
 *
 * O(1), which is what lets a boot-time structural pass use it. It is not a
 * whole-chain verification and does not claim to be: what it answers is "is
 * this one row a genuine link", which is exactly the question a corroboration
 * check needs (Wave 5 correction round four, Medium M1). Before it, a
 * corroborating evidence row needed NO valid hash at all — the check matched
 * `kind` and a `json_extract` of the payload — so two raw INSERTs cleared a
 * latched safe mode while the chain was genuinely broken.
 *
 * The residual is unchanged and is stated wherever this is used: HQ holds no
 * key a foreign writer does not also have, so a writer holding the file open
 * can APPEND a correctly-hashed row. This raises the bar from "any row" to "a
 * row that is really part of the chain"; it is not a cryptographic boundary.
 */
export function evidenceEntryLinkStands(db: HqDatabase, seq: number): boolean {
  try {
    const row = db.prepare(`SELECT * FROM op_evidence WHERE seq = ?`).get(seq) as
      | Record<string, unknown>
      | undefined;
    if (!row) return false;
    const previous = db
      .prepare(`SELECT hash FROM op_evidence WHERE seq < ? ORDER BY seq DESC LIMIT 1`)
      .get(seq) as { hash: unknown } | undefined;
    const prevHash = previous ? previous.hash : GENESIS_HASH;
    if (typeof prevHash !== 'string') return false;
    if (row.prev_hash !== prevHash) return false;
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(JSON.parse(row.payload as string));
    } catch {
      return false;
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
    return row.hash === expected;
  } catch {
    return false;
  }
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
