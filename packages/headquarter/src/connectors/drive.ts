/**
 * Google Drive connector contract and adapter.
 *
 * Compatible with the Drive access the Founder already has, without this
 * repository ever holding OAuth tokens, client secrets, refresh tokens or
 * service-account keys:
 *
 * - The connector receives **pages from an already-authorized fetcher**. The
 *   authorization lives entirely in the caller (the Founder's Drive session,
 *   an MCP bridge, or an operator-supplied export).
 * - `assertNoCredentialFields` refuses any config that carries credential-like
 *   keys, so "just put the token in the config" cannot happen by accident.
 * - Authorization state is explicit: `needs_auth` is a first-class outcome,
 *   never an empty-and-therefore-fine listing.
 *
 * Ingestion is reference-only. Drive files are not downloaded, copied,
 * renamed, moved or trashed by this lane; the index records their id,
 * revision and canonical link.
 */

import type { DateConfidence } from '../archive/schema.js';
import { assertNoCredentialFields, sanitizeLocator, sanitizeText } from './safety.js';
import { runConnectorSync, type ConnectorIndex, type RunConnectorSyncOptions } from './sync.js';
import type {
  ConnectorProblem,
  NormalizeResult,
  ObservedItem,
  PageFetcher,
  SourceConfidence,
  SyncOutcome,
} from './types.js';

export const DRIVE_CONNECTOR_ID = 'drive';
export const DRIVE_SOURCE_SYSTEM = 'drive.google.com';
export const DRIVE_HOST = 'drive.google.com';

export const DRIVE_NATIVE_KINDS = ['drive_file', 'drive_folder'] as const;

export type DriveNativeKind = (typeof DRIVE_NATIVE_KINDS)[number];

export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Drive file ids are opaque; this is a conservative shape check, not a parse. */
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Authorization state supplied by the caller. `unknown` is honest: it means
 * nobody has established whether the Drive session is usable, and it is
 * reported as such rather than optimistically treated as authorized.
 */
export type DriveAuthState = 'authorized' | 'needs_auth' | 'unknown';

export interface DriveConnectorConfig {
  /**
   * Folder to ingest, or `'root'`. Also used as the provenance container so a
   * record always says which corner of Drive it came from.
   */
  folderId: string;
  /** Caller-declared authorization state. No tokens, ever. */
  authState: DriveAuthState;
  /** Optional human label for the folder, used only for provenance notes. */
  label?: string;
}

/** Raw Drive file metadata. Validated, not trusted. */
export interface RawDriveFile {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  modifiedTime?: unknown;
  createdTime?: unknown;
  version?: unknown;
  md5Checksum?: unknown;
  webViewLink?: unknown;
  trashed?: unknown;
  explicitlyTrashed?: unknown;
  description?: unknown;
  [key: string]: unknown;
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && ISO_INSTANT.test(value) ? value : null;
}

/** Canonical Drive link for a validated file id. Constructed, never trusted. */
export function driveLocator(id: string, kind: DriveNativeKind): string {
  return kind === 'drive_folder'
    ? `https://${DRIVE_HOST}/drive/folders/${id}`
    : `https://${DRIVE_HOST}/file/d/${id}/view`;
}

/**
 * Validate and normalize one raw Drive file into an observation.
 *
 * Trashed files are kept in the index and marked `deleted_at_source` rather
 * than dropped: the reference is history, and losing it silently would be a
 * form of rewriting evidence.
 */
export function normalizeDriveFile(
  raw: unknown,
  observedAt: string,
  config: DriveConnectorConfig,
): NormalizeResult {
  const file = asRecord(raw);
  if (!file) return { ok: false, reason: 'drive: item is not an object' };

  const id = typeof file.id === 'string' ? file.id : '';
  if (!DRIVE_ID_PATTERN.test(id)) {
    return { ok: false, reason: `drive: invalid file id "${sanitizeText(file.id, 60)}"` };
  }

  const mimeType = typeof file.mimeType === 'string' ? file.mimeType : '';
  const kind: DriveNativeKind = mimeType === DRIVE_FOLDER_MIME ? 'drive_folder' : 'drive_file';
  const locator = driveLocator(id, kind);

  const notes: string[] = [];
  let sourceConfidence: SourceConfidence = 'confirmed';

  if (file.webViewLink !== undefined) {
    const reported = sanitizeLocator(file.webViewLink);
    if (!reported.linkSafe) {
      notes.push('reported_locator_unsafe');
      sourceConfidence = 'reported';
    } else if (reported.note) {
      notes.push(reported.note);
      sourceConfidence = 'reported';
    }
  }

  const createdTime = isoOrNull(file.createdTime);
  const modifiedTime = isoOrNull(file.modifiedTime);
  if (file.modifiedTime !== undefined && modifiedTime === null) notes.push('modified_time_unparseable');
  if (!createdTime) notes.push('created_time_missing');
  const dateConfidence: DateConfidence = createdTime ? 'exact' : modifiedTime ? 'inferred' : 'estimated';

  // Revision preference: Drive's own version counter, then the content hash,
  // then the modification time. All three are source-reported.
  const version =
    typeof file.version === 'string' || typeof file.version === 'number' ? String(file.version) : null;
  const md5 = typeof file.md5Checksum === 'string' ? file.md5Checksum : null;
  const revision = version ?? md5 ?? modifiedTime;
  if (revision === null) notes.push('no_revision_marker');

  const trashed = file.trashed === true || file.explicitlyTrashed === true;
  if (!mimeType) notes.push('mime_type_missing');

  const title = sanitizeText(file.name, 300) || `drive item ${id}`;
  const summary = sanitizeText(file.description, 400) || title;

  const observation: ObservedItem = {
    provenance: {
      connectorId: DRIVE_CONNECTOR_ID,
      sourceSystem: DRIVE_SOURCE_SYSTEM,
      container: config.folderId,
      nativeKind: kind,
      nativeId: id,
      locator,
      revision,
      observedAt,
    },
    title,
    summary,
    sourceCreatedAt: createdTime,
    sourceUpdatedAt: modifiedTime,
    sourceConfidence,
    dateConfidence,
    deletedAtSource: trashed,
    linkSafe: true, // constructed https://drive.google.com/... locator
    notes,
  };
  return { ok: true, item: observation };
}

export interface SyncDriveOptions
  extends Omit<RunConnectorSyncOptions, 'connectorId' | 'normalize' | 'scope'> {
  config: DriveConnectorConfig;
  fetchPage: PageFetcher;
  index: ConnectorIndex;
}

const AUTH_PROBLEM: Record<Exclude<DriveAuthState, 'authorized'>, ConnectorProblem> = {
  needs_auth: {
    code: 'auth_required',
    message: 'Drive access is not authorized; re-authorize the Drive session before syncing',
  },
  unknown: {
    code: 'unknown_outcome',
    message: 'Drive authorization state is unknown; refusing to report a listing as current',
  },
};

/**
 * Read-only Drive sync. When the caller has not established authorization the
 * connector returns a truthful `needs_auth` / `outcome_unknown` outcome and
 * touches neither Drive nor the index — it never returns an empty listing that
 * could be mistaken for "the folder is empty".
 */
export function syncDrive(options: SyncDriveOptions): Promise<SyncOutcome> {
  assertNoCredentialFields('drive connector config', options.config);
  const { authState } = options.config;
  if (authState !== 'authorized') {
    const problem = AUTH_PROBLEM[authState] ?? AUTH_PROBLEM.unknown;
    return Promise.resolve({
      connectorId: DRIVE_CONNECTOR_ID,
      status: authState === 'needs_auth' ? 'needs_auth' : 'outcome_unknown',
      startedAt: options.now,
      completedAt: options.now,
      authoritative: false,
      cursor: options.startCursor ?? null,
      counts: { observed: 0, ingested: 0, updated: 0, unchanged: 0, rejected: 0, missing: 0 },
      problems: [problem],
      entries: [...options.index.entries.values()].sort((a, b) => a.key.localeCompare(b.key)),
    });
  }
  return runConnectorSync({
    ...options,
    connectorId: DRIVE_CONNECTOR_ID,
    scope: 'read',
    normalize: (raw, observedAt) => normalizeDriveFile(raw, observedAt, options.config),
  });
}
