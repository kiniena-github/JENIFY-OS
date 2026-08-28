/**
 * Connection Center (issue #200, scope C).
 *
 * The property under test throughout: **state is evidence-derived, never
 * descriptor-derived.** The catalogue naming Vercel, Supabase and Google
 * Workspace must not make any of them look reachable, and an adapter that
 * over-claims must not be able to promote advertised capabilities into
 * granted ones.
 */

import { describe, expect, it } from 'vitest';
import {
  assessConnections,
  CONNECTION_CATALOG,
  connectionSummary,
  defaultConnectionProbes,
  configurationProbe,
  DEFAULT_CONNECTION_VERIFIERS,
  verifiedProbe,
  type ConnectionDescriptor,
  type ConnectionProbe,
  type ConnectionVerifier,
  type VerificationOutcome,
} from '../src/live/connections.js';
import { assertBrowserSafe } from '../src/live/redaction.js';
import { renderConnections } from '../src/ui/render.js';

const NOW = '2026-08-28T12:00:00Z';

/** No facts observed at all — the state of a bare machine. */
const NOTHING = {};

function statusFor(id: string, env = NOTHING) {
  const status = assessConnections(env, { now: NOW }).find((entry) => entry.id === id);
  if (!status) throw new Error(`no connection ${id}`);
  return status;
}

describe('nothing is connected merely by being catalogued', () => {
  it('reports every seeded integration as not connected on a bare environment', () => {
    for (const status of assessConnections(NOTHING, { now: NOW })) {
      expect(status.state, `${status.id} must not claim connectivity from its descriptor`).toBe(
        'not_connected',
      );
      expect(status.effectiveCapabilities).toEqual([]);
    }
  });

  it('seeds the categories the mission names, without claiming any of them', () => {
    const ids = CONNECTION_CATALOG.map((descriptor) => descriptor.id);
    for (const expected of [
      'anthropic-claude',
      'openai-codex',
      'google-gemini',
      'github',
      'vercel',
      'supabase',
      'google-workspace',
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it('never turns an advertised capability into an effective one without evidence', () => {
    const vercel = statusFor('vercel');
    expect(vercel.advertisedCapabilities).toContain('preview_deployment');
    expect(vercel.effectiveCapabilities).toEqual([]);
  });
});

describe('evidence changes the verdict', () => {
  it('reports Claude DISPATCHABLE once its routine secrets are observed, not connected', () => {
    // Codex round-3 P1 #3: the routing dispatch contract is satisfied, so HQ
    // would route work here — but nothing has asked Anthropic whether the
    // token is still valid, so this is not connectivity and grants nothing.
    const status = statusFor('anthropic-claude', {
      CLAUDE_ROUTINE_URL: 'present',
      CLAUDE_ROUTINE_TOKEN: 'present',
    });
    expect(status.state).toBe('dispatchable');
    expect(status.verification).toBe('routing_contract');
    expect(status.outcome).toBe('not_attempted');
    expect(status.effectiveCapabilities).toEqual([]);
    expect(status.lastVerifiedAt).toBeNull();
  });

  it('reports Codex as dispatchable-and-local, never as connected', () => {
    // Flattening the local/cloud difference into "connected" is exactly the
    // lie that let the old bridge stall silently in CI; `locality` keeps it.
    const status = statusFor('openai-codex', {
      CODEX_CLI_PATH: '/usr/local/bin/codex',
      CODEX_AUTH_MODE: 'chatgpt',
    });
    expect(status.state).toBe('dispatchable');
    expect(status.locality).toBe('local');
    expect(status.effectiveCapabilities).toEqual([]);
  });

  it('reports a partially-configured integration as setup required, not connected', () => {
    const status = statusFor('supabase', { SUPABASE_URL: 'https://example.supabase.co' });
    expect(status.state).toBe('setup_required');
    expect(status.observedFacts).toEqual(['SUPABASE_URL']);
    expect(status.missingFacts).toEqual(['SUPABASE_ANON_KEY']);
    expect(status.effectiveCapabilities).toEqual([]);
  });

  it('agrees with routing/providers.ts about DISPATCHABILITY, so the page and the router cannot diverge', () => {
    const routable = statusFor('google-gemini', { GEMINI_API_KEY: 'present' });
    expect(routable.state).toBe('dispatchable');
    expect(routable.evidenceSource).toContain('providerConnectivity(GEMINI)');
    expect(statusFor('google-gemini').state).toBe('not_connected');
  });
});

describe('routing evidence is dispatchability, never verified connectivity', () => {
  /**
   * Codex round-3 P1 #3. `providerConnectivity` reads executor metadata and
   * environment facts. It never contacts the provider, so an expired, revoked
   * or rotated credential is indistinguishable from a working one — and the
   * page previously reported all three as Connected, with the integration's
   * advertised capabilities granted on the strength of it.
   */
  const ROUTABLE = {
    CLAUDE_ROUTINE_URL: 'present',
    CLAUDE_ROUTINE_TOKEN: 'revoked-yesterday',
    GEMINI_API_KEY: 'rotated-last-week',
    CODEX_CLI_PATH: '/usr/local/bin/codex',
    CODEX_AUTH_MODE: 'chatgpt',
  };

  it('grants no capability and no verification timestamp to ANY routing-backed provider', () => {
    for (const status of assessConnections(ROUTABLE, { now: NOW })) {
      if (status.verification !== 'routing_contract') continue;
      expect(status.state, `${status.id} must not claim connectivity from routing evidence`).not.toBe(
        'connected',
      );
      expect(status.state).not.toBe('local_only');
      expect(status.effectiveCapabilities).toEqual([]);
      expect(status.lastVerifiedAt).toBeNull();
      expect(status.outcome).toBe('not_attempted');
    }
  });

  it('says in words that nothing asked the provider', () => {
    const status = statusFor('anthropic-claude', ROUTABLE);
    expect(status.reason.toLowerCase()).toContain('dispatch');
    expect(status.reason).toMatch(/nothing has asked the provider/i);
  });

  it('downgrades a probe that claims connected on routing evidence alone', () => {
    // Enforced centrally, so an adapter written later cannot restore the
    // defect by claiming harder than its method supports.
    const overclaiming: ConnectionProbe = {
      id: 'anthropic-claude',
      probe: () => ({
        state: 'connected',
        verification: 'routing_contract',
        outcome: 'verified',
        observedFacts: ['CLAUDE_ROUTINE_URL', 'CLAUDE_ROUTINE_TOKEN'],
        missingFacts: [],
        effectiveCapabilities: ['ai_task_execution'],
        lastVerifiedAt: NOW,
        evidenceSource: 'the router, optimistically',
        reason: 'we can dispatch, so it must be up',
      }),
    };
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'anthropic-claude')!;
    const [status] = assessConnections(ROUTABLE, {
      now: NOW,
      catalog: [descriptor],
      probes: [overclaiming],
    });
    expect(status!.state).toBe('dispatchable');
    expect(status!.effectiveCapabilities).toEqual([]);
    expect(status!.lastVerifiedAt).toBeNull();
    expect(status!.reason).toContain('DISPATCHABLE rather than connected');
  });

  it('reaches connected ONLY through a live check that actually succeeded', () => {
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'anthropic-claude')!;
    const [status] = assessConnections(ROUTABLE, {
      now: NOW,
      catalog: [descriptor],
      probes: [
        verifiedProbe(descriptor, {
          id: descriptor.id,
          verify: () => ({
            outcome: 'verified',
            detail: 'asked the service and it answered',
            capabilities: ['ai_task_execution'],
          }),
        }),
      ],
    });
    expect(status!.state).toBe('connected');
    expect(status!.verification).toBe('live_check');
    expect(status!.effectiveCapabilities).toEqual(['ai_task_execution']);
    expect(status!.lastVerifiedAt).toBe(NOW);
    // And V1 ships no such verifier, so nothing in the shipped page is
    // Connected on its own evidence.
    expect(DEFAULT_CONNECTION_VERIFIERS).toEqual([]);
    expect(
      assessConnections(ROUTABLE, { now: NOW }).some((entry) => entry.state === 'connected'),
    ).toBe(false);
  });
});

describe('credential presence is configuration, never connectivity', () => {
  /**
   * Codex P1 #4: setting `VERCEL_TOKEN` and `VERCEL_PROJECT_ID` says somebody
   * configured Vercel. It says nothing about whether the token is valid,
   * unexpired, unrevoked, well-formed or pointed at the right project — so it
   * cannot mean Connected, and it cannot grant a capability.
   */
  const FULLY_SET = {
    VERCEL_TOKEN: 'set',
    VERCEL_PROJECT_ID: 'set',
    SUPABASE_URL: 'set',
    SUPABASE_ANON_KEY: 'set',
    GITHUB_TOKEN: 'set',
    GOOGLE_WORKSPACE_CLIENT_ID: 'set',
    GOOGLE_WORKSPACE_REFRESH_TOKEN: 'set',
  };

  it('reports a fully-credentialed generic integration as CONFIGURED, not connected', () => {
    for (const id of ['vercel', 'supabase', 'github', 'google-workspace']) {
      const status = statusFor(id, FULLY_SET);
      expect(status.state, `${id} must not claim connectivity from credential presence`).toBe(
        'configured',
      );
      expect(status.effectiveCapabilities).toEqual([]);
      expect(status.verification).toBe('configuration');
      expect(status.outcome).toBe('not_attempted');
      // Nothing was verified, so nothing may carry a verification timestamp.
      expect(status.lastVerifiedAt).toBeNull();
    }
  });

  it('grants no capability to any generic integration in V1, because none is verified', () => {
    for (const status of assessConnections(FULLY_SET, { now: NOW })) {
      if (status.verification === 'configuration') {
        expect(status.effectiveCapabilities).toEqual([]);
      }
    }
    expect(DEFAULT_CONNECTION_VERIFIERS).toEqual([]);
  });

  it('downgrades a probe that claims connected on configuration alone', () => {
    // The invariant is enforced centrally, so a third-party adapter written
    // later cannot restore the defect by claiming harder.
    const overclaiming: ConnectionProbe = {
      id: 'vercel',
      probe: () => ({
        state: 'connected',
        verification: 'configuration',
        outcome: 'verified',
        observedFacts: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'],
        missingFacts: [],
        effectiveCapabilities: ['preview_deployment'],
        lastVerifiedAt: NOW,
        evidenceSource: 'the environment, optimistically',
        reason: 'the token is set, so surely it works',
      }),
    };
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'vercel')!;
    const [status] = assessConnections(FULLY_SET, {
      now: NOW,
      catalog: [descriptor],
      probes: [overclaiming],
    });
    expect(status!.state).toBe('configured');
    expect(status!.effectiveCapabilities).toEqual([]);
    expect(status!.reason).toContain('CONFIGURED rather than connected');
  });

  it('keeps expired, revoked, malformed and wrong-project truthfully representable', () => {
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'supabase')!;
    const cases: { outcome: VerificationOutcome; state: string }[] = [
      { outcome: 'expired', state: 'expired' },
      { outcome: 'revoked', state: 'expired' },
      { outcome: 'malformed', state: 'error' },
      { outcome: 'wrong_project', state: 'error' },
      { outcome: 'unreachable', state: 'error' },
    ];
    for (const { outcome, state } of cases) {
      const verifier: ConnectionVerifier = {
        id: 'supabase',
        verify: () => ({ outcome, detail: `the check reported ${outcome}` }),
      };
      const [status] = assessConnections(FULLY_SET, {
        now: NOW,
        catalog: [descriptor],
        probes: [verifiedProbe(descriptor, verifier)],
      });
      expect(status!.state).toBe(state);
      expect(status!.outcome).toBe(outcome);
      expect(status!.effectiveCapabilities).toEqual([]);
      expect(status!.reason).toContain(outcome);
    }
  });

  /**
   * Codex exact-head finding on `5c767fa` (P2). `verifiedProbe` recorded the
   * check instant whatever came back, so an expired, revoked, malformed or
   * unreachable credential was stamped with the moment it FAILED — and the
   * Connection Center renders that field under the label "Last verified". The
   * most recently broken credential looked like the most recently confirmed
   * healthy one. The failure is still evidence and still survives in `outcome`
   * and `reason`; what it is not is verification.
   */
  it('leaves no last-verified instant behind when the check did not succeed', () => {
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'supabase')!;
    for (const outcome of [
      'expired',
      'revoked',
      'malformed',
      'wrong_project',
      'unreachable',
      'failed',
    ] as VerificationOutcome[]) {
      const verifier: ConnectionVerifier = {
        id: 'supabase',
        verify: () => ({ outcome, detail: `the check reported ${outcome}` }),
      };
      const [status] = assessConnections(FULLY_SET, {
        now: NOW,
        catalog: [descriptor],
        probes: [verifiedProbe(descriptor, verifier)],
      });
      expect(status!.lastVerifiedAt, outcome).toBeNull();
      // The check is not erased — it is reported as what it was.
      expect(status!.outcome, outcome).toBe(outcome);
      expect(status!.reason, outcome).toContain(outcome);
    }
  });

  it('reaches connected only when a live check actually succeeds', () => {
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'supabase')!;
    const verifier: ConnectionVerifier = {
      id: 'supabase',
      verify: () => ({ outcome: 'verified', detail: 'HTTP 200 from the project health endpoint' }),
    };
    const [status] = assessConnections(FULLY_SET, {
      now: NOW,
      catalog: [descriptor],
      probes: [verifiedProbe(descriptor, verifier)],
    });
    expect(status!.state).toBe('connected');
    expect(status!.verification).toBe('live_check');
    expect(status!.effectiveCapabilities).toEqual([...descriptor.advertisedCapabilities]);
    expect(status!.lastVerifiedAt).toBe(NOW);
  });

  it('does not ask a verifier about an integration nobody configured', () => {
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'supabase')!;
    let asked = 0;
    const verifier: ConnectionVerifier = {
      id: 'supabase',
      verify: () => {
        asked += 1;
        return { outcome: 'verified', detail: 'should never be reached' };
      },
    };
    const [status] = assessConnections(NOTHING, {
      now: NOW,
      catalog: [descriptor],
      probes: [verifiedProbe(descriptor, verifier)],
    });
    expect(asked).toBe(0);
    expect(status!.state).toBe('not_connected');
  });
});

describe('the probe seam cannot weaken the invariants', () => {
  const descriptor: ConnectionDescriptor = {
    id: 'over-eager',
    displayName: 'Over-eager Adapter',
    category: 'workspace',
    authMechanism: 'oauth',
    locality: 'cloud',
    advertisedCapabilities: ['everything'],
    requiredFacts: ['NEVER_SET'],
    setupHint: 'n/a',
    recheckable: true,
    revocable: true,
  };

  it('empties effective capabilities when a probe claims them while not connected', () => {
    const liar: ConnectionProbe = {
      id: 'over-eager',
      probe: () => ({
        state: 'not_connected',
        verification: 'live_check',
        outcome: 'failed',
        observedFacts: [],
        missingFacts: ['NEVER_SET'],
        effectiveCapabilities: ['everything'], // over-claim
        lastVerifiedAt: NOW,
        evidenceSource: 'wishful thinking',
        reason: 'trust me',
      }),
    };
    const [status] = assessConnections(NOTHING, { now: NOW, catalog: [descriptor], probes: [liar] });
    expect(status!.effectiveCapabilities).toEqual([]);
  });

  it('reports a throwing probe as an error rather than dropping the row', () => {
    const broken: ConnectionProbe = {
      id: 'over-eager',
      probe: () => {
        throw new Error('probe exploded');
      },
    };
    const [status] = assessConnections(NOTHING, { now: NOW, catalog: [descriptor], probes: [broken] });
    expect(status!.state).toBe('error');
    expect(status!.reason).toContain('probe exploded');
    expect(status!.effectiveCapabilities).toEqual([]);
  });

  it('treats a descriptor with no probe as not connected and never verified', () => {
    const [status] = assessConnections(NOTHING, { now: NOW, catalog: [descriptor], probes: [] });
    expect(status!.state).toBe('not_connected');
    expect(status!.lastVerifiedAt).toBeNull();
    expect(status!.canRecheck).toBe(false);
  });

  /**
   * Codex exact-head finding on `5c767fa` (P2). The method alone used to be
   * the whole test: a probe returning `verification: 'live_check'` and
   * `state: 'connected'` was treated as verified WHATEVER its outcome, so an
   * adapter reporting a failed, expired or unreachable check kept the
   * connected state, had its capabilities granted, and was stamped with a
   * verification instant. `options.probes` takes arbitrary adapters and this
   * layer is where the invariant is meant to hold centrally, so the outcome
   * belongs in the test: a check that RAN is not a check that SUCCEEDED.
   */
  const claimingProbe = (outcome: VerificationOutcome): ConnectionProbe => ({
    id: 'over-eager',
    probe: () => ({
      state: 'connected',
      verification: 'live_check',
      outcome,
      observedFacts: ['NEVER_SET'],
      missingFacts: [],
      effectiveCapabilities: ['everything'],
      lastVerifiedAt: NOW,
      evidenceSource: 'adapter',
      reason: `Over-eager Adapter: ${outcome}`,
    }),
  });

  const assessClaim = (outcome: VerificationOutcome) =>
    assessConnections(NOTHING, {
      now: NOW,
      catalog: [descriptor],
      probes: [claimingProbe(outcome)],
    })[0]!;

  it('refuses a connected claim whose live check did not come back verified', () => {
    for (const outcome of [
      'failed',
      'expired',
      'revoked',
      'malformed',
      'wrong_project',
      'unreachable',
      'not_attempted',
    ] as VerificationOutcome[]) {
      const status = assessClaim(outcome);
      expect(status.state, outcome).not.toBe('connected');
      expect(status.effectiveCapabilities, outcome).toEqual([]);
      expect(status.lastVerifiedAt, outcome).toBeNull();
    }
  });

  it('downgrades a failed live check to what its own outcome means, not to configured', () => {
    // "Configured" would say nothing had been tried. Something was tried and
    // it came back badly; the row must keep saying so.
    expect(assessClaim('expired').state).toBe('expired');
    expect(assessClaim('revoked').state).toBe('expired');
    expect(assessClaim('unreachable').state).toBe('error');
    expect(assessClaim('malformed').state).toBe('error');
    expect(assessClaim('wrong_project').state).toBe('error');
    expect(assessClaim('failed').state).toBe('error');
    // And the reason says a check ran, rather than blaming configuration.
    expect(assessClaim('expired').reason).toContain('a live check ran and came back expired');
  });

  it('still grants a genuinely verified live check everything it earned', () => {
    const status = assessClaim('verified');
    expect(status.state).toBe('connected');
    expect(status.effectiveCapabilities).toEqual(['everything']);
    expect(status.lastVerifiedAt).toBe(NOW);
  });
});

describe('controls are only offered where something real exists', () => {
  it('offers no Disconnect anywhere in V1, because there is no credential store to revoke from', () => {
    for (const status of assessConnections(NOTHING, { now: NOW })) {
      expect(status.canDisconnect).toBe(false);
    }
  });

  it('offers recheck only where a probe genuinely ran', () => {
    const statuses = assessConnections(NOTHING, { now: NOW });
    const workspace = statuses.find((entry) => entry.id === 'google-workspace')!;
    // No safe secret-free recheck exists for an OAuth client that was never
    // registered, so no control is drawn.
    expect(workspace.canRecheck).toBe(false);
    expect(statuses.find((entry) => entry.id === 'github')!.canRecheck).toBe(true);
  });
});

describe('nothing a probe returns can carry a secret to the browser', () => {
  it('survives the browser-safety guard even when every fact is set to a credential-shaped value', () => {
    const env = Object.fromEntries(
      CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts).map((fact) => [
        fact,
        'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      ]),
    );
    const statuses = assessConnections(env, { now: NOW });
    // Values were read for presence only; none of them may appear anywhere.
    expect(() => assertBrowserSafe(statuses)).not.toThrow();
    expect(JSON.stringify(statuses)).not.toContain('ghp_');
  });
});

describe('summary counts', () => {
  it('counts each state exactly once', () => {
    const counts = connectionSummary(assessConnections(NOTHING, { now: NOW }));
    expect(counts.not_connected).toBe(CONNECTION_CATALOG.length);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(CONNECTION_CATALOG.length);
  });

  it('builds one default probe per catalogue entry', () => {
    expect(defaultConnectionProbes().map((probe) => probe.id).sort()).toEqual(
      CONNECTION_CATALOG.map((descriptor) => descriptor.id).sort(),
    );
  });

  it('treats a blank fact as absent, so an empty env var cannot fake a connection', () => {
    const descriptor = CONNECTION_CATALOG.find((entry) => entry.id === 'supabase')!;
    const evidence = configurationProbe(descriptor).probe(
      { SUPABASE_URL: '   ', SUPABASE_ANON_KEY: '' },
      NOW,
    );
    expect(evidence.state).toBe('not_connected');
  });
});

/**
 * Found while verifying the round-5 fixes, and a residual of the same defect
 * class as the second of them: `options.probes` accepts arbitrary adapters,
 * and this layer is the one place documented as enforcing the probe
 * invariants centrally — so an answer outside the vocabulary has to fail
 * closed here too.
 *
 * It did not. `state`, `verification` and `outcome` were forwarded verbatim,
 * so a probe answering `state: 'totally_fine'` reached the Connection Center,
 * where that state has no label and no tone; rendering the page threw a
 * TypeError inside `escapeHtml`, naming neither the connection nor the
 * adapter. One bad probe took down the whole site build pointing at the wrong
 * place. A malformed `outcome` (`null`, a number, a made-up word) did the
 * same, and `outcome` became an execution-authority input in this very round.
 *
 * No unrecognised value could ever forge a connection — an unknown state is
 * not `connected` and an unknown outcome is not `verified`, so both already
 * failed closed on the security question. What was missing is the honesty and
 * robustness half: "fail closed on unknown" is the rule everywhere else in
 * this control plane.
 */
describe('a probe answering outside the vocabulary fails closed', () => {
  const descriptor: ConnectionDescriptor = {
    id: 'alien',
    displayName: 'Alien Adapter',
    category: 'workspace',
    authMechanism: 'oauth',
    locality: 'cloud',
    advertisedCapabilities: ['everything'],
    requiredFacts: [],
    setupHint: 'n/a',
    recheckable: true,
    revocable: false,
  };

  const answering = (evidence: unknown): ConnectionProbe => ({
    id: 'alien',
    probe: () => evidence as never,
  });

  const honest = {
    state: 'connected',
    verification: 'live_check',
    outcome: 'verified',
    observedFacts: [],
    missingFacts: [],
    effectiveCapabilities: ['everything'],
    lastVerifiedAt: NOW,
    evidenceSource: 'a real check',
    reason: 'Alien Adapter: verified',
  };

  const assess = (evidence: unknown) =>
    assessConnections(NOTHING, { now: NOW, catalog: [descriptor], probes: [answering(evidence)] })[0]!;

  it('reports an unrecognised state as an error, not as itself', () => {
    const status = assess({ ...honest, state: 'totally_fine' });
    expect(status.state).toBe('error');
    expect(status.effectiveCapabilities).toEqual([]);
    expect(status.lastVerifiedAt).toBeNull();
    // The offending answer is nameable from the page rather than swallowed.
    expect(status.reason).toContain('totally_fine');
    expect(status.reason).toContain('cannot read');
  });

  it('reports an unrecognised or malformed outcome as an error', () => {
    for (const outcome of ['ok', null, undefined, 42, { verified: true }]) {
      const status = assess({ ...honest, outcome });
      expect(status.state).toBe('error');
      expect(status.outcome).toBe('failed');
      expect(status.effectiveCapabilities).toEqual([]);
      expect(status.lastVerifiedAt).toBeNull();
    }
  });

  it('reports an unrecognised verification method as an error', () => {
    const status = assess({ ...honest, verification: 'vibes' });
    expect(status.state).toBe('error');
    expect(status.verification).toBe('none');
    expect(status.effectiveCapabilities).toEqual([]);
  });

  it('names every unrecognised field, not just the first', () => {
    const status = assess({ ...honest, state: 'fine', verification: 'vibes', outcome: 'ok' });
    expect(status.reason).toContain('fine');
    expect(status.reason).toContain('vibes');
    expect(status.reason).toContain('ok');
  });

  it('bounds what it quotes back, since the value came from an adapter', () => {
    const status = assess({ ...honest, state: 'x'.repeat(5000) });
    expect(status.reason.length).toBeLessThan(500);
  });

  it('leaves a probe answering in the vocabulary completely untouched', () => {
    const status = assess(honest);
    expect(status.state).toBe('connected');
    expect(status.effectiveCapabilities).toEqual(['everything']);
    expect(status.lastVerifiedAt).toBe(NOW);
    expect(status.reason).toBe('Alien Adapter: verified');
  });

  it('the rendered page survives it and says error rather than throwing', () => {
    const status = assess({ ...honest, state: 'totally_fine' });
    const html = renderConnections([status], NOW, undefined, 'sample');
    expect(html).toContain('Error');
    expect(html).not.toContain('totally_fine</span>'); // never rendered as a state chip
    expect(html).not.toContain('undefined');
  });

  it('reports an answer that is not an object at all, without throwing', () => {
    for (const answer of [null, undefined, 'nope', 42, []]) {
      const status = assess(answer);
      expect(status.state).toBe('error');
      expect(status.effectiveCapabilities).toEqual([]);
      expect(status.lastVerifiedAt).toBeNull();
      expect(() => renderConnections([status], NOW, undefined, 'sample')).not.toThrow();
    }
  });

  it('reports a fact list that is not a list of strings, however valid the vocabulary', () => {
    // The vocabulary is impeccable here; the SHAPE is not. This used to pass
    // straight through as `connected` and crash the renderer on `.map`.
    for (const field of ['observedFacts', 'missingFacts', 'effectiveCapabilities']) {
      const status = assess({ ...honest, [field]: 'oops' });
      expect(status.state).toBe('error');
      expect(status.effectiveCapabilities).toEqual([]);
      expect(status.reason).toContain(field);
      expect(() => renderConnections([status], NOW, undefined, 'sample')).not.toThrow();
    }
    const mixed = assess({ ...honest, observedFacts: ['ok', 7] });
    expect(mixed.state).toBe('error');
  });

  it('reports a non-string reason, evidenceSource or lastVerifiedAt', () => {
    for (const override of [{ reason: 5 }, { evidenceSource: null }, { lastVerifiedAt: 12345 }]) {
      const status = assess({ ...honest, ...override });
      expect(status.state).toBe('error');
      expect(() => renderConnections([status], NOW, undefined, 'sample')).not.toThrow();
    }
    // null lastVerifiedAt is legitimate: it means "never".
    expect(assess({ ...honest, lastVerifiedAt: null }).state).toBe('connected');
  });

  it('repairs nothing by halves — an unreadable answer is an error in full', () => {
    // Part-repairing would leave a half-understood answer that later reads as
    // a claim. Every field is replaced, and the fact list falls back to the
    // descriptor's own requirements rather than to the probe's.
    const status = assess({ ...honest, observedFacts: 'oops' });
    expect(status.verification).toBe('none');
    expect(status.outcome).toBe('failed');
    expect(status.observedFacts).toEqual([]);
    expect(status.evidenceSource).toContain('cannot read');
  });

  it('survives a value that cannot even be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const status = assess({ ...honest, state: circular });
    expect(status.state).toBe('error');
    expect(() => renderConnections([status], NOW, undefined, 'sample')).not.toThrow();
  });

  it('an unrecognised answer carrying credential material still cannot be rendered', () => {
    // The quoted-back value goes to the browser, so the boundary guard has to
    // see it. It does: the site refuses rather than publishing.
    const status = assess({ ...honest, state: 'sk-abcdefghijklmnopqrstuvwxyz012345' });
    expect(() => assertBrowserSafe([status], 'test.connections')).toThrow();
  });
});
