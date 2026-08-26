/**
 * Inventory/reconstruction pipeline (issue #43, order 3).
 *
 * Reads GitHub-visible history (git log, exported issues/PRs) and
 * reconstructs canonical ArchiveRecords. Sources are read-only: evidence
 * items keep their original location and input objects are never mutated.
 * Drive/files ingestion later happens by exporting the same EvidenceItem
 * JSON shape and feeding it through StaticExportAdapter — no new pipeline.
 */

import type { ArchiveRecord, ArchiveStatus, DateConfidence, RelatedRefs } from './schema.js';

export interface EvidenceItem {
  kind: 'commit' | 'issue' | 'pull_request' | 'file' | 'report';
  /** Source-native id: commit sha, issue/PR number as string, file path. */
  id: string;
  title: string;
  project?: string;
  category?: string;
  /** ISO date/instant when known. */
  date?: string;
  /** Where the date came from; decides confidence. */
  dateSource?: 'git' | 'github-api' | 'filename' | 'manual' | 'unknown';
  body?: string;
  refs?: RelatedRefs;
  /** Original evidence location (URL or repo path). Preserved verbatim. */
  location: string;
  /** Optional explicit version tag, e.g. "V0", "R4". */
  version?: string;
  /** Optional explicit status override. */
  status?: ArchiveStatus;
}

export interface SourceAdapter {
  readonly name: string;
  collect(): EvidenceItem[];
}

/* ------------------------------------------------------------------ */
/* Git log adapter                                                     */
/* ------------------------------------------------------------------ */

export const GIT_LOG_FORMAT = '%H%x1f%aI%x1f%s%x1e';

/**
 * Adapter over `git log --pretty=format:'%H%x1f%aI%x1f%s%x1e'` output.
 * The caller runs git and passes raw text, keeping this module pure.
 */
export function createGitLogAdapter(rawLog: string, options: { project: string; repoUrl?: string }): SourceAdapter {
  return {
    name: 'git-log',
    collect(): EvidenceItem[] {
      return rawLog
        .split('\x1e')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => {
          const [sha, authorDate, subject] = entry.split('\x1f');
          const short = (sha ?? '').slice(0, 7);
          return {
            kind: 'commit' as const,
            id: short,
            title: subject ?? '(no subject)',
            project: options.project,
            category: 'code-change',
            date: authorDate,
            dateSource: 'git' as const,
            refs: { commits: [sha ?? short] },
            location: options.repoUrl ? `${options.repoUrl}/commit/${sha}` : `commit ${sha}`,
          };
        });
    },
  };
}

/* ------------------------------------------------------------------ */
/* GitHub export adapter                                               */
/* ------------------------------------------------------------------ */

export interface GitHubExport {
  repo: string;
  repoUrl?: string;
  issues?: Array<{ number: number; title: string; body?: string; created_at: string; state?: string; labels?: string[] }>;
  pullRequests?: Array<{ number: number; title: string; body?: string; created_at: string; state?: string; merged?: boolean; head?: string }>;
}

/** Adapter over a pre-exported issues/PRs JSON snapshot (no live API calls). */
export function createGitHubExportAdapter(data: GitHubExport): SourceAdapter {
  const base = data.repoUrl ?? `https://github.com/${data.repo}`;
  return {
    name: 'github-export',
    collect(): EvidenceItem[] {
      const items: EvidenceItem[] = [];
      for (const issue of data.issues ?? []) {
        items.push({
          kind: 'issue',
          id: String(issue.number),
          title: issue.title,
          project: data.repo.split('/').pop(),
          category: issue.labels?.includes('ai-task') ? 'ai-task' : 'issue',
          date: issue.created_at,
          dateSource: 'github-api',
          body: issue.body,
          refs: { issues: [issue.number] },
          location: `${base}/issues/${issue.number}`,
        });
      }
      for (const pr of data.pullRequests ?? []) {
        items.push({
          kind: 'pull_request',
          id: String(pr.number),
          title: pr.title,
          project: data.repo.split('/').pop(),
          category: 'pull-request',
          date: pr.created_at,
          dateSource: 'github-api',
          body: pr.body,
          refs: { pullRequests: [pr.number] },
          location: `${base}/pull/${pr.number}`,
        });
      }
      return items;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Static export adapter (Drive/files later)                           */
/* ------------------------------------------------------------------ */

/**
 * Adapter over any pre-exported EvidenceItem[] JSON. A future Drive/local-file
 * connector only needs to emit this shape; the pipeline stays unchanged.
 */
export function createStaticExportAdapter(name: string, items: EvidenceItem[]): SourceAdapter {
  return { name, collect: () => items.map((item) => ({ ...item })) };
}

/* ------------------------------------------------------------------ */
/* Reconstruction                                                      */
/* ------------------------------------------------------------------ */

export interface ReconstructOptions {
  /** Project used when an evidence item names none. */
  defaultProject: string;
  /**
   * Fallback creation date (ISO) for undated evidence; recorded with
   * confidence "estimated" so it is never silently trusted.
   */
  fallbackDate: string;
}

function confidenceFor(source: EvidenceItem['dateSource']): DateConfidence {
  if (source === 'git' || source === 'github-api') return 'exact';
  if (source === 'filename' || source === 'manual') return 'inferred';
  return 'estimated';
}

const KIND_PREFIX: Record<EvidenceItem['kind'], string> = {
  commit: 'commit',
  issue: 'issue',
  pull_request: 'pr',
  file: 'file',
  report: 'report',
};

/** Extract a version token like V0, v1.2, R4 from a title, defaulting to "v1". */
export function versionFromTitle(title: string): string {
  const match = title.match(/\b([VvRr]\d+(?:\.\d+)*)\b/);
  return match ? match[1] : 'v1';
}

/**
 * Map raw evidence to canonical archive records. Pure and deterministic:
 * the same evidence always yields the same records; inputs are not mutated.
 */
export function reconstructArchive(items: EvidenceItem[], options: ReconstructOptions): ArchiveRecord[] {
  return items.map((item) => {
    const dated = item.date
      ? { date: item.date, confidence: confidenceFor(item.dateSource), source: item.dateSource ?? 'unknown' }
      : { date: options.fallbackDate, confidence: 'estimated' as DateConfidence, source: 'fallback' };
    return {
      id: `${KIND_PREFIX[item.kind]}-${item.id}`,
      title: item.title,
      project: item.project ?? options.defaultProject,
      category: item.category ?? item.kind,
      created: dated,
      evidence: dated,
      version: item.version ?? versionFromTitle(item.title),
      status: item.status ?? 'CURRENT',
      predecessorId: null,
      successorIds: [],
      related: item.refs ? { ...item.refs } : {},
      sourceRef: item.location,
      summary: item.body ? item.body.slice(0, 280) : item.title,
      tags: [item.kind],
    };
  });
}

/**
 * Explicitly declare an evolution chain (oldest → newest) between records.
 * Links predecessor/successor and marks earlier entries SUPERSEDED unless
 * they already carry a terminal status (REJECTED/ARCHIVED/EXPERIMENTAL).
 */
export function linkEvolutionChain(records: ArchiveRecord[], orderedIds: string[]): ArchiveRecord[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const id of orderedIds) {
    if (!byId.has(id)) throw new Error(`linkEvolutionChain: unknown record id "${id}"`);
  }
  return records.map((record) => {
    const index = orderedIds.indexOf(record.id);
    if (index === -1) return record;
    const predecessorId = index > 0 ? orderedIds[index - 1] : null;
    const successorIds = index < orderedIds.length - 1 ? [orderedIds[index + 1]] : [];
    const isLatest = index === orderedIds.length - 1;
    const keepStatus = record.status !== 'CURRENT';
    return {
      ...record,
      predecessorId,
      successorIds,
      status: isLatest || keepStatus ? record.status : 'SUPERSEDED',
    };
  });
}
