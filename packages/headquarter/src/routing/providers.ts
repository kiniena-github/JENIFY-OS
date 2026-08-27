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
 * secrets actually present in the environment at run time.
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

export interface ProviderDef {
  id: ProviderId;
  label: string;
  /**
   * Every one of these must be present and non-empty for the provider to be
   * considered connected. An empty list alone is NOT enough — `executor` must
   * also exist, otherwise there is nothing to run.
   */
  requiredSecrets: string[];
  /**
   * The workflow file that genuinely executes this provider, or null when no
   * execution mechanism exists. null => permanently fail closed.
   */
  executor: string | null;
  /**
   * Marker that this provider's own result comments carry. Used to guarantee a
   * worker's report can never re-trigger that same worker.
   */
  resultMarker: string | null;
  /** Human-readable note shown when the provider is unavailable. */
  note?: string;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderDef> = {
  CLAUDE: {
    id: 'CLAUDE',
    label: 'Claude (claude.ai Routine — AI WORKERS)',
    requiredSecrets: ['CLAUDE_ROUTINE_URL', 'CLAUDE_ROUTINE_TOKEN'],
    executor: '.github/workflows/ai-task-trigger.yml',
    resultMarker: 'jenify-claude-result',
  },
  GEMINI: {
    id: 'GEMINI',
    label: 'Gemini (AI Studio, billing-disabled key)',
    requiredSecrets: ['GEMINI_API_KEY'],
    executor: '.github/workflows/ai-task-gemini.yml',
    resultMarker: 'jenify-gemini-result',
  },
  CODEX: {
    id: 'CODEX',
    label: 'Codex / OpenAI',
    requiredSecrets: ['CODEX_API_KEY'],
    executor: null,
    resultMarker: 'jenify-codex-result',
    note: 'No Codex execution workflow exists and no Codex credential is configured. Tasks tagged [CODEX] fail closed and are NEVER re-routed to another provider.',
  },
  JULES: {
    id: 'JULES',
    label: 'Jules (Google independent engineer)',
    requiredSecrets: ['JULES_API_KEY'],
    executor: null,
    resultMarker: 'jenify-jules-result',
    note: 'Jules currently works from GitHub directly; there is no automated execution route.',
  },
  XAI: { id: 'XAI', label: 'xAI / Grok', requiredSecrets: ['XAI_API_KEY'], executor: null, resultMarker: 'jenify-xai-result' },
  MICROSOFT: { id: 'MICROSOFT', label: 'Microsoft / Copilot', requiredSecrets: ['MICROSOFT_AI_KEY'], executor: null, resultMarker: 'jenify-microsoft-result' },
  META: { id: 'META', label: 'Meta / Llama', requiredSecrets: ['META_AI_KEY'], executor: null, resultMarker: 'jenify-meta-result' },
  MISTRAL: { id: 'MISTRAL', label: 'Mistral', requiredSecrets: ['MISTRAL_API_KEY'], executor: null, resultMarker: 'jenify-mistral-result' },
  QWEN: { id: 'QWEN', label: 'Qwen', requiredSecrets: ['QWEN_API_KEY'], executor: null, resultMarker: 'jenify-qwen-result' },
  DEEPSEEK: { id: 'DEEPSEEK', label: 'DeepSeek', requiredSecrets: ['DEEPSEEK_API_KEY'], executor: null, resultMarker: 'jenify-deepseek-result' },
  LOCAL: { id: 'LOCAL', label: 'Local / self-hosted model', requiredSecrets: ['LOCAL_MODEL_ENDPOINT'], executor: null, resultMarker: 'jenify-local-result' },
  CUSTOM: { id: 'CUSTOM', label: 'Custom provider', requiredSecrets: ['CUSTOM_AI_ENDPOINT'], executor: null, resultMarker: 'jenify-custom-result' },
  JENIFY: { id: 'JENIFY', label: 'Future JENIFY AI', requiredSecrets: ['JENIFY_AI_ENDPOINT'], executor: null, resultMarker: 'jenify-jenify-result' },
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

/** Secrets available to a run: name -> value. Empty/blank counts as absent. */
export type SecretsEnv = Record<string, string | undefined>;

export interface ConnectivityReport {
  provider: ProviderId;
  connected: boolean;
  hasExecutor: boolean;
  missingSecrets: string[];
  reason: string;
}

/**
 * Is this provider genuinely able to execute right now?
 *
 * Connectivity is NEVER assumed or hard-coded to true: it requires both a real
 * executor workflow and every required secret actually present.
 */
export function providerConnectivity(provider: ProviderId, secrets: SecretsEnv): ConnectivityReport {
  const def = PROVIDER_REGISTRY[provider];
  const hasExecutor = def.executor != null;
  const missingSecrets = def.requiredSecrets.filter((s) => {
    const v = secrets[s];
    return v == null || String(v).trim() === '';
  });
  const connected = hasExecutor && missingSecrets.length === 0;
  let reason: string;
  if (connected) {
    reason = `${def.label} is connected.`;
  } else if (!hasExecutor) {
    reason = `${provider} NOT CONNECTED — no execution mechanism exists.${def.note ? ` ${def.note}` : ''}`;
  } else {
    reason = `${provider} NOT CONNECTED — missing credential(s): ${missingSecrets.join(', ')}.`;
  }
  return { provider, connected, hasExecutor, missingSecrets, reason };
}

export function connectedProviders(secrets: SecretsEnv): ProviderId[] {
  return PROVIDERS.filter((p) => providerConnectivity(p, secrets).connected);
}
