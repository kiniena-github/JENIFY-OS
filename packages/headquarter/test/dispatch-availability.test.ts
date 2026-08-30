/**
 * The transport-backed route-availability verdict (issue #224, Codex P1 and
 * P2 #3 on `66d34cc`).
 *
 * Two defects this pins, both the same shape — a surface more confident than
 * its evidence:
 *
 *   P1. The Direct Order CLI passed no availability at all, so on the Founder
 *       workstation — `gh` authenticated, `CLAUDE_ROUTINE_*` deliberately
 *       absent because they are GitHub Actions secrets — a CLAUDE or AUTO
 *       order reported `BLOCKED — NOT CONNECTED` over an order that was
 *       perfectly dispatchable. The CLI is the caller that RUNS on that
 *       machine, so it is the one with the least excuse for inferring.
 *
 *   P2. A live negative was collapsed to "don't know". `gh auth status` calls
 *       the API, so a non-zero exit is a LIVE answer — session missing,
 *       expired or revoked. Discarding it makes the routing contract answer
 *       from `secretsEnv`, and a host that happens to carry `CLAUDE_ROUTINE_*`
 *       then reports READY while the only real transport would refuse as
 *       unauthenticated.
 */

import { describe, expect, it } from 'vitest';
import {
  transportRouteAvailability,
  TRANSPORT_VERDICT_TTL_MS,
} from '../src/providers/claude/dispatch-availability.js';
import type {
  GitHubIssueResult,
  GitHubIssueTransport,
  GitHubTransportStatus,
} from '../src/providers/claude/transport.js';

/** `gh` installed and holding a live authenticated github.com session. */
const AUTHENTICATED: GitHubTransportStatus = {
  available: true,
  authenticated: true,
  account: 'kiniena-github',
  depth: 'live',
  observedFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
  missingFacts: [],
  reason: 'The GitHub CLI is installed and an authenticated github.com session was observed.',
};

/** `gh` installed, live check RAN, and reported no session. A real negative. */
const LIVE_UNAUTHENTICATED: GitHubTransportStatus = {
  available: true,
  authenticated: false,
  account: null,
  depth: 'live',
  observedFacts: ['GH_CLI_PATH'],
  missingFacts: ['GH_AUTH_ACCOUNT'],
  reason: 'The GitHub CLI is installed but no authenticated github.com session was observed.',
};

/** No `gh` at all. Genuine ignorance — the routing contract should answer. */
const NO_TRANSPORT: GitHubTransportStatus = {
  available: false,
  authenticated: false,
  account: null,
  depth: 'none',
  observedFacts: [],
  missingFacts: ['GH_CLI_PATH', 'GH_AUTH_ACCOUNT'],
  reason: 'No GitHub CLI (`gh`) was found on this machine.',
};

function stub(
  status: GitHubTransportStatus | (() => GitHubTransportStatus),
): GitHubIssueTransport & { calls: number } {
  const transport = {
    id: 'stub-gh',
    calls: 0,
    status(): GitHubTransportStatus {
      transport.calls += 1;
      return typeof status === 'function' ? status() : status;
    },
    createIssue(): GitHubIssueResult {
      throw new Error('this suite never publishes');
    },
  };
  return transport;
}

describe('an observed transport answers for CLAUDE, and only for CLAUDE', () => {
  it('says dispatchable when a live check found an authenticated session', () => {
    const availability = transportRouteAvailability(stub(AUTHENTICATED));
    expect(availability.providerDispatchable!('CLAUDE')).toBe(true);
  });

  /**
   * The P2. A live check that ran and found nothing is an ANSWER, not a
   * shrug — and it is the answer that keeps a host carrying `CLAUDE_ROUTINE_*`
   * from reporting READY while `gh` would refuse.
   */
  it('says NOT dispatchable when a live check found no session', () => {
    const availability = transportRouteAvailability(stub(LIVE_UNAUTHENTICATED));
    expect(availability.providerDispatchable!('CLAUDE')).toBe(false);
  });

  it('defers when no live check happened at all', () => {
    const availability = transportRouteAvailability(stub(NO_TRANSPORT));
    expect(availability.providerDispatchable!('CLAUDE')).toBeNull();
  });

  it('defers for every provider this transport does not carry', () => {
    const availability = transportRouteAvailability(stub(AUTHENTICATED));
    for (const provider of ['CODEX', 'GEMINI', 'JULES', 'LOCAL'] as const) {
      // An authenticated GitHub session says nothing about whether the Codex
      // CLI is installed. Answering would be a guess.
      expect(availability.providerDispatchable!(provider), provider).toBeNull();
    }
  });

  it('treats a probe that throws as ignorance, never as a negative', () => {
    // A broken probe tells us nothing about the session. Turning it into
    // "not dispatchable" would block orders on the health of the check.
    const availability = transportRouteAvailability(
      stub(() => {
        throw new Error('spawn failed');
      }),
    );
    expect(availability.providerDispatchable!('CLAUDE')).toBeNull();
  });
});

describe('the verdict is cached, because observing it spawns a process', () => {
  it('asks the transport once for repeated questions inside the window', () => {
    const transport = stub(AUTHENTICATED);
    const availability = transportRouteAvailability(transport);
    // The composer resolves three routes in one pass; the dry run prints all
    // three. That must not cost three `gh auth status` calls.
    for (let i = 0; i < 5; i += 1) availability.providerDispatchable!('CLAUDE');
    expect(transport.calls).toBe(1);
  });

  it('does not spawn at all for a provider it does not carry', () => {
    const transport = stub(AUTHENTICATED);
    const availability = transportRouteAvailability(transport);
    availability.providerDispatchable!('CODEX');
    expect(transport.calls).toBe(0);
  });

  it('re-observes once the window has passed', () => {
    let at = 1_000;
    let status = AUTHENTICATED;
    const transport = stub(() => status);
    const availability = transportRouteAvailability(transport, { now: () => at });
    expect(availability.providerDispatchable!('CLAUDE')).toBe(true);

    // The session is revoked while HQ is not looking.
    status = LIVE_UNAUTHENTICATED;
    at += TRANSPORT_VERDICT_TTL_MS;
    // Still inside the window (boundary is inclusive): the cached answer holds.
    expect(availability.providerDispatchable!('CLAUDE')).toBe(true);
    expect(transport.calls).toBe(1);

    at += 1;
    expect(availability.providerDispatchable!('CLAUDE')).toBe(false);
    expect(transport.calls).toBe(2);
  });

  it('caches a null verdict too, so a missing transport is not re-probed in a loop', () => {
    const transport = stub(NO_TRANSPORT);
    const availability = transportRouteAvailability(transport);
    for (let i = 0; i < 3; i += 1) {
      expect(availability.providerDispatchable!('CLAUDE')).toBeNull();
    }
    expect(transport.calls).toBe(1);
  });

  it('caches per instance, so one host’s verdict is not another’s', () => {
    const a = stub(AUTHENTICATED);
    const b = stub(LIVE_UNAUTHENTICATED);
    expect(transportRouteAvailability(a).providerDispatchable!('CLAUDE')).toBe(true);
    expect(transportRouteAvailability(b).providerDispatchable!('CLAUDE')).toBe(false);
  });
});
