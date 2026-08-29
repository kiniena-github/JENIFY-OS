/**
 * An HQ-dispatched issue is not re-triggerable from the workflow (issue #224,
 * Codex P1 on `2638796`).
 *
 * ## The defect
 *
 * HQ's dispatch adapter publishes an ordinary `[AI TASK]` issue, so once it
 * exists `ai-task-trigger.yml` keeps accepting owner `jenify-run` comments and
 * manual dispatches for it — indefinitely. Every one of those starts work that
 * never passes through the boundary this whole lane exists to enforce: the
 * canonical claim, the single-use approval, the fence, the dispatch history.
 * One Founder approval could therefore authorise an unbounded number of
 * sequential executions.
 *
 * And a comment directive may NAME a provider, so `jenify-run: GEMINI` on a
 * CLAUDE-bound canonical task is provider substitution arriving through the one
 * door that never checked the binding.
 *
 * There is a THIRD door, which the first version of this guard left open: the
 * workflow also wakes on `issues: labeled`, so removing and re-adding the
 * `ai-task` label re-fired the routine on an HQ-dispatched issue just as a
 * comment did. The guard is now stated as ALLOW `issue_opened` rather than as a
 * list of denied triggers, and that shape is itself asserted below.
 *
 * ## What is asserted
 *
 * Re-triggers of an HQ-dispatched issue are refused; the dispatch itself is
 * untouched; and an ordinary (non-HQ) AI task keeps working exactly as before,
 * so the guard is narrow rather than a general freeze on re-triggering.
 */

import { describe, expect, it } from 'vitest';
import { decideRouting, parseHqDispatchEvidence, type RoutingRequest } from '../src/routing/route.js';
import { HQ_DISPATCH_MARKER } from '../src/routing/providers.js';

const OWNER = 'kiniena-github';
const CONNECTED = { CLAUDE_ROUTINE_URL: 'present', CLAUDE_ROUTINE_TOKEN: 'present', GEMINI_API_KEY: 'present' };

/** A body as `renderDispatchIssue` produces it: HQ's marker is in it. */
const HQ_BODY = [
  `<!-- ${HQ_DISPATCH_MARKER}: task-1 -->`,
  '',
  '## Instruction',
  '',
  'Draft the Q3 maintenance plan.',
].join('\n');

const PLAIN_BODY = 'A human opened this by hand and wrote an instruction.';

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    trigger: 'issue_comment',
    issueTitle: '[AI TASK][CLAUDE][BUILDER] HQ order task-1',
    actorLogin: OWNER,
    issueAuthorLogin: OWNER,
    repositoryOwner: OWNER,
    commentBody: '<!-- jenify-run -->',
    issueBody: HQ_BODY,
    // The realistic HQ case: the marker is in the body AND the issue's
    // immutable edit history agrees. The tests below separate the two.
    hqDispatchEvidence: 'dispatched',
    secrets: CONNECTED,
    ...overrides,
  };
}

/** An ordinary AI task: no marker, and the edit history proves there never was one. */
const ORDINARY = { issueBody: PLAIN_BODY, hqDispatchEvidence: 'never_dispatched' } as const;

describe('a re-trigger of an HQ-dispatched issue is refused', () => {
  it('ignores an owner jenify-run comment on it', () => {
    const decision = decideRouting(request());
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
    expect(decision.reason).toContain('JENIFY HQ');
  });

  it('ignores a manual workflow dispatch of it', () => {
    const decision = decideRouting(request({ trigger: 'manual_dispatch', commentBody: undefined }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
  });

  it('refuses a comment directive that tries to SUBSTITUTE the provider', () => {
    // The sharper half: `jenify-run: GEMINI` on a CLAUDE-bound canonical task
    // would have run a different vendor's worker against a Founder approval
    // bound to CLAUDE — through the one door that never checked the binding.
    const decision = decideRouting(request({ commentBody: '<!-- jenify-run: GEMINI -->' }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
  });

  it('ignores a LABEL event on it', () => {
    // The door the first version of this guard left open. `ai-task-trigger.yml`
    // wakes on `issues: [opened, labeled]`, so the owner removing and re-adding
    // the `ai-task` label re-fires the routine on an HQ-dispatched issue —
    // unbounded sequential executions of one Founder-approved action, exactly
    // the P1, arriving through a third door rather than the two Codex named.
    // Before the fix this asserted ROUTE / ['CLAUDE'].
    const decision = decideRouting(request({ trigger: 'issue_labeled', commentBody: undefined }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
    expect(decision.reason).toContain('JENIFY HQ');
  });

  it('refuses every trigger that is not the dispatch itself', () => {
    // The rule is ALLOW `issue_opened`, not DENY a list — so a TriggerKind added
    // later is refused on an HQ issue by default instead of silently becoming a
    // fourth door. This test fails if the guard is ever rewritten as an
    // enumeration that misses one.
    const everyTrigger: RoutingRequest['trigger'][] = [
      'issue_opened',
      'issue_labeled',
      'issue_comment',
      'manual_dispatch',
    ];
    const routed = everyTrigger.filter(
      (trigger) => decideRouting(request({ trigger })).outcome === 'ROUTE',
    );
    expect(routed).toEqual(['issue_opened']);
  });

  it('does not fire for the dispatch itself', () => {
    // `opened` IS the dispatch — the one run HQ authorised. Refusing it would
    // break the lane rather than guard it.
    const decision = decideRouting(request({ trigger: 'issue_opened', commentBody: undefined }));
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toContain('CLAUDE');
  });
});

describe('the guard is narrow', () => {
  it('leaves an ordinary AI task fully re-triggerable', () => {
    const decision = decideRouting(request(ORDINARY));
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toContain('CLAUDE');
  });

  it('leaves an ordinary AI task label event working', () => {
    // Widening the guard to every non-`opened` trigger must not freeze the
    // label path for issues a human opened by hand.
    const decision = decideRouting(
      request({ ...ORDINARY, trigger: 'issue_labeled', commentBody: undefined }),
    );
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toContain('CLAUDE');
  });

  it('still refuses a non-owner commenter, HQ issue or not', () => {
    // The pre-existing rule is unchanged and still checked first.
    expect(decideRouting(request({ ...ORDINARY, actorLogin: 'someone-else' })).outcome).toBe('IGNORE');
    expect(decideRouting(request({ actorLogin: 'someone-else' })).outcome).toBe('IGNORE');
  });
});

// ===========================================================================
// The DURABLE fact (Codex P1 on `2dc86e8`)
// ===========================================================================

/**
 * The correction this block exists for.
 *
 * The guard above originally read HQ's marker out of the issue's CURRENT body,
 * and an issue body is editable — by the repository owner, which is the only
 * account allowed to trigger this workflow at all. So the guard was erasable by
 * exactly the actor it constrains: delete the marker, comment
 * `jenify-run: GEMINI`, and both the unbounded re-execution and the provider
 * substitution come straight back.
 *
 * The authority is now a caller-resolved verdict derived from GitHub's
 * immutable issue edit history, which retains every earlier version of the
 * body. The current-body marker survives only as compatibility evidence.
 */
describe('editing the body cannot reopen an HQ-dispatched issue', () => {
  /** The attack: the marker deleted from the body, the history still holding it. */
  const ERASED = { issueBody: PLAIN_BODY, hqDispatchEvidence: 'dispatched' } as const;

  it('refuses a re-trigger when the marker was edited out of the body', () => {
    const decision = decideRouting(request(ERASED));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
    expect(decision.reason).toContain('edit history');
  });

  it('refuses the erased-marker attack through EVERY non-dispatch trigger', () => {
    const everyTrigger: RoutingRequest['trigger'][] = [
      'issue_opened',
      'issue_labeled',
      'issue_comment',
      'manual_dispatch',
    ];
    const routed = everyTrigger.filter(
      (trigger) => decideRouting(request({ ...ERASED, trigger })).outcome === 'ROUTE',
    );
    expect(routed).toEqual(['issue_opened']);
  });

  it('refuses the PROVIDER SUBSTITUTION the erased marker was hiding', () => {
    // The sharper half of the attack: an erased marker plus a directive naming
    // a different vendor ran GEMINI against a CLAUDE-bound Founder approval.
    const decision = decideRouting(
      request({ ...ERASED, commentBody: '<!-- jenify-run: GEMINI -->' }),
    );
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
  });
});

describe('an unestablished durable answer fails closed', () => {
  it('refuses when the lookup could not be established', () => {
    const decision = decideRouting(request({ issueBody: PLAIN_BODY, hqDispatchEvidence: 'unknown' }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.reason).toContain('could not be established');
  });

  it('refuses when the caller supplies no durable evidence AT ALL', () => {
    // The point of the whole shape. If omitting the field were permissive,
    // omitting the field would itself be the bypass — which is precisely the
    // defect class issue #224 has already produced four times (a guard correct
    // where it was wired and absent where it was not). An earlier version of
    // this file asserted the OPPOSITE here, on the reasoning that callers
    // unable to supply the fact should keep working; that reasoning was wrong,
    // because a caller unable to supply it is exactly the caller that cannot
    // prove the issue is safe to re-run.
    const decision = decideRouting(request({ issueBody: PLAIN_BODY, hqDispatchEvidence: undefined }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.dispatchTo).toEqual([]);
  });

  it('still allows the dispatch itself, so an unresolvable lookup cannot brick the lane', () => {
    const decision = decideRouting(
      request({ trigger: 'issue_opened', hqDispatchEvidence: 'unknown', commentBody: undefined }),
    );
    expect(decision.outcome).toBe('ROUTE');
  });
});

describe('the body marker remains COMPATIBILITY evidence, never overridden', () => {
  it('refuses on the marker even when the durable lookup says never dispatched', () => {
    // Contradictory inputs resolve toward refusal. A stale or wrong
    // `never_dispatched` must not clear an issue that currently SAYS it is an
    // HQ dispatch — which is also what keeps issues dispatched before this
    // change guarded.
    const decision = decideRouting(request({ hqDispatchEvidence: 'never_dispatched' }));
    expect(decision.outcome).toBe('IGNORE');
    expect(decision.reason).toContain('JENIFY HQ');
  });
});

describe('parseHqDispatchEvidence never invents a clean bill of health', () => {
  it('maps only the two exact positive strings, everything else to unknown', () => {
    expect(parseHqDispatchEvidence('dispatched')).toBe('dispatched');
    expect(parseHqDispatchEvidence('never_dispatched')).toBe('never_dispatched');
    for (const raw of [undefined, null, '', ' never_dispatched', 'NEVER_DISPATCHED', 'never-dispatched', 'true', 'no']) {
      expect(parseHqDispatchEvidence(raw)).toBe('unknown');
    }
  });
});
