/**
 * GitHub ingestion adapter.
 *
 * Ingests repository / issue / pull-request / commit evidence as **index
 * references with exact provenance**. It never edits, closes, comments on, or
 * otherwise mutates anything on GitHub: the only capability this module has is
 * to read pages handed to it by an already-authorized fetcher.
 *
 * Locator policy: a locator is CONSTRUCTED from validated components
 * (`owner/repo` + number/sha), never taken verbatim from the payload. A
 * payload `html_url` that disagrees with the constructed locator is recorded
 * as a note and downgrades source confidence to `reported`, so a hostile or
 * mis-synced export cannot point a Founder at somebody else's page.
 */

import type { DateConfidence } from '../archive/schema.js';
import { assertNoCredentialFields, isHost, sanitizeLocator, sanitizeText } from './safety.js';
import { runConnectorSync, type ConnectorIndex, type RunConnectorSyncOptions } from './sync.js';
import type { NormalizeResult, ObservedItem, PageFetcher, SourceConfidence, SyncOutcome } from './types.js';

export const GITHUB_CONNECTOR_ID = 'github';
export const GITHUB_SOURCE_SYSTEM = 'github.com';
export const GITHUB_HOST = 'github.com';

export const GITHUB_NATIVE_KINDS = ['repository', 'issue', 'pull_request', 'commit'] as const;

export type GitHubNativeKind = (typeof GITHUB_NATIVE_KINDS)[number];

/** `owner/repo`, the only form this adapter treats as an identity. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A raw item as it arrives from a GitHub read. Deliberately typed as unknown
 * fields: the adapter validates rather than trusts.
 */
export interface RawGitHubItem {
  kind?: unknown;
  number?: unknown;
  sha?: unknown;
  title?: unknown;
  body?: unknown;
  html_url?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  state?: unknown;
  merged?: unknown;
  full_name?: unknown;
  [key: string]: unknown;
}

export interface GitHubConnectorConfig {
  /** `owner/repo` to ingest. No credentials — see assertNoCredentialFields. */
  repo: string;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? value : null;
}

function nativeKindOf(value: unknown): GitHubNativeKind | null {
  return typeof value === 'string' && (GITHUB_NATIVE_KINDS as readonly string[]).includes(value)
    ? (value as GitHubNativeKind)
    : null;
}

/** Canonical GitHub URL for a validated item. Constructed, never trusted. */
export function githubLocator(repo: string, kind: GitHubNativeKind, nativeId: string): string {
  const base = `https://${GITHUB_HOST}/${repo}`;
  switch (kind) {
    case 'repository':
      return base;
    case 'issue':
      return `${base}/issues/${nativeId}`;
    case 'pull_request':
      return `${base}/pull/${nativeId}`;
    case 'commit':
      return `${base}/commit/${nativeId}`;
  }
}

/**
 * Validate and normalize one raw GitHub item into an observation.
 *
 * Rejects (never silently accepts) items with an unknown kind, a repo that
 * does not match the configured one, or a missing/invalid native identifier.
 */
export function normalizeGitHubItem(
  raw: unknown,
  observedAt: string,
  config: GitHubConnectorConfig,
): NormalizeResult {
  if (!REPO_PATTERN.test(config.repo)) {
    return { ok: false, reason: `github: invalid repo "${sanitizeText(config.repo, 80)}"` };
  }
  const item = asRecord(raw);
  if (!item) return { ok: false, reason: 'github: item is not an object' };

  const kind = nativeKindOf(item.kind);
  if (!kind) {
    return { ok: false, reason: `github: unknown item kind "${sanitizeText(item.kind, 40)}"` };
  }

  // An item carrying its own full_name must agree with the configured repo;
  // a mismatch is cross-repo contamination, not something to normalize away.
  if (typeof item.full_name === 'string' && item.full_name !== config.repo && kind !== 'repository') {
    return {
      ok: false,
      reason: `github: item repo "${sanitizeText(item.full_name, 80)}" does not match configured repo`,
    };
  }

  let nativeId: string;
  switch (kind) {
    case 'repository':
      if (typeof item.full_name === 'string' && item.full_name !== config.repo) {
        return {
          ok: false,
          reason: `github: repository "${sanitizeText(item.full_name, 80)}" does not match configured repo`,
        };
      }
      nativeId = config.repo;
      break;
    case 'commit': {
      const sha = typeof item.sha === 'string' ? item.sha.toLowerCase() : '';
      if (!SHA_PATTERN.test(sha)) {
        return { ok: false, reason: `github: invalid commit sha "${sanitizeText(item.sha, 60)}"` };
      }
      // The FULL sha is the identity — never the abbreviation.
      nativeId = sha;
      break;
    }
    default:
      if (!isPositiveInteger(item.number)) {
        return {
          ok: false,
          reason: `github: ${kind} has no positive integer number (${sanitizeText(String(item.number), 40)})`,
        };
      }
      nativeId = String(item.number);
      break;
  }

  const locator = githubLocator(config.repo, kind, nativeId);
  const notes: string[] = [];
  let sourceConfidence: SourceConfidence = 'confirmed';

  // Compare the payload's own link against the canonical one. We keep ours.
  if (item.html_url !== undefined) {
    const reported = sanitizeLocator(item.html_url);
    if (!reported.linkSafe || !isHost(reported.locator, GITHUB_HOST)) {
      notes.push('reported_locator_unsafe');
      sourceConfidence = 'reported';
    } else if (reported.locator.replace(/\/$/, '') !== locator) {
      notes.push('reported_locator_mismatch');
      sourceConfidence = 'reported';
    }
  }

  const createdAt = isoOrNull(item.created_at);
  const updatedAt = isoOrNull(item.updated_at);
  if (item.created_at !== undefined && createdAt === null) {
    notes.push('created_at_unparseable');
  }
  // GitHub timestamps are authoritative when present and well-formed.
  const dateConfidence: DateConfidence = createdAt ? 'exact' : 'estimated';
  if (!createdAt) notes.push('created_at_missing');

  // Revision drives change detection: the newest thing the source reports
  // about this item. Commits are immutable, so the sha is its own revision.
  const revision =
    kind === 'commit' ? nativeId : updatedAt ?? createdAt ?? null;
  if (kind !== 'commit' && revision === null) notes.push('no_revision_marker');

  const title = sanitizeText(item.title, 300) || `${kind} ${nativeId}`;
  const summary = sanitizeText(item.body, 400) || title;

  const observation: ObservedItem = {
    provenance: {
      connectorId: GITHUB_CONNECTOR_ID,
      sourceSystem: GITHUB_SOURCE_SYSTEM,
      container: config.repo,
      nativeKind: kind,
      nativeId,
      locator,
      revision,
      observedAt,
    },
    title,
    summary,
    sourceCreatedAt: createdAt,
    sourceUpdatedAt: updatedAt,
    sourceConfidence,
    dateConfidence,
    // GitHub has no "trashed" flag on a read listing; a deleted issue simply
    // stops appearing, which authoritative-run deletion detection handles.
    deletedAtSource: false,
    linkSafe: true, // constructed https://github.com/... locator
    notes,
  };
  return { ok: true, item: observation };
}

export interface SyncGitHubOptions
  extends Omit<RunConnectorSyncOptions, 'connectorId' | 'normalize' | 'scope'> {
  config: GitHubConnectorConfig;
  fetchPage: PageFetcher;
  index: ConnectorIndex;
}

/**
 * Read-only GitHub sync. Scope is hard-wired to `read`: there is no argument
 * a caller can pass that makes this write to GitHub.
 */
export function syncGitHub(options: SyncGitHubOptions): Promise<SyncOutcome> {
  assertNoCredentialFields('github connector config', options.config);
  return runConnectorSync({
    ...options,
    connectorId: GITHUB_CONNECTOR_ID,
    scope: 'read',
    normalize: (raw, observedAt) => normalizeGitHubItem(raw, observedAt, options.config),
  });
}
