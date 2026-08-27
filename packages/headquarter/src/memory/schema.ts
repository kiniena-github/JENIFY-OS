/**
 * Company memory schema (issue #120, HQ special lane D).
 *
 * A MemoryRecord is company-owned knowledge — decisions, rationale, and
 * live task/project state — captured so it survives past any single AI
 * session or worker. It deliberately REUSES the existing archive/
 * provenance/date-confidence vocabulary from archive/schema.ts (ArchiveStatus,
 * DatedValue/DateConfidence, RelatedRefs) instead of inventing a parallel
 * one, per issue #120's explicit requirement that memory stay "searchable
 * and compatible with the existing archive/provenance/date-confidence
 * system."
 *
 * OWNERSHIP: this memory belongs to Jenify / Headquarter — the company —
 * never to the AI worker or session that happened to record it.
 * `recordedBy` is PROVENANCE ONLY (who observed/typed the entry); it is not
 * an ownership claim, and no code should treat a memory record as private
 * to the recording actor.
 */

import {
  ARCHIVE_STATUSES,
  type ArchiveStatus,
  DATE_CONFIDENCES,
  type DateConfidence,
  type DatedValue,
  type RelatedRefs,
} from '../archive/schema.js';

/** What a piece of company memory captures. */
export const MEMORY_KINDS = [
  'decision',
  'rationale',
  'task_state',
  'project_state',
  'blocker',
  'dependency',
  'next_action',
  'evidence_note',
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);
}

/**
 * Metadata only — not an enforcement mechanism by itself. Access control for
 * 'founder_only' records is the responsibility of whatever reads hq_memory
 * (Headquarter's permission layer, per JENIFY-OS CLAUDE.md rule 3: financial
 * and other privileged visibility is enforced at the API layer, never only
 * by a UI hiding a field). This module stores the flag; it does not gate
 * reads by it.
 */
export const MEMORY_PRIVACY_LEVELS = ['internal', 'founder_only'] as const;
export type MemoryPrivacy = (typeof MEMORY_PRIVACY_LEVELS)[number];

export function isMemoryPrivacy(value: unknown): value is MemoryPrivacy {
  return typeof value === 'string' && (MEMORY_PRIVACY_LEVELS as readonly string[]).includes(value);
}

export interface MemoryRecord {
  /** Stable id — caller-supplied (e.g. deterministic slug) or a generated uuid. */
  id: string;
  kind: MemoryKind;
  title: string;
  /** The decision/rationale/state text itself. */
  body: string;
  /** Reused from archive/schema.ts — CURRENT/SUPERSEDED/REJECTED/EXPERIMENTAL/ARCHIVED. */
  status: ArchiveStatus;
  /** Provenance date + confidence (reused DatedValue from archive/schema.ts). */
  recorded: DatedValue;
  /** Provenance only — see module doc comment. Never treat as ownership. */
  recordedBy: string;
  project: string;
  /** Cross-links to issues/PRs/commits/artifacts (reused RelatedRefs). */
  related: RelatedRefs;
  /** Pointers to evidence — locations, never copies (mirrors ArchiveRecord.sourceRef). */
  sourceRefs: string[];
  tags: string[];
  /** Id of the CURRENT record this one replaces, if any. */
  supersedes?: string | null;
  /** Ids of records that have superseded this one (may branch; usually one). */
  supersededBy?: string[];
  privacy: MemoryPrivacy;
}

/**
 * Mirrors archive/schema.ts's internal ISO-8601 check. That helper is not
 * exported from archive/schema.ts (it is a private `validateDated`), so this
 * is a small, deliberate duplication of a regex literal — NOT a parallel
 * status/date-confidence vocabulary, which is exactly what issue #120 says
 * not to duplicate and which this module avoids by importing ArchiveStatus/
 * DateConfidence/DatedValue themselves.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function validateMemoryRecord(record: MemoryRecord): string[] {
  const errors: string[] = [];
  if (!record.id) errors.push('id is required');
  if (!isMemoryKind(record.kind)) errors.push(`kind must be one of: ${MEMORY_KINDS.join(', ')}`);
  if (!record.title) errors.push('title is required');
  if (!record.body) errors.push('body is required');
  if (!(ARCHIVE_STATUSES as readonly string[]).includes(record.status)) {
    errors.push(`status must be one of: ${ARCHIVE_STATUSES.join(', ')}`);
  }
  if (!record.recorded || typeof record.recorded !== 'object') {
    errors.push('recorded is required');
  } else {
    if (!record.recorded.date || !ISO_DATE.test(record.recorded.date)) {
      errors.push('recorded.date must be an ISO-8601 date');
    }
    if (!(DATE_CONFIDENCES as readonly string[]).includes(record.recorded.confidence as DateConfidence)) {
      errors.push(`recorded.confidence must be one of: ${DATE_CONFIDENCES.join(', ')}`);
    }
  }
  if (!record.recordedBy) errors.push('recordedBy is required');
  if (!record.project) errors.push('project is required');
  if (!record.related || typeof record.related !== 'object') errors.push('related is required (may be empty)');
  if (!Array.isArray(record.sourceRefs)) errors.push('sourceRefs must be an array');
  if (!Array.isArray(record.tags)) errors.push('tags must be an array');
  if (!isMemoryPrivacy(record.privacy)) {
    errors.push(`privacy must be one of: ${MEMORY_PRIVACY_LEVELS.join(', ')}`);
  }
  return errors;
}
