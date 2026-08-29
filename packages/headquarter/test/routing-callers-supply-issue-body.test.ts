/**
 * Every workflow that calls the shared router must hand it the inputs the
 * single-use guard runs on: the issue body (issue #224, Codex P1 on `0961cde`)
 * and, since `2dc86e8`, the DURABLE HQ-dispatch verdict that replaced it as the
 * authority.
 *
 * ## The defect
 *
 * The single-use guard added in `869bfdf` refuses re-triggering an
 * HQ-dispatched issue — but only if `decideRouting` can SEE the issue body. The
 * body arrives as an environment variable each workflow sets for itself, and
 * `ISSUE_BODY` was wired into `ai-task-trigger.yml` alone.
 *
 * `ai-task-gemini.yml` calls the same `decide-routing.ts`. It saw an empty body,
 * missed the guard entirely, and routed: an owner commenting
 * `<!-- jenify-run: GEMINI -->` on an HQ-dispatched CLAUDE issue got a second
 * execution AND a provider substitution, through the one workflow the guard had
 * not been wired into.
 *
 * ## Why this test exists rather than just the fix
 *
 * Wiring both callers fixes today. It does not stop the third workflow, added
 * later by someone who has never read this file, from calling the router without
 * a body and silently reopening the same hole — with every existing test green,
 * because the guard's unit tests pass the body directly.
 *
 * This is the fourth defect of this exact shape in issue #224: a guard that was
 * correct where it was wired and absent where it was not. So the rule is
 * asserted over the WORKFLOW DIRECTORY rather than over the two files that
 * happen to exist — the class, not the instance.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HQ_DISPATCH_MARKER } from '../src/routing/providers.js';

// Resolved from THIS FILE, not `process.cwd()`. The suite is normally run from
// `packages/headquarter`, but `vitest` invoked at the repository root would
// otherwise look for `.github/` two levels above the root and report twelve
// failures for a guard that is intact — a false alarm on the one test whose
// whole job is to be believed.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');
const EVIDENCE_ACTION = join(REPO_ROOT, '.github', 'actions', 'hq-dispatch-evidence', 'action.yml');

/** Every workflow file that invokes the shared routing decision. */
function routerCallers(): { name: string; body: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((name) => ({ name, body: readFileSync(join(WORKFLOWS, name), 'utf8') }))
    .filter((f) => f.body.includes('decide-routing'));
}

describe('the single-use guard cannot be bypassed by a caller that omits the body', () => {
  it('finds the workflows that call the shared router', () => {
    // Guards the guard: if the invocation is ever renamed, this test would
    // otherwise pass vacuously by finding nothing to check.
    const callers = routerCallers();
    expect(callers.length).toBeGreaterThanOrEqual(2);
    expect(callers.map((c) => c.name).sort()).toContain('ai-task-trigger.yml');
    expect(callers.map((c) => c.name).sort()).toContain('ai-task-gemini.yml');
  });

  it('requires EVERY one of them to supply ISSUE_BODY', () => {
    const missing = routerCallers()
      .filter((c) => !/^\s*ISSUE_BODY:/m.test(c.body))
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it('requires every one of them to supply it for MANUAL dispatch too', () => {
    // The comment path and the manual path are separate sources. A workflow that
    // resolves an issue by number for `workflow_dispatch` has no
    // `github.event.issue.body`, so it must fetch the body itself — otherwise the
    // guard is live for comments and blind for manual runs.
    const missing = routerCallers()
      .filter((c) => c.body.includes('workflow_dispatch'))
      .filter((c) => !c.body.includes('DISPATCH_BODY'))
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });
});

/**
 * The DURABLE half of the same guard (issue #224, Codex P1 on `2dc86e8`).
 *
 * The body is erasable by the repository owner, so it cannot be the authority
 * for a rule that constrains the repository owner. The authority is a verdict
 * derived from GitHub's immutable issue edit history, and — exactly as with
 * `ISSUE_BODY` one round earlier — it is worth nothing in the lane that forgot
 * to wire it. So it is asserted over the workflow directory, and over the ONE
 * shared implementation every lane must call rather than copy.
 */
describe('every router caller resolves the durable HQ-dispatch fact', () => {
  it('requires EVERY one of them to supply HQ_DISPATCH_EVIDENCE', () => {
    const missing = routerCallers()
      .filter((c) => !/^\s*HQ_DISPATCH_EVIDENCE:/m.test(c.body))
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it('requires each to take it from the SHARED action, not a hand-rolled copy', () => {
    // A per-workflow copy is how the previous four defects of this shape
    // happened: the derivation drifts in one lane and nobody notices, because
    // each lane's own tests still pass.
    const wrong = routerCallers()
      .filter(
        (c) =>
          !c.body.includes('uses: ./.github/actions/hq-dispatch-evidence') ||
          !c.body.includes('HQ_DISPATCH_EVIDENCE: ${{ steps.hq_evidence.outputs.evidence }}') ||
          !/^\s*id: hq_evidence$/m.test(c.body),
      )
      .map((c) => c.name);
    expect(wrong).toEqual([]);
  });

  it('requires each to resolve it for the manual path as well as the event path', () => {
    // `github.event.issue.number` is empty on `workflow_dispatch`. A lane that
    // passed only that would resolve `unknown` for every manual run — which
    // fails closed, but by accident rather than by design, and it would silently
    // disable the manual lane instead of guarding it.
    const missing = routerCallers()
      .filter((c) => c.body.includes('workflow_dispatch'))
      .filter((c) => !c.body.includes('issue-number: ${{ github.event.issue.number || inputs.issue_number }}'))
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });
});

describe('the shared resolver derives the fact from something the owner cannot erase', () => {
  const action = (): string => readFileSync(EVIDENCE_ACTION, 'utf8');

  it('reads GitHub’s immutable issue edit history', () => {
    // The whole correction in one assertion: if this ever reduces to reading
    // the current body, the guard is erasable again by the only actor that can
    // trigger the workflow.
    expect(action()).toContain('userContentEdits');
  });

  it('looks for the same marker the routing module knows', () => {
    // The shell cannot import the TypeScript constant, so the literal is
    // duplicated. This is what stops the two drifting apart into a resolver
    // that always answers `never_dispatched`.
    expect(action()).toContain(`marker='${HQ_DISPATCH_MARKER}'`);
  });

  it('defaults to unknown and normalises anything else to unknown', () => {
    const body = action();
    expect(body).toContain('verdict=unknown');
    // The final normalisation: only the three known verdicts survive.
    expect(body).toMatch(/case "\$verdict" in\s*\n\s*dispatched\|never_dispatched\|unknown\) ;;\s*\n\s*\*\) verdict=unknown ;;/);
  });

  it('also reads the issue label timeline, so an illegible edit history is not the only source', () => {
    // The edit history is immutable but not always LEGIBLE: `diff` comes back
    // null for a revision whose content was deleted and for a token that cannot
    // see it, and the rule above correctly calls that `unknown`. Safe — and it
    // would also permanently freeze re-triggering for an ORDINARY task whose
    // body happens to have been edited once.
    //
    // HQ therefore stamps every issue it dispatches with the same string as a
    // LABEL (`providers/claude/dispatch.ts`), and a label event is an
    // undeletable timeline entry read over plain REST, with no diff and no
    // visibility caveat.
    const body = action();
    expect(body).toContain('/timeline');
    expect(body).toContain('.label.name == $m');
  });

  it('lets the label source only TIGHTEN the verdict, never clear one', () => {
    // The asymmetry is the correctness argument. The label PRESENT proves HQ
    // dispatched the issue; the label ABSENT proves nothing, because an issue
    // dispatched before HQ stamped one has no label event. So this source may
    // set `dispatched` and must never set `never_dispatched` — and a failed read
    // of it must leave a verdict the edit history proved alone.
    const body = action();
    const from = body.indexOf('SECOND DURABLE SOURCE');
    const to = body.indexOf('Anything the pipeline did not produce cleanly');
    expect(from, 'the label-timeline block must be identifiable').toBeGreaterThan(-1);
    expect(to, 'the final normalisation must follow it').toBeGreaterThan(from);
    const timelineBlock = body.slice(from, to);
    expect(timelineBlock).toContain('verdict=dispatched');
    expect(timelineBlock).not.toContain('verdict=never_dispatched');
    expect(timelineBlock).not.toContain('verdict=unknown');
  });

  it('does not let a failed lookup crash the job instead of failing closed', () => {
    // `set -e` here would abort the step, the workflow would fail, and nobody
    // would learn whether the issue was HQ-dispatched. The guard has to REACH
    // the routing module with `unknown`.
    const body = action();
    expect(body).toContain('set -uo pipefail');
    expect(body).not.toContain('set -e');
  });
});
