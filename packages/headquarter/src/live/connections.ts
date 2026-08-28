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
 * ## Presence is configuration; connectivity has to be checked
 *
 * The second rule, added after the PR #201 review: observing that a
 * credential-shaped environment variable is SET is evidence that somebody
 * configured the integration, and nothing more. It does not establish that the
 * credential is valid, unexpired, unrevoked, well-formed, or pointed at the
 * right project. So a generic integration whose facts are all present is
 * `configured`, not `connected`, and it grants no capability. Only a verifying
 * method — the routing lane's dispatch contract, or a real live check — can
 * support a claim of connectivity, and `assessConnections` downgrades any probe
 * that claims otherwise.
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
 * Connection state.
 *
 * `local_only` is load-bearing rather than cosmetic: a Codex CLI holding a live
 * subscription session on the Founder workstation is genuinely usable there and
 * genuinely unavailable to a GitHub-hosted runner or a hosted preview, and
 * flattening that into "connected" is exactly the lie that made the old bridge
 * stall silently.
 *
 * `configured` is the state this module was missing (issue #200, Codex P1 #4).
 * Observing that `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set says somebody
 * configured Supabase; it does not say the credential is valid, unexpired,
 * unrevoked, well-formed, or pointed at the right project. Reporting that as
 * `connected` — and granting the integration's advertised capabilities on the
 * strength of it — was a descriptor-shaped claim wearing evidence's clothes.
 * Credential PRESENCE is setup evidence. `connected` now requires a
 * provider-specific verification that actually succeeded.
 *
 * `dispatchable` is the state the round-3 review found missing above it (Codex
 * round-3 P1 #3). The routing lane's dispatch contract — an executor exists AND
 * every fact it needs is present — is genuinely stronger than bare credential
 * presence: it is what HQ consults before it will route work at all. But it is
 * still an inventory of what is present locally, and cannot tell an expired,
 * revoked, malformed or wrong-project credential from a good one, because it
 * never asks the provider anything. Calling that `connected` and handing over
 * the integration's advertised capabilities read as "verified reachable" to
 * anyone looking at the page. So routing evidence now tops out at
 * `dispatchable`: HQ may dispatch to it, nothing has confirmed it answers, and
 * no capability is granted. `connected` (and `local_only`) means one thing
 * only — a live check ran and succeeded.
 */
export type ConnectionState =
  | 'connected'
  | 'local_only'
  | 'dispatchable'
  | 'configured'
  | 'not_connected'
  | 'expired'
  | 'error'
  | 'setup_required';

export const CONNECTION_STATE_LABELS: Record<ConnectionState, string> = {
  connected: 'Connected',
  local_only: 'Local-only',
  dispatchable: 'Dispatchable — unverified',
  configured: 'Configured — unverified',
  not_connected: 'Not connected',
  expired: 'Expired',
  error: 'Error',
  setup_required: 'Setup required',
};

/**
 * How a state was established. Carried on every status so a reader can see
 * what kind of claim is being made, not just the word.
 *
 *   none            nothing was observed at all
 *   configuration   required facts were observed present — setup evidence only
 *   routing_contract the routing lane's own dispatch contract was satisfied:
 *                   an executor genuinely exists AND every fact it needs to
 *                   dispatch is present. This is the same computation the
 *                   router uses to decide it may dispatch — so a page that
 *                   disagreed about DISPATCHABILITY would be the thing that is
 *                   wrong — but it asks the provider nothing, so it cannot
 *                   establish connectivity (Codex round-3 P1 #3).
 *   live_check      a provider-specific check ran against the service and
 *                   returned an answer
 */
export type VerificationMethod = 'none' | 'configuration' | 'routing_contract' | 'live_check';

/** What a verification actually found. Precise words, not a boolean. */
export type VerificationOutcome =
  | 'verified'
  | 'not_attempted'
  | 'expired'
  | 'revoked'
  | 'malformed'
  | 'wrong_project'
  | 'unreachable'
  | 'failed';

/**
 * Methods that may support a `connected`/`local_only` state and grant
 * capabilities. Exactly one qualifies: a check that actually asked the
 * provider. Routing evidence proves dispatchability, not connectivity, and is
 * downgraded in `assessConnections` rather than trusted here.
 */
const VERIFYING_METHODS: readonly VerificationMethod[] = ['live_check'];

/** Methods that may support `dispatchable` — a weaker, honestly-named claim. */
const DISPATCH_METHODS: readonly VerificationMethod[] = ['routing_contract'];

/*
 * The three vocabularies a probe answers in, written as exhaustive records so
 * TypeScript refuses to compile a new member that is not listed here. A plain
 * array would let the enum grow past its own validator in silence, which is
 * the failure mode these guards exist to prevent.
 *
 * `options.probes` accepts arbitrary adapters, and `outcome` became an
 * execution-authority input in this round (a check that RAN is not a check
 * that SUCCEEDED). A value outside the vocabulary is therefore no longer a
 * display curiosity: it is an unknown, and unknowns fail closed here like
 * every other unknown in the control plane.
 */
const KNOWN_STATES: Record<ConnectionState, true> = {
  connected: true,
  local_only: true,
  dispatchable: true,
  configured: true,
  not_connected: true,
  expired: true,
  error: true,
  setup_required: true,
};

const KNOWN_METHODS: Record<VerificationMethod, true> = {
  none: true,
  configuration: true,
  routing_contract: true,
  live_check: true,
};

const KNOWN_OUTCOMES: Record<VerificationOutcome, true> = {
  verified: true,
  not_attempted: true,
  expired: true,
  revoked: true,
  malformed: true,
  wrong_project: true,
  unreachable: true,
  failed: true,
};

function known<T extends string>(vocabulary: Record<T, true>, value: unknown): value is T {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(vocabulary, value);
}

/**
 * Describe an unrecognised probe answer for a reason string, WITHOUT
 * serialising it.
 *
 * This used to be `JSON.stringify(value)`, which copied an object's property
 * VALUES into the reason — and `reason` is published to the browser. That
 * defeated both halves of the boundary guard at once (issue #200, Codex
 * exact-head finding on `7a1c21d`): an outcome of
 * `{ password: 'ordinary-secret' }` became the flat string
 * `{"password":"ordinary-secret"}`, so `assertBrowserSafe` no longer saw
 * `password` as a credential-holder KEY — there was no key left, only text —
 * and its `key: value` heuristic missed it too, because JSON puts a quote
 * between the key and the colon. A guard written to stop exactly this was
 * walked straight past by the diagnostic that was supposed to be helping.
 *
 * So nothing structured is serialised at all now. A string is quoted, because
 * a string is the answer a real adapter bug gives — a typo'd vocabulary word —
 * and it stays a string, which the guard scans normally. Everything else is
 * reported by TYPE only: enough to tell an operator that the adapter returned
 * an object where a word belongs, and carrying none of what was inside it.
 * Diagnostics are worth having, but not at the price of being the leak.
 *
 * Bounded either way, because an adapter's string is still an adapter's
 * string. No `JSON.stringify`, so a circular value and a `BigInt` — both of
 * which made it THROW, defeating the fail-closed path it exists to serve —
 * are now simply described.
 */
const DESCRIBE_LIMIT = 60;

/**
 * Cap every description, whatever branch produced it.
 *
 * The bound used to apply to the string branch alone, so `String(value)` on a
 * numeric answer was unbounded — and a `BigInt` has no size limit. An adapter
 * returning `10n ** 200000n` put a 200,000-character diagnostic into `reason`
 * and from there into the rendered page (Codex P2 on `a6577af`, reproduced:
 * 200,171 characters). Bounded output was the stated guarantee; now it is the
 * enforced one.
 */
function bound(text: string): string {
  return text.length > DESCRIBE_LIMIT ? `${text.slice(0, DESCRIBE_LIMIT)}…` : text;
}

/**
 * Past this magnitude a BigInt is reported by size rather than converted.
 * Truncating afterwards would still pay for the decimal conversion of an
 * arbitrarily large integer, which is the other half of what that answer
 * costs — so the conversion never happens at all.
 */
const BIGINT_DESCRIBE_LIMIT = 10n ** BigInt(DESCRIBE_LIMIT);

function describeUnrecognised(value: unknown): string {
  // Bounded twice: once on the content, so a long answer is cut, and once on
  // the quoted form, since escaping can expand what survived.
  if (typeof value === 'string') return bound(JSON.stringify(bound(value)));
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'bigint') {
    const magnitude = value < 0n ? -value : value;
    return magnitude < BIGINT_DESCRIBE_LIMIT
      ? String(value)
      : `a bigint of more than ${DESCRIBE_LIMIT} digits`;
  }
  const type = typeof value;
  if (type === 'number' || type === 'boolean') return bound(String(value));
  // Object, function, symbol: the TYPE, never the contents.
  return `a value of type ${type}`;
}

/**
 * Everything wrong with one probe's answer, in the order a reader would want
 * it. Empty means the answer is readable — not that it is true, which is what
 * the invariants further down decide.
 *
 * Shape is checked as well as vocabulary because `options.probes` accepts
 * arbitrary adapters, and every field here is read by the invariants or
 * rendered by the Connection Center. A probe returning `null`, a string, or an
 * object whose `observedFacts` is not an array used to reach the renderer and
 * crash it — `.map is not a function`, `Cannot read properties of undefined` —
 * from a stack naming `escapeHtml` rather than the adapter responsible.
 */
function unreadableParts(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw == null) {
    return [`an answer that is not an object (${describeUnrecognised(raw)})`];
  }
  const evidence = raw as Record<string, unknown>;
  const parts: string[] = [];
  if (!known(KNOWN_STATES, evidence.state)) parts.push(`state ${describeUnrecognised(evidence.state)}`);
  if (!known(KNOWN_METHODS, evidence.verification)) {
    parts.push(`verification ${describeUnrecognised(evidence.verification)}`);
  }
  if (!known(KNOWN_OUTCOMES, evidence.outcome)) {
    parts.push(`outcome ${describeUnrecognised(evidence.outcome)}`);
  }
  for (const field of ['observedFacts', 'missingFacts', 'effectiveCapabilities'] as const) {
    const value = evidence[field];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
      parts.push(`${field} ${describeUnrecognised(value)}`);
    }
  }
  for (const field of ['evidenceSource', 'reason'] as const) {
    if (typeof evidence[field] !== 'string') parts.push(`${field} ${describeUnrecognised(evidence[field])}`);
  }
  const verifiedAt = evidence.lastVerifiedAt;
  if (verifiedAt != null && typeof verifiedAt !== 'string') {
    parts.push(`lastVerifiedAt ${describeUnrecognised(verifiedAt)}`);
  }
  return parts;
}

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
  /** How the state was established. `configuration` can never mean connected. */
  verification: VerificationMethod;
  /** What the verification found, in its own words. */
  outcome: VerificationOutcome;
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
  verification: VerificationMethod;
  outcome: VerificationOutcome;
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
 * The generic CONFIGURATION probe used by every catalogue entry that is not an
 * AI provider with its own routing definition.
 *
 * It answers exactly one question: has somebody supplied the facts this
 * integration needs? Its strongest possible verdict is therefore `configured`
 * — never `connected` — and it grants no capability at any state (issue #200,
 * Codex P1 #4). Turning `configured` into `connected` takes a
 * `ConnectionVerifier`: something that actually asks the service.
 *
 * `setup_required` is reserved for a *partially* configured integration —
 * some required facts present, others absent. That is a real, distinguishable
 * observation ("someone started wiring this up"), unlike using it as a softer
 * synonym for "not connected", which would overstate the state of an
 * integration nobody has touched.
 */
export function configurationProbe(descriptor: ConnectionDescriptor): ConnectionProbe {
  return {
    id: descriptor.id,
    probe(env, now) {
      const { observed, missing } = splitFacts(env, descriptor.requiredFacts);
      const source = `environment facts (presence only): ${descriptor.requiredFacts.join(', ')}`;
      if (missing.length === 0 && descriptor.requiredFacts.length > 0) {
        return {
          state: 'configured',
          verification: 'configuration',
          outcome: 'not_attempted',
          observedFacts: observed,
          missingFacts: missing,
          effectiveCapabilities: [],
          lastVerifiedAt: null,
          evidenceSource: source,
          reason:
            `${descriptor.displayName}: every required fact is present, so it is CONFIGURED. ` +
            'That is setup evidence, not connectivity: nothing here has checked whether the ' +
            'credential is valid, unexpired, unrevoked or pointed at the right project, so no ' +
            'capability is granted.',
        };
      }
      if (observed.length > 0) {
        return {
          state: 'setup_required',
          verification: 'configuration',
          outcome: 'not_attempted',
          observedFacts: observed,
          missingFacts: missing,
          effectiveCapabilities: [],
          lastVerifiedAt: null,
          evidenceSource: source,
          reason:
            `${descriptor.displayName}: partially configured — still missing ` +
            `${missing.join(', ')}. ${descriptor.setupHint}`,
        };
      }
      return {
        state: 'not_connected',
        verification: 'configuration',
        outcome: 'not_attempted',
        observedFacts: observed,
        missingFacts: missing,
        effectiveCapabilities: [],
        lastVerifiedAt: null,
        evidenceSource: source,
        reason: `${descriptor.displayName}: not connected — no required fact observed. ${descriptor.setupHint}`,
      };
    },
  };
}

/**
 * A provider-specific check that genuinely asks the service.
 *
 * V1 registers NONE of these: every real one would make a network call, and
 * this mission neither deploys nor enables a paid service. The seam exists so
 * that adding one is a new verifier plus a catalogue line — and so the
 * unverified states above are visibly the *absence* of one, rather than a
 * softened version of success.
 */
export interface ConnectionVerifier {
  /** Matches `ConnectionDescriptor.id`. */
  id: string;
  verify(
    env: SecretsEnv,
    now: string,
  ): {
    outcome: VerificationOutcome;
    /** What was checked and what came back. Never a credential value. */
    detail: string;
    /** Capabilities the check proved available. Ignored unless verified. */
    capabilities?: readonly string[];
  };
}

/** Outcome → state. Every non-verified outcome stays truthfully distinguishable. */
function stateForOutcome(outcome: VerificationOutcome, locality: ConnectionLocality): ConnectionState {
  switch (outcome) {
    case 'verified':
      return locality === 'local' ? 'local_only' : 'connected';
    case 'expired':
    case 'revoked':
      return 'expired';
    case 'not_attempted':
      return 'configured';
    default:
      // malformed / wrong_project / unreachable / failed — a real, named
      // failure, kept in `outcome` and spelled out in `reason`.
      return 'error';
  }
}

/**
 * Compose a configuration probe with a verifier: configuration first (a
 * verifier is not asked about an integration nobody has configured), then the
 * verifier's own answer.
 */
export function verifiedProbe(
  descriptor: ConnectionDescriptor,
  verifier: ConnectionVerifier,
): ConnectionProbe {
  const configuration = configurationProbe(descriptor);
  return {
    id: descriptor.id,
    probe(env, now) {
      const configured = configuration.probe(env, now);
      if (configured.state !== 'configured') return configured;
      const result = verifier.verify(env, now);
      const state = stateForOutcome(result.outcome, descriptor.locality);
      const verified = result.outcome === 'verified';
      return {
        state,
        verification: 'live_check',
        outcome: result.outcome,
        observedFacts: configured.observedFacts,
        missingFacts: configured.missingFacts,
        effectiveCapabilities: verified
          ? [...(result.capabilities ?? descriptor.advertisedCapabilities)]
          : [],
        // Only a check that SUCCEEDED leaves a verification instant behind.
        // This used to record `now` whatever the outcome, so an expired,
        // revoked, malformed or unreachable credential was stamped with the
        // moment it failed — and the Connection Center renders that field
        // under the label "Last verified". The most recently broken
        // credential then looked like the most recently checked healthy one,
        // which is the presence-equals-connected defect wearing a timestamp.
        // A failed check is still evidence, and it survives in `outcome` and
        // `reason`; what it is not is verification.
        lastVerifiedAt: verified ? now : null,
        evidenceSource: `verifier ${descriptor.id}`,
        reason: `${descriptor.displayName}: ${result.outcome} — ${result.detail}`,
      };
    },
  };
}

/**
 * Probe backed by `routing/providers.ts`, so an AI provider's Connection
 * Center row and its actual routability can never disagree. Reuses the
 * existing connectivity computation rather than re-deriving it.
 *
 * What it can and cannot establish (Codex round-3 P1 #3): `providerConnectivity`
 * is not a credential-presence heuristic — it is the routing lane's own
 * dispatch contract, requiring that an executor exist AND that every fact that
 * executor needs be present, and it is the exact computation the router
 * consults before dispatching. So a Connection Center that called a
 * dispatchable provider merely "configured" would be contradicting what HQ
 * actually does. But the contract asks the provider NOTHING: a revoked token, a
 * rotated secret and a working one are indistinguishable to it. It therefore
 * reports `dispatchable` — a real, named claim, above `configured` and below
 * `connected` — and grants no capability and leaves no verification timestamp.
 * Reaching `connected` takes a `ConnectionVerifier`.
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
        state = 'dispatchable';
      } else if (!report.hasExecutor) {
        // No execution mechanism exists at all: this is not something a
        // credential would fix, so it is not "setup required".
        state = 'not_connected';
      } else if (observed.length > 0) {
        state = 'setup_required';
      } else {
        state = 'not_connected';
      }
      return {
        state,
        verification: 'routing_contract',
        // Nothing was attempted against the provider itself, whatever the
        // dispatch contract says — so the outcome is `not_attempted`, and
        // there is no verification instant to record.
        outcome: 'not_attempted',
        observedFacts: observed,
        missingFacts: missing,
        // Advertised, never granted: no capability is available through a
        // connection nothing has checked.
        effectiveCapabilities: [],
        lastVerifiedAt: null,
        evidenceSource: `routing/providers.ts providerConnectivity(${provider})`,
        reason:
          state === 'dispatchable'
            ? `${report.reason} HQ may DISPATCH to ${provider} on this evidence; nothing has ` +
              'asked the provider whether the credential is valid, unexpired or unrevoked, so ' +
              'this is not a claim of connectivity and grants no capability.'
            : report.reason,
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

/**
 * Verifiers registered in V1: none.
 *
 * Stated as an empty seam rather than left implicit — every generic
 * integration therefore tops out at `configured`, which is the truth about
 * what HQ has actually established.
 */
export const DEFAULT_CONNECTION_VERIFIERS: readonly ConnectionVerifier[] = [];

/** Default probe set for the seeded catalogue. */
export function defaultConnectionProbes(
  catalog: readonly ConnectionDescriptor[] = CONNECTION_CATALOG,
  verifiers: readonly ConnectionVerifier[] = DEFAULT_CONNECTION_VERIFIERS,
): ConnectionProbe[] {
  const byId = new Map(verifiers.map((verifier) => [verifier.id, verifier]));
  return catalog.map((descriptor) => {
    const provider = ROUTING_BACKED[descriptor.id];
    if (provider) return routingProbe(descriptor, provider);
    const verifier = byId.get(descriptor.id);
    return verifier ? verifiedProbe(descriptor, verifier) : configurationProbe(descriptor);
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
 * Four invariants are enforced here rather than left to each probe, so a
 * future third-party adapter cannot weaken them:
 *
 *   - a descriptor with no probe is `not_connected` and never verified;
 *   - a probe that throws yields `error`, not a silent omission;
 *   - a probe claiming `connected`/`local_only` is DOWNGRADED here unless a
 *     live check actually established it (issue #200, Codex P1 #4 and round-3
 *     P1 #3): to `dispatchable` when the routing dispatch contract was
 *     satisfied, to `configured` otherwise. Credential presence is setup
 *     evidence and dispatchability is a local inventory; neither asked the
 *     provider anything, and only a check that did can support a claim of
 *     connectivity;
 *   - `effectiveCapabilities` is emptied unless the state is genuinely usable
 *     AND was established by a live check, so an over-eager adapter cannot
 *     promote advertised capabilities into granted ones;
 *   - `lastVerifiedAt` survives only a live check, so a page can never show a
 *     "last verified" instant for something nothing verified.
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
        verification: 'none',
        outcome: 'not_attempted',
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
          verification: 'none',
          outcome: 'failed',
          observedFacts: [],
          missingFacts: [...descriptor.requiredFacts],
          effectiveCapabilities: [],
          lastVerifiedAt: options.now,
          evidenceSource: `probe ${descriptor.id} threw`,
          reason: `${descriptor.displayName}: connection probe failed (${(error as Error).message}).`,
        };
      }
    }

    // An answer HQ cannot read is an unknown, and unknowns fail closed.
    //
    // Every invariant below reads `state`, `verification` and `outcome`, and
    // the Connection Center renders the fact lists, the reason and the
    // evidence source. All of it arrives from an adapter this layer does not
    // control, and all of it used to be forwarded verbatim. A state of
    // `'totally_fine'` therefore reached the page, where it has no label and
    // no tone; an `observedFacts` that was not an array reached it too. Both
    // threw a TypeError from a stack naming `escapeHtml` — so one bad probe
    // took down the whole site build with an error pointing at the wrong
    // place, and a probe returning `null` outright threw here before the row
    // existed at all.
    //
    // None of it could forge a connection: an unknown state is not
    // `connected` and an unknown outcome is not `verified`, so the security
    // question already failed closed. This is the honesty and robustness
    // half — "fail closed on unknown" is the rule everywhere else in this
    // control plane, and an unknown that crashes the renderer is not failing
    // closed, it is failing loudly in the wrong place. The one layer
    // documented as enforcing the probe invariants centrally is where it
    // belongs.
    //
    // Shape and vocabulary are one decision, not two: an answer that is
    // unreadable in any respect is reported as `error` in full rather than
    // part-repaired, because a half-understood answer is exactly the kind of
    // thing that later reads as a claim. The offending values are quoted back
    // — bounded, since they came from an adapter — so the page names the
    // probe that did it. That text is published to the browser, so it passes
    // through the boundary guard in front of the rendered connections: an
    // unreadable answer carrying credential material makes the site refuse
    // rather than publish.
    const unreadable = unreadableParts(evidence);
    if (unreadable.length > 0) {
      evidence = {
        state: 'error',
        verification: 'none',
        outcome: 'failed',
        observedFacts: [],
        missingFacts: [...descriptor.requiredFacts],
        effectiveCapabilities: [],
        lastVerifiedAt: null,
        evidenceSource: `probe ${descriptor.id} returned an answer HQ cannot read`,
        reason:
          `${descriptor.displayName}: the connection probe returned ${unreadable.join(', ')}. ` +
          'An answer HQ cannot read establishes nothing, so it is reported as an error rather ' +
          'than shown as a connection.',
      };
    }

    // A claim of connectivity is only as good as the method behind it.
    // Neither configuration nor the routing dispatch contract asked the
    // provider anything, so neither can support one: the claim is downgraded
    // here rather than trusted — the invariant holds for every probe,
    // including ones written later by somebody else — to the strongest state
    // the method it DID use can honestly carry.
    //
    // A live check that RAN is not the same as one that SUCCEEDED, and the
    // method alone used to be enough here. `options.probes` accepts arbitrary
    // adapters, so a probe could return `verification: 'live_check'` with
    // `state: 'connected'` and an outcome of `failed`, `expired` or
    // `unreachable`, and this layer — the one place the invariant is supposed
    // to be enforced centrally — granted its capabilities and stamped it
    // verified. The outcome is now part of the test: verification means a
    // check ran AND came back verified. `verifiedProbe` already derived its
    // own state from the outcome, so this changes nothing for it; it closes
    // the door for every adapter written later, which is the point of
    // enforcing it here rather than in each probe.
    const verifiedOutcome = evidence.outcome === 'verified';
    const checked = VERIFYING_METHODS.includes(evidence.verification);
    const verifying = checked && verifiedOutcome;
    const dispatchOnly = DISPATCH_METHODS.includes(evidence.verification);
    const claimsUsable = evidence.state === 'connected' || evidence.state === 'local_only';
    // A usable claim that no verified check supports is downgraded to the
    // strongest honest state. When a check DID run and did not come back
    // verified, the honest state is the one its own outcome implies —
    // `expired` for expired/revoked, `error` for a named failure — not the
    // `configured` that would suggest nothing had been tried.
    const state: ConnectionState = claimsUsable && !verifying
      ? checked
        ? stateForOutcome(evidence.outcome, descriptor.locality)
        : dispatchOnly
          ? 'dispatchable'
          : 'configured'
      : evidence.state;
    const usable = (state === 'connected' || state === 'local_only') && verifying;
    return {
      ...descriptor,
      state,
      verification: evidence.verification,
      outcome: evidence.outcome,
      observedFacts: evidence.observedFacts,
      missingFacts: evidence.missingFacts,
      // Advertised never becomes granted without a check that came back
      // verified.
      effectiveCapabilities: usable ? evidence.effectiveCapabilities : [],
      // "Verified" means a check ran AND succeeded. Configuration verifies
      // nothing, and a check that failed verified nothing either, so neither
      // leaves a verification timestamp behind.
      lastVerifiedAt: verifying ? evidence.lastVerifiedAt : null,
      evidenceSource: evidence.evidenceSource,
      reason:
        claimsUsable && !verifying
          ? `${evidence.reason} (Reported as ${state.toUpperCase()} rather ` +
            `than connected: ${
              checked
                ? `a live check ran and came back ${evidence.outcome}, which establishes ` +
                  'no connection'
                : `the claim rested on ${
                    dispatchOnly ? 'the routing dispatch contract' : 'configuration'
                  } alone, which shows what is present here and never asks the provider itself`
            }.)`
          : evidence.reason,
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
    dispatchable: 0,
    configured: 0,
    not_connected: 0,
    expired: 0,
    error: 0,
    setup_required: 0,
  } satisfies Record<ConnectionState, number>;
  for (const status of statuses) counts[status.state] += 1;
  return counts;
}
