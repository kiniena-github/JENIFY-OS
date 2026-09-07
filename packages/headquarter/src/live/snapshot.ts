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
import { missionBrowserView, type MissionBrowserView } from '../application/mission-command.js';
import { projectBrowserView, type ProjectBrowserView } from '../application/project-command.js';
import type { MemoryBrowserView } from '../application/memory-command.js';
import { TRUTH_SNAPSHOT_LIMIT, type TruthSnapshotView } from '../application/truth-command.js';
import { COLLABORATION_SNAPSHOT_LIMIT, type CollaborationSnapshotView } from '../application/collaboration-command.js';
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

/**
 * Bumped whenever the wire shape changes incompatibly.
 *
 * Phase 3 added the `missions` section and `counts.missions` WITHOUT a bump,
 * deliberately: the change is purely additive, no consumer validates by
 * exhaustive shape, and the site and server deploy as one unit. A bump is for
 * a change an old reader would misread, not for a field it never looks at.
 */
export const HQ_SNAPSHOT_VERSION = 1;

/** How many recent canonical events a snapshot carries. */
export const SNAPSHOT_ACTIVITY_LIMIT = 40;

/**
 * How many missions the WRITTEN snapshot artefact carries (the `hq:snapshot`
 * CLI passes this as `missionLimit`). Deliberately an opt-in bound: the live
 * `/state` route passes no limit, so the Mission Room's rows and metrics
 * never silently truncate. When the bound applies, `counts.missions` still
 * reports the TOTAL and the section's provenance says what was trimmed.
 */
export const SNAPSHOT_MISSION_LIMIT = 40;

/**
 * How many memory records the WRITTEN snapshot artefact carries (Phase 5,
 * issue #265 — the mission-limit policy applied to memory). Opt-in exactly
 * like `missionLimit`: the live `/state` route passes no limit. When rows are
 * trimmed or excluded, `counts.memory` still reports the TOTAL and the
 * section's provenance says what was withheld.
 */
export const SNAPSHOT_MEMORY_LIMIT = 40;

/**
 * Bound a mission list to the NEWEST `limit`, returned oldest-first (the
 * order `listMissions` already uses, so bounded and unbounded sections read
 * the same way). Mirrors `trimActivity`; unlike it, this trims rows only —
 * the browser view is already the whitelisted projection.
 */
export function trimMissions(
  missions: readonly MissionBrowserView[],
  limit = SNAPSHOT_MISSION_LIMIT,
): MissionBrowserView[] {
  const byNewest = [...missions].sort((a, b) =>
    a.createdAt === b.createdAt
      ? b.id.localeCompare(a.id)
      : b.createdAt.localeCompare(a.createdAt),
  );
  return byNewest.slice(0, limit).reverse();
}

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
  /**
   * Declared execution provider (Phase 4). Null = no declaration exists —
   * never inferred from the vendor string. `dispatchable` is transport truth
   * three-valued: true/false when the building context genuinely observed
   * it, null when it could not (a static build observes nothing).
   */
  provider: { declaredId: string; dispatchable: boolean | null } | null;
  /**
   * AI member enrichment (Phase 4): the registry record sharing this worker
   * id, when one exists. Identity/status/health truth only; health is
   * 'unknown' until somebody explicitly declared otherwise.
   */
  member: {
    identityKey: string;
    status: string;
    health: string;
    healthCheckedAt: string | null;
  } | null;
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
  /** Canonical missions commanded by the Founder (Phase 3). 0 means 0. */
  missions: number;
  /** Canonical project register entries (Phase 4). 0 means 0. */
  projects: number;
  /**
   * ALL company memory records (Phase 5) — including rows the section's data
   * excludes (founder_only in the unauthenticated artifact) or trims. The
   * count-only disclosure is deliberate and stated in the section provenance.
   */
  memory: number;
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
  /**
   * The canonical Mission aggregate (Phase 3, issue #254) — the SHARED
   * `missionBrowserView` projection, so this section and the mission routes
   * cannot disagree about what the browser sees. No intent bodies, no
   * idempotency keys, no invented metrics.
   */
  missions: SnapshotSection<MissionBrowserView[]>;
  /**
   * The canonical Project register (Phase 4, issue #262) — the shared
   * `projectBrowserView` projection, same one-implementation rule as
   * missions. Unbounded deliberately: a Founder-typed register is inherently
   * small, so a trim limit would be machinery for a scale the data cannot
   * reach. Added WITHOUT a version bump — purely additive, per the
   * `HQ_SNAPSHOT_VERSION` policy above.
   */
  projects: SnapshotSection<ProjectBrowserView[]>;
  /**
   * Company memory (Phase 5, issue #265) — the shared `memoryBrowserView`
   * projection, same one-implementation rule as missions/projects. The
   * Founder-gated `/state` route carries every record; the unauthenticated
   * artifact excludes founder_only rows and states the exclusion.
   */
  memory: SnapshotSection<MemoryBrowserView[]>;
  /**
   * The truth/evidence projection (Phase 7) — the shared `TruthRecordView`
   * derivation, bounded (`TRUTH_SNAPSHOT_LIMIT`, newest first) with the true
   * totals stated. OPTIONAL by shape, deliberately: a static site build opens
   * no truth store and states nothing rather than an invented zero section,
   * and every pre-Phase-7 fixture stays valid. When present, the
   * Founder-gated `/state` route carries founder_only rows; the
   * unauthenticated artifact withholds them and counts the exclusion.
   */
  truth?: SnapshotSection<TruthSnapshotView>;
  /**
   * The Mission Room collaboration record (Phase 9) — counts HQ made over
   * every session plus the newest `COLLABORATION_SNAPSHOT_LIMIT` session
   * views, each with its DERIVED standing and admitted workers. OPTIONAL by
   * shape for the truth section's reason: a static build opens no store and
   * states nothing rather than an invented zero section. No participant
   * activity is invented; a session with no contribution counts zero.
   */
  collaboration?: SnapshotSection<CollaborationSnapshotView>;
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
  missions: { data: MissionBrowserView[]; provenance: Provenance };
  projects: { data: ProjectBrowserView[]; provenance: Provenance };
  /**
   * Company memory (Phase 5). `data` may already be privacy-filtered by the
   * building context; `memoryTotal` (below) keeps `counts.memory` truthful.
   */
  memory: { data: MemoryBrowserView[]; provenance: Provenance };
  /** The truth/evidence projection (Phase 7). Optional — omitted means no truth store was read. */
  truth?: { data: TruthSnapshotView; provenance: Provenance };
  /** The collaboration record (Phase 9). Optional — omitted means no collaboration store was read. */
  collaboration?: { data: CollaborationSnapshotView; provenance: Provenance };
  /**
   * Per-worker provider declarations (Phase 4). Optional: an omitted map
   * means the building context holds no declaration truth — every worker's
   * `provider` reads null, which is the honest static-build answer, not a
   * claim that no declaration exists.
   */
  workerProviders?: Record<string, { declaredId: string; dispatchable: boolean | null }>;
  /** Per-worker AI member enrichment (Phase 4). Same optional semantics. */
  workerMembers?: Record<
    string,
    { identityKey: string; status: string; health: string; healthCheckedAt: string | null }
  >;
  policyContext?: Parameters<typeof classifyCapability>[1];
  activityLimit?: number;
  /** Opt-in mission bound — see SNAPSHOT_MISSION_LIMIT. Omitted = unbounded. */
  missionLimit?: number;
  /** Opt-in memory bound — see SNAPSHOT_MEMORY_LIMIT. Omitted = unbounded. */
  memoryLimit?: number;
  /**
   * TRUE total of memory records, when `memory.data` was privacy-filtered by
   * the building context. Omitted = data.length (nothing was withheld).
   */
  memoryTotal?: number;
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
      sources.missions.provenance.mode,
      sources.projects.provenance.mode,
      sources.memory.provenance.mode,
      ...(sources.truth ? [sources.truth.provenance.mode] : []),
      ...(sources.collaboration ? [sources.collaboration.provenance.mode] : []),
    ]),
    note: sources.note ?? null,
    counts: {
      approvals: console_.approvals.length,
      pendingReviews: console_.pendingReviews.length,
      outcomeUnknown: console_.outcomeUnknown.length,
      blocked: console_.blocked.length,
      inFlight: console_.inFlight.length,
      queued: console_.queued.length,
      missions: sources.missions.data.length,
      projects: sources.projects.data.length,
      memory: sources.memoryTotal ?? sources.memory.data.length,
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
        provider: sources.workerProviders?.[worker.id] ?? null,
        member: sources.workerMembers?.[worker.id] ?? null,
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
    missions:
      sources.missionLimit != null && sources.missions.data.length > sources.missionLimit
        ? section(
            {
              ...sources.missions.provenance,
              note:
                `Trimmed to the newest ${sources.missionLimit} of ` +
                `${sources.missions.data.length} missions; counts.missions still reports the total.`,
            },
            trimMissions(sources.missions.data, sources.missionLimit),
          )
        : section(sources.missions.provenance, sources.missions.data),
    projects: section(sources.projects.provenance, sources.projects.data),
    memory:
      sources.memoryLimit != null && sources.memory.data.length > sources.memoryLimit
        ? section(
            {
              ...sources.memory.provenance,
              note: [
                sources.memory.provenance.note,
                `Trimmed to the newest ${sources.memoryLimit} of ` +
                  `${sources.memory.data.length} carried records; counts.memory still reports the total.`,
              ]
                .filter(Boolean)
                .join(' '),
            },
            // listMemory() already orders newest-first, so the bound keeps
            // the newest rows without re-sorting.
            sources.memory.data.slice(0, sources.memoryLimit),
          )
        : section(sources.memory.provenance, sources.memory.data),
    ...(sources.truth ? { truth: section(sources.truth.provenance, sources.truth.data) } : {}),
    ...(sources.collaboration
      ? { collaboration: section(sources.collaboration.provenance, sources.collaboration.data) }
      : {}),
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
  /** Opt-in mission bound — see SNAPSHOT_MISSION_LIMIT. Omitted = unbounded. */
  missionLimit?: number;
  /** Opt-in memory bound — see SNAPSHOT_MEMORY_LIMIT. Omitted = unbounded. */
  memoryLimit?: number;
  /**
   * Whether founder_only memory rows ride this snapshot (Phase 5). Default
   * FALSE — fail closed: the unauthenticated artifact (`hq:snapshot`, the
   * static build) never sets it, and only the Founder-gated `/state` route
   * passes true. Excluded rows stay in `counts.memory` and the exclusion is
   * stated in the section provenance.
   */
  includeFounderOnlyMemory?: boolean;
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

  // Phase 4 workforce enrichment, from the same canonical reads the routes
  // use: declarations declared-or-absent (never inferred from vendor),
  // dispatchability three-valued through the same transport seam the console
  // uses, member records only where a registry is genuinely configured.
  const workerProviders: NonNullable<SnapshotSources['workerProviders']> = {};
  for (const declaration of ops.workerProviderDeclarations()) {
    workerProviders[declaration.workerId] = {
      declaredId: declaration.providerId,
      dispatchable: options.dispatchAvailability?.(declaration.providerId as ProviderId) ?? null,
    };
  }
  const workerMembers: NonNullable<SnapshotSources['workerMembers']> = {};
  const roster = ops.listAiMembers();
  if (roster.configured) {
    for (const member of roster.members) {
      workerMembers[member.id] = {
        identityKey: member.identityKey,
        status: member.status,
        health: member.health,
        healthCheckedAt: member.healthCheckedAt,
      };
    }
  }

  // Phase 5 memory section inputs: the reading layer's privacy decision is
  // made HERE, before the pure builder sees the rows, and the true total is
  // carried separately so counts.memory never understates.
  const allMemory = ops.memoryStorePresent() ? ops.listMemory() : [];
  const carriedMemory =
    options.includeFounderOnlyMemory === true
      ? allMemory
      : allMemory.filter((record) => record.privacy !== 'founder_only');
  const withheldMemory = allMemory.length - carriedMemory.length;

  // Phase 7 truth section: the SAME reading-layer privacy decision as memory
  // (founder_only rides only the Founder-gated /state route), bounded to the
  // newest TRUTH_SNAPSHOT_LIMIT with every total stated inside the view.
  const truth = ops.truthStorePresent()
    ? ops.truthSummary({
        includeFounderOnly: options.includeFounderOnlyMemory === true,
        limit: TRUTH_SNAPSHOT_LIMIT,
      })
    : null;

  // Phase 9 collaboration section: the SAME reading-layer privacy decision as
  // memory and truth (Phase 9 correction, Low L5). A session's own material is
  // classified (`internal | founder_only`, the memory/truth vocabulary): a
  // `founder_only` session rides only the Founder-gated /state route, and no
  // session's free-text purpose is published verbatim on the unauthenticated
  // artifact — the vocabulary has no level that classifies text for an
  // unauthenticated reader. Both omissions are counted inside the view.
  const collaboration = ops.collaborationStorePresent()
    ? ops.collaborationSummary({
        includeFounderOnly: options.includeFounderOnlyMemory === true,
        limit: COLLABORATION_SNAPSHOT_LIMIT,
      })
    : null;

  return buildHqSnapshot({
    workerProviders,
    workerMembers,
    generatedAt: at,
    note: options.note,
    policyContext: ops.policyContext,
    activityLimit: options.activityLimit,
    missionLimit: options.missionLimit,
    memoryLimit: options.memoryLimit,
    memoryTotal: allMemory.length,
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
      data: ops.directory.listSpecialists(),
      provenance: provenanceFor('hq_specialists via HeadquarterStore.listSpecialists'),
    },
    capabilities: {
      data: ops.queue.capabilities.list(),
      provenance: provenanceFor('op_capabilities via CapabilityRegistry.list'),
    },
    activity: {
      data: ops.directory.latestStatusPerSubject(),
      provenance: provenanceFor('hq_events via HeadquarterStore.latestStatusPerSubject'),
    },
    missions: ops.missionStorePresent()
      ? {
          data: ops.listMissions().map(missionBrowserView),
          provenance: provenanceFor('hq_missions via HeadquarterOperations.listMissions'),
        }
      : {
          // A read-only handle over a pre-Phase-3 file: the mission tables do
          // not exist, and a read-only path never creates them. Zero missions
          // with THIS provenance is the truth; an unlabeled empty list would
          // read as "the store is empty", which it is not — it is absent.
          data: [],
          provenance: {
            mode,
            source: 'hq_missions via HeadquarterOperations.listMissions',
            asOf: at,
            note:
              'This database predates the Phase 3 mission tables and was opened read-only, so no ' +
              'mission store exists to read. 0 rows states that absence; nothing was migrated.',
          },
        },
    projects: ops.projectStorePresent()
      ? {
          data: ops.listProjects().map(projectBrowserView),
          provenance: provenanceFor('hq_projects via HeadquarterOperations.listProjects'),
        }
      : {
          // The mission absence rule, applied to the Phase 4 register: a
          // read-only pre-Phase-4 file has no project schema to read, and
          // stating that absence is different from claiming an empty register.
          data: [],
          provenance: {
            mode,
            source: 'hq_projects via HeadquarterOperations.listProjects',
            asOf: at,
            note:
              'This database predates the Phase 4 project schema and was opened read-only, so no ' +
              'project register exists to read. 0 rows states that absence; nothing was migrated.',
          },
        },
    memory: ops.memoryStorePresent()
      ? {
          data: carriedMemory,
          provenance: {
            mode,
            source: 'hq_memory via HeadquarterOperations.listMemory',
            asOf: at,
            ...(withheldMemory > 0
              ? {
                  note:
                    `${withheldMemory} founder_only record(s) are counted in counts.memory but not ` +
                    'carried by this artifact; they are readable only through the ' +
                    'Founder-authenticated /state route.',
                }
              : {}),
          },
        }
      : {
          // The mission/project absence rule, applied to Phase 5 memory.
          data: [],
          provenance: {
            mode,
            source: 'hq_memory via HeadquarterOperations.listMemory',
            asOf: at,
            note:
              'This database predates the Phase 5 memory schema and was opened read-only, so no ' +
              'memory store exists to read. 0 rows states that absence; nothing was migrated.',
          },
        },
    truth: truth
      ? {
          data: truth,
          provenance: {
            mode,
            source:
              'hq_truth_records / hq_truth_verifications / hq_truth_acceptances / hq_truth_relations via ' +
              'HeadquarterOperations.truthSummary (derived projection; evidence ids reference op_evidence)',
            asOf: at,
            note: [
              truth.withheldFounderOnly > 0
                ? `${truth.withheldFounderOnly} founder_only record(s) are counted in total but not carried by ` +
                  'this artifact; they are readable only through the Founder-authenticated /state route.'
                : null,
              truth.withheldFounderOnlyRelations > 0
                ? `${truth.withheldFounderOnlyRelations} relation(s) from carried records to founder_only ` +
                  'records are withheld by id; the carried records’ own categorical standing is unchanged.'
                : null,
              truth.total > truth.records.length
                ? `Carries the newest ${truth.records.length} of ${truth.total} records; total states the count.`
                : null,
            ]
              .filter(Boolean)
              .join(' ') || undefined,
          },
        }
      : {
          data: {
            total: 0,
            byState: { claimed: 0, observed: 0, verified: 0, accepted: 0 },
            unresolvedContradictions: 0,
            awaitingAcceptance: 0,
            withheldFounderOnly: 0,
            withheldFounderOnlyRelations: 0,
            records: [],
            contradictions: [],
          },
          provenance: {
            mode,
            source: 'hq_truth_records via HeadquarterOperations.truthSummary',
            asOf: at,
            note:
              'This database predates the Phase 7 truth schema and was opened read-only, so no truth ' +
              'store exists to read. 0 rows states that absence; nothing was migrated.',
          },
        },
    collaboration: collaboration
      ? {
          data: collaboration,
          provenance: {
            mode,
            source:
              'hq_collab_sessions / hq_collab_participants / hq_collab_contributions / hq_collab_relations via ' +
              'HeadquarterOperations.collaborationSummary (derived projection; a session references one hq_missions row)',
            asOf: at,
            note:
              [
                collaboration.sessions > collaboration.recent.length
                  ? `Carries the newest ${collaboration.recent.length} of ${collaboration.sessions} sessions; sessions states the count.`
                  : null,
                collaboration.withheldFounderOnly > 0
                  ? `${collaboration.withheldFounderOnly} founder_only session(s) are counted in sessions but not carried by ` +
                    'this artifact, and no other number here aggregates over them; they are readable only through the ' +
                    'Founder-authenticated /state route.'
                  : null,
                collaboration.withheldPurposes > 0
                  ? `${collaboration.withheldPurposes} carried session(s) state a purpose that this artifact withholds: ` +
                    'session purpose is free operator text and no privacy level classifies it for an unauthenticated reader.'
                  : null,
              ]
                .filter(Boolean)
                .join(' ') || undefined,
          },
        }
      : {
          data: {
            sessions: 0,
            withheldFounderOnly: 0,
            withheldPurposes: 0,
            activeSessions: 0,
            workersAdmitted: 0,
            contributions: 0,
            disagreements: 0,
            handoffRequests: 0,
            recent: [],
          },
          provenance: {
            mode,
            source: 'hq_collab_sessions via HeadquarterOperations.collaborationSummary',
            asOf: at,
            note:
              'This database predates the Phase 9 collaboration schema and was opened read-only, so no ' +
              'collaboration store exists to read. 0 rows states that absence; nothing was migrated.',
          },
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
