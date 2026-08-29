/**
 * Every workflow that calls the shared router must hand it the issue body
 * (issue #224, Codex P1 on `0961cde`).
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
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(process.cwd(), '..', '..', '.github', 'workflows');

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
