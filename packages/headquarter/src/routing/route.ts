import {
  ALL_RESULT_MARKERS,
  HQ_DISPATCH_MARKER,
  PROVIDERS,
  PROVIDER_REGISTRY,
  isProviderId,
  isRole,
  providerConnectivity,
  type ProviderId,
  type Role,
  type SecretsEnv,
} from './providers.js';
import { DEFAULT_ROLE_ASSIGNMENTS, providerForRole, type RoleAssignments } from './assignments.js';

/**
 * Deterministic routing decisions for JENIFY AI tasks.
 *
 * Pure functions only: no network, no GitHub API, no side effects — so every
 * safety rule below is exhaustively testable without firing a real worker.
 */

// ---------------------------------------------------------------------------
// Task title grammar
// ---------------------------------------------------------------------------

/**
 * `[AI TASK]` (legacy, => CLAUDE)
 * `[AI TASK][GEMINI] ...`
 * `[AI TASK][CODEX][REVIEWER] ...`   provider and role are independent
 * `[AI TASK][BOTH] ...`              => CLAUDE + GEMINI (retained, deterministic)
 */
export interface ParsedTask {
  isAiTask: boolean;
  requestedProviders: ProviderId[];
  /**
   * True when the title named a provider outright. False when
   * `requestedProviders` only holds the legacy `[AI TASK]` => CLAUDE default,
   * which is what lets a role-only task be staffed from the assignment table
   * instead of silently going to Claude.
   */
  providerExplicit: boolean;
  role: Role | null;
  /** tags present in the title that are neither a provider nor a role */
  unknownTags: string[];
}

const TASK_PREFIX = '[AI TASK]';

export function parseTaskTitle(title: string): ParsedTask {
  const empty: ParsedTask = { isAiTask: false, requestedProviders: [], providerExplicit: false, role: null, unknownTags: [] };
  if (typeof title !== 'string') return empty;
  const trimmed = title.trim();
  if (!trimmed.toUpperCase().startsWith(TASK_PREFIX)) return empty;

  // collect the bracket tags that immediately follow the [AI TASK] prefix
  const rest = trimmed.slice(TASK_PREFIX.length);
  const tags: string[] = [];
  const tagRe = /^\s*\[([^\]]*)\]/;
  let cursor = rest;
  for (;;) {
    const m = tagRe.exec(cursor);
    if (!m) break;
    tags.push((m[1] ?? '').trim().toUpperCase());
    cursor = cursor.slice(m[0].length);
  }

  const requested: ProviderId[] = [];
  let role: Role | null = null;
  const unknownTags: string[] = [];
  for (const tag of tags) {
    if (tag === 'BOTH') {
      // deterministic, order-stable multi-provider fan-out
      for (const p of ['CLAUDE', 'GEMINI'] as ProviderId[]) {
        if (!requested.includes(p)) requested.push(p);
      }
    } else if (isProviderId(tag)) {
      if (!requested.includes(tag)) requested.push(tag);
    } else if (isRole(tag)) {
      role ??= tag;
    } else if (tag !== '') {
      unknownTags.push(tag);
    }
  }

  const providerExplicit = requested.length > 0;

  // legacy bare [AI TASK] with no provider tag => Claude, preserving today's
  // working behaviour exactly. A title that names a ROLE but no provider is
  // still recorded as CLAUDE here for backward compatibility; decideRouting is
  // what re-staffs it from the assignment table.
  if (requested.length === 0 && unknownTags.length === 0) requested.push('CLAUDE');

  return { isAiTask: true, requestedProviders: requested, providerExplicit, role, unknownTags };
}

// ---------------------------------------------------------------------------
// Re-trigger directive (comment-driven wake-up)
// ---------------------------------------------------------------------------

/**
 * A comment only wakes a worker when it carries this explicit machine-readable
 * directive. Ordinary discussion can never start AI work.
 *
 *   <!-- jenify-run -->             re-run using the task's own routing
 *   <!-- jenify-run: GEMINI -->     re-run, overriding the provider
 */
const RUN_DIRECTIVE_RE = /<!--\s*jenify-run\s*(?::\s*([A-Za-z0-9_,\s]+?)\s*)?-->/i;

export interface ParsedDirective {
  hasDirective: boolean;
  /** providers named on the directive itself, if any */
  overrideProviders: ProviderId[];
  unknownOverrides: string[];
  /** true when the comment carries ANY provider's result marker */
  carriesResultMarker: boolean;
}

export function parseRunDirective(body: string | undefined | null): ParsedDirective {
  const text = typeof body === 'string' ? body : '';
  const carriesResultMarker = ALL_RESULT_MARKERS.some((m) => text.includes(m));
  const m = RUN_DIRECTIVE_RE.exec(text);
  if (!m) return { hasDirective: false, overrideProviders: [], unknownOverrides: [], carriesResultMarker };
  const overrideProviders: ProviderId[] = [];
  const unknownOverrides: string[] = [];
  if (m[1]) {
    for (const raw of m[1].split(',')) {
      const tag = raw.trim().toUpperCase();
      if (tag === '') continue;
      if (tag === 'BOTH') {
        for (const p of ['CLAUDE', 'GEMINI'] as ProviderId[]) {
          if (!overrideProviders.includes(p)) overrideProviders.push(p);
        }
      } else if (isProviderId(tag)) {
        if (!overrideProviders.includes(tag)) overrideProviders.push(tag);
      } else {
        unknownOverrides.push(tag);
      }
    }
  }
  return { hasDirective: true, overrideProviders, unknownOverrides, carriesResultMarker };
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

export type TriggerKind = 'issue_opened' | 'issue_labeled' | 'issue_comment' | 'manual_dispatch';

export interface RoutingRequest {
  trigger: TriggerKind;
  issueTitle: string;
  /** login of whoever caused the event */
  actorLogin: string;
  /** login of the account that OPENED the issue */
  issueAuthorLogin: string;
  repositoryOwner: string;
  /** true when the actor is a bot/app (e.g. github-actions[bot]) */
  actorIsBot?: boolean;
  /** comment body, for trigger === 'issue_comment' */
  commentBody?: string;
  /**
   * The ISSUE body, when the caller can supply it (issue #224, Codex P1 on
   * `2638796`).
   *
   * Read for one purpose only: to recognise an issue that HQ itself dispatched.
   * Such an issue carries a canonical task behind it, and the authority to run
   * that task lives in HQ's claim/approval/fence — not in this workflow. Absent,
   * the rule below simply does not fire, so callers that cannot supply a body
   * keep today's behaviour.
   */
  issueBody?: string;
  /** stable id used for duplicate suppression */
  dedupeKey?: string;
  secrets: SecretsEnv;
  /**
   * Current ROLE -> PROVIDER staffing. Only consulted when a task names a role
   * and no explicit provider. Defaults to DEFAULT_ROLE_ASSIGNMENTS, so callers
   * that do not care about staffing keep today's behaviour.
   */
  assignments?: RoleAssignments;
}

export type RoutingOutcome = 'ROUTE' | 'IGNORE' | 'BLOCKED';

export interface ProviderDecision {
  provider: ProviderId;
  connected: boolean;
  executor: string | null;
  reason: string;
}

export interface RoutingDecision {
  outcome: RoutingOutcome;
  /** providers that will actually be fired — empty unless outcome === 'ROUTE' */
  dispatchTo: ProviderId[];
  requestedProviders: ProviderId[];
  blocked: ProviderDecision[];
  role: Role | null;
  /**
   * True when the provider was chosen from the ROLE -> PROVIDER assignment
   * table rather than named in the task. Recorded so provenance can show that
   * the Founder's staffing decided this, not a hard-coded vendor.
   */
  staffedFromRole: boolean;
  /**
   * The ONE provider whose workflow must post the routing-blocked notice for
   * this decision, or null when there is nothing blocked to report.
   *
   * Every provider that `observesAllAiTasks` wakes up for every `[AI TASK]`
   * issue and computes this same decision. Without a single named owner they
   * would each post the same notice (spam); with the owner gate keyed on
   * outcome instead of on `blocked`, a partially-blocked ROUTE posted nothing
   * at all (silence). Naming the owner here — in the one tested decision both
   * workflows read — is what makes the report exactly-once.
   */
  blockedReportOwner: ProviderId | null;
  /**
   * Stable identity of THIS blocked notice: same issue + same blocked set =>
   * same key. The posted comment carries it, so a re-label, a re-dispatch or a
   * repeated comment can recognise its own earlier notice and not post it
   * twice — while a genuinely different block still gets reported.
   */
  blockedReportKey: string | null;
  reason: string;
  dedupeKey?: string;
}

/**
 * Which provider is responsible for posting the shared blocked notice?
 *
 * The first provider, in registry order, whose workflow observes every AI task.
 * Deliberately independent of connectivity and of who was requested: the notice
 * is posted with the repository's own GitHub token, so a provider missing its
 * OWN credential can still truthfully report that someone else is blocked. That
 * matters because the providers most likely to be blocked (`local-cli`: Codex,
 * Jules) have no CI workflow at all and can never report themselves.
 */
export function blockedReportOwnerFor(blocked: ProviderDecision[]): ProviderId | null {
  if (blocked.length === 0) return null;
  return PROVIDERS.find((p) => PROVIDER_REGISTRY[p].observesAllAiTasks) ?? null;
}

/** Stable per-issue identity for a blocked notice; see `blockedReportKey`. */
export function blockedReportKeyFor(blocked: ProviderDecision[]): string | null {
  if (blocked.length === 0) return null;
  return blocked
    .map((b) => b.provider)
    .slice()
    .sort()
    .join('+');
}

/** Human-readable blocked line, e.g. "ROUTING BLOCKED — CODEX NOT CONNECTED". */
export function blockedHeadline(provider: ProviderId): string {
  return `ROUTING BLOCKED — ${provider} NOT CONNECTED`;
}

export function decideRouting(req: RoutingRequest): RoutingDecision {
  const base = {
    requestedProviders: [] as ProviderId[],
    blocked: [] as ProviderDecision[],
    role: null as Role | null,
    dispatchTo: [] as ProviderId[],
    staffedFromRole: false,
    blockedReportOwner: null as ProviderId | null,
    blockedReportKey: null as string | null,
    dedupeKey: req.dedupeKey,
  };
  const assignments = req.assignments ?? DEFAULT_ROLE_ASSIGNMENTS;

  // ---- 1. the issue must be a routed AI task -----------------------------
  const parsed = parseTaskTitle(req.issueTitle);
  if (!parsed.isAiTask) {
    return { ...base, outcome: 'IGNORE', reason: 'Not an [AI TASK] issue.' };
  }

  // ---- 2. authorization --------------------------------------------------
  // The ISSUE must have been opened by the repository owner (unchanged rule),
  // and for a comment trigger the COMMENTER must be the owner too. A bot may
  // never start AI work, which is the outer guard against worker loops.
  if (req.issueAuthorLogin !== req.repositoryOwner) {
    return { ...base, outcome: 'IGNORE', reason: 'AI tasks must be opened by the repository owner.' };
  }
  if (req.actorIsBot) {
    return { ...base, outcome: 'IGNORE', reason: 'Bot actors may never trigger AI work.' };
  }
  if (req.trigger === 'issue_comment' && req.actorLogin !== req.repositoryOwner) {
    return { ...base, outcome: 'IGNORE', reason: 'Only the repository owner may re-trigger a task by comment.' };
  }

  // ---- 2b. an HQ-dispatched issue is not re-triggerable from here ---------
  //
  // Issue #224, Codex P1 on `2638796`. HQ's dispatch adapter publishes an
  // ordinary `[AI TASK]` issue, so once it exists this workflow keeps accepting
  // owner `jenify-run` comments and manual dispatches for it — forever. Every
  // one of those would start work that never passed through the canonical
  // boundary the whole lane exists to enforce: the claim, the single-use
  // approval, the fence, the dispatch history. One Founder approval could
  // authorise an unbounded number of sequential executions.
  //
  // Worse, a comment directive may name a provider, so `jenify-run: GEMINI` on
  // a CLAUDE-BOUND canonical task is provider substitution arriving through the
  // one door that does not check the binding — the exact thing this lane refuses
  // everywhere else.
  //
  // So a RE-trigger of an HQ-dispatched issue is refused here. `opened` is
  // untouched: that is the dispatch itself, and it is the only run HQ authorised.
  // Re-running such a task is a canonical act — a fresh Founder approval and a
  // fresh `hq:dispatch-claude` — never a comment.
  const hqDispatched = typeof req.issueBody === 'string' && req.issueBody.includes(HQ_DISPATCH_MARKER);
  if (hqDispatched && (req.trigger === 'issue_comment' || req.trigger === 'manual_dispatch')) {
    return {
      ...base,
      outcome: 'IGNORE',
      reason:
        'This issue was dispatched by JENIFY HQ for a canonical task. Its execution authority is ' +
        'the HQ claim, single-use approval and fence, which a comment or manual dispatch does not ' +
        'pass through — so re-triggering it here is refused. Re-run it with a fresh Founder ' +
        'approval and a fresh HQ dispatch.',
    };
  }

  // ---- 3. comment triggers need an explicit directive --------------------
  let requested = parsed.requestedProviders;
  let providerExplicit = parsed.providerExplicit;
  if (req.trigger === 'issue_comment') {
    const directive = parseRunDirective(req.commentBody);
    // A worker's own report must NEVER wake a worker, even if it quotes the
    // directive text while explaining it. Result marker wins over directive.
    if (directive.carriesResultMarker) {
      return { ...base, outcome: 'IGNORE', reason: 'Comment carries a worker result marker; result comments never re-trigger.' };
    }
    if (!directive.hasDirective) {
      return { ...base, outcome: 'IGNORE', reason: 'Ordinary comment without a <!-- jenify-run --> directive; no AI work started.' };
    }
    if (directive.unknownOverrides.length > 0) {
      return {
        ...base,
        outcome: 'BLOCKED',
        requestedProviders: [],
        reason: `Unknown provider(s) in run directive: ${directive.unknownOverrides.join(', ')}. Refusing to guess a provider.`,
      };
    }
    if (directive.overrideProviders.length > 0) {
      requested = directive.overrideProviders;
      providerExplicit = true;
    }
  }

  // ---- 4. unknown provider tags fail closed ------------------------------
  // ANY unrecognised tag in the routing region blocks the whole task, even when
  // a recognised provider sits beside it.
  //
  // Jules review of PR #153 (report PR #163) found this guard fail-OPEN: it
  // previously also required `parsed.requestedProviders.length === 0`, so
  // `[AI TASK][CLAUDE][CODEXX]` recognised CLAUDE, skipped the guard entirely
  // and fired Claude. A typo'd vendor tag is not a harmless extra word — it is
  // an instruction we did not understand, and the safe reading of an
  // instruction we did not understand is to run NO worker and say so. Refusing
  // to guess also protects the case the typo was meant to be: had `CODEXX`
  // been `CODEX`, the task wanted a second provider's share done, and running
  // only Claude would silently under-deliver while looking successful.
  if (parsed.unknownTags.length > 0) {
    return {
      ...base,
      outcome: 'BLOCKED',
      requestedProviders: [],
      reason:
        `Unrecognised routing tag(s): ${parsed.unknownTags.join(', ')}. ` +
        'Refusing to guess a provider; no worker was started.',
    };
  }

  // ---- 4b. staff a role-only task from the assignment table --------------
  // `[AI TASK][REVIEWER] ...` names a JOB, not a vendor. Whoever currently
  // holds REVIEWER does it. This is the mechanism that lets the Founder move a
  // role between providers with no architectural change — and the reason a
  // role-only task must NOT keep silently defaulting to Claude.
  let staffedFromRole = false;
  if (parsed.role != null && !providerExplicit) {
    requested = [providerForRole(parsed.role, assignments)];
    staffedFromRole = true;
  }

  // ---- 5. connectivity: every requested provider must be genuinely live ---
  const decisions: ProviderDecision[] = requested.map((p) => {
    const conn = providerConnectivity(p, req.secrets);
    return { provider: p, connected: conn.connected, executor: PROVIDER_REGISTRY[p].executor, reason: conn.reason };
  });
  const live = decisions.filter((d) => d.connected).map((d) => d.provider);
  const blocked = decisions.filter((d) => !d.connected);

  // FAIL CLOSED: a blocked provider is never silently swapped for a live one.
  // If ANY requested provider is unavailable the task is reported as blocked
  // for that provider; the remaining live providers still run their own share,
  // which keeps [BOTH] deterministic without ever impersonating the missing one.
  if (live.length === 0) {
    return {
      ...base,
      outcome: 'BLOCKED',
      requestedProviders: requested,
      blocked,
      role: parsed.role,
      staffedFromRole,
      blockedReportOwner: blockedReportOwnerFor(blocked),
      blockedReportKey: blockedReportKeyFor(blocked),
      reason: blocked.map((b) => `${blockedHeadline(b.provider)} — ${b.reason}`).join(' | '),
    };
  }

  return {
    ...base,
    outcome: 'ROUTE',
    dispatchTo: live,
    requestedProviders: requested,
    blocked,
    role: parsed.role,
    staffedFromRole,
    // A partially-blocked route reports too. Claude doing its own share is not
    // a reason to stay silent about the share nobody did.
    blockedReportOwner: blockedReportOwnerFor(blocked),
    blockedReportKey: blockedReportKeyFor(blocked),
    reason:
      blocked.length === 0
        ? `Routing to ${live.join(', ')}.`
        : `Routing to ${live.join(', ')}; ${blocked.map((b) => blockedHeadline(b.provider)).join(' | ')}.`,
  };
}

/**
 * Provenance record attached to every execution/result (requirement D).
 * `actualProvider`/`actualModel` are only ever filled from evidence returned by
 * the executing service — never assumed from what was requested.
 */
export interface ExecutionProvenance {
  issueNumber: number;
  requestedProvider: ProviderId;
  actualProvider: ProviderId | null;
  actualModel: string | null;
  role: Role | null;
  trigger: TriggerKind;
  sessionId: string | null;
  runId: string | null;
  status: 'dispatched' | 'completed' | 'blocked' | 'failed';
  timestamp: string;
  evidence: string | null;
}

export function renderProvenance(p: ExecutionProvenance): string {
  const rows: Array<[string, string]> = [
    ['Issue', `#${p.issueNumber}`],
    ['Requested provider', p.requestedProvider],
    ['Actual provider', p.actualProvider ?? '_unverified_'],
    ['Actual model', p.actualModel ?? '_unverified_'],
    ['Role', p.role ?? '_unset_'],
    ['Trigger', p.trigger],
    ['Session', p.sessionId ?? '_none_'],
    ['Run', p.runId ?? '_none_'],
    ['Status', p.status],
    ['Timestamp', p.timestamp],
    ['Evidence', p.evidence ?? '_none_'],
  ];
  return ['| Field | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join('\n');
}
