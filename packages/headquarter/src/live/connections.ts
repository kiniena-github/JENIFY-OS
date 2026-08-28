/**
 * Connection Center V1 (issue #200, scope C).
 *
 * ## The rule this module exists to enforce
 *
 * **A connection's state is derived from EVIDENCE, never from a descriptor.**
 *
 * HQ already holds three things that look like connections but are not:
 * `providers/known.ts` descriptors (a vendor's advertised product shape),
 * AI Member Registry rows (who is registered, with what claimed identity), and
 * `routing/providers.ts` registry entries (which providers HQ knows how to
 * route to at all). None of the three is proof that anything is reachable.
 * A member can be registered for a vendor HQ has no credential for; a
 * descriptor exists for providers that were never wired up.
 *
 * So the catalogue below deliberately holds only the *questions*: what would
 * have to be observed for this integration to be usable, and by what
 * mechanism. The answers come from a `ConnectionProbe`, and a connection with
 * no probe result is `not_connected` — deny by default, exactly like the rest
 * of the control plane.
 *
 * ## Secret presence, never secret values
 *
 * Probes report fact NAMES (`CLAUDE_ROUTINE_TOKEN`), never fact values. This
 * is the same convention `routing/providers.ts` uses, and it is what lets a
 * connection status be rendered in a browser at all. `redaction.ts` enforces
 * it mechanically.
 *
 * ## Extension seam (future `+ Add Connection`)
 *
 * A new integration is a new `ConnectionDescriptor` plus a `ConnectionProbe`.
 * Nothing in the UI, the snapshot, or this module's logic needs to change, and
 * a descriptor added without a probe is inert rather than optimistic.
 * Preference order for new adapters, per the mission brief: OAuth, then API
 * key, then MCP/CLI, with browser automation only as a last resort.
 */

import {
  providerConnectivity,
  type ProviderId,
  type SecretsEnv,
} from '../routing/providers.js';

/**
 * Connection state. `local_only` is load-bearing rather than cosmetic: a
 * Codex CLI holding a live subscription session on the Founder workstation is
 * genuinely usable there and genuinely unavailable to a GitHub-hosted runner
 * or a hosted preview, and flattening that into "connected" is exactly the
 * lie that made the old bridge stall silently.
 */
export type ConnectionState =
  | 'connected'
  | 'local_only'
  | 'not_connected'
  | 'expired'
  | 'error'
  | 'setup_required';

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  local_only: 'Local-only',
  not_connected: 'Not connected',
  expired: 'Expired',
  error: 'Error',
  setup_required: 'Setup required',
};

/** How HQ would authenticate to the service, if it were connected. */
export type AuthMechanism =
  | 'oauth'
  | 'api_key'
  | 'mcp'
  | 'cli'
  | 'github_workflow'
  | 'service_account'
  | 'none';

export const AUTH_MECHANISM_LABELS: Record<AuthMechanism, string> = {
  oauth: 'OAuth',
  api_key: 'API key',
  mcp: 'MCP',
  cli: 'Local CLI',
  github_workflow: 'GitHub workflow secret',
  service_account: 'Service account',
  none: 'None',
};

/** Where the integration physically runs. */
export type ConnectionLocality = 'cloud' | 'local';

export type ConnectionCategory =
  | 'ai_provider'
  | 'code_hosting'
  | 'hosting'
  | 'database'
  | 'workspace';

/**
 * What an integration WOULD be. Contains no state and no claim of
 * availability — see the module note.
 */
export interface ConnectionDescriptor {
  id: string;
  displayName: string;
  category: ConnectionCategory;
  authMechanism: AuthMechanism;
  locality: ConnectionLocality;
  /**
   * Capabilities the integration could expose to HQ. ADVERTISED, never
   * granted: these are copied into `effectiveCapabilities` only when a probe
   * has actually established the connection.
   */
  advertisedCapabilities: readonly string[];
  /** Non-secret fact names whose presence a probe looks for. */
  requiredFacts: readonly string[];
  /** What a Founder would have to do to connect it. Shown when not connected. */
  setupHint: string;
  /**
   * True only when a recheck exists that is safe to run from HQ without
   * exposing or transmitting a secret. False draws NO control at all rather
   * than a dead one.
   */
  recheckable: boolean;
  /**
   * True only when a real backend revoke/disconnect implementation exists.
   * Every V1 entry is false: HQ holds no credential store to revoke from, and
   * drawing the control anyway would be a fake button.
   */
  revocable: boolean;
}

/** What a probe observed. Fact NAMES only — never fact values. */
export interface ConnectionEvidence {
  state: ConnectionState;
  /** Required fact names actually observed present. */
  observedFacts: string[];
  /** Required fact names observed absent. */
  missingFacts: string[];
  /**
   * Capabilities genuinely available through this connection right now.
   * MUST be empty unless the state is `connected` or `local_only`.
   */
  effectiveCapabilities: string[];
  /** When the evidence was gathered, or null when never verified. */
  lastVerifiedAt: string | null;
  /** What was read to reach this verdict, precise enough to check. */
  evidenceSource: string;
  reason: string;
}

export interface ConnectionProbe {
  /** Matches `ConnectionDescriptor.id`. */
  id: string;
  probe(env: SecretsEnv, now: string): ConnectionEvidence;
}

/** A descriptor and its evidence, merged for display. */
export interface ConnectionStatus extends ConnectionDescriptor {
  state: ConnectionState;
  observedFacts: string[];
  missingFacts: string[];
  effectiveCapabilities: string[];
  lastVerifiedAt: string | null;
  evidenceSource: string;
  reason: string;
  /**
   * True when the UI may draw a working Test/Recheck control. Requires both a
   * recheckable descriptor AND a probe that actually ran.
   */
  canRecheck: boolean;
  /** True when a real revoke exists. Always false in V1 — see `revocable`. */
  canDisconnect: boolean;
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

/**
 * The seeded connection catalogue. Names present here mean only "HQ knows
 * what this integration would be"; they are not a claim that it exists.
 */
export const CONNECTION_CATALOG: readonly ConnectionDescriptor[] = [
  {
    id: 'anthropic-claude',
    displayName: 'Anthropic — Claude',
    category: 'ai_provider',
    authMechanism: 'github_workflow',
    locality: 'cloud',
    advertisedCapabilities: ['ai_task_execution', 'code_review', 'research'],
    requiredFacts: ['CLAUDE_ROUTINE_URL', 'CLAUDE_ROUTINE_TOKEN'],
    setupHint:
      'Set the CLAUDE_ROUTINE_URL and CLAUDE_ROUTINE_TOKEN GitHub Actions secrets so ' +
      '.github/workflows/ai-task-trigger.yml can dispatch the Claude routine.',
    recheckable: true,
    revocable: false,
  },
  {
    id: 'openai-codex',
    displayName: 'OpenAI — Codex CLI',
    category: 'ai_provider',
    authMechanism: 'cli',
    locality: 'local',
    advertisedCapabilities: ['code_review', 'ai_task_execution'],
    requiredFacts: ['CODEX_CLI_PATH', 'CODEX_AUTH_MODE'],
    setupHint:
      'Install the Codex CLI on the Founder workstation and run `codex login` once. ' +
      'Codex is deliberately unavailable to GitHub-hosted runners and to a hosted preview.',
    recheckable: true,
    revocable: false,
  },
  {
    id: 'google-gemini',
    displayName: 'Google — Gemini',
    category: 'ai_provider',
    authMechanism: 'api_key',
    locality: 'cloud',
    advertisedCapabilities: ['ai_task_execution', 'research'],
    requiredFacts: ['GEMINI_API_KEY'],
    setupHint:
      'Set the GEMINI_API_KEY GitHub Actions secret (AI Studio key, billing disabled) ' +
      'for .github/workflows/ai-task-gemini.yml.',
    recheckable: true,
    revocable: false,
  },
  {
    id: 'github',
    displayName: 'GitHub',
    category: 'code_hosting',
    authMechanism: 'github_workflow',
    locality: 'cloud',
    advertisedCapabilities: ['issues', 'pull_requests', 'actions', 'repository_read'],
    requiredFacts: ['GITHUB_TOKEN'],
    setupHint:
      'A GitHub Actions run supplies GITHUB_TOKEN automatically. Outside Actions, HQ has no ' +
      'GitHub credential of its own and reaches GitHub only through the Founder’s own tooling.',
    recheckable: true,
    revocable: false,
  },
  {
    id: 'vercel',
    displayName: 'Vercel',
    category: 'hosting',
    authMechanism: 'oauth',
    locality: 'cloud',
    advertisedCapabilities: ['preview_deployment'],
    requiredFacts: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID'],
    setupHint:
      'Connect the repository through the Vercel Git integration, or supply VERCEL_TOKEN and ' +
      'VERCEL_PROJECT_ID. HQ never deploys on its own — publishing stays a Founder action.',
    recheckable: true,
    revocable: false,
  },
  {
    id: 'supabase',
    displayName: 'Supabase',
    category: 'database',
    authMechanism: 'api_key',
    locality: 'cloud',
    advertisedCapabilities: ['postgres', 'auth', 'storage'],
    requiredFacts: ['SUPABASE_URL', 'SUPABASE_ANON_KEY'],
    setupHint:
      'Supply SUPABASE_URL and SUPABASE_ANON_KEY. JENIFY OS itself is local-first on SQLite; ' +
      'this entry exists for the sibling platforms that do use Supabase.',
    recheckable: true,
    revocable: false,
  },
  {
    id: 'google-workspace',
    displayName: 'Google Workspace',
    category: 'workspace',
    authMechanism: 'oauth',
    locality: 'cloud',
    advertisedCapabilities: ['drive_read', 'drive_write', 'docs'],
    requiredFacts: ['GOOGLE_WORKSPACE_CLIENT_ID', 'GOOGLE_WORKSPACE_REFRESH_TOKEN'],
    setupHint:
      'Register an OAuth client for the workspace and complete the consent flow. No client ' +
      'registration exists yet, so HQ has nothing to authenticate with.',
    recheckable: false,
    revocable: false,
  },
] as const;

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

function present(env: SecretsEnv, fact: string): boolean {
  const value = env[fact];
  return value != null && String(value).trim() !== '';
}

function splitFacts(env: SecretsEnv, facts: readonly string[]): { observed: string[]; missing: string[] } {
  const observed: string[] = [];
  const missing: string[] = [];
  for (const fact of facts) (present(env, fact) ? observed : missing).push(fact);
  return { observed, missing };
}

/**
 * The generic fact probe used by every catalogue entry that is not an AI
 * provider with its own routing definition.
 *
 * `setup_required` is reserved for a *partially* configured integration —
 * some required facts present, others absent. That is a real, distinguishable
 * observation ("someone started wiring this up"), unlike using it as a softer
 * synonym for "not connected", which would overstate the state of an
 * integration nobody has touched.
 */
export function factProbe(descriptor: ConnectionDescriptor): ConnectionProbe {
  return {
    id: descriptor.id,
    probe(env, now) {
      const { observed, missing } = splitFacts(env, descriptor.requiredFacts);
      const source = `environment facts: ${descriptor.requiredFacts.join(', ')}`;
      if (missing.length === 0 && descriptor.requiredFacts.length > 0) {
        const state: ConnectionState = descriptor.locality === 'local' ? 'local_only' : 'connected';
        return {
          state,
          observedFacts: observed,
          missingFacts: missing,
          effectiveCapabilities: [...descriptor.advertisedCapabilities],
          lastVerifiedAt: now,
          evidenceSource: source,
          reason: `${descriptor.displayName}: every required fact was observed present.`,
        };
      }
      if (observed.length > 0) {
        return {
          state: 'setup_required',
          observedFacts: observed,
          missingFacts: missing,
          effectiveCapabilities: [],
          lastVerifiedAt: now,
          evidenceSource: source,
          reason:
            `${descriptor.displayName}: partially configured — still missing ` +
            `${missing.join(', ')}. ${descriptor.setupHint}`,
        };
      }
      return {
        state: 'not_connected',
        observedFacts: observed,
        missingFacts: missing,
        effectiveCapabilities: [],
        lastVerifiedAt: now,
        evidenceSource: source,
        reason: `${descriptor.displayName}: not connected — no required fact observed. ${descriptor.setupHint}`,
      };
    },
  };
}

/**
 * Probe backed by `routing/providers.ts`, so an AI provider's Connection
 * Center row and its actual routability can never disagree. Reuses the
 * existing connectivity computation rather than re-deriving it.
 */
export function routingProbe(descriptor: ConnectionDescriptor, provider: ProviderId): ConnectionProbe {
  return {
    id: descriptor.id,
    probe(env, now) {
      const report = providerConnectivity(provider, env);
      const missing = [...report.missingSecrets, ...report.missingLocalFacts];
      const observed = descriptor.requiredFacts.filter((fact) => !missing.includes(fact));
      let state: ConnectionState;
      if (report.connected) {
        state = report.executorKind === 'local-cli' ? 'local_only' : 'connected';
      } else if (!report.hasExecutor) {
        // No execution mechanism exists at all: this is not something a
        // credential would fix, so it is not "setup required".
        state = 'not_connected';
      } else if (observed.length > 0) {
        state = 'setup_required';
      } else {
        state = 'not_connected';
      }
      const usable = state === 'connected' || state === 'local_only';
      return {
        state,
        observedFacts: observed,
        missingFacts: missing,
        effectiveCapabilities: usable ? [...descriptor.advertisedCapabilities] : [],
        lastVerifiedAt: now,
        evidenceSource: `routing/providers.ts providerConnectivity(${provider})`,
        reason: report.reason,
      };
    },
  };
}

/** AI-provider catalogue ids mapped to their routing registry provider. */
const ROUTING_BACKED: Readonly<Record<string, ProviderId>> = {
  'anthropic-claude': 'CLAUDE',
  'openai-codex': 'CODEX',
  'google-gemini': 'GEMINI',
};

/** Default probe set for the seeded catalogue. */
export function defaultConnectionProbes(
  catalog: readonly ConnectionDescriptor[] = CONNECTION_CATALOG,
): ConnectionProbe[] {
  return catalog.map((descriptor) => {
    const provider = ROUTING_BACKED[descriptor.id];
    return provider ? routingProbe(descriptor, provider) : factProbe(descriptor);
  });
}

/* ------------------------------------------------------------------ */
/* Assessment                                                          */
/* ------------------------------------------------------------------ */

export interface AssessConnectionsOptions {
  catalog?: readonly ConnectionDescriptor[];
  probes?: readonly ConnectionProbe[];
  /** Timestamp recorded as `lastVerifiedAt`. Injected so renders stay reproducible. */
  now: string;
}

/**
 * Merge catalogue and evidence into the displayable status list.
 *
 * Three invariants are enforced here rather than left to each probe, so a
 * future third-party adapter cannot weaken them:
 *
 *   - a descriptor with no probe is `not_connected` and never verified;
 *   - a probe that throws yields `error`, not a silent omission;
 *   - `effectiveCapabilities` is emptied unless the state is genuinely usable,
 *     so an over-eager adapter cannot promote advertised capabilities into
 *     granted ones.
 */
export function assessConnections(
  env: SecretsEnv,
  options: AssessConnectionsOptions,
): ConnectionStatus[] {
  const catalog = options.catalog ?? CONNECTION_CATALOG;
  const probes = new Map((options.probes ?? defaultConnectionProbes(catalog)).map((p) => [p.id, p]));

  return catalog.map((descriptor) => {
    const probe = probes.get(descriptor.id);
    let evidence: ConnectionEvidence;
    if (!probe) {
      evidence = {
        state: 'not_connected',
        observedFacts: [],
        missingFacts: [...descriptor.requiredFacts],
        effectiveCapabilities: [],
        lastVerifiedAt: null,
        evidenceSource: 'no probe registered',
        reason:
          `${descriptor.displayName}: catalogued but never probed. A catalogue entry is not ` +
          'evidence of a connection.',
      };
    } else {
      try {
        evidence = probe.probe(env, options.now);
      } catch (error) {
        evidence = {
          state: 'error',
          observedFacts: [],
          missingFacts: [...descriptor.requiredFacts],
          effectiveCapabilities: [],
          lastVerifiedAt: options.now,
          evidenceSource: `probe ${descriptor.id} threw`,
          reason: `${descriptor.displayName}: connection probe failed (${(error as Error).message}).`,
        };
      }
    }

    const usable = evidence.state === 'connected' || evidence.state === 'local_only';
    return {
      ...descriptor,
      state: evidence.state,
      observedFacts: evidence.observedFacts,
      missingFacts: evidence.missingFacts,
      // Advertised never becomes granted without evidence.
      effectiveCapabilities: usable ? evidence.effectiveCapabilities : [],
      lastVerifiedAt: evidence.lastVerifiedAt,
      evidenceSource: evidence.evidenceSource,
      reason: evidence.reason,
      canRecheck: descriptor.recheckable && probe != null,
      canDisconnect: descriptor.revocable,
    };
  });
}

/** Counts for the Connection Center header. */
export function connectionSummary(statuses: readonly ConnectionStatus[]): Record<ConnectionState, number> {
  const counts = {
    connected: 0,
    local_only: 0,
    not_connected: 0,
    expired: 0,
    error: 0,
    setup_required: 0,
  } satisfies Record<ConnectionState, number>;
  for (const status of statuses) counts[status.state] += 1;
  return counts;
}
