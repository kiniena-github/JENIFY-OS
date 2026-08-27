/**
 * Headquarter connector contracts (issue #123 / retry #140, special lane G).
 *
 * A connector reads an external source of evidence (GitHub, Google Drive, and
 * later Gmail/Calendar/JENIFY products/media) and produces **index records
 * that point at the original**. Nothing here copies, rewrites, moves, or
 * mutates source evidence: originals stay where they are and the index holds
 * exact identifiers plus provenance.
 *
 * Three rules shape every type in this file:
 *
 * 1. **Read-first, least privilege.** The only scope this lane defines is
 *    `read`; there is no representation for an outbound mutation.
 * 2. **Never invent success.** A connector that could not read reports
 *    `unavailable` / `needs_auth` / `blocked` / `outcome_unknown` — it never
 *    reports an empty-but-current listing.
 * 3. **Confirmed current is a claim, not a default.** Every entry carries
 *    source confidence, date confidence, lifecycle and last-sync metadata so
 *    a reader can tell live data from a stale or partial snapshot.
 */

import type { DateConfidence } from '../archive/schema.js';

/* ------------------------------------------------------------------ */
/* Scope / policy                                                      */
/* ------------------------------------------------------------------ */

/**
 * Connector scopes defined by this lane. Deliberately read-only: there is no
 * write/delete scope, so a mutation cannot be expressed, let alone executed.
 */
export const CONNECTOR_SCOPES = ['read'] as const;

export type ConnectorScope = (typeof CONNECTOR_SCOPES)[number];

export type ConnectorPolicyCode =
  | 'scope_not_read_only'
  | 'connector_not_implemented'
  | 'credentials_in_config'
  | 'secret_material';

/** Refusal raised by a connector guard. Carries a machine-readable code. */
export class ConnectorPolicyError extends Error {
  constructor(
    readonly code: ConnectorPolicyCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorPolicyError';
  }
}

/**
 * Least-privilege gate. Any scope other than `read` is refused before a
 * connector touches a source, so this lane can never perform a destructive
 * outbound GitHub or Drive action.
 */
export function assertReadOnlyScope(scope: unknown): asserts scope is ConnectorScope {
  if (scope !== 'read') {
    throw new ConnectorPolicyError(
      'scope_not_read_only',
      `Connector scope "${String(scope)}" refused: this lane is read-only`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Connector run status                                                */
/* ------------------------------------------------------------------ */

export const CONNECTOR_STATUSES = [
  /** The complete listing was read successfully; data is confirmed current. */
  'current',
  /** Some of the listing was read (pagination cut short, unusable items). */
  'partial',
  /** No successful read within the freshness window; last known good only. */
  'stale',
  /** The source could not be reached. */
  'unavailable',
  /** The source refused for authorization reasons; re-auth is needed. */
  'needs_auth',
  /** A local policy gate refused the read (scope, unimplemented connector). */
  'blocked',
  /** The read neither clearly succeeded nor clearly failed. */
  'outcome_unknown',
] as const;

export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** Only `current` may be presented as confirmed live source data. */
export function isConfirmedCurrent(status: ConnectorStatus): boolean {
  return status === 'current';
}

/* ------------------------------------------------------------------ */
/* Confidence and lifecycle                                            */
/* ------------------------------------------------------------------ */

export const SOURCE_CONFIDENCES = [
  /** Read directly from the authoritative source during this sync run. */
  'confirmed',
  /** Source-supplied metadata accepted but not independently corroborated. */
  'reported',
  /** Last known good value from an earlier run; not re-confirmed now. */
  'cached',
  /** Shape accepted, but provenance could not be established. */
  'unverified',
] as const;

export type SourceConfidence = (typeof SOURCE_CONFIDENCES)[number];

export const CONNECTOR_LIFECYCLES = [
  /** Present in the source at last observation. */
  'active',
  /** The source explicitly reported the item deleted/trashed. */
  'deleted_at_source',
  /** Absent from an authoritative complete listing (not explicitly deleted). */
  'missing_at_source',
  /** The last read of this item failed; the last known state is retained. */
  'unavailable',
] as const;

export type ConnectorLifecycle = (typeof CONNECTOR_LIFECYCLES)[number];

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/**
 * Exact, source-native identity of one piece of evidence. Every field is
 * preserved verbatim from the source (or derived deterministically from
 * validated source fields) so an index record can always be traced back.
 */
export interface ConnectorProvenance {
  /** Connector that produced the record, e.g. `github`, `drive`. */
  connectorId: string;
  /** Origin system, e.g. `github.com`, `drive.google.com`. */
  sourceSystem: string;
  /** Container the item lives in: repo full name, Drive folder id. */
  container: string;
  /** Source-native kind, e.g. `issue`, `pull_request`, `commit`, `drive_file`. */
  nativeKind: string;
  /** Source-native id, exactly as the source spells it (sha, number, file id). */
  nativeId: string;
  /**
   * Canonical locator for the ORIGINAL. Constructed from validated source
   * components rather than trusted verbatim, so a hostile `html_url` cannot
   * redirect a reader away from the real evidence.
   */
  locator: string;
  /** Source-reported revision marker used for change detection. */
  revision: string | null;
  /** When this connector observed the item. */
  observedAt: string;
}

/* ------------------------------------------------------------------ */
/* Observations and index entries                                      */
/* ------------------------------------------------------------------ */

/** One normalized item produced by a connector's normalizer. */
export interface ObservedItem {
  provenance: ConnectorProvenance;
  title: string;
  summary: string;
  /** Authoritative source creation timestamp, or null when unknown. */
  sourceCreatedAt: string | null;
  /** Authoritative source update timestamp, or null when unknown. */
  sourceUpdatedAt: string | null;
  sourceConfidence: SourceConfidence;
  dateConfidence: DateConfidence;
  /** The source explicitly says this item is deleted/trashed. */
  deletedAtSource?: boolean;
  /** Whether the locator is safe to render as a clickable link. */
  linkSafe: boolean;
  /** Findings about untrusted metadata, recorded rather than dropped. */
  notes?: string[];
}

/** One observation of a revision, appended and never rewritten. */
export interface RevisionMark {
  revision: string | null;
  observedAt: string;
}

/**
 * An index record. It references evidence; it is not the evidence. Revision
 * and locator history are append-only, so an earlier observation is never
 * overwritten by a later one.
 */
export interface ConnectorIndexEntry {
  /** Stable idempotency key: `<connectorId>:<nativeKind>:<nativeId>`. */
  key: string;
  provenance: ConnectorProvenance;
  title: string;
  summary: string;
  lifecycle: ConnectorLifecycle;
  sourceConfidence: SourceConfidence;
  dateConfidence: DateConfidence;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  /** First sync run in which this item was observed. */
  firstSeenAt: string;
  /** Last sync run in which the item itself was observed. */
  lastSeenAt: string;
  /** Last sync run that covered this item's container, seen or not. */
  lastSyncAt: string;
  /** Append-only revision history, oldest first. */
  revisions: RevisionMark[];
  /** Append-only locator history, oldest first; current locator is last. */
  locatorHistory: string[];
  linkSafe: boolean;
  notes: string[];
}

/** Deterministic idempotency key for an item. */
export function connectorRecordKey(provenance: {
  connectorId: string;
  nativeKind: string;
  nativeId: string;
}): string {
  return `${provenance.connectorId}:${provenance.nativeKind}:${provenance.nativeId}`;
}

/* ------------------------------------------------------------------ */
/* Problems, pages, outcomes                                           */
/* ------------------------------------------------------------------ */

export const CONNECTOR_PROBLEM_CODES = [
  'auth_required',
  'unreachable',
  'rate_limited',
  'partial_pagination',
  'malformed_item',
  'blocked_by_policy',
  'unknown_outcome',
] as const;

export type ConnectorProblemCode = (typeof CONNECTOR_PROBLEM_CODES)[number];

export interface ConnectorProblem {
  code: ConnectorProblemCode;
  /** Sanitized, secret-redacted description. */
  message: string;
  /** Item key when the problem is item-scoped. */
  key?: string;
}

export interface ConnectorPage {
  items: unknown[];
  /** Cursor for the next page, or null when the listing is complete. */
  nextCursor: string | null;
}

export type PageResult =
  | { ok: true; page: ConnectorPage }
  | { ok: false; problem: ConnectorProblem };

/**
 * Port supplying already-authorized reads. Credentials live in the caller and
 * never reach this package — a connector receives pages, never a token.
 */
export type PageFetcher = (cursor: string | null) => Promise<PageResult>;

export type NormalizeResult =
  | { ok: true; item: ObservedItem }
  | { ok: false; reason: string };

export type ItemNormalizer = (raw: unknown, observedAt: string) => NormalizeResult;

export interface SyncCounts {
  /** Raw items returned by the source. */
  observed: number;
  /** Items indexed for the first time. */
  ingested: number;
  /** Known items whose revision changed. */
  updated: number;
  /** Known items re-observed at the same revision. */
  unchanged: number;
  /** Items rejected as malformed/untrusted. */
  rejected: number;
  /** Known items absent from an authoritative listing. */
  missing: number;
}

export interface SyncOutcome {
  connectorId: string;
  status: ConnectorStatus;
  startedAt: string;
  completedAt: string;
  /**
   * True only when the connector observed the complete listing AND every
   * item in it was usable. Deletion detection requires this: a partial run
   * must never conclude that an unseen item disappeared.
   */
  authoritative: boolean;
  /** Cursor to resume from; null when the listing was read to the end. */
  cursor: string | null;
  counts: SyncCounts;
  problems: ConnectorProblem[];
  /** Full index after the run, sorted by key for deterministic output. */
  entries: ConnectorIndexEntry[];
}

/* ------------------------------------------------------------------ */
/* Reported connector state                                            */
/* ------------------------------------------------------------------ */

export type ConnectorFreshness = 'fresh' | 'stale' | 'never_synced';

/**
 * What may honestly be claimed about the data a connector is showing.
 * Deliberately separate from `ConnectorStatus`: a connector can be healthy
 * right now and still be showing data nobody has re-confirmed.
 */
export type ConnectorDataClaim =
  | 'confirmed_current'
  | 'last_known_good'
  | 'partial'
  | 'no_data';

export interface ConnectorState {
  connectorId: string;
  status: ConnectorStatus;
  freshness: ConnectorFreshness;
  dataClaim: ConnectorDataClaim;
  lastAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  /** Age of the last successful sync in milliseconds, null if never synced. */
  ageMs: number | null;
  problems: ConnectorProblem[];
}
