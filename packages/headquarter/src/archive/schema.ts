/**
 * Historical archive metadata schema (issue #43, order 2).
 *
 * Canonical records describe historical evidence; the evidence itself
 * (files, PRs, Drive documents) is never rewritten, moved, or renamed by
 * this system — records point at originals via sourceRef.
 */

import type { RelatedRefs } from '../events.js';

export const ARCHIVE_STATUSES = [
  'CURRENT',
  'SUPERSEDED',
  'REJECTED',
  'EXPERIMENTAL',
  'ARCHIVED',
] as const;

export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

export const DATE_CONFIDENCES = [
  /** Taken from an authoritative timestamp (Git commit, GitHub API, file metadata). */
  'exact',
  /** Derived from nearby evidence (surrounding commits, filename, referenced events). */
  'inferred',
  /** A best guess with no direct evidence; must be reviewed before being trusted. */
  'estimated',
] as const;

export type DateConfidence = (typeof DATE_CONFIDENCES)[number];

export interface DatedValue {
  /** ISO-8601 date or instant. */
  date: string;
  confidence: DateConfidence;
  /** Where the date came from, e.g. "git author date", "github issue created_at". */
  source?: string;
}

export interface ArchiveRecord {
  /** Stable unique id, e.g. "pr-7", "commit-ed20eb2", "issue-43". */
  id: string;
  title: string;
  /** Product/project the record belongs to, e.g. "JENIFY-OS", "QOS", "Jenify News". */
  project: string;
  /** Category within the project, e.g. "decision", "review", "code-change", "report". */
  category: string;
  /** When the underlying work/document was created. */
  created: DatedValue;
  /** When the evidence for it was observed/recorded (may differ from created). */
  evidence: DatedValue;
  /** Human-meaningful version, e.g. "v0", "v1.2", "R4". */
  version: string;
  status: ArchiveStatus;
  /** Evolution links: the record this one replaced, and the ones replacing it. */
  predecessorId?: string | null;
  successorIds?: string[];
  related: RelatedRefs;
  /**
   * Original evidence location (repo path, GitHub URL, Drive id later).
   * Originals are preserved in place — this is a pointer, never a copy-then-delete.
   */
  sourceRef: string;
  summary: string;
  tags: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function isArchiveStatus(value: unknown): value is ArchiveStatus {
  return typeof value === 'string' && (ARCHIVE_STATUSES as readonly string[]).includes(value);
}

export function isDateConfidence(value: unknown): value is DateConfidence {
  return typeof value === 'string' && (DATE_CONFIDENCES as readonly string[]).includes(value);
}

function validateDated(name: string, value: DatedValue | undefined, errors: string[]): void {
  if (!value || typeof value !== 'object') {
    errors.push(`${name} is required`);
    return;
  }
  if (!value.date || !ISO_DATE.test(value.date)) errors.push(`${name}.date must be an ISO-8601 date`);
  if (!isDateConfidence(value.confidence)) {
    errors.push(`${name}.confidence must be one of: ${DATE_CONFIDENCES.join(', ')}`);
  }
}

export function validateArchiveRecord(record: ArchiveRecord): string[] {
  const errors: string[] = [];
  if (!record.id) errors.push('id is required');
  if (!record.title) errors.push('title is required');
  if (!record.project) errors.push('project is required');
  if (!record.category) errors.push('category is required');
  validateDated('created', record.created, errors);
  validateDated('evidence', record.evidence, errors);
  if (!record.version) errors.push('version is required');
  if (!isArchiveStatus(record.status)) {
    errors.push(`status must be one of: ${ARCHIVE_STATUSES.join(', ')}`);
  }
  if (!record.sourceRef) errors.push('sourceRef is required');
  if (!record.summary) errors.push('summary is required');
  if (!Array.isArray(record.tags)) errors.push('tags must be an array');
  if (!record.related || typeof record.related !== 'object') errors.push('related is required (may be empty)');
  return errors;
}

/** Year/month partition a record files under, derived from its creation date. */
export function archivePeriod(record: ArchiveRecord): { year: string; month: string } {
  return { year: record.created.date.slice(0, 4), month: record.created.date.slice(5, 7) };
}

/**
 * Canonical logical path: archive/<year>/<month>/<project>/<category>/<id>.
 * This is an addressing scheme for browsing/storage of RECORDS — it never
 * dictates moving original files.
 */
export function archivePath(record: ArchiveRecord): string {
  const { year, month } = archivePeriod(record);
  return `archive/${year}/${month}/${record.project}/${record.category}/${record.id}`;
}
