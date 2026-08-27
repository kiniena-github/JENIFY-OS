/**
 * Headquarter connector contracts (issue #140 / #123, HQ lane G).
 *
 * A connector is a READ-ONLY adapter over an external source of evidence
 * (GitHub, Google Drive today; Gmail/Calendar/JENIFY products/media later).
 * Connectors never rewrite, move, or delete the source. They emit *index
 * records*: references plus provenance, pointing back at the untouched
 * original.
 *
 * Three rules shape every type in this file:
 *
 * 1. **Truthful state.** A connector that could not read its source says so
 *    (`unavailable` / `needs_auth` / `blocked` / `outcome_unknown`). Only
 *    `ok` with `complete: true` asserts "this is the confirmed current set".
 * 2. **Provenance is mandatory.** Every record carries the exact source-native
 *    identifier, the original locator, the source-side version marker used for
 *    change detection, and explicit source/date confidence.
 * 3. **No credentials.** Access is described by non-secret scope labels only;
 *    tokens, cookies and keys never enter a connector input, a snapshot, or
 *    any serialized state. See `safety.ts`.
 */

import type { DateConfidence } from '../archive/schema.js';
import type { EvidenceItem } from '../archive/inventory.js';

/* ------------------------------------------------------------------ */
/* Connector identity                                                  */
/* ------------------------------------------------------------------ */

/**
 * Every source Headquarter may ever ingest from. Declaring the future kinds
 * here is the extension point: a new connector registers against an existing
 * kind instead of inventing a parallel pipeline. Only the kinds in
 * `IMPLEMENTED_CONNECTOR_KINDS` have an adapter in this lane.
 */
export const CONNECTOR_KINDS = [
  'github',
  'drive',
  'gmail',
  'calendar',
  'jenify_web',
  'jenify_products',
  'media',
] as const;

export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** Kinds with a real adapter today. Everything else is declared, not built. */
export const IMPLEMENTED_CONNECTOR_KINDS = ['github', 'drive'] as const satisfies readonly ConnectorKind[];

/** Kinds reserved for later lanes; the registry reports them as `planned`. */
export const PLANNED_CONNECTOR_KINDS = [
  'gmail',
  'calendar',
  'jenify_web',
  'jenify_products',
  'media',
] as const satisfies readonly ConnectorKind[];

export function isConnectorKind(value: unknown): value is ConnectorKind {
  return typeof value === 'string' && (CONNECTOR_KINDS as readonly string[]).includes(value);
}

/* ------------------------------------------------------------------ */
/* Connector state                                                     */
/* ------------------------------------------------------------------ */

export const CONNECTOR_STATES = [
  /** The source was read successfully. */
  'ok',
  /** Read succeeded but the result set is knowingly incomplete (pagination). */
  'partial',
  /** Last read is older than the freshness budget; data shown is not current. */
  'stale',
  /** The source could not be reached at all. */
  'unavailable',
  /** The source refused for lack of (re-)authorization. */
  'needs_auth',
  /** A policy/permission rule stopped the read before it happened. */
  'blocked',
  /** The read may or may not have happened; the result is genuinely unknown. */
  'outcome_unknown',
] as const;

export type ConnectorState = (typeof CONNECTOR_STATES)[number];

/** States that mean "no data was obtained"; they must never look like success. */
export const UNUSABLE_CONNECTOR_STATES = [
  'unavailable',
  'needs_auth',
  'blocked',
  'outcome_unknown',
] as const satisfies readonly ConnectorState[];

export function isUnusableState(state: ConnectorState): boolean {
  return (UNUSABLE_CONNECTOR_STATES as readonly ConnectorState[]).includes(state);
}

/**
 * The ONLY combination that asserts confirmed-current data. `partial`,
 * `stale` and every unusable state are explicitly not this.
 */
export function isConfirmedCurrent(state: ConnectorState, complete: boolean): boolean {
  return state === 'ok' && complete === true;
}

/* ------------------------------------------------------------------ */
/* Confidence and lifecycle                                            */
/* ------------------------------------------------------------------ */

export const SOURCE_CONFIDENCES = [
  /** Read directly from the source in a complete, current read. */
  'confirmed',
  /** Read from the source, but the surrounding result set was incomplete. */
  'partial',
  /** Last read succeeded but is older than the freshness budget. */
  'stale',
  /** Could not be confirmed against the source at all. */
  'unconfirmed',
] as const;

export type SourceConfidence = (typeof SOURCE_CONFIDENCES)[number];

export const LIFECYCLE_STATUSES = [
  /** Present in the source at the last confirmed read. */
  'active',
  /** Was present; the last read is too old to still claim it is. */
  'stale',
  /** Was present and is now absent from a complete read — presumed removed. */
  'unavailable',
  /** The source itself reports it as deleted/trashed. */
  'deleted',
] as const;

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

/* ------------------------------------------------------------------ */
/* Access (least privilege, read-first)                                */
/* ------------------------------------------------------------------ */

/**
 * How a connector reaches its source — described, never carried. `mode` is
 * fixed to `read_only` in this lane: Headquarter performs no outbound
 * mutations through connectors. `scopes` are non-secret scope labels
 * (`drive.readonly`, `repo:read`); `accountLabel` is a human name for the
 * identity in use, never an address or credential.
 */
export interface AccessDescriptor {
  mode: 'read_only';
  scopes: string[];
  accountLabel?: string;
}

/* ------------------------------------------------------------------ */
/* Provenance and index records                                        */
/* ------------------------------------------------------------------ */

export interface Provenance {
  /** Connector instance name, e.g. `github:kiniena-github/JENIFY-OS`. */
  connector: string;
  connectorKind: ConnectorKind;
  /** Source system label, e.g. `github`, `google-drive`. */
  sourceSystem: string;
  /** Exact source-native identifier: issue number, commit sha, Drive file id. */
  sourceId: string;
  /** Type within the source system: `issue`, `pull_request`, `commit`, `file`. */
  sourceType: string;
  /** Original evidence locator, preserved verbatim. Never a copy. */
  locator: string;
  /**
   * Whether the locator is safe to render as a clickable link. Locators come
   * from untrusted external metadata, so this is decided here, once, and the
   * UI honours it (see `ui/render.ts` renderSourceRef).
   */
  locatorLinkable: boolean;
  /** Source-side change marker (commit sha, Drive version, etag). */
  sourceVersion: string | null;
  /** Last modification as reported by the source, when it reports one. */
  sourceUpdatedAt: string | null;
  /** When the connector actually observed this item in the source. */
  observedAt: string;
  sourceConfidence: SourceConfidence;
  /** Confidence in the record's creation date; reuses the archive vocabulary. */
  dateConfidence: DateConfidence;
  lifecycle: LifecycleStatus;
}

export interface IndexRecord {
  /** Deterministic id: `<kind>:<sourceType>:<sourceId>`. Stable across syncs. */
  id: string;
  title: string;
  project: string;
  category: string;
  provenance: Provenance;
  /**
   * SHA-256 over the record's identity + content fields. Two reads of an
   * unchanged source produce the same digest; this is what makes incremental
   * sync deterministic and idempotent.
   */
  digest: string;
  /** When sync last checked this record, whether or not the source changed. */
  lastCheckedAt: string;
  /**
   * The item handed to the existing archive reconstruction pipeline
   * (`archive/inventory.ts`). Connectors add a source; they do not fork the
   * pipeline.
   */
  evidence: EvidenceItem;
}

/* ------------------------------------------------------------------ */
/* Issues                                                              */
/* ------------------------------------------------------------------ */

export const CONNECTOR_ISSUE_CODES = [
  /** An item was dropped because its metadata was unusable. */
  'malformed_metadata',
  /** A locator was demoted to non-clickable text (bad scheme/host). */
  'unsafe_locator',
  /** Source-provided URL disagreed with the item's own identifiers. */
  'identity_mismatch',
  /** Secret-looking material was found in the input and removed. */
  'secret_material',
  /** The read did not cover the whole result set. */
  'partial_page',
  /** The source could not be read; see the snapshot state for which way. */
  'source_unavailable',
] as const;

export type ConnectorIssueCode = (typeof CONNECTOR_ISSUE_CODES)[number];

export interface ConnectorIssue {
  code: ConnectorIssueCode;
  /** Source-native id of the offending item, when the item is identifiable. */
  sourceId?: string;
  /** Sanitized, non-secret explanation. */
  detail: string;
}

/* ------------------------------------------------------------------ */
/* Snapshot and connector                                              */
/* ------------------------------------------------------------------ */

export interface ConnectorSnapshot {
  connector: string;
  connectorKind: ConnectorKind;
  state: ConnectorState;
  /** Truthful reason for any non-`ok` state; null only when state is `ok`. */
  stateReason: string | null;
  observedAt: string;
  access: AccessDescriptor;
  /** Resume cursor for incremental sync; null when the source has none. */
  cursor: string | null;
  /** True only when the connector saw the complete result set. */
  complete: boolean;
  /** Deterministically ordered index records. Empty on an unusable state. */
  records: IndexRecord[];
  issues: ConnectorIssue[];
}

export interface Connector {
  readonly name: string;
  readonly kind: ConnectorKind;
  readonly access: AccessDescriptor;
  /** Pure: builds a snapshot from already-fetched, caller-supplied input. */
  snapshot(): ConnectorSnapshot;
}

/**
 * Shared shape for a caller-reported read failure. Connectors never invent a
 * successful read: the caller that performed the fetch reports what happened
 * and the connector propagates it verbatim.
 */
export interface ConnectorFailure {
  state: (typeof UNUSABLE_CONNECTOR_STATES)[number];
  reason: string;
}

/** Pagination as reported by whoever performed the read. */
export interface PageInfo {
  /** False when more pages exist than were read. */
  complete: boolean;
  cursor?: string | null;
}
