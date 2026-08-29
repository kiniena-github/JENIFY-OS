/**
 * The HQ-dispatch identity survives an edited issue body (issue #224, Codex P1
 * on `2dc86e8`, review thread `PRRT_kwDOUDYLvM6dch4q`).
 *
 * ## The defect
 *
 * `hq-dispatched-issue-retrigger.test.ts` proves that an HQ-dispatched issue is
 * not re-triggerable. It proved it against a marker in the issue BODY — and the
 * HQ-created issue is authored by the repository OWNER, the same authorized
 * actor the single-use boundary exists to bind. That actor may edit their own
 * issue body.
 *
 * So the whole guard came off with one edit: remove the marker, then comment,
 * re-label, or fire `workflow_dispatch`. `hqDispatched` went false, the router
 * treated the issue as ordinary, and authorized another execution with no fresh
 * HQ claim, no fresh approval and no fence — and `<!-- jenify-run: GEMINI -->`
 * substituted a provider on a CLAUDE-bound canonical task through the one door
 * that never checks the binding.
 *
 * ## The fix these tests pin
 *
 * The identity now has a DURABLE half that issue-body editing cannot reach: the
 * `jenify-hq-dispatch` LABEL, applied by the dispatch adapter when it opens the
 * issue. Applying a label writes an issue-timeline entry no repository
 * permission can delete; removing the label only appends `unlabeled` beside it.
 * The workflows read that timeline and hand the router a three-valued
 * observation, and the router refuses a re-trigger it cannot verify rather than
 * falling back to the surface the guarded actor controls.
 *
 * Every case below therefore runs with a body that has been WIPED CLEAN of HQ's
 * marker. If any of them routes, the P1 is back.
 */

import { describe, expect, it } from 'vitest';
import { decideRouting, type HqDispatchProvenance, type RoutingRequest } from '../src/routing/route.js';
import { HQ_DISPATCH_LABEL, HQ_DISPATCH_MARKER } from '../src/routing/providers.js';

const OWNER = 'kiniena-github';
const CONNECTED = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present', GEMINI_API_KEY: 'present' };

/** Every trigger the shared router can be reached through. */
const EVERY_TRIGGER: RoutingRequest['trigger'][] = [
  'issue_opened',
  'issue_labeled',
  'issue_comment',
  'manual_dispatch',
];

const RETRIGGERS = EVERY_TRIGGER.filter((t) => t !== 'issue_opened');

/**
 * Bodies an owner could plausibly leave behind after "removing the HQ marker".
 * Not one hostile string but the class: deleted, reworded, and — the sharpest —
 * a body that still LOOKS canonical while the machine-readable marker is subtly
 * broken, which a substring check reads as an ordinary issue.
 */
const EDITED_BODIES: Record<string, string> = {
  'marker deleted outright': 'Please redo this task.\n\n## Instruction\n\nDraft the Q3 maintenance plan.',
  'body emptied': '',
  'marker reworded into prose': 'This was once a jenify hq dispatch issue, but no longer says so in HTML.',
  'marker subtly broken': '<!-- jenify-hq-dispatchh: task-1 -->\n\n## Instruction\n\nDraft the plan.',
  'marker replaced with a lookalike': '<!-- jenify-hq-dispatched: task-1 -->\n\n## Instruction\n\nDraft the plan.',
};

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    trigger: 'issue_comment',
    issueTitle: '[AI TASK][CLAUDE][BUILDER] HQ order task-1',
    actorLogin: OWNER,
    issueAuthorLogin: OWNER,
    repositoryOwner: OWNER,
    commentBody: '<!-- jenify-run -->',
    // The body is edited clean in every case here. The durable record is the
    // only thing left that can answer the question.
    issueBody: EDITED_BODIES['marker deleted outright'],
    hqDispatchProvenance: 'dispatched' as HqDispatchProvenance,
    secrets: CONNECTED,
    ...overrides,
  };
}

describe('an edited issue body does not erase the HQ-dispatch identity', () => {
  it('refuses a comment re-trigger', () => {
    const decision = decideRouting(request());
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
    expect(decision.reason).toContain('JENIFY HQ');
  });

  it('refuses a label re-trigger', () => {
    const decision = decideRouting(request({ trigger: 'issue_labeled', commentBody: undefined }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
  });

  it('refuses a manual workflow dispatch', () => {
    const decision = decideRouting(request({ trigger: 'manual_dispatch', commentBody: undefined }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
  });

  it('refuses a provider-override attempt, for every provider a directive can name', () => {
    // The sharper half of the P1: the comment directive is the one door that
    // never checked the canonical provider binding, so `jenify-run: GEMINI` on a
    // CLAUDE-bound task would have run a different vendor against a Founder
    // approval bound to CLAUDE.
    for (const directive of ['GEMINI', 'CLAUDE', 'BOTH', 'CODEX', 'gemini, claude']) {
      const decision = decideRouting(request({ commentBody: `<!-- jenify-run: ${directive} -->` }));
      expect(decision.outcome, directive).toBe('IGNORE');
      expect(decision.dispatchTo, directive).toEqual([]);
    }
  });

  it('refuses every trigger that is not the dispatch itself, whatever the body says', () => {
    // Stated over the trigger SET rather than the four cases above, so a
    // `TriggerKind` added later is refused by default instead of becoming a
    // fifth door.
    for (const [label, issueBody] of Object.entries(EDITED_BODIES)) {
      const routed = EVERY_TRIGGER.filter(
        (trigger) =>
          decideRouting(request({ trigger, issueBody, commentBody: '<!-- jenify-run -->' })).outcome === 'ROUTE',
      );
      expect(routed, label).toEqual(['issue_opened']);
    }
  });

  it('is not defeated by removing the label afterwards, because the timeline keeps the event', () => {
    // The durable record is the issue's label TIMELINE, not the label's current
    // presence — an `unlabeled` entry is appended beside the `labeled` one
    // rather than replacing it. The workflow reports `dispatched` for either, so
    // what this asserts at the router is that the router asks no further
    // question: a `dispatched` observation is sufficient on its own.
    const decision = decideRouting(request({ issueBody: '', hqDispatchProvenance: 'dispatched' }));
    expect(decision.outcome).toBe('IGNORE');
  });
});

describe('a record that could not be read is not a record that says no', () => {
  it('refuses every re-trigger while the durable record is unreadable', () => {
    for (const trigger of RETRIGGERS) {
      const decision = decideRouting(
        request({ trigger, issueBody: 'edited clean', hqDispatchProvenance: 'unverified' }),
      );
      expect(decision.outcome, trigger).toBe('BLOCKED');
      expect(decision.dispatchTo, trigger).toEqual([]);
    }
  });

  it('says which of the two refusals it is', () => {
    // An operator must be able to tell "this is an HQ task" from "I could not
    // check", because only the second is fixed by retrying.
    const unverified = decideRouting(request({ issueBody: 'edited clean', hqDispatchProvenance: 'unverified' }));
    expect(unverified.reason).toContain('could not be read');
    expect(unverified.reason).not.toContain('was dispatched by JENIFY HQ');
  });

  it('still lets a NEW task be opened while the record is unreadable', () => {
    // Fail-closed on the guarded act, not on the whole lane. A timeline read
    // that fails must not stop the Founder opening ordinary AI tasks.
    const decision = decideRouting(
      request({ trigger: 'issue_opened', commentBody: undefined, issueBody: 'A human wrote this.', hqDispatchProvenance: 'unverified' }),
    );
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toContain('CLAUDE');
  });

  it('does not let an unreadable record be reported as a clean "no"', () => {
    // The one substitution that would quietly restore the defect: a workflow
    // that swallows a failed timeline read and reports `not_dispatched`. Pinned
    // here as a behavioural difference so the two values can never be
    // interchanged without this failing.
    const unverified = decideRouting(request({ issueBody: 'edited clean', hqDispatchProvenance: 'unverified' }));
    const negative = decideRouting(request({ issueBody: 'edited clean', hqDispatchProvenance: 'not_dispatched' }));
    expect(unverified.outcome).toBe('BLOCKED');
    expect(negative.outcome).toBe('ROUTE');
  });
});

describe('the guard stays narrow', () => {
  it('leaves an ordinary AI task routing exactly as before, on every trigger', () => {
    for (const trigger of EVERY_TRIGGER) {
      const decision = decideRouting(
        request({
          trigger,
          issueBody: 'A human opened this by hand.',
          hqDispatchProvenance: 'not_dispatched',
          commentBody: '<!-- jenify-run -->',
        }),
      );
      expect(decision.outcome, trigger).toBe('ROUTE');
      expect(decision.dispatchTo, trigger).toContain('CLAUDE');
    }
  });

  it('leaves an ordinary provider override working', () => {
    const decision = decideRouting(
      request({
        issueBody: 'A human opened this by hand.',
        hqDispatchProvenance: 'not_dispatched',
        commentBody: '<!-- jenify-run: GEMINI -->',
      }),
    );
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toEqual(['GEMINI']);
  });

  it('keeps the body marker working on its own, for issues opened before the label existed', () => {
    // The two sources are a UNION, not a replacement. An HQ issue dispatched
    // before this fix carries no label event, so dropping the body check would
    // have silently un-guarded every issue already in flight.
    const decision = decideRouting({
      ...request(),
      issueBody: `<!-- ${HQ_DISPATCH_MARKER}: task-1 -->\n\nInstruction.`,
      hqDispatchProvenance: 'not_dispatched',
    });
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.reason).toContain('JENIFY HQ');
  });

  it('keeps the pre-existing authorization rules ahead of it', () => {
    // A non-owner commenter is refused for that reason, HQ issue or not — the
    // durable record must not become a way to reach a later rule first.
    expect(decideRouting(request({ actorLogin: 'someone-else' })).outcome).toBe('IGNORE');
    expect(decideRouting(request({ issueAuthorLogin: 'someone-else' })).outcome).toBe('IGNORE');
    expect(decideRouting(request({ actorIsBot: true })).outcome).toBe('IGNORE');
    expect(decideRouting(request({ issueTitle: 'not an ai task' })).outcome).toBe('IGNORE');
  });

  it('keeps today’s behaviour for a caller that supplies no observation at all', () => {
    // `undefined` means "this caller did not look", and the pure function stays
    // composable for it — the same contract `issueBody` already has. Real
    // callers cannot be in that state: `.github/scripts/decide-routing.ts`
    // refuses to run without the value, and
    // `routing-callers-supply-issue-body.test.ts` asserts every workflow
    // supplies it.
    const decision = decideRouting(request({ issueBody: 'plain', hqDispatchProvenance: undefined }));
    expect(decision.outcome).toBe('ROUTE');
  });
});

describe('the durable identity has one spelling', () => {
  it('uses the same string as the body marker', () => {
    // A second name for the same fact is how the body check and the label check
    // would drift apart, and a drifted guard is one that recognises HQ's issues
    // on one path and not the other.
    expect(HQ_DISPATCH_LABEL).toBe(HQ_DISPATCH_MARKER);
  });
});
