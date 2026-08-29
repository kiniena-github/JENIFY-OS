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
 *
 * ## And then the body turned out not to be an identity
 *
 * Codex P1 on `2dc86e8`: the HQ-dispatched issue is authored by the repository
 * OWNER, and an author may edit their own issue body. Wiring the body into every
 * caller made the guard consistent — and still removable with one edit, after
 * which a comment, a label event or a manual dispatch authorised another
 * execution of a single-use Founder approval.
 *
 * The identity therefore gained a DURABLE half, `HQ_DISPATCH_PROVENANCE`, read
 * from the issue's label timeline — a record no repository permission deletes
 * and no body edit touches. It is a second thing every caller must supply, so it
 * is asserted here, over the same directory, for the same reason.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HQ_DISPATCH_LABEL } from '../src/routing/providers.js';

const WORKFLOWS = join(process.cwd(), '..', '..', '.github', 'workflows');

/** Every workflow file that invokes the shared routing decision. */
function routerCallers(): { name: string; body: string }[] {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((name) => ({ name, body: readFileSync(join(WORKFLOWS, name), 'utf8') }))
    .filter((f) => f.body.includes('decide-routing'));
}

describe('the single-use guard cannot be bypassed by a caller that omits its evidence', () => {
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

  it('requires EVERY one of them to supply the DURABLE record too', () => {
    // Issue #224, Codex P1 on `2dc86e8`. `ISSUE_BODY` is not an identity: the
    // HQ-dispatched issue is authored by the repository owner, and an author may
    // edit their own body. Wiring the body into both callers made the guard
    // consistent and still removable with one edit.
    //
    // `HQ_DISPATCH_PROVENANCE` is the durable half — what the caller read out of
    // the issue's label timeline, which body editing cannot reach. Asserted over
    // the directory for the same reason the body is: the class, not the two
    // instances that happen to exist today.
    const missing = routerCallers()
      .filter((c) => !/^\s*HQ_DISPATCH_PROVENANCE:/m.test(c.body))
      .map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it('requires every one of them to OBSERVE it, not just declare the variable', () => {
    // Declaring `HQ_DISPATCH_PROVENANCE:` and never computing it would pass the
    // test above while handing the router an empty string — which the script
    // refuses, so it fails loudly rather than silently. This pins the intended
    // wiring anyway: each caller reads the issue TIMELINE (the record that
    // survives a body edit) and reports a failed read as `unverified`, never as
    // `not_dispatched`.
    for (const caller of routerCallers()) {
      expect(caller.body, `${caller.name} must read the issue timeline`).toContain('/timeline');
      // Tied to the CONSTANT, not to a literal repeated in this test: the label
      // is spelled in YAML, which no type checker reads, so a rename in
      // `routing/providers.ts` would otherwise leave both workflows searching
      // the timeline for a label nothing applies any more — every unit test
      // green, and the guard silently answering `not_dispatched` for every HQ
      // issue.
      expect(caller.body, `${caller.name} must look for the HQ label`).toContain(`HQ_LABEL: ${HQ_DISPATCH_LABEL}`);
      expect(caller.body, `${caller.name} must default to unverified`).toContain('verdict=unverified');
      // The substitution that would quietly restore the defect.
      expect(
        /verdict=not_dispatched\s*$/m.test(caller.body) && !/hits/.test(caller.body),
        `${caller.name} must not report not_dispatched without reading the record`,
      ).toBe(false);
    }
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
