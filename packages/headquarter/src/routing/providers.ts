/**
 * JENIFY multi-AI provider registry — the SINGLE source of truth for who may
 * execute an AI task.
 *
 * Why this exists: the previous bridge assumed every `[AI TASK]` belonged to
 * Claude. Its guard was `startsWith('[AI TASK]') && !startsWith('[AI TASK][GEMINI]')`,
 * so a task tagged for ANY other provider — `[CODEX]`, `[JULES]`, `[XAI]` — matched
 * and fired the Claude routine. Claude then correctly refused to impersonate the
 * requested provider, and the task silently stalled.
 *
 * The rule this registry enforces: a provider may only execute when it has a
 * REAL executor and REAL credentials. Everything else fails closed. Declaring a
 * provider here does NOT make it connected — connectivity is derived from the
 * facts actually observed in the environment at run time.
 *
 * Two kinds of executor exist, and the difference is load-bearing:
 *
 *   'github-workflow'  runs on a GitHub-hosted runner. Its credentials are
 *                      GitHub Actions secrets (`requiredSecrets`).
 *   'local-cli'        runs on the Founder workstation via an installed CLI
 *                      holding its own local session. It has NO GitHub secret,
 *                      so it is deliberately NOT connected inside CI — a
 *                      GitHub Actions run fails closed for that provider
 *                      instead of pretending it ran.
 *
 * `requiredLocalFacts` are NON-SECRET observations (a CLI path, an auth mode
 * name) produced by a probe on the machine that will execute. Secret VALUES
 * never enter routing: presence is all routing needs.
 */

export const PROVIDERS = [
  'CLAUDE',
  'GEMINI',
  'CODEX',
  'JULES',
  'XAI',
  'MICROSOFT',
  'META',
  'MISTRAL',
  'QWEN',
  'DEEPSEEK',
  'LOCAL',
  'CUSTOM',
  'JENIFY',
] as const;

export type ProviderId = (typeof PROVIDERS)[number];

/**
 * Roles are deliberately SEPARATE from provider identity (requirement F): the
 * Founder can move `REVIEWER` from Codex to Gemini without touching routing.
 */
export const ROLES = ['MANAGER', 'BUILDER', 'REVIEWER', 'RESEARCHER'] as const;
export type Role = (typeof ROLES)[number];

/** Where a provider's execution physically happens. */
export type ExecutorKind = 'github-workflow' | 'local-cli';

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /**
   * GitHub Actions secrets that must all be present and non-empty for a
   * 'github-workflow' provider to be considered connected. An empty list alone
   * is NOT enough — `executor` must also exist, otherwise there is nothing to
   * run.
   */
  requiredSecrets: string[];
  /**
   * Non-secret environment facts that must all be present for a 'local-cli'
   * provider to be considered connected (e.g. CODEX_CLI_PATH, CODEX_AUTH_MODE).
   * Absent inside GitHub Actions by design, so a local provider fails closed
   * there rather than being silently replaced.
   */
  requiredLocalFacts: string[];
  /**
   * The workflow file or local entry point that genuinely executes this
   * provider, or null when no execution mechanism exists.
   * null => permanently fail closed.
   */
  executor: string | null;
  /** How `executor` runs. null exactly when `executor` is null. */
  executorKind: ExecutorKind | null;
  /**
   * Marker that this provider's own result comments carry. Used to guarantee a
   * worker's report can never re-trigger that same worker.
   */
  resultMarker: string | null;
  /**
   * True when this provider's executor workflow is triggered for EVERY
   * `[AI TASK]` issue, not only for tasks addressed to it.
   *
   * This is a statement of fact about the workflow's pre-gate, and it is what
   * makes a provider eligible to post the SHARED routing-blocked notice on
   * behalf of a provider that has no workflow of its own (a `local-cli`
   * provider observes nothing in CI and can never report its own block).
   *
   * Exactly one eligible provider is chosen as the reporter for any given
   * decision — see `blockedReportOwner` in route.ts — so a blocked provider is
   * reported once rather than once per workflow that happened to wake up.
   */
  observesAllAiTasks: boolean;
  /** Human-readable note shown when the provider is unavailable. */
  note?: string;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderDef> = {
  CLAUDE: {
    id: 'CLAUDE',
    label: 'Claude (claude.ai Routine — AI WORKERS)',
    requiredSecrets: ['CLAUDE_ROUTINE_URL', 'CLAUDE_ROUTINE_TOKEN'],
    requiredLocalFacts: [],
    executor: '.github/workflows/ai-task-trigger.yml',
    executorKind: 'github-workflow',
    resultMarker: 'jenify-claude-result',
    // ai-task-trigger.yml pre-gates on `startsWith(title, '[AI TASK]')`, so it
    // wakes for every AI task regardless of which provider was requested.
    observesAllAiTasks: true,
  },
  GEMINI: {
    id: 'GEMINI',
    label: 'Gemini (AI Studio, billing-disabled key)',
    requiredSecrets: ['GEMINI_API_KEY'],
    requiredLocalFacts: [],
    executor: '.github/workflows/ai-task-gemini.yml',
    executorKind: 'github-workflow',
    resultMarker: 'jenify-gemini-result',
    // ai-task-gemini.yml carries the same catch-all pre-gate.
    observesAllAiTasks: true,
  },
  CODEX: {
    id: 'CODEX',
    label: 'Codex (OpenAI Codex CLI — existing ChatGPT subscription session)',
    requiredSecrets: [],
    requiredLocalFacts: ['CODEX_CLI_PATH', 'CODEX_AUTH_MODE'],
    executor: 'packages/headquarter/src/cli/codex-review.ts',
    executorKind: 'local-cli',
    resultMarker: 'jenify-codex-result',
    // Local CLI: nothing of Codex's runs in CI, so it can never report itself.
    observesAllAiTasks: false,
    note:
      'Codex executes on the Founder workstation through the installed Codex CLI using the ' +
      'existing ChatGPT subscription session (no API key, no new paid service). It is NOT ' +
      'available to GitHub-hosted runners, so a GitHub Actions run fails closed for CODEX ' +
      'instead of substituting another provider.',
  },
  JULES: {
    id: 'JULES',
    label: 'Jules (Google independent engineer)',
    requiredSecrets: [],
    requiredLocalFacts: ['JULES_CLI_PATH'],
    executor: 'jules (npm @google/jules CLI)',
    executorKind: 'local-cli',
    resultMarker: 'jenify-jules-result',
    observesAllAiTasks: false,
    note:
      'Jules is driven from the Founder workstation, or opens its own review PR directly on ' +
      'GitHub. It has no GitHub Actions credential, so CI fails closed for JULES.',
  },
  XAI: { id: 'XAI', label: 'xAI / Grok', requiredSecrets: ['XAI_API_KEY'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-xai-result', observesAllAiTasks: false },
  MICROSOFT: { id: 'MICROSOFT', label: 'Microsoft / Copilot', requiredSecrets: ['MICROSOFT_AI_KEY'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-microsoft-result', observesAllAiTasks: false },
  META: { id: 'META', label: 'Meta / Llama', requiredSecrets: ['META_AI_KEY'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-meta-result', observesAllAiTasks: false },
  MISTRAL: { id: 'MISTRAL', label: 'Mistral', requiredSecrets: ['MISTRAL_API_KEY'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-mistral-result', observesAllAiTasks: false },
  QWEN: { id: 'QWEN', label: 'Qwen', requiredSecrets: ['QWEN_API_KEY'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-qwen-result', observesAllAiTasks: false },
  DEEPSEEK: { id: 'DEEPSEEK', label: 'DeepSeek', requiredSecrets: ['DEEPSEEK_API_KEY'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-deepseek-result', observesAllAiTasks: false },
  LOCAL: { id: 'LOCAL', label: 'Local / self-hosted model', requiredSecrets: ['LOCAL_MODEL_ENDPOINT'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-local-result', observesAllAiTasks: false },
  CUSTOM: { id: 'CUSTOM', label: 'Custom provider', requiredSecrets: ['CUSTOM_AI_ENDPOINT'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-custom-result', observesAllAiTasks: false },
  JENIFY: { id: 'JENIFY', label: 'Future JENIFY AI', requiredSecrets: ['JENIFY_AI_ENDPOINT'], requiredLocalFacts: [], executor: null, executorKind: null, resultMarker: 'jenify-jenify-result', observesAllAiTasks: false },
};

/** Every result marker in the registry — nothing carrying one may re-trigger. */
export const ALL_RESULT_MARKERS: string[] = Object.values(PROVIDER_REGISTRY)
  .map((p) => p.resultMarker)
  .filter((m): m is string => m != null);

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDERS as readonly string[]).includes(value);
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Facts available to a run: name -> value. Empty/blank counts as absent.
 * Holds BOTH secret-presence flags and non-secret local facts; routing never
 * receives a real secret value.
 */
export type SecretsEnv = Record<string, string | undefined>;

export interface ConnectivityReport {
  provider: ProviderId;
  connected: boolean;
  hasExecutor: boolean;
  executorKind: ExecutorKind | null;
  missingSecrets: string[];
  /** Missing non-secret local facts (local-cli providers). */
  missingLocalFacts: string[];
  reason: string;
}

function absent(env: SecretsEnv, name: string): boolean {
  const v = env[name];
  return v == null || String(v).trim() === '';
}

/**
 * Is this provider genuinely able to execute right now?
 *
 * Connectivity is NEVER assumed or hard-coded to true: it requires a real
 * executor plus every required secret AND every required local fact actually
 * observed in the supplied environment.
 */
export function providerConnectivity(provider: ProviderId, secrets: SecretsEnv): ConnectivityReport {
  const def = PROVIDER_REGISTRY[provider];
  const hasExecutor = def.executor != null;
  const missingSecrets = def.requiredSecrets.filter((s) => absent(secrets, s));
  const missingLocalFacts = def.requiredLocalFacts.filter((s) => absent(secrets, s));
  const connected = hasExecutor && missingSecrets.length === 0 && missingLocalFacts.length === 0;

  const suffix = def.note ? ` ${def.note}` : '';
  let reason: string;
  if (connected) {
    reason = `${def.label} is connected.`;
  } else if (!hasExecutor) {
    reason = `${provider} NOT CONNECTED — no execution mechanism exists.${suffix}`;
  } else if (missingSecrets.length > 0) {
    reason = `${provider} NOT CONNECTED — missing credential(s): ${missingSecrets.join(', ')}.`;
  } else {
    reason =
      `${provider} NOT CONNECTED — its executor is a local CLI and the required local fact(s) ` +
      `were not observed here: ${missingLocalFacts.join(', ')}.${suffix}`;
  }
  return {
    provider,
    connected,
    hasExecutor,
    executorKind: def.executorKind,
    missingSecrets,
    missingLocalFacts,
    reason,
  };
}

export function connectedProviders(secrets: SecretsEnv): ProviderId[] {
  return PROVIDERS.filter((p) => providerConnectivity(p, secrets).connected);
}
