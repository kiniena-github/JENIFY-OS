/**
 * Every mutation IN THE PACKAGE that pairs a canonical row write with a
 * hash-chained evidence append runs in ONE transaction — derived from the
 * shape, not from a list (Wave 5 correction round sixteen, High B-4; the file
 * scope corrected in round seventeen, High-1).
 *
 * ## What was still open after round sixteen, and it is the same lesson again
 *
 * Round sixteen replaced a list of METHODS with a derivation over the shape,
 * and then scoped that derivation to ONE FILE — `src/operator/queue.ts` — while
 * the docblock below described a class. A hostile review pointed the same
 * measurement at `service.ts` and found four members with exactly the shape and
 * none of the three atomicity credits: `promoteProposal`, `rejectProposal`,
 * `proposeMission` and `assignTask`. Measured on `85b720d`, with a
 * `BEFORE INSERT ON op_evidence WHEN NEW.kind = 'mission_promoted_to_task' ->
 * RAISE(ABORT, 'blocked')` trigger standing:
 *
 * ```
 * BEFORE: {"tasks":0,"proposalStatus":"proposed"}
 * RESULT: THREW blocked                     <- the caller was told it failed
 * AFTER : tasks 1, proposalStatus promoted, evidenceRows 0,
 *         task capability github.open_pr status queued
 * CLAIM : {"ok":true,"claimedBy":"claude"}  <- claimable, zero audit rows
 * RE-PROMOTE: {"ok":false,"code":"proposal_not_open"}   <- permanently wedged
 * ```
 *
 * `rejectProposal` (`{"status":"rejected","evidenceRows":0}`) and
 * `proposeMission` (`{"proposals":1,"evidenceRows":0}`) reproduced the same
 * shape. So the SCAN is the deliverable and its scope is the whole package: it
 * now walks every `.ts` file under `src/`, and the four methods above are its
 * first output rather than four named repairs.
 *
 * ## What was open originally
 *
 * Round fifteen closed this class for `PrivilegedQueueApi` by wrapping the
 * whole surface at the one place it is issued, and wrote: "the wrapper is
 * applied HERE, at the one place the privileged API is issued, so a mutation
 * added to `PrivilegedQueueApi` in a future phase is atomic by construction
 * instead of by somebody remembering."
 *
 * That sentence is true and its scope is narrower than the defect. MEMBERSHIP
 * OF `PrivilegedQueueApi` IS NOT THE PROPERTY THAT MAKES A MUTATION NEED A
 * TRANSACTION — the update-then-append SHAPE is. `complete()` has exactly that
 * shape, is not on that surface, and reproduced the identical defect. With a
 * `BEFORE INSERT ON op_evidence WHEN kind =
 * 'execution_result_submitted_for_review' -> RAISE(ABORT)` trigger standing, a
 * hostile review measured:
 *
 * ```
 * RESULT: {"code":"operator_rejected","msg":"blocked"}
 * AFTER : status running / review_state PENDING / submitted_by claude / result committed
 * evidence rows for that kind: 0
 * ```
 *
 * The caller was told the submission failed; it had not. The task sat in the
 * independent reviewer's queue with zero hash-chained audit rows behind it, and
 * `HeadquarterOperations.submitResult`'s own
 * `if (existing.reviewState === 'pending') return fail(…'cannot be
 * re-submitted')` guard then wedged it there permanently — the task could
 * neither be reviewed honestly nor re-submitted.
 *
 * ## What is enforced instead
 *
 * Two halves, and the first is the one that generalises:
 *
 *  1. A DERIVED SHAPE GUARD over the WHOLE PACKAGE. Every unit of code under
 *     `src/` — a class member at member indentation, a top-level `function`,
 *     or a top-level `const` binding, in any file — whose own text contains
 *     BOTH a canonical row write (an `INSERT`/`UPDATE`/`DELETE` prepared
 *     statement, a `#transition`, a `#recordEvent` or a `#upsertMeta`) AND an
 *     evidence append (`#evidence.append`, `appendEvidence` or
 *     `#appendDispatchOutcome`) must be atomic. Three ways to be atomic are
 *     accepted and all three are derived from the source: the body reserves for
 *     itself; the member is handed out through its file's `atomic(…)` wrapper
 *     (that set is parsed out of the source, not typed here); or every call to
 *     it in its own file is itself inside a reservation. A unit added in a
 *     future phase with that shape and none of those three fails on the day it
 *     is written, in whichever file it is written.
 *
 *  2. The BEHAVIOURAL proof, by the same abort-trigger attack the reviews used,
 *     against the mutations they named: `complete` (which failed in round
 *     sixteen), `fail` (which passed by ORDERING — it appends first — and is
 *     reserved as well, because ordering is not a property a later edit
 *     preserves), `claim`, and round seventeen's four —
 *     `promoteProposal`, `rejectProposal`, `proposeMission` and `assignTask`.
 *
 * ## What this does not claim — measured, not aspirational
 *
 * The shape guard is a lexical scan over source text. Named limitations:
 *
 *  - it cannot tell that a reservation ENCLOSES the pair rather than merely
 *    appearing somewhere in the unit's text. A unit that reserves for an
 *    unrelated reason and then writes-and-appends outside that reservation is
 *    credited by the scan and is not atomic. Only the behavioural half proves
 *    enclosure, and it proves it for eight mutations, not for all 42;
 *  - it does not follow calls into helpers that write on a unit's behalf, so a
 *    pair split across two units (one writes, the other appends, a third calls
 *    both) is invisible to it;
 *  - a class member is sliced from its declaration line to the next member's,
 *    so a nested function inside a member is part of that member's text rather
 *    than a unit of its own — deliberately inclusive, since it can only make a
 *    pair more visible, never less;
 *  - a unit that writes a canonical row through a spelling none of the four
 *    write predicates recognises (a raw `db.exec`, a helper module's writer) is
 *    not seen as writing at all;
 *  - `appendEvidence(` matches on the METHOD NAME, so a same-named method on an
 *    unrelated object would be counted. There is no such method in `src/`
 *    today; if one is added the scan over-reports rather than under-reports.
 *
 * Measured at the head that closed round seventeen's High-1: **42 units in
 * `src/` pair a canonical write with an evidence append**, across
 * `src/operator/queue.ts` and `src/application/service.ts`; nine are credited
 * by the `atomic(…)` wrapper or by every caller reserving, and the rest reserve
 * for themselves. It is a floor, not a proof of serializability.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const QUEUE = path.join(SRC, 'operator', 'queue.ts');

/** Every `.ts` file under `src/`, so a file added in a future phase is scanned. */
function sourceFiles(directory: string = SRC, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out.sort();
}

/**
 * Every UNIT of code in one file, each with its own text.
 *
 * A unit is a class member at member indentation, a top-level `function`, or a
 * top-level `const` binding — sliced from one declaration to the next, which is
 * the same technique `unauthenticated-founder-text.test.ts` uses on the facade.
 * Derived, so a member OR a module function added in a future phase is scanned
 * without being named. `memberBodies` below is this function restricted to
 * `OperatorQueue`, kept because the queue-specific assertions name queue
 * members.
 */
function unitBodies(source: string): Map<string, string> {
  const lines = source.split('\n');
  const reserved = ['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try', 'constructor', 'function'];
  const starts: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const member = /^ {2}(?:(?:readonly|static|async|get|set|public|private|protected)\s+)*(#?[A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^=;]*>)?\(/.exec(line);
    const fn = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line);
    const binding = /^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[:=]/.exec(line);
    const name = fn?.[1] ?? binding?.[1] ?? member?.[1] ?? null;
    if (!name || reserved.includes(name)) continue;
    starts.push({ name, line: i });
  }
  const bodies = new Map<string, string>();
  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]!.line : lines.length;
    const text = lines.slice(start.line, end).join('\n');
    bodies.set(start.name, (bodies.get(start.name) ?? '') + text);
  });
  return bodies;
}

/**
 * Members of `OperatorQueue`, public and `#private`, each with its own text.
 * The whole-package scan uses `unitBodies`; this narrows it to the queue class
 * for the assertions that name queue members by hand.
 */
function memberBodies(source: string): Map<string, string> {
  const lines = source.split('\n');
  const classStart = lines.findIndex((line) => /^export class OperatorQueue\b/.test(line));
  expect(classStart, 'OperatorQueue must be declared in this file').toBeGreaterThan(-1);
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(?:(?:readonly|static|async|get|set)\s+)*(#?[A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lines[i]!);
    if (!match) continue;
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else', 'try'].includes(match[1]!)) continue;
    starts.push({ name: match[1]!, line: i });
  }
  const bodies = new Map<string, string>();
  starts.forEach((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1]!.line : lines.length;
    bodies.set(start.name, lines.slice(start.line, end).join('\n'));
  });
  return bodies;
}

/**
 * Does this text write a canonical row?
 *
 * `#upsertMeta` is here because `hq_op_task_meta.assigned_worker_id` is what
 * `#assignmentIntentOf` ENFORCES at the claim boundary — an intent row is a
 * canonical write by any measure that matters, and `assignTask` was the fourth
 * member round seventeen's widening found.
 */
function writesARow(body: string): boolean {
  return (
    /\.prepare\(\s*`?\s*(?:INSERT|UPDATE|DELETE)/i.test(body) ||
    /this\.#transition\(/.test(body) ||
    /this\.#recordEvent\(/.test(body) ||
    /this\.#upsertMeta\(/.test(body)
  );
}

/**
 * Does this text append to the hash-chained evidence log?
 *
 * Three spellings, because the log is reached three ways: the queue's own
 * `#evidence.append`, the facade's `appendEvidence` through the privileged
 * API, and the dispatch lane's narrow `#appendDispatchOutcome` grant.
 */
function appendsEvidence(body: string): boolean {
  return (
    /#evidence\s*\.\s*append\(/.test(body) ||
    /\bappendEvidence\(/.test(body) ||
    /#appendDispatchOutcome\(/.test(body)
  );
}

/** Does this text open a reservation of its own? */
function reservesForItself(body: string): boolean {
  return /\breserve\(/.test(body) || /\breserveEvidence\s*[<(]/.test(body);
}

/**
 * The `#private` methods the constructor hands out through `atomic(…)`.
 * PARSED from the `grantPrivileged` block rather than listed here, so a
 * mutation added to `PrivilegedQueueApi` is credited automatically and one
 * REMOVED from the wrapper stops being credited.
 */
function atomicallyIssued(source: string): Set<string> {
  return new Set(
    [...source.matchAll(/atomic\(\([^)]*\)\s*=>\s*this\.(#[A-Za-z0-9_]+)\(/g)].map((match) => match[1]!),
  );
}

/**
 * Is every call to this member inside a reservation?
 *
 * The shape `this.#evidence.reserve(() => this.#xInternal(...))` — how a
 * method too long to nest inline is made atomic without moving its body. Only
 * credited when EVERY call site has it, so adding a bare second caller breaks
 * the credit rather than inheriting it.
 */
function alwaysCalledInsideAReservation(source: string, name: string): boolean {
  const pattern = new RegExp(`this\\.${name}\\(`, 'g');
  let total = 0;
  let wrapped = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    total += 1;
    if (/#evidence\.reserve\(\s*\(\)\s*=>\s*$/.test(source.slice(Math.max(0, match.index - 80), match.index))) {
      wrapped += 1;
    }
  }
  return total > 0 && wrapped === total;
}

/**
 * The whole-package census: `<file>::<unit>` for every unit that pairs a
 * canonical row write with an evidence append, and whether it is atomic.
 *
 * The three atomicity credits are evaluated PER FILE — a unit is credited by
 * its own file's `atomic(…)` wrapper or by its own file's call sites, never by
 * another file's — so moving a mutation into a new module does not carry a
 * credit with it.
 */
function pairedUnits(): { key: string; atomic: boolean }[] {
  const found: { key: string; atomic: boolean }[] = [];
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    // Cheap rejection first: a file that never reaches the evidence log has no
    // pair in it, and the scan says so by looking rather than by assuming.
    if (!appendsEvidence(source)) continue;
    const relative = path.relative(ROOT, file).split(path.sep).join('/');
    const issued = atomicallyIssued(source);
    for (const [name, body] of unitBodies(source)) {
      if (!writesARow(body) || !appendsEvidence(body)) continue;
      found.push({
        key: `${relative}::${name}`,
        atomic:
          reservesForItself(body) ||
          issued.has(name) ||
          alwaysCalledInsideAReservation(source, name),
      });
    }
  }
  return found;
}

describe('any mutation in the package that writes a row and appends evidence is one transaction', () => {
  it('finds no unit with that shape outside a transaction, ANYWHERE in src/', () => {
    const paired = pairedUnits();
    const bare = paired.filter((unit) => !unit.atomic).map((unit) => unit.key);
    // The derivation has to SEE the mutations, or an empty answer would pass.
    // The floor is the whole-package count measured when round seventeen closed
    // High-1 (42), less a little room for a member being split or renamed.
    expect(paired.length, 'the scan found no write-then-append unit at all').toBeGreaterThanOrEqual(38);
    // Both FILES the class lives in today are represented, so a scan that
    // silently narrowed back to one file fails here rather than passing.
    const filesSeen = new Set(paired.map((unit) => unit.key.split('::')[0]!));
    expect([...filesSeen].sort()).toContain('src/operator/queue.ts');
    expect([...filesSeen].sort()).toContain('src/application/service.ts');
    // The named mutations of all three rounds, queue side and facade side.
    const keys = paired.map((unit) => unit.key);
    for (const named of [
      'src/operator/queue.ts::claim',
      'src/operator/queue.ts::complete',
      'src/operator/queue.ts::fail',
      'src/operator/queue.ts::#approve',
      'src/operator/queue.ts::#enqueue',
      'src/application/service.ts::promoteProposal',
      'src/application/service.ts::rejectProposal',
      'src/application/service.ts::proposeMission',
      'src/application/service.ts::assignTask',
    ]) {
      expect(keys, `${named} pairs a row write with an evidence append`).toContain(named);
    }
    expect(bare, 'a mutation writes a row and appends evidence without a transaction').toEqual([]);
  });

  it('finds no queue member with that shape outside a transaction', () => {
    const source = fs.readFileSync(QUEUE, 'utf8');
    const bodies = memberBodies(source);
    const issued = atomicallyIssued(source);
    const paired: string[] = [];
    const bare: string[] = [];
    for (const [name, body] of bodies) {
      if (!writesARow(body) || !appendsEvidence(body)) continue;
      paired.push(name);
      const atomic =
        /this\.#evidence\.reserve\(/.test(body) ||
        issued.has(name) ||
        alwaysCalledInsideAReservation(source, name);
      if (!atomic) bare.push(name);
    }
    // The derivation has to SEE the mutations, or an empty answer would pass.
    expect(paired.length, 'the scan found no update-then-append member at all').toBeGreaterThanOrEqual(10);
    for (const named of ['claim', 'complete', 'fail', '#approve', '#enqueue']) {
      expect(paired, `${named} pairs a row write with an evidence append`).toContain(named);
    }
    expect(issued.size, 'the atomic wrapper set must be parsed, not empty').toBeGreaterThanOrEqual(9);
    expect(bare, 'a queue mutation writes a row and appends evidence without a transaction').toEqual([]);
  });

  it('the widened scan really would have caught the four the file-scoped one missed', () => {
    // A regression on the DERIVATION, not on the corpus. The corpus is correct
    // now, so a scan that quietly narrowed back to `queue.ts` would still pass
    // the case above; this feeds it the exact pre-fix shape of `promoteProposal`
    // and requires it to be reported.
    const preFix = [
      '  promoteProposal(input: { proposalId: string }): void {',
      "    this.#db.prepare(`UPDATE hq_mission_proposals SET status = 'promoted' WHERE id = ?`).run(1);",
      '    this.#upsertMeta(1, {});',
      "    this.#requirePrivilegedQueue().appendEvidence({ kind: 'mission_promoted_to_task' });",
      '  }',
      '  somethingElse(): void {}',
    ].join('\n');
    const body = unitBodies(preFix).get('promoteProposal')!;
    expect(writesARow(body), 'the pre-fix body writes a canonical row').toBe(true);
    expect(appendsEvidence(body), 'the pre-fix body appends evidence').toBe(true);
    expect(reservesForItself(body), 'and it opens no reservation of its own').toBe(false);
    // And the FIXED shape is credited, so the guard is not simply always-red.
    const fixed = preFix.replace(
      '    this.#upsertMeta(1, {});',
      '    privileged.reserve(() => { this.#upsertMeta(1, {}); });',
    );
    expect(reservesForItself(unitBodies(fixed).get('promoteProposal')!)).toBe(true);
  });

  it('leaves `fail` appending BEFORE it transitions, so ordering still backs the reservation', () => {
    // The one property the round-fifteen review credited `fail` with, kept as
    // defence in depth. Checked positionally in the source, because "it is
    // reserved now" would let a later edit silently reorder it.
    const body = memberBodies(fs.readFileSync(QUEUE, 'utf8')).get('fail')!;
    const append = body.indexOf("kind: 'execution_failed'");
    const transition = body.indexOf("'review_failed'");
    expect(append).toBeGreaterThan(-1);
    expect(transition).toBeGreaterThan(-1);
    expect(append, 'fail must append before it moves the row').toBeLessThan(transition);
  });
});

describe('the abort-trigger attack the review executed', () => {
  /** A live, started claim on the pre-approved side-effect capability. */
  function running(): ReturnType<typeof setupFixture> & { taskId: string; fence: number } {
    const fx = setupFixture();
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { pr: 1 },
        idempotencyKey: 'atomicity-1',
        requestedBy: 'founder',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.openPr));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    return { ...fx, taskId: claimed.id, fence: claimed.fence };
  }

  it('rolls the whole submission back when the evidence append is refused', () => {
    const fx = running();
    fx.db.exec(
      `CREATE TRIGGER abort_submit BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'execution_result_submitted_for_review'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const result = fx.ops.submitResult(fx.taskId, 'claude', fx.fence, { pr: 'https://example.invalid/1' });
    expect(result.ok, 'the submission must be refused').toBe(false);

    // What the review measured BEFORE the fix: status running, review_state
    // PENDING, submitted_by claude, result committed, zero evidence rows.
    const row = fx.db
      .prepare(`SELECT status, review_state, submitted_by, result FROM op_tasks WHERE id = ?`)
      .get(fx.taskId) as { status: string; review_state: string; submitted_by: string | null; result: string | null };
    expect(row.status).toBe('running');
    expect(row.review_state, 'a refused submission must not enter the reviewer queue').toBe('none');
    expect(row.submitted_by).toBeNull();
    expect(row.result, 'the result must not be committed by a submission that failed').toBeNull();
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'execution_result_submitted_for_review'`).get() as {
        n: number;
      }).n,
    ).toBe(0);

    // And the wedge is gone with it: the caller can try again, and the second
    // attempt is refused by the TRIGGER rather than by a `pending` state the
    // first attempt should never have left behind.
    const again = fx.ops.submitResult(fx.taskId, 'claude', fx.fence, { pr: 'https://example.invalid/1' });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.message).toContain('blocked');

    // Removing the trigger, the honest submission still works — the guard must
    // not have become a deadlock.
    fx.db.exec(`DROP TRIGGER abort_submit`);
    const honest = fx.ops.submitResult(fx.taskId, 'claude', fx.fence, { pr: 'https://example.invalid/1' });
    expect(honest.ok, 'a real submission must still land').toBe(true);
    const after = fx.db
      .prepare(`SELECT review_state, submitted_by FROM op_tasks WHERE id = ?`)
      .get(fx.taskId) as { review_state: string; submitted_by: string | null };
    expect(after.review_state).toBe('pending');
    expect(after.submitted_by).toBe('claude');
    fx.db.close();
  });

  it('rolls a failure report back the same way', () => {
    const fx = running();
    fx.db.exec(
      `CREATE TRIGGER abort_fail BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'execution_failed'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const result = fx.ops.failTask(fx.taskId, 'claude', fx.fence, 'the remote refused');
    expect(result.ok).toBe(false);
    const row = fx.db.prepare(`SELECT status FROM op_tasks WHERE id = ?`).get(fx.taskId) as { status: string };
    expect(row.status, 'a refused failure report must not move the task').toBe('running');
    fx.db.exec(`DROP TRIGGER abort_fail`);
    expect(fx.ops.failTask(fx.taskId, 'claude', fx.fence, 'the remote refused').ok).toBe(true);
    fx.db.close();
  });

  it('rolls a CLAIM back when its evidence append is refused, leaving the approval unspent', () => {
    const fx = setupFixture();
    expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { pr: 2 },
        idempotencyKey: 'atomicity-2',
        requestedBy: 'founder',
      }),
    );
    fx.db.exec(
      `CREATE TRIGGER abort_claim BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'claimed'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const claimed = fx.ops.claimNext('claude', CAPS.openPr);
    expect(claimed.ok).toBe(false);
    const row = fx.db
      .prepare(`SELECT status, claimed_by, fence FROM op_tasks LIMIT 1`)
      .get() as { status: string; claimed_by: string | null; fence: number };
    expect(row.status, 'a claim whose audit row was refused never happened').toBe('queued');
    expect(row.claimed_by).toBeNull();
    expect(row.fence, 'and it did not inflate the fencing token either').toBe(0);
    fx.db.close();
  });
});

/**
 * The FACADE half of the same attack (Wave 5 correction round seventeen,
 * High-1) — the four units the widened scan reported, each measured under an
 * abort trigger on exactly its own evidence kind.
 */
describe('the same abort-trigger attack against the facade mutations', () => {
  /** An open proposal on the pre-approved side-effect capability. */
  function withProposal(): ReturnType<typeof setupFixture> & { proposalId: string } {
    const fx = setupFixture();
    const proposal = expectOk(
      fx.ops.proposeMission({
        threadId: 'thread-atomicity',
        capabilityId: CAPS.openPr,
        payload: { pr: 42 },
        idempotencyKey: 'atomicity-promotion',
        proposedBy: 'claude',
      }),
    );
    return { ...fx, proposalId: proposal.id };
  }

  it('rolls the WHOLE promotion back — no task, no promoted row, and no wedge', () => {
    const fx = withProposal();
    fx.db.exec(
      `CREATE TRIGGER abort_promote BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'mission_promoted_to_task'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const result = fx.ops.promoteProposal({ proposalId: fx.proposalId, promotedBy: 'claude' });
    expect(result.ok, 'the promotion must be refused').toBe(false);

    // What the review measured BEFORE the fix: one queued `github.open_pr`
    // task, the proposal `promoted`, zero evidence rows, and the orphan task
    // claimable by a real worker.
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM op_tasks`).get() as { n: number }).n,
      'a refused promotion must leave no executable task behind',
    ).toBe(0);
    expect(
      (fx.db.prepare(`SELECT status FROM hq_mission_proposals WHERE id = ?`).get(fx.proposalId) as {
        status: string;
      }).status,
    ).toBe('proposed');
    expect(
      (fx.db
        .prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = 'mission_promoted_to_task'`)
        .get() as { n: number }).n,
    ).toBe(0);
    // Nothing to claim, because nothing was created.
    expect(fx.ops.claimNext('claude', CAPS.openPr).ok).toBe(false);

    // And the permanent wedge is gone: with the trigger removed the SAME
    // proposal promotes, where before it was stuck at `proposal_not_open`.
    fx.db.exec(`DROP TRIGGER abort_promote`);
    const honest = fx.ops.promoteProposal({ proposalId: fx.proposalId, promotedBy: 'claude' });
    expect(honest.ok, 'the guard must not have become a deadlock').toBe(true);
    fx.db.close();
  });

  it('rolls a REJECTION back, leaving the proposal open rather than closed by nobody', () => {
    const fx = withProposal();
    fx.db.exec(
      `CREATE TRIGGER abort_reject BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'mission_proposal_rejected'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const result = fx.ops.rejectProposal(fx.proposalId, 'founder', 'not now');
    expect(result.ok).toBe(false);
    expect(
      (fx.db.prepare(`SELECT status FROM hq_mission_proposals WHERE id = ?`).get(fx.proposalId) as {
        status: string;
      }).status,
      'a refused rejection must not close the proposal',
    ).toBe('proposed');
    fx.db.exec(`DROP TRIGGER abort_reject`);
    expect(fx.ops.rejectProposal(fx.proposalId, 'founder', 'not now').ok).toBe(true);
    fx.db.close();
  });

  it('rolls a PROPOSAL back, leaving no row an evidence chain cannot account for', () => {
    const fx = setupFixture();
    fx.db.exec(
      `CREATE TRIGGER abort_propose BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'mission_proposed'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const result = fx.ops.proposeMission({
      threadId: 'thread-atomicity',
      capabilityId: CAPS.openPr,
      payload: { pr: 43 },
      proposedBy: 'claude',
    });
    expect(result.ok).toBe(false);
    expect(
      (fx.db.prepare(`SELECT COUNT(*) AS n FROM hq_mission_proposals`).get() as { n: number }).n,
    ).toBe(0);
    fx.db.exec(`DROP TRIGGER abort_propose`);
    expect(
      fx.ops.proposeMission({
        threadId: 'thread-atomicity',
        capabilityId: CAPS.openPr,
        payload: { pr: 43 },
        proposedBy: 'claude',
      }).ok,
    ).toBe(true);
    fx.db.close();
  });

  it('rolls an ASSIGNMENT INTENT back, so no unaudited gate stands at the claim boundary', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.openPr,
        payload: { pr: 44 },
        idempotencyKey: 'atomicity-assign',
        requestedBy: 'founder',
      }),
    );
    fx.db.exec(
      `CREATE TRIGGER abort_assign BEFORE INSERT ON op_evidence
       WHEN NEW.kind = 'assignment_intent_recorded'
       BEGIN SELECT RAISE(ABORT, 'blocked'); END;`,
    );
    const result = fx.ops.assignTask(created.task.id, 'claude', 'founder', 'claude owns this');
    expect(result.ok).toBe(false);
    // `createTask` already left a meta row; what must NOT have landed is the
    // `assigned_worker_id` the claim boundary enforces on.
    expect(
      (
        fx.db
          .prepare(`SELECT assigned_worker_id FROM hq_op_task_meta WHERE task_id = ?`)
          .get(created.task.id) as { assigned_worker_id: string | null } | undefined
      )?.assigned_worker_id ?? null,
      'a refused assignment must leave no intent enforcing a gate nobody audited',
    ).toBeNull();
    fx.db.exec(`DROP TRIGGER abort_assign`);
    expect(fx.ops.assignTask(created.task.id, 'claude', 'founder', 'claude owns this').ok).toBe(true);
    // …and NOW the gate stands, which is what makes the rollback above a real
    // difference rather than a difference in a column nobody reads.
    const wrongWorker = fx.ops.claimNext('jules', CAPS.openPr);
    expect(wrongWorker.ok, 'the audited intent must hold at the claim boundary').toBe(false);
    if (!wrongWorker.ok) expect(wrongWorker.error.code).toBe('assigned_to_other_worker');
    fx.db.close();
  });
});
