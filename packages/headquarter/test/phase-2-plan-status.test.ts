/**
 * The Phase 2 plan must not disagree with itself about what is finished.
 *
 * `PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md` states each stage's status twice: once
 * in the Progress block near the top, which is what a reader skims, and once on
 * the stage's own heading, which is what a reader lands on from a link. Those
 * two drifted: Stage 4's heading said **DONE** while the Progress block six
 * lines into the same file said *"Stages 4–5 — not started"*, and the DONE half
 * presented an unmet review-and-acceptance gate as satisfied (Codex round 20).
 *
 * Which half was wrong matters less than the fact that nothing was checking.
 * This is a documentation file, so nothing compiles it and no test read it —
 * and it is the canonical plan, the document a Founder consults to decide what
 * is left to do. A plan that can quietly claim a stage is finished is a
 * fabricated status report with a longer shelf life than any UI bug on this
 * branch.
 *
 * The property is deliberately narrow: DONE-ness must agree. It does not
 * compare wording, because the two places legitimately say different amounts —
 * the heading carries the detail and the Progress line carries the summary.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const planPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_2_FIRST_CLASS_PRODUCT_PLAN.md',
);

const plan = readFileSync(planPath, 'utf8');

/**
 * "Claims to be finished", by the only marker this document uses.
 *
 * `NOT ACCEPTED`, `becomes DONE when…` and similar must NOT count — a status
 * that says what is still missing is the honest case this guard exists to
 * protect, and matching a bare `DONE` inside it would invert the test.
 */
function claimsDone(line: string): boolean {
  const withoutNegations = line
    .replace(/\bNOT\s+(ACCEPTED|STARTED|DONE|COMPLETE)\b/gi, '')
    .replace(/becomes\s+DONE\s+when/gi, '');
  return /\bDONE\b/.test(withoutNegations);
}

/** `> - **Stage 4 — …` — the Progress block, one line per stage. */
function progressLines(): Map<number, string> {
  const found = new Map<number, string>();
  for (const line of plan.split('\n')) {
    const match = /^>\s*-\s*\*\*Stage\s+(\d+)\b/.exec(line);
    if (match) found.set(Number(match[1]), line);
  }
  return found;
}

/** `### Stage 4 — …` — the stage's own heading. */
function headingLines(): Map<number, string> {
  const found = new Map<number, string>();
  for (const line of plan.split('\n')) {
    const match = /^###\s+Stage\s+(\d+)\b/.exec(line);
    if (match) found.set(Number(match[1]), line);
  }
  return found;
}

describe('the Phase 2 plan states one status per stage', () => {
  it('finds both status lines for every stage the plan defines', () => {
    // A guard that silently matched nothing would pass forever. The plan has
    // six stages, 0..5, and both blocks must name every one of them — if a
    // heading format changes and this stops matching, this assertion is what
    // says so rather than the suite going quietly green.
    const headings = headingLines();
    const progress = progressLines();
    expect([...headings.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...progress.keys()].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('never calls a stage DONE in one place and unfinished in the other', () => {
    const headings = headingLines();
    const progress = progressLines();
    const disagreements: string[] = [];
    for (const [stage, heading] of headings) {
      const summary = progress.get(stage)!;
      if (claimsDone(heading) !== claimsDone(summary)) {
        disagreements.push(
          `Stage ${stage}: heading says ${claimsDone(heading) ? 'DONE' : 'not done'}, ` +
            `Progress block says ${claimsDone(summary) ? 'DONE' : 'not done'}`,
        );
      }
    }
    expect(disagreements, disagreements.join(' | ')).toEqual([]);
  });

  it('reads a status that says what is missing as unfinished, not as DONE', () => {
    // The negation handling above is the part most likely to be wrong in the
    // direction that matters — a guard that read "becomes DONE when a Founder
    // records acceptance" as a DONE claim would force the honest wording out of
    // the document to stay green.
    expect(claimsDone('### Stage 1 — Give HQ its own host — **DONE**')).toBe(true);
    expect(claimsDone('### Stage 4 — Client runtime — **IMPLEMENTED, NOT ACCEPTED**')).toBe(false);
    expect(claimsDone('> - **Stage 5 —** not started.')).toBe(false);
    expect(claimsDone('Stage 4 becomes DONE when a Founder records acceptance')).toBe(false);
  });
});
