/**
 * Memory Command — the `hq.memory_command` capability trio (Phase 5,
 * issue #265).
 *
 * The one capability a Founder memory act exercises: recording (and, via
 * `supersedes`, superseding) canonical company memory records from the
 * control boundary. It follows the mission/project/workforce
 * CONFIGURATION-vs-INVOCATION pattern exactly: registration is a separate
 * explicit act, invocation fails closed on missing/altered/disabled, and
 * detection never repairs.
 *
 * What this capability deliberately is NOT:
 * - not an execution right — a memory record changes no task status, burns
 *   no approval, dispatches nothing, and no gate anywhere reads hq_memory;
 * - not a rewrite right — the store is insert-only BY ENGINE; "changing"
 *   memory is recording a successor that names its predecessor;
 * - not a worker-facing power — the facade refuses worker identity outright,
 *   so no worker can write company memory as itself.
 */

import { createHash } from 'node:crypto';
import type { HqDatabase } from '../store/db.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import { canonicalJson } from '../operator/approvals.js';
import type { MemoryKind, MemoryPrivacy, MemoryRecord } from '../memory/schema.js';
import type { ArchiveStatus, DateConfidence, RelatedRefs } from '../archive/schema.js';

export const MEMORY_COMMAND_CAPABILITY = {
  id: 'hq.memory_command',
  description:
    'Founder memory command — records and supersedes canonical company memory records. ' +
    'Writes the company record only; executes nothing.',
  riskClass: 'founder_gate',
  sideEffect: false,
  idempotent: true,
} as const;

/** Register the memory-command capability — a CONFIGURATION action. */
export function registerMemoryCommandCapability(db: HqDatabase): void {
  new CapabilityRegistry(db).register({ ...MEMORY_COMMAND_CAPABILITY });
}

export const MEMORY_COMMAND_RESERVED_CONTRACT = {
  riskClass: MEMORY_COMMAND_CAPABILITY.riskClass,
  sideEffect: MEMORY_COMMAND_CAPABILITY.sideEffect,
  idempotent: MEMORY_COMMAND_CAPABILITY.idempotent,
} as const;

/** Which contract fields the registry's CURRENT row disagrees with, if any. */
export function memoryCommandContractDrift(capability: Capability): string[] {
  const drift: string[] = [];
  if (capability.riskClass !== MEMORY_COMMAND_RESERVED_CONTRACT.riskClass) drift.push('riskClass');
  if (capability.sideEffect !== MEMORY_COMMAND_RESERVED_CONTRACT.sideEffect) drift.push('sideEffect');
  if (capability.idempotent !== MEMORY_COMMAND_RESERVED_CONTRACT.idempotent) drift.push('idempotent');
  return drift;
}

export type MemoryCommandCapabilityState = 'missing' | 'altered' | 'disabled' | 'enabled';

/**
 * Classify the registry's current row. Callers supply the row from an
 * ENFORCEMENT-SAFE read, never from `queue.capabilities` (#219). Drift is
 * checked before `enabled`, and detecting drift never repairs it.
 */
export function memoryCommandCapabilityState(
  capability: Capability | null,
): MemoryCommandCapabilityState {
  if (!capability) return 'missing';
  if (memoryCommandContractDrift(capability).length > 0) return 'altered';
  return capability.enabled ? 'enabled' : 'disabled';
}

// ---- bounds ----

export const MAX_MEMORY_TITLE_LENGTH = 200;
export const MAX_MEMORY_BODY_LENGTH = 4000;
export const MAX_MEMORY_PROJECT_LABEL_LENGTH = 120;
export const MAX_MEMORY_LIST_ITEMS = 20;
export const MAX_MEMORY_TAG_LENGTH = 60;
/** Source refs are locators (paths, URLs, `hq://` ids) — longer than tags, still bounded. */
export const MAX_MEMORY_SOURCE_REF_LENGTH = 500;
/**
 * `recorded.source` — the caller's free-text note about where the DATE came
 * from ("git author date", "chat log"). Bounded since Phase 11, because it is
 * persisted, published on `memoryBrowserView`, and indexed by search: an
 * unbounded, unscanned field on a published projection is exactly the shape a
 * secret gets smuggled through.
 */
export const MAX_MEMORY_RECORDED_SOURCE_LENGTH = 200;

// ---- idempotency ----

/**
 * Derived dedupe key for a memory record. The caller's `idempotencyKey` is an
 * INPUT to the digest, never the key itself (the mission/project rule): a
 * client cannot choose a stored key, only make two otherwise-identical
 * submissions distinct.
 */
export function memoryCommandIdempotencyKey(input: {
  requestedBy: string;
  kind: MemoryKind;
  title: string;
  body: string;
  project: string;
  missionId: string | null;
  projectId: string | null;
  taskId: string | null;
  supersedes: string | null;
  derivedFrom: string[];
  privacy: MemoryPrivacy;
  idempotencyKey: string | null;
}): string {
  const digest = createHash('sha256').update(canonicalJson(input)).digest('hex');
  return `memory:${digest.slice(0, 32)}`;
}

// ---- browser projection ----

/**
 * The ONE browser-safe projection of a memory record, shared by the control
 * routes and the snapshot so the two can never disagree about what the
 * browser sees. Absent by shape: the stored idempotency key.
 */
export interface MemoryBrowserView {
  id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  status: ArchiveStatus;
  recorded: { date: string; confidence: DateConfidence; source: string | null };
  recordedBy: string;
  /** Free-text LABEL — never matched against the project register. */
  project: string;
  missionId: string | null;
  projectId: string | null;
  taskId: string | null;
  derivedFrom: string[];
  related: RelatedRefs;
  sourceRefs: string[];
  tags: string[];
  supersedes: string | null;
  supersededBy: string[];
  privacy: MemoryPrivacy;
}

export function memoryBrowserView(record: MemoryRecord): MemoryBrowserView {
  return {
    id: record.id,
    kind: record.kind,
    title: record.title,
    body: record.body,
    status: record.status,
    recorded: {
      date: record.recorded.date,
      confidence: record.recorded.confidence,
      source: record.recorded.source ?? null,
    },
    recordedBy: record.recordedBy,
    project: record.project,
    missionId: record.missionId ?? null,
    projectId: record.projectId ?? null,
    taskId: record.taskId ?? null,
    derivedFrom: record.derivedFrom ?? [],
    related: record.related,
    sourceRefs: record.sourceRefs,
    tags: record.tags,
    supersedes: record.supersedes ?? null,
    supersededBy: record.supersededBy ?? [],
    privacy: record.privacy,
  };
}
