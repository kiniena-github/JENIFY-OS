/**
 * Wave 5, correction round thirteen — Medium 4 and Medium 5: three defences in
 * `operator/evidence.ts` that reached this head with nothing asserting them.
 *
 * A hostile review mutated each one in a scratch copy and ran the whole suite:
 * all 3425 tests stayed green, and each mutation CHANGED the answer HQ gives
 * the Founder. Those are the two properties that together define an unpinned
 * defence.
 *
 *  - **Medium 4** — `return seq` on an unparseable payload, at the point the
 *    walk re-stringifies it. Mutated to `continue`, `verifyEvidenceChain` went
 *    from `3` to `null` and the Founder's assessment went from
 *    `evidence_chain_broken` to CLEAN over a log carrying a row no hash could
 *    ever have been taken over. At this head that is the only detector of that
 *    state at the first assessment.
 *  - **Medium 5** — the `prev_hash` comparison, at BOTH of its sites: the walk
 *    (`verifyEvidenceChain`) and the O(1) corroboration
 *    (`evidenceEntryLinkStands`). A row whose `prev_hash` column is forged
 *    while its `hash` stays correct over the REAL previous hash passes every
 *    other test in both functions, and `evidenceEntryLinkStands` returning
 *    `true` for it would corroborate a verdict-clearing claim — which is
 *    precisely the check round four added.
 *
 * Every plant below goes through the guards the way a raw writer would — drop
 * the trigger, write, put it back — because `op_evidence` is append-only and
 * the whole point is what HQ says about a file somebody else has written.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fileFixture, type FileFixture } from './reliability.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import { evidenceEntryLinkStands, verifyEvidenceChain } from '../src/operator/evidence.js';

/** The chain's zero value, spelled here only to BUILD the forgery. */
const GENESIS = 'genesis';

function findings(observations: readonly { finding: string }[]): string[] {
  return observations.map((observation) => observation.finding);
}

function warm(fx: FileFixture, times = 3): void {
  for (let i = 0; i < times; i += 1) {
    expect(fx.ops.assessHqIntegrity({ requestedBy: 'founder' }).ok).toBe(true);
  }
}

/** Drop this table's guards, write, put them back — the standing residual. */
function throughTheGuards(raw: HqDatabase, write: () => void): void {
  const triggers = raw
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'op_evidence'`)
    .all() as { name: string; sql: string }[];
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
  write();
  for (const trigger of triggers) raw.exec(trigger.sql);
}

/** The one spelling of the chain's hash, rebuilt here to BUILD a forgery. */
function chainHash(previous: string, row: Record<string, unknown>, payloadJson: string): string {
  return createHash('sha256')
    .update(
      [
        previous,
        String(row.id),
        String(row.at),
        (row.task_id as string | null) ?? '',
        String(row.actor),
        String(row.kind),
        payloadJson,
      ].join('|'),
    )
    .digest('hex');
}

function rowAt(raw: HqDatabase, seq: number): Record<string, unknown> {
  return raw.prepare(`SELECT * FROM op_evidence WHERE seq = ?`).get(seq) as Record<string, unknown>;
}

function hashBefore(raw: HqDatabase, seq: number): string {
  const previous = raw
    .prepare(`SELECT hash FROM op_evidence WHERE seq < ? ORDER BY seq DESC LIMIT 1`)
    .get(seq) as { hash: string } | undefined;
  return previous ? previous.hash : GENESIS;
}

/** A seq in the middle of the log, so the plant is neither the head nor the tail. */
function middleSeq(raw: HqDatabase): number {
  const bounds = raw.prepare(`SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM op_evidence`).get() as {
    lo: number;
    hi: number;
  };
  expect(bounds.hi - bounds.lo, 'the fixture must give a log long enough to plant inside').toBeGreaterThan(2);
  return bounds.lo + 1;
}

describe('an entry whose payload cannot be parsed is a BREAK, not a skipped row', () => {
  it('reports that seq, and the Founder assessment says the chain is broken', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const seq = middleSeq(raw);
      const before = verifyEvidenceChain(raw);
      expect(before, 'the log must be sound before the plant').toBeNull();

      throughTheGuards(raw, () => {
        raw.prepare(`UPDATE op_evidence SET payload = ? WHERE seq = ?`).run('not json at all', seq);
      });

      // The exact answer, not merely "some break": this is what makes the
      // mutation to `continue` — which returns `null` on this same file —
      // visible.
      expect(verifyEvidenceChain(raw)).toBe(seq);
      // And nothing about the row's SHAPE is missing: the guards are back, the
      // row count did not move, so the walk is the only thing that can see it.
      expect(
        (raw.prepare(`SELECT COUNT(*) AS n FROM op_evidence`).get() as { n: number }).n,
      ).toBeGreaterThan(seq);
      raw.close();

      const process = fx.reopen('after-unparseable');
      const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(findings(assessed.data.observations)).toContain('evidence_chain_broken');
      process.db.close();
    } finally {
      fx.cleanup();
    }
  });

  /** No false alarm: a payload that parses to the same value verifies clean. */
  it('does not report a row whose stored payload merely differs in whitespace', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const seq = middleSeq(raw);
      const stored = String(rowAt(raw, seq).payload);
      const respaced = JSON.stringify(JSON.parse(stored), null, 2);
      expect(respaced).not.toBe(stored);
      throughTheGuards(raw, () => {
        raw.prepare(`UPDATE op_evidence SET payload = ? WHERE seq = ?`).run(respaced, seq);
      });
      expect(verifyEvidenceChain(raw), 'the walk re-stringifies before hashing').toBeNull();
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});

describe('a forged prev_hash is caught at BOTH sites, with the row’s own hash correct', () => {
  /**
   * The plant: rewrite `prev_hash` to a value that is not the previous entry's
   * hash, and leave `hash` exactly as it was — so it is still correct over the
   * REAL previous hash. Every other check in both functions passes on it.
   */
  function plantForgedPrevHash(raw: HqDatabase, seq: number): void {
    const row = rowAt(raw, seq);
    const real = hashBefore(raw, seq);
    expect(row.prev_hash, 'the plant must start from a sound row').toBe(real);
    const payloadJson = JSON.stringify(JSON.parse(String(row.payload)));
    expect(row.hash, 'and its own hash must be correct over the real previous').toBe(
      chainHash(real, row, payloadJson),
    );
    const forged = createHash('sha256').update('a hash of something else entirely').digest('hex');
    expect(forged).not.toBe(real);
    throughTheGuards(raw, () => {
      raw.prepare(`UPDATE op_evidence SET prev_hash = ? WHERE seq = ?`).run(forged, seq);
    });
    // The row's OWN hash is untouched and still correct over the real previous
    // hash, which is what makes `row.hash === expected` true inside the walk.
    expect(rowAt(raw, seq).hash).toBe(row.hash);
  }

  it('makes verifyEvidenceChain report that seq', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const seq = middleSeq(raw);
      expect(verifyEvidenceChain(raw)).toBeNull();
      plantForgedPrevHash(raw, seq);
      expect(verifyEvidenceChain(raw)).toBe(seq);
      raw.close();

      const process = fx.reopen('after-forged-prev');
      const assessed = process.ops.assessHqIntegrity({ requestedBy: 'founder' });
      expect(assessed.ok).toBe(true);
      if (!assessed.ok) throw new Error('unreachable');
      expect(assessed.data.safeMode).toBe(true);
      expect(findings(assessed.data.observations)).toContain('evidence_chain_broken');
      process.db.close();
    } finally {
      fx.cleanup();
    }
  });

  it('makes evidenceEntryLinkStands answer false, so it cannot corroborate a clearing claim', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      fx.db.close();
      const raw = fx.raw();
      const seq = middleSeq(raw);
      expect(evidenceEntryLinkStands(raw, seq), 'sound before the plant').toBe(true);
      plantForgedPrevHash(raw, seq);
      expect(
        evidenceEntryLinkStands(raw, seq),
        'a row that does not link to its predecessor is not part of the chain',
      ).toBe(false);
      // Its neighbours are untouched, so the answer is about THIS row rather
      // than about the log having become unreadable.
      expect(evidenceEntryLinkStands(raw, seq - 1)).toBe(true);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });

  /** And the same function still says true of every genuine row. */
  it('answers true for every entry of an untouched log', () => {
    const fx = fileFixture();
    try {
      warm(fx);
      const raw = fx.raw();
      const seqs = (raw.prepare(`SELECT seq FROM op_evidence ORDER BY seq`).all() as { seq: number }[]).map(
        (row) => row.seq,
      );
      expect(seqs.length).toBeGreaterThan(3);
      for (const seq of seqs) expect(evidenceEntryLinkStands(raw, seq), `seq ${seq}`).toBe(true);
      raw.close();
    } finally {
      fx.cleanup();
    }
  });
});
