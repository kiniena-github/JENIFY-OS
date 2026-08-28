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
  factProbe,
  type ConnectionDescriptor,
  type ConnectionProbe,
} from '../src/live/connections.js';
import { assertBrowserSafe } from '../src/live/redaction.js';

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
  it('reports Claude connected once its routine secrets are observed', () => {
    const status = statusFor('anthropic-claude', {
      CLAUDE_ROUTINE_URL: 'present',
      CLAUDE_ROUTINE_TOKEN: 'present',
    });
    expect(status.state).toBe('connected');
    expect(status.effectiveCapabilities).toContain('ai_task_execution');
    expect(status.lastVerifiedAt).toBe(NOW);
  });

  it('reports Codex as LOCAL-ONLY rather than connected, because it is a local CLI', () => {
    // Flattening this into "connected" is exactly the lie that let the old
    // bridge stall silently in CI.
    const status = statusFor('openai-codex', {
      CODEX_CLI_PATH: '/usr/local/bin/codex',
      CODEX_AUTH_MODE: 'chatgpt',
    });
    expect(status.state).toBe('local_only');
    expect(status.locality).toBe('local');
  });

  it('reports a partially-configured integration as setup required, not connected', () => {
    const status = statusFor('supabase', { SUPABASE_URL: 'https://example.supabase.co' });
    expect(status.state).toBe('setup_required');
    expect(status.observedFacts).toEqual(['SUPABASE_URL']);
    expect(status.missingFacts).toEqual(['SUPABASE_ANON_KEY']);
    expect(status.effectiveCapabilities).toEqual([]);
  });

  it('agrees with routing/providers.ts, so the page and the router cannot diverge', () => {
    const connected = statusFor('google-gemini', { GEMINI_API_KEY: 'present' });
    expect(connected.state).toBe('connected');
    expect(connected.evidenceSource).toContain('providerConnectivity(GEMINI)');
    expect(statusFor('google-gemini').state).toBe('not_connected');
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
    const evidence = factProbe(descriptor).probe(
      { SUPABASE_URL: '   ', SUPABASE_ANON_KEY: '' },
      NOW,
    );
    expect(evidence.state).toBe('not_connected');
  });
});
