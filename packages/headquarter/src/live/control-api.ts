/**
 * The narrow HQ browser-control API (issue #200, Founder decision of
 * 2026-08-28).
 *
 * ## Why it is a handler and not a framework plugin
 *
 * Headquarter imports no other workspace package and depends on no web
 * framework, and that independence is worth keeping: it means the whole
 * authority boundary can be exercised in a unit test with no server, no
 * socket, and no fixture that could accidentally differ from production. So
 * this file is a pure function from a reduced request to a reduced response.
 * The host adapts its own framework to it (`@factoryos/server`'s
 * `routes/headquarter.ts` does exactly that) and supplies the ports.
 *
 * ## What is exposed, and what deliberately is not
 *
 * Matched exactly, deny-by-default on everything else:
 *
 *   GET  /api/hq/control/session                  who am I, and are the controls on
 *   GET  /api/hq/control/approvals                the pending approvals + digests
 *   GET  /api/hq/control/state                    canonical state, room-projected
 *   GET  /api/hq/control/missions                 the canonical missions, full detail
 *   GET  /api/hq/control/projects                 the canonical project register (Phase 4)
 *   GET  /api/hq/control/workforce                registered workers + transport/member truth
 *   POST /api/hq/control/orders                   create a canonical direct order
 *   POST /api/hq/control/approvals/approve        approve the exact rendered action
 *   POST /api/hq/control/approvals/deny           deny, with a reason
 *   POST /api/hq/control/missions                 command a canonical mission (Phase 3)
 *   POST /api/hq/control/missions/transition      move a mission through its lifecycle
 *   POST /api/hq/control/missions/amend           amend mission intent, append-only
 *   POST /api/hq/control/missions/assign-project  bind/clear the mission -> project link
 *   POST /api/hq/control/missions/link-plan-item  link a plan item to a real task (write-once)
 *   POST /api/hq/control/projects                 create a register entry idempotently
 *   POST /api/hq/control/projects/transition      close/reopen, note required
 *   POST /api/hq/control/projects/update          audited register edit
 *   POST /api/hq/control/workforce/route          evaluate eligibility (records evidence)
 *   POST /api/hq/control/workforce/assign         record an ADVISORY assignment intent
 *
 * The mission writes (Phase 3) and the project/workforce writes (Phase 4)
 * widen the browser write surface the 2026-08-28 Founder decision pinned at
 * exactly orders/approve/deny. Each widening is Founder-approved (issues
 * #254 and #262) and recorded in `docs/JENIFY_DECISIONS.md`; every other
 * clause of the original decision — identity derivation, fail-closed map, no
 * generic mutation endpoint — applies to every new route unchanged.
 *
 * STEP-UP, RE-EVALUATED AT PHASE 4 (the obligation the Phase 3 decision
 * recorded): none of the new writes takes step-up, and the exemption is
 * re-affirmed rather than inherited. Phase 4 still adds NO autonomous
 * consumer of mission or project state — nomination is advisory and inert
 * without the directory + policy engine's own verdict, an assignment intent
 * changes no status and burns no approval, and nothing reads a mission to
 * create/claim/dispatch anything. Step-up stays bound to what it protects:
 * execution-granting approvals. This must be re-evaluated AGAIN the moment
 * a consumer can turn mission/project state into execution (Phase >= 6, or
 * any earlier wiring of the mission watchdog).
 *
 * There is **no ask-for-changes route**, and its absence is a decision rather
 * than an omission. The canonical approval model has exactly two outcomes:
 * `approve` binds a single-use approval to an action digest, `deny` blocks the
 * task with an immutable reason. "Ask for changes" is a third state the
 * Operator does not track, and the two ways to fake it are both dishonest —
 * denying while calling it something softer misreports a blocked task, and
 * leaving the task pending while recording a note would show the Founder a
 * decision the queue never saw. The Founder decision authorised this route
 * "only where the existing approval model allows it"; it does not, so the UI
 * says so instead of drawing a button that lies.
 *
 * There is also **no generic mutation surface**: no route takes a table, a
 * column, a capability id to register, a principal to grant, or a SQL
 * fragment. The two writes call `submitDirectOrder` and
 * `HeadquarterOperations.approveTask`/`denyTask`, which is the whole point —
 * the browser gets the same seam the CLI has, not a wider one.
 *
 * ## The order every request goes through
 *
 * 1. route match (unknown → 404, revealing nothing)
 * 2. origin + content-type, on state-changing methods only
 * 3. client-identity scan — a body that names an actor is REFUSED
 * 4. session → account → explicit Founder map → registered active principal
 * 5. step-up, for approvals of irreversible risk classes
 * 6. the canonical call
 * 7. `assertBrowserSafe` over the response, before it leaves
 *
 * Step 7 is not decoration. Every response passes the same fail-closed guard
 * the polled snapshot passes, so a field added here later cannot carry a
 * credential to the browser without the guard throwing — and a throw becomes
 * an opaque 500, never a partial body.
 */

import { founderConsole, type ApprovalCard } from '../application/console.js';
import { hydrateRooms } from '../client/hydrate.js';
import { liveSnapshotFromOperations } from './snapshot.js';
import { capabilityRowFor } from '../application/service.js';
import type { HeadquarterOperations } from '../application/service.js';
import { taskActionDigest } from '../operator/approvals.js';
import type { ProviderId, SecretsEnv } from '../routing/providers.js';
import { dispatchHistory } from '../providers/claude/dispatch.js';
import {
  checkMutationOrigin,
  normalizedTrustedOrigins,
  requestOriginContext,
  resolveFounderPrincipal,
  scanForClientIdentity,
  verifyStepUp,
  FOUNDER_DENIAL_STATUS,
  STEP_UP_RISK_CLASSES,
  type ControlAuditPort,
  type ControlRequest,
  type CredentialVerifierPort,
  type ResolvedFounder,
  type SessionResolverPort,
} from './auth.js';
import { assertBrowserSafe } from './redaction.js';
import {
  directOrderCapabilityState,
  directOrderDispatchBlocked,
  resolveOrderRoute,
  submitDirectOrder,
  DIRECT_ORDER_CAPABILITY,
  DIRECT_ORDER_ROUTES,
  type DirectOrderRoute,
} from './orders.js';
import {
  MISSION_COMMAND_CAPABILITY,
  missionBrowserView,
  missionCommandCapabilityState,
  type MissionRecord,
} from '../application/mission-command.js';
import {
  PROJECT_COMMAND_CAPABILITY,
  projectBrowserView,
  projectCommandCapabilityState,
  type ProjectRecord,
} from '../application/project-command.js';
import {
  WORKFORCE_ASSIGN_CAPABILITY,
  workforceAssignCapabilityState,
} from '../application/workforce-command.js';
import {
  MEMORY_COMMAND_CAPABILITY,
  memoryCommandCapabilityState,
} from '../application/memory-command.js';
import {
  MISSION_ORCHESTRATE_CAPABILITY,
  missionOrchestrateCapabilityState,
} from '../application/orchestrator-command.js';
import {
  TRUTH_BORN_STATES,
  TRUTH_ENTITY_KINDS,
  TRUTH_READ_LIMIT,
  TRUTH_RECORD_CAPABILITY,
  TRUTH_VERIFY_CAPABILITY,
  VERIFICATION_METHODS,
  VERIFICATION_VERDICTS,
  isTruthBornState,
  isTruthEntityKind,
  isVerificationMethod,
  isVerificationVerdict,
  truthRecordCapabilityState,
  truthVerifyCapabilityState,
} from '../application/truth-command.js';
import {
  ACTION_RECONCILE_DECISIONS,
  ACTION_STATES,
  isActionBlastRadius,
  isActionReconcileDecision,
  isActionState,
  type ActionRiskEscalations,
  type ActionState,
} from '../application/action-gateway.js';
import {
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_ROLES,
  collaborationCommandCapabilityState,
  isCollaborationPrivacy,
  isCollaborationRole,
} from '../application/collaboration-command.js';
import {
  FOUNDER_BRIEF_CAPABILITY,
  founderBriefCapabilityState,
} from '../application/chief-of-staff.js';
import { SEARCH_SOURCES, isSearchSource, type SearchSourceId } from '../application/search-command.js';
import {
  PRODUCT_ARTIFACT_KINDS,
  PRODUCT_COMMAND_CAPABILITY,
  productCommandCapabilityState,
  PRODUCT_LIFECYCLE_STATES,
  PRODUCT_RELEASE_GATE_STATEMENT,
  PRODUCT_TYPES,
  isProductArtifactKind,
  isProductLifecycleState,
  isProductType,
  type ProductLifecycleState,
  type ProductRecord,
} from '../application/product-command.js';
import { MEMORY_KINDS, isMemoryKind, isMemoryPrivacy } from '../memory/schema.js';
import { isArchiveStatus } from '../archive/schema.js';
import { PROVIDERS, providerConnectivity } from '../routing/providers.js';

export const CONTROL_API_PREFIX = '/api/hq/control';

/**
 * A denial reason is persisted to `op_tasks`, `hq_approvals` and the evidence
 * log, so it is bounded here rather than left to whatever a caller sends —
 * the same reasoning as `MAX_TITLE_LENGTH` on an order.
 */
export const MAX_DENIAL_REASON_LENGTH = 500;

/**
 * An approval note is stored permanently in `hq_approvals.decision_note` and
 * rendered into the generated console HTML, so it is bounded and scanned on
 * exactly the same terms as a denial reason.
 */
export const MAX_APPROVAL_NOTE_LENGTH = 500;

export const CONTROL_ROUTES = {
  session: `${CONTROL_API_PREFIX}/session`,
  approvals: `${CONTROL_API_PREFIX}/approvals`,
  /**
   * The Stage 4 read route: canonical HQ state, projected into the seventeen
   * approved rooms, for an authenticated Founder session.
   *
   * READ ONLY, and the same projection the polled snapshot uses — see the
   * `state` branch in `route()` for why it is a projection of an existing read
   * model rather than a new source of truth.
   */
  state: `${CONTROL_API_PREFIX}/state`,
  orders: `${CONTROL_API_PREFIX}/orders`,
  approve: `${CONTROL_API_PREFIX}/approvals/approve`,
  deny: `${CONTROL_API_PREFIX}/approvals/deny`,
  /**
   * Phase 3 (issue #254): the canonical Mission surface. GET lists every
   * mission with full browser-safe detail (exact-match routing is preserved —
   * no path parameters, and Phase-3 scale needs no pagination); POST commands
   * one canonical mission idempotently.
   */
  missions: `${CONTROL_API_PREFIX}/missions`,
  missionTransition: `${CONTROL_API_PREFIX}/missions/transition`,
  missionAmend: `${CONTROL_API_PREFIX}/missions/amend`,
  /**
   * Phase 4 (issue #262): the canonical Project register surface. GET lists
   * every register entry with full browser-safe detail (exact-match routing
   * preserved — no path parameters; a Founder-typed register needs no
   * pagination); POST creates one idempotently. The two mission additions
   * bind the existing facade seams — `assignMissionToProject` and the
   * previously route-less `linkMissionPlanItem` — to the browser.
   */
  projects: `${CONTROL_API_PREFIX}/projects`,
  projectTransition: `${CONTROL_API_PREFIX}/projects/transition`,
  projectUpdate: `${CONTROL_API_PREFIX}/projects/update`,
  missionAssignProject: `${CONTROL_API_PREFIX}/missions/assign-project`,
  missionLinkPlanItem: `${CONTROL_API_PREFIX}/missions/link-plan-item`,
  /**
   * Phase 4: the workforce surface. GET reports every registered worker with
   * enforcement/transport/member truth; the two POSTs record evidence — an
   * eligibility evaluation (`routing_evaluated`) and an ADVISORY assignment
   * intent — which is why both sit on the write surface despite executing
   * nothing.
   */
  workforce: `${CONTROL_API_PREFIX}/workforce`,
  workforceRoute: `${CONTROL_API_PREFIX}/workforce/route`,
  workforceAssign: `${CONTROL_API_PREFIX}/workforce/assign`,
  /**
   * Phase 5 (issue #265): the company memory surface. GET lists every memory
   * record with full browser-safe detail INCLUDING founder_only rows — this
   * route sits behind the Founder gate, which is exactly the reading API
   * layer the memory schema says must enforce privacy (the unauthenticated
   * snapshot artifact excludes them instead). POST records one memory entry
   * idempotently (superseding via `supersedes` — the store is insert-only by
   * engine, so there is no edit to offer). The search and context reads are
   * the two parameterized GETs the `query` boundary field exists for.
   */
  memory: `${CONTROL_API_PREFIX}/memory`,
  memorySearch: `${CONTROL_API_PREFIX}/memory/search`,
  memoryContext: `${CONTROL_API_PREFIX}/memory/context`,
  /**
   * Phase 6 (issue #265): ONE orchestration route, mode 'preview' | 'apply'
   * in the body. Preview is a pure read that still rides the POST pipeline
   * (one route, one console flow, and the mode is data the write-shaped
   * pipeline scans like everything else). Apply is the act — the first write
   * that turns mission state into execution-reachable tasks, which is
   * exactly why it (and it alone) takes STEP-UP: the re-evaluation the
   * Phase 3/4 decisions recorded as owed at "Phase >= 6" resolves here.
   */
  missionOrchestrate: `${CONTROL_API_PREFIX}/missions/orchestrate`,
  /**
   * Phase 7: the truth/evidence projection. GET lists every truth record
   * with its DERIVED categorical state, its verifications, acceptances and
   * contradictions — founder_only rows INCLUDED, because this route sits
   * behind the Founder gate (the memory rule). POST records one claimed or
   * observed statement that must reference existing evidence. The entity
   * read is the parameterized GET the `query` field exists for. `verify`
   * records an independent verification; `accept` is the Founder act and
   * is the ONE Phase 7 route that takes STEP-UP — always, not by risk class:
   * an acceptance is the Founder's irreversible signature on truth.
   */
  truth: `${CONTROL_API_PREFIX}/truth`,
  truthEntity: `${CONTROL_API_PREFIX}/truth/entity`,
  truthVerify: `${CONTROL_API_PREFIX}/truth/verify`,
  truthAccept: `${CONTROL_API_PREFIX}/truth/accept`,
  /**
   * Phase 8: the external-action ledger. GET lists every action intent with
   * its DERIVED ledger state (bounded, newest first; `?taskId=`/`?state=`
   * narrow it); the detail read is the parameterized GET (`?id=`). POST
   * PROPOSES one action against a canonical task — a record, executing
   * nothing; authorization and execution are worker acts under a live fenced
   * claim and have NO browser route, because humans never execute.
   * `reconcile` is the Founder act that closes an open/unknown external
   * attempt and takes STEP-UP always: it is a judgement about whether an
   * irreversible external side effect happened.
   */
  actions: `${CONTROL_API_PREFIX}/actions`,
  actionDetail: `${CONTROL_API_PREFIX}/actions/detail`,
  actionReconcile: `${CONTROL_API_PREFIX}/actions/reconcile`,
  /**
   * Phase 9: the Mission Room / multi-AI collaboration record. GET lists
   * every collaboration session with its DERIVED standing (bounded, newest
   * first; `?missionId=` narrows); POST OPENS one session on a canonical
   * mission (a Founder act). `room` is the parameterized Founder read
   * (`?missionId=`) composing everything the Mission Room shows; `context`
   * (`?sessionId=&collaborationRole=&taskId=`) audits the bounded bundle a
   * role would receive; `admit` admits a REGISTERED worker under a role. A
   * contribution is a worker act under its own resolved identity and has NO
   * browser route, exactly as authorize/execute have none — the Founder
   * directs a mission; workers contribute through the facade.
   */
  collaboration: `${CONTROL_API_PREFIX}/collaboration`,
  collaborationRoom: `${CONTROL_API_PREFIX}/collaboration/room`,
  collaborationContext: `${CONTROL_API_PREFIX}/collaboration/context`,
  collaborationAdmit: `${CONTROL_API_PREFIX}/collaboration/admit`,
  /**
   * Phase 10: the Chief of Staff / Company Command Center. GET is the whole
   * derived briefing (the six questions, the recommendations, the department
   * projections and the brief ledger's state); `inbox` is the Founder Inbox
   * alone, for a light poll. Both are pure reads over canonical rows and
   * write nothing.
   *
   * POST `brief` issues ONE receipt row recording that a brief was issued,
   * by whom, over which canonical watermarks, with categorical counts and a
   * content digest. That is the phase's ONLY write. There is deliberately no
   * route — and no facade method — that takes a recommendation id: a
   * recommendation is a record about an act, never a handle on one.
   */
  commandCenter: `${CONTROL_API_PREFIX}/command-center`,
  commandCenterInbox: `${CONTROL_API_PREFIX}/command-center/inbox`,
  commandCenterBrief: `${CONTROL_API_PREFIX}/command-center/brief`,
  /**
   * Phase 11: unified search and Ask Jenify. BOTH ARE GETs, and that is a
   * design statement rather than a convenience — a read that can never appear
   * on the write surface cannot quietly become a writer, and the phase adds no
   * write at all. `search` takes the query criteria (`?text=&source=&project=
   * &tag=&year=&limit=`); `ask` takes one natural-language `?question=` and
   * answers from canonical rows retrieved first, or says it cannot.
   *
   * Neither route takes an identity, a privacy level or a source to trust:
   * whether founder_only material is searched is decided from the RESOLVED
   * Founder, exactly as the memory, truth, collaboration and command-centre
   * reads decide it.
   */
  search: `${CONTROL_API_PREFIX}/search`,
  ask: `${CONTROL_API_PREFIX}/ask`,
  /**
   * Phase 12: the Product Factory. GET lists every registered product with
   * its DERIVED lifecycle and artifact versions (bounded, newest first;
   * `?projectId=`/`?lifecycle=` narrow), plus the closed vocabularies a
   * console needs to draw a form without inventing one. `detail` is the
   * parameterized read (`?productId=`) that adds the type's plan template and
   * the release-readiness observation.
   *
   * Three POSTs, and there is deliberately no fourth: `products` registers a
   * product against a canonical project, `lifecycle` moves the product's own
   * state, and `artifacts` records the NEXT immutable version of an artifact
   * line. There is NO release, publish or deploy route here and there is no
   * facade method behind one — a real release is an external action and has
   * exactly one path, the Phase 8 gateway, with its risk assessment, its
   * bound approval, its Intent Guard and its kill switches.
   *
   * None of the three takes step-up, and that is a decision rather than an
   * omission: step-up guards acts whose consequence cannot be walked back
   * (a truth acceptance, a reconciliation of an irreversible external
   * effect). Every write here appends a row to an append-only ledger that
   * reaches nothing outside HQ, and a lifecycle move is undone by moving
   * back. Demanding a fresh credential for it would imply the act does
   * something it cannot do.
   */
  products: `${CONTROL_API_PREFIX}/products`,
  productDetail: `${CONTROL_API_PREFIX}/products/detail`,
  productLifecycle: `${CONTROL_API_PREFIX}/products/lifecycle`,
  productArtifacts: `${CONTROL_API_PREFIX}/products/artifacts`,
} as const;

/**
 * Every state-changing route, stated once so test obligations can enumerate
 * the write surface instead of inferring it from path shapes — a heuristic
 * that silently probed new POSTs as GETs when it guessed wrong.
 */
export const CONTROL_WRITE_ROUTES: readonly string[] = [
  CONTROL_ROUTES.orders,
  CONTROL_ROUTES.approve,
  CONTROL_ROUTES.deny,
  CONTROL_ROUTES.missions,
  CONTROL_ROUTES.missionTransition,
  CONTROL_ROUTES.missionAmend,
  CONTROL_ROUTES.projects,
  CONTROL_ROUTES.projectTransition,
  CONTROL_ROUTES.projectUpdate,
  CONTROL_ROUTES.missionAssignProject,
  CONTROL_ROUTES.missionLinkPlanItem,
  CONTROL_ROUTES.workforceRoute,
  CONTROL_ROUTES.workforceAssign,
  CONTROL_ROUTES.memory,
  CONTROL_ROUTES.missionOrchestrate,
  CONTROL_ROUTES.truth,
  CONTROL_ROUTES.truthVerify,
  CONTROL_ROUTES.truthAccept,
  CONTROL_ROUTES.actions,
  CONTROL_ROUTES.actionReconcile,
  CONTROL_ROUTES.collaboration,
  CONTROL_ROUTES.collaborationAdmit,
  CONTROL_ROUTES.commandCenterBrief,
  // Phase 12: register a product, move its lifecycle, version an artifact.
  // Three writes, all of them appends to append-only HQ ledgers; no fourth
  // exists, because a release is not a Product Factory act.
  CONTROL_ROUTES.products,
  CONTROL_ROUTES.productLifecycle,
  CONTROL_ROUTES.productArtifacts,
];

export interface ControlResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ControlApiDeps {
  /**
   * The one authority. Identity is resolved from `ops.principals` and nowhere
   * else (issue #200, Codex round 4 P1).
   *
   * This deliberately no longer takes a separate `principals` port. It used to,
   * and that was a second source of truth for the same question: the boundary
   * authenticated a mapped principal id against the supplied registry while
   * `createTask`/`approveTask`/`denyTask` authorized that same string against
   * `ops.principals`. A host that wired two registries — or two databases —
   * would have had an account mapped to an innocuous principal here inherit an
   * unrelated same-id principal's grants there. Detecting the divergence would
   * have been possible; removing the field makes it unrepresentable, which is
   * better.
   */
  ops: HeadquarterOperations;
  sessions: SessionResolverPort;
  /** RAW configured Founder map; parsed per request so a broken map fails closed. */
  founderMap: unknown;
  /** Trusted origins for state-changing requests. Empty ⇒ no mutations at all. */
  allowedOrigins: readonly string[];
  /** Provider facts for route resolution. Names only ever leave here, never values. */
  secretsEnv: SecretsEnv;
  /**
   * Transport-backed dispatchability for a provider — true/false when the host
   * genuinely knows, null when it does not. A host running where the real
   * transport lives supplies it; without one the routing contract answers.
   */
  dispatchAvailability?: (provider: ProviderId) => boolean | null;
  credentials?: CredentialVerifierPort;
  audit?: ControlAuditPort;
  now?: () => Date;
  /**
   * Set false to serve the reads without the writes — the safe posture while a
   * deployment's Founder binding is still being established.
   *
   * It lives here, in the layer that also computes `controls`, rather than in
   * the host adapter, and that placement is the fix for a real defect: with the
   * flag enforced in the adapter only, the session route went on advertising
   * `directOrder`/`approve`/`deny` as available, so a read-only deployment told
   * the UI to draw buttons that could only ever return `mutations_disabled`.
   * One flag, read once, decides both what happens and what is claimed.
   */
  mutationsEnabled?: boolean;
}

function json(status: number, body: Record<string, unknown>): ControlResponse {
  return { status, body };
}

function refusal(status: number, code: string, message: string): ControlResponse {
  return json(status, { ok: false, error: { code, message } });
}

/**
 * Everything the browser is told about a pending approval.
 *
 * Note what is absent: the task PAYLOAD. It carries the Founder's own
 * instruction text, and the digest is what the approval binds to, so the
 * browser needs the digest and not the contents. Publishing the payload here
 * would undo the care `orders.ts` takes to keep instruction text off the wire.
 */
interface ApprovalView {
  taskId: string;
  capabilityId: string;
  riskClass: string;
  title: string | null;
  project: string | null;
  createdBy: string;
  createdAt: string;
  actionDigest: string;
  ask: string;
  /** True when approving this one will demand a fresh credential. */
  stepUpRequired: boolean;
  /** True when the canonical no-self-approval rule already refuses this Founder. */
  selfApproval: boolean;
  /**
   * True when this is a direct order whose bound provider cannot dispatch right
   * now (issue #224). The live approvals view is what the browser console
   * actually renders, so the blocked state has to travel HERE — a field only on
   * the polled snapshot was a promise nothing kept.
   */
  dispatchBlocked: boolean;
}

function approvalView(
  card: ApprovalCard,
  founderId: string,
  dispatchBlocked: boolean,
): ApprovalView {
  return {
    taskId: card.taskId,
    capabilityId: card.capabilityId,
    riskClass: card.classification.riskClass,
    title: card.title,
    project: card.project,
    createdBy: card.createdBy,
    createdAt: card.createdAt,
    actionDigest: card.actionDigest,
    ask: card.ask,
    stepUpRequired: STEP_UP_RISK_CLASSES.includes(card.classification.riskClass),
    selfApproval: card.createdBy === founderId,
    dispatchBlocked,
  };
}

function stringField(body: unknown, key: string): string | undefined {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A list-of-strings body field. `undefined` when absent, `'invalid'` when
 * present but not a string array — the caller refuses rather than coercing.
 */
function stringArrayField(body: unknown, key: string): string[] | undefined | 'invalid' {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return 'invalid';
  return value as string[];
}

/** A list-of-integers body field, same contract as `stringArrayField`. */
function numberArrayField(body: unknown, key: string): number[] | undefined | 'invalid' {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !Number.isInteger(entry))) return 'invalid';
  return value as number[];
}

/** One object-form plan entry (Phase 6): a summary plus an optional Founder work spec. */
interface PlanEntryField {
  summary: string;
  capabilityId?: string;
  payload?: Record<string, unknown>;
}

/**
 * The object-form plan field, same contract as `stringArrayField`: absent =
 * undefined, malformed = 'invalid' (the caller refuses, never coerces).
 * Structural shape only — depth/bounds/reserved-key rules stay at the facade.
 */
function planArrayField(body: unknown, key: string): PlanEntryField[] | undefined | 'invalid' {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return 'invalid';
  const out: PlanEntryField[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid';
    const record = entry as Record<string, unknown>;
    if (typeof record.summary !== 'string') return 'invalid';
    const hasCapability = record.capabilityId !== undefined;
    const hasPayload = record.payload !== undefined;
    if (hasCapability !== hasPayload) return 'invalid';
    if (hasCapability && typeof record.capabilityId !== 'string') return 'invalid';
    if (hasPayload && (record.payload == null || typeof record.payload !== 'object' || Array.isArray(record.payload))) {
      return 'invalid';
    }
    out.push(
      hasCapability
        ? {
            summary: record.summary,
            capabilityId: record.capabilityId as string,
            payload: record.payload as Record<string, unknown>,
          }
        : { summary: record.summary },
    );
  }
  return out;
}

/** The specify-existing-items field (Phase 6), same absent/'invalid' contract. */
function specifyArrayField(
  body: unknown,
  key: string,
): { seq: number; capabilityId: string; payload: Record<string, unknown> }[] | undefined | 'invalid' {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return 'invalid';
  const out: { seq: number; capabilityId: string; payload: Record<string, unknown> }[] = [];
  for (const entry of value) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid';
    const record = entry as Record<string, unknown>;
    if (
      !Number.isInteger(record.seq) ||
      typeof record.capabilityId !== 'string' ||
      record.payload == null ||
      typeof record.payload !== 'object' ||
      Array.isArray(record.payload)
    ) {
      return 'invalid';
    }
    out.push({
      seq: record.seq as number,
      capabilityId: record.capabilityId,
      payload: record.payload as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Everything the browser is told about a mission — the ONE shared projection
 * (`missionBrowserView`), so this route and the snapshot's missions section
 * cannot drift apart. Intent BODIES (the raw Founder order and every
 * amendment's rationale) are server-side audit material, exactly as a direct
 * order's instruction is; the derived `idempotency_key` stays internal.
 * `safe()` re-walks this on the way out like every other response.
 */
function missionView(mission: MissionRecord): Record<string, unknown> {
  return missionBrowserView(mission) as unknown as Record<string, unknown>;
}

/**
 * Handle one HQ control request.
 *
 * Never throws for a client's benefit: an unexpected error becomes an opaque
 * 500 so an internal message can never become an oracle.
 */
export function handleControlRequest(
  request: ControlRequest,
  deps: ControlApiDeps,
): ControlResponse {
  try {
    return route(request, deps);
  } catch {
    return refusal(500, 'internal', 'The request could not be completed.');
  }
}

/**
 * Is this approval card a direct order whose provider cannot dispatch right now?
 *
 * Asked here, per card, because this route is what the live console renders —
 * the polled snapshot carries the same field but nothing in the browser reads
 * it, so a block that lived only there was invisible (issue #224, Codex P1 on
 * `faf4fda`). Evidence outranks inference: an order HQ has already published is
 * not blocked, whatever the environment now looks like.
 *
 * `dispatchAvailability` lets a host that holds the real transport answer for
 * its provider; without one, the routing contract answers, as it did before.
 */
function isDispatchBlocked(deps: ControlApiDeps, taskId: string): boolean {
  const task = deps.ops.queue.get(taskId);
  if (!task) return false;
  return directOrderDispatchBlocked(task, deps.secretsEnv, {
    alreadyDispatched: dispatchHistory(deps.ops, taskId).state === 'dispatched',
    providerDispatchable: deps.dispatchAvailability,
  });
}

function route(request: ControlRequest, deps: ControlApiDeps): ControlResponse {
  const method = request.method.toUpperCase();
  const path = request.path;
  const now = deps.now ?? (() => new Date());

  const known =
    (method === 'GET' &&
      (path === CONTROL_ROUTES.session ||
        path === CONTROL_ROUTES.approvals ||
        path === CONTROL_ROUTES.state ||
        path === CONTROL_ROUTES.missions ||
        path === CONTROL_ROUTES.projects ||
        path === CONTROL_ROUTES.workforce ||
        path === CONTROL_ROUTES.memory ||
        path === CONTROL_ROUTES.memorySearch ||
        path === CONTROL_ROUTES.memoryContext ||
        path === CONTROL_ROUTES.truth ||
        path === CONTROL_ROUTES.truthEntity ||
        path === CONTROL_ROUTES.actions ||
        path === CONTROL_ROUTES.actionDetail ||
        path === CONTROL_ROUTES.collaboration ||
        path === CONTROL_ROUTES.collaborationRoom ||
        path === CONTROL_ROUTES.collaborationContext ||
        path === CONTROL_ROUTES.commandCenter ||
        path === CONTROL_ROUTES.commandCenterInbox ||
        path === CONTROL_ROUTES.search ||
        path === CONTROL_ROUTES.ask ||
        path === CONTROL_ROUTES.products ||
        path === CONTROL_ROUTES.productDetail)) ||
    (method === 'POST' &&
      (path === CONTROL_ROUTES.orders ||
        path === CONTROL_ROUTES.approve ||
        path === CONTROL_ROUTES.deny ||
        path === CONTROL_ROUTES.missions ||
        path === CONTROL_ROUTES.missionTransition ||
        path === CONTROL_ROUTES.missionAmend ||
        path === CONTROL_ROUTES.projects ||
        path === CONTROL_ROUTES.projectTransition ||
        path === CONTROL_ROUTES.projectUpdate ||
        path === CONTROL_ROUTES.missionAssignProject ||
        path === CONTROL_ROUTES.missionLinkPlanItem ||
        path === CONTROL_ROUTES.workforceRoute ||
        path === CONTROL_ROUTES.workforceAssign ||
        path === CONTROL_ROUTES.memory ||
        path === CONTROL_ROUTES.missionOrchestrate ||
        path === CONTROL_ROUTES.truth ||
        path === CONTROL_ROUTES.truthVerify ||
        path === CONTROL_ROUTES.truthAccept ||
        path === CONTROL_ROUTES.actions ||
        path === CONTROL_ROUTES.actionReconcile ||
        path === CONTROL_ROUTES.collaboration ||
        path === CONTROL_ROUTES.collaborationAdmit ||
        path === CONTROL_ROUTES.commandCenterBrief ||
        path === CONTROL_ROUTES.products ||
        path === CONTROL_ROUTES.productLifecycle ||
        path === CONTROL_ROUTES.productArtifacts));
  if (!known) {
    // Deny by default, and say nothing about what does exist.
    return refusal(404, 'not_found', 'No such HQ control route.');
  }

  const mutationsEnabled = deps.mutationsEnabled !== false;
  if (!mutationsEnabled && method !== 'GET') {
    return refusal(
      403,
      'mutations_disabled',
      'HQ browser writes are switched off for this deployment.',
    );
  }

  // Auditing is best-effort BY CONTRACT, and the try/catch is what makes that
  // true rather than merely intended (issue #200, Codex round 4 P2).
  //
  // Every `allowed` audit call happens AFTER its canonical write has
  // committed. A throwing sink — an unreachable logging backend, say — would
  // escape to `handleControlRequest`'s catch-all and become a 500, telling the
  // client its order or approval failed when it had in fact succeeded. That is
  // the same defect class as the round-2 denial partial commit: a response
  // disagreeing with committed state, and a retry then hitting an
  // already-created or no-longer-pending task.
  //
  // Swallowing the error is the lesser cost, and it is not a loss of the
  // record: `op_evidence` is the authoritative, hash-chained log written
  // inside the canonical operation. This port is a supplementary host-side
  // sink, and a supplementary sink must never be able to misreport the
  // outcome of the thing it is describing.
  const audit = (
    outcome: 'allowed' | 'refused',
    detail: string,
    founder?: ResolvedFounder,
  ): void => {
    try {
      deps.audit?.record({
        at: now().toISOString(),
        route: `${method} ${path}`,
        outcome,
        detail,
        ...(founder
          ? {
              accountId: founder.account.accountId,
              realmId: founder.account.realmId,
              principalId: founder.principal.id,
            }
          : {}),
      });
    } catch {
      // Deliberately swallowed. See above.
    }
  };

  const origin = checkMutationOrigin(request, deps.allowedOrigins);
  if (!origin.ok) {
    audit('refused', origin.reason);
    return refusal(403, origin.reason, origin.message);
  }

  // Body AND query (Phase 5): a `?principalId=...` attempt is the same
  // weaker-security-model client as a body naming an actor, and is refused
  // on the same terms rather than silently ignored.
  for (const carrier of [request.body, request.query]) {
    const identity = scanForClientIdentity(carrier);
    if (!identity.ok) {
      audit('refused', 'client_identity_supplied');
      return refusal(
        400,
        'client_identity_supplied',
        `This request tries to supply '${identity.key}'. Who is acting is decided by the ` +
          'server session and the configured Founder map only; a request that names an actor is ' +
          'refused rather than silently re-attributed.',
      );
    }
  }

  const resolution = resolveFounderPrincipal(request, {
    sessions: deps.sessions,
    // The SAME registry HeadquarterOperations authorizes against, never a
    // second one supplied alongside it.
    principals: { get: (id: string) => deps.ops.lookupPrincipal(id) },
    founderMap: deps.founderMap,
  });

  // The session probe is the one route a signed-in non-Founder may call: it
  // exists so the UI can show "you are signed in, the controls are off" and
  // an accurate reason, instead of guessing from a failed mutation. It never
  // reveals which account IS the Founder.
  if (path === CONTROL_ROUTES.session) {
    if (!resolution.ok) {
      const authenticated = resolution.reason !== 'unauthenticated';
      audit('refused', resolution.reason);
      return safe(
        json(resolution.reason === 'unauthenticated' ? 401 : 200, {
          ok: true,
          authenticated,
          founder: false,
          reason: resolution.reason,
          message: resolution.message,
          controls: controlAvailability(deps, null, request),
        }),
      );
    }
    audit('allowed', 'session', resolution.founder);
    const founderControls = controlAvailability(deps, resolution.founder, request);
    return safe(
      json(200, {
        ok: true,
        authenticated: true,
        founder: true,
        principalId: resolution.founder.principal.id,
        displayName: resolution.founder.principal.displayName,
        approvalAuthority: resolution.founder.principal.approvalAuthority,
        // The console renders `message` as its own reason for showing no
        // control, so the one case a Founder could not otherwise explain gets
        // said plainly. Two different situations produce the same `false`, and
        // conflating them would send a Founder to edit a configuration that is
        // already correct, so they are worded apart: the page's origin is not
        // on the trusted list, versus the request carried no evidence of its
        // origin at all (a stripped referrer, leaving only a scheme-blind
        // Host). The untrusted origin itself is deliberately NOT echoed back —
        // a reason must not become a reflection channel for a header the
        // caller controls.
        ...(founderControls.requestOriginAllowed === false
          ? {
              message:
                founderControls.requestOriginSource === 'origin' ||
                founderControls.requestOriginSource === 'referer'
                  ? 'This page was not served from an origin that is trusted for HQ browser ' +
                    'control, so every state-changing request from it would be refused. Add ' +
                    "this deployment's exact origin to the HQ trusted-origin configuration."
                  : 'This request carried no evidence of the origin that made it — no Origin ' +
                    'and no Referer — so the controls stay off rather than being advertised on ' +
                    'a guess. A Host header alone cannot say whether the page was loaded over ' +
                    'http or https, which is exactly what a write is checked against.',
            }
          : {}),
        controls: founderControls,
        // Live route availability for the composer, derived from the same
        // observed evidence that will decide the order — never from the
        // provider catalogue. Founder-only: which providers this host can
        // dispatch to is deployment knowledge an unmapped session has no
        // business reading. Candidate verdicts name missing FACTS, never
        // values, and `safe()` walks this on the way out like everything else.
        // The composer's route verdicts come from the same place the order's
        // own verdict will: a host holding the real transport answers for its
        // provider, so the browser cannot contradict what dispatch will do.
        routes: DIRECT_ORDER_ROUTES.map((route) =>
          resolveOrderRoute(route, deps.secretsEnv, { providerDispatchable: deps.dispatchAvailability }),
        ),
      }),
    );
  }

  if (!resolution.ok) {
    audit('refused', resolution.reason);
    return refusal(
      FOUNDER_DENIAL_STATUS[resolution.reason],
      resolution.reason,
      resolution.message,
    );
  }
  const founder = resolution.founder;

  if (method === 'GET' && path === CONTROL_ROUTES.approvals) {
    const console_ = founderConsole(deps.ops, now());
    audit('allowed', 'list_approvals', founder);
    return safe(
      json(200, {
        ok: true,
        generatedAt: console_.generatedAt,
        approvals: console_.approvals.map((card) =>
          approvalView(card, founder.principal.id, isDispatchBlocked(deps, card.taskId)),
        ),
      }),
    );
  }

  if (method === 'GET' && path === CONTROL_ROUTES.state) {
    // Canonical state, for a Founder session, projected into the seventeen
    // approved rooms (issue #250, Stage 4 §A.2–A.4).
    //
    // ## Why this route exists at all
    //
    // Until Stage 4 the HQ pages carried their data BAKED IN by
    // `build-site.ts`, and the browser asked the server only whether that bake
    // was stale. This is the seam that ends that: same-origin, Founder-gated,
    // read-only, and answered from the live database rather than from a file
    // written at build time.
    //
    // ## Why it is a projection, not a new read model
    //
    // `liveSnapshotFromOperations` is the SAME builder the polled snapshot
    // uses. Reusing it is what keeps the two artefacts from disagreeing, and it
    // means this route inherits the guarantees that were already proven for it:
    // no task payloads, no secrets (`assertBrowserSafe`), and no invented
    // metric (`assertNoFabricatedFields` refuses cost/token/ETA/progress
    // fields on the way out, so a future field of that shape fails here rather
    // than reaching a browser).
    //
    // ## Why the room projection happens HERE and not in the browser
    //
    // So there is exactly one implementation of "what does this room show", in
    // TypeScript, under test. The browser renders text it was handed; it holds
    // no rule it could get wrong. See `client/contracts.ts`.
    //
    // `safe()` walks the finished body a second time regardless, because this
    // response carries session-derived fields the snapshot does not.
    const state = liveSnapshotFromOperations(deps.ops, {
      now: now().toISOString(),
      env: deps.secretsEnv,
      dispatchAvailability: deps.dispatchAvailability,
      // This response exists only past the Founder gate — the reading layer
      // that IS allowed to disclose founder_only memory (Phase 5). The
      // unauthenticated artifact paths never set this.
      includeFounderOnlyMemory: true,
    });
    const rooms = hydrateRooms(state, {
      ok: true,
      authenticated: true,
      founder: true,
      principalId: founder.principal.id,
      displayName: founder.principal.displayName,
      approvalAuthority: founder.principal.approvalAuthority,
      controls: controlAvailability(deps, founder, request),
    });
    audit('allowed', 'read_state', founder);
    return safe(
      json(200, {
        ok: true,
        generatedAt: state.generatedAt,
        mode: state.mode,
        note: state.note,
        counts: state.counts,
        killSwitch: state.operations.data.killSwitch,
        rooms,
      }),
    );
  }

  if (method === 'GET' && path === CONTROL_ROUTES.missions) {
    audit('allowed', 'list_missions', founder);
    return safe(
      json(200, {
        ok: true,
        generatedAt: now().toISOString(),
        missions: deps.ops.listMissions().map(missionView),
      }),
    );
  }

  if (method === 'GET' && path === CONTROL_ROUTES.projects) {
    audit('allowed', 'list_projects', founder);
    return safe(
      json(200, {
        ok: true,
        generatedAt: now().toISOString(),
        projects: deps.ops.listProjects().map(projectView),
      }),
    );
  }

  if (method === 'GET' && path === CONTROL_ROUTES.workforce) {
    return workforceReport(deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.memory) {
    audit('allowed', 'list_memory', founder);
    return safe(
      json(200, {
        ok: true,
        generatedAt: now().toISOString(),
        // founder_only INCLUDED: this response exists only past the Founder
        // gate, which is the privacy-enforcing reading layer.
        records: deps.ops.listMemory() as unknown as Record<string, unknown>[],
        storePresent: deps.ops.memoryStorePresent(),
      }),
    );
  }

  if (method === 'GET' && path === CONTROL_ROUTES.memorySearch) {
    return searchMemoryRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.memoryContext) {
    return memoryContextRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.truth) {
    return listTruthRoute(deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.truthEntity) {
    return entityTruthRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.actions) {
    return listActionsRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.actionDetail) {
    return actionDetailRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.collaboration) {
    return listCollaborationRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.collaborationRoom) {
    return missionRoomRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.collaborationContext) {
    return collaborationContextRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.commandCenter) {
    return commandCenterRoute(deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.commandCenterInbox) {
    return founderInboxRoute(deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.search) {
    return searchCompanyRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.ask) {
    return askJenifyRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.products) {
    return listProductsRoute(request, deps, founder, audit, now);
  }

  if (method === 'GET' && path === CONTROL_ROUTES.productDetail) {
    return productDetailRoute(request, deps, founder, audit, now);
  }

  if (path === CONTROL_ROUTES.orders) return createOrder(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.approve) return approve(request, deps, founder, audit, now);
  if (path === CONTROL_ROUTES.missions) return commandMission(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.missionTransition) {
    return transitionMission(request, deps, founder, audit);
  }
  if (path === CONTROL_ROUTES.missionAmend) return amendMission(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.projects) return createProject(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.projectTransition) {
    return transitionProject(request, deps, founder, audit);
  }
  if (path === CONTROL_ROUTES.projectUpdate) return updateProject(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.missionAssignProject) {
    return assignMissionProject(request, deps, founder, audit);
  }
  if (path === CONTROL_ROUTES.missionLinkPlanItem) {
    return linkPlanItem(request, deps, founder, audit);
  }
  if (path === CONTROL_ROUTES.workforceRoute) return workforceRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.workforceAssign) {
    return workforceAssign(request, deps, founder, audit);
  }
  if (path === CONTROL_ROUTES.memory) return recordMemoryRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.missionOrchestrate) {
    return orchestrateMissionRoute(request, deps, founder, audit, now);
  }
  if (path === CONTROL_ROUTES.truth) return recordTruthRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.truthVerify) return verifyTruthRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.truthAccept) return acceptTruthRoute(request, deps, founder, audit, now);
  if (path === CONTROL_ROUTES.actions) return proposeActionRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.actionReconcile) return reconcileActionRoute(request, deps, founder, audit, now);
  if (path === CONTROL_ROUTES.collaboration) return openCollaborationRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.collaborationAdmit) return admitCollaboratorRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.commandCenterBrief) return issueBriefRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.products) return createProductRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.productLifecycle) return moveProductLifecycleRoute(request, deps, founder, audit);
  if (path === CONTROL_ROUTES.productArtifacts) return registerArtifactRoute(request, deps, founder, audit);
  return deny(request, deps, founder, audit);
}

type Audit = (outcome: 'allowed' | 'refused', detail: string, founder?: ResolvedFounder) => void;

/**
 * What the UI may draw as live.
 *
 * Every control is derived from the thing that will actually decide the
 * request — never from the weaker fact that an account was mapped. Being the
 * Founder is not one authority but several independent ones, and the human
 * principal registry is explicit that they do not imply each other: a mapped,
 * active principal may hold `approvalAuthority: false`, or hold approval
 * authority while lacking the origination grant for `hq.direct_order`. Reading
 * only `founder` advertised buttons that `HeadquarterOperations` would then
 * refuse — the same defect as the `mutationsEnabled` one, one layer further in
 * (issue #200, Codex round 2 P2).
 */
function controlAvailability(
  deps: ControlApiDeps,
  founder: ResolvedFounder | null,
  request: ControlRequest,
): Record<string, unknown> {
  // Every write control is gated on the SAME conditions that refuse the write,
  // so the console can never be told a button works when the route will refuse
  // it. That means the origin allow-list too: with none configured, or only
  // unparseable entries, `checkMutationOrigin` rejects every POST as
  // `origin_allowlist_empty` — and derived from the same function it uses, so
  // the two cannot disagree about what counts as a usable origin.
  const originsUsable = normalizedTrustedOrigins(deps.allowedOrigins).length > 0;
  // A configured allow-list is necessary and NOT sufficient. What decides a
  // POST is whether THIS page's origin is on it, so that is what decides the
  // advertisement too (issue #219 correction round, Codex P2). A console
  // reached at a preview hostname nobody added to the list is told the
  // controls are off, with the reason, instead of drawing buttons whose every
  // POST returns `origin_not_allowed`.
  const requestOrigin = requestOriginContext(request, deps.allowedOrigins);
  const writable =
    founder !== null &&
    deps.mutationsEnabled !== false &&
    originsUsable &&
    requestOrigin.allowed === true;
  const principal = founder?.principal;
  const mayApprove = writable && principal?.approvalAuthority === true;
  const mayOriginate =
    writable && principal?.originateCapabilities.includes(DIRECT_ORDER_CAPABILITY.id) === true;
  const mayCommandMissions =
    writable && principal?.originateCapabilities.includes(MISSION_COMMAND_CAPABILITY.id) === true;
  const mayCommandProjects =
    writable && principal?.originateCapabilities.includes(PROJECT_COMMAND_CAPABILITY.id) === true;
  const mayAssignWorkforce =
    writable && principal?.originateCapabilities.includes(WORKFORCE_ASSIGN_CAPABILITY.id) === true;
  return {
    directOrder: mayOriginate && directOrderCapabilityState(deps.ops) === 'enabled',
    approve: mayApprove,
    deny: mayApprove,
    // Advertised from the same conditions that decide the write: the mapped
    // principal must hold the mission originate grant AND the registry row
    // must match its reserved contract, read enforcement-safe.
    missionCommand:
      mayCommandMissions &&
      missionCommandCapabilityState(capabilityRowFor(deps.ops, MISSION_COMMAND_CAPABILITY.id)) ===
        'enabled',
    // The two Phase 4 controls, derived exactly the same way.
    projectCommand:
      mayCommandProjects &&
      projectCommandCapabilityState(capabilityRowFor(deps.ops, PROJECT_COMMAND_CAPABILITY.id)) ===
        'enabled',
    workforceAssign:
      mayAssignWorkforce &&
      workforceAssignCapabilityState(capabilityRowFor(deps.ops, WORKFORCE_ASSIGN_CAPABILITY.id)) ===
        'enabled',
    // Phase 5: advertised from exactly the conditions that decide the write.
    memoryCommand:
      writable &&
      principal?.originateCapabilities.includes(MEMORY_COMMAND_CAPABILITY.id) === true &&
      memoryCommandCapabilityState(capabilityRowFor(deps.ops, MEMORY_COMMAND_CAPABILITY.id)) ===
        'enabled',
    // Phase 6: preview needs the orchestrate grant alone; apply additionally
    // needs the MISSION grant at the facade — advertised from the union the
    // console draws (the panel appears when orchestration is usable at all,
    // and apply's extra refusals surface verbatim).
    missionOrchestrate:
      writable &&
      principal?.originateCapabilities.includes(MISSION_ORCHESTRATE_CAPABILITY.id) === true &&
      missionOrchestrateCapabilityState(
        capabilityRowFor(deps.ops, MISSION_ORCHESTRATE_CAPABILITY.id),
      ) === 'enabled',
    // Phase 7: the three truth controls, each advertised from exactly the
    // conditions that decide its write. Record/verify need the grant AND an
    // intact registry row (enforcement-safe read); accept is the Founder gate
    // itself — approval authority, the same condition as approve/deny.
    truthRecord:
      writable &&
      principal?.originateCapabilities.includes(TRUTH_RECORD_CAPABILITY.id) === true &&
      truthRecordCapabilityState(capabilityRowFor(deps.ops, TRUTH_RECORD_CAPABILITY.id)) === 'enabled',
    truthVerify:
      writable &&
      principal?.originateCapabilities.includes(TRUTH_VERIFY_CAPABILITY.id) === true &&
      truthVerifyCapabilityState(capabilityRowFor(deps.ops, TRUTH_VERIFY_CAPABILITY.id)) === 'enabled',
    truthAccept: mayApprove,
    // Phase 8: reconciling an external outcome is the Founder gate itself
    // (approval authority, plus step-up at the route). Proposing is NOT
    // advertised as a single flag: its deciding condition is per task (the
    // principal must hold THAT task's capability), and a flag that ignored
    // the task would tell the console a button works when the route refuses.
    actionReconcile: mayApprove,
    // Phase 9: opening a session and admitting a worker are one Founder act
    // (`hq.collaboration_command`), advertised from exactly the conditions
    // that decide the write — the originate grant AND the intact registry
    // row, read enforcement-safe. Contributing has no route, so no flag.
    collaborationCommand:
      writable &&
      principal?.originateCapabilities.includes(COLLABORATION_COMMAND_CAPABILITY.id) === true &&
      collaborationCommandCapabilityState(capabilityRowFor(deps.ops, COLLABORATION_COMMAND_CAPABILITY.id)) ===
        'enabled',
    // Phase 10: issuing a brief receipt is one Founder act
    // (`hq.founder_brief`), advertised from exactly the conditions that
    // decide the write. READING the Command Center takes no capability — the
    // routes sit behind the Founder gate exactly as the Mission Room does —
    // so there is no read flag, and no flag exists for a recommendation
    // because no act takes one.
    founderBrief:
      writable &&
      principal?.originateCapabilities.includes(FOUNDER_BRIEF_CAPABILITY.id) === true &&
      founderBriefCapabilityState(capabilityRowFor(deps.ops, FOUNDER_BRIEF_CAPABILITY.id)) === 'enabled',
    // Phase 12: registering a product, moving its lifecycle and versioning an
    // artifact are ONE Founder act (`hq.product_command`), advertised from
    // exactly the conditions that decide the write — the originate grant AND
    // the intact registry row, read enforcement-safe. Reading the register
    // takes no capability beyond the Founder gate, so there is no read flag;
    // and there is deliberately no release flag, because there is no release
    // act here to grant.
    productCommand:
      writable &&
      principal?.originateCapabilities.includes(PRODUCT_COMMAND_CAPABILITY.id) === true &&
      productCommandCapabilityState(capabilityRowFor(deps.ops, PRODUCT_COMMAND_CAPABILITY.id)) === 'enabled',
    mutationsEnabled: deps.mutationsEnabled !== false,
    trustedOriginConfigured: originsUsable,
    // Stated separately from `trustedOriginConfigured`, because they answer
    // different questions and a deployment can pass the first and fail the
    // second. `requestOriginSource` names how the requesting origin was
    // established — `origin`/`referer` carry a scheme and can answer yes;
    // `host` carries none and `none` is no evidence at all, and both of those
    // answer no rather than guess a scheme the POST gate would decide on.
    requestOriginAllowed: requestOrigin.allowed,
    requestOriginSource: requestOrigin.source,
    // Stated, not hidden: the canonical model has no third decision, so the
    // UI must not draw one. See the module docstring.
    askForChanges: false,
    askForChangesReason:
      'The canonical approval model records approve or deny only. A third outcome would be a ' +
      'state the Operator does not track, so it is not offered.',
  };
}

/** Guard every response body on the way out, exactly like the polled snapshot. */
function safe(response: ControlResponse): ControlResponse {
  try {
    assertBrowserSafe(response.body, 'control');
  } catch {
    return refusal(500, 'internal', 'The response could not be produced safely.');
  }
  return response;
}

function createOrder(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const instruction = stringField(request.body, 'instruction') ?? '';
  const routeName = stringField(request.body, 'route') ?? '';
  const project = stringField(request.body, 'project');
  const title = stringField(request.body, 'title');
  const clientKey = stringField(request.body, 'idempotencyKey');

  if (!DIRECT_ORDER_ROUTES.includes(routeName as DirectOrderRoute)) {
    audit('refused', 'invalid_route', founder);
    return refusal(
      400,
      'invalid_input',
      `Unknown route. Choose one of: ${DIRECT_ORDER_ROUTES.join(', ')}.`,
    );
  }

  const result = submitDirectOrder(
    deps.ops,
    {
      instruction,
      project,
      title,
      route: routeName as DirectOrderRoute,
      // The ONLY place the acting principal comes from. Not the body — the
      // body could not have carried it, the identity scan refuses it.
      requestedBy: founder.principal.id,
      idempotencyKey: clientKey,
    },
    deps.secretsEnv,
    {
      providerDispatchable: deps.dispatchAvailability,
      // Earned, not asserted: a server-resolved JENIFY OS session mapped by
      // explicit configuration to this principal. This is the first interface
      // in Headquarter entitled to say so.
      //
      // Passed HERE, on the options object, rather than on the order input:
      // the input is what a request body deserializes into, and this value must
      // never be reachable from a body. `submitDirectOrder` refuses it from a
      // caller asserting it about itself (issue #219, integrating #200's
      // runtime vocabulary guard with #214's authenticated path).
      resolvedActorAuthentication: 'authenticated_os_session',
    },
  );

  if (!result.ok) {
    audit('refused', result.error.code, founder);
    // An authorization denial must not be reported as a bad request. The
    // registry refuses an ungranted principal through the generic
    // `enqueue_rejected` code — the only way that code can be reached from
    // here, since its other cause (a side-effect capability with no
    // idempotency key) cannot occur on a path that always derives one. So it
    // belongs with the 403s, and a browser is told "not allowed" rather than
    // "malformed", which is what the caller would otherwise try to fix.
    //
    // `capability_definition_altered` belongs there for the same reason
    // (issue #219, Codex P2 on `6e5f054`). The three capability-state
    // refusals answer one question — may this capability be invoked here,
    // as it is currently configured — and the answer is a property of the
    // SERVER's registry row, not of the submitted order. A 400 tells the
    // console the order was malformed and invites the Founder to edit and
    // resend an order that was already valid; the drifted row would refuse
    // every retry. All three now say 403: refused, and nothing you can
    // change in this request will help. Restoring the reserved definition
    // stays the explicit registration action, exactly as before.
    const status =
      result.error.code === 'provider_not_connected'
        ? 409
        : result.error.code === 'capability_not_registered' ||
            result.error.code === 'capability_disabled' ||
            result.error.code === 'capability_definition_altered' ||
            result.error.code === 'unknown_principal' ||
            result.error.code === 'not_permitted' ||
            result.error.code === 'enqueue_rejected' ||
            result.error.code === 'kill_switch_engaged'
          ? 403
          : 400;
    return safe(
      json(status, {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
        // Candidate verdicts name missing FACTS, never their values — the
        // shape `routing/providers.ts` already guarantees.
        route: result.error.details?.candidates ?? null,
      }),
    );
  }

  audit(
    'allowed',
    result.data.dispatchBlocked
      ? result.data.deduplicated
        ? 'order_deduplicated_blocked'
        : 'order_created_blocked'
      : result.data.deduplicated
        ? 'order_deduplicated'
        : 'order_created',
    founder,
  );
  const task = result.data.task;
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      taskId: task.id,
      status: task.status,
      deduplicated: result.data.deduplicated,
      capabilityId: task.capabilityId,
      riskClass: result.data.classification.riskClass,
      requiresFounderApproval: task.status === 'needs_approval',
      // The order exists AND cannot be dispatched right now (issue #224). Both
      // halves are true and the browser must show both: this is a created,
      // gated, remembered order in a BLOCKED / NOT CONNECTED state — never a
      // success it can present as running, and never a failure that suggests
      // nothing was recorded.
      dispatchBlocked: result.data.dispatchBlocked,
      boundProvider: result.data.boundProvider,
      route: {
        requested: result.data.route.requested,
        resolved: result.data.route.resolved,
        reason: result.data.route.reason,
        // Names of the facts that are missing, never their values — the shape
        // `routing/providers.ts` already guarantees.
        missingFacts: result.data.dispatchBlocked
          ? result.data.route.candidates.flatMap((candidate) => candidate.missingFacts)
          : [],
      },
      // Bound at creation so the browser can present the exact action it will
      // later be asked to approve.
      actionDigest: taskActionDigest(task),
    }),
  );
}

/**
 * One status per refusal class, shared by every mission, project and
 * workforce write so the browser is told the same thing for the same cause
 * everywhere:
 * - 400 invalid input — fix the request;
 * - 403 authority/capability — nothing in this request will help;
 * - 404 unknown mission/project/task — same non-oracle shape as an unknown
 *   route (and reachable only AFTER the authority gates, so a caller without
 *   the grant cannot probe which records exist);
 * - 409 state conflict — the record moved, or the act conflicts with a
 *   terminal/closed/current state; re-read and decide again.
 */
function controlErrorStatus(code: string): number {
  switch (code) {
    case 'unknown_mission':
    case 'unknown_project':
    case 'unknown_task':
    case 'unknown_memory':
    case 'unknown_truth':
    case 'unknown_evidence':
    case 'unknown_entity':
    case 'unknown_action':
    case 'unknown_session':
    case 'unknown_contribution':
    case 'unknown_product':
      return 404;
    case 'invalid_mission_transition':
    case 'mission_status_changed':
    case 'mission_terminal':
    case 'mission_intent_conflict':
    case 'invalid_project_transition':
    case 'project_status_changed':
    case 'project_closed':
    case 'assigned_to_other_worker':
    case 'task_already_claimed':
    case 'task_beyond_claiming':
    case 'worker_not_assignable':
    case 'memory_conflict':
      return 409;
    case 'mission_not_orchestratable':
    case 'orchestrate_fingerprint_mismatch':
    case 'truth_conflict':
    case 'truth_not_verified':
    case 'truth_contested':
      return 409;
    // Phase 8: the ledger moved, or the act conflicts with what it records.
    case 'action_state_conflict':
    case 'action_outcome_unknown':
    case 'duplicate_external_action':
    case 'action_approval_stale':
    case 'intent_changed':
    case 'task_not_executing':
    case 'mission_not_active':
    // Phase 9: the session's mission finished, or the act conflicts with
    // what the record holds.
    case 'session_closed':
    // Phase 12: the product moved, or the requested move is not one the
    // lifecycle admits.
    case 'product_lifecycle_conflict':
    case 'invalid_product_lifecycle_move':
      return 409;
    case 'unknown_capability':
    case 'capability_disabled':
    case 'not_permitted':
    case 'unknown_principal':
    case 'workforce_registry_unconfigured':
    // Phase 9: a worker asking for a role it was not admitted under.
    case 'not_a_participant':
    // Risk added an approval requirement the request cannot satisfy by itself.
    case 'approval_required_by_risk':
    // The switch stops execution reachability; a 403 says "nothing in this
    // request will help until it is released" (the order-path mapping).
    case 'kill_switch_engaged':
      return 403;
    default:
      return 400;
  }
}

/** Search results are bounded on the wire; the true hit count is stated. */
const MEMORY_SEARCH_LIMIT = 50;

function searchMemoryRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const text = query.text?.trim();
  const project = query.project?.trim();
  const category = query.category?.trim();
  const status = query.status?.trim();
  const tag = query.tag?.trim();
  const year = query.year?.trim();
  if (!text && !project && !category && !status && !tag && !year) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'Supply at least one of text, project, category, status, tag or year.',
    );
  }
  if (status !== undefined && status !== '' && !isArchiveStatus(status)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'status is not a known archive status.');
  }
  const { hits, total } = deps.ops.searchMemoryRecords({
    text: text || undefined,
    project: project || undefined,
    category: category || undefined,
    status: status ? (status as Parameters<typeof deps.ops.searchMemoryRecords>[0]['status']) : undefined,
    tag: tag || undefined,
    year: year || undefined,
  });
  audit('allowed', 'search_memory', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      hits: hits.slice(0, MEMORY_SEARCH_LIMIT) as unknown as Record<string, unknown>[],
      total,
      truncated: total > MEMORY_SEARCH_LIMIT,
    }),
  );
}

function memoryContextRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const scope = query.scope?.trim();
  const id = query.id?.trim();
  if (!id || (scope !== 'mission' && scope !== 'project' && scope !== 'task')) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', "Supply scope=mission|project|task and id=<entity id>.");
  }
  const result =
    scope === 'mission'
      ? deps.ops.getMissionContext(id)
      : scope === 'project'
        ? deps.ops.getProjectContext(id)
        : deps.ops.getTaskContext(id);
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', `memory_context_${scope}`, founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      context: result.data as unknown as Record<string, unknown>,
    }),
  );
}

function recordMemoryRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const kind = stringField(request.body, 'kind') ?? '';
  if (!isMemoryKind(kind)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `kind must be one of: ${MEMORY_KINDS.join(', ')}.`);
  }
  const privacy = stringField(request.body, 'privacy');
  if (privacy !== undefined && !isMemoryPrivacy(privacy)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'privacy must be internal or founder_only.');
  }
  const tags = stringArrayField(request.body, 'tags');
  const sourceRefs = stringArrayField(request.body, 'sourceRefs');
  const derivedFrom = stringArrayField(request.body, 'derivedFrom');
  if (tags === 'invalid' || sourceRefs === 'invalid' || derivedFrom === 'invalid') {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'tags, sourceRefs and derivedFrom must be lists of text entries.');
  }
  const title = stringField(request.body, 'title') ?? '';
  const body = stringField(request.body, 'body') ?? '';
  const project = stringField(request.body, 'project') ?? '';
  const missionId = stringField(request.body, 'missionId');
  const projectId = stringField(request.body, 'projectId');
  const taskId = stringField(request.body, 'taskId');
  const supersedes = stringField(request.body, 'supersedes');
  const clientKey = stringField(request.body, 'idempotencyKey');

  // The browser boundary's stricter scan, BEFORE anything persists — raw
  // provider-token shapes included (the mission-intake precedent).
  try {
    assertBrowserSafe({ title, body, project, tags, sourceRefs }, 'memory');
  } catch {
    audit('refused', 'unsafe_memory_content', founder);
    return refusal(
      400,
      'unsafe_memory_content',
      'The memory text looks like it contains credential material, so it was refused rather than stored.',
    );
  }

  const result = deps.ops.recordMemory({
    kind,
    title,
    body,
    project,
    missionId,
    projectId,
    taskId,
    tags,
    sourceRefs,
    derivedFrom,
    supersedes,
    privacy,
    // The server-resolved principal, never a body field.
    requestedBy: founder.principal.id,
    idempotencyKey: clientKey,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'memory_deduplicated' : 'memory_recorded', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      record: result.data.record as unknown as Record<string, unknown>,
    }),
  );
}

function orchestrateMissionRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const missionId = stringField(request.body, 'missionId') ?? '';
  const mode = stringField(request.body, 'mode') ?? '';
  const fingerprint = stringField(request.body, 'fingerprint');
  if (!missionId || (mode !== 'preview' && mode !== 'apply')) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', "missionId and mode ('preview' or 'apply') are required.");
  }

  if (mode === 'apply') {
    // STEP-UP — the re-evaluation the Phase 3/4 decisions recorded as owed
    // "the moment a consumer can turn mission/project state into execution
    // (Phase >= 6)" resolves HERE, as a demand: apply is that first consumer,
    // and one apply can originate many tasks from stored state, so it takes
    // the same fresh-credential bar as an execution-granting approval.
    // Decided from the CANONICAL registry row via `capabilityRowFor` (the
    // approve-route rule — never queue.capabilities, never a client-sent
    // class); PREVIEW is a pure read and takes none. A missing/altered row
    // falls through to the facade's fail-closed trio refusal.
    const capability = capabilityRowFor(deps.ops, MISSION_ORCHESTRATE_CAPABILITY.id);
    if (capability && STEP_UP_RISK_CLASSES.includes(capability.riskClass)) {
      const stepUp = verifyStepUp(founder, stringField(request.body, 'stepUpPassword'), {
        credentials: deps.credentials,
        now: now(),
      });
      if (!stepUp.ok) {
        audit('refused', stepUp.reason, founder);
        const status =
          stepUp.reason === 'step_up_rate_limited'
            ? 429
            : stepUp.reason === 'step_up_failed'
              ? 403
              : 401;
        return refusal(status, stepUp.reason, stepUp.message);
      }
    }
  }

  const result = deps.ops.orchestrateMission({
    missionId,
    mode,
    fingerprint,
    // The server-resolved principal, never a body field.
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', mode === 'apply' ? 'mission_orchestrated' : 'orchestration_previewed', founder);
  return safe(json(200, { ok: true, report: result.data as unknown as Record<string, unknown> }));
}

/**
 * Phase 7 reads. Bounded on the wire (`TRUTH_READ_LIMIT`, newest first) with
 * the true total stated; founder_only INCLUDED past the Founder gate, which
 * is the privacy-enforcing reading layer. Unresolved contradictions ride
 * alongside so the browser cannot show a record without its dispute.
 */
function listTruthRoute(deps: ControlApiDeps, founder: ResolvedFounder, audit: Audit, now: () => Date): ControlResponse {
  const records = deps.ops.listTruth();
  const contradictions = deps.ops.listTruthContradictions();
  audit('allowed', 'list_truth', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      records: records.slice(0, TRUTH_READ_LIMIT) as unknown as Record<string, unknown>[],
      total: records.length,
      truncated: records.length > TRUTH_READ_LIMIT,
      unresolvedContradictions: contradictions.filter((c) => c.resolution === 'unresolved') as unknown as Record<
        string,
        unknown
      >[],
      storePresent: deps.ops.truthStorePresent(),
    }),
  );
}

function entityTruthRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const kind = query.kind?.trim();
  const id = query.id?.trim();
  if (!id || !isTruthEntityKind(kind)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `Supply kind=${TRUTH_ENTITY_KINDS.join('|')} and id=<entity id>.`);
  }
  const result = deps.ops.getEntityTruth(kind, id, { limit: TRUTH_READ_LIMIT });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', `truth_entity_${kind}`, founder);
  return safe(json(200, { ok: true, generatedAt: now().toISOString(), truth: result.data as unknown as Record<string, unknown> }));
}

function recordTruthRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const entityKind = stringField(request.body, 'entityKind') ?? '';
  if (!isTruthEntityKind(entityKind)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `entityKind must be one of: ${TRUTH_ENTITY_KINDS.join(', ')}.`);
  }
  const bornState = stringField(request.body, 'bornState');
  if (bornState !== undefined && !isTruthBornState(bornState)) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      `bornState must be one of: ${TRUTH_BORN_STATES.join(', ')} — verified and accepted are derived, never asserted.`,
    );
  }
  const privacy = stringField(request.body, 'privacy');
  if (privacy !== undefined && !isMemoryPrivacy(privacy)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'privacy must be internal or founder_only.');
  }
  const evidenceRefs = stringArrayField(request.body, 'evidenceRefs');
  const supports = stringArrayField(request.body, 'supports');
  const contradicts = stringArrayField(request.body, 'contradicts');
  const derivedFrom = stringArrayField(request.body, 'derivedFrom');
  if (evidenceRefs === 'invalid' || supports === 'invalid' || contradicts === 'invalid' || derivedFrom === 'invalid') {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'evidenceRefs, supports, contradicts and derivedFrom must be lists of ids.');
  }
  const entityId = stringField(request.body, 'entityId') ?? '';
  const statement = stringField(request.body, 'statement') ?? '';
  try {
    assertBrowserSafe({ statement, entityId }, 'truth');
  } catch {
    audit('refused', 'unsafe_truth_content', founder);
    return refusal(
      400,
      'unsafe_truth_content',
      'The statement looks like it contains credential material, so it was refused rather than stored.',
    );
  }
  const result = deps.ops.recordTruth({
    entityKind,
    entityId,
    statement,
    bornState,
    evidenceRefs,
    supports,
    contradicts,
    derivedFrom,
    supersedes: stringField(request.body, 'supersedes'),
    privacy,
    // The server-resolved principal, never a body field.
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'truth_deduplicated' : 'truth_recorded', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      record: result.data.record as unknown as Record<string, unknown>,
    }),
  );
}

function verifyTruthRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const method = stringField(request.body, 'method') ?? '';
  const verdict = stringField(request.body, 'verdict') ?? '';
  if (!isVerificationMethod(method) || !isVerificationVerdict(verdict)) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      `method must be one of: ${VERIFICATION_METHODS.join(', ')}; verdict one of: ${VERIFICATION_VERDICTS.join(', ')}.`,
    );
  }
  const evidenceRefs = stringArrayField(request.body, 'evidenceRefs');
  if (evidenceRefs === 'invalid' || evidenceRefs === undefined) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'evidenceRefs must be a non-empty list of evidence ids.');
  }
  const limitations = stringField(request.body, 'limitations') ?? '';
  try {
    assertBrowserSafe({ limitations }, 'truth');
  } catch {
    audit('refused', 'unsafe_truth_content', founder);
    return refusal(400, 'unsafe_truth_content', 'The limitations text looks like it contains credential material.');
  }
  const result = deps.ops.verifyTruth({
    truthId: stringField(request.body, 'truthId') ?? '',
    method,
    verdict,
    evidenceRefs,
    limitations,
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'truth_verification_deduplicated' : 'truth_verified', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      verification: result.data.verification as unknown as Record<string, unknown>,
      record: result.data.record as unknown as Record<string, unknown>,
    }),
  );
}

function acceptTruthRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const truthId = stringField(request.body, 'truthId') ?? '';
  const expectedDigest = stringField(request.body, 'expectedDigest') ?? '';
  if (!truthId || !expectedDigest) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'truthId and expectedDigest are required.');
  }
  const note = stringField(request.body, 'note');
  if (note !== undefined) {
    try {
      assertBrowserSafe({ note }, 'truth');
    } catch {
      audit('refused', 'unsafe_truth_content', founder);
      return refusal(400, 'unsafe_truth_content', 'The note looks like it contains credential material.');
    }
  }
  // STEP-UP, unconditionally. Acceptance is the Founder's irreversible
  // signature on a truth record (append-only; withdrawn only by a later
  // Founder-gated supersession), so it takes the same fresh-credential bar
  // as an execution-granting approval — decided here, before the facade's
  // own Founder gate, exactly like the approve route.
  const stepUp = verifyStepUp(founder, stringField(request.body, 'stepUpPassword'), {
    credentials: deps.credentials,
    now: now(),
  });
  if (!stepUp.ok) {
    audit('refused', stepUp.reason, founder);
    const status = stepUp.reason === 'step_up_rate_limited' ? 429 : stepUp.reason === 'step_up_failed' ? 403 : 401;
    return refusal(status, stepUp.reason, stepUp.message);
  }
  const result = deps.ops.acceptTruth({
    truthId,
    expectedDigest,
    note,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'truth_acceptance_deduplicated' : 'truth_accepted', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      acceptance: result.data.acceptance as unknown as Record<string, unknown>,
      record: result.data.record as unknown as Record<string, unknown>,
    }),
  );
}

/**
 * Phase 8 reads. Bounded on the wire (`ACTION_READ_LIMIT`, newest first) with
 * the true total stated; `?taskId=` and `?state=` narrow. Every view is the
 * one shared projection — payload BODY absent by shape, digest present.
 */
function listActionsRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const state = query.state?.trim();
  if (state !== undefined && state !== '' && !isActionState(state)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `state must be one of: ${ACTION_STATES.join(', ')}.`);
  }
  const page = deps.ops.listActionsBounded({
    taskId: query.taskId?.trim() || undefined,
    state: state ? (state as ActionState) : undefined,
  });
  audit('allowed', 'list_actions', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      actions: page.actions as unknown as Record<string, unknown>[],
      total: page.total,
      truncated: page.truncated,
      storePresent: deps.ops.actionStorePresent(),
    }),
  );
}

function actionDetailRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const id = request.query?.id?.trim() ?? '';
  if (!id) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'Supply id=<action id>.');
  }
  const action = deps.ops.getAction(id);
  if (!action) {
    audit('refused', 'unknown_action', founder);
    return refusal(404, 'unknown_action', `Unknown action: ${id}`);
  }
  audit('allowed', 'action_detail', founder);
  return safe(json(200, { ok: true, generatedAt: now().toISOString(), action: action as unknown as Record<string, unknown> }));
}

/** Read the optional risk-escalation object off a body; `'invalid'` when malformed. */
function riskField(body: unknown): ActionRiskEscalations | undefined | 'invalid' {
  if (body == null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)['risk'];
  if (value === undefined) return undefined;
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const record = value as Record<string, unknown>;
  const out: ActionRiskEscalations = {};
  for (const key of ['productionScope', 'spend', 'credentialSensitivity', 'legalCompliance'] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== 'boolean') return 'invalid';
    out[key] = record[key] as boolean;
  }
  if (record.blastRadius !== undefined) {
    if (!isActionBlastRadius(record.blastRadius)) return 'invalid';
    out.blastRadius = record.blastRadius;
  }
  return out;
}

function proposeActionRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const evidenceRefs = stringArrayField(request.body, 'contextEvidenceRefs');
  const truthRefs = stringArrayField(request.body, 'contextTruthRefs');
  const risk = riskField(request.body);
  if (evidenceRefs === 'invalid' || truthRefs === 'invalid' || risk === 'invalid') {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'contextEvidenceRefs and contextTruthRefs must be lists of ids; risk must be an object of boolean flags plus an optional blastRadius (single|many|system).',
    );
  }
  const payloadValue = request.body != null && typeof request.body === 'object' ? (request.body as Record<string, unknown>).payload : undefined;
  if (payloadValue == null || typeof payloadValue !== 'object' || Array.isArray(payloadValue)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'payload must be a plain object.');
  }
  const target = stringField(request.body, 'target') ?? '';
  try {
    // The browser boundary's stricter scan BEFORE anything persists — the
    // facade scans again with the same guard, so the two cannot drift.
    assertBrowserSafe({ target, payload: payloadValue }, 'action');
  } catch {
    audit('refused', 'unsafe_action_content', founder);
    return refusal(400, 'unsafe_action_content', 'The action payload or target looks like it contains credential material, so it was refused rather than stored.');
  }
  const result = deps.ops.proposeAction({
    taskId: stringField(request.body, 'taskId') ?? '',
    adapterId: stringField(request.body, 'adapterId') ?? '',
    actionType: stringField(request.body, 'actionType') ?? '',
    target,
    payload: payloadValue as Record<string, unknown>,
    missionId: stringField(request.body, 'missionId'),
    risk,
    contextEvidenceRefs: evidenceRefs,
    contextTruthRefs: truthRefs,
    // The server-resolved principal, never a body field.
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'action_deduplicated' : 'action_proposed', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      action: result.data.action as unknown as Record<string, unknown>,
    }),
  );
}

function reconcileActionRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const actionId = stringField(request.body, 'actionId') ?? '';
  const decision = stringField(request.body, 'decision') ?? '';
  const note = stringField(request.body, 'note') ?? '';
  if (!actionId || !isActionReconcileDecision(decision) || !note.trim()) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      `actionId, a decision (${ACTION_RECONCILE_DECISIONS.join(' | ')}) and a note are required.`,
    );
  }
  try {
    assertBrowserSafe({ note }, 'action');
  } catch {
    audit('refused', 'unsafe_action_content', founder);
    return refusal(400, 'unsafe_action_content', 'The note looks like it contains credential material.');
  }
  // STEP-UP, unconditionally. Reconciling declares whether an irreversible
  // external side effect happened — the same class of judgement as an
  // execution-granting approval, decided here before the facade's own
  // Founder gate, exactly like the approve and accept routes.
  const stepUp = verifyStepUp(founder, stringField(request.body, 'stepUpPassword'), {
    credentials: deps.credentials,
    now: now(),
  });
  if (!stepUp.ok) {
    audit('refused', stepUp.reason, founder);
    const status = stepUp.reason === 'step_up_rate_limited' ? 429 : stepUp.reason === 'step_up_failed' ? 403 : 401;
    return refusal(status, stepUp.reason, stepUp.message);
  }
  const result = deps.ops.reconcileAction({ actionId, decision, note, requestedBy: founder.principal.id });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', 'action_reconciled', founder);
  return safe(json(200, { ok: true, action: result.data.action as unknown as Record<string, unknown> }));
}

/**
 * Phase 9 reads. The session list is bounded (`COLLABORATION_READ_LIMIT`,
 * newest first) with the true total stated; `?missionId=` narrows. Every
 * session view carries its DERIVED standing — no session stores a status.
 */
function listCollaborationRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const page = deps.ops.listCollaborationSessionsBounded({ missionId: request.query?.missionId?.trim() || undefined });
  audit('allowed', 'list_collaboration', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      sessions: page.sessions as unknown as Record<string, unknown>[],
      total: page.total,
      truncated: page.truncated,
      storePresent: deps.ops.collaborationStorePresent(),
    }),
  );
}

/** The Founder's Mission Room for one mission: `?missionId=`. 404 for an unknown mission. */
function missionRoomRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const missionId = request.query?.missionId?.trim() ?? '';
  if (!missionId) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'Supply missionId=<mission id>.');
  }
  const result = deps.ops.getMissionRoom(missionId);
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', 'mission_room', founder);
  return safe(json(200, { ok: true, generatedAt: now().toISOString(), room: result.data as unknown as Record<string, unknown> }));
}

/**
 * The bounded bundle a role would receive: `?sessionId=&collaborationRole=`
 * plus an optional `taskId=`. The query key is `collaborationRole`, NOT
 * `role`: `role` is a client-identity key the boundary refuses on sight, and
 * a collaboration role is admission metadata, not who is acting — the acting
 * principal is the mapped Founder, whose command grant the facade checks.
 */
function collaborationContextRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const sessionId = query.sessionId?.trim() ?? '';
  const role = query.collaborationRole?.trim() ?? '';
  if (!sessionId || !isCollaborationRole(role)) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      `Supply sessionId=<session id> and collaborationRole=<${COLLABORATION_ROLES.join('|')}> (taskId optional).`,
    );
  }
  const result = deps.ops.assembleCollaborationContext({
    sessionId,
    role,
    taskId: query.taskId?.trim() || undefined,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', `collaboration_context_${role}`, founder);
  return safe(json(200, { ok: true, generatedAt: now().toISOString(), bundle: result.data as unknown as Record<string, unknown> }));
}

function openCollaborationRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const title = stringField(request.body, 'title') ?? '';
  const purpose = stringField(request.body, 'purpose');
  // The session's own classification — the SAME body key and vocabulary the
  // memory and truth routes already use, not a second privacy system.
  const privacy = stringField(request.body, 'privacy');
  if (privacy !== undefined && !isCollaborationPrivacy(privacy)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'privacy must be internal or founder_only.');
  }
  try {
    assertBrowserSafe({ title, purpose: purpose ?? null }, 'collaboration');
  } catch {
    audit('refused', 'unsafe_collaboration_content', founder);
    return refusal(400, 'unsafe_collaboration_content', 'The title or purpose looks like it contains credential material, so it was refused rather than stored.');
  }
  const result = deps.ops.openCollaborationSession({
    missionId: stringField(request.body, 'missionId') ?? '',
    title,
    purpose,
    privacy,
    // The server-resolved principal, never a body field.
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'collaboration_session_deduplicated' : 'collaboration_session_opened', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      session: result.data.session as unknown as Record<string, unknown>,
    }),
  );
}

/** Admit a registered worker under a role. Body key `collaborationRole` — `role` is an identity key the scan refuses. */
function admitCollaboratorRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const role = stringField(request.body, 'collaborationRole') ?? '';
  if (!isCollaborationRole(role)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `collaborationRole must be one of: ${COLLABORATION_ROLES.join(', ')}.`);
  }
  const result = deps.ops.admitCollaborator({
    sessionId: stringField(request.body, 'sessionId') ?? '',
    workerId: stringField(request.body, 'workerId') ?? '',
    role,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'collaborator_admission_deduplicated' : 'collaborator_admitted', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      participant: result.data.participant as unknown as Record<string, unknown>,
      session: result.data.session as unknown as Record<string, unknown>,
    }),
  );
}

/**
 * Phase 10 reads. Both sit behind the Founder gate exactly as the Mission
 * Room does, and both carry founder_only-derived material for that reason —
 * the same rule `GET /truth` follows. Neither takes a capability: reading a
 * derivation is not an act.
 *
 * Nothing on these responses is a handle. A recommendation is a record with
 * `executable: false` naming an EXISTING gated act; there is no route, and no
 * facade method, that accepts a recommendation id.
 */
function commandCenterRoute(
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const briefing = deps.ops.founderBriefing({ includeFounderOnly: true });
  audit('allowed', 'command_center', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      briefing: briefing as unknown as Record<string, unknown>,
      briefStorePresent: deps.ops.briefStorePresent(),
    }),
  );
}

/** The Founder Inbox alone — the same derivation, without the other five sections. */
function founderInboxRoute(
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const inbox = deps.ops.founderInbox({ includeFounderOnly: true });
  audit('allowed', 'founder_inbox', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      inbox: inbox as unknown as Record<string, unknown>,
    }),
  );
}

/**
 * Issue one brief receipt. The phase's only write, and it records rather than
 * acts: no notification is sent, nothing is scheduled, and the response is a
 * receipt the Founder can check a later re-derivation against.
 */
function issueBriefRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const result = deps.ops.issueBrief({
    // The server-resolved principal, never a body field.
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'founder_brief_deduplicated' : 'founder_brief_issued', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      brief: result.data.brief as unknown as Record<string, unknown>,
    }),
  );
}

/**
 * Phase 11 — unified search across the canonical sources.
 *
 * A GET, and a pure read: the facade appends no row, no event and no evidence
 * answering it, and there is no Phase 11 table it could append one to.
 *
 * `includeFounderOnly: true` is passed because this response exists ONLY past
 * the Founder gate — the same reading-layer decision `GET /memory`,
 * `GET /truth`, `GET /collaboration` and `GET /command-center` each make.
 * Nothing in the query can change it: the flag is a function of the RESOLVED
 * principal and of nothing the client sent.
 *
 * `?source=` may repeat as a comma-separated list; an unknown source is
 * refused rather than silently ignored, so a client never believes it filtered
 * when it did not.
 */
function searchCompanyRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const rawSources = (query.source ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const source of rawSources) {
    if (!isSearchSource(source)) {
      audit('refused', 'invalid_input', founder);
      return refusal(400, 'invalid_input', `source must be one of: ${SEARCH_SOURCES.join(', ')}.`);
    }
  }
  const limitText = (query.limit ?? '').trim();
  if (limitText !== '' && !/^\d{1,3}$/.test(limitText)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'limit must be a small positive whole number.');
  }
  const text = (query.text ?? '').trim();
  const project = (query.project ?? '').trim();
  const tag = (query.tag ?? '').trim();
  // The browser boundary's stricter scan of EVERY free-text criterion, before
  // anything is matched: a query carrying credential-shaped material is
  // refused here rather than echoed back inside `criteria` and `terms` (the
  // memory-intake precedent).
  //
  // `project` and `tag` are scanned for the same reason `text` is, and the
  // omission was not cosmetic: `normalizeSearchQuery` echoes both VERBATIM
  // into `criteria` (`text` survives only as tokenized terms), so they were
  // the two criteria most able to carry a credential back out. The last-resort
  // `safe()` guard did stop the disclosure, but it turned the designed
  // `400 unsafe_query` into an opaque `500 internal` AFTER the read had
  // already been audited `allowed`. `year` needs no scan: it is pinned to four
  // digits, and `source` to the closed registry, both above.
  try {
    assertBrowserSafe({ text, project, tag }, 'search');
  } catch {
    audit('refused', 'unsafe_query', founder);
    return refusal(
      400,
      'unsafe_query',
      'The search text, project or tag looks like it contains credential material, so the query was ' +
        'refused rather than matched.',
    );
  }
  const result = deps.ops.searchCompany(
    {
      text: text || undefined,
      sources: rawSources.length > 0 ? (rawSources as SearchSourceId[]) : undefined,
      project: project || undefined,
      tag: tag || undefined,
      year: (query.year ?? '').trim() || undefined,
      limit: limitText === '' ? undefined : Number(limitText),
    },
    { includeFounderOnly: true },
  );
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', 'company_search', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      search: result.data as unknown as Record<string, unknown>,
    }),
  );
}

/**
 * Phase 11 — Ask Jenify.
 *
 * A GET, deliberately: a question is a read, and a read route can never drift
 * onto the write surface. The facade retrieves canonical rows FIRST and
 * composes the response from their fields only; when nothing was retrieved the
 * answer states `insufficient_evidence` or `unknown` and says why. No model is
 * called from here and nothing external is contacted.
 *
 * The question is scanned for credential shapes before it is echoed, and the
 * response — like every control response — passes the browser-safety guard.
 */
function askJenifyRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const question = (request.query?.question ?? '').trim();
  if (question === '') {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'Supply a question (?question=...).');
  }
  try {
    assertBrowserSafe({ question }, 'ask');
  } catch {
    audit('refused', 'unsafe_question', founder);
    return refusal(
      400,
      'unsafe_question',
      'The question looks like it contains credential material, so it was refused rather than answered.',
    );
  }
  const result = deps.ops.askJenify({ question, includeFounderOnly: true });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', `ask_jenify_${result.data.state}`, founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      answer: result.data as unknown as Record<string, unknown>,
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Phase 12 — the Product Factory                                      */
/* ------------------------------------------------------------------ */

function productView(product: ProductRecord): Record<string, unknown> {
  return product as unknown as Record<string, unknown>;
}

/**
 * Phase 12 — the product register.
 *
 * Bounded on the wire (`PRODUCT_READ_LIMIT`, newest first) with the true total
 * stated; `?projectId=` and `?lifecycle=` narrow it. The closed vocabularies
 * ride along so a console can draw a form from the SERVER's list rather than
 * from a hardcoded copy that could drift — the same reason the mission console
 * is handed its transition table.
 */
function listProductsRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const query = request.query ?? {};
  const lifecycle = (query.lifecycle ?? '').trim();
  if (lifecycle !== '' && !isProductLifecycleState(lifecycle)) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      `lifecycle must be one of: ${PRODUCT_LIFECYCLE_STATES.join(', ')}.`,
    );
  }
  const page = deps.ops.listProductsBounded({
    projectId: (query.projectId ?? '').trim() || undefined,
    lifecycle: lifecycle === '' ? undefined : (lifecycle as ProductLifecycleState),
  });
  audit('allowed', 'list_products', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      products: page.products.map(productView),
      total: page.total,
      truncated: page.truncated,
      storePresent: deps.ops.productStorePresent(),
      vocabulary: {
        productTypes: [...PRODUCT_TYPES],
        lifecycleStates: [...PRODUCT_LIFECYCLE_STATES],
        artifactKinds: [...PRODUCT_ARTIFACT_KINDS],
      },
      releaseGate: PRODUCT_RELEASE_GATE_STATEMENT,
    }),
  );
}

/**
 * One product, its immutable artifact versions, its history, the plan its
 * type template proposes, and the release-readiness observation.
 *
 * All three are READS. The plan carries no id and nothing accepts one; the
 * readiness answer carries `authorizesRelease: false` whatever its blocker
 * list says, because this route cannot authorize anything and neither can the
 * facade method behind it.
 */
function productDetailRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const productId = (request.query?.productId ?? '').trim();
  if (!productId) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'Supply a productId (?productId=...).');
  }
  const product = deps.ops.getProduct(productId);
  if (!product) {
    audit('refused', 'unknown_product', founder);
    return refusal(404, 'unknown_product', `Unknown product: ${productId}`);
  }
  const plan = deps.ops.productPlanTemplate(productId);
  const readiness = deps.ops.productReleaseReadiness(productId);
  if (!plan.ok || !readiness.ok) {
    const error = plan.ok ? readiness : plan;
    if (error.ok) return refusal(500, 'internal', 'The product detail could not be produced.');
    audit('refused', error.error.code, founder);
    return refusal(controlErrorStatus(error.error.code), error.error.code, error.error.message);
  }
  audit('allowed', 'product_detail', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      product: productView(product),
      plan: plan.data as unknown as Record<string, unknown>,
      readiness: readiness.data as unknown as Record<string, unknown>,
    }),
  );
}

function createProductRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const productType = stringField(request.body, 'productType') ?? '';
  if (!isProductType(productType)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `productType must be one of: ${PRODUCT_TYPES.join(', ')}.`);
  }
  const projectId = stringField(request.body, 'projectId') ?? '';
  const name = stringField(request.body, 'name') ?? '';
  const problem = stringField(request.body, 'problem') ?? '';
  const targetUsers = stringField(request.body, 'targetUsers') ?? '';
  const summary = stringField(request.body, 'summary');
  // The browser boundary's stricter scan BEFORE anything persists — the
  // mission/project precedent.
  try {
    assertBrowserSafe({ name, problem, targetUsers, summary }, 'product');
  } catch {
    audit('refused', 'unsafe_product_content', founder);
    return refusal(
      400,
      'unsafe_product_content',
      'The product text looks like it contains credential material, so it was refused rather than stored.',
    );
  }
  const result = deps.ops.createProduct({
    projectId,
    productType,
    name,
    problem,
    targetUsers,
    summary,
    // The ONLY place the acting principal comes from — never the body.
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', result.data.deduplicated ? 'product_deduplicated' : 'product_registered', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      product: productView(result.data.product),
    }),
  );
}

/**
 * Move a product's own lifecycle. Records a state; publishes nothing.
 *
 * The response says so explicitly (`externalActionTaken: false`) rather than
 * leaving a reader of `released` to assume otherwise — the same honesty the
 * evidence entry behind it carries.
 */
function moveProductLifecycleRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const productId = stringField(request.body, 'productId') ?? '';
  const to = stringField(request.body, 'to') ?? '';
  if (!productId || !to) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'productId and to are required.');
  }
  const note = stringField(request.body, 'note');
  if (note) {
    try {
      assertBrowserSafe({ note }, 'product');
    } catch {
      audit('refused', 'unsafe_product_content', founder);
      return refusal(
        400,
        'unsafe_product_content',
        'The note looks like it contains credential material, so it was refused rather than stored.',
      );
    }
  }
  const result = deps.ops.moveProductLifecycle({
    productId,
    to,
    note,
    expectedState: stringField(request.body, 'expectedState'),
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit('allowed', `product_lifecycle_${result.data.lifecycle}`, founder);
  return safe(
    json(200, {
      ok: true,
      product: productView(result.data),
      externalActionTaken: false,
      releaseGate: PRODUCT_RELEASE_GATE_STATEMENT,
    }),
  );
}

/**
 * Record the NEXT version of one artifact line. There is no update route,
 * because there is no update: the table is INSERT-only by engine and the
 * version number is derived server-side, so a client cannot state one.
 */
function registerArtifactRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const kind = stringField(request.body, 'kind') ?? '';
  if (!isProductArtifactKind(kind)) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', `kind must be one of: ${PRODUCT_ARTIFACT_KINDS.join(', ')}.`);
  }
  const productId = stringField(request.body, 'productId') ?? '';
  const name = stringField(request.body, 'name') ?? '';
  const locator = stringField(request.body, 'locator') ?? '';
  const note = stringField(request.body, 'note');
  try {
    assertBrowserSafe({ name, locator, note }, 'product');
  } catch {
    audit('refused', 'unsafe_product_content', founder);
    return refusal(
      400,
      'unsafe_product_content',
      'The artifact text looks like it contains credential material, so it was refused rather than stored.',
    );
  }
  const result = deps.ops.registerProductArtifact({
    productId,
    kind,
    name,
    locator,
    contentDigest: stringField(request.body, 'contentDigest'),
    note,
    requestedBy: founder.principal.id,
    idempotencyKey: stringField(request.body, 'idempotencyKey'),
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return refusal(controlErrorStatus(result.error.code), result.error.code, result.error.message);
  }
  audit(
    'allowed',
    result.data.deduplicated ? 'product_artifact_deduplicated' : 'product_artifact_registered',
    founder,
  );
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      artifactId: result.data.artifactId,
      version: result.data.version,
      product: productView(result.data.product),
    }),
  );
}

function commandMission(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const constraints = stringArrayField(request.body, 'constraints');
  const acceptanceCriteria = stringArrayField(request.body, 'acceptanceCriteria');
  const planItems = stringArrayField(request.body, 'planItems');
  const dependsOn = stringArrayField(request.body, 'dependsOn');
  const plan = planArrayField(request.body, 'plan');
  if (
    constraints === 'invalid' ||
    acceptanceCriteria === 'invalid' ||
    planItems === 'invalid' ||
    dependsOn === 'invalid' ||
    plan === 'invalid'
  ) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'constraints, acceptanceCriteria, planItems and dependsOn must be lists of text entries; ' +
        'plan entries need a summary and, when specified, BOTH capabilityId and a payload object.',
    );
  }
  const title = stringField(request.body, 'title') ?? '';
  const objective = stringField(request.body, 'objective') ?? '';
  const scope = stringField(request.body, 'scope');
  const project = stringField(request.body, 'project');
  const priority = stringField(request.body, 'priority');
  const instruction = stringField(request.body, 'instruction');
  const sourceOrderTaskId = stringField(request.body, 'sourceOrderTaskId');
  const clientKey = stringField(request.body, 'idempotencyKey');

  // The browser boundary's stricter scan, BEFORE anything persists — raw
  // provider-token shapes included. The instruction is scanned too even
  // though it never returns to a browser: a credential has no business being
  // stored, whatever table it would land in (the direct-order precedent).
  try {
    assertBrowserSafe(
      { title, objective, scope, project, instruction, constraints, acceptanceCriteria, planItems, plan },
      'mission',
    );
  } catch {
    audit('refused', 'unsafe_mission_content', founder);
    return refusal(
      400,
      'unsafe_mission_content',
      'The mission text looks like it contains credential material, so it was refused rather than stored.',
    );
  }

  const result = deps.ops.commandMission({
    title,
    objective,
    scope,
    constraints,
    acceptanceCriteria,
    planItems,
    plan,
    project,
    priority,
    dependsOn,
    sourceOrderTaskId,
    instruction,
    // The ONLY place the acting principal comes from — never the body, which
    // the identity scan already refuses.
    requestedBy: founder.principal.id,
    idempotencyKey: clientKey,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', result.data.deduplicated ? 'mission_deduplicated' : 'mission_commanded', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      mission: missionView(result.data.mission),
    }),
  );
}

function transitionMission(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const missionId = stringField(request.body, 'missionId') ?? '';
  const to = stringField(request.body, 'to') ?? '';
  const note = stringField(request.body, 'note');
  const expectedStatus = stringField(request.body, 'expectedStatus');
  if (!missionId || !to) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'missionId and to are required.');
  }
  if (note) {
    try {
      assertBrowserSafe({ note }, 'mission');
    } catch {
      audit('refused', 'unsafe_mission_content', founder);
      return refusal(
        400,
        'unsafe_mission_content',
        'The note looks like it contains credential material, so it was refused rather than stored.',
      );
    }
  }
  const result = deps.ops.transitionMission({
    missionId,
    to,
    note,
    expectedStatus,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', `mission_transitioned_${result.data.status}`, founder);
  return safe(json(200, { ok: true, mission: missionView(result.data) }));
}

function amendMission(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const constraints = stringArrayField(request.body, 'constraints');
  const acceptanceCriteria = stringArrayField(request.body, 'acceptanceCriteria');
  const addPlanItems = stringArrayField(request.body, 'addPlanItems');
  const supersedePlanItemSeqs = numberArrayField(request.body, 'supersedePlanItemSeqs');
  const addPlan = planArrayField(request.body, 'addPlan');
  const specifyPlanItems = specifyArrayField(request.body, 'specifyPlanItems');
  if (
    constraints === 'invalid' ||
    acceptanceCriteria === 'invalid' ||
    addPlanItems === 'invalid' ||
    supersedePlanItemSeqs === 'invalid' ||
    addPlan === 'invalid' ||
    specifyPlanItems === 'invalid'
  ) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'constraints, acceptanceCriteria and addPlanItems must be lists of text entries; ' +
        'supersedePlanItemSeqs must be a list of integers; addPlan/specifyPlanItems entries need ' +
        'a summary or seq plus BOTH capabilityId and a payload object when specified.',
    );
  }
  const missionId = stringField(request.body, 'missionId') ?? '';
  const amendment = stringField(request.body, 'amendment') ?? '';
  const objective = stringField(request.body, 'objective');
  if (!missionId || !amendment.trim()) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'missionId and a non-empty amendment are required.');
  }
  try {
    assertBrowserSafe(
      { amendment, objective, constraints, acceptanceCriteria, addPlanItems, addPlan, specifyPlanItems },
      'mission',
    );
  } catch {
    audit('refused', 'unsafe_mission_content', founder);
    return refusal(
      400,
      'unsafe_mission_content',
      'The amendment text looks like it contains credential material, so it was refused rather than stored.',
    );
  }
  const result = deps.ops.amendMissionIntent({
    missionId,
    amendment,
    objective,
    constraints,
    acceptanceCriteria,
    addPlanItems,
    addPlan,
    specifyPlanItems,
    supersedePlanItemSeqs,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'mission_amended', founder);
  return safe(json(200, { ok: true, mission: missionView(result.data) }));
}

function projectView(project: ProjectRecord): Record<string, unknown> {
  return projectBrowserView(project) as unknown as Record<string, unknown>;
}

function createProject(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const name = stringField(request.body, 'name') ?? '';
  const purpose = stringField(request.body, 'purpose') ?? '';
  const stream = stringField(request.body, 'stream');
  const clientKey = stringField(request.body, 'idempotencyKey');
  // The browser boundary's stricter scan BEFORE anything persists — the
  // mission-command precedent.
  try {
    assertBrowserSafe({ name, purpose, stream }, 'project');
  } catch {
    audit('refused', 'unsafe_project_content', founder);
    return refusal(
      400,
      'unsafe_project_content',
      'The project text looks like it contains credential material, so it was refused rather than stored.',
    );
  }
  const result = deps.ops.createProject({
    name,
    purpose,
    stream,
    // The ONLY place the acting principal comes from — never the body.
    requestedBy: founder.principal.id,
    idempotencyKey: clientKey,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', result.data.deduplicated ? 'project_deduplicated' : 'project_created', founder);
  return safe(
    json(result.data.deduplicated ? 200 : 201, {
      ok: true,
      deduplicated: result.data.deduplicated,
      project: projectView(result.data.project),
    }),
  );
}

function transitionProject(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const projectId = stringField(request.body, 'projectId') ?? '';
  const to = stringField(request.body, 'to') ?? '';
  const note = stringField(request.body, 'note');
  const expectedStatus = stringField(request.body, 'expectedStatus');
  if (!projectId || !to) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'projectId and to are required.');
  }
  if (note) {
    try {
      assertBrowserSafe({ note }, 'project');
    } catch {
      audit('refused', 'unsafe_project_content', founder);
      return refusal(
        400,
        'unsafe_project_content',
        'The note looks like it contains credential material, so it was refused rather than stored.',
      );
    }
  }
  const result = deps.ops.transitionProject({
    projectId,
    to,
    note,
    expectedStatus,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', `project_transitioned_${result.data.status}`, founder);
  return safe(json(200, { ok: true, project: projectView(result.data) }));
}

function updateProject(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const projectId = stringField(request.body, 'projectId') ?? '';
  const name = stringField(request.body, 'name');
  const purpose = stringField(request.body, 'purpose');
  // `stream` is TRI-STATE and must stay so across the wire: absent =
  // unchanged, null = clear the label, string = set it. `stringField` would
  // silently fold null into "absent" and answer 200 with the old stream kept
  // — a false clear (Opus Low on PR #263). A non-string non-null is refused
  // rather than coerced (the assignMissionProject precedent below).
  const rawStream =
    request.body != null && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>).stream
      : undefined;
  if (rawStream !== undefined && rawStream !== null && typeof rawStream !== 'string') {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'stream must be a string, null, or absent.');
  }
  const stream = rawStream as string | null | undefined;
  if (!projectId) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'projectId is required.');
  }
  try {
    assertBrowserSafe({ name, purpose, stream: stream ?? undefined }, 'project');
  } catch {
    audit('refused', 'unsafe_project_content', founder);
    return refusal(
      400,
      'unsafe_project_content',
      'The project text looks like it contains credential material, so it was refused rather than stored.',
    );
  }
  const result = deps.ops.updateProject({
    projectId,
    name,
    purpose,
    stream,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'project_updated', founder);
  return safe(json(200, { ok: true, project: projectView(result.data) }));
}

function assignMissionProject(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const missionId = stringField(request.body, 'missionId') ?? '';
  if (!missionId) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'missionId is required.');
  }
  // `projectId: null` (or absent) clears the assignment; a non-string,
  // non-null value is refused rather than coerced.
  const rawProjectId =
    request.body != null && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>).projectId
      : undefined;
  if (rawProjectId != null && typeof rawProjectId !== 'string') {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'projectId must be a string or null.');
  }
  const result = deps.ops.assignMissionToProject({
    missionId,
    projectId: (rawProjectId as string | undefined) ?? null,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'mission_project_assigned', founder);
  return safe(json(200, { ok: true, mission: missionView(result.data) }));
}

function linkPlanItem(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const missionId = stringField(request.body, 'missionId') ?? '';
  const taskId = stringField(request.body, 'taskId') ?? '';
  const rawSeq =
    request.body != null && typeof request.body === 'object'
      ? (request.body as Record<string, unknown>).planItemSeq
      : undefined;
  if (!missionId || !taskId || typeof rawSeq !== 'number' || !Number.isInteger(rawSeq)) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'missionId, an integer planItemSeq and a taskId are required.',
    );
  }
  const result = deps.ops.linkMissionPlanItem({
    missionId,
    planItemSeq: rawSeq,
    taskId,
    requestedBy: founder.principal.id,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'mission_plan_item_linked', founder);
  return safe(json(200, { ok: true, mission: missionView(result.data) }));
}

/**
 * GET /workforce — every registered worker with its enforcement, transport
 * and member truth, composed HERE because this is the one layer that holds
 * all three: the facade answers grants/assignability, the routing contract
 * plus the host's transport seam answer dispatchability (three-valued —
 * true/false when genuinely observed, null when this host cannot observe),
 * and the member registry answers identity/health enrichment. Nothing is
 * inferred: an undeclared provider reads null, an unobserved transport reads
 * null, an unconfigured registry says so.
 */
function workforceReport(
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const declared = new Map(
    deps.ops.workerProviderDeclarations().map((d) => [d.workerId, d.providerId] as const),
  );
  const roster = deps.ops.listAiMembers();
  const memberById = new Map(roster.members.map((member) => [member.id, member] as const));
  const workers = deps.ops.directory.listSpecialists().map((worker) => {
    const providerId = declared.get(worker.id) ?? null;
    const transport =
      providerId && (PROVIDERS as readonly string[]).includes(providerId)
        ? (() => {
            const connectivity = providerConnectivity(providerId as ProviderId, deps.secretsEnv);
            // `contractSatisfied` is a CONFIGURATION fact — the routing
            // contract's required secrets/local facts are all present.
            // Nothing was asked of the vendor, so it is deliberately not
            // called "connected" here (Opus Low on PR #263). The truth
            // asymmetry: a NEGATIVE reason (missing requirement) genuinely
            // proves non-executability and passes through verbatim; the
            // positive claim is restated as exactly what was checked. Live
            // observation stays where it belongs — `dispatchable` is
            // three-valued and only ever non-null when genuinely observed.
            return {
              contractSatisfied: connectivity.connected,
              reason: connectivity.connected
                ? 'Routing-contract requirements are satisfied by configuration; nothing was probed.'
                : connectivity.reason,
              missingSecrets: connectivity.missingSecrets,
              missingLocalFacts: connectivity.missingLocalFacts,
              dispatchable: deps.dispatchAvailability?.(providerId as ProviderId) ?? null,
            };
          })()
        : null;
    const member = memberById.get(worker.id);
    return {
      id: worker.id,
      displayName: worker.displayName,
      vendor: worker.vendor,
      role: worker.role,
      active: worker.active,
      allowedCapabilities: [...worker.allowedCapabilities],
      providerDeclared: providerId,
      transport,
      member: member
        ? {
            identityKey: member.identityKey,
            status: member.status,
            health: member.health,
            healthCheckedAt: member.healthCheckedAt,
            workerType: member.workerType,
            locality: member.locality,
            costClass: member.costClass,
          }
        : null,
    };
  });
  // Members with no matching execution worker are listed separately and
  // labeled: registered in the member registry, NOT enrolled for execution
  // (issue #182 — a registry row enrols nobody).
  const specialistIds = new Set(workers.map((worker) => worker.id));
  const membersOnly = roster.members
    .filter((member) => !specialistIds.has(member.id))
    .map((member) => ({
      id: member.id,
      displayName: member.displayName,
      identityKey: member.identityKey,
      status: member.status,
      health: member.health,
      healthCheckedAt: member.healthCheckedAt,
      workerType: member.workerType,
      executionWorker: false,
    }));
  audit('allowed', 'read_workforce', founder);
  return safe(
    json(200, {
      ok: true,
      generatedAt: now().toISOString(),
      workers,
      memberRegistryConfigured: roster.configured,
      membersNotEnrolledForExecution: membersOnly,
    }),
  );
}

function workforceRoute(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const taskId = stringField(request.body, 'taskId') ?? '';
  if (!taskId) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'taskId is required.');
  }
  const result = deps.ops.evaluateTaskEligibility(taskId);
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'workforce_route_evaluated', founder);
  return safe(json(200, { ok: true, report: result.data as unknown as Record<string, unknown> }));
}

function workforceAssign(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const taskId = stringField(request.body, 'taskId') ?? '';
  const workerId = stringField(request.body, 'workerId') ?? '';
  const rationale = stringField(request.body, 'rationale');
  if (!taskId || !workerId) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'taskId and workerId are required.');
  }
  if (rationale) {
    try {
      assertBrowserSafe({ rationale }, 'workforce');
    } catch {
      audit('refused', 'unsafe_rationale_content', founder);
      return refusal(
        400,
        'unsafe_rationale_content',
        'The rationale looks like it contains credential material, so it was refused rather than stored.',
      );
    }
  }
  const result = deps.ops.assignTaskAsFounder({
    taskId,
    workerId,
    founderId: founder.principal.id,
    rationale,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(controlErrorStatus(result.error.code), {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'workforce_assigned', founder);
  return safe(
    json(200, {
      ok: true,
      assignment: result.data as unknown as Record<string, unknown>,
    }),
  );
}

function approve(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
  now: () => Date,
): ControlResponse {
  const taskId = stringField(request.body, 'taskId') ?? '';
  const expectedActionDigest = stringField(request.body, 'expectedActionDigest') ?? '';
  const note = stringField(request.body, 'note');
  if (!taskId || !expectedActionDigest) {
    audit('refused', 'invalid_input', founder);
    return refusal(
      400,
      'invalid_input',
      'An approval needs a taskId and the action digest that was displayed.',
    );
  }
  // The note gets the same treatment as a denial reason, and for a stronger
  // reason: it is not merely persisted, it is PUBLISHED — `renderFounderApprovals`
  // writes `decision_note` into the generated HTML (issue #200, Codex round 3 P1).
  if (note !== undefined) {
    if (note.length > MAX_APPROVAL_NOTE_LENGTH) {
      audit('refused', 'note_too_long', founder);
      return refusal(
        400,
        'note_too_long',
        `An approval note may be at most ${MAX_APPROVAL_NOTE_LENGTH} characters.`,
      );
    }
    try {
      assertBrowserSafe({ note }, 'approval');
    } catch {
      audit('refused', 'unsafe_note', founder);
      return refusal(
        400,
        'unsafe_note',
        'The approval note looks like it contains a credential. Approval notes are stored ' +
          'permanently and rendered in the Founder console, so nothing was approved.',
      );
    }
  }

  // Step-up is decided from the CANONICAL capability of the task named in the
  // request, never from a risk class the client sends. An unknown task is
  // refused here rather than being allowed to skip the check and fail later.
  const task = deps.ops.queue.get(taskId);
  if (!task) {
    audit('refused', 'unknown_task', founder);
    return refusal(404, 'unknown_task', `Unknown task: ${taskId}`);
  }
  // The DATABASE row, never `queue.capabilities` (issue #219, Codex P1 on
  // `2175fa2`). Whether a password is demanded is decided from `riskClass`, so
  // this is enforcement, and it was reading the convenience surface #200
  // documents as patchable: `queue.capabilities.get = () => ({ ...cap,
  // riskClass: 'read_only' })` drops the class out of STEP_UP_RISK_CLASSES,
  // `verifyStepUp` never runs, and a stale Founder session approves a
  // `founder_gate` task with no fresh credential. `approveTask` does not
  // re-demand one — step-up is decided here — so nothing downstream catches it.
  const capability = capabilityRowFor(deps.ops, task.capabilityId);
  if (!capability) {
    audit('refused', 'unknown_capability', founder);
    return refusal(403, 'unknown_capability', `Unknown capability: ${task.capabilityId}`);
  }
  if (STEP_UP_RISK_CLASSES.includes(capability.riskClass)) {
    const stepUp = verifyStepUp(founder, stringField(request.body, 'stepUpPassword'), {
      credentials: deps.credentials,
      now: now(),
    });
    if (!stepUp.ok) {
      audit('refused', stepUp.reason, founder);
      const status =
        stepUp.reason === 'step_up_rate_limited'
          ? 429
          : stepUp.reason === 'step_up_failed'
            ? 403
            : 401;
      return refusal(status, stepUp.reason, stepUp.message);
    }
  }

  const result = deps.ops.approveTask({
    taskId,
    // Again: the server-resolved principal, never a body field.
    founderId: founder.principal.id,
    expectedActionDigest,
    note,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    const status =
      result.error.code === 'action_digest_mismatch'
        ? 409
        : result.error.code === 'unknown_task'
          ? 404
          : 403;
    return safe(
      json(status, { ok: false, error: { code: result.error.code, message: result.error.message } }),
    );
  }
  audit('allowed', 'approved', founder);
  return safe(json(200, { ok: true, taskId, status: result.data.status }));
}

function deny(
  request: ControlRequest,
  deps: ControlApiDeps,
  founder: ResolvedFounder,
  audit: Audit,
): ControlResponse {
  const taskId = stringField(request.body, 'taskId') ?? '';
  const reason = (stringField(request.body, 'reason') ?? '').trim();
  const expectedActionDigest = stringField(request.body, 'expectedActionDigest');
  if (!taskId || !reason) {
    audit('refused', 'invalid_input', founder);
    return refusal(400, 'invalid_input', 'A denial needs a taskId and a reason.');
  }
  if (reason.length > MAX_DENIAL_REASON_LENGTH) {
    audit('refused', 'reason_too_long', founder);
    return refusal(
      400,
      'reason_too_long',
      `A denial reason may be at most ${MAX_DENIAL_REASON_LENGTH} characters.`,
    );
  }
  // Guard the reason before the canonical call, exactly as the order path
  // guards an instruction (issue #200, Codex round 2 P1). `denyTask` now
  // refuses a credential-shaped reason before its first write, so this is not
  // what prevents the partial commit — it is what makes the browser's refusal
  // specific instead of a generic `operator_rejected`, and it applies the
  // stricter of the two guards, which also scans the raw string rather than
  // only the JSON encoding.
  try {
    assertBrowserSafe({ reason }, 'denial');
  } catch {
    audit('refused', 'unsafe_reason', founder);
    return refusal(
      400,
      'unsafe_reason',
      'The denial reason looks like it contains a credential. Denials are recorded in the ' +
        'append-only evidence log, so nothing was written.',
    );
  }
  const result = deps.ops.denyTask({
    taskId,
    founderId: founder.principal.id,
    reason,
    expectedActionDigest,
  });
  if (!result.ok) {
    audit('refused', result.error.code, founder);
    return safe(
      json(result.error.code === 'unknown_task' ? 404 : 403, {
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      }),
    );
  }
  audit('allowed', 'denied', founder);
  return safe(json(200, { ok: true, taskId, status: result.data.status }));
}
