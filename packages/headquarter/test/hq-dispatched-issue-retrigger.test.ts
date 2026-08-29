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
 * ## What is asserted
 *
 * Re-triggers of an HQ-dispatched issue are refused; the dispatch itself is
 * untouched; and an ordinary (non-HQ) AI task keeps working exactly as before,
 * so the guard is narrow rather than a general freeze on re-triggering.
 */

import { describe, expect, it } from 'vitest';
import { decideRouting, type RoutingRequest } from '../src/routing/route.js';
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
    secrets: CONNECTED,
    ...overrides,
  };
}

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
    const decision = decideRouting(request({ issueBody: PLAIN_BODY }));
    expect(decision.outcome).toBe('ROUTE');
    expect(decision.dispatchTo).toContain('CLAUDE');
  });

  it('keeps today’s behaviour when no issue body is available at all', () => {
    // Callers that cannot supply a body must not silently lose re-triggering.
    const decision = decideRouting(request({ issueBody: undefined }));
    expect(decision.outcome).toBe('ROUTE');
  });

  it('still refuses a non-owner commenter, HQ issue or not', () => {
    // The pre-existing rule is unchanged and still checked first.
    expect(decideRouting(request({ actorLogin: 'someone-else', issueBody: PLAIN_BODY })).outcome).toBe('IGNORE');
    expect(decideRouting(request({ actorLogin: 'someone-else' })).outcome).toBe('IGNORE');
  });
});
