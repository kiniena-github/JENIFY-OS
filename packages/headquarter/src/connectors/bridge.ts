/**
 * Bridge from connector index entries to the existing archive pipeline.
 *
 * Connectors do not get their own archive: they emit the `EvidenceItem` shape
 * the inventory pipeline already consumes (`reconstructArchive`), exactly as
 * `createStaticExportAdapter` anticipated. There is no second reconstruction
 * path and no duplicated schema.
 *
 * What crosses the bridge is a REFERENCE. `sourceRef` is the canonical
 * constructed locator for the original; nothing here copies file content or
 * rewrites source evidence.
 */

import { createStaticExportAdapter, type EvidenceItem, type SourceAdapter } from '../archive/inventory.js';
import type { ArchiveStatus, RelatedRefs } from '../archive/schema.js';
import { DRIVE_CONNECTOR_ID } from './drive.js';
import { GITHUB_CONNECTOR_ID } from './github.js';
import type { ConnectorIndexEntry } from './types.js';

const EVIDENCE_KIND_BY_NATIVE_KIND: Record<string, EvidenceItem['kind']> = {
  issue: 'issue',
  pull_request: 'pull_request',
  commit: 'commit',
  repository: 'file',
  drive_file: 'file',
  drive_folder: 'file',
};

const DATE_SOURCE_BY_CONNECTOR: Record<string, EvidenceItem['dateSource']> = {
  [GITHUB_CONNECTOR_ID]: 'github-api',
  [DRIVE_CONNECTOR_ID]: 'drive-api',
};

/**
 * Lifecycle → archive status. An item that vanished from its source is
 * ARCHIVED, not deleted: the reference and its history are kept so the record
 * of what once existed survives.
 */
function statusFor(entry: ConnectorIndexEntry): ArchiveStatus {
  switch (entry.lifecycle) {
    case 'deleted_at_source':
    case 'missing_at_source':
      return 'ARCHIVED';
    default:
      return 'CURRENT';
  }
}

function refsFor(entry: ConnectorIndexEntry): RelatedRefs {
  const { nativeKind, nativeId, locator } = entry.provenance;
  switch (nativeKind) {
    case 'issue':
      return { issues: [Number(nativeId)] };
    case 'pull_request':
      return { pullRequests: [Number(nativeId)] };
    case 'commit':
      return { commits: [nativeId] };
    default:
      return { artifacts: [locator] };
  }
}

/**
 * Tags carry the connector's honest qualifiers into the archive, so a record
 * built from a stale or unverified observation cannot be mistaken for a
 * confirmed one downstream.
 */
export function connectorTags(entry: ConnectorIndexEntry): string[] {
  const tags = [
    `connector:${entry.provenance.connectorId}`,
    `kind:${entry.provenance.nativeKind}`,
    `lifecycle:${entry.lifecycle}`,
    `source-confidence:${entry.sourceConfidence}`,
    `date-confidence:${entry.dateConfidence}`,
  ];
  if (!entry.linkSafe) tags.push('link:unsafe');
  return tags;
}

export interface ToEvidenceOptions {
  /** Project the records belong to, e.g. 'JENIFY-OS'. */
  project: string;
  /** Category override; defaults to the source-native kind. */
  category?: string;
}

/** Map index entries to archive evidence items. Pure and deterministic. */
export function toEvidenceItems(
  entries: ConnectorIndexEntry[],
  options: ToEvidenceOptions,
): EvidenceItem[] {
  return entries.map((entry) => {
    const kind = EVIDENCE_KIND_BY_NATIVE_KIND[entry.provenance.nativeKind] ?? 'file';
    const date = entry.sourceCreatedAt ?? entry.sourceUpdatedAt ?? undefined;
    return {
      kind,
      // Namespaced so a GitHub issue #7 and a Drive file cannot collide, and
      // so the archive id is traceable back to the exact connector record.
      id: `${entry.provenance.connectorId}-${entry.provenance.nativeKind}-${entry.provenance.nativeId}`,
      title: entry.title,
      project: options.project,
      category: options.category ?? entry.provenance.nativeKind,
      date,
      dateSource: date ? DATE_SOURCE_BY_CONNECTOR[entry.provenance.connectorId] ?? 'unknown' : 'unknown',
      // The connector already established how much the date can be trusted;
      // this override keeps that judgement instead of re-deriving it.
      dateConfidence: entry.dateConfidence,
      body: entry.summary,
      refs: refsFor(entry),
      location: entry.provenance.locator,
      status: statusFor(entry),
    };
  });
}

/**
 * A `SourceAdapter` over connector output, so connector evidence flows through
 * the identical inventory pipeline as git-log and GitHub-export evidence.
 */
export function createConnectorSourceAdapter(
  entries: ConnectorIndexEntry[],
  options: ToEvidenceOptions,
): SourceAdapter {
  return createStaticExportAdapter(
    `connector:${entries[0]?.provenance.connectorId ?? 'empty'}`,
    toEvidenceItems(entries, options),
  );
}
