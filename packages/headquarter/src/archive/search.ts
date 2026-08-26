/**
 * Search/indexing foundation over archive records (issue #43, order 5).
 *
 * A dependency-free inverted index answering queries like
 * "show every QOS chatbot upgrade" via free text plus structured filters,
 * without folder hunting.
 */

import type { ArchiveRecord, ArchiveStatus } from './schema.js';

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

export interface SearchIndex {
  /** token → record ids containing it (in title, summary, tags, category, project). */
  postings: Map<string, Set<string>>;
  records: Map<string, ArchiveRecord>;
}

export function buildIndex(records: ArchiveRecord[]): SearchIndex {
  const postings = new Map<string, Set<string>>();
  const byId = new Map<string, ArchiveRecord>();
  for (const record of records) {
    byId.set(record.id, record);
    const text = [record.title, record.summary, record.project, record.category, record.version, ...record.tags].join(' ');
    for (const token of new Set(tokenize(text))) {
      const ids = postings.get(token) ?? new Set<string>();
      ids.add(record.id);
      postings.set(token, ids);
    }
  }
  return { postings, records: byId };
}

export interface SearchQuery {
  text?: string;
  project?: string;
  category?: string;
  status?: ArchiveStatus;
  year?: string;
  tag?: string;
}

export interface SearchHit {
  record: ArchiveRecord;
  /** Number of query tokens matched (all tokens must match to be a hit). */
  score: number;
}

export function search(index: SearchIndex, query: SearchQuery): SearchHit[] {
  let candidateIds: Set<string>;
  const tokens = query.text ? tokenize(query.text) : [];
  if (tokens.length > 0) {
    // AND semantics: every token must appear somewhere in the record.
    let intersection: Set<string> | null = null;
    for (const token of tokens) {
      const ids = index.postings.get(token) ?? new Set<string>();
      if (intersection === null) {
        intersection = new Set(ids);
      } else {
        const previous: Set<string> = intersection;
        intersection = new Set([...previous].filter((id) => ids.has(id)));
      }
      if (intersection.size === 0) break;
    }
    candidateIds = intersection ?? new Set(index.records.keys());
  } else {
    candidateIds = new Set(index.records.keys());
  }

  const hits: SearchHit[] = [];
  for (const id of candidateIds) {
    const record = index.records.get(id);
    if (!record) continue;
    if (query.project && record.project !== query.project) continue;
    if (query.category && record.category !== query.category) continue;
    if (query.status && record.status !== query.status) continue;
    if (query.year && !record.created.date.startsWith(query.year)) continue;
    if (query.tag && !record.tags.includes(query.tag)) continue;
    hits.push({ record, score: tokens.length });
  }
  return hits.sort(
    (a, b) => b.record.created.date.localeCompare(a.record.created.date) || a.record.id.localeCompare(b.record.id),
  );
}
