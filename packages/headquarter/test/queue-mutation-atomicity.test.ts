/**
 * Every queue mutation that pairs a row write with a hash-chained evidence
 * append runs in ONE transaction — derived from the shape, not from a list
 * (Wave 5 correction round sixteen, High B-4).
 *
 * ## What was open
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
 *  1. A DERIVED SHAPE GUARD. Every member of `OperatorQueue` — public and
 *     `#private`, parsed out of the class body — whose own text contains BOTH a
 *     row write (an `INSERT`/`UPDATE`/`DELETE` statement, a `#transition` or a
 *     `#recordEvent`) AND an `#evidence.append` must be atomic. Three ways to
 *     be atomic are accepted and all three are derived from the source: the
 *     body reserves for itself; the method is handed out through the
 *     constructor's `atomic(…)` wrapper (that set is parsed out of the
 *     `grantPrivileged` block, not typed here); or every call to it in the file
 *     is itself inside a reservation. A method added in a future phase with
 *     that shape and none of those three fails on the day it is written.
 *
 *  2. The BEHAVIOURAL proof, by the same abort-trigger attack the review used,
 *     against the two mutations the review named: `complete` (which failed) and
 *     `fail` (which passed by ORDERING — it appends first — and is now reserved
 *     as well, because ordering is not a property a later edit preserves).
 *
 * ## What this does not claim
 *
 * The shape guard is a lexical scan. It cannot tell that a reservation
 * ENCLOSES the pair rather than merely appearing somewhere in the method, and
 * it does not follow calls into helpers that write on the method's behalf. It
 * is a floor: it makes the `complete` defect impossible to reintroduce
 * silently, and it is not a proof of serializability. The behavioural half is
 * what proves the enclosure for the mutations it covers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(HERE, '..', 'src', 'operator', 'queue.ts');

/**
 * Members of `OperatorQueue`, public and `#private`, each with its own text.
 *
 * Sliced from one member declaration to the next, which is the same technique
 * `unauthenticated-founder-text.test.ts` uses on the facade. Derived, so a
 * member added in a future phase is scanned without being named.
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

/** Does this text write a canonical row? */
function writesARow(body: string): boolean {
  return (
    /\.prepare\(\s*`?\s*(?:INSERT|UPDATE|DELETE)/i.test(body) ||
    /this\.#transition\(/.test(body) ||
    /this\.#recordEvent\(/.test(body)
  );
}

/** Does this text append to the hash-chained evidence log? */
function appendsEvidence(body: string): boolean {
  return /this\.#evidence\.append\(/.test(body);
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

describe('a queue mutation that writes a row and appends evidence is one transaction', () => {
  it('finds no member with that shape outside a transaction', () => {
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
