/**
 * GitHub ingestion connector (issue #140 / #123, HQ lane G).
 *
 * Read-first and pure: the caller performs the actual (read-only) GitHub read
 * — CLI, MCP tool, or a saved export — and hands the result here. This module
 * never opens a socket, never holds a token, and never mutates GitHub. That
 * keeps ingestion deterministic and testable, and makes it structurally
 * impossible for Headquarter to write to a repository through this lane.
 *
 * What it produces is an *evidence index*: for each issue, pull request or
 * commit, a record carrying the exact source-native identifier, the canonical
 * original URL, the source-side change marker and explicit confidence. The
 * GitHub objects themselves are never copied, edited or rewritten.
 *
 * Trust model: everything in the input is attacker-controllable except the
 * repository the caller chose to read. In particular a supplied `html_url` is
 * NOT trusted — it is checked against the item's own identifiers, and on any
 * disagreement the canonical URL is derived locally and an `identity_mismatch`
 * issue is raised. This stops a hostile export from turning an archived
 * "issue #140" row into a link to somebody else's site.
 */

import type { EvidenceItem } from '../archive/inventory.js';
import type { RelatedRefs } from '../archive/schema.js';
import {
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  assertNoSecretMaterial,
  classifyLocator,
  recordDigest,
  sanitizeText,
  scrubSecrets,
} from './safety.js';
import type {
  AccessDescriptor,
  Connector,
  ConnectorFailure,
  ConnectorIssue,
  ConnectorSnapshot,
  IndexRecord,
  PageInfo,
  Provenance,
  SourceConfidence,
} from './types.js';

/** Hosts whose URLs may become clickable links for GitHub evidence. */
export const GITHUB_HOSTS = ['github.com'] as const;

/** Least-privilege default: read scopes only, no write/admin scope. */
export const GITHUB_READ_ACCESS: AccessDescriptor = {
  mode: 'read_only',
  scopes: ['repo:read', 'issues:read', 'pull_requests:read'],
};

/* ------------------------------------------------------------------ */
/* Input shapes                                                        */
/* ------------------------------------------------------------------ */

export interface GitHubIssueInput {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  html_url?: unknown;
  labels?: unknown;
}

export interface GitHubPullInput extends GitHubIssueInput {
  merged?: unknown;
  merged_at?: unknown;
  head_sha?: unknown;
}

export interface GitHubCommitInput {
  sha?: unknown;
  message?: unknown;
  /** Author date, ISO-8601, as reported by git/the API. */
  authored_at?: unknown;
  html_url?: unknown;
}

export interface GitHubFetchResult {
  /** Repository the caller read, exactly as GitHub names it: `owner/name`. */
  repo: string;
  /** When the read happened. Caller-supplied so ingestion stays deterministic. */
  fetchedAt: string;
  issues?: GitHubIssueInput[];
  pullRequests?: GitHubPullInput[];
  commits?: GitHubCommitInput[];
  page?: PageInfo;
  /**
   * Set when the read did NOT succeed. A connector never infers success from
   * an empty payload: no failure and no items means "read fine, nothing there".
   */
  failure?: ConnectorFailure;
}

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) return Number(value);
  return null;
}

function labelNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((label) => {
      if (typeof label === 'string') return label;
      if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') {
        return (label as { name: string }).name;
      }
      return null;
    })
    .filter((name): name is string => name !== null);
}

/* ------------------------------------------------------------------ */
/* Connector                                                           */
/* ------------------------------------------------------------------ */

export interface GitHubConnectorOptions {
  /** Project the records belong to; defaults to the repository name. */
  project?: string;
  access?: AccessDescriptor;
}

export function gitHubConnectorName(repo: string): string {
  return `github:${repo}`;
}

/**
 * Build a read-only GitHub connector over an already-fetched result.
 * Throws only on a caller error the connector cannot honestly work around:
 * a malformed repository name, or credentials handed in through `access`.
 */
export function createGitHubConnector(input: GitHubFetchResult, options: GitHubConnectorOptions = {}): Connector {
  if (typeof input.repo !== 'string' || !REPO_PATTERN.test(input.repo)) {
    throw new Error(`createGitHubConnector: invalid repository "${String(input.repo)}" (expected owner/name)`);
  }
  const access = options.access ?? GITHUB_READ_ACCESS;
  assertNoSecretMaterial(access, 'createGitHubConnector access descriptor');

  const repo = input.repo;
  const name = gitHubConnectorName(repo);
  const project = options.project ?? repo.split('/')[1];
  const repoBase = `https://github.com/${repo}`;

  return {
    name,
    kind: 'github',
    access,
    snapshot(): ConnectorSnapshot {
      return buildSnapshot({ input, name, project, repoBase, access });
    },
  };
}

interface BuildArgs {
  input: GitHubFetchResult;
  name: string;
  project: string;
  repoBase: string;
  access: AccessDescriptor;
}

function buildSnapshot({ input, name, project, repoBase, access }: BuildArgs): ConnectorSnapshot {
  const observedAt = isoOrNull(input.fetchedAt) ?? '';
  const issues: ConnectorIssue[] = [];

  // A reported failure short-circuits everything: no records, no invented
  // success, and the caller's reason is preserved verbatim.
  if (input.failure) {
    return {
      connector: name,
      connectorKind: 'github',
      state: input.failure.state,
      stateReason: sanitizeText(input.failure.reason, MAX_TITLE_LENGTH) ?? 'no reason reported',
      observedAt,
      access,
      cursor: input.page?.cursor ?? null,
      complete: false,
      records: [],
      issues: [
        {
          code: 'source_unavailable',
          detail: sanitizeText(input.failure.reason, MAX_TITLE_LENGTH) ?? 'no reason reported',
        },
      ],
    };
  }

  const complete = input.page?.complete ?? true;
  const state = complete ? 'ok' : 'partial';
  const confidence: SourceConfidence = complete ? 'confirmed' : 'partial';
  if (!complete) {
    issues.push({
      code: 'partial_page',
      detail: 'Result set incomplete: absent items must not be treated as removed.',
    });
  }

  const records: IndexRecord[] = [];
  for (const issue of input.issues ?? []) {
    const record = mapNumbered(issue, {
      sourceType: 'issue',
      evidenceKind: 'issue',
      urlSegment: 'issues',
      name,
      project,
      repoBase,
      observedAt,
      confidence,
      issues,
    });
    if (record) records.push(record);
  }
  for (const pull of input.pullRequests ?? []) {
    const record = mapNumbered(pull, {
      sourceType: 'pull_request',
      evidenceKind: 'pull_request',
      urlSegment: 'pull',
      name,
      project,
      repoBase,
      observedAt,
      confidence,
      issues,
    });
    if (record) records.push(record);
  }
  for (const commit of input.commits ?? []) {
    const record = mapCommit(commit, { name, project, repoBase, observedAt, confidence, issues });
    if (record) records.push(record);
  }

  const snapshot: ConnectorSnapshot = {
    connector: name,
    connectorKind: 'github',
    state,
    stateReason: complete ? null : 'Partial read: more pages remain unread.',
    observedAt,
    access,
    cursor: input.page?.cursor ?? null,
    complete,
    records: sortRecords(records),
    issues,
  };
  // Fail closed: nothing secret-looking may leave this module.
  assertNoSecretMaterial(snapshot, 'github connector snapshot');
  return snapshot;
}

interface MapContext {
  name: string;
  project: string;
  repoBase: string;
  observedAt: string;
  confidence: SourceConfidence;
  issues: ConnectorIssue[];
}

interface NumberedContext extends MapContext {
  sourceType: 'issue' | 'pull_request';
  evidenceKind: EvidenceItem['kind'];
  urlSegment: 'issues' | 'pull';
}

function mapNumbered(raw: GitHubIssueInput, ctx: NumberedContext): IndexRecord | null {
  const { value: item, redactedPaths } = scrubSecrets(raw);
  const number = positiveInteger(item.number);
  if (number === null) {
    ctx.issues.push({
      code: 'malformed_metadata',
      detail: `Dropped a ${ctx.sourceType} with a non-numeric identifier.`,
    });
    return null;
  }
  const sourceId = String(number);
  if (redactedPaths.length > 0) {
    ctx.issues.push({
      code: 'secret_material',
      sourceId,
      detail: `Removed secret-like material at ${redactedPaths.join(', ')} before indexing.`,
    });
  }
  const title = sanitizeText(item.title, MAX_TITLE_LENGTH);
  if (title === null) {
    ctx.issues.push({
      code: 'malformed_metadata',
      sourceId,
      detail: `Dropped ${ctx.sourceType} ${sourceId}: unusable title.`,
    });
    return null;
  }

  const canonicalUrl = `${ctx.repoBase}/${ctx.urlSegment}/${number}`;
  const locator = verifyLocator(item.html_url, canonicalUrl, sourceId, ctx);
  const created = isoOrNull(item.created_at);
  const updated = isoOrNull(item.updated_at);
  const labels = labelNames(item.labels);
  const category =
    ctx.sourceType === 'pull_request' ? 'pull-request' : labels.includes('ai-task') ? 'ai-task' : 'issue';
  const refs: RelatedRefs = ctx.sourceType === 'pull_request' ? { pullRequests: [number] } : { issues: [number] };
  const summary = sanitizeText(item.body, MAX_SUMMARY_LENGTH) ?? title;

  return assemble({
    ctx,
    sourceType: ctx.sourceType,
    sourceId,
    title,
    category,
    summary,
    locator,
    // GitHub reports `updated_at` on every edit: it is the change marker.
    sourceVersion: updated,
    sourceUpdatedAt: updated,
    createdAt: created,
    evidenceKind: ctx.evidenceKind,
    refs,
  });
}

function mapCommit(raw: GitHubCommitInput, ctx: MapContext): IndexRecord | null {
  const { value: item, redactedPaths } = scrubSecrets(raw);
  const sha = typeof item.sha === 'string' && SHA_PATTERN.test(item.sha) ? item.sha : null;
  if (sha === null) {
    ctx.issues.push({ code: 'malformed_metadata', detail: 'Dropped a commit with an invalid sha.' });
    return null;
  }
  if (redactedPaths.length > 0) {
    ctx.issues.push({
      code: 'secret_material',
      sourceId: sha,
      detail: `Removed secret-like material at ${redactedPaths.join(', ')} before indexing.`,
    });
  }
  const title = sanitizeText(item.message, MAX_TITLE_LENGTH) ?? `commit ${sha.slice(0, 7)}`;
  const canonicalUrl = `${ctx.repoBase}/commit/${sha}`;
  const locator = verifyLocator(item.html_url, canonicalUrl, sha, ctx);

  return assemble({
    ctx,
    sourceType: 'commit',
    sourceId: sha,
    title,
    category: 'code-change',
    summary: title,
    locator,
    // A commit is immutable; its sha IS its version.
    sourceVersion: sha,
    sourceUpdatedAt: isoOrNull(item.authored_at),
    createdAt: isoOrNull(item.authored_at),
    evidenceKind: 'commit',
    refs: { commits: [sha] },
  });
}

/**
 * Trust the identifiers, not the URL. A supplied `html_url` is accepted only
 * when it is exactly the canonical URL for this item; anything else is
 * reported and replaced with the locally derived canonical URL.
 */
function verifyLocator(
  supplied: unknown,
  canonicalUrl: string,
  sourceId: string,
  ctx: MapContext,
): { locator: string; linkable: boolean } {
  if (typeof supplied === 'string' && supplied.trim().length > 0 && supplied.trim() !== canonicalUrl) {
    ctx.issues.push({
      code: 'identity_mismatch',
      sourceId,
      detail: 'Source-supplied URL did not match the canonical URL for this item; canonical URL used instead.',
    });
  }
  const classified = classifyLocator(canonicalUrl, GITHUB_HOSTS);
  if (!classified.linkable && classified.reason) {
    ctx.issues.push({ code: 'unsafe_locator', sourceId, detail: classified.reason });
  }
  return { locator: classified.locator, linkable: classified.linkable };
}

interface AssembleArgs {
  ctx: MapContext;
  sourceType: string;
  sourceId: string;
  title: string;
  category: string;
  summary: string;
  locator: { locator: string; linkable: boolean };
  sourceVersion: string | null;
  sourceUpdatedAt: string | null;
  createdAt: string | null;
  evidenceKind: EvidenceItem['kind'];
  refs: RelatedRefs;
}

function assemble(args: AssembleArgs): IndexRecord {
  const { ctx } = args;
  // No date from the source means no date invented: the archive pipeline
  // records its own fallback and flags it "estimated".
  const dateConfidence = args.createdAt ? 'exact' : 'estimated';
  const provenance: Provenance = {
    connector: ctx.name,
    connectorKind: 'github',
    sourceSystem: 'github',
    sourceId: args.sourceId,
    sourceType: args.sourceType,
    locator: args.locator.locator,
    locatorLinkable: args.locator.linkable,
    sourceVersion: args.sourceVersion,
    sourceUpdatedAt: args.sourceUpdatedAt,
    observedAt: ctx.observedAt,
    sourceConfidence: ctx.confidence,
    dateConfidence,
    lifecycle: 'active',
  };
  const evidence: EvidenceItem = {
    kind: args.evidenceKind,
    id: args.sourceId,
    title: args.title,
    project: ctx.project,
    category: args.category,
    ...(args.createdAt ? { date: args.createdAt } : {}),
    dateSource: 'github-api',
    body: args.summary,
    refs: args.refs,
    location: args.locator.locator,
  };
  return {
    id: `github:${args.sourceType}:${args.sourceId}`,
    title: args.title,
    project: ctx.project,
    category: args.category,
    provenance,
    digest: recordDigest({
      connector: ctx.name,
      sourceType: args.sourceType,
      sourceId: args.sourceId,
      locator: args.locator.locator,
      sourceVersion: args.sourceVersion,
      sourceUpdatedAt: args.sourceUpdatedAt,
      title: args.title,
      project: ctx.project,
      category: args.category,
      summary: args.summary,
      lifecycle: 'active',
    }),
    lastCheckedAt: ctx.observedAt,
    evidence,
  };
}

/** Stable ordering so two reads of the same source produce identical output. */
export function sortRecords(records: IndexRecord[]): IndexRecord[] {
  return [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
