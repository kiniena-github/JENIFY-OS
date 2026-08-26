/**
 * Monthly and project-evolution views over canonical archive records
 * (issue #43, order 4). Both derive from the same records — no second
 * source of truth.
 */

import type { ArchiveRecord } from './schema.js';
import { archivePeriod } from './schema.js';

export interface MonthlyGroup {
  year: string;
  month: string;
  records: ArchiveRecord[];
}

/** Chronological browsing: records grouped by year/month, newest month first. */
export function monthlyView(records: ArchiveRecord[]): MonthlyGroup[] {
  const groups = new Map<string, MonthlyGroup>();
  for (const record of records) {
    const { year, month } = archivePeriod(record);
    const key = `${year}-${month}`;
    const group = groups.get(key) ?? { year, month, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.records.sort((a, b) => a.created.date.localeCompare(b.created.date));
  }
  return [...groups.values()].sort((a, b) => `${b.year}-${b.month}`.localeCompare(`${a.year}-${a.month}`));
}

export interface EvolutionChain {
  /** Head-of-chain record id. */
  rootId: string;
  /** Records ordered predecessor → successor. */
  entries: ArchiveRecord[];
}

/**
 * Product-version browsing: follow predecessor/successor links per project.
 * Records without links form single-entry chains, ordered by creation date.
 */
export function projectEvolutionView(records: ArchiveRecord[], project: string): EvolutionChain[] {
  const inProject = records.filter((record) => record.project === project);
  const byId = new Map(inProject.map((record) => [record.id, record]));
  const roots = inProject.filter(
    (record) => !record.predecessorId || !byId.has(record.predecessorId),
  );
  const chains: EvolutionChain[] = [];
  for (const root of roots) {
    const entries: ArchiveRecord[] = [];
    const seen = new Set<string>();
    let current: ArchiveRecord | undefined = root;
    while (current && !seen.has(current.id)) {
      entries.push(current);
      seen.add(current.id);
      const nextId: string | undefined = current.successorIds?.[0];
      current = nextId ? byId.get(nextId) : undefined;
    }
    chains.push({ rootId: root.id, entries });
  }
  return chains.sort((a, b) => a.entries[0].created.date.localeCompare(b.entries[0].created.date));
}

/** All distinct projects present in the records, alphabetical. */
export function listProjects(records: ArchiveRecord[]): string[] {
  return [...new Set(records.map((record) => record.project))].sort();
}
