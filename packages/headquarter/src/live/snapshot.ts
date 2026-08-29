/**
 * Browser-safe HQ snapshot (issue #200, scope A).
 *
 * The smallest read-only seam between canonical HQ state and a browser. It is
 * a projection, not a second source of truth: every field is copied from the
 * existing canonical read models (`application/console.ts`, the specialist
 * directory, the capability registry, the canonical event log) or from
 * evidence-derived connection status. Nothing here derives a status, infers a
 * completion, or fills in a field the control plane does not record.
 *
 * Four properties are enforced mechanically rather than by convention, because
 * this is the one artefact that leaves the machine:
 *
 *   1. **No task payloads.** `ConsoleTask` deliberately has no payload field,
 *      and this module never reaches past it to `OperatorTask.payload`. An
 *      order's instruction text is Founder input and stays server-side; the
 *      browser sees the task, its status and its digest, not its contents.
 *   2. **No secrets.** `assertBrowserSafe` walks the finished snapshot and
 *      throws rather than publishing. Fail closed: a snapshot that cannot be
 *      proven safe is not written at all.
 *   3. **No invented metrics.** `assertNoFabricatedFields` refuses cost,
 *      token, ETA, sentiment and progress fields — HQ measures none of them.
 *   4. **Provenance per section.** Each section states its own mode and what
 *      was read; the snapshot's overall mode is the weakest of them, so one
 *      sample section can never let the whole thing render as LIVE.
 *
 * Activity `detail` is whitelisted to the two presentation labels the UI
 * actually uses. The canonical envelope permits arbitrary detail, and passing
 * it through unfiltered would make the browser boundary depend on whatever a
 * worker happened to write.
 */

import path from 'node:path';
import type { ActivityEvent } from '../contracts/events.js';
import type { WorkerDescriptor } from '../contracts/workers.js';
import type { Capability } from '../operator/capabilities.js';
import { classifyCapability, type TaskClassification } from '../application/classification.js';
import { founderConsole, type FounderConsole } from '../application/console.js';
import { directOrderDispatchBlocked } from './orders.js';
import { dispatchHistory } from '../providers/claude/dispatch.js';
import type { HeadquarterOperations } from '../application/service.js';
import type { ProviderId, SecretsEnv } from '../routing/providers.js';
import { assessConnections, type ConnectionProbe, type ConnectionStatus } from './connections.js';
import { assertBrowserSafe, assertNoFabricatedFields } from './redaction.js';
import {
  section,
  weakestMode,
  type Provenance,
  type SnapshotSection,
  type SourceMode,
} from './provenance.js';

/** Bumped whenever the wire shape changes incompatibly. */
export const HQ_SNAPSHOT_VERSION = 1;

/** How many recent canonical events a snapshot carries. */
export const SNAPSHOT_ACTIVITY_LIMIT = 40;

/** One canonical event, trimmed to what the browser renders. */
export interface SnapshotActivityEntry {
  seq: number;
  at: string;
  actor: string;
  subjectKind: string;
  subjectId: string;
  status: string | null;
  summary: string;
  project: string | null;
  title: string | null;
  refs: string[];
}

export interface SnapshotWorker {
  id: string;
  displayName: string;
  vendor: string;
  role: string;
  active: boolean;
  /** GRANTED capability ids from the directory — never advertised claims. */
  allowedCapabilities: string[];
}

export interface SnapshotCapability {
  id: string;
  description: string;
  riskClass: string;
  sideEffect: boolean;
  idempotent: boolean;
  enabled: boolean;
  classification: TaskClassification;
}

export interface SnapshotCounts {
  approvals: number;
  pendingReviews: number;
  outcomeUnknown: number;
  blocked: number;
  inFlight: number;
  queued: number;
}

export interface HqSnapshot {
  snapshotVersion: number;
  generatedAt: string;
  /** Weakest mode across all sections — the honest headline claim. */
  mode: SourceMode;
  note: string | null;
  counts: SnapshotCounts;
  operations: SnapshotSection<FounderConsole>;
  connections: SnapshotSection<ConnectionStatus[]>;
  workforce: SnapshotSection<SnapshotWorker[]>;
  capabilities: SnapshotSection<SnapshotCapability[]>;
  activity: SnapshotSection<SnapshotActivityEntry[]>;
}

/**
 * An operational section with nothing in it.
 *
 * Used by the static site build, which renders a data bundle and never opens
 * the HQ database. Saying "zero tasks, and here is where that came from" is
 * honest; inventing operational rows from a presentation bundle would not be.
 */
export function emptyFounderConsole(generatedAt: string): FounderConsole {
  return {
    generatedAt,
    killSwitch: { globalEngaged: false, engagedScopes: [] },
    approvals: [],
    pendingReviews: [],
    outcomeUnknown: [],
    blocked: [],
    inFlight: [],
    queued: [],
  };
}

function stringDetail(event: ActivityEvent, key: string): string | null {
  const value = event.detail?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Trim canonical events to the whitelisted presentation fields. */
export function trimActivity(
  events: readonly ActivityEvent[],
  limit = SNAPSHOT_ACTIVITY_LIMIT,
): SnapshotActivityEntry[] {
  return [...events]
    .sort((a, b) => b.seq - a.seq)
    .slice(0, limit)
    .map((event) => ({
      seq: event.seq,
      at: event.at,
      actor: event.actor,
      subjectKind: event.subjectKind,
      subjectId: event.subjectId,
      status: event.status ?? null,
      summary: event.summary,
      project: stringDetail(event, 'project'),
      title: stringDetail(event, 'title'),
      // Only absolute https refs: a local path would leak the machine's layout.
      refs: (event.refs ?? []).filter((ref) => ref.startsWith('https:')),
    }));
}

export interface SnapshotSources {
  generatedAt: string;
  note?: string;
  console: { data: FounderConsole; provenance: Provenance };
  connections: { data: ConnectionStatus[]; provenance: Provenance };
  workforce: { data: WorkerDescriptor[]; provenance: Provenance };
  capabilities: { data: Capability[]; provenance: Provenance };
  activity: { data: ActivityEvent[]; provenance: Provenance };
  policyContext?: Parameters<typeof classifyCapability>[1];
  activityLimit?: number;
}

/**
 * Assemble a snapshot from already-read sections, then prove it is publishable.
 *
 * Pure: same inputs, same bytes. That is what keeps the static build
 * reproducible and lets tests assert on the whole artefact.
 */
export function buildHqSnapshot(sources: SnapshotSources): HqSnapshot {
  const console_ = sources.console.data;
  const snapshot: HqSnapshot = {
    snapshotVersion: HQ_SNAPSHOT_VERSION,
    generatedAt: sources.generatedAt,
    mode: weakestMode([
      sources.console.provenance.mode,
      sources.connections.provenance.mode,
      sources.workforce.provenance.mode,
      sources.capabilities.provenance.mode,
      sources.activity.provenance.mode,
    ]),
    note: sources.note ?? null,
    counts: {
      approvals: console_.approvals.length,
      pendingReviews: console_.pendingReviews.length,
      outcomeUnknown: console_.outcomeUnknown.length,
      blocked: console_.blocked.length,
      inFlight: console_.inFlight.length,
      queued: console_.queued.length,
    },
    operations: section(sources.console.provenance, console_),
    connections: section(sources.connections.provenance, sources.connections.data),
    workforce: section(
      sources.workforce.provenance,
      sources.workforce.data.map((worker) => ({
        id: worker.id,
        displayName: worker.displayName,
        vendor: worker.vendor,
        role: worker.role,
        active: worker.active,
        allowedCapabilities: [...worker.allowedCapabilities],
      })),
    ),
    capabilities: section(
      sources.capabilities.provenance,
      sources.capabilities.data.map((capability) => ({
        id: capability.id,
        description: capability.description,
        riskClass: capability.riskClass,
        sideEffect: capability.sideEffect,
        idempotent: capability.idempotent,
        enabled: capability.enabled,
        classification: classifyCapability(capability, sources.policyContext ?? {}),
      })),
    ),
    activity: section(
      sources.activity.provenance,
      trimActivity(sources.activity.data, sources.activityLimit),
    ),
  };

  // Fail closed: prove it before anyone can publish it.
  assertBrowserSafe(snapshot);
  assertNoFabricatedFields(snapshot);
  return snapshot;
}

export interface LiveSnapshotOptions {
  /** Instant to stamp. Injected so tests and reproducible builds control it. */
  now: string;
  /** Non-secret facts (and secret PRESENCE flags) for connection probing. */
  env?: SecretsEnv;
  note?: string;
  /**
   * Overall claim for the operational sections. Defaults to 'live' because
   * this function genuinely reads the canonical tables; a caller replaying a
   * fixture should pass 'sample' rather than let a fixture render as LIVE.
   */
  mode?: SourceMode;
  activityLimit?: number;
  /**
   * Connection probes to assess with (issue #221, Codex P2 on `1d5b3bf`).
   *
   * Omitted, the default catalogue probes are used, exactly as before — which is
   * the right answer for a CI or static-site build, where nothing may spawn a
   * process or call a provider. A caller that runs ON the machine holding an
   * integration (the local `hq:snapshot` CLI) passes a probe set that can
   * genuinely observe it, so the Connection Center shows what is actually true
   * there instead of a generic environment-variable inventory.
   */
  connectionProbes?: readonly ConnectionProbe[];
  /**
   * Transport-backed dispatchability for a provider — true/false when the host
   * genuinely knows, null when it does not (issue #224, Codex P1 on
   * `faf4fda`). Supplied by the local snapshot CLI, which holds the real GitHub
   * transport; omitted by CI and static builds, which hold nothing and fall
   * back to the routing contract.
   */
  dispatchAvailability?: (provider: ProviderId) => boolean | null;
}

/**
 * Read a live snapshot straight out of a running `HeadquarterOperations`.
 *
 * Read-only by construction: `founderConsole`, the specialist directory, the
 * capability registry and the event log are all read paths. Nothing on this
 * code path can write.
 */
/**
 * Mark direct orders whose bound provider cannot dispatch right now (issue
 * #224), so the Founder console shows BLOCKED / NOT CONNECTED rather than an
 * ordinary pending approval.
 *
 * Done HERE rather than inside `founderConsole`, deliberately. The console is
 * env-blind by design — it copies canonical status and never infers — and
 * connectivity is not canonical state: it is an observation of the world that
 * changes without any task changing. The snapshot layer is the one place that
 * already holds both, so this is the narrowest seam that can answer the
 * question truthfully, and it adds a derived FIELD without touching the
 * canonical `status` a task carries.
 */
function withDispatchBlocked(
  data: FounderConsole,
  ops: HeadquarterOperations,
  env: SecretsEnv,
  providerDispatchable?: (provider: ProviderId) => boolean | null,
): FounderConsole {
  const mark = <T extends { taskId: string }>(card: T): T => {
    const task = ops.queue.get(card.taskId);
    if (!task) return card;
    return {
      ...card,
      dispatchBlocked: directOrderDispatchBlocked(task, env, {
        // Evidence first: an order HQ has already published is not blocked,
        // whatever the environment looks like now.
        alreadyDispatched: dispatchHistory(ops, card.taskId).state === 'dispatched',
        providerDispatchable,
      }),
    };
  };
  return {
    ...data,
    approvals: data.approvals.map(mark),
    pendingReviews: data.pendingReviews.map(mark),
    outcomeUnknown: data.outcomeUnknown.map(mark),
    blocked: data.blocked.map(mark),
    inFlight: data.inFlight.map(mark),
    queued: data.queued.map(mark),
  };
}

export function liveSnapshotFromOperations(
  ops: HeadquarterOperations,
  options: LiveSnapshotOptions,
): HqSnapshot {
  const mode = options.mode ?? 'live';
  const at = options.now;
  const env = options.env ?? {};
  const provenanceFor = (source: string): Provenance => ({ mode, source, asOf: at });

  return buildHqSnapshot({
    generatedAt: at,
    note: options.note,
    policyContext: ops.policyContext,
    activityLimit: options.activityLimit,
    console: {
      data: withDispatchBlocked(founderConsole(ops, new Date(at)), ops, env, options.dispatchAvailability),
      provenance: provenanceFor('op_tasks / hq_approvals via application/console.founderConsole'),
    },
    connections: {
      // Connection state is evidence-derived on every build; it is never
      // inherited from the snapshot's own mode.
      data: assessConnections(env, { now: at, probes: options.connectionProbes }),
      provenance: {
        mode,
        source: 'live/connections.assessConnections over observed environment facts',
        asOf: at,
        note: 'Connection state is derived from observed facts, never from provider descriptors.',
      },
    },
    workforce: {
      data: ops.store.listSpecialists(),
      provenance: provenanceFor('hq_specialists via HeadquarterStore.listSpecialists'),
    },
    capabilities: {
      data: ops.queue.capabilities.list(),
      provenance: provenanceFor('op_capabilities via CapabilityRegistry.list'),
    },
    activity: {
      data: ops.store.latestStatusPerSubject(),
      provenance: provenanceFor('hq_events via HeadquarterStore.latestStatusPerSubject'),
    },
  });
}

/**
 * A provenance label for a bundle path that is truthful AND portable
 * (issue #200, integration lane — coordinator finding on `hq-snapshot.json`).
 *
 * The snapshot is served to the browser, and the naive interpolation of a
 * resolved `dataPath` embedded the build machine's absolute checkout path in
 * three provenance `source` fields — host filesystem layout and account name
 * a client has no business receiving, and a build that differed byte-for-byte
 * per checkout location, breaking reproducible builds.
 *
 * This keeps the attribution genuinely informative without either problem:
 * a path inside the repository becomes repo-relative with forward slashes
 * (identical on every machine and OS); a path OUTSIDE the repository — a
 * custom bundle on some operator's disk — contributes only its basename,
 * because everything above it is precisely the host information that must
 * not travel.
 */
export function portableSourceLabel(dataPath: string, repoRoot: string): string {
  const resolved = path.resolve(dataPath);
  const relative = path.relative(path.resolve(repoRoot), resolved);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return path.basename(resolved);
  return relative.split(path.sep).join('/');
}
