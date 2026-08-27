/**
 * Google Drive connector contract and adapter (issue #140 / #123, HQ lane G).
 *
 * The Drive *access path* stays exactly where it already is — whichever
 * read-only Drive integration the Founder has authorized. This module is the
 * contract that access path feeds: it takes already-fetched file metadata and
 * turns it into index records. It deliberately does not authenticate, refresh
 * tokens, or call Drive, because that is how OAuth material stays out of this
 * repository, out of snapshots, and out of logs (`safety.ts` enforces it
 * mechanically, and `AccessDescriptor` can only carry scope labels).
 *
 * File contents are never copied. A record points at the original file by id
 * and, when the link is vetted, by URL. Drive stays the system of record; if
 * a document changes, the next sync notices via `version`/`modifiedTime` and
 * updates the *reference*, never the document.
 *
 * Privacy: owner email addresses are not indexed — a display name is enough
 * to attribute a document, and Headquarter has no reason to accumulate a
 * directory of addresses.
 */

import type { EvidenceItem } from '../archive/inventory.js';
import {
  MAX_SUMMARY_LENGTH,
  MAX_TITLE_LENGTH,
  assertNoSecretMaterial,
  classifyLocator,
  recordDigest,
  sanitizeText,
  scrubSecrets,
} from './safety.js';
import { sortRecords } from './github.js';
import type {
  AccessDescriptor,
  Connector,
  ConnectorFailure,
  ConnectorIssue,
  ConnectorSnapshot,
  IndexRecord,
  LifecycleStatus,
  PageInfo,
  Provenance,
  SourceConfidence,
} from './types.js';

/** Hosts whose URLs may become clickable links for Drive evidence. */
export const DRIVE_HOSTS = ['drive.google.com', 'docs.google.com'] as const;

/** Least-privilege default: Google's read-only Drive scopes, nothing else. */
export const DRIVE_READ_ACCESS: AccessDescriptor = {
  mode: 'read_only',
  scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.metadata.readonly'],
};

/* ------------------------------------------------------------------ */
/* Input shapes                                                        */
/* ------------------------------------------------------------------ */

export interface DriveFileInput {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  description?: unknown;
  createdTime?: unknown;
  modifiedTime?: unknown;
  /** Drive's monotonically increasing per-file version. */
  version?: unknown;
  webViewLink?: unknown;
  trashed?: unknown;
  owners?: unknown;
  /** Set by the caller when Drive reported the file as gone/inaccessible. */
  unavailable?: unknown;
}

export interface DriveFetchResult {
  /**
   * Non-secret label for the authorized Drive access path in use, e.g.
   * `founder-drive-readonly`. Never an address, token or key.
   */
  accessLabel: string;
  fetchedAt: string;
  files?: DriveFileInput[];
  page?: PageInfo;
  failure?: ConnectorFailure;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
/** Drive file ids are opaque; bound the shape so an id can never be a URL. */
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? value : null;
}

function ownerName(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (first && typeof first === 'object') {
    const display = (first as { displayName?: unknown }).displayName;
    return sanitizeText(display, 120);
  }
  return null;
}

/**
 * Map a Drive mimeType to an archive category. Unknown types stay `document`
 * rather than being guessed into something more specific.
 */
export function driveCategory(mimeType: unknown): string {
  if (typeof mimeType !== 'string') return 'document';
  if (mimeType === 'application/vnd.google-apps.folder') return 'folder';
  if (mimeType.startsWith('application/vnd.google-apps.spreadsheet')) return 'spreadsheet';
  if (mimeType.startsWith('application/vnd.google-apps.presentation')) return 'presentation';
  if (mimeType.startsWith('application/vnd.google-apps.document')) return 'document';
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/')) return 'media';
  if (mimeType === 'application/pdf') return 'document';
  return 'document';
}

/* ------------------------------------------------------------------ */
/* Connector                                                           */
/* ------------------------------------------------------------------ */

export interface DriveConnectorOptions {
  /** Project these files belong to. Required: Drive has no project concept. */
  project: string;
  access?: AccessDescriptor;
}

export function driveConnectorName(accessLabel: string): string {
  return `drive:${accessLabel}`;
}

export function createDriveConnector(input: DriveFetchResult, options: DriveConnectorOptions): Connector {
  if (typeof input.accessLabel !== 'string' || input.accessLabel.trim().length === 0) {
    throw new Error('createDriveConnector: accessLabel is required (a non-secret label for the access path)');
  }
  const access = options.access ?? DRIVE_READ_ACCESS;
  assertNoSecretMaterial(access, 'createDriveConnector access descriptor');
  assertNoSecretMaterial({ accessLabel: input.accessLabel }, 'createDriveConnector accessLabel');

  const name = driveConnectorName(input.accessLabel.trim());

  return {
    name,
    kind: 'drive',
    access,
    snapshot(): ConnectorSnapshot {
      return buildSnapshot(input, name, options.project, access);
    },
  };
}

function buildSnapshot(
  input: DriveFetchResult,
  name: string,
  project: string,
  access: AccessDescriptor,
): ConnectorSnapshot {
  const observedAt = isoOrNull(input.fetchedAt) ?? '';

  if (input.failure) {
    const reason = sanitizeText(input.failure.reason, MAX_TITLE_LENGTH) ?? 'no reason reported';
    return {
      connector: name,
      connectorKind: 'drive',
      state: input.failure.state,
      stateReason: reason,
      observedAt,
      access,
      cursor: input.page?.cursor ?? null,
      complete: false,
      records: [],
      issues: [{ code: 'source_unavailable', detail: reason }],
    };
  }

  const issues: ConnectorIssue[] = [];
  const complete = input.page?.complete ?? true;
  const state = complete ? 'ok' : 'partial';
  const confidence: SourceConfidence = complete ? 'confirmed' : 'partial';
  if (!complete) {
    issues.push({
      code: 'partial_page',
      detail: 'Result set incomplete: absent files must not be treated as deleted.',
    });
  }

  const records: IndexRecord[] = [];
  for (const raw of input.files ?? []) {
    const record = mapFile(raw, { name, project, observedAt, confidence, issues });
    if (record) records.push(record);
  }

  const snapshot: ConnectorSnapshot = {
    connector: name,
    connectorKind: 'drive',
    state,
    stateReason: complete ? null : 'Partial read: more pages remain unread.',
    observedAt,
    access,
    cursor: input.page?.cursor ?? null,
    complete,
    records: sortRecords(records),
    issues,
  };
  assertNoSecretMaterial(snapshot, 'drive connector snapshot');
  return snapshot;
}

interface DriveContext {
  name: string;
  project: string;
  observedAt: string;
  confidence: SourceConfidence;
  issues: ConnectorIssue[];
}

function mapFile(raw: DriveFileInput, ctx: DriveContext): IndexRecord | null {
  const { value: file, redactedPaths } = scrubSecrets(raw);
  const id = typeof file.id === 'string' && DRIVE_ID_PATTERN.test(file.id) ? file.id : null;
  if (id === null) {
    ctx.issues.push({ code: 'malformed_metadata', detail: 'Dropped a Drive file with an unusable id.' });
    return null;
  }
  if (redactedPaths.length > 0) {
    ctx.issues.push({
      code: 'secret_material',
      sourceId: id,
      detail: `Removed secret-like material at ${redactedPaths.join(', ')} before indexing.`,
    });
  }
  const title = sanitizeText(file.name, MAX_TITLE_LENGTH);
  if (title === null) {
    ctx.issues.push({ code: 'malformed_metadata', sourceId: id, detail: `Dropped Drive file ${id}: unusable name.` });
    return null;
  }

  // Drive's own webViewLink is preferred, but only if it is a vetted host AND
  // actually addresses this file id. Otherwise fall back to an inert
  // `drive://<id>` locator: still exact provenance, never a clickable link to
  // somewhere a hostile share name pointed at.
  const supplied = typeof file.webViewLink === 'string' ? file.webViewLink.trim() : '';
  const classified = supplied.length > 0 ? classifyLocator(supplied, DRIVE_HOSTS) : null;
  let locator = `drive://${id}`;
  let linkable = false;
  if (classified?.linkable && classified.locator.includes(id)) {
    locator = classified.locator;
    linkable = true;
  } else if (supplied.length > 0) {
    ctx.issues.push({
      code: classified?.linkable ? 'identity_mismatch' : 'unsafe_locator',
      sourceId: id,
      detail: classified?.linkable
        ? 'webViewLink did not address this file id; inert drive:// locator used instead.'
        : (classified?.reason ?? 'webViewLink unusable; inert drive:// locator used instead.'),
    });
  }

  // The source's own word on existence. Absence from a *complete* read is a
  // separate signal handled by sync.ts — this is Drive explicitly saying gone.
  const lifecycle: LifecycleStatus =
    file.unavailable === true ? 'unavailable' : file.trashed === true ? 'deleted' : 'active';

  const created = isoOrNull(file.createdTime);
  const modified = isoOrNull(file.modifiedTime);
  const version =
    typeof file.version === 'string' || typeof file.version === 'number' ? String(file.version) : modified;
  const category = driveCategory(file.mimeType);
  const owner = ownerName(file.owners);
  const description = sanitizeText(file.description, MAX_SUMMARY_LENGTH);
  const summary = description ?? (owner ? `${title} (owner: ${owner})` : title);

  const provenance: Provenance = {
    connector: ctx.name,
    connectorKind: 'drive',
    sourceSystem: 'google-drive',
    sourceId: id,
    sourceType: 'file',
    locator,
    locatorLinkable: linkable,
    sourceVersion: version,
    sourceUpdatedAt: modified,
    observedAt: ctx.observedAt,
    sourceConfidence: ctx.confidence,
    // Drive's createdTime is authoritative file metadata; without it we do not
    // guess a date, we say the date is estimated downstream.
    dateConfidence: created ? 'exact' : 'estimated',
    lifecycle,
  };

  const evidence: EvidenceItem = {
    kind: 'file',
    id,
    title,
    project: ctx.project,
    category,
    ...(created ? { date: created } : {}),
    dateSource: created ? 'drive-api' : 'unknown',
    body: summary,
    refs: { artifacts: [locator] },
    location: locator,
  };

  return {
    id: `drive:file:${id}`,
    title,
    project: ctx.project,
    category,
    provenance,
    digest: recordDigest({
      connector: ctx.name,
      sourceType: 'file',
      sourceId: id,
      locator,
      sourceVersion: version,
      sourceUpdatedAt: modified,
      title,
      project: ctx.project,
      category,
      summary,
      lifecycle,
    }),
    lastCheckedAt: ctx.observedAt,
    evidence,
  };
}
