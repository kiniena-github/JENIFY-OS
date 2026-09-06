/**
 * Context assembly — Phase 5's read-time composition layer (issue #265).
 *
 * Turns "what does HQ know that is RELEVANT to this mission/project/task"
 * into one deterministic, bounded, provenance-labeled projection. Three laws,
 * stated here because they are the phase boundary:
 *
 * 1. **Read-time only.** Assembly composes canonical rows and memory rows at
 *    the moment of the call and persists NOTHING — this module contains no
 *    INSERT and no UPDATE. A context view is derived presentation, never a
 *    new fact; re-reading the entities after assembly returns byte-identical
 *    canonical truth.
 * 2. **Relationship-scoped, never a global dump.** Records join a context
 *    through explicit linkage only: the entity's own id, the mission's linked
 *    plan-item tasks, the mission's canonical project, and a single hop of
 *    derivation/supersession from those. Company-wide memory that lacks a
 *    link to the requested entity NEVER appears. Text search is a separate
 *    explicit act (`searchMemoryRecords`), not part of assembly.
 * 3. **Deterministic order, honest bounds.** Groups are ordered
 *    mission → task → project → related; within a group CURRENT records come
 *    before superseded ones, then newest recorded first. Every group is
 *    bounded to MEMORY_CONTEXT_LIMIT with the true total stated — trimming is
 *    visible, never silent.
 *
 * Context informs; it never grants. Nothing in this module consults or
 * produces authority, and no gate anywhere reads its output.
 */

import type { Provenance } from '../live/provenance.js';
import type { MemoryRecord } from '../memory/schema.js';
import { memoryBrowserView, type MemoryBrowserView } from './memory-command.js';

/** Per-group cap on records carried by one context view. */
export const MEMORY_CONTEXT_LIMIT = 20;

export type MemoryContextLinkage = 'mission' | 'task' | 'project' | 'related';

export interface MemoryContextGroup {
  /** How these records are connected to the requested entity. */
  linkage: MemoryContextLinkage;
  /** Bounded, deterministic slice — CURRENT-first, then newest recorded first. */
  records: MemoryBrowserView[];
  /** True group size before bounding. Included count is records.length. */
  total: number;
}

export interface ContextElement<T> {
  provenance: Provenance;
  data: T;
}

/** Lookup used for the one-hop related walk. */
export type MemoryLookup = (id: string) => MemoryRecord | null;

export interface MemoryGroupInputs {
  /** Records linked directly to the requested entity (mission_id/task_id/project_id = id). */
  direct: MemoryRecord[];
  directLinkage: MemoryContextLinkage;
  /** Records linked to the mission's plan-item tasks (mission scope only). */
  taskLinked?: MemoryRecord[];
  /** Records linked to the mission's canonical project (mission scope only). */
  projectLinked?: MemoryRecord[];
  /** Resolver for the one-hop derivation/supersession walk. */
  lookup: MemoryLookup;
}

function orderGroup(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((a, b) => {
    const aCurrent = a.status === 'CURRENT' ? 0 : 1;
    const bCurrent = b.status === 'CURRENT' ? 0 : 1;
    if (aCurrent !== bCurrent) return aCurrent - bCurrent;
    const byDate = b.recorded.date.localeCompare(a.recorded.date);
    if (byDate !== 0) return byDate;
    return a.id.localeCompare(b.id);
  });
}

function boundGroup(linkage: MemoryContextLinkage, records: MemoryRecord[]): MemoryContextGroup {
  const ordered = orderGroup(records);
  return {
    linkage,
    records: ordered.slice(0, MEMORY_CONTEXT_LIMIT).map(memoryBrowserView),
    total: ordered.length,
  };
}

/**
 * Build the memory groups for one context view. Pure over its inputs plus the
 * supplied lookup; performs no writes.
 *
 * The `related` group is exactly one hop: records reachable from the already
 * -included groups via `derivedFrom` (a summary's sources), `supersedes`
 * (the predecessor) and `supersededBy` (the successors) — and not already in
 * a group. One hop, not a closure: context stays inspectable, not viral.
 */
export function assembleMemoryGroups(inputs: MemoryGroupInputs): MemoryContextGroup[] {
  const groups: MemoryContextGroup[] = [];
  const seen = new Set<string>();

  const take = (linkage: MemoryContextLinkage, records: MemoryRecord[] | undefined): MemoryRecord[] => {
    const fresh = (records ?? []).filter((r) => !seen.has(r.id));
    for (const r of fresh) seen.add(r.id);
    if (records !== undefined) groups.push(boundGroup(linkage, fresh));
    return fresh;
  };

  const included: MemoryRecord[] = [];
  included.push(...take(inputs.directLinkage, inputs.direct));
  if (inputs.taskLinked !== undefined) included.push(...take('task', inputs.taskLinked));
  if (inputs.projectLinked !== undefined) included.push(...take('project', inputs.projectLinked));

  const relatedIds = new Set<string>();
  for (const record of included) {
    for (const id of record.derivedFrom ?? []) relatedIds.add(id);
    if (record.supersedes) relatedIds.add(record.supersedes);
    for (const id of record.supersededBy ?? []) relatedIds.add(id);
  }
  const related: MemoryRecord[] = [];
  for (const id of relatedIds) {
    if (seen.has(id)) continue;
    const record = inputs.lookup(id);
    if (record) {
      seen.add(id);
      related.push(record);
    }
  }
  groups.push(boundGroup('related', related));

  return groups;
}

/** Provenance for a memory group element — names what was actually read. */
export function memoryContextProvenance(scope: string, asOf: string): Provenance {
  return {
    mode: 'live',
    source: `hq_memory entity-linked reads for ${scope} (MemoryStore.listBy*, one-hop related walk)`,
    asOf,
  };
}

/**
 * One assembled context view: the canonical entity element plus its bounded,
 * provenance-labeled memory groups. `entity.data` is the entity's existing
 * browser-safe projection — context invents no second projection of canonical
 * truth.
 */
export interface EntityContextView<T> {
  scope: 'mission' | 'project' | 'task';
  entityId: string;
  assembledAt: string;
  entity: ContextElement<T>;
  memory: ContextElement<MemoryContextGroup[]>;
}
