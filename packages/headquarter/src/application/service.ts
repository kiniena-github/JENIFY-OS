/**
 * `HeadquarterOperations` — the typed application/service layer that makes
 * Headquarter operational over the EXISTING Universal Operator (HQ lane F,
 * issue #139, retry of #122).
 *
 * ## What this layer is
 *
 * One facade over the whole task lifecycle — create / classify / route /
 * assign / claim / start / review / complete / reconcile — plus the Founder
 * Approval Center actions and group-room mission intake. A UI binds to this
 * and to `console.ts`; it never reaches into `OperatorQueue` directly.
 *
 * ## What this layer is NOT
 *
 * It does not re-implement, relax, or route around a single canonical
 * Operator guarantee. Approval digest binding, time-box, single-use nonce,
 * claim/worker/fence/nonce binding, atomic fenced claim, idempotency,
 * independent review, `outcome_unknown`, the kill switch and deny-by-default
 * all stay exactly where they are, in `operator/*`. Everything here either
 * delegates to them or adds a STRICTER precondition on top. There is
 * deliberately no method that edits a task's capability or payload, no method
 * that clears a rejection, and no path that writes `op_tasks`/`hq_approvals`
 * columns behind the queue's back.
 *
 * ## The hardenings this lane adds
 *
 * 1. **Allow-lists come from a registry.** `OperatorQueue.enqueue()` takes
 *    `requestedBy.allowedCapabilities` from its caller. Here that argument is
 *    always filled from `WorkerDirectoryPort` (workers) or
 *    `originateCapabilities` (human principals) — a caller cannot hand in its
 *    own permissions.
 * 2. **Approvals are digest-echoed.** `approveTask()` requires the console to
 *    send back the exact action digest it displayed. If the action changed
 *    between render and click, the approval is refused before it is ever
 *    written, so a Founder can never approve something other than what was on
 *    screen.
 * 3. **Assignability is re-checked at claim and at start.** A worker disabled
 *    or replaced mid-flight cannot take new work, and cannot start work it had
 *    already claimed.
 * 4. **Every actor must positively BE someone.** Approve, deny and the kill
 *    switch need a registered, active human principal carrying approval
 *    authority; opening work needs a worker or a human with the capability
 *    granted; review and reconciliation need a known actor. Registered workers
 *    are still refused approval authority outright, and human principals can
 *    never claim or start work. See `principals.ts` — an earlier version of
 *    this file authorized Founder actions by elimination ("not a worker,
 *    therefore human"), which admitted every unknown string; authority is now
 *    positive and deny-by-default on both sides. All of this sits on top of —
 *    never instead of — the queue's own self-approval guards.
 *
 * ## Standing rule for anyone extending this file
 *
 * **Every method that writes a record carrying an actor's name must resolve
 * that actor first** — `resolveRequester()` when a capability grant is needed,
 * `resolveActor()` when mere identity is enough, `assertApprovalAuthority()`
 * for Founder decisions, or the fencing token (`assertFence`) for a worker
 * mid-execution. There is no fifth option, and "this path is harmless" is not
 * one: authorization and attribution are different properties.
 *
 * That distinction is why the Jules review of `ff105a2` found four attributed
 * writes still unresolved (`rejectProposal`, `assignTask`, `postMissionMessage`,
 * `proposeMission`). None could escalate privilege — a proposal and a message
 * are inert, an assignment intent is advisory — but each let an unknown
 * identity choose what it SIGNED, in a hash-chained evidence log that exists
 * precisely so history can be trusted. Group-room attribution is the sharpest
 * case: it is what a human reads before deciding to promote a mission.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { HeadquarterStore } from '../store/headquarter.js';
import { QUEUED_UNREACHABLE_STATUSES, type ActivityStatus } from '../contracts/events.js';
import type { WorkerDescriptor, WorkerRole } from '../contracts/workers.js';
import { approvalRequired, evaluatePolicy, type PolicyContext, type PolicyDecision } from '../operator/policy.js';
import {
  approvalExpiredAt,
  canonicalJson,
  taskActionDigest,
  validateApprovalClaimBinding,
  type ApprovalRejection,
} from '../operator/approvals.js';
import { assertNoSecretLikeContent, type EvidenceEntry } from '../operator/evidence.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import {
  GLOBAL_SCOPE,
  OperatorQueue,
  type OperatorTask,
  type PrivilegedQueueApi,
  type ReconcileDecision,
} from '../operator/queue.js';
import {
  ProviderBindingViolation,
  ProviderDeclarationRejected,
  WorkerProviderDirectory,
  readProviderBinding,
  type WorkerProviderRecord,
} from '../operator/provider-binding.js';
import { assertBrowserSafe } from '../live/redaction.js';
import { PROVIDERS, type ProviderId } from '../routing/providers.js';

/**
 * The only actors an in-process system lane may append evidence under.
 *
 * Closed on purpose. Every name here denotes the SYSTEM recording its own act;
 * none is, or may become, a human principal or a registered worker — that is
 * enforced at the call, not merely intended. See `appendSystemEvidence`.
 */
export const SYSTEM_EVIDENCE_ACTORS = ['system', 'hq-claude-dispatch'] as const;
export type SystemEvidenceActor = (typeof SYSTEM_EVIDENCE_ACTORS)[number];

/**
 * Every event kind a system lane may record through the GENERIC surface.
 * Closed, so a caller holding `HeadquarterOperations` cannot invent one (issue
 * #219, Codex P1 on `9c2a474`).
 *
 * Deliberately excludes every kind that SETS a dispatch outcome. Those moved to
 * `DISPATCH_OUTCOME_EVIDENCE_KINDS` and are unreachable from here — see the
 * dispatch-evidence grant below.
 */
export const SYSTEM_EVIDENCE_KINDS = [
  'claude_github_dispatch_refused',
  'direct_order_dispatch_blocked',
] as const;
export type SystemEvidenceKind = (typeof SYSTEM_EVIDENCE_KINDS)[number];

/**
 * The dispatch facts that DECIDE an outcome, and are therefore writable only
 * through the dispatch-only constructor grant (issue #219, Founder decision of
 * 2026-08-30 approving Option B).
 *
 * What these four have in common is that something downstream READS them and
 * acts on the answer:
 *
 *   - `attempted` opens an attempt, which is what makes the next dispatch
 *     refuse rather than publish;
 *   - `succeeded` closes it with the issue every later deduplicated dispatch is
 *     answered with;
 *   - `failed` closes it as "nothing was published", which RE-ENABLES a
 *     dispatch;
 *   - `correlated` is the ingest lane's idempotency record — `findResultComment`
 *     reads it to decide a report was already attached.
 *
 * The previous round bound `attempted`/`succeeded` to an active execution claim
 * and left `failed`/`correlated` on the generic surface, because reconciliation
 * and ingest legitimately hold no claim. ChatGPT and Codex both reported the
 * consequence on `89fb8ad`: any in-process holder of `HeadquarterOperations`
 * could append a terminal `failed` directly, flipping `dispatchHistory` from
 * `unknown` to `none` without going through `resolveUnknownDispatch` and its
 * reconciliation-authority check. That was reproduced end-to-end before this
 * fix — a forged `failed`, then a genuine re-approval taken on false evidence,
 * then a second public issue.
 *
 * A claim requirement could not close it: the honest reason `failed` was
 * unbound is that its legitimate writers hold no claim. So the rule changed
 * axis — not "what has this caller done" but "was this caller handed the
 * writer". The grant is handed to whoever CONSTRUCTS the service and to nobody
 * else, exactly as `PrivilegedQueueApi` is handed to whoever constructs the
 * queue, so it is not reachable from an `ops` object a worker holds.
 */
export const DISPATCH_OUTCOME_EVIDENCE_KINDS = [
  'claude_github_dispatch_attempted',
  'claude_github_dispatch_succeeded',
  'claude_github_dispatch_failed',
  'claude_github_result_correlated',
] as const;
export type DispatchOutcomeEvidenceKind = (typeof DISPATCH_OUTCOME_EVIDENCE_KINDS)[number];

/**
 * The dispatch-only evidence capability, as an OPAQUE handle.
 *
 * A caller can hold one and hand it back to a dispatch lane. It has no
 * methods, no prototype anyone can reach for, and no properties: everything it
 * authorises happens inside this module, keyed off the object's identity.
 *
 * ## Why it has no methods, and why the class is gone
 *
 * Three rounds of review walked this boundary inward, and each round's fix was
 * defeated one layer below it:
 *
 *   1. Kinds were closed by an ALLOWLIST → a caller could still write `failed`
 *      through the generic surface.
 *   2. Writes moved behind a constructor GRANT typed as an interface → a
 *      TypeScript interface is erased, so a counterfeit `{ appendDispatchOutcome
 *      () {} }` was accepted and silently swallowed the mandatory writes while a
 *      real GitHub issue was published.
 *   3. The grant became a CLASS with an ECMAScript private-field brand → the
 *      brand held, but the class was exported, and an exported class object is
 *      mutable. ChatGPT's blocking review of `26b3068` reported both routes and
 *      both were reproduced end to end:
 *
 *        A. `DispatchEvidenceGrant.assertIssuedBy = () => {}` — a writable
 *           static — then the same counterfeit from round 2:
 *           issue published, canonical history `none`.
 *        B. `DispatchEvidenceGrant.prototype.appendDispatchOutcome = () => {}`
 *           — and the GENUINE grant then swallowed its own writes:
 *           issue published, canonical history `none`.
 *
 * B is the instructive one: the private field protected the brand, and the call
 * never went near it, because the call resolved through a mutable prototype.
 * This repository has already been here — #200 replaced `WorkerProviderDirectory`
 * dispatch with a closure for exactly this reason: "a closure created here has
 * no prototype in its dispatch path and no exported identity to patch."
 *
 * So the capability is no longer a thing with behaviour. It is an inert token:
 *
 *   - frozen, with its prototype severed — no methods to overwrite, no
 *     prototype to poison, not even `Object.prototype` behind it, and no route
 *     from a grant back to the class that made it;
 *   - the writer and the issuer live in `#private` fields of a module-private,
 *     frozen class, so the brand check is a syntactic slot test rather than a
 *     lookup through any patchable object (see `IssuedGrant` below — a
 *     `WeakMap` registry was NOT enough, and the measurement is recorded there);
 *   - the two functions that consult it are exported as FUNCTION BINDINGS, not
 *     properties of an exported object. An ES module binding is immutable from
 *     the importing side: `import { writeDispatchOutcome }` cannot be reassigned
 *     by anyone, which is precisely what a writable static could not promise.
 *
 * And `writeDispatchOutcome` re-checks the brand and the issuer itself rather
 * than trusting that `assertDispatchEvidenceGrant` ran. There is deliberately no
 * single choke point to disable: skipping the verifier does not reach the write.
 */
declare const DISPATCH_GRANT_BRAND: unique symbol;
export interface DispatchEvidenceGrant {
  readonly [DISPATCH_GRANT_BRAND]: true;
}

/** The write a genuine grant authorises. Unreachable outside this module. */
type DispatchOutcomeWrite = (entry: {
  taskId?: string | null;
  actor: SystemEvidenceActor;
  kind: DispatchOutcomeEvidenceKind;
  payload: Record<string, unknown>;
}) => EvidenceEntry;

/**
 * ## Why the brand is a private FIELD and not a `WeakMap` membership
 *
 * A module-private `WeakMap` is unnameable, which is what made it look
 * sufficient — but reading it is a method call on a shared, mutable builtin.
 * `WeakMap.prototype.get` and `.has` are writable, and an attacker does not
 * even need to deep-import this file to reach them. Measured on the previous
 * head, against the real lane and a counting transport:
 *
 *     const realGet = WeakMap.prototype.get;
 *     const token = Object.freeze(Object.create(null));
 *     WeakMap.prototype.has = function (k) { return k === token || realHas.call(this, k); };
 *     WeakMap.prototype.get = function (k) { return k === token ? forged : realGet.call(this, k); };
 *
 *   → counterfeit token ACCEPTED, 1 `createIssue`, both mandatory writes
 *     swallowed, `dispatchHistory` = `none`.
 *
 * Surgical rather than global — every other `WeakMap` in the process, the
 * database driver's included, keeps working — so nothing gives the attack away.
 * That is the same P1 the round before this one, reached through the last
 * mutable object left in the check.
 *
 * A `#private` field has no such lookup. `#issuer in value` is a syntactic slot
 * test the language performs directly: there is no property, prototype, builtin
 * or binding anywhere in its path for an in-process caller to replace. The
 * class carrying it is module-private, frozen, with a frozen prototype, so the
 * class object is not reachable or patchable either — and the token severs its
 * own prototype, so holding a genuine grant does not lead back to the class.
 */
class IssuedGrant {
  readonly #issuer: HeadquarterOperations;
  readonly #write: DispatchOutcomeWrite;

  constructor(issuer: HeadquarterOperations, write: DispatchOutcomeWrite) {
    this.#issuer = issuer;
    this.#write = write;
    // No prototype: `getPrototypeOf(grant).constructor` must not lead back to
    // this class. Private fields are unaffected — a private-field brand check
    // is a slot test, not a prototype lookup — and no lane calls a method on
    // the token, so it needs no prototype at all.
    Object.setPrototypeOf(this, null);
    Object.freeze(this);
  }

  /** The genuine write for this grant, or null. The single source of truth. */
  static resolve(ops: HeadquarterOperations, grant: unknown): DispatchOutcomeWrite | null {
    if (typeof grant !== 'object' || grant === null || !(#issuer in (grant as IssuedGrant))) {
      return null;
    }
    const issued = grant as IssuedGrant;
    return issued.#issuer === ops ? issued.#write : null;
  }

  /** Whether this is a genuine grant at all, whoever issued it. */
  static isGenuine(grant: unknown): boolean {
    return typeof grant === 'object' && grant !== null && #issuer in (grant as IssuedGrant);
  }
}
Object.freeze(IssuedGrant);
Object.freeze(IssuedGrant.prototype);

/** Mint one. Called only by the `HeadquarterOperations` constructor. */
function issueDispatchEvidenceGrant(
  issuer: HeadquarterOperations,
  write: DispatchOutcomeWrite,
): DispatchEvidenceGrant {
  return new IssuedGrant(issuer, write) as unknown as DispatchEvidenceGrant;
}

/** The genuine record for this grant, or null. The single source of truth. */
function resolveGrant(ops: HeadquarterOperations, grant: unknown): DispatchOutcomeWrite | null {
  return IssuedGrant.resolve(ops, grant);
}

/**
 * Throw unless `grant` is a genuine capability issued by exactly `ops`.
 *
 * Called by the provider lanes BEFORE anything irreversible, so a refusal
 * happens before a claim, a start or a repository write. It is a function
 * binding rather than a static method for the reason in the comment above.
 */
export function assertDispatchEvidenceGrant(
  ops: HeadquarterOperations,
  grant: unknown,
): asserts grant is DispatchEvidenceGrant {
  if (!IssuedGrant.isGenuine(grant)) {
    throw new Error(
      'The dispatch evidence capability is not a genuine grant. An object of the right shape is ' +
        'not the capability: a counterfeit could accept the mandatory outcome writes and discard ' +
        'them, letting a real issue be published with no canonical record of it. Nothing was ' +
        'claimed, started or published.',
    );
  }
  if (resolveGrant(ops, grant) === null) {
    throw new Error(
      'The dispatch evidence capability was issued by a different HeadquarterOperations than the ' +
        'one this call was given. A capability is bound to the construction boundary that issued ' +
        'it. Nothing was claimed, started or published.',
    );
  }
}

/**
 * Write one dispatch outcome through a genuine grant.
 *
 * Re-verifies rather than trusting that the assertion above ran: the check and
 * the write are the same indivisible step, so there is no arrangement of
 * patched or skipped calls that publishes an issue without recording it.
 */
export function writeDispatchOutcome(
  ops: HeadquarterOperations,
  grant: DispatchEvidenceGrant,
  entry: {
    taskId?: string | null;
    actor: SystemEvidenceActor;
    kind: DispatchOutcomeEvidenceKind;
    payload: Record<string, unknown>;
  },
): EvidenceEntry {
  const write = resolveGrant(ops, grant);
  if (!write) {
    throw new Error(
      'Refusing to record a dispatch outcome through a capability this HeadquarterOperations did ' +
        'not issue. The write re-checks the grant rather than trusting an earlier assertion.',
    );
  }
  return write(entry);
}

/**
 * The kinds that CLAIM A PUBLICATION HAPPENED, and therefore may only be
 * written by something holding the claim under which it happened.
 *
 * `dispatchHistory` treats these as canonical: an `attempted` entry marks an
 * unresolved attempt that blocks the next dispatch, and a `succeeded` entry
 * reports the issue a task was published as. Restricting the ACTOR was not
 * enough — the actor allowlist said who may speak, not what they may claim —
 * so a caller could append a `succeeded` record naming an issue that was never
 * created, and `dispatchClaudeTask` would then refuse to publish the real one
 * and hand back the forged receipt. Verified by exploit before this fix.
 *
 * The real dispatch lane claims the task and starts the execution BEFORE it
 * writes either kind (#224), so requiring an active claim costs it nothing and
 * denies a caller that has not done the work. The kinds NOT listed here are
 * the ones an operator lane legitimately writes without a claim —
 * reconciliation of an unknown outcome, and result correlation.
 *
 * These strings are duplicated from `providers/claude/dispatch.ts` rather than
 * imported, to keep the application layer from depending on a provider
 * adapter. `test/integration-seams.test.ts` asserts the two agree, so a rename
 * there fails loudly here instead of silently unbinding the rule.
 *
 * KEPT after the Option B grant, not replaced by it. The grant answers "may
 * this caller write an outcome at all"; the claim answers "did the work this
 * record describes actually happen". A holder of the grant that has not claimed
 * still may not report a publication.
 */
export const CLAIM_BOUND_EVIDENCE_KINDS = [
  'claude_github_dispatch_attempted',
  'claude_github_dispatch_succeeded',
] as const;
import { ensureApplicationSchema } from './db.js';
import {
  SpecialistDirectoryAdapter,
  type NominationSourcePort,
  type WorkerAssignability,
  type WorkerDirectoryPort,
} from './ports.js';
import { narrowByRegistry, type MemberDirectorySource } from './registry-directory.js';
import { classifyCapability, type TaskClassification } from './classification.js';
import {
  HumanPrincipalRegistry,
  resolveApprover,
  resolvePrincipal,
  type HumanPrincipalPort,
  type HumanPrincipal,
} from './principals.js';
import {
  detectActionLanguage,
  missionProposalDigest,
  type MissionProposal,
  type MissionProposalStatus,
} from './missions.js';
import {
  MISSION_COMMAND_CAPABILITY,
  MAX_MISSION_INSTRUCTION_LENGTH,
  MAX_MISSION_ITEM_LENGTH,
  MAX_MISSION_LIST_ITEMS,
  MAX_MISSION_NOTE_LENGTH,
  MAX_MISSION_OBJECTIVE_LENGTH,
  MAX_MISSION_PROJECT_LENGTH,
  MAX_MISSION_SCOPE_LENGTH,
  MAX_MISSION_TITLE_LENGTH,
  MISSION_PLAN_NOT_DECIDED_SUMMARY,
  appendMissionEvent,
  appendMissionIntent,
  ensureMissionCommandSchema,
  findMissionIdByIdempotencyKey,
  insertMissionPlanItem,
  listMissionIds,
  missionCommandCapabilityState,
  missionCommandContractDrift,
  missionCommandIdempotencyKey,
  missionBrowserView,
  missionSchemaPresent,
  readMissionIntentEntries,
  readMissionRecord,
  setMissionPlanItemSpec,
  type LinkedTaskLookup,
  type MissionBrowserView,
  type MissionIntentEntry,
  type MissionPlanItem,
  type MissionRecord,
} from './mission-command.js';
import {
  MISSION_ALLOWED_TRANSITIONS,
  MISSION_NOTE_REQUIRED_TARGETS,
  canTransitionMission,
  isMissionPriority,
  isMissionStatus,
  isMissionTerminal,
  type MissionPlanItemState,
  type MissionPriority,
  type MissionStatus,
} from '../contracts/mission.js';
import type { Provenance } from '../live/provenance.js';
import {
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_NOTE_LENGTH,
  MAX_PROJECT_PURPOSE_LENGTH,
  MAX_PROJECT_STREAM_LENGTH,
  PROJECT_COMMAND_CAPABILITY,
  appendProjectEvent,
  encodeStream,
  ensureProjectCommandSchema,
  findProjectIdByIdempotencyKey,
  listProjectIds,
  projectCommandCapabilityState,
  projectCommandContractDrift,
  projectCommandIdempotencyKey,
  projectBrowserView,
  projectCommandSchemaPresent,
  readProjectRecord,
  type ProjectBrowserView,
  type ProjectRecord,
} from './project-command.js';
import {
  PROJECT_ALLOWED_TRANSITIONS,
  canTransitionProject,
  isProjectStatus,
  type ProjectStatus,
} from '../contracts/project.js';
import {
  MAX_ASSIGNMENT_RATIONALE_LENGTH,
  WORKFORCE_ASSIGN_CAPABILITY,
  workforceAssignCapabilityState,
  workforceAssignContractDrift,
} from './workforce-command.js';
import {
  MEMBER_HEALTHS,
  type AiMember,
  type AiMemberRegistry,
  type MemberAssignment,
  type MemberHealth,
  type RegisterMemberInput,
} from '../registry/members.js';
import {
  MAX_MEMORY_BODY_LENGTH,
  MAX_MEMORY_LIST_ITEMS,
  MAX_MEMORY_PROJECT_LABEL_LENGTH,
  MAX_MEMORY_SOURCE_REF_LENGTH,
  MAX_MEMORY_TAG_LENGTH,
  MAX_MEMORY_TITLE_LENGTH,
  MEMORY_COMMAND_CAPABILITY,
  memoryBrowserView,
  memoryCommandCapabilityState,
  memoryCommandContractDrift,
  memoryCommandIdempotencyKey,
  type MemoryBrowserView,
} from './memory-command.js';
import {
  assembleMemoryGroups,
  memoryContextProvenance,
  type EntityContextView,
  type MemoryContextGroup,
} from './context-assembly.js';
import {
  MAX_MISSION_SPEC_CAPABILITY_LENGTH,
  MAX_MISSION_SPEC_PAYLOAD_LENGTH,
  MISSION_ORCHESTRATE_CAPABILITY,
  ensureOrchestratorSchema,
  insertOrchestrationRun,
  insertOrchestrationRunItem,
  missionOrchestrateCapabilityState,
  missionOrchestrateContractDrift,
  orchestrationObservedDigest,
  orchestrationTaskIdempotencyKey,
  planOrchestration,
  type ObservedPlanItem,
  type OrchestrationDecision,
} from './orchestrator-command.js';
import {
  MAX_ACCEPTANCE_NOTE_LENGTH,
  MAX_TRUTH_ENTITY_ID_LENGTH,
  MAX_TRUTH_STATEMENT_LENGTH,
  MAX_VERIFICATION_LIMITATIONS_LENGTH,
  TRUTH_BORN_STATES,
  TRUTH_ENTITY_KINDS,
  TRUTH_RECORD_CAPABILITY,
  TRUTH_SNAPSHOT_LIMIT,
  TRUTH_VERIFY_CAPABILITY,
  VERIFICATION_METHODS,
  VERIFICATION_VERDICTS,
  deriveTruthRecord,
  ensureTruthSchema,
  entityCurrentState,
  establishedTruthTier,
  isTruthBornState,
  isTruthEntityKind,
  isVerificationMethod,
  isVerificationVerdict,
  listContradictions,
  loadTruthGraph,
  truthRecordCapabilityState,
  truthRecordContractDrift,
  truthRecordIdempotencyKey,
  truthSchemaPresent,
  truthVerificationIdempotencyKey,
  truthVerifyCapabilityState,
  truthVerifyContractDrift,
  withholdFounderOnlyRelations,
  type EntityTruthView,
  type SubjectDrift,
  type TruthAcceptanceView,
  type TruthBornState,
  type TruthContradictionPair,
  type TruthEntityKind,
  type TruthGraph,
  type TruthRecordRow,
  type TruthRecordView,
  type TruthSnapshotView,
  type TruthState,
  type TruthVerificationView,
  type VerificationMethod,
  type VerificationVerdict,
} from './truth-command.js';
import {
  ACTION_READ_LIMIT,
  EXTERNAL_ACTION_KILL_SCOPE,
  MAX_ACTION_CONTEXT_REFS,
  MAX_ACTION_NOTE_LENGTH,
  MAX_ACTION_PAYLOAD_CHARS,
  MAX_ACTION_TARGET_LENGTH,
  ACTION_TYPE_PATTERN,
  actionGatewaySchemaPresent,
  actionIdempotencyKey,
  actionPayloadDigest,
  adapterContractProblems,
  adapterKillSwitchScope,
  assessActionRisk,
  authorizationDigest,
  deriveActionView,
  ensureActionGatewaySchema,
  isActionBlastRadius,
  isActionReconcileDecision,
  isActionState,
  loadActionEvents,
  loadActionIntent,
  loadActionIntents,
  providerKillSwitchScope,
  riskRequiresApproval,
  sideEffectGeneration,
  sideEffectHolder,
  sideEffectKey,
  sideEffectKeyBase,
  snapshotDrift,
  stateAdmitsAttempt,
  stateAdmitsReconciliation,
  type ActionIntentRow,
  type ActionReconcileDecision,
  type ActionRiskEscalations,
  type ActionState,
  type ActionView,
  type AdapterOutcome,
  type AuthorizedSnapshot,
  type ExternalActionAdapter,
} from './action-gateway.js';
import {
  COLLABORATION_COMMAND_CAPABILITY,
  COLLABORATION_CONTEXT_LIMIT,
  COLLABORATION_CONTRIBUTE_CAPABILITY,
  COLLABORATION_PRIVACIES,
  COLLABORATION_READ_LIMIT,
  COLLABORATION_ROLES,
  COLLABORATION_SNAPSHOT_LIMIT,
  CONTEXT_SECTIONS_BY_ROLE,
  CONTRIBUTION_KINDS,
  DEFAULT_COLLABORATION_PRIVACY,
  MAX_COLLABORATION_PURPOSE_LENGTH,
  MAX_COLLABORATION_REF_LENGTH,
  MAX_COLLABORATION_TITLE_LENGTH,
  MAX_CONTRIBUTION_CONTENT_LENGTH,
  MAX_HANDOFF_REASON_LENGTH,
  MISSION_ROOM_CONTRIBUTION_LIMIT,
  MISSION_ROOM_RUN_LIMIT,
  collaborationCommandCapabilityState,
  collaborationCommandContractDrift,
  collaborationContributeCapabilityState,
  collaborationContributeContractDrift,
  collaborationSchemaPresent,
  collaborationSessionIdempotencyKey,
  contributionIdempotencyKey,
  deriveContributionView,
  deriveDisagreements,
  deriveHandoffRequests,
  deriveSessionView,
  ensureCollaborationSchema,
  isCollaborationPrivacy,
  isCollaborationRole,
  isContributionKind,
  loadCollaborationSession,
  loadCollaborationSessions,
  loadContribution,
  loadContributions,
  loadParticipants,
  loadSessionRelations,
  participantView,
  sessionStandingFor,
  snapshotSessionView,
  type BindingSource,
  type CollaborationPrivacy,
  type CollaborationRole,
  type CollaborationSessionRow,
  type CollaborationSessionView,
  type CollaborationSnapshotView,
  type ContextSection,
  type ContributionDerivationContext,
  type ContributionKind,
  type ContributionView,
  type DisagreementView,
  type HandoffCanonicalTaskState,
  type HandoffRequestView,
  type ParticipantView,
} from './collaboration-command.js';
import { listOrchestrationRuns, orchestratorSchemaPresent } from './orchestrator-command.js';
import {
  BRIEFING_SECTION_LIMIT,
  BRIEF_READ_LIMIT,
  CHANGED_EVENT_LIMIT,
  COMMAND_CENTER_SNAPSHOT_LIMIT,
  FOUNDER_BRIEF_CAPABILITY,
  INBOX_READ_LIMIT,
  REFUSAL_EVIDENCE_KINDS,
  assembleBriefing,
  assembleCommandCenterSnapshot,
  assembleFounderInbox,
  briefCountsOf,
  briefIdempotencyKey,
  briefSchemaPresent,
  briefView,
  contentDigest,
  deriveChanged,
  deriveFounderInbox,
  ensureBriefSchema,
  founderBriefCapabilityState,
  founderBriefContractDrift,
  loadBrief,
  loadBriefs,
  loadLatestBrief,
  type BriefRow,
  type BriefView,
  type ChangedEventRef,
  type ChangedView,
  type CommandCenterSnapshotView,
  type CommandFacts,
  type CanonicalWatermark,
  type FounderBriefingView,
  type FounderInboxView,
  type InboxAttentionItem,
  type MissionFact,
  type TruthFact,
} from './chief-of-staff.js';
import {
  ASK_CITATION_LIMIT,
  MAX_DOCUMENT_BODY_LENGTH,
  MAX_QUESTION_LENGTH,
  SEARCH_SOURCES,
  assembleAnswer,
  normalizeSearchQuery,
  resolveRetrievalAdapter,
  runCompanySearch,
  searchSourceDescriptor,
  sourceStatuses,
  SEARCH_SNAPSHOT_NOTE,
  type AskAnswerView,
  type CompanySearchQuery,
  type CompanySearchView,
  type RetrievalMode,
  type SearchCorpus,
  type SearchDocument,
  type SearchEntityRef,
  type SearchIndexSnapshotView,
  type SearchSourceId,
} from './search-command.js';
import { CLIENT_IDENTITY_KEYS } from '../live/auth.js';
import { ensureMemoryTables, memorySchemaPresent, MemoryStore, searchMemory } from '../memory/store.js';
import {
  MEMORY_KINDS,
  MEMORY_PRIVACY_LEVELS,
  isMemoryKind,
  isMemoryPrivacy,
  type MemoryKind,
  type MemoryPrivacy,
  type MemoryRecord as CompanyMemoryRecord,
} from '../memory/schema.js';
import type { SearchQuery } from '../archive/search.js';
import { isArchiveStatus, type ArchiveStatus, type DatedValue, type RelatedRefs } from '../archive/schema.js';

// ---- result contract ----

export type OpsErrorCode =
  | 'invalid_input'
  | 'unknown_task'
  | 'unknown_capability'
  | 'capability_disabled'
  | 'not_permitted'
  | 'worker_not_assignable'
  | 'kill_switch_engaged'
  | 'action_digest_mismatch'
  | 'task_not_awaiting_approval'
  | 'assigned_to_other_worker'
  | 'task_already_claimed'
  | 'task_beyond_claiming'
  | 'provider_binding_mismatch'
  | 'unknown_provider'
  | 'nothing_claimable'
  | 'unknown_principal'
  | 'humans_do_not_execute'
  | 'enqueue_rejected'
  | 'operator_rejected'
  | 'proposal_not_found'
  | 'proposal_not_open'
  | 'proposal_digest_mismatch'
  | 'replacement_blocked'
  | 'unknown_mission'
  | 'invalid_mission_transition'
  | 'mission_status_changed'
  | 'mission_terminal'
  | 'mission_intent_conflict'
  | 'unknown_project'
  | 'invalid_project_transition'
  | 'project_status_changed'
  | 'project_closed'
  | 'workforce_registry_unconfigured'
  | 'unknown_memory'
  | 'memory_conflict'
  | 'mission_not_orchestratable'
  | 'orchestrate_fingerprint_mismatch'
  // Phase 7 — the truth/evidence projection.
  | 'unknown_truth'
  | 'unknown_evidence'
  | 'unknown_entity'
  | 'truth_conflict'
  | 'truth_not_verified'
  | 'truth_contested'
  // Phase 8 — the authority/risk/external-action gateway.
  | 'unknown_action'
  | 'unknown_adapter'
  | 'action_state_conflict'
  | 'action_outcome_unknown'
  | 'duplicate_external_action'
  | 'action_approval_stale'
  | 'approval_required_by_risk'
  | 'intent_changed'
  | 'task_not_executing'
  | 'mission_not_active'
  // Phase 9 — the Mission Room / multi-AI collaboration record.
  | 'unknown_session'
  | 'session_closed'
  | 'not_a_participant'
  | 'unknown_contribution';
// Phase 10 adds NO refusal code: its two reads cannot fail (a derivation over
// whatever the canonical stores hold), `getBrief` answers null for an id that
// is not in the ledger, and `issueBrief` refuses only through the codes the
// Founder gate and the capability gate already own.

export interface OpsError {
  code: OpsErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type OpsResult<T> = { ok: true; data: T } | { ok: false; error: OpsError };

/**
 * Minimal browser-safe canonical element for a task-scoped context view:
 * never the payload, never the result (the snapshot's no-task-payload rule).
 */
export interface TaskContextRef {
  taskId: string;
  capabilityId: string;
  status: ActivityStatus;
  createdAt: string;
}

/**
 * Truthful, CATEGORICAL mission execution state (Phase 6, issue #265).
 * Counts and canonical statuses only — no percentage, no ETA, no invented
 * figure; the wire format actively refuses those shapes. `recommendation` is
 * derived readiness the Founder may act on; it transitions NOTHING.
 */
export interface MissionExecutionState {
  missionId: string;
  status: MissionStatus;
  planItems: {
    total: number;
    superseded: number;
    needsClarification: number;
    workUnspecified: number;
    workSpecified: number;
    linked: number;
  };
  linkedTasks: {
    planItemSeq: number;
    taskId: string;
    status: ActivityStatus;
    reviewPending: boolean;
    claimedBy: string | null;
    assignment: { workerId: string; assignedBy: string; assignedAt: string } | null;
    /** Evidence-free read through the SAME predicates enforcement uses. */
    eligibleWorkers: string[];
  }[];
  blockers: {
    unspecifiedWorkItems: number[];
    needsClarification: number[];
    approvalPending: string[];
    outcomeUnknown: string[];
    blocked: string[];
  };
  killSwitch: { global: boolean; orchestrate: boolean; engagedSpecScopes: string[] };
  /** Advisory, reported only — nothing schedules on it. */
  dependsOn: { missionId: string; status: MissionStatus | null }[];
  recommendation: 'none' | 'ready_review';
}

/**
 * The Founder's Mission Room (Phase 9): ONE read composing what canonical
 * truth holds about a mission and its collaboration — never a second record
 * of any of it. Every element is a canonical projection HQ already makes
 * (`missionBrowserView`, `MissionExecutionState`, `TruthRecordView`,
 * `ActionView`, run records) or a derived collaboration view; every list is
 * bounded with its true total stated. There is no worker "activity" here
 * that is not an attributed, stored contribution.
 */
export interface MissionRoomView {
  missionId: string;
  mission: MissionBrowserView;
  execution: MissionExecutionState;
  sessions: CollaborationSessionView[];
  /** Distinct admitted workers across every session of the mission, each with the roles held. */
  participants: { workerId: string; roles: CollaborationRole[]; providerId: string | null; memberIdentityKey: string | null }[];
  contributions: { items: ContributionView[]; total: number; truncated: boolean };
  disagreements: DisagreementView[];
  handoffRequests: HandoffRequestView[];
  /** Truth records ABOUT the mission or its linked tasks, newest first, bounded. Founder-gated reader: founder_only included. */
  truth: { records: TruthRecordView[]; total: number; truncated: boolean; unresolvedContradictions: number };
  /**
   * The mission's linked tasks the Founder gate is HOLDING — canonical
   * `op_tasks` rows with `status = 'needs_approval'`, referenced. No approval
   * id is named because a task still at the gate has no `hq_approvals` row:
   * HQ writes that row when the decision is made (Phase 10 correction, M1).
   */
  heldForApproval: { taskId: string; capabilityId: string; requestedBy: string; since: string }[];
  /** Orchestration run records for this mission, newest first, bounded. */
  recentRuns: { runId: string; requestedBy: string; at: string; summary: Record<string, unknown> }[];
  /** External-action ledger entries bound to the mission or its linked tasks, newest first, bounded. */
  externalActions: {
    items: {
      id: string;
      taskId: string;
      adapterId: string;
      actionType: string;
      riskLevel: string;
      state: string;
      requestedBy: string;
      requestedAt: string;
    }[];
    total: number;
    truncated: boolean;
  };
  assembledAt: string;
  provenance: Provenance;
}

/**
 * A bounded, role/task/mission-scoped context bundle (Phase 9) — what a
 * worker admitted under `role` receives. Read-time composition that persists
 * nothing. Absent by construction: founder_only memory and truth (counted in
 * `withheld`), raw intent bodies, task payloads, and every other session's
 * contributions. `sections` names what THIS role's policy assembled; a
 * section outside the policy is null, never an empty list pretending to be a
 * read.
 */
export interface CollaborationContextBundle {
  sessionId: string;
  missionId: string;
  role: CollaborationRole;
  taskId: string | null;
  assembledAt: string;
  sections: readonly ContextSection[];
  mission: {
    id: string;
    title: string;
    objective: string;
    scope: string | null;
    constraints: string[];
    acceptanceCriteria: string[] | null;
    status: MissionStatus;
    priority: MissionPriority | null;
    blockReason: string | null;
    /** The current intent version — what a contribution is made against. */
    intentSeq: number;
    planItems: {
      seq: number;
      summary: string;
      kind: 'work' | 'needs_clarification';
      state: MissionPlanItemState;
      taskId: string | null;
      specCapabilityId: string | null;
    }[];
  };
  task: TaskContextRef | null;
  participants: ParticipantView[] | null;
  contributions: { items: ContributionView[]; total: number } | null;
  truth: {
    items: {
      id: string;
      entityKind: TruthEntityKind;
      entityId: string;
      statement: string;
      state: TruthState;
      contested: boolean;
      evidenceRefs: string[];
    }[];
    total: number;
  } | null;
  memory: { groups: MemoryContextGroup[] } | null;
  withheld: ContextWithheld;
  provenance: Provenance;
}

/**
 * What the bundle did NOT carry — reported at the audience's resolution.
 *
 * A `founder_only` CARDINALITY is itself a disclosure about private material:
 * "3 private truth records exist about your mission" is a fact a worker was
 * never meant to learn, and repeated probes across task scopes would localise
 * them. So a worker is told categorically THAT something was withheld and
 * nothing more (Founder decision, Phase 9 correction Low L3); the
 * Founder-gated audit path keeps the exact counts, because auditing what a
 * role would receive is exactly the case for knowing the numbers.
 *
 * `otherSessionContributions` stays a count for both audiences deliberately:
 * it is not founder_only material, it is same-mission collaboration the
 * worker's own room simply does not include, and the phase advertises it as a
 * stated bound rather than a silent drop.
 */
export type ContextWithheld =
  | {
      audience: 'worker';
      /** Whether ANY founder_only memory was withheld. Never how much. */
      founderOnlyMemory: boolean;
      /** Whether ANY founder_only truth was withheld. Never how much. */
      founderOnlyTruth: boolean;
      otherSessionContributions: number;
    }
  | {
      audience: 'founder_audit';
      founderOnlyMemory: number;
      founderOnlyTruth: number;
      otherSessionContributions: number;
    };

export interface OrchestrationReport {
  missionId: string;
  mode: 'preview' | 'apply';
  /** Null for preview — a preview writes nothing, so there is no run. */
  runId: string | null;
  /** Echo this into apply: a mission that moved since the preview refuses. */
  fingerprint: string;
  state: MissionExecutionState;
  decisions: OrchestrationDecision[];
}

function fail(code: OpsErrorCode, message: string, details?: Record<string, unknown>): OpsResult<never> {
  return { ok: false, error: { code, message, details } };
}

function ok<T>(data: T): OpsResult<T> {
  return { ok: true, data };
}

/**
 * Live-claim statuses: the task is genuinely held by its claimant right now.
 * The SAME predicate as `replacementPlan()` and the handover inventory
 * (`claimed_by` set AND status in this list) — `complete()` deliberately
 * leaves `claimed_by` on the finished row for attribution, so the column
 * alone is not a claim.
 */
const LIVE_CLAIM_STATUSES: readonly ActivityStatus[] = ['assigned', 'running', 'outcome_unknown'];

/**
 * Phase 10: the canonical position a brief observes, and the delta it is
 * measured against, deliberately EXCLUDE the brief ledger's own audit rows.
 *
 * Issuing a brief appends one `hq_events` row and one `op_evidence` entry, as
 * every write in HQ does. If those counted, the watermark would move every
 * time a brief was issued, so a second brief issued a second later would
 * never deduplicate and "what changed since the last brief" would report the
 * last brief. Neither is true of the COMPANY record: writing a brief is not
 * something to brief about.
 *
 * The exclusion is exact rather than a name-shaped guess — the events are
 * matched against the ledger's own ids, and the evidence against the one kind
 * `issueBrief` appends — and it is stated wherever the watermark is shown.
 */
const BRIEF_EVIDENCE_KIND = 'founder_brief_issued';
const NOT_A_BRIEF_EVENT_SQL = `NOT (subject_kind = 'system' AND subject_id IN (
  SELECT 'brief:' || id FROM hq_briefs
))`;
const NOT_A_BRIEF_EVIDENCE_SQL = `kind <> '${BRIEF_EVIDENCE_KIND}'`;
/**
 * With no ledger on the handle there is nothing to exclude — and the
 * sub-select would reference a table that does not exist — so the predicate
 * degenerates to "every row", which is the truthful answer for a file that
 * has never held a brief.
 */
function notABriefEvent(ledgerPresent: boolean): string {
  return ledgerPresent ? NOT_A_BRIEF_EVENT_SQL : '1 = 1';
}
function notABriefEvidence(ledgerPresent: boolean): string {
  return ledgerPresent ? NOT_A_BRIEF_EVIDENCE_SQL : '1 = 1';
}

/**
 * Why an advisory assignment intent may NOT be recorded for this task, or
 * null when it may. ONE predicate with two consumers — `assignTask` (the
 * write refusal) and `evaluateTaskEligibility` (the read) — so the browser
 * is never told an assignment is open that the write path would refuse
 * (GPT-5.6 Sol M1 on PR #263).
 *
 * An assignment intent's only operational effect is to narrow FUTURE
 * claiming from the queue, so it is allowed exactly while that effect is
 * genuinely possible:
 * - a task under a live fenced claim is refused — recording "meant for B"
 *   while A holds the claim narrows nothing now and would silently misroute
 *   a re-claim after a later release;
 * - a task whose status can never reach `queued` again is refused — no
 *   statement about its future claiming can be true;
 * - `blocked` / `needs_approval` / `review_failed` with no live claim stay
 *   assignable: `queued` is reachable from all three, so the narrowing is
 *   real. (A `needs_approval` task that arrived there from `running` may
 *   resume under its original claimant, in which case the intent simply
 *   never fires — advisory means advisory.)
 *
 * A live claim whose lease has expired but has not been reaped yet is still
 * refused (consistent with `replacementPlan`); the lease expiry is included
 * in the details so a stale claim is legible. The lease is NOT released
 * here — a refusal must never change state.
 */
function assignmentBarrier(task: OperatorTask): OpsError | null {
  if (task.claimedBy != null && LIVE_CLAIM_STATUSES.includes(task.status)) {
    return {
      code: 'task_already_claimed',
      message: `Task ${task.id} is already claimed by ${task.claimedBy} (status ${task.status}); an assignment intent recorded now could not narrow claiming`,
      details: {
        taskId: task.id,
        claimedBy: task.claimedBy,
        status: task.status,
        leaseExpiresAt: task.leaseExpiresAt,
      },
    };
  }
  if (QUEUED_UNREACHABLE_STATUSES.has(task.status)) {
    return {
      code: 'task_beyond_claiming',
      message: `Task ${task.id} is ${task.status} and can never return to the queue; there is no future claiming to narrow`,
      details: { taskId: task.id, status: task.status },
    };
  }
  return null;
}

/** Trim + bound one mission text field. Absent optional fields become null. */
function missionText(
  field: string,
  value: string | undefined,
  max: number,
  required: boolean,
): { ok: true; value: string | null; message?: never } | { ok: false; message: string } {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    return required ? { ok: false, message: `${field} is required` } : { ok: true, value: null };
  }
  if (trimmed.length > max) {
    return { ok: false, message: `${field} exceeds ${max} characters` };
  }
  return { ok: true, value: trimmed };
}

/**
 * Trim + bound one mission list field. `undefined` stays null (honestly not
 * supplied); an explicit empty list is a stated empty list.
 */
function missionList(
  field: string,
  values: string[] | undefined,
): { ok: true; value: string[] | null; message?: never } | { ok: false; message: string } {
  if (values == null) return { ok: true, value: null };
  if (!Array.isArray(values)) return { ok: false, message: `${field} must be a list` };
  if (values.length > MAX_MISSION_LIST_ITEMS) {
    return { ok: false, message: `${field} exceeds ${MAX_MISSION_LIST_ITEMS} entries` };
  }
  const out: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') return { ok: false, message: `${field} entries must be text` };
    const trimmed = entry.trim();
    if (!trimmed) return { ok: false, message: `${field} entries must not be empty` };
    if (trimmed.length > MAX_MISSION_ITEM_LENGTH) {
      return { ok: false, message: `${field} entries exceed ${MAX_MISSION_ITEM_LENGTH} characters` };
    }
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

/**
 * Trim + bound one memory list field with a caller-supplied per-entry bound
 * (memory lists carry tags AND locators, whose sane lengths differ —
 * `missionList` above hard-binds the mission bounds). `undefined` becomes an
 * empty list: memory lists have no supplied-vs-absent distinction to record.
 */
function memoryList(
  field: string,
  values: string[] | undefined,
  maxEntryLength: number,
): { ok: true; value: string[]; message?: never } | { ok: false; message: string } {
  if (values == null) return { ok: true, value: [] };
  if (!Array.isArray(values)) return { ok: false, message: `${field} must be a list` };
  if (values.length > MAX_MEMORY_LIST_ITEMS) {
    return { ok: false, message: `${field} exceeds ${MAX_MEMORY_LIST_ITEMS} entries` };
  }
  const out: string[] = [];
  for (const entry of values) {
    if (typeof entry !== 'string') return { ok: false, message: `${field} entries must be text` };
    const trimmed = entry.trim();
    if (!trimmed) return { ok: false, message: `${field} entries must not be empty` };
    if (trimmed.length > maxEntryLength) {
      return { ok: false, message: `${field} entries exceed ${maxEntryLength} characters` };
    }
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

/**
 * A bounded list of ids for the truth projection (evidence ids, truth record
 * ids): the memory-list rules, plus duplicates collapsed in order so a
 * repeated id cannot mint a duplicate relation row.
 */
function truthIdList(
  field: string,
  values: string[] | undefined,
): { ok: true; value: string[]; message?: never } | { ok: false; message: string } {
  const list = memoryList(field, values, MAX_TRUTH_ENTITY_ID_LENGTH);
  if (!list.ok) return list;
  return { ok: true, value: [...new Set(list.value)] };
}

function emptyTruthGraph(): TruthGraph {
  return { records: [], relations: [], verifications: [], acceptances: [] };
}

/**
 * A stored JSON string list, read defensively (Phase 11 corpus builder).
 *
 * The corpus reads `hq_memory.tags` as a raw column rather than through the
 * store's row mapper, so a malformed value must degrade to "no tags" instead
 * of throwing a search request. Nothing here repairs the row.
 */
function safeStringList(encoded: string | null): string[] {
  if (!encoded) return [];
  try {
    const parsed: unknown = JSON.parse(encoded);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Map a truth record's SUBJECT onto a search entity reference.
 *
 * Total over `TruthEntityKind`, deliberately: the Phase 10 salvage found a
 * draft that relabelled a `memory` subject as `truth`, publishing a memory id
 * under the wrong kind. A total mapping cannot drift that way.
 */
function truthEntityRef(entityKind: TruthEntityKind, entityId: string): SearchEntityRef {
  switch (entityKind) {
    case 'mission':
      return { kind: 'mission', id: entityId };
    case 'project':
      return { kind: 'project', id: entityId };
    case 'task':
      return { kind: 'task', id: entityId };
    case 'memory':
      return { kind: 'memory', id: entityId };
    case 'worker':
      return { kind: 'worker', id: entityId };
    case 'capability':
      return { kind: 'capability', id: entityId };
  }
}

/**
 * Shape-check a RelatedRefs object from the boundary: known keys only, each a
 * bounded array of the right primitive. Refusal names the offending key — an
 * unknown key is refused rather than dropped, because silently discarding a
 * cross-link would record less than the Founder stated.
 */
function memoryRelatedRefs(
  value: RelatedRefs | undefined,
): { ok: true; value: RelatedRefs; message?: never } | { ok: false; message: string } {
  if (value == null) return { ok: true, value: {} };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'related must be an object' };
  }
  const out: RelatedRefs = {};
  for (const [key, entries] of Object.entries(value)) {
    if (!['issues', 'pullRequests', 'commits', 'artifacts'].includes(key)) {
      return { ok: false, message: `related.${key} is not a known reference list` };
    }
    if (!Array.isArray(entries) || entries.length > MAX_MEMORY_LIST_ITEMS) {
      return { ok: false, message: `related.${key} must be a list of at most ${MAX_MEMORY_LIST_ITEMS} entries` };
    }
    const wantNumber = key === 'issues' || key === 'pullRequests';
    for (const entry of entries) {
      if (wantNumber ? typeof entry !== 'number' : typeof entry !== 'string') {
        return { ok: false, message: `related.${key} entries have the wrong type` };
      }
    }
    (out as Record<string, unknown>)[key] = [...entries];
  }
  return { ok: true, value: out };
}

/** One normalized Founder work spec from the plan intake. */
interface NormalizedWorkSpec {
  capabilityId: string;
  /** Canonical JSON — the exact bytes the orchestrator will hand to createTask. */
  payload: string;
}

/**
 * Validate one Founder work spec (Phase 6, issue #265). Shape/bounds only —
 * whether the capability is REGISTERED/ENABLED/GRANTED is an
 * orchestration-time verdict, because a capability may legitimately be
 * registered after the mission was commanded.
 *
 * The payload is a plain JSON object, at most three levels deep, and no key
 * at ANY depth may be a client-identity key — the boundary's scan stops at
 * depth three, so this facade check is the defense-in-depth that keeps a
 * spec from smuggling a `requestedBy` past it inside a nested object.
 */
function normalizeWorkSpec(
  field: string,
  capabilityId: unknown,
  payload: unknown,
): { ok: true; value: NormalizedWorkSpec; message?: never } | { ok: false; message: string } {
  if (typeof capabilityId !== 'string' || capabilityId.trim() === '') {
    return { ok: false, message: `${field}: a spec needs a capabilityId` };
  }
  const trimmedCapability = capabilityId.trim();
  if (trimmedCapability.length > MAX_MISSION_SPEC_CAPABILITY_LENGTH) {
    return { ok: false, message: `${field}: capabilityId exceeds ${MAX_MISSION_SPEC_CAPABILITY_LENGTH} characters` };
  }
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: `${field}: a spec payload must be a JSON object` };
  }
  const walk = (value: unknown, depth: number): string | null => {
    if (value == null || typeof value !== 'object') return null;
    if (depth > 3) return `${field}: a spec payload may nest at most three levels deep`;
    if (Array.isArray(value)) {
      for (const entry of value) {
        const problem = walk(entry, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (CLIENT_IDENTITY_KEYS.includes(key)) {
        return `${field}: a spec payload may not carry the reserved key '${key}'`;
      }
      const problem = walk(entry, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  const problem = walk(payload, 1);
  if (problem) return { ok: false, message: problem };
  const encoded = canonicalJson(payload);
  if (encoded.length > MAX_MISSION_SPEC_PAYLOAD_LENGTH) {
    return { ok: false, message: `${field}: the spec payload exceeds ${MAX_MISSION_SPEC_PAYLOAD_LENGTH} characters` };
  }
  return { ok: true, value: { capabilityId: trimmedCapability, payload: encoded } };
}

/**
 * A (mission_id, seq) collision from a raced concurrent amendment.
 * With the amendment's reads inside an IMMEDIATE transaction this should be
 * unreachable; it is kept so that any writer which nevertheless collides
 * surfaces as a typed conflict rather than an opaque 500.
 *
 * Two engine shapes describe the same collision: the UNIQUE constraint, and
 * — since Phase 4 §G — the BEFORE INSERT append-only guard, which fires
 * FIRST (it aborts an insert landing on an existing row before conflict
 * resolution or the UNIQUE check can run) and surfaces as
 * SQLITE_CONSTRAINT_TRIGGER carrying the table name in its message.
 */
function isMissionSequenceConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: string }).code;
  if (code !== 'SQLITE_CONSTRAINT_UNIQUE' && code !== 'SQLITE_CONSTRAINT_TRIGGER') return false;
  return (
    error.message.includes('hq_mission_intents') || error.message.includes('hq_mission_plan_items')
  );
}

// ---- inputs / outputs ----

export interface CreateTaskInput {
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  /**
   * Worker or human principal opening the work. Permissions are read from the
   * matching registry, never from the caller. A human's grant is to ORIGINATE
   * only — it never confers a claim.
   */
  requestedBy: string;
  /** Console labels only — never authority. */
  project?: string;
  title?: string;
}

export interface CreatedTask {
  task: OperatorTask;
  classification: TaskClassification;
  deduplicated: boolean;
}

/** A nomination after the Operator has had the final word on it. */
export interface EvaluatedNomination {
  workerId: string;
  /** Nomination source ids that suggested this worker. */
  nominatedBy: string[];
  rationales: string[];
  assignability: WorkerAssignability;
  /** The Operator's own decision, from registry + directory allow-list only. */
  operatorDecision: PolicyDecision;
  /** True only when the Operator itself would admit this worker. */
  eligible: boolean;
}

export interface TaskRouting {
  taskId: string;
  capabilityId: string;
  classification: TaskClassification;
  nominations: EvaluatedNomination[];
}

export interface AssignmentIntent {
  taskId: string;
  workerId: string;
  assignedBy: string;
  assignedAt: string;
  rationale: string | null;
}

/**
 * One registered worker's standing toward one task (Phase 4). Everything here
 * is enforcement truth or its verbatim refusal reason — nothing advisory can
 * change `eligible`, and nothing here fabricates availability: transport/
 * connectivity truth deliberately lives at the control-api layer, where the
 * secrets environment does.
 */
export interface WorkerEligibility {
  workerId: string;
  displayName: string;
  role: string;
  /** The directory grants the task's capability id (enforcement read). */
  holdsCapability: boolean;
  assignability: WorkerAssignability;
  operatorOutcome: PolicyDecision['outcome'];
  denyReason: string | null;
  /** Declared execution provider — declared or null, never inferred. */
  providerDeclared: string | null;
  /** Advisory only: which sources nominated this worker, and why. */
  nominatedBy: string[];
  rationales: string[];
  eligible: boolean;
}

/**
 * Canonical task/claim state on the eligibility read, so the browser can
 * never be shown "eligible" workers for a task the write path would refuse:
 * `assignmentOpen` is computed by the SAME `assignmentBarrier` predicate
 * `assignTask` enforces, and `reason` is that refusal verbatim (null while
 * assignment is genuinely open).
 */
export interface TaskAssignmentState {
  status: ActivityStatus;
  claimedBy: string | null;
  assignmentOpen: boolean;
  reason: string | null;
}

export interface TaskEligibilityReport {
  taskId: string;
  capabilityId: string;
  classification: TaskClassification;
  taskState: TaskAssignmentState;
  workers: WorkerEligibility[];
}

export interface TaskMeta {
  taskId: string;
  project: string | null;
  title: string | null;
  sourceProposalId: string | null;
  assignment: AssignmentIntent | null;
}

export interface ApproveTaskInput {
  taskId: string;
  /** Human principal deciding. Refused for any registered worker. */
  founderId: string;
  /**
   * The digest the Approval Center displayed. REQUIRED: if the action changed
   * since it was rendered, the approval is refused rather than written.
   */
  expectedActionDigest: string;
  ttlMs?: number;
  note?: string;
}

export interface DenyTaskInput {
  taskId: string;
  founderId: string;
  reason: string;
  /** Optional; a mismatch is recorded but does not block a denial. */
  expectedActionDigest?: string;
}

export interface ReplacementBlocker {
  taskId: string;
  status: ActivityStatus;
  capabilityId: string;
  /** What must happen before the worker can be safely removed. */
  requires: 'handover' | 'reconciliation';
}

export interface ReplacementPlan {
  workerId: string;
  safe: boolean;
  blockers: ReplacementBlocker[];
}

/**
 * The worker→provider WRITE mechanism, defined here and exported to nobody.
 *
 * It lived in `operator/provider-binding.ts` for two rounds and could not be
 * held there. Removing it from the queue's property left the class publicly
 * constructible; a module-local construction key then left an exported factory
 * holding that key, so a deep import still reached it — the same mistake one
 * level up (issue #200, Codex exact-head findings on `5a19350` and `03a7104`).
 * Omitting a name from `operator/index.ts` never stopped a deep import, and ESM
 * offers no package-private class, so no gate in an importable module can hold.
 *
 * Defining it here does hold, because there is no exported path to it at all:
 * reaching this mechanism means going through `HeadquarterOperations`, whose
 * `declareWorkerProvider`/`revokeWorkerProvider` resolve the actor against the
 * human-principal registry and require approval authority — the same gate as
 * the kill switch. The read side stays in the operator module, where it grants
 * nothing and the queue needs it.
 */
class WorkerProviderRegistrar extends WorkerProviderDirectory {
  /**
   * Its own `#private` handle rather than an inherited `protected` one. The
   * base class's database is `#private` now too, and `protected` would have
   * erased to a public property on this subclass — reintroducing, one level
   * down, exactly the route this class exists behind a gate to prevent.
   */
  readonly #db: HqDatabase;

  constructor(db: HqDatabase) {
    super(db);
    this.#db = db;
  }

  /** Declare (or re-declare) which provider a worker executes as. */
  declare(workerId: string, providerId: string, declaredBy: string): WorkerProviderRecord {
    if (!workerId?.trim() || !providerId?.trim() || !declaredBy?.trim()) {
      throw new ProviderDeclarationRejected(
        'invalid_input',
        'A provider declaration needs a worker, a provider and a declaring actor',
      );
    }
    if (!(PROVIDERS as readonly string[]).includes(providerId)) {
      throw new ProviderDeclarationRejected(
        'unknown_provider',
        `Unknown execution provider: ${providerId}. Declarations are limited to the routing ` +
          `registry (${PROVIDERS.join(', ')}), so a typo fails closed instead of creating a ` +
          'declaration that matches nothing.',
      );
    }
    const declaredAt = nowIso();
    this.#db
      .prepare(
        `INSERT INTO op_worker_providers (worker_id, provider_id, declared_by, declared_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET
           provider_id = excluded.provider_id,
           declared_by = excluded.declared_by,
           declared_at = excluded.declared_at`,
      )
      .run(workerId, providerId, declaredBy, declaredAt);
    return { workerId, providerId: providerId as ProviderId, declaredBy, declaredAt };
  }

  /** Remove a declaration. The worker can then claim no provider-bound task. */
  revoke(workerId: string): boolean {
    const result = this.#db.prepare(`DELETE FROM op_worker_providers WHERE worker_id = ?`).run(workerId);
    return result.changes > 0;
  }
}

export interface HeadquarterOperationsOptions {
  policyCtx?: PolicyContext;
  workers?: WorkerDirectoryPort;
  /** Human identity seam. Defaults to the (initially empty) table-backed registry. */
  humanPrincipals?: HumanPrincipalPort;
  nominationSources?: readonly NominationSourcePort[];
  store?: HeadquarterStore;
  queue?: OperatorQueue;
  /**
   * Lane C's AI Member Registry (issue #174 Mission C).
   *
   * When supplied, worker capability reads are narrowed to the Registry's
   * GRANTED/EFFECTIVE capabilities, so nomination and authorization can no
   * longer diverge from the provider-neutral Registry. The Registry may only
   * narrow — see application/registry-directory.ts. Omit it and behaviour is
   * exactly as before.
   *
   * Ignored when an explicit `workers` port is supplied: an explicit directory
   * is already a deliberate override of this whole resolution.
   */
  memberRegistry?: MemberDirectorySource;
  /**
   * Lane C's full AI Member Registry, for the Phase 4 workforce LIFECYCLE
   * facade (`registerAiMember`, `disableAiMember`, `setAiMemberHealth`,
   * `listAiMembers`) — registration, display and advisory truth only.
   *
   * DELIBERATELY NOT the same thing as `memberRegistry` above, and NEVER
   * consulted for capability narrowing, worker resolution or any enforcement
   * read: wiring narrowing on is the recorded authority migration
   * (registry-directory.ts, issue #182) and remains a separate Founder
   * decision. Omitting this leaves the workforce facade truthfully
   * unconfigured (`workforce_registry_unconfigured`), never silently active.
   */
  aiMemberRegistry?: AiMemberRegistry;
  /**
   * Receives the dispatch-only evidence capability, once, at construction — and
   * nobody else ever does (issue #219, Founder decision approving Option B).
   *
   * The same shape as `OperatorQueue`'s `grantPrivileged`, for the same reason:
   * a power that must not be reachable from the object under attack is given to
   * the code that BUILDS that object. A composition root (the dispatch CLI, the
   * ingest CLI, a test fixture) captures the grant here and passes it into the
   * dispatch lane; a worker handed the resulting `ops` has no way to obtain it.
   */
  grantDispatchEvidence?: (grant: DispatchEvidenceGrant) => void;
  /**
   * The external-action adapters this deployment may execute through (Phase
   * 8). Supplied ONLY by the composition root, exactly like the dispatch
   * evidence grant: an adapter is an execution mechanism, and nothing holding
   * `ops` may register one. A contract that fails `adapterContractProblems`
   * refuses construction loudly rather than becoming a silently unusable lane.
   * Omitted ⇒ the gateway records nothing executable and every execute refuses
   * `unknown_adapter`.
   */
  actionAdapters?: readonly ExternalActionAdapter[];
}

/** Who an actor turned out to be, once resolved against both registries. */
type ResolvedRequester =
  | { kind: 'worker'; allowedCapabilities: readonly string[] }
  | { kind: 'human'; allowedCapabilities: readonly string[] };

/**
 * A defensive, frozen copy of a policy context.
 *
 * `PolicyContext` carries a `ReadonlySet` — readonly in TYPE only. The service
 * and the queue both retained the caller's object, and `ops.policyContext`
 * handed it to anyone, so `ops.policyContext.preApprovedCapabilities.add(...)`
 * granted a standing pre-approval for an `external_side_effect` capability and
 * `#enqueue`, `claim` and `start` all then skipped the Founder gate (issue
 * #200, Codex exact-head finding on `063c7d3`).
 *
 * A new `Set` per copy, and the object frozen, so neither the caller's original
 * nor a value handed out later is the one enforcement reads.
 */
function freezePolicyContext(ctx: PolicyContext | undefined): PolicyContext {
  return Object.freeze({
    preApprovedCapabilities: Object.freeze(new Set(ctx?.preApprovedCapabilities ?? [])) as ReadonlySet<string>,
  });
}

/**
 * Prepare a statement once and return its `get` already bound.
 *
 * Enforcement then calls a closure directly: no `db.prepare` lookup on
 * `Database.prototype` and no `.get` lookup on `Statement.prototype` at call
 * time, both of which are mutable third-party prototypes a same-realm caller
 * can replace.
 *
 * This is a narrowing, not a guarantee — see the note at the call site.
 */
function bindGet(db: HqDatabase, sql: string): (...params: unknown[]) => unknown {
  const stmt = db.prepare(sql);
  const get = stmt.get.bind(stmt) as (...params: unknown[]) => unknown;
  return get;
}

/**
 * Module-private. Assigned once by the class's static block below; unreachable
 * and unassignable from any other module, which is what makes `capabilityRowFor`
 * an enforcement-safe path rather than another patchable surface.
 */
let readCapabilityRow: (ops: HeadquarterOperations, capabilityId: string) => Capability | null;

/**
 * Module-private, same recipe as `readCapabilityRow` (Phase 8, Low 7): the
 * canonical kill-switch read published to `killSwitchEngagedFor` and nothing
 * else, so a provider lane deciding dispatch eligibility can read the row
 * through a function binding instead of the patchable queue delegate.
 */
let readKillSwitchEngaged: (ops: HeadquarterOperations, capabilityId?: string) => boolean;
/** Same recipe for the gateway's attempt history (the dispatch lane's one-external-path verdict). */
let readGatewayActionHistory: (ops: HeadquarterOperations, taskId: string) => GatewayActionHistory;
/**
 * Same recipe for a task's canonical `op_evidence` rows (review round 2): the
 * dispatch lane's duplicate-publication read (`dispatchHistory`) decides whether
 * a public GitHub issue is published again, so it must not read the patchable
 * `queue.evidence.list` display surface.
 */
let readTaskEvidenceRows: (ops: HeadquarterOperations, taskId: string) => CanonicalEvidenceRow[];

export class HeadquarterOperations {
  readonly queue: OperatorQueue;
  /**
   * `#private`: `HeadquarterStore` carries `upsertSpecialist`, so a holder
   * could grant itself any capability and satisfy every check above it. The
   * two reads the snapshot seam legitimately needs are exposed as a read-only
   * view instead. Not named by the review; found by sweeping the class rather
   * than the findings.
   */
  readonly #store: HeadquarterStore;
  /** Reads the live snapshot needs. No write method to find. */
  readonly directory: {
    listSpecialists: () => ReturnType<HeadquarterStore['listSpecialists']>;
    latestStatusPerSubject: () => ReturnType<HeadquarterStore['latestStatusPerSubject']>;
    getSpecialist: (workerId: string) => ReturnType<HeadquarterStore['getSpecialist']>;
  };
  /**
   * Read-only principal LOOKUP — a method, never the registry object.
   *
   * #200 removed the public `principals` collaborator because it was patchable:
   * `ops.principals.get = () => ({ approvalAuthority: true, ... })` forged the
   * Founder gate one layer below the authority method. That property stays
   * gone, and `test/provider-binding.test.ts` asserts it.
   *
   * #214's control API still has to resolve an authenticated account to the
   * SAME principal `createTask`/`approveTask` authorize against — a second
   * injected registry is the two-sources-of-truth bug #200 made unrepresentable
   * on purpose, so re-adding one is not an option either.
   *
   * This is the narrow way through: it resolves via `#principalOf`, which the
   * enforcement path calls DIRECTLY. Replacing this method changes what the
   * replacer reads and nothing about what any gate decides — the same standard
   * that keeps `selectClaimable` public and disqualified `get`.
   */
  lookupPrincipal(id: string): HumanPrincipal | null {
    return this.#principalOf(id);
  }
  /**
   * Effective worker directory. `#private`: it was a public collaborator, so
   * `ops.workers.allowedCapabilities = () => [cap]` forged a least-privilege
   * grant, and `ops.principals.get = () => ({ approvalAuthority: true, ... })`
   * forged the Founder gate itself — making the authority METHOD `#private`
   * bought nothing while the registry it resolves through stayed patchable
   * (issue #200, Codex exact-head finding on `f91563f`).
   */
  readonly #workers: WorkerDirectoryPort;
  /**
   * READS of the effective directory, as own-property closures. Callers and
   * tests legitimately ask what a worker is granted; enforcement resolves
   * through `#workers` and never through this, so patching it changes what the
   * patcher sees and nothing about what is enforced — the same split already
   * used for `queue.get` and `queue.capabilities`.
   */
  readonly workers: {
    allowedCapabilities: (workerId: string) => readonly string[];
    isRegistered: (workerId: string) => boolean;
    assignability: (workerId: string) => ReturnType<WorkerDirectoryPort['assignability']>;
  };
  /**
   * Human identity, deliberately separate from worker identity. Empty by
   * default: nobody is a principal until a Founder registers them.
   */
  readonly #principals: HumanPrincipalPort;
  /**
   * ENFORCEMENT lookups, as prototype-free closures captured at construction.
   *
   * Making `#principals` and `#workers` `#private` hid the instance references
   * and nothing else: the default instances are a `HumanPrincipalRegistry` and
   * a `SpecialistDirectoryAdapter`/`NarrowingWorkerDirectory`, all exported
   * classes, and every call resolved its method through those mutable
   * prototypes. A same-realm worker or plugin could set
   * `HumanPrincipalRegistry.prototype.get = () => ({ approvalAuthority: true, ... })`
   * and forge the Founder gate, or patch the directory prototype and forge a
   * least-privilege grant (issue #200, Codex exact-head findings on `063c7d3`).
   *
   * This is the same defect the queue's provider lookup had in round 42, and
   * the same remedy: read the DATABASE through a closure, so no object an
   * attacker can reach participates in the answer. A CUSTOM port supplied by
   * the composer is used as given — that object is the composer's own choice at
   * construction, the same trust level as the privileged grant itself.
   */
  readonly #principalOf: (id: string) => HumanPrincipal | null;
  readonly #grantOf: (workerId: string) => readonly string[];
  readonly #isRegisteredWorker: (workerId: string) => boolean;
  readonly #nominationSources: readonly NominationSourcePort[];
  readonly #policyCtx: PolicyContext;
  /** Write side of the worker → provider map. Private by design — see below. */
  /**
   * ECMAScript `#private`, not TypeScript `private`.
   *
   * TypeScript's `private` is a compile-time annotation and erases to an
   * ordinary public property, so `ops.workerProviderRegistrar.declare(...)` was
   * reachable from any JavaScript caller holding the exported
   * `HeadquarterOperations` — the authority gate bypassed for the third time in
   * three attempts (issue #200, Codex exact-head findings on `5a19350`,
   * `03a7104` and `f221826`). The first attempt removed it from the queue's
   * property; the second added a construction key and exported the factory
   * holding it; the third moved the class here and left the INSTANCE on a
   * public field. Each time the signpost moved and the path did not.
   *
   * `#` is enforced by the runtime: the field is not a property, does not
   * appear on the object, and cannot be reached by name, index or reflection
   * from outside this class body.
   */
  readonly #workerProviderRegistrar: WorkerProviderRegistrar;
  readonly #queuePrivileged: PrivilegedQueueApi | undefined;
  /**
   * Capability WRITE side, `#private`, for the same reason as the provider
   * registrar: a worker holding a queue could otherwise rewrite the
   * `op_capabilities` row that enforcement reads and downgrade an already
   * claimed task's risk class (issue #200, Codex exact-head finding on
   * `653bdb8`). Reads stay on `queue.capabilities`.
   *
   * No enable/disable method is exposed here. One was drafted and removed: an
   * existing security test forbids `set*Capability*` on this surface, and it was
   * right to. No production path disables a capability — only tests do, and a
   * test holding the database can build its own registry. A method that exists
   * only to satisfy tests is surface an attacker gets for free.
   *
   * NOTE, flagged rather than invented: this makes registration unreachable
   * from a queue handle, which is what the finding requires. WHO may register a
   * capability — whether it should require approval authority like
   * `declareWorkerProvider` — is a policy question this correction loop is not
   * authorised to decide, so no authority rule has been made up here.
   */


  /**
   * ECMAScript `#private`. TypeScript `private` erases to a public property, so
   * `ops.db` handed a writable database to any JavaScript caller holding the
   * exported operations object — and from there `op_worker_providers` can be
   * upserted directly, satisfying the provider binding check while bypassing
   * `declareWorkerProvider`, its principal/approval-authority gate and its
   * evidence record entirely (issue #200, Codex exact-head finding on
   * `135ae58`). This was the FOURTH distinct route to that boundary, and the
   * first one below the mechanism rather than beside it: making the registrar
   * `#private` closed the named property and left its substrate public.
   */
  readonly #db: HqDatabase;

  /**
   * Whether this database carries the Phase 3 mission tables. False only for
   * a READ-ONLY handle over a pre-Phase-3 file (schema init never writes
   * through a read-only connection); mission reads then answer empty/null
   * truthfully, and the snapshot layer states the absence in its provenance.
   */
  readonly #missionStorePresent: boolean;

  /** The Phase 4 project schema, same truth-recording as missions above. */
  readonly #projectStorePresent: boolean;

  /** The Phase 5 memory schema, same truth-recording as missions above. */
  readonly #memoryStorePresent: boolean;

  /** The Phase 7 truth/evidence schema, same truth-recording as missions above. */
  readonly #truthStorePresent: boolean;

  /** The Phase 8 action ledger schema, same truth-recording as missions above. */
  readonly #actionStorePresent: boolean;

  /** The Phase 9 collaboration schema, same truth-recording as missions above. */
  readonly #collaborationStorePresent: boolean;

  /**
   * The Phase 10 brief ledger (`hq_briefs`), same truth-recording as missions
   * above. Note what it does NOT gate: the Command Center's derivations read
   * canonical stores that exist without it, so a handle with no ledger still
   * answers every question truthfully — it simply cannot record a receipt,
   * and says so (`safeNext`'s `issue_founder_brief` carries the blocker).
   */
  readonly #briefStorePresent: boolean;


  /**
   * The external-action adapters, keyed by id — `#private`, handed in by the
   * composition root once, and read by the gateway's execute path ONLY. There
   * is deliberately no register/unregister method: an adapter is an execution
   * mechanism, so adding one is a construction-time act, never a runtime one.
   */
  readonly #actionAdapters: ReadonlyMap<string, ExternalActionAdapter>;

  /**
   * The Phase 5 company-memory store (issue #120 wired by #265), or null over
   * a read-only pre-Phase-5 file. `#private` and read by the memory facade
   * methods ONLY — no gate, grant, policy or enforcement path consults it.
   */
  readonly #memory: MemoryStore | null;

  /**
   * The Phase 4 workforce lifecycle registry (or null: unconfigured, stated).
   * `#private` and read by the workforce facade methods ONLY — never by
   * `#grantOf`, `#workers`, policy evaluation or any enforcement path.
   */
  readonly #aiMemberRegistry: AiMemberRegistry | null;

  /**
   * The capability ROW, read from the database (issue #219, Codex P1 on
   * `9c2a474`).
   *
   * `queue.capabilities` is an own-property closure that #200 documents as
   * patchable and that the queue's own tests patch — safe, because enforcement
   * reads `#capabilityOf` from the database instead. A capability-drift
   * decision is enforcement, so it may not read the convenience surface: with
   * `queue.capabilities.get` replaced to report the reserved definition, the
   * drift check said `enabled` while `#enqueue` classified the real weakened
   * row, and a Founder-gated order reached `queued`. Verified by exploit, then
   * closed here and regression-covered.
   */
  readonly #capabilityFromStore: (id: string) => Capability | null;

  /**
   * The kill-switch ROW read, from the database (Sol M1, PR #266 review
   * 5124774932).
   *
   * `queue.killSwitchEngaged` is the read-only delegate that #200 documents
   * as safe to patch because enforcement never dispatches through it — a
   * caller who lies to itself about a read harms only itself. That stops
   * being true the moment such a read becomes the authority a WRITE path
   * acts on: the locked orchestration cycle refuses or proceeds on this
   * answer. So the locked revalidation reads the `op_kill_switch` rows
   * through this `#private` closure (the `#capabilityFromStore` recipe)
   * and never through the patchable public delegate. The fast prechecks
   * may keep using the delegate — after the locked revalidation they are
   * an optimization, not the boundary.
   *
   * Sol M2 (same review cycle): `#observeOrchestration`'s per-spec
   * `specScopeKillSwitchEngaged` fact reads through this closure too —
   * `planOrchestration` turns that fact into `ready`, and `ready` creates
   * canonical work inside the locked apply cycle, so it is a write
   * authority, not a peek.
   */
  readonly #killSwitchEngagedFromStore: (capabilityId?: string) => boolean;

  /**
   * The same canonical `op_kill_switch` read over an ARBITRARY scope list
   * (Phase 8). The gateway honours four scope families at once — global, the
   * task's capability, `external_action`, `provider:<id>` and `adapter:<id>`
   * — and reads them through this closure, never through the patchable public
   * delegate. Returns the FIRST engaged scope so a refusal can name it.
   *
   * Phase 8 also migrated the load-bearing Low-7 call sites onto the
   * single-capability closure above: `approveTask` (an approval primed to
   * run the instant a switch releases), `claimNext` (a claim/dispatch
   * decision) and the `orchestrateMission` apply precheck. The one call site
   * deliberately LEFT on `queue.killSwitchEngaged` is `#missionExecutionState`,
   * which is a derived read projection (the Mission Room's picture) that
   * decides no write — a lie there misinforms the patcher's own display and
   * changes nothing that is enforced.
   */
  readonly #engagedKillSwitchScopeFromStore: (scopes: readonly string[]) => string | null;

  constructor(db: HqDatabase, options: HeadquarterOperationsOptions = {}) {
    this.#db = db;
    this.#engagedKillSwitchScopeFromStore = (scopes: readonly string[]): string | null => {
      const list = [...new Set(scopes)];
      if (list.length === 0) return null;
      const row = db
        .prepare(
          `SELECT scope FROM op_kill_switch WHERE engaged = 1 AND scope IN (${list
            .map(() => '?')
            .join(',')}) ORDER BY scope LIMIT 1`,
        )
        .get(...list) as { scope: string } | undefined;
      return row?.scope ?? null;
    };
    this.#killSwitchEngagedFromStore = (capabilityId?: string): boolean =>
      this.#engagedKillSwitchScopeFromStore([GLOBAL_SCOPE, ...(capabilityId ? [capabilityId] : [])]) !== null;
    // Adapters are validated at construction: a broken contract is a
    // composition error and must surface where the composition happened.
    const adapters = new Map<string, ExternalActionAdapter>();
    for (const adapter of options.actionAdapters ?? []) {
      const problems = adapterContractProblems(adapter);
      if (problems.length > 0) {
        throw new Error(
          `External-action adapter ${String(adapter?.id)} has an invalid contract: ${problems.join('; ')}. ` +
            'Nothing was constructed: an adapter that cannot state its own reversibility is not an adapter HQ will execute through.',
        );
      }
      if (adapters.has(adapter.id)) {
        throw new Error(`External-action adapter id ${adapter.id} is declared twice; adapter identity must be unique.`);
      }
      adapters.set(adapter.id, adapter);
    }
    this.#actionAdapters = adapters;
    this.#capabilityFromStore = (capabilityId: string): Capability | null => {
      const row = db.prepare(`SELECT * FROM op_capabilities WHERE id = ?`).get(capabilityId) as
        | Record<string, unknown>
        | undefined;
      if (!row) return null;
      return {
        id: row.id as string,
        description: row.description as string,
        riskClass: row.risk_class as Capability['riskClass'],
        sideEffect: !!row.side_effect,
        idempotent: !!row.idempotent,
        enabled: !!row.enabled,
      };
    };
    ensureApplicationSchema(db);
    ensureMissionCommandSchema(db);
    ensureProjectCommandSchema(db);
    ensureMemoryTables(db);
    ensureOrchestratorSchema(db);
    ensureTruthSchema(db);
    ensureActionGatewaySchema(db);
    ensureCollaborationSchema(db);
    ensureBriefSchema(db);
    // A writable construction just ensured the mission/project/memory tables.
    // A READ-ONLY one (the hq:snapshot path) may be observing an older file
    // that has some or none of them — the ensures above deliberately write
    // nothing through a read-only handle — so record what is actually there
    // and let every read answer truthfully instead of throwing at the first
    // prepare.
    this.#missionStorePresent = db.readonly ? missionSchemaPresent(db) : true;
    this.#projectStorePresent = db.readonly ? projectCommandSchemaPresent(db) : true;
    this.#memoryStorePresent = db.readonly ? memorySchemaPresent(db) : true;
    this.#truthStorePresent = db.readonly ? truthSchemaPresent(db) : true;
    this.#actionStorePresent = db.readonly ? actionGatewaySchemaPresent(db) : true;
    this.#collaborationStorePresent = db.readonly ? collaborationSchemaPresent(db) : true;
    this.#briefStorePresent = db.readonly ? briefSchemaPresent(db) : true;
    this.#aiMemberRegistry = options.aiMemberRegistry ?? null;
    this.#store = options.store ?? new HeadquarterStore(db);
    // Company memory (Phase 5, issue #265): the issue-#120 store, finally
    // wired. Constructed ONLY when the schema exists (a read-only pre-Phase-5
    // file has no table and the reads answer empty/null truthfully). The
    // onEvent hook lands memory audit entries in hq_events via the store —
    // live for the first time.
    this.#memory = this.#memoryStorePresent
      ? new MemoryStore(db, (e) => this.#store.appendEvent(e))
      : null;
    // The approval mutations are handed to whoever CONSTRUCTS the queue and to
    // nobody else, so they are unreachable from a queue handle a worker holds.
    // When a queue is supplied (tests, composition), no grant arrives and this
    // service simply has no approval mutation available — which is correct: it
    // did not construct that queue and cannot vouch for it.
    let granted: PrivilegedQueueApi | undefined;
    this.queue =
      options.queue ??
      new OperatorQueue(
        db,
        freezePolicyContext(options.policyCtx),
        (api) => {
          granted = api;
        },
        // Lazily evaluated: `#workers` is composed below, and a claim can only
        // happen after this constructor returns.
        (workerId) => this.#grantOf(workerId),
      );
    this.#queuePrivileged = granted;
    // The WRITE side of the worker → provider map lives here and nowhere else
    // (issue #200, Codex round-3 P1 #1). It is private: the only ways in are
    // `declareWorkerProvider`/`revokeWorkerProvider`, which resolve the actor
    // and require approval authority first.
    this.#workerProviderRegistrar = new WorkerProviderRegistrar(db);
    this.#workers =
      options.workers ?? narrowByRegistry(new SpecialistDirectoryAdapter(this.#store), options.memberRegistry);
    this.#principals = options.humanPrincipals ?? new HumanPrincipalRegistry(db);
    this.#nominationSources = options.nominationSources ?? [];
    // Defensive, frozen copy. The caller's object (and the `Set` inside it)
    // stayed reachable through `ops.policyContext`, so a worker could add a
    // standing pre-approval for an `external_side_effect` capability and skip
    // the Founder gate at enqueue, claim and start alike.
    this.#policyCtx = freezePolicyContext(options.policyCtx);
    // Statements PREPARED and their `get` BOUND here, once, so the call path
    // at enforcement time is a direct closure invocation with no property
    // lookup on any prototype.
    //
    // My previous comment here read "prototype-free by construction: `db.prepare`
    // is the only dispatch" — naming the remaining dispatch in the same sentence
    // that called it prototype-free. `db.prepare` resolves on
    // `Database.prototype` and the returned statement's `.get` on
    // `Statement.prototype`, both mutable and both third-party. A same-realm
    // caller could patch `prepare` to intercept just the principals query,
    // return a forged approval-authority row, and delegate everything else to
    // the original (issue #200, Codex exact-head finding on `6dde073`).
    //
    // LIMIT, stated rather than implied: this narrows the window, it does not
    // close it. An attacker who executes BEFORE this constructor — a plugin
    // imported earlier — can still patch what these lines capture. In a
    // same-realm threat model there is no in-process fix for that; the boundary
    // that actually holds is a separate process or realm. See the PR discussion.
    const principalGet = bindGet(db, `SELECT * FROM hq_human_principals WHERE id = ?`);
    const grantGet = bindGet(db, `SELECT allowed_capabilities FROM hq_specialists WHERE id = ?`);
    const specialistGet = bindGet(db, `SELECT 1 FROM hq_specialists WHERE id = ?`);
    this.#principalOf = options.humanPrincipals
      ? (id: string) => this.#principals.get(id)
      : (id: string) => {
          const row = principalGet(id) as Record<string, unknown> | undefined;
          if (!row) return null;
          return {
            id: row.id as string,
            displayName: row.display_name as string,
            originateCapabilities: JSON.parse(row.originate_capabilities as string) as string[],
            approvalAuthority: !!row.approval_authority,
            active: !!row.active,
          };
        };
    this.#grantOf =
      options.workers || options.memberRegistry
        ? (workerId: string) => this.#workers.allowedCapabilities(workerId)
        : (workerId: string) => {
            const row = grantGet(workerId) as { allowed_capabilities: string } | undefined;
            if (!row) return [];
            try {
              const parsed: unknown = JSON.parse(row.allowed_capabilities);
              return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
            } catch {
              return [];
            }
          };
    this.#isRegisteredWorker = options.workers
      ? (workerId: string) => this.#workers.isRegistered(workerId)
      : (workerId: string) => specialistGet(workerId) !== undefined;
    this.directory = {
      listSpecialists: () => this.#store.listSpecialists(),
      latestStatusPerSubject: () => this.#store.latestStatusPerSubject(),
      getSpecialist: (workerId: string) => this.#store.getSpecialist(workerId),
    };

    this.workers = {
      allowedCapabilities: (workerId: string) => this.#workers.allowedCapabilities(workerId),
      isRegistered: (workerId: string) => this.#workers.isRegistered(workerId),
      assignability: (workerId: string) => this.#workers.assignability(workerId),
    };

    // LAST in the constructor, deliberately. The grant is a closure over `this`
    // and the caller may use it the moment it is handed over, so every field it
    // dereferences — the queue, the principal and worker lookups — is already
    // initialised. (A `#private` field read before initialisation throws; the
    // queue's own grant is handed out early for the mirror-image reason, after
    // `#evidence` and before nothing else it touches.)
    options.grantDispatchEvidence?.(
      issueDispatchEvidenceGrant(this, (entry) => this.#appendDispatchOutcome(entry)),
    );
  }

  /** Standing pre-approval set the policy engine is evaluated against. */
  get policyContext(): PolicyContext {
    // A fresh copy per read: handing out the enforcement object let a caller
    // mutate the policy every gate is evaluated against.
    return freezePolicyContext(this.#policyCtx);
  }

  /** Every engaged kill-switch scope, for the console's alarm section. */
  killSwitchScopes(): {
    scope: string;
    reason: string | null;
    engagedBy: string | null;
    engagedAt: string | null;
  }[] {
    return this.#db
      .prepare(
        `SELECT scope, reason, engaged_by AS engagedBy, engaged_at AS engagedAt
         FROM op_kill_switch WHERE engaged = 1 ORDER BY scope`,
      )
      .all() as {
      scope: string;
      reason: string | null;
      engagedBy: string | null;
      engagedAt: string | null;
    }[];
  }

  // ---- classify ----

  /** Explain a capability's gates. Registry-derived; payload-blind. */
  classify(capabilityId: string): OpsResult<TaskClassification> {
    const cap = this.queue.capabilities.get(capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${capabilityId}`);
    return ok(classifyCapability(cap, this.#policyCtx));
  }

  // ---- create ----

  /**
   * Create a task on behalf of a worker OR a human principal.
   *
   * Either way the capability allow-list is read from a registry — the
   * specialist directory for a worker, `originateCapabilities` for a human —
   * and never accepted from the caller. Deny by default: an id in neither
   * registry can open nothing, and a human's origination grant confers no
   * execution right whatsoever (see `claimNext`/`startTask`).
   */
  createTask(input: CreateTaskInput): OpsResult<CreatedTask> {
    if (!input.capabilityId || !input.requestedBy) {
      return fail('invalid_input', 'capabilityId and requestedBy are required');
    }
    const cap = this.queue.capabilities.get(input.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${input.capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${cap.id} is disabled`);

    const requester = this.#resolveRequester(input.requestedBy, 'create_task');
    if (!requester.ok) return requester;

    const result = this.#requirePrivilegedQueue().enqueue({
      capabilityId: input.capabilityId,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      requestedBy: {
        workerId: input.requestedBy,
        // Authority: the registry, not the caller.
        allowedCapabilities: [...requester.data.allowedCapabilities],
      },
    });
    if (!result.accepted) {
      return fail('enqueue_rejected', result.reason, { capabilityId: input.capabilityId });
    }
    if (!result.deduplicated) {
      this.#upsertMeta(result.task.id, { project: input.project, title: input.title });
    }
    return ok({
      task: result.task,
      classification: classifyCapability(cap, this.#policyCtx),
      deduplicated: result.deduplicated,
    });
  }

  // ---- route / nominate ----

  /**
   * Ask every nomination source who could do this task, then let the Operator
   * decide. Nominations are advisory: `eligible` is computed ONLY from the
   * capability registry and the directory allow-list, so a source that
   * nominates an unauthorized, unknown, or disabled worker changes nothing.
   */
  routeTask(taskId: string): OpsResult<TaskRouting> {
    const task = this.queue.get(taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${taskId}`);
    const cap = this.queue.capabilities.get(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);

    const merged = new Map<string, { sources: string[]; rationales: string[] }>();
    for (const source of this.#nominationSources) {
      let nominations: readonly { workerId: string; rationale?: string }[] = [];
      try {
        nominations = source.nominate({
          taskId: task.id,
          capabilityId: task.capabilityId,
          riskClass: cap.riskClass,
          sideEffect: cap.sideEffect,
        });
      } catch {
        // A misbehaving nomination source must never break routing; it simply
        // nominates nobody. Recorded, then ignored.
        this.#requirePrivilegedQueue().appendEvidence({
          taskId: task.id,
          actor: 'system',
          kind: 'nomination_source_failed',
          payload: { source: source.id },
        });
        continue;
      }
      for (const nomination of nominations) {
        const entry = merged.get(nomination.workerId) ?? { sources: [], rationales: [] };
        entry.sources.push(source.id);
        if (nomination.rationale) entry.rationales.push(nomination.rationale);
        merged.set(nomination.workerId, entry);
      }
    }

    const nominations: EvaluatedNomination[] = [...merged.entries()]
      .map(([workerId, entry]) => {
        const assignability = this.#workers.assignability(workerId);
        const operatorDecision = evaluatePolicy(
          cap,
          { workerId, allowedCapabilities: [...this.#workers.allowedCapabilities(workerId)] },
          this.#policyCtx,
        );
        return {
          workerId,
          nominatedBy: entry.sources,
          rationales: entry.rationales,
          assignability,
          operatorDecision,
          eligible: assignability.assignable && operatorDecision.outcome !== 'deny',
        };
      })
      .sort((a, b) => a.workerId.localeCompare(b.workerId));

    this.#requirePrivilegedQueue().appendEvidence({
      taskId: task.id,
      actor: 'system',
      kind: 'routing_evaluated',
      payload: {
        capabilityId: task.capabilityId,
        nominated: nominations.map((n) => ({
          workerId: n.workerId,
          nominatedBy: n.nominatedBy,
          eligible: n.eligible,
          operatorOutcome: n.operatorDecision.outcome,
        })),
      },
    });

    return ok({
      taskId: task.id,
      capabilityId: task.capabilityId,
      classification: classifyCapability(cap, this.#policyCtx),
      nominations,
    });
  }

  /**
   * Record an ADVISORY assignment intent: "this task is meant for that
   * worker". It changes no canonical status and grants nothing — the worker
   * still has to claim the task through the atomic fenced claim path, and is
   * still subject to policy, approval and review.
   *
   * Its one operational effect is a NARROWING one: `claimNext()` refuses to
   * hand the head-of-queue task to a different worker (see that method for the
   * benign race it can lose).
   *
   * Because that is its ONLY effect, the intent is refused whenever the
   * effect is impossible — a live fenced claim already exists, or the task
   * can never return to the queue. See `assignmentBarrier` for the exact
   * canonical predicate (Sol M1 on PR #263).
   */
  assignTask(
    taskId: string,
    workerId: string,
    assignedBy: string,
    rationale?: string,
  ): OpsResult<AssignmentIntent> {
    const task = this.queue.get(taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${taskId}`);
    const cap = this.queue.capabilities.get(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);

    // The actor RECORDING the intent must be someone: this writes an
    // actor-attributed annotation event and evidence entry.
    const actor = this.#resolveActor(assignedBy, 'record an assignment intent');
    if (!actor.ok) return actor;

    // Canonical task/claim truth, checked AFTER the actor gate so record
    // state (claimant, lease) is only disclosed to a resolved identity.
    const barrier = assignmentBarrier(task);
    if (barrier) return { ok: false, error: barrier };

    const assignability = this.#workers.assignability(workerId);
    if (!assignability.assignable) {
      return this.#rejectNotAssignable(workerId, assignability, 'assign_task');
    }
    const decision = evaluatePolicy(
      cap,
      { workerId, allowedCapabilities: [...this.#workers.allowedCapabilities(workerId)] },
      this.#policyCtx,
    );
    if (decision.outcome === 'deny') {
      return fail('not_permitted', decision.reason, { workerId, capabilityId: cap.id });
    }

    const at = nowIso();
    this.#upsertMeta(taskId, {
      assignedWorkerId: workerId,
      assignedBy,
      assignedAt: at,
      assignmentRationale: rationale ?? null,
    });
    // Annotation only (status null): history records the routing decision
    // without pretending the task changed state.
    this.#store.appendEvent({
      subjectKind: 'task',
      subjectId: taskId,
      status: null,
      actor: assignedBy,
      summary: `Assignment intent recorded for ${workerId}`,
      detail: { workerId, advisory: true, rationale: rationale ?? null },
    });
    this.#requirePrivilegedQueue().appendEvidence({
      taskId,
      actor: assignedBy,
      kind: 'assignment_intent_recorded',
      payload: { workerId, rationale: rationale ?? null },
    });
    return ok({ taskId, workerId, assignedBy, assignedAt: at, rationale: rationale ?? null });
  }

  // ---- Founder Approval Center ----

  /**
   * Approve the exact action the console displayed.
   *
   * `expectedActionDigest` is the whole point: the Approval Center renders a
   * digest, the Founder clicks approve, and the digest travels back. A payload
   * or capability mutated in between produces a different digest and the
   * approval is refused BEFORE any approval row exists — the Founder cannot
   * approve something other than what they read. The queue then binds its own
   * approval record to that same digest, so the guarantee also survives any
   * mutation after this call.
   */
  approveTask(input: ApproveTaskInput): OpsResult<OperatorTask> {
    const task = this.queue.get(input.taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${input.taskId}`);
    const principal = this.#assertApprovalAuthority(input.founderId, 'approve');
    if (principal) return principal;
    if (task.status !== 'needs_approval') {
      return fail(
        'task_not_awaiting_approval',
        `Task ${task.id} is not awaiting approval (status: ${task.status})`,
        { status: task.status },
      );
    }
    const cap = this.queue.capabilities.get(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${cap.id} is disabled`);
    // Enforcement-safe read (Phase 8, the carried-forward Low 7): this answer
    // decides whether an approval row is WRITTEN, so it may not come from the
    // patchable `queue.killSwitchEngaged` convenience delegate. A forged
    // delegate used to let an approval land while the switch was engaged —
    // approved work sitting primed to run the instant the switch released.
    if (this.#killSwitchEngagedFromStore(task.capabilityId)) {
      // Refuse rather than let approved work sit primed to run the instant the
      // switch is released.
      return fail('kill_switch_engaged', `Kill switch is engaged for ${task.capabilityId}`);
    }

    // Validate the note BEFORE any write (issue #200, Codex round 3 P1).
    //
    // This one has no backstop at all, which makes it worse than the denial
    // case rather than merely similar: `queue.approve`'s evidence payload
    // carries the approval id, digest and expiry — NOT the note — so the
    // evidence log's guard never sees it. A credential pasted into an approval
    // note is therefore written to `hq_approvals.decision_note` with nothing
    // objecting, and `renderFounderApprovals` publishes that column into
    // generated HTML. Silent persistence plus publication, with no error
    // anywhere.
    if (input.note !== undefined) {
      try {
        assertNoSecretLikeContent({ note: input.note });
      } catch {
        return fail(
          'invalid_input',
          'The approval note looks like it contains a credential. Approval notes are stored ' +
            'permanently and rendered in the Founder console, so nothing was approved.',
        );
      }
    }
    const currentDigest = taskActionDigest(task);
    if (!input.expectedActionDigest || input.expectedActionDigest !== currentDigest) {
      this.#requirePrivilegedQueue().appendEvidence({
        taskId: task.id,
        actor: input.founderId,
        kind: 'approval_refused_action_changed',
        payload: { expected: input.expectedActionDigest ?? null, current: currentDigest },
      });
      return fail(
        'action_digest_mismatch',
        `Task ${task.id}: the action changed since it was presented for approval; nothing was approved`,
        { expected: input.expectedActionDigest ?? null, current: currentDigest },
      );
    }

    try {
      return ok(
        this.#requirePrivilegedQueue().approve(task.id, input.founderId, { ttlMs: input.ttlMs, note: input.note }),
      );
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId: task.id });
    }
  }

  /** Founder denial. Blocks the task with an immutable, reasoned record. */
  denyTask(input: DenyTaskInput): OpsResult<OperatorTask> {
    const task = this.queue.get(input.taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${input.taskId}`);
    const principal = this.#assertApprovalAuthority(input.founderId, 'deny');
    if (principal) return principal;
    if (!input.reason) return fail('invalid_input', 'A denial requires a reason');
    // Validate the reason BEFORE anything is written, with the SAME guard the
    // evidence log applies at the end (issue #200, Codex round 2 P1).
    //
    // `queue.deny` transitions the task to `blocked`, writes `block_reason`
    // and inserts the `hq_approvals` row, and only then appends evidence — so
    // a reason the evidence log refuses used to throw AFTER those three writes
    // had committed. This method caught that late throw and reported
    // `operator_rejected`, which meant the caller was told the denial failed
    // while the task was in fact blocked and the offending text was persisted
    // in two tables. Checking here makes the refusal precede the first write.
    //
    // Deliberately the same function the log uses, not a stricter or looser
    // one: a different guard would reopen the gap from the other side, where
    // this check passes and the append still throws.
    try {
      assertNoSecretLikeContent({ reason: input.reason });
    } catch {
      return fail(
        'invalid_input',
        'The denial reason looks like it contains a credential. A reason is recorded in the ' +
          'append-only evidence log, so nothing was written.',
      );
    }
    const currentDigest = taskActionDigest(task);
    if (input.expectedActionDigest && input.expectedActionDigest !== currentDigest) {
      // A denial is never an authorization, so a stale digest does not block
      // it — but the divergence is recorded.
      this.#requirePrivilegedQueue().appendEvidence({
        taskId: task.id,
        actor: input.founderId,
        kind: 'denial_digest_divergence',
        payload: { expected: input.expectedActionDigest, current: currentDigest },
      });
    }
    try {
      return ok(this.#requirePrivilegedQueue().deny(task.id, input.reason, input.founderId));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId: task.id });
    }
  }

  // ---- claim / start / execute ----

  /**
   * Claim the next task for a capability.
   *
   * Preconditions added here, all strictly narrowing: the worker must be
   * assignable (a disabled or replaced worker gets no new work), the directory
   * must grant it the capability, the kill switch must be clear, and the
   * head-of-queue task must not carry an assignment intent for someone else.
   * The atomic fenced claim itself, and the approval consumption bound to it,
   * remain entirely `OperatorQueue.claim()`'s.
   *
   * Known benign race: the intent peek is not part of the claim's conditional
   * UPDATE, so an intent recorded in the microseconds between peek and claim
   * can be missed and another eligible worker may take the task. Assignment
   * intent is advisory routing, and every real authority — allow-list,
   * approval binding, fence, independent review — is unaffected.
   */
  claimNext(
    workerId: string,
    capabilityId: string,
    leaseMs?: number,
    onlyTaskId?: string,
  ): OpsResult<OperatorTask> {
    const cap = this.queue.capabilities.get(capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${capabilityId} is disabled`);

    const human = this.#rejectHumanExecution(workerId, 'claim work');
    if (human) return human;
    const assignability = this.#workers.assignability(workerId);
    if (!assignability.assignable) {
      return this.#rejectNotAssignable(workerId, assignability, 'claim');
    }
    if (!this.#grantOf(workerId).includes(capabilityId)) {
      return fail(
        'not_permitted',
        `Worker ${workerId} is not allowed capability ${capabilityId} (least privilege)`,
      );
    }
    // Enforcement-safe read (Phase 8, Low 7): a claim is an execution decision
    // and the typed `kill_switch_engaged` refusal is what the dispatch lane
    // reports. The canonical `OperatorQueue.claim` re-reads its own private
    // row check below regardless, so a forged delegate never produced a claim
    // — but it did turn "stopped" into "nothing_claimable", which misreports
    // an emergency stop as an empty queue.
    if (this.#killSwitchEngagedFromStore(capabilityId)) {
      return fail('kill_switch_engaged', `Kill switch is engaged for ${capabilityId}`);
    }

    // Peek at the task this worker would actually be offered — the oldest one
    // COMPATIBLE with its declared execution provider, not merely the oldest
    // one (issue #200, Codex round-3 P1 #2). Peeking at the raw head would put
    // the head-of-line block back in this layer: a CLAUDE-bound order sitting
    // in front would make every later CODEX-compatible task unreachable
    // through the assignment-intent check below.
    const peek = this.queue.selectClaimable(workerId, capabilityId, onlyTaskId);
    if (!peek.task && !peek.refusal) {
      return fail('nothing_claimable', `No queued task for ${capabilityId}`);
    }
    // A refusal (queued work exists, none of it this worker's) is deliberately
    // NOT answered here: it is raised and written to the evidence log once, by
    // the canonical boundary in `OperatorQueue.claim` below, and translated to
    // a typed error in the catch. Answering it here would record it twice or
    // not at all, depending on the caller.
    const head = peek.task;
    const intent = head ? this.readMeta(head.id)?.assignment : null;
    if (head && intent && intent.workerId !== workerId) {
      return fail(
        'assigned_to_other_worker',
        `Task ${head.id} is assigned to ${intent.workerId}`,
        { taskId: head.id, assignedTo: intent.workerId },
      );
    }
    // Provider binding (issue #200, Codex P1 #1) is deliberately NOT
    // re-implemented here. It is enforced once, at the canonical execution
    // boundary in `OperatorQueue.claim`, which is also where the refusal is
    // written to the evidence log — so it holds for callers that never come
    // through this layer, and it cannot be recorded twice or drift between two
    // copies. This layer only translates the violation into a typed error.
    let claimed: OperatorTask | null;
    try {
      claimed = this.queue.claim(workerId, capabilityId, leaseMs, onlyTaskId);
    } catch (error) {
      if (error instanceof ProviderBindingViolation) {
        return fail('provider_binding_mismatch', error.message, {
          taskId: error.taskId,
          requiredProvider: error.requiredProvider,
          workerProvider: error.workerProvider,
        });
      }
      return fail('operator_rejected', errorMessage(error), { capabilityId });
    }
    if (!claimed) return fail('nothing_claimable', `No claimable task for ${capabilityId}`);
    return ok(claimed);
  }

  /**
   * Start executing a claimed task. Assignability is re-checked here: a worker
   * disabled or replaced between claim and start must not begin execution.
   * The approval digest / time-box / claim-binding revalidation stays in
   * `OperatorQueue.start()`.
   */
  startTask(taskId: string, workerId: string, fence: number): OpsResult<OperatorTask> {
    const human = this.#rejectHumanExecution(workerId, 'start work');
    if (human) return human;
    const assignability = this.#workers.assignability(workerId);
    if (!assignability.assignable) {
      return this.#rejectNotAssignable(workerId, assignability, 'start', { taskId });
    }
    try {
      return ok(this.queue.start(taskId, workerId, fence));
    } catch (error) {
      if (error instanceof ProviderBindingViolation) {
        return fail('provider_binding_mismatch', error.message, {
          taskId: error.taskId,
          requiredProvider: error.requiredProvider,
          workerProvider: error.workerProvider,
        });
      }
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  heartbeat(taskId: string, workerId: string, fence: number, leaseMs?: number): OpsResult<null> {
    try {
      this.queue.heartbeat(taskId, workerId, fence, leaseMs);
      return ok(null);
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Submit an execution result. For a side-effect capability this can only
   * ever reach `reviewState: 'pending'` — the queue refuses to let the
   * executing worker self-complete, and only an independent reviewer moves it
   * to `completed`.
   *
   * Added precondition (narrowing): a result already awaiting review may not
   * be re-submitted. `OperatorQueue.complete()` releases the lease but leaves
   * `claimed_by`/`fence` intact, so a second call would still satisfy the
   * fence check and would overwrite the stored result while a reviewer is
   * looking at it. It could never self-complete the task — the review gate
   * holds either way — but the reviewer must decide on the evidence that was
   * actually submitted, so the second submission is refused here. Rework after
   * a failed review goes back through claim/start and gets a fresh fence.
   */
  submitResult(
    taskId: string,
    workerId: string,
    fence: number,
    result: Record<string, unknown>,
    evidenceRefs: string[] = [],
  ): OpsResult<OperatorTask> {
    const existing = this.queue.get(taskId);
    if (!existing) return fail('unknown_task', `Unknown task: ${taskId}`);
    if (existing.reviewState === 'pending') {
      return fail(
        'operator_rejected',
        `Task ${taskId} already has a result awaiting independent review; it cannot be re-submitted`,
        { submittedBy: existing.submittedBy },
      );
    }
    try {
      return ok(this.queue.complete(taskId, workerId, fence, result, evidenceRefs));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  failTask(taskId: string, workerId: string, fence: number, reason: string): OpsResult<OperatorTask> {
    try {
      return ok(this.queue.fail(taskId, workerId, fence, reason));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Independent review of a submitted result.
   *
   * The reviewer must BE someone: an assignable worker, or a registered active
   * human principal. (Approval authority is not required — reviewing a result
   * is not deciding a Founder approval.) Independence itself — never the
   * executing, submitting or requesting worker — is enforced by the queue.
   */
  reviewTask(
    taskId: string,
    reviewerId: string,
    verdict: 'pass' | 'fail',
    note = '',
  ): OpsResult<OperatorTask> {
    if (verdict === 'fail' && !note) {
      return fail('invalid_input', 'A failed review requires a reason');
    }
    const reviewer = this.#resolveActor(reviewerId, 'review');
    if (!reviewer.ok) return reviewer;
    try {
      return ok(
        verdict === 'pass'
          ? this.#requirePrivilegedQueue().reviewPass(taskId, reviewerId, note)
          : this.#requirePrivilegedQueue().reviewFail(taskId, reviewerId, note),
      );
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Resolve an `outcome_unknown` task after a human checked the real world.
   * The reconciler must be a known actor (same rule as review); independence
   * and the "never blindly re-queue a non-idempotent capability" rule are the
   * queue's.
   */
  reconcileTask(
    taskId: string,
    decision: ReconcileDecision,
    by: string,
    note: string,
  ): OpsResult<OperatorTask> {
    if (!note) return fail('invalid_input', 'Reconciliation requires a note');
    const reconciler = this.#resolveActor(by, 'reconcile');
    if (!reconciler.ok) return reconciler;
    try {
      return ok(this.#requirePrivilegedQueue().reconcile(taskId, decision, by, note));
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  /**
   * Return a task whose Founder approval no longer admits execution to
   * `needs_approval`, so a fresh Founder decision is possible (issue #226).
   *
   * ## The deadlock this exists to break
   *
   * A time-boxed approval moves a task to `queued`. If it expires there — the
   * Founder-workstation dispatch lane asks `claudeDispatchEligibility` before it
   * claims, so an expired approval refuses the dispatch and `claim()`, the only
   * caller of the boundary recovery, never runs — the task stays `queued`
   * forever. `approveTask` accepts `needs_approval` ONLY, so there was no
   * supported way to give that task a fresh approval: it was canonically
   * stranded, with a live order nobody could authorise or run.
   *
   * ## What it is not
   *
   * Not an approval, not an extension, and not a re-approval. It grants
   * nothing, decides nothing on a Founder's behalf, and is a NO-OP whenever the
   * approval still admits execution — so it cannot be used to strip a good one.
   * The fresh decision that follows is an ordinary `approveTask` call, subject
   * to every rule it already enforces: approval authority, the no-self-approval
   * rule, the action digest the Founder echoes back, a new single-use nonce and
   * a new time-box.
   *
   * The stale approval row is never touched: `hq_approvals` is immutable audit
   * evidence, and only the task's binding to it is cleared.
   *
   * Unauthenticated on purpose — it takes no actor, because it attributes
   * nothing to a human. It applies a consequence the canonical rules already
   * require, and the only thing it can produce is LESS authority than before.
   */
  returnForFreshApproval(taskId: string): OpsResult<{
    /** True when an approval was found dead and the consequence was applied. */
    returned: boolean;
    /** Which rejection was applied, or null when nothing needed applying. */
    rejection: ApprovalRejection | null;
    /** The task's status afterwards — `needs_approval`, or `blocked` if hostile. */
    status: ActivityStatus;
  }> {
    const task = this.queue.get(taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${taskId}`);
    try {
      const rejection = this.#requirePrivilegedQueue().returnForFreshApproval(taskId);
      const after = this.queue.get(taskId);
      return ok({
        returned: rejection !== null,
        rejection,
        status: after?.status ?? task.status,
      });
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { taskId });
    }
  }

  // ---- kill switch (Founder only) ----

  engageKillSwitch(scope: string, founderId: string, reason: string): OpsResult<null> {
    const principal = this.#assertApprovalAuthority(founderId, 'engage the kill switch');
    if (principal) return principal;
    this.#requirePrivilegedQueue().engageKillSwitch(scope, founderId, reason);
    return ok(null);
  }

  releaseKillSwitch(scope: string, founderId: string): OpsResult<null> {
    const principal = this.#assertApprovalAuthority(founderId, 'release the kill switch');
    if (principal) return principal;
    this.#requirePrivilegedQueue().releaseKillSwitch(scope, founderId);
    return ok(null);
  }

  // ---- execution-provider declarations (Founder only) ----

  /**
   * Declare which provider a worker genuinely executes as (issue #200, Codex
   * round-3 P1 #1).
   *
   * This is the ONLY authorized way the worker → provider map is written. It
   * sits here, beside the kill switch, because it is the same kind of act: a
   * configuration decision that changes who may execute what. It therefore
   * carries the same gate — a registered, active human principal holding
   * approval authority. Registered workers are refused that authority
   * outright (`principals.ts`), so no execution worker can declare a provider,
   * its own least of all: the queue it holds exposes lookup only.
   *
   * `declaredBy` is the RESOLVED principal, not a caller-supplied string, so
   * the recorded attribution cannot differ from the identity that was checked.
   * The declaration narrows only — it decides which bound tasks a worker may
   * take, never which capabilities it holds, which stay with the directory.
   */
  /**
   * The approval mutations, or a loud failure. A service built around a queue
   * it did not construct holds no grant, and must not silently behave as if an
   * approval had been recorded.
   */
  #requirePrivilegedQueue(): PrivilegedQueueApi {
    if (!this.#queuePrivileged) {
      throw new Error(
        'This HeadquarterOperations was constructed around an externally supplied queue, so it ' +
          'holds no approval-mutation grant. Approvals must go through a service that built its ' +
          'own queue.',
      );
    }
    return this.#queuePrivileged;
  }

  /**
   * May `actor` decide an ambiguous external outcome? Returns the refusal
   * reason, or null when they may (issue #219, ChatGPT blocking finding on
   * `173cd30`).
   *
   * Reconciling an `unknown` dispatch is the act of declaring whether a public
   * side effect happened. Getting it wrong in one direction publishes a second
   * GitHub issue for work already dispatched, so it is a decision about an
   * irreversible external act — the same class the Founder gate exists for, and
   * it was previously taken on an unauthenticated caller-supplied string.
   *
   * This deliberately introduces NO new identity mechanism. It is the same
   * boundary `approveTask`/`denyTask` already use: `'system'` is refused, a
   * registered worker is refused because worker identity never carries approval
   * authority, and the id must resolve to a principal holding it. A refusal is
   * audited, exactly as an approval refusal is.
   */
  reconciliationAuthorityRefusal(actor: string): string | null {
    const refusal = this.#assertApprovalAuthority(actor, 'reconcile an unknown dispatch outcome');
    if (!refusal || refusal.ok) return null;
    return refusal.error.message;
  }

  /**
   * Publishes the canonical capability read to `capabilityRowFor`, and to
   * nothing else (issue #219, Codex P1 on `2175fa2`).
   *
   * A `static {}` block is the only place outside an instance method that can
   * touch `#capabilityFromStore`, so the reader is handed to a MODULE-PRIVATE
   * `let` that no other module can name or reassign. Nothing is added to the
   * class, the prototype or any instance — which is the difference from the
   * public `capabilityRow(...)` method this replaces.
   *
   * That method was introduced in `173cd30` as the enforcement-safe
   * alternative to `queue.capabilities`, and was itself patchable because a
   * public method lives on the prototype: `ops.capabilityRow = () => reserved`
   * made `directOrderCapabilityState` answer `enabled` while `#enqueue`
   * classified the real weakened row — the exact Founder-gate bypass the
   * original fix existed to close, reached one layer up.
   */
  static {
    readCapabilityRow = (ops: HeadquarterOperations, capabilityId: string): Capability | null =>
      ops.#capabilityFromStore(capabilityId);
    readKillSwitchEngaged = (ops: HeadquarterOperations, capabilityId?: string): boolean =>
      ops.#killSwitchEngagedFromStore(capabilityId);
    readGatewayActionHistory = (ops: HeadquarterOperations, taskId: string): GatewayActionHistory =>
      ops.#gatewayActionHistoryFromStore(taskId);
    readTaskEvidenceRows = (ops: HeadquarterOperations, taskId: string): CanonicalEvidenceRow[] =>
      ops.#taskEvidenceRowsFromStore(taskId);
  }

  /**
   * Evidence appended by an in-process SYSTEM lane, under a reserved system
   * actor and nothing else (issue #219 integration of #200 with #223/#224).
   *
   * Issue #200 made the evidence writer privileged because "a holder can forge
   * entries under any actor whose hashes still pass `verifyChain`" — the risk is
   * ATTRIBUTION: an entry that appears to record a Founder approval or a
   * worker's act. The dispatch and ingest lanes (#221/#223/#224) need to record
   * what the SYSTEM did — a handoff published, a lease expired, a route
   * blocked — and every one of their appends already names a reserved actor,
   * never a human and never a worker.
   *
   * So the narrow surface is the actor, not the caller. `SYSTEM_EVIDENCE_ACTORS`
   * is closed, and the runtime check below refuses any name that resolves to a
   * registered human principal or worker — so this method cannot write the
   * entries #200 took away, even if a reserved name were later reused as a
   * principal id. It grants no approval, no capability and no execution right.
   *
   * NARROWED AGAIN for Option B (issue #219). Restricting the actor and closing
   * the kind set was still not enough for the kinds that DECIDE something: a
   * caller holding `ops` could write a terminal `claude_github_dispatch_failed`
   * here and flip an unresolved attempt to "nothing was published" without ever
   * passing the reconciliation-authority check. Those kinds are gone from this
   * surface entirely — see `DISPATCH_OUTCOME_EVIDENCE_KINDS` and
   * `#appendDispatchOutcome`. What is left here is what a system lane may say
   * without deciding anything: that it refused, and that a route was blocked.
   */
  appendSystemEvidence(entry: {
    taskId?: string | null;
    actor: SystemEvidenceActor;
    kind: SystemEvidenceKind;
    payload: Record<string, unknown>;
  }): EvidenceEntry {
    this.#assertSystemEvidenceActor(entry.actor);
    // Named separately from the generic "not a system evidence kind" refusal.
    // An outcome kind is not an unknown string — it is a real kind this surface
    // deliberately no longer carries — and a caller that reaches here holding
    // one is either the dispatch lane wired wrong (which should say where the
    // writer lives) or a caller trying to forge an outcome (which should be
    // told plainly that it cannot).
    if ((DISPATCH_OUTCOME_EVIDENCE_KINDS as readonly string[]).includes(entry.kind)) {
      throw new Error(
        `${String(entry.kind)} decides a dispatch outcome, so it is not writable through the ` +
          'generic system-evidence surface. Outcome facts are written only through the ' +
          'dispatch-only grant handed to whoever constructs this service ' +
          '(HeadquarterOperationsOptions.grantDispatchEvidence).',
      );
    }
    if (!SYSTEM_EVIDENCE_KINDS.includes(entry.kind)) {
      throw new Error(
        `${String(entry.kind)} is not a system evidence kind. The set is closed: a system lane ` +
          'records the events it owns, and cannot invent one.',
      );
    }
    return this.#requirePrivilegedQueue().appendEvidence(entry);
  }

  /**
   * The reserved-actor rule, shared by both evidence surfaces.
   *
   * `SYSTEM_EVIDENCE_ACTORS` is closed, and the runtime check refuses any name
   * that resolves to a registered human principal or worker — so neither
   * surface can write the attributed entries #200 took away, even if a reserved
   * name were later reused as a principal id.
   */
  #assertSystemEvidenceActor(actor: SystemEvidenceActor): void {
    if (!SYSTEM_EVIDENCE_ACTORS.includes(actor)) {
      throw new Error(
        `${String(actor)} is not a reserved system evidence actor. System lanes record only ` +
          'under their own reserved names; attributed evidence goes through the privileged queue.',
      );
    }
    if (this.#principalOf(actor) || this.#isRegisteredWorker(actor)) {
      throw new Error(
        `${actor} resolves to a registered principal or worker, so a system lane may not ` +
          'append under it. Evidence attributed to a person or a worker is privileged.',
      );
    }
  }

  /**
   * The write behind `DispatchEvidenceGrant`. Reachable ONLY through the grant
   * object handed out at construction — it is a `#private` method, so it is not
   * a property of `ops` and cannot be reached by name, index or reflection from
   * a caller holding one.
   *
   * Every rule the generic surface applied still applies here; this method adds
   * the outcome-kind allowlist and keeps the claim binding. What it does NOT do
   * is decide reconciliation authority: that is `resolveUnknownDispatch`'s
   * check, and it stays there because it is a question about WHO decided, which
   * this layer cannot see.
   */
  #appendDispatchOutcome(entry: {
    taskId?: string | null;
    actor: SystemEvidenceActor;
    kind: DispatchOutcomeEvidenceKind;
    payload: Record<string, unknown>;
  }): EvidenceEntry {
    this.#assertSystemEvidenceActor(entry.actor);
    if (!(DISPATCH_OUTCOME_EVIDENCE_KINDS as readonly string[]).includes(entry.kind)) {
      throw new Error(
        `${String(entry.kind)} is not a dispatch outcome kind. The grant is narrow on purpose: it ` +
          'writes the outcome facts the dispatch and ingest lanes own, and nothing else.',
      );
    }
    // A claim of publication needs the claim it happened under.
    if ((CLAIM_BOUND_EVIDENCE_KINDS as readonly string[]).includes(entry.kind)) {
      const task = entry.taskId ? this.queue.get(entry.taskId) : null;
      if (!task) {
        throw new Error(
          `${entry.kind} names no task that exists. A record of a publication is written against ` +
            'the canonical task it published.',
        );
      }
      if (!task.claimedBy) {
        throw new Error(
          `${entry.kind} may only be recorded while the task is claimed. Nothing holds an ` +
            `execution claim on ${task.id}, so no publication can have happened under one — a ` +
            'record written now would report work nobody did.',
        );
      }
    }
    return this.#requirePrivilegedQueue().appendEvidence(entry);
  }

  /**
   * Run `fn` in one IMMEDIATE write transaction. Atomicity, not authority: it
   * writes nothing itself, and every gate inside `fn` still applies. Public
   * because a read-then-append decision (#221's "has this already been
   * dispatched?") is only correct when the two halves are indivisible.
   */
  reserveEvidence<T>(fn: () => T): T {
    return this.#requirePrivilegedQueue().reserve(fn);
  }

  declareWorkerProvider(input: {
    workerId: string;
    providerId: string;
    founderId: string;
  }): OpsResult<WorkerProviderRecord> {
    const principal = this.#assertApprovalAuthority(
      input.founderId,
      'declare a worker execution provider',
    );
    if (principal) return principal;
    try {
      // The mapping write and its evidence commit together or not at all
      // (issue #224, Codex P1 on `9fd1f1c`). They used to be two statements: if
      // the append failed — another process holding the SQLite write lock, a
      // full disk — the provider mapping stayed CHANGED while this method
      // caught the error and told the caller the declaration had failed. That
      // is the worst shape for this particular write: an execution-authority
      // change live in the database, with no record of who made it, and an
      // operator who believes it did not happen.
      //
      // `reserve` is an IMMEDIATE write transaction, so a throwing append rolls
      // the declaration back with it. The refusal the caller then sees is true.
      //
      // Both halves run through the PRIVILEGED handle and the `#private`
      // registrar (issue #200): the atomicity above is layered onto that
      // hardening, not substituted for it.
      const privileged = this.#requirePrivilegedQueue();
      const record = privileged.reserve(() => {
        const declared = this.#workerProviderRegistrar.declare(
          input.workerId,
          input.providerId,
          input.founderId,
        );
        privileged.appendEvidence({
          actor: input.founderId,
          kind: 'worker_provider_declared',
          payload: {
            workerId: declared.workerId,
            providerId: declared.providerId,
            declaredAt: declared.declaredAt,
          },
        });
        return declared;
      });
      return ok(record);
    } catch (error) {
      if (error instanceof ProviderDeclarationRejected) {
        return fail(
          error.reason === 'unknown_provider' ? 'unknown_provider' : 'invalid_input',
          error.message,
          { workerId: input.workerId, providerId: input.providerId },
        );
      }
      return fail('operator_rejected', errorMessage(error), { workerId: input.workerId });
    }
  }

  // ---- worker registration (Founder only) ----

  /**
   * Register an external execution worker (issue #224, ChatGPT P1 on `83e146b`).
   *
   * The Claude handoff requires a named, registered, CLAUDE-declared worker
   * before it will publish anything — and until now nothing canonical could
   * CREATE one. `upsertSpecialist` lives on the store, reachable only by code
   * holding the raw database, and the tests built their executor by calling it
   * directly. So the documented Founder-gated boundary ("registering this worker
   * is an explicit configuration act") had no implementation on the one machine
   * that dispatches: the real answer was "drop to the data layer", which is not
   * a gate at all.
   *
   * This is that act, and it is deliberately narrow:
   *
   * - **Founder-gated**, the same check as `declareWorkerProvider` and the kill
   *   switch: a registered, active human principal holding approval authority.
   *   Workers are refused that authority outright, so no execution worker can
   *   register a worker — itself included.
   * - **Create-only.** An existing id is REFUSED rather than overwritten.
   *   `upsertSpecialist` replaces the whole row, so allowing re-registration
   *   here would make a capability allow-list — an authority — silently
   *   editable through a "bootstrap" command. Changing or retiring a worker
   *   stays with the paths that own those decisions (handover, deactivation).
   * - **Deny-by-default on capabilities.** Every requested capability must
   *   already exist in the registry; a typo grants nothing and is refused
   *   loudly rather than registering a worker that can claim nothing.
   * - **Atomic**, for the same reason the declaration is: a registration whose
   *   evidence cannot be written must not survive as an unrecorded grant.
   *
   * It grants no provider identity. Registration and declaration stay two
   * separate acts, so neither one alone makes a worker able to take
   * CLAUDE-bound work.
   */
  registerExecutionWorker(input: {
    workerId: string;
    displayName: string;
    vendor: string;
    role: WorkerRole;
    allowedCapabilities: readonly string[];
    founderId: string;
  }): OpsResult<WorkerDescriptor> {
    const principal = this.#assertApprovalAuthority(input.founderId, 'register an execution worker');
    if (principal) return principal;

    const workerId = input.workerId.trim();
    if (!workerId) return fail('invalid_input', 'A worker id is required.');
    // Worker identity and HUMAN identity are separate registries, and an id in
    // both is the one combination neither registry can express safely. It is
    // refused here because both consequences are silent and neither is
    // recoverable through this command:
    //
    //   - `rejectHumanExecution` waves an id through the moment it is a
    //     registered WORKER, so the human principal becomes executable;
    //   - `assertApprovalAuthority` refuses any registered worker, so that
    //     human INSTANTLY loses approval authority — an approver locked out of
    //     the kill switch and every approval, by a registration that reported
    //     success.
    //
    // Registration is create-only and there is no revoke path, so undoing it
    // would mean dropping to the data layer: exactly the boundary this method
    // exists to remove.
    if (this.#principals.get(workerId) != null) {
      return fail(
        'not_permitted',
        `${workerId} is already registered as a HUMAN principal. Worker identity and human ` +
          'identity are deliberately separate: an id in both would be a human that may execute, ' +
          'and would silently strip that human of approval authority. Choose a distinct worker id.',
        { workerId },
      );
    }
    if (this.#store.getSpecialist(workerId)) {
      return fail(
        'invalid_input',
        `Worker ${workerId} is already registered. Registration is create-only: it will not ` +
          'overwrite an existing worker, because that would silently rewrite its capability ' +
          'allow-list.',
        { workerId },
      );
    }
    if (input.allowedCapabilities.length === 0) {
      return fail(
        'invalid_input',
        'A worker registered with no capabilities could claim nothing. Name the capabilities it ' +
          'is allowed, explicitly.',
        { workerId },
      );
    }
    const unknown = input.allowedCapabilities.filter((id) => this.queue.capabilities.get(id) == null);
    if (unknown.length > 0) {
      return fail(
        'unknown_capability',
        `Unknown capabilit${unknown.length === 1 ? 'y' : 'ies'}: ${unknown.join(', ')}. A worker is ` +
          'never granted a capability the registry does not define.',
        { workerId, unknown },
      );
    }

    const descriptor: WorkerDescriptor = {
      id: workerId,
      displayName: input.displayName.trim() || workerId,
      vendor: input.vendor.trim(),
      role: input.role,
      allowedCapabilities: [...input.allowedCapabilities],
      active: true,
    };
    try {
      const privileged = this.#requirePrivilegedQueue();
      return ok(
        privileged.reserve(() => {
          this.#store.upsertSpecialist(descriptor);
          privileged.appendEvidence({
            actor: input.founderId,
            kind: 'execution_worker_registered',
            payload: {
              workerId: descriptor.id,
              vendor: descriptor.vendor,
              role: descriptor.role,
              allowedCapabilities: descriptor.allowedCapabilities,
            },
          });
          return descriptor;
        }),
      );
    } catch (error) {
      return fail('operator_rejected', errorMessage(error), { workerId });
    }
  }

  /**
   * Withdraw a worker's execution-provider declaration. Same authority as
   * declaring one, and strictly narrowing in effect: the worker can then claim
   * no provider-bound task at all.
   */
  revokeWorkerProvider(input: { workerId: string; founderId: string }): OpsResult<boolean> {
    const principal = this.#assertApprovalAuthority(
      input.founderId,
      'revoke a worker execution provider',
    );
    if (principal) return principal;
    const removed = this.#workerProviderRegistrar.revoke(input.workerId);
    if (removed) {
      this.#requirePrivilegedQueue().appendEvidence({
        actor: input.founderId,
        kind: 'worker_provider_revoked',
        payload: { workerId: input.workerId },
      });
    }
    return ok(removed);
  }

  /** Every declaration currently in force. A read, available to any caller. */
  workerProviderDeclarations(): WorkerProviderRecord[] {
    return this.queue.listWorkerProviders();
  }

  // ---- worker replacement ----

  /**
   * What blocks removing a worker right now. Lane F does not own the worker
   * lifecycle (that is lane D / the specialist directory) — it reports the
   * Operator-side truth that lifecycle must respect: a worker holding
   * in-flight claims needs a handover, and one holding an `outcome_unknown`
   * task needs reconciliation, before it can be safely replaced.
   */
  replacementPlan(workerId: string): OpsResult<ReplacementPlan> {
    const rows = this.#db
      .prepare(
        `SELECT id, status, capability_id FROM op_tasks
         WHERE claimed_by = ? AND status IN ('assigned', 'running', 'outcome_unknown')
         ORDER BY created_at`,
      )
      .all(workerId) as { id: string; status: ActivityStatus; capability_id: string }[];
    const blockers: ReplacementBlocker[] = rows.map((row) => ({
      taskId: row.id,
      status: row.status,
      capabilityId: row.capability_id,
      requires: row.status === 'outcome_unknown' ? 'reconciliation' : 'handover',
    }));
    return ok({ workerId, safe: blockers.length === 0, blockers });
  }

  /** Convenience guard for a caller about to disable/replace a worker. */
  assertReplacementSafe(workerId: string): OpsResult<ReplacementPlan> {
    const plan = this.replacementPlan(workerId);
    if (!plan.ok) return plan;
    if (!plan.data.safe) {
      return fail(
        'replacement_blocked',
        `Worker ${workerId} still holds ${plan.data.blockers.length} in-flight task(s); handover/reconciliation required first`,
        { blockers: plan.data.blockers },
      );
    }
    return plan;
  }

  // ---- dynamic AI workforce (Phase 4 — issue #262) ----

  /**
   * Deactivate an execution worker. Founder-gated and strictly NARROWING:
   * the worker keeps its row and its history, loses assignability, and there
   * is deliberately NO reactivate method — turning a worker back on would be
   * a widening, and stays a separate recorded act (re-registration is
   * create-only and will refuse the id, so reactivation today means a
   * deliberate configuration change, not an API call).
   *
   * In-flight work is protected: `assertReplacementSafe` refuses while the
   * worker holds assigned/running/outcome_unknown tasks, so deactivation can
   * never orphan a claim.
   */
  deactivateExecutionWorker(input: {
    workerId: string;
    reason: string;
    founderId: string;
  }): OpsResult<WorkerDescriptor> {
    const refused = this.#assertApprovalAuthority(input.founderId, 'deactivate an execution worker');
    if (refused) return refused;
    const reason = missionText('reason', input.reason, MAX_ASSIGNMENT_RATIONALE_LENGTH, true);
    if (!reason.ok) return fail('invalid_input', reason.message);
    try {
      assertNoSecretLikeContent({ reason: reason.value });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }
    const specialist = this.#store.getSpecialist(input.workerId);
    if (!specialist) {
      return fail('invalid_input', `Unknown worker: ${input.workerId}`, {
        workerId: input.workerId,
      });
    }
    if (!specialist.active) {
      return fail('invalid_input', `Worker ${input.workerId} is already inactive`, {
        workerId: input.workerId,
      });
    }
    const safe = this.assertReplacementSafe(input.workerId);
    if (!safe.ok) return safe;
    const deactivated: WorkerDescriptor = { ...specialist, active: false };
    const privileged = this.#requirePrivilegedQueue();
    return ok(
      privileged.reserve(() => {
        this.#store.upsertSpecialist(deactivated);
        privileged.appendEvidence({
          actor: input.founderId,
          kind: 'execution_worker_deactivated',
          payload: { workerId: deactivated.id, reason: reason.value },
        });
        return deactivated;
      }),
    );
  }

  /**
   * Record an ADVISORY assignment intent from the Founder surface.
   *
   * The browser-facing wrapper around `assignTask`: same advisory semantics
   * (no status change, narrowing-only at claim), gated by the
   * `hq.workforce_assign` trio instead of bare actor resolution, and the
   * rationale is bounded and secret-scanned BEFORE the first write — the
   * underlying method writes its meta row before its evidence append, so a
   * scan there would refuse after a partial commit.
   */
  assignTaskAsFounder(input: {
    taskId: string;
    workerId: string;
    founderId: string;
    rationale?: string;
  }): OpsResult<AssignmentIntent> {
    if (!input.taskId || !input.workerId) {
      return fail('invalid_input', 'taskId and workerId are required');
    }
    const rationale = missionText(
      'rationale',
      input.rationale,
      MAX_ASSIGNMENT_RATIONALE_LENGTH,
      false,
    );
    if (!rationale.ok) return fail('invalid_input', rationale.message);
    if (rationale.value) {
      try {
        assertNoSecretLikeContent({ rationale: rationale.value });
      } catch (error) {
        return fail('invalid_input', errorMessage(error));
      }
    }
    const refusedActor = this.#resolveFounderGateActor(
      input.founderId,
      `assign task ${input.taskId}`,
      WORKFORCE_ASSIGN_CAPABILITY.id,
      'assigning workforce',
    );
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#founderGateCapabilityGate(
      'assign a task to a worker',
      WORKFORCE_ASSIGN_CAPABILITY.id,
      workforceAssignCapabilityState,
      workforceAssignContractDrift,
      'assigning workforce',
    );
    if (refusedCapability) return refusedCapability;
    return this.assignTask(input.taskId, input.workerId, input.founderId, rationale.value ?? undefined);
  }

  /**
   * Which registered workers could take this task, and why not — the
   * eligible-worker calculation. A READ over enforcement-safe truth plus one
   * `routeTask` evaluation (which records its `routing_evaluated` evidence),
   * merged per worker. Deliberately absent: transport/connectivity truth —
   * the facade holds no secrets environment, so "is the executor wired up"
   * belongs to the control-api layer, which composes it in from
   * `providerConnectivity` where that truth actually lives.
   */
  evaluateTaskEligibility(taskId: string): OpsResult<TaskEligibilityReport> {
    const routed = this.routeTask(taskId);
    if (!routed.ok) return routed;
    const task = this.queue.get(taskId)!;
    const cap = this.queue.capabilities.get(task.capabilityId)!;
    const declaredProviders = new Map(
      this.queue.listWorkerProviders().map((d) => [d.workerId, d.providerId] as const),
    );
    const nominationByWorker = new Map(routed.data.nominations.map((n) => [n.workerId, n] as const));
    const workers: WorkerEligibility[] = this.#store
      .listSpecialists()
      .map((specialist) => {
        const granted = this.#grantOf(specialist.id);
        const assignability = this.#workers.assignability(specialist.id);
        const decision = evaluatePolicy(
          cap,
          { workerId: specialist.id, allowedCapabilities: [...granted] },
          this.#policyCtx,
        );
        const nomination = nominationByWorker.get(specialist.id);
        const holdsCapability = granted.includes(task.capabilityId);
        return {
          workerId: specialist.id,
          displayName: specialist.displayName,
          role: specialist.role,
          holdsCapability,
          assignability,
          operatorOutcome: decision.outcome,
          denyReason: decision.outcome === 'deny' ? decision.reason : null,
          providerDeclared: declaredProviders.get(specialist.id) ?? null,
          nominatedBy: nomination?.nominatedBy ?? [],
          rationales: nomination?.rationales ?? [],
          eligible: holdsCapability && assignability.assignable && decision.outcome !== 'deny',
        };
      })
      .sort((a, b) => a.workerId.localeCompare(b.workerId));
    // The same predicate assignTask refuses with — read and write truth
    // cannot drift (Sol M1 on PR #263).
    const barrier = assignmentBarrier(task);
    return ok({
      taskId,
      capabilityId: task.capabilityId,
      classification: routed.data.classification,
      taskState: {
        status: task.status,
        claimedBy: task.claimedBy,
        assignmentOpen: barrier === null,
        reason: barrier?.message ?? null,
      },
      workers,
    });
  }

  /**
   * Register an AI member — the rich provider/model/capability record behind
   * the workforce display and advisory nomination. Founder-gated (approval
   * authority, the same bar as registering an execution worker).
   *
   * NOT an execution enrolment: a member row grants nothing and is never
   * consulted by enforcement. When the id matches a registered execution
   * worker the result says `enrichesExecutionWorker: true` — the same
   * identity described in both layers. An id registered as a HUMAN principal
   * is refused outright: the narrowing directory's `isRegistered` ORs the
   * member registry in, and a member row under a human's id would flip that
   * human into "worker identity" and silently strip their approval
   * authority.
   */
  registerAiMember(
    input: RegisterMemberInput & { founderId: string },
  ): OpsResult<{ member: AiMember; warnings: string[]; enrichesExecutionWorker: boolean }> {
    const refused = this.#assertApprovalAuthority(input.founderId, 'register an AI member');
    if (refused) return refused;
    const registry = this.#aiMemberRegistry;
    if (!registry) {
      return fail(
        'workforce_registry_unconfigured',
        'No AI member registry is configured on this deployment. Wiring one is a composition-root act, not something registration performs.',
      );
    }
    const memberId = input.id?.trim();
    if (!memberId) return fail('invalid_input', 'A member id is required.');
    if (this.#principals.get(memberId) != null) {
      return fail(
        'not_permitted',
        `${memberId} is registered as a HUMAN principal. A member row under that id would make ` +
          'the id read as worker identity and silently strip the human of approval authority. ' +
          'Choose a distinct member id.',
        { memberId },
      );
    }
    const enrichesExecutionWorker = this.#store.getSpecialist(memberId) != null;
    try {
      const privileged = this.#requirePrivilegedQueue();
      return ok(
        privileged.reserve(() => {
          const result = registry.register({ ...input, id: memberId }, input.founderId);
          privileged.appendEvidence({
            actor: input.founderId,
            kind: 'ai_member_registered',
            payload: {
              memberId,
              identityKey: result.member.identityKey,
              workerType: result.member.workerType,
              grantedCapabilities: result.member.grantedCapabilities,
              enrichesExecutionWorker,
            },
          });
          return { member: result.member, warnings: result.warnings, enrichesExecutionWorker };
        }),
      );
    } catch (error) {
      return fail('invalid_input', errorMessage(error), { memberId });
    }
  }

  /** Disable an AI member (Founder-gated; display/advisory layer only). */
  disableAiMember(input: {
    memberId: string;
    reason: string;
    founderId: string;
  }): OpsResult<{ member: AiMember; handoverRequired: MemberAssignment[] }> {
    const refused = this.#assertApprovalAuthority(input.founderId, 'disable an AI member');
    if (refused) return refused;
    const registry = this.#aiMemberRegistry;
    if (!registry) {
      return fail(
        'workforce_registry_unconfigured',
        'No AI member registry is configured on this deployment.',
      );
    }
    const reason = missionText('reason', input.reason, MAX_ASSIGNMENT_RATIONALE_LENGTH, true);
    if (!reason.ok) return fail('invalid_input', reason.message);
    try {
      const privileged = this.#requirePrivilegedQueue();
      return ok(
        privileged.reserve(() => {
          const result = registry.disable(input.memberId, reason.value!, input.founderId);
          privileged.appendEvidence({
            actor: input.founderId,
            kind: 'ai_member_disabled',
            payload: {
              memberId: input.memberId,
              reason: reason.value,
              handoverRequired: result.handoverRequired.map((a) => a.id),
            },
          });
          return result;
        }),
      );
    } catch (error) {
      return fail('invalid_input', errorMessage(error), { memberId: input.memberId });
    }
  }

  /**
   * Declare an AI member's health. An explicit Founder statement, never a
   * probe: HQ asked nothing, so HQ records what the Founder observed, with
   * the timestamp of the declaration.
   */
  setAiMemberHealth(input: {
    memberId: string;
    health: string;
    founderId: string;
  }): OpsResult<AiMember> {
    const refused = this.#assertApprovalAuthority(input.founderId, "declare an AI member's health");
    if (refused) return refused;
    const registry = this.#aiMemberRegistry;
    if (!registry) {
      return fail(
        'workforce_registry_unconfigured',
        'No AI member registry is configured on this deployment.',
      );
    }
    if (!(MEMBER_HEALTHS as readonly string[]).includes(input.health)) {
      return fail('invalid_input', `Unknown member health: ${input.health}`);
    }
    try {
      const privileged = this.#requirePrivilegedQueue();
      return ok(
        privileged.reserve(() => {
          const member = registry.setHealth(
            input.memberId,
            input.health as MemberHealth,
            input.founderId,
          );
          privileged.appendEvidence({
            actor: input.founderId,
            kind: 'ai_member_health_declared',
            payload: { memberId: input.memberId, health: input.health },
          });
          return member;
        }),
      );
    } catch (error) {
      return fail('invalid_input', errorMessage(error), { memberId: input.memberId });
    }
  }

  /**
   * The member roster, or the truthful statement that none is configured.
   * A read, available to any caller — member rows grant nothing.
   */
  listAiMembers(): { configured: boolean; members: AiMember[] } {
    if (!this.#aiMemberRegistry) return { configured: false, members: [] };
    return { configured: true, members: this.#aiMemberRegistry.list() };
  }

  // ---- group-room mission intake ----

  /**
   * Post a group-room message. Storage only. This never creates a task, never
   * touches an approval, and never grants anything, whatever the text says.
   *
   * The AUTHOR must still be a resolvable identity. A message is inert, so a
   * forged author escalates nothing — but attribution in the group room is
   * exactly what a human reads before deciding to promote a mission, so an
   * unknown id must not be able to publish under a trusted-looking name.
   */
  postMissionMessage(input: {
    threadId: string;
    author: string;
    body: string;
    refs?: string[];
  }): OpsResult<{ messageId: string; containsActionLanguage: boolean }> {
    if (!input.threadId || !input.author) {
      return fail('invalid_input', 'threadId and author are required');
    }
    const actor = this.#resolveActor(input.author, 'post to a group room');
    if (!actor.ok) return actor;
    const message = this.#store.postMessage(input);
    return ok({
      messageId: message.id,
      // Advisory decoration for human readers only.
      containsActionLanguage: detectActionLanguage(input.body),
    });
  }

  /**
   * Raise an INERT proposal from a group-room discussion. Still no task, no
   * approval, no grant — a row a human can read and act on. The capability is
   * chosen through this typed argument, never parsed from message text.
   */
  proposeMission(input: {
    threadId: string;
    capabilityId: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    proposedBy: string;
    sourceMessageId?: string;
  }): OpsResult<MissionProposal> {
    if (!input.threadId || !input.capabilityId || !input.proposedBy) {
      return fail('invalid_input', 'threadId, capabilityId and proposedBy are required');
    }
    // Inert, but it enters the evidence chain under this actor's name.
    const actor = this.#resolveActor(input.proposedBy, 'raise a mission proposal');
    if (!actor.ok) return actor;
    try {
      assertNoSecretLikeContent(input.payload);
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }
    const cap = this.queue.capabilities.get(input.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${input.capabilityId}`);

    const id = uuid();
    const at = nowIso();
    const idempotencyKey = input.idempotencyKey ?? null;
    const digest = missionProposalDigest({
      threadId: input.threadId,
      capabilityId: input.capabilityId,
      payload: input.payload,
      idempotencyKey,
    });
    this.#db
      .prepare(
        `INSERT INTO hq_mission_proposals
           (id, thread_id, source_message_id, capability_id, payload, idempotency_key, digest,
            proposed_by, proposed_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed')`,
      )
      .run(
        id,
        input.threadId,
        input.sourceMessageId ?? null,
        input.capabilityId,
        JSON.stringify(input.payload),
        idempotencyKey,
        digest,
        input.proposedBy,
        at,
      );
    this.#requirePrivilegedQueue().appendEvidence({
      actor: input.proposedBy,
      kind: 'mission_proposed',
      payload: {
        proposalId: id,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        digest,
        executable: false,
      },
    });
    return ok(this.getProposal(id)!);
  }

  /**
   * Turn a proposal into a real Operator task.
   *
   * This is the ONLY bridge from chat to work, and it is authorized entirely
   * on the Operator side: `promotedBy` must be an assignable worker that the
   * DIRECTORY already grants the capability to. Neither the message author,
   * nor the proposer, nor the message text has any say. The created task is an
   * ordinary task — a Founder-gated capability still lands in `needs_approval`
   * exactly as if it had been created any other way.
   */
  promoteProposal(input: {
    proposalId: string;
    promotedBy: string;
    expectedDigest?: string;
    project?: string;
    title?: string;
  }): OpsResult<CreatedTask> {
    const proposal = this.getProposal(input.proposalId);
    if (!proposal) return fail('proposal_not_found', `Unknown proposal: ${input.proposalId}`);
    if (proposal.status !== 'proposed') {
      return fail('proposal_not_open', `Proposal ${proposal.id} is already ${proposal.status}`, {
        status: proposal.status,
      });
    }
    if (input.expectedDigest && input.expectedDigest !== proposal.digest) {
      return fail(
        'proposal_digest_mismatch',
        `Proposal ${proposal.id} does not match the digest presented`,
        { expected: input.expectedDigest, current: proposal.digest },
      );
    }

    const created = this.createTask({
      capabilityId: proposal.capabilityId,
      payload: proposal.payload,
      idempotencyKey: proposal.idempotencyKey ?? undefined,
      requestedBy: input.promotedBy,
      project: input.project,
      title: input.title,
    });
    if (!created.ok) return created;

    this.#db
      .prepare(
        `UPDATE hq_mission_proposals
         SET status = 'promoted', task_id = ?, decided_by = ?, decided_at = ?
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(created.data.task.id, input.promotedBy, nowIso(), proposal.id);
    this.#upsertMeta(created.data.task.id, { sourceProposalId: proposal.id });
    this.#requirePrivilegedQueue().appendEvidence({
      taskId: created.data.task.id,
      actor: input.promotedBy,
      kind: 'mission_promoted_to_task',
      payload: {
        proposalId: proposal.id,
        threadId: proposal.threadId,
        sourceMessageId: proposal.sourceMessageId,
        capabilityId: proposal.capabilityId,
      },
    });
    return created;
  }

  /**
   * Close an open proposal without promoting it.
   *
   * Rejection is a one-way state change on a shared record, attributed to the
   * deciding actor in both the proposal row and the hash-chained evidence log,
   * so `by` must resolve to a known worker or active human principal (Jules
   * review of `ff105a2`). An unknown or deactivated identity could otherwise
   * close other people's proposals and write a false name into the evidence
   * trail.
   */
  rejectProposal(proposalId: string, by: string, note: string): OpsResult<MissionProposal> {
    const proposal = this.getProposal(proposalId);
    if (!proposal) return fail('proposal_not_found', `Unknown proposal: ${proposalId}`);
    if (proposal.status !== 'proposed') {
      return fail('proposal_not_open', `Proposal ${proposalId} is already ${proposal.status}`);
    }
    if (!note) return fail('invalid_input', 'Rejecting a proposal requires a note');
    const actor = this.#resolveActor(by, 'reject a mission proposal');
    if (!actor.ok) return actor;
    this.#db
      .prepare(
        `UPDATE hq_mission_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?
         WHERE id = ? AND status = 'proposed'`,
      )
      .run(by, nowIso(), note, proposalId);
    this.#requirePrivilegedQueue().appendEvidence({
      actor: by,
      kind: 'mission_proposal_rejected',
      payload: { proposalId, note },
    });
    return ok(this.getProposal(proposalId)!);
  }

  getProposal(id: string): MissionProposal | null {
    const row = this.#db.prepare(`SELECT * FROM hq_mission_proposals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      sourceMessageId: (row.source_message_id as string | null) ?? null,
      capabilityId: row.capability_id as string,
      payload: JSON.parse(row.payload as string),
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      digest: row.digest as string,
      proposedBy: row.proposed_by as string,
      proposedAt: row.proposed_at as string,
      status: row.status as MissionProposalStatus,
      taskId: (row.task_id as string | null) ?? null,
      decidedBy: (row.decided_by as string | null) ?? null,
      decidedAt: (row.decided_at as string | null) ?? null,
      decisionNote: (row.decision_note as string | null) ?? null,
    };
  }

  listProposals(status?: MissionProposalStatus): MissionProposal[] {
    const rows = (
      status
        ? this.#db
            .prepare(`SELECT id FROM hq_mission_proposals WHERE status = ? ORDER BY proposed_at`)
            .all(status)
        : this.#db.prepare(`SELECT id FROM hq_mission_proposals ORDER BY proposed_at`).all()
    ) as { id: string }[];
    return rows.map((r) => this.getProposal(r.id)!);
  }

  // ---- missions (Phase 3 — Founder Command + Mission Core, issue #254) ----

  /**
   * Command a canonical Mission from a Founder order.
   *
   * A mission is a durable planning record ABOVE tasks. Commanding one
   * executes nothing: no task is created, no approval is touched, no worker
   * is dispatched, and no later-phase orchestration is implied. The act is
   * Founder-only — the requester must resolve to an active HUMAN principal
   * holding the `hq.mission_command` originate grant (workers are refused
   * outright), and the capability row must match its reserved contract
   * (fail closed on missing/altered/disabled; commanding never registers or
   * repairs — the direct-order CONFIGURATION-vs-INVOCATION rule).
   *
   * Transactional and idempotent: the derived digest key dedupes an
   * identical re-command onto the existing mission with no second intent,
   * plan, event or evidence row.
   *
   * The optional free-text `instruction` is the raw order. It is preserved
   * in the intent body (seq 0, immutable, append-only history) and stays
   * SERVER-SIDE ONLY — the browser sees the intake-scanned canonical fields.
   *
   * No text is ever parsed into capabilities, tasks or providers. The plan
   * is exactly what the Founder supplied; when nothing was supplied, the one
   * honest plan item is a needs-clarification record, never an invented
   * breakdown.
   */
  commandMission(input: {
    title: string;
    objective: string;
    scope?: string;
    constraints?: string[];
    acceptanceCriteria?: string[];
    planItems?: string[];
    /**
     * Object-form plan (Phase 6, issue #265) — mutually exclusive with the
     * legacy `planItems` strings. A plan entry MAY carry a Founder work spec
     * (capabilityId + payload, both or neither): the explicit structured
     * statement that lets the orchestrator turn the item into a real gated
     * task. No spec = truthfully not actionable; nothing is ever parsed out
     * of the summary text.
     */
    plan?: { summary: string; capabilityId?: string; payload?: Record<string, unknown> }[];
    /** Free-text console LABEL — never authority, never matched to the register. */
    project?: string;
    /** Canonical register id (Phase 4). Validated: must exist and be active. */
    projectId?: string;
    priority?: string;
    dependsOn?: string[];
    sourceOrderTaskId?: string;
    /** Raw order text. SERVER-SIDE ONLY — lives in the intent body. */
    instruction?: string;
    /** Resolved principal id. Set by the boundary, never read from a body. */
    requestedBy: string;
    /** Client dedupe hint — an INPUT to the derived key, never the key. */
    idempotencyKey?: string;
  }): OpsResult<{ mission: MissionRecord; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const title = missionText('title', input.title, MAX_MISSION_TITLE_LENGTH, true);
    if (!title.ok) return fail('invalid_input', title.message);
    const objective = missionText('objective', input.objective, MAX_MISSION_OBJECTIVE_LENGTH, true);
    if (!objective.ok) return fail('invalid_input', objective.message);
    const scope = missionText('scope', input.scope, MAX_MISSION_SCOPE_LENGTH, false);
    if (!scope.ok) return fail('invalid_input', scope.message);
    const project = missionText('project', input.project, MAX_MISSION_PROJECT_LENGTH, false);
    if (!project.ok) return fail('invalid_input', project.message);
    const instruction = missionText(
      'instruction',
      input.instruction,
      MAX_MISSION_INSTRUCTION_LENGTH,
      false,
    );
    if (!instruction.ok) return fail('invalid_input', instruction.message);
    const constraints = missionList('constraints', input.constraints);
    if (!constraints.ok) return fail('invalid_input', constraints.message);
    const acceptance = missionList('acceptanceCriteria', input.acceptanceCriteria);
    if (!acceptance.ok) return fail('invalid_input', acceptance.message);
    // One plan, one shape: the legacy summary strings OR the object form with
    // optional specs — both at once would be two competing plans.
    if (input.plan !== undefined && input.planItems !== undefined) {
      return fail('invalid_input', 'Supply plan OR planItems, not both');
    }
    const planItems = missionList(
      'planItems',
      input.plan !== undefined ? input.plan.map((entry) => entry?.summary as string) : input.planItems,
    );
    if (!planItems.ok) return fail('invalid_input', planItems.message);
    // Per-entry specs, aligned with the summaries by index. capabilityId and
    // payload travel together or not at all.
    const planSpecs: (NormalizedWorkSpec | null)[] = [];
    if (input.plan !== undefined) {
      for (const [i, entry] of input.plan.entries()) {
        const hasCapability = entry?.capabilityId !== undefined;
        const hasPayload = entry?.payload !== undefined;
        if (!hasCapability && !hasPayload) {
          planSpecs.push(null);
          continue;
        }
        if (hasCapability !== hasPayload) {
          return fail('invalid_input', `plan[${i}]: a spec needs BOTH capabilityId and payload`);
        }
        const spec = normalizeWorkSpec(`plan[${i}]`, entry.capabilityId, entry.payload);
        if (!spec.ok) return fail('invalid_input', spec.message);
        planSpecs.push(spec.value);
      }
    }
    let priority: MissionPriority | null = null;
    if (input.priority != null && input.priority !== '') {
      if (!isMissionPriority(input.priority)) {
        return fail('invalid_input', `Unknown mission priority: ${input.priority}`);
      }
      priority = input.priority;
    }
    const refusedCommander = this.#resolveMissionCommander(input.requestedBy, 'command a mission');
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#missionCapabilityGate('command a mission');
    if (refusedCapability) return refusedCapability;

    // Existence probes run AFTER the authority gates — the order the other
    // three mission methods already use — so a caller without the mission
    // grant gets the same refusal for a real and an imaginary id and learns
    // nothing about which missions or tasks exist (Opus second-pass finding
    // on `cee771f`: this method was the sole outlier).
    const dependsOn = [...new Set((input.dependsOn ?? []).map((d) => d.trim()).filter(Boolean))];
    if (dependsOn.length > MAX_MISSION_LIST_ITEMS) {
      return fail('invalid_input', `dependsOn exceeds ${MAX_MISSION_LIST_ITEMS} entries`);
    }
    for (const dep of dependsOn) {
      if (!this.#db.prepare(`SELECT 1 FROM hq_missions WHERE id = ?`).get(dep)) {
        return fail('invalid_input', `dependsOn names an unknown mission: ${dep}`);
      }
    }
    const sourceOrderTaskId = input.sourceOrderTaskId?.trim() || null;
    if (
      sourceOrderTaskId &&
      !this.#db.prepare(`SELECT 1 FROM op_tasks WHERE id = ?`).get(sourceOrderTaskId)
    ) {
      return fail('invalid_input', `sourceOrderTaskId names an unknown task: ${sourceOrderTaskId}`);
    }
    // The project-active check moved INSIDE the transaction below: the
    // project register is the one read here that can go stale (missions and
    // tasks are append-only, so the dependsOn/sourceOrderTaskId existence
    // checks above cannot regress outside it).
    const projectId = input.projectId?.trim() || null;

    // Everything that will be PERSISTED is scanned before anything is
    // written — a credential-looking order is refused, never stored. Spec
    // payloads are Founder input headed for storage, so they are scanned on
    // exactly the same terms.
    try {
      assertNoSecretLikeContent({
        title: title.value,
        objective: objective.value,
        scope: scope.value,
        project: project.value,
        instruction: instruction.value,
        constraints: constraints.value,
        acceptanceCriteria: acceptance.value,
        planItems: planItems.value,
        planSpecs: planSpecs.map((spec) => spec?.payload ?? null),
      });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    // Specs join the digest ONLY when at least one is stated (the projectId
    // back-compat rule): stored Phase 3/4 keys keep deduping byte-identical
    // spec-less re-commands.
    const statedSpecs = planSpecs
      .map((spec, i) => (spec ? { seq: i + 1, capabilityId: spec.capabilityId, payload: spec.payload } : null))
      .filter((spec): spec is { seq: number; capabilityId: string; payload: string } => spec != null);
    const idempotencyKey = missionCommandIdempotencyKey({
      requestedBy: input.requestedBy,
      title: title.value!,
      objective: objective.value!,
      scope: scope.value,
      constraints: constraints.value ?? [],
      acceptanceCriteria: acceptance.value,
      project: project.value,
      projectId,
      priority,
      sourceOrderTaskId,
      dependsOn,
      planItems: planItems.value ?? [],
      instruction: instruction.value,
      idempotencyKey: input.idempotencyKey ?? null,
      planItemSpecs: statedSpecs,
    });

    const id = `mission-${uuid()}`;
    const at = nowIso();
    const body = canonicalJson({
      kind: 'founder_order',
      title: title.value,
      objective: objective.value,
      scope: scope.value,
      constraints: constraints.value ?? [],
      acceptanceCriteria: acceptance.value,
      planItems: planItems.value ?? [],
      project: project.value,
      projectId,
      priority,
      dependsOn,
      sourceOrderTaskId,
      instruction: instruction.value,
      requestedBy: input.requestedBy,
      clientIdempotencyKey: input.idempotencyKey ?? null,
      // Full specs live in the SERVER-SIDE intent body (the raw-order rule),
      // so the append-only history explains every spec verbatim.
      planItemSpecs: statedSpecs,
      at,
    });
    const items =
      planItems.value && planItems.value.length > 0
        ? planItems.value.map((summary, i) => ({
            summary,
            kind: 'work' as const,
            seq: i + 1,
            spec: planSpecs[i] ?? null,
          }))
        : [
            {
              summary: MISSION_PLAN_NOT_DECIDED_SUMMARY,
              kind: 'needs_clarification' as const,
              seq: 1,
              spec: null,
            },
          ];

    // The dedupe read, the mission write, its event and its evidence commit
    // inside ONE IMMEDIATE transaction (the declareWorkerProvider precedent,
    // issue #224): the privileged handle is resolved BEFORE anything is
    // written — a service holding no grant refuses with zero rows, not after
    // a committed mission — a failing evidence append rolls the mission back
    // with it, and the read-then-insert dedupe decision cannot race a
    // concurrent writer past the UNIQUE idempotency key.
    const privileged = this.#requirePrivilegedQueue();
    let dedupedTo: string | null = null;
    let refusal: OpsResult<never> | null = null;
    privileged.reserve(() => {
      // Project state is read inside the write lock so a concurrent close
      // cannot land between the check and the INSERT (Opus Low on PR #263).
      // Checked BEFORE the dedupe read, deliberately: a replayed command
      // into a since-closed project refuses exactly as a fresh one does.
      if (projectId) {
        const target = this.#projectRecord(projectId);
        if (!target) {
          refusal = fail('unknown_project', `Unknown project: ${projectId}`);
          return;
        }
        if (target.status === 'closed') {
          refusal = fail(
            'project_closed',
            `Project ${projectId} is closed; reopen it before assigning missions to it`,
          );
          return;
        }
      }
      const existing = findMissionIdByIdempotencyKey(this.#db, idempotencyKey);
      if (existing) {
        dedupedTo = existing;
        return;
      }
      this.#db
        .prepare(
          `INSERT INTO hq_missions
             (id, title, objective, scope, constraints, acceptance_criteria, project, project_id, priority,
              status, depends_on, source_order_task_id, idempotency_key,
              created_by, created_at, updated_at, status_changed_at, status_changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          title.value,
          objective.value,
          scope.value,
          JSON.stringify(constraints.value ?? []),
          acceptance.value == null ? null : JSON.stringify(acceptance.value),
          project.value,
          projectId,
          priority,
          JSON.stringify(dependsOn),
          sourceOrderTaskId,
          idempotencyKey,
          input.requestedBy,
          at,
          at,
          at,
          input.requestedBy,
        );
      appendMissionIntent(this.#db, {
        missionId: id,
        seq: 0,
        kind: 'founder_order',
        body,
        objective: objective.value!,
        constraints: constraints.value ?? [],
        acceptanceCriteria: acceptance.value,
        actor: input.requestedBy,
        at,
      });
      for (const item of items) {
        insertMissionPlanItem(this.#db, {
          missionId: id,
          seq: item.seq,
          summary: item.summary,
          kind: item.kind,
          createdInIntentSeq: 0,
          specCapabilityId: item.spec?.capabilityId ?? null,
          specPayload: item.spec?.payload ?? null,
        });
      }
      appendMissionEvent(this.#db, {
        missionId: id,
        actor: input.requestedBy,
        kind: 'commanded',
        toStatus: 'planned',
        detail: { planItemCount: items.length },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'mission_commanded',
        payload: { missionId: id, idempotencyKey, planItemCount: items.length, executable: false },
      });
    });
    if (refusal) return refusal;
    if (dedupedTo) {
      return ok({ mission: this.#missionRecord(dedupedTo)!, deduplicated: true });
    }
    return ok({ mission: this.#missionRecord(id)!, deduplicated: false });
  }

  getMission(id: string): MissionRecord | null {
    if (!id) return null;
    return this.#missionRecord(id);
  }

  listMissions(status?: MissionStatus): MissionRecord[] {
    if (!this.#missionStorePresent) return [];
    return listMissionIds(this.#db, status).map((id) => this.#missionRecord(id)!);
  }

  /**
   * Whether this database carries the Phase 3 mission tables. False only for
   * a read-only handle over a pre-Phase-3 file; mission reads then answer
   * empty/null and the snapshot's missions provenance states the absence.
   */
  missionStorePresent(): boolean {
    return this.#missionStorePresent;
  }

  /**
   * Full intent history INCLUDING bodies (raw order + amendment rationale).
   * SERVER-SIDE ONLY: no route response or snapshot may carry these bodies —
   * the browser gets the structured per-sequence history that rides on
   * `MissionRecord.intentHistory` (audit spine + objective/constraints/
   * acceptance criteria), never the raw text.
   */
  getMissionIntentHistory(missionId: string): MissionIntentEntry[] {
    if (!this.#missionStorePresent) return [];
    return readMissionIntentEntries(this.#db, missionId);
  }

  /**
   * Move a mission through its lifecycle. Founder-driven in Phase 3 — every
   * transition is an actor-checked act by a principal holding the mission
   * grant, structurally bounded by `MISSION_ALLOWED_TRANSITIONS`.
   *
   * `verified` additionally requires approval AUTHORITY (the decision-class
   * check used by approvals and the kill switch) and a mandatory note: with
   * no evidence engine in Phase 3, verification IS the recorded Founder
   * decision, and it is displayed as exactly that. It grants and executes
   * nothing, and never touches `hq_approvals`.
   */
  transitionMission(input: {
    missionId: string;
    to: string;
    note?: string;
    /** Optimistic guard: refuse if the mission moved since it was read. */
    expectedStatus?: string;
    requestedBy: string;
  }): OpsResult<MissionRecord> {
    if (!input.missionId || !input.requestedBy) {
      return fail('invalid_input', 'missionId and requestedBy are required');
    }
    if (!isMissionStatus(input.to)) {
      return fail('invalid_input', `Unknown mission status: ${input.to}`);
    }
    if (input.expectedStatus != null && !isMissionStatus(input.expectedStatus)) {
      return fail('invalid_input', `Unknown mission status: ${input.expectedStatus}`);
    }
    const noteField = missionText('note', input.note, MAX_MISSION_NOTE_LENGTH, false);
    if (!noteField.ok) return fail('invalid_input', noteField.message);
    const note = noteField.value;

    const refusedCommander = this.#resolveMissionCommander(
      input.requestedBy,
      `move mission ${input.missionId} to ${input.to}`,
    );
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#missionCapabilityGate('transition a mission');
    if (refusedCapability) return refusedCapability;

    const current = this.#missionRecord(input.missionId);
    if (!current) return fail('unknown_mission', `Unknown mission: ${input.missionId}`);
    if (input.expectedStatus && current.status !== input.expectedStatus) {
      return fail(
        'mission_status_changed',
        `Mission ${input.missionId} is ${current.status}, not ${input.expectedStatus}`,
        { status: current.status },
      );
    }
    if (current.status === input.to) {
      // A replayed transition is refused rather than re-applied: appending a
      // second identical event would forge history.
      return fail('mission_status_changed', `Mission ${input.missionId} is already ${input.to}`, {
        status: current.status,
      });
    }
    if (!canTransitionMission(current.status, input.to)) {
      return fail(
        'invalid_mission_transition',
        `Illegal mission transition: ${current.status} -> ${input.to}`,
        { from: current.status, to: input.to, allowed: [...MISSION_ALLOWED_TRANSITIONS[current.status]] },
      );
    }
    if (MISSION_NOTE_REQUIRED_TARGETS.includes(input.to) && !note) {
      return fail('invalid_input', `Moving a mission to ${input.to} requires a note`);
    }
    if (note) {
      try {
        assertNoSecretLikeContent({ note });
      } catch (error) {
        return fail('invalid_input', errorMessage(error));
      }
    }
    if (input.to === 'verified') {
      const refusedAuthority = this.#assertApprovalAuthority(
        input.requestedBy,
        `verify mission ${input.missionId}`,
      );
      if (refusedAuthority) return refusedAuthority;
    }

    const at = nowIso();
    let raced = false;
    // The guarded UPDATE, its event and its evidence commit inside ONE
    // IMMEDIATE transaction (the declareWorkerProvider precedent, issue
    // #224): the privileged handle is resolved before anything is written,
    // and a failing evidence append rolls the transition back instead of
    // leaving a moved mission with no evidence row.
    const privileged = this.#requirePrivilegedQueue();
    privileged.reserve(() => {
      const blockReason = input.to === 'blocked' ? note : null;
      const result =
        input.to === 'verified'
          ? this.#db
              .prepare(
                `UPDATE hq_missions
                 SET status = ?, block_reason = ?, updated_at = ?, status_changed_at = ?, status_changed_by = ?,
                     verified_by = ?, verified_at = ?, verified_note = ?, verification_method = 'founder_decision'
                 WHERE id = ? AND status = ?`,
              )
              .run(
                input.to,
                blockReason,
                at,
                at,
                input.requestedBy,
                input.requestedBy,
                at,
                note,
                input.missionId,
                current.status,
              )
          : this.#db
              .prepare(
                `UPDATE hq_missions
                 SET status = ?, block_reason = ?, updated_at = ?, status_changed_at = ?, status_changed_by = ?
                 WHERE id = ? AND status = ?`,
              )
              .run(input.to, blockReason, at, at, input.requestedBy, input.missionId, current.status);
      if (result.changes === 0) {
        raced = true;
        return;
      }
      appendMissionEvent(this.#db, {
        missionId: input.missionId,
        actor: input.requestedBy,
        kind: 'transitioned',
        fromStatus: current.status,
        toStatus: input.to as MissionStatus,
        note,
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'mission_transitioned',
        payload: { missionId: input.missionId, from: current.status, to: input.to, executable: false },
      });
    });
    if (raced) {
      return fail(
        'mission_status_changed',
        `Mission ${input.missionId} changed status while the transition was being decided`,
        {},
      );
    }
    return ok(this.#missionRecord(input.missionId)!);
  }

  /**
   * Amend a mission's intent. APPEND-ONLY: the original Founder order (seq 0)
   * is never rewritten; each amendment appends the full rationale body and
   * the canonical state AFTER it, and supersedes plan items rather than
   * deleting them. Terminal missions cannot be amended — their record is
   * closed history.
   */
  amendMissionIntent(input: {
    missionId: string;
    /** Required rationale. SERVER-SIDE ONLY — lives in the intent body. */
    amendment: string;
    objective?: string;
    constraints?: string[];
    acceptanceCriteria?: string[];
    addPlanItems?: string[];
    /** Object-form additions (Phase 6) — mutually exclusive with addPlanItems. */
    addPlan?: { summary: string; capabilityId?: string; payload?: Record<string, unknown> }[];
    /**
     * State the Founder work spec on an EXISTING unlinked, unsuperseded work
     * item (Phase 6). Write-once — the engine holds that — so changing a
     * stated spec means superseding the item and adding a new one, which
     * this same amendment path already offers.
     */
    specifyPlanItems?: { seq: number; capabilityId: string; payload: Record<string, unknown> }[];
    supersedePlanItemSeqs?: number[];
    requestedBy: string;
  }): OpsResult<MissionRecord> {
    if (!input.missionId || !input.requestedBy) {
      return fail('invalid_input', 'missionId and requestedBy are required');
    }
    const amendment = missionText(
      'amendment',
      input.amendment,
      MAX_MISSION_INSTRUCTION_LENGTH,
      true,
    );
    if (!amendment.ok) return fail('invalid_input', amendment.message);
    const objective = missionText('objective', input.objective, MAX_MISSION_OBJECTIVE_LENGTH, false);
    if (!objective.ok) return fail('invalid_input', objective.message);
    const constraints = missionList('constraints', input.constraints);
    if (!constraints.ok) return fail('invalid_input', constraints.message);
    const acceptance = missionList('acceptanceCriteria', input.acceptanceCriteria);
    if (!acceptance.ok) return fail('invalid_input', acceptance.message);
    if (input.addPlan !== undefined && input.addPlanItems !== undefined) {
      return fail('invalid_input', 'Supply addPlan OR addPlanItems, not both');
    }
    const addPlanItems = missionList(
      'addPlanItems',
      input.addPlan !== undefined ? input.addPlan.map((entry) => entry?.summary as string) : input.addPlanItems,
    );
    if (!addPlanItems.ok) return fail('invalid_input', addPlanItems.message);
    const addSpecs: (NormalizedWorkSpec | null)[] = [];
    if (input.addPlan !== undefined) {
      for (const [i, entry] of input.addPlan.entries()) {
        const hasCapability = entry?.capabilityId !== undefined;
        const hasPayload = entry?.payload !== undefined;
        if (!hasCapability && !hasPayload) {
          addSpecs.push(null);
          continue;
        }
        if (hasCapability !== hasPayload) {
          return fail('invalid_input', `addPlan[${i}]: a spec needs BOTH capabilityId and payload`);
        }
        const spec = normalizeWorkSpec(`addPlan[${i}]`, entry.capabilityId, entry.payload);
        if (!spec.ok) return fail('invalid_input', spec.message);
        addSpecs.push(spec.value);
      }
    }
    const specifyItems: { seq: number; spec: NormalizedWorkSpec }[] = [];
    for (const [i, entry] of (input.specifyPlanItems ?? []).entries()) {
      if (!Number.isInteger(entry?.seq)) {
        return fail('invalid_input', `specifyPlanItems[${i}]: seq must be an integer`);
      }
      const spec = normalizeWorkSpec(`specifyPlanItems[${i}]`, entry.capabilityId, entry.payload);
      if (!spec.ok) return fail('invalid_input', spec.message);
      if (specifyItems.some((existing) => existing.seq === entry.seq)) {
        return fail('invalid_input', `specifyPlanItems names plan item ${entry.seq} twice`);
      }
      specifyItems.push({ seq: entry.seq, spec: spec.value });
    }

    const refusedCommander = this.#resolveMissionCommander(
      input.requestedBy,
      `amend mission ${input.missionId}`,
    );
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#missionCapabilityGate('amend a mission');
    if (refusedCapability) return refusedCapability;

    const supersedeSeqs = [...new Set(input.supersedePlanItemSeqs ?? [])];
    for (const seq of supersedeSeqs) {
      if (!Number.isInteger(seq)) {
        return fail('invalid_input', `supersedePlanItemSeqs entries must be integers`);
      }
    }

    try {
      assertNoSecretLikeContent({
        amendment: amendment.value,
        objective: objective.value,
        constraints: constraints.value,
        acceptanceCriteria: acceptance.value,
        addPlanItems: addPlanItems.value,
        addSpecs: addSpecs.map((spec) => spec?.payload ?? null),
        specifyPlanItems: specifyItems.map((entry) => entry.spec.payload),
      });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    // The status read, the plan-item validation, both MAX(seq) reads and
    // every write commit inside ONE IMMEDIATE transaction (the
    // declareWorkerProvider precedent, issue #224). That closes the
    // check-then-append window in which two concurrent amendments computed
    // the same sequence and the loser surfaced as an opaque
    // UNIQUE-constraint 500; it resolves the privileged handle before
    // anything is written; and a failing evidence append rolls the amendment
    // back with it.
    const privileged = this.#requirePrivilegedQueue();
    const at = nowIso();
    let refusal: OpsResult<MissionRecord> | null = null;
    try {
      privileged.reserve(() => {
        const current = this.#missionRecord(input.missionId);
        if (!current) {
          refusal = fail('unknown_mission', `Unknown mission: ${input.missionId}`);
          return;
        }
        if (isMissionTerminal(current.status)) {
          refusal = fail(
            'mission_terminal',
            `Mission ${input.missionId} is ${current.status} — a terminal mission is closed history and cannot be amended`,
            { status: current.status },
          );
          return;
        }
        for (const seq of supersedeSeqs) {
          const item = current.planItems.find((p) => p.seq === seq);
          if (!item) {
            refusal = fail('invalid_input', `Mission ${input.missionId} has no plan item ${seq}`);
            return;
          }
          if (item.supersededInIntentSeq != null) {
            refusal = fail('invalid_input', `Plan item ${seq} is already superseded`);
            return;
          }
        }
        // Spec targets validated INSIDE the write lock, against the same
        // rules linkMissionPlanItem enforces for links: the item must exist,
        // be work, not be superseded (including by THIS amendment), not be
        // linked, and not already carry a spec (write-once — supersede and
        // re-add to change the work).
        for (const { seq } of specifyItems) {
          const item = current.planItems.find((p) => p.seq === seq);
          if (!item) {
            refusal = fail('invalid_input', `Mission ${input.missionId} has no plan item ${seq}`);
            return;
          }
          if (item.kind !== 'work') {
            refusal = fail('invalid_input', `Plan item ${seq} is ${item.kind}, not work — it cannot carry a spec`);
            return;
          }
          if (item.supersededInIntentSeq != null || supersedeSeqs.includes(seq)) {
            refusal = fail('invalid_input', `Plan item ${seq} is superseded — spec the replacement item instead`);
            return;
          }
          if (item.taskId != null) {
            refusal = fail('invalid_input', `Plan item ${seq} is already linked to task ${item.taskId}`);
            return;
          }
          if (item.specCapabilityId != null) {
            refusal = fail(
              'invalid_input',
              `Plan item ${seq} already carries a spec (write-once) — supersede it and add a re-specified item`,
            );
            return;
          }
        }

        const nextObjective = objective.value ?? current.objective;
        const nextConstraints = constraints.value ?? current.constraints;
        const nextAcceptance = acceptance.value ?? current.acceptanceCriteria;
        const nextIntentSeq =
          ((
            this.#db
              .prepare(`SELECT MAX(seq) AS max_seq FROM hq_mission_intents WHERE mission_id = ?`)
              .get(input.missionId) as { max_seq: number | null }
          ).max_seq ?? 0) + 1;
        const maxPlanSeq =
          (
            this.#db
              .prepare(`SELECT MAX(seq) AS max_seq FROM hq_mission_plan_items WHERE mission_id = ?`)
              .get(input.missionId) as { max_seq: number | null }
          ).max_seq ?? 0;
        const body = canonicalJson({
          kind: 'amendment',
          amendment: amendment.value,
          objective: objective.value,
          constraints: constraints.value,
          acceptanceCriteria: acceptance.value,
          addPlanItems: addPlanItems.value,
          // Full specs in the SERVER-SIDE body: the append-only history
          // explains every spec verbatim (the raw-order rule).
          addPlanSpecs: addSpecs.map((spec, i) => (spec ? { index: i, ...spec } : null)).filter(Boolean),
          specifyPlanItems: specifyItems.map((entry) => ({ seq: entry.seq, ...entry.spec })),
          supersedePlanItemSeqs: supersedeSeqs,
          requestedBy: input.requestedBy,
          at,
        });

        this.#db
          .prepare(
            `UPDATE hq_missions
             SET objective = ?, constraints = ?, acceptance_criteria = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(
            nextObjective,
            JSON.stringify(nextConstraints),
            nextAcceptance == null ? null : JSON.stringify(nextAcceptance),
            at,
            input.missionId,
          );
        appendMissionIntent(this.#db, {
          missionId: input.missionId,
          seq: nextIntentSeq,
          kind: 'amendment',
          body,
          objective: nextObjective,
          constraints: nextConstraints,
          acceptanceCriteria: nextAcceptance,
          actor: input.requestedBy,
          at,
        });
        for (const seq of supersedeSeqs) {
          this.#db
            .prepare(
              `UPDATE hq_mission_plan_items
               SET superseded_in_intent_seq = ?
               WHERE mission_id = ? AND seq = ? AND superseded_in_intent_seq IS NULL`,
            )
            .run(nextIntentSeq, input.missionId, seq);
        }
        (addPlanItems.value ?? []).forEach((summary, i) => {
          insertMissionPlanItem(this.#db, {
            missionId: input.missionId,
            seq: maxPlanSeq + i + 1,
            summary,
            kind: 'work',
            createdInIntentSeq: nextIntentSeq,
            specCapabilityId: addSpecs[i]?.capabilityId ?? null,
            specPayload: addSpecs[i]?.payload ?? null,
          });
        });
        for (const { seq, spec } of specifyItems) {
          const stated = setMissionPlanItemSpec(this.#db, {
            missionId: input.missionId,
            seq,
            specCapabilityId: spec.capabilityId,
            specPayload: spec.payload,
            specSetInIntentSeq: nextIntentSeq,
          });
          if (!stated) {
            // Validated above inside the same lock — reaching here means a
            // writer outside this transaction raced us anyway; surface it as
            // the same typed conflict a raced amendment gets
            // (isMissionSequenceConflict matches the table name + code).
            throw Object.assign(
              new Error(`hq_mission_plan_items work spec for item ${seq} was stated concurrently`),
              { code: 'SQLITE_CONSTRAINT_TRIGGER' },
            );
          }
        }
        appendMissionEvent(this.#db, {
          missionId: input.missionId,
          actor: input.requestedBy,
          kind: 'intent_amended',
          detail: {
            intentSeq: nextIntentSeq,
            addedPlanItems: addPlanItems.value?.length ?? 0,
            supersededPlanItems: supersedeSeqs.length,
            specifiedPlanItems: specifyItems.length,
          },
        });
        privileged.appendEvidence({
          actor: input.requestedBy,
          kind: 'mission_intent_amended',
          payload: { missionId: input.missionId, intentSeq: nextIntentSeq, executable: false },
        });
      });
    } catch (error) {
      // Belt over the braces above: even a writer that somehow slipped past
      // the IMMEDIATE transaction surfaces as a typed 409 conflict, never an
      // opaque 500 that hides which write lost.
      if (isMissionSequenceConflict(error)) {
        return fail(
          'mission_intent_conflict',
          `Mission ${input.missionId} was amended concurrently — re-read the mission and retry`,
        );
      }
      throw error;
    }
    if (refusal) return refusal;
    return ok(this.#missionRecord(input.missionId)!);
  }

  /**
   * Link a plan item to a REAL operator task (created through the ordinary
   * gated paths — a direct order, a promoted proposal). Written once: the
   * link records which canonical work carries the item; it grants nothing,
   * moves nothing, and never touches the task.
   */
  linkMissionPlanItem(input: {
    missionId: string;
    planItemSeq: number;
    taskId: string;
    requestedBy: string;
  }): OpsResult<MissionRecord> {
    if (!input.missionId || !input.requestedBy || !input.taskId) {
      return fail('invalid_input', 'missionId, planItemSeq, taskId and requestedBy are required');
    }
    if (!Number.isInteger(input.planItemSeq)) {
      return fail('invalid_input', 'planItemSeq must be an integer');
    }
    const refusedCommander = this.#resolveMissionCommander(
      input.requestedBy,
      `link a task to mission ${input.missionId}`,
    );
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#missionCapabilityGate('link a mission plan item');
    if (refusedCapability) return refusedCapability;

    const current = this.#missionRecord(input.missionId);
    if (!current) return fail('unknown_mission', `Unknown mission: ${input.missionId}`);
    if (isMissionTerminal(current.status)) {
      return fail(
        'mission_terminal',
        `Mission ${input.missionId} is ${current.status} — a terminal mission is closed history`,
        { status: current.status },
      );
    }
    const item = current.planItems.find((p) => p.seq === input.planItemSeq);
    if (!item) {
      return fail('invalid_input', `Mission ${input.missionId} has no plan item ${input.planItemSeq}`);
    }
    if (item.supersededInIntentSeq != null) {
      return fail('invalid_input', `Plan item ${input.planItemSeq} is superseded`);
    }
    if (item.kind !== 'work') {
      return fail(
        'invalid_input',
        `Plan item ${input.planItemSeq} records an open question — amend the mission to turn it into work before linking`,
      );
    }
    if (item.taskId) {
      return fail('invalid_input', `Plan item ${input.planItemSeq} is already linked to ${item.taskId}`);
    }
    if (!this.#db.prepare(`SELECT 1 FROM op_tasks WHERE id = ?`).get(input.taskId)) {
      return fail('unknown_task', `Unknown task: ${input.taskId}`);
    }

    const at = nowIso();
    let raced = false;
    // Write-once link, its event and its evidence in ONE IMMEDIATE
    // transaction — same rationale as the other three mission mutations.
    const privileged = this.#requirePrivilegedQueue();
    privileged.reserve(() => {
      const result = this.#db
        .prepare(
          `UPDATE hq_mission_plan_items
           SET task_id = ?, linked_by = ?, linked_at = ?
           WHERE mission_id = ? AND seq = ? AND task_id IS NULL`,
        )
        .run(input.taskId, input.requestedBy, at, input.missionId, input.planItemSeq);
      if (result.changes === 0) {
        raced = true;
        return;
      }
      appendMissionEvent(this.#db, {
        missionId: input.missionId,
        actor: input.requestedBy,
        kind: 'plan_item_linked',
        detail: { planItemSeq: input.planItemSeq, taskId: input.taskId },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'mission_plan_item_linked',
        payload: {
          missionId: input.missionId,
          planItemSeq: input.planItemSeq,
          taskId: input.taskId,
          executable: false,
        },
      });
    });
    if (raced) {
      return fail('invalid_input', `Plan item ${input.planItemSeq} was linked concurrently`);
    }
    return ok(this.#missionRecord(input.missionId)!);
  }

  // ---- mission orchestration (Phase 6 — Real Mission Orchestrator, #265) ----

  /**
   * One bounded orchestration cycle over an already-commanded mission.
   *
   * PREVIEW is a pure read: it observes canonical state, classifies every
   * plan item through the deterministic decision core, and writes NOTHING —
   * no task, no link, no run record, no evidence (it deliberately does not
   * call routeTask/evaluateTaskEligibility, whose evidence writes are why
   * /workforce/route sits on the write surface; eligibility here reads the
   * SAME directory/policy predicates evidence-free).
   *
   * APPLY is the act, inside ONE IMMEDIATE transaction: for each READY item
   * (work-kind, unsuperseded, unlinked, Founder-spec'd, capability
   * registered+enabled, originate grant held, scope switch off) it creates
   * the task through `createTask` — THE approved origination path, policy
   * deciding queued vs needs_approval exactly as for a manual order — with a
   * DERIVED idempotency key, then links it write-once. Rerun-safe by
   * construction: the queue dedupes on (capability_id, key), the link never
   * re-points, and an in-cycle crash rolls the whole transaction back.
   *
   * Authority boundaries, stated: the orchestrator approves nothing, claims
   * nothing, dispatches nothing, transitions no mission, invents no work
   * (an unspec'd item is truthfully not actionable — the Phase 3 no-parsing
   * law), never touches hq_memory, and under an engaged global/orchestrate
   * kill switch APPLY refuses wholesale — an orchestrated `queued` task
   * would sit primed to run on release (the approveTask precedent), while
   * PREVIEW stays available because reading is not reachability. Mission
   * priority still never reorders operator FIFO: created tasks join the
   * queue in arrival order like every other task.
   *
   * The gates run TWICE on apply, deliberately: once before the lock for
   * fast refusal, and again inside the outer IMMEDIATE transaction from
   * canonical store truth (`#revalidateOrchestrationAuthorityLocked`,
   * Sol M1) — a revocation or kill-switch engagement another connection
   * commits between precheck and lock refuses the whole cycle with zero
   * orchestration writes.
   */
  orchestrateMission(input: {
    missionId: string;
    mode: 'preview' | 'apply';
    /** From a prior preview; when supplied, apply refuses if the mission moved. */
    fingerprint?: string;
    /** Resolved principal id. Set by the boundary, never read from a body. */
    requestedBy: string;
  }): OpsResult<OrchestrationReport> {
    if (!input.missionId || !input.requestedBy) {
      return fail('invalid_input', 'missionId and requestedBy are required');
    }
    if (input.mode !== 'preview' && input.mode !== 'apply') {
      return fail('invalid_input', "mode must be 'preview' or 'apply'");
    }
    const refusedOrchestrator = this.#resolveFounderGateActor(
      input.requestedBy,
      'orchestrate a mission',
      MISSION_ORCHESTRATE_CAPABILITY.id,
      'orchestrating a mission',
    );
    if (refusedOrchestrator) return refusedOrchestrator;
    const refusedCapability = this.#founderGateCapabilityGate(
      'orchestrate a mission',
      MISSION_ORCHESTRATE_CAPABILITY.id,
      missionOrchestrateCapabilityState,
      missionOrchestrateContractDrift,
      'orchestrating a mission',
    );
    if (refusedCapability) return refusedCapability;
    if (input.mode === 'apply') {
      // Linking is a mission-directing act, so apply pre-checks the MISSION
      // gate up front rather than failing per-item halfway through.
      const refusedCommander = this.#resolveMissionCommander(input.requestedBy, 'orchestrate a mission');
      if (refusedCommander) return refusedCommander;
      const refusedMissionCapability = this.#missionCapabilityGate('orchestrate a mission');
      if (refusedMissionCapability) return refusedMissionCapability;
    }

    const mission = this.#missionRecord(input.missionId);
    if (!mission) return fail('unknown_mission', `Unknown mission: ${input.missionId}`);
    if (isMissionTerminal(mission.status)) {
      return fail(
        'mission_terminal',
        `Mission ${input.missionId} is ${mission.status} — a terminal mission has no work to orchestrate`,
        { status: mission.status },
      );
    }
    if (input.mode === 'apply' && mission.status !== 'planned' && mission.status !== 'working') {
      return fail(
        'mission_not_orchestratable',
        `Mission ${input.missionId} is ${mission.status} — apply orchestrates only planned/working missions ` +
          '(blocked records a Founder stop; ready_review/verified are past building)',
        { status: mission.status },
      );
    }
    // Enforcement-safe read (Phase 8, Low 7). The locked revalidation below
    // already reads the canonical row, so a forged delegate could never make
    // apply WRITE on an engaged switch — but this precheck decides a refusal
    // outcome, and the rule is that no decision reads the patchable delegate.
    if (input.mode === 'apply' && this.#killSwitchEngagedFromStore(MISSION_ORCHESTRATE_CAPABILITY.id)) {
      // Wholesale, before any write: an orchestrated read-only task would
      // land `queued` — primed to run the moment the switch releases.
      return fail(
        'kill_switch_engaged',
        'The kill switch is engaged: orchestrate-apply refuses wholesale so no orchestrated task sits primed. Preview remains available.',
      );
    }

    const observedNow = this.#observeOrchestration(mission, input.requestedBy);
    const fingerprint = orchestrationObservedDigest(observedNow);
    const decisionsNow = planOrchestration(observedNow.items);

    if (input.mode === 'preview') {
      return ok({
        missionId: mission.id,
        mode: 'preview',
        runId: null,
        fingerprint,
        state: this.#missionExecutionState(mission),
        decisions: decisionsNow,
      });
    }

    if (input.fingerprint !== undefined && input.fingerprint !== fingerprint) {
      return fail(
        'orchestrate_fingerprint_mismatch',
        'The mission moved since the preview this apply echoes — re-preview and decide again',
      );
    }

    const privileged = this.#requirePrivilegedQueue();
    const runId = `orch-${uuid()}`;
    let refusal: OpsResult<never> | null = null;
    const enacted: OrchestrationDecision[] = [];
    privileged.reserve(() => {
      // Revalidated INSIDE the write lock, before anything else (Sol M1,
      // PR #266 review 5124774932): the prechecks above ran on a picture a
      // second connection could still move — a revocation or kill-switch
      // engagement committed between them and this lock must refuse the
      // whole cycle, never let it act on stale authority. Nothing below —
      // no task, no link, no run item, no run, no event, no evidence — may
      // be written until the CURRENT canonical truth re-admits the act.
      const staleAuthority = this.#revalidateOrchestrationAuthorityLocked(input.requestedBy);
      if (staleAuthority) {
        refusal = staleAuthority;
        return;
      }
      // Re-observed INSIDE the write lock (the assignMissionToProject
      // precedent): the decisions acted on are the decisions of the locked
      // picture, not the pre-lock one.
      const current = this.#missionRecord(input.missionId)!;
      if (current.status !== 'planned' && current.status !== 'working') {
        refusal = fail('mission_status_changed', `Mission ${input.missionId} moved to ${current.status} concurrently`);
        return;
      }
      const observed = this.#observeOrchestration(current, input.requestedBy);
      if (input.fingerprint !== undefined && orchestrationObservedDigest(observed) !== input.fingerprint) {
        refusal = fail(
          'orchestrate_fingerprint_mismatch',
          'The mission moved since the preview this apply echoes — re-preview and decide again',
        );
        return;
      }
      const decisions = planOrchestration(observed.items);
      const specBySeq = new Map(current.planItems.map((item) => [item.seq, item] as const));
      for (const decision of decisions) {
        if (decision.decision !== 'ready') {
          enacted.push(decision);
          insertOrchestrationRunItem(this.#db, {
            runId,
            missionId: current.id,
            planItemSeq: decision.planItemSeq,
            decision: decision.decision,
            detail: decision.detail,
          });
          continue;
        }
        const seq = decision.planItemSeq!;
        const item = specBySeq.get(seq)!;
        const idempotencyKey = orchestrationTaskIdempotencyKey({
          missionId: current.id,
          planItemSeq: seq,
          capabilityId: item.specCapabilityId!,
          payload: item.specPayload!,
        });
        // THE approved origination path — the same facade gate every manual
        // order passes, payload VERBATIM from the Founder's stored spec.
        const created = this.createTask({
          capabilityId: item.specCapabilityId!,
          payload: JSON.parse(item.specPayload!) as Record<string, unknown>,
          idempotencyKey,
          project: current.project ?? undefined,
          title: item.summary,
          requestedBy: input.requestedBy,
        });
        if (!created.ok) {
          const refused: OrchestrationDecision = {
            planItemSeq: seq,
            decision: 'enqueue_refused',
            detail: { capabilityId: item.specCapabilityId, code: created.error.code },
          };
          enacted.push(refused);
          insertOrchestrationRunItem(this.#db, {
            runId,
            missionId: current.id,
            planItemSeq: seq,
            decision: refused.decision,
            detail: refused.detail,
          });
          continue;
        }
        const taskId = created.data.task.id;
        const madeDecision: OrchestrationDecision = {
          planItemSeq: seq,
          decision: created.data.deduplicated ? 'task_deduplicated' : 'task_created',
          detail: {
            taskId,
            capabilityId: item.specCapabilityId,
            taskStatus: created.data.task.status,
          },
        };
        enacted.push(madeDecision);
        insertOrchestrationRunItem(this.#db, {
          runId,
          missionId: current.id,
          planItemSeq: seq,
          decision: madeDecision.decision,
          detail: madeDecision.detail,
        });
        const linked = this.linkMissionPlanItem({
          missionId: current.id,
          planItemSeq: seq,
          taskId,
          requestedBy: input.requestedBy,
        });
        const linkDecision: OrchestrationDecision = linked.ok
          ? { planItemSeq: seq, decision: 'item_linked', detail: { taskId } }
          : {
              planItemSeq: seq,
              decision: 'link_refused',
              detail: { taskId, code: linked.error.code, message: linked.error.message },
            };
        enacted.push(linkDecision);
        insertOrchestrationRunItem(this.#db, {
          runId,
          missionId: current.id,
          planItemSeq: seq,
          decision: linkDecision.decision,
          detail: linkDecision.detail,
        });
      }
      const counts = {
        decisions: enacted.length,
        created: enacted.filter((d) => d.decision === 'task_created').length,
        deduplicated: enacted.filter((d) => d.decision === 'task_deduplicated').length,
        linked: enacted.filter((d) => d.decision === 'item_linked').length,
        refused: enacted.filter((d) => d.decision === 'enqueue_refused' || d.decision === 'link_refused').length,
        notActionable: enacted.filter(
          (d) =>
            d.decision === 'not_actionable_unspecified' || d.decision === 'not_actionable_needs_clarification',
        ).length,
      };
      // The run row lands LAST, its summary complete — an aborted cycle
      // leaves no half-run record because the whole transaction rolls back.
      insertOrchestrationRun(this.#db, {
        id: runId,
        missionId: current.id,
        requestedBy: input.requestedBy,
        observedDigest: orchestrationObservedDigest(observed),
        summary: counts,
      });
      appendMissionEvent(this.#db, {
        missionId: current.id,
        actor: input.requestedBy,
        kind: 'orchestrated',
        detail: { runId, ...counts },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'mission_orchestrated',
        payload: { missionId: current.id, runId, ...counts, executable: false },
      });
    });
    if (refusal) return refusal;

    const after = this.#missionRecord(input.missionId)!;
    return ok({
      missionId: after.id,
      mode: 'apply',
      runId,
      fingerprint: orchestrationObservedDigest(this.#observeOrchestration(after, input.requestedBy)),
      state: this.#missionExecutionState(after),
      decisions: enacted,
    });
  }

  /**
   * Every load-bearing orchestrate gate, re-proven from CURRENT canonical
   * enforcement truth INSIDE the outer IMMEDIATE write transaction (Sol M1,
   * PR #266 review 5124774932).
   *
   * Why it exists: `orchestrateMission`'s prechecks run BEFORE the lock, so a
   * second connection could commit an authority revocation or engage the
   * orchestrate kill switch after the precheck observed them clear and before
   * the apply acquired its write lock — and the locked cycle would then create
   * real tasks on stale authority. The same window let `createTask` succeed
   * before `linkMissionPlanItem` observed a concurrently revoked Mission gate,
   * leaving a real unlinked task. Holding the lock while re-proving all five
   * gates closes both: nothing can move between this check and the writes.
   *
   * The five gates, in precheck order:
   *   1. the acting principal still holds `hq.mission_orchestrate`
   *      (`#resolveFounderGateActor` → the database principal row);
   *   2. the canonical `hq.mission_orchestrate` row is still present, enabled
   *      and contract-correct (`#founderGateCapabilityGate` → `#capabilityFromStore`);
   *   3. the Mission actor and `hq.mission_command` gate still admit the
   *      linking act (`#resolveMissionCommander` + `#missionCapabilityGate`);
   *   4./5. the global and `hq.mission_orchestrate` kill-switch scopes are
   *      still clear — read through `#killSwitchEngagedFromStore`, never the
   *      patchable `queue.killSwitchEngaged` convenience delegate.
   *
   * A refusal is the canonical precheck refusal with `revalidation:
   * 'post_lock'` added to its details — truthful provenance of WHERE the
   * refusal was decided, so audit and the concurrency proofs can tell a
   * precheck refusal from a raced one. The caller returns it before any
   * orchestration write, so a failed revalidation leaves ZERO mutations.
   */
  #revalidateOrchestrationAuthorityLocked(requestedBy: string): OpsResult<never> | null {
    const refused =
      this.#resolveFounderGateActor(
        requestedBy,
        'orchestrate a mission',
        MISSION_ORCHESTRATE_CAPABILITY.id,
        'orchestrating a mission',
      ) ??
      this.#founderGateCapabilityGate(
        'orchestrate a mission',
        MISSION_ORCHESTRATE_CAPABILITY.id,
        missionOrchestrateCapabilityState,
        missionOrchestrateContractDrift,
        'orchestrating a mission',
      ) ??
      this.#resolveMissionCommander(requestedBy, 'orchestrate a mission') ??
      this.#missionCapabilityGate('orchestrate a mission');
    if (refused && !refused.ok) {
      return fail(refused.error.code, refused.error.message, {
        ...(refused.error.details ?? {}),
        revalidation: 'post_lock',
      });
    }
    if (this.#killSwitchEngagedFromStore(MISSION_ORCHESTRATE_CAPABILITY.id)) {
      return fail(
        'kill_switch_engaged',
        'The kill switch engaged while orchestrate-apply waited for the write lock: the locked cycle refuses wholesale so no orchestrated task sits primed. Preview remains available.',
        { revalidation: 'post_lock' },
      );
    }
    return null;
  }

  /** Observe the facts the decision core classifies — reads only, no clock beyond `nowIso` provenance. */
  #observeOrchestration(
    mission: MissionRecord,
    requestedBy: string,
  ): { missionId: string; missionStatus: string; items: ObservedPlanItem[] } {
    const originate = this.#principals.get(requestedBy)?.originateCapabilities ?? [];
    const items: ObservedPlanItem[] = mission.planItems.map((item) => {
      const taskRow = item.taskId
        ? (this.#db
            .prepare(`SELECT status, review_state, claimed_by FROM op_tasks WHERE id = ?`)
            .get(item.taskId) as { status: string; review_state: string | null; claimed_by: string | null } | undefined)
        : undefined;
      const specCapability =
        item.specCapabilityId != null ? this.#capabilityFromStore(item.specCapabilityId) : null;
      return {
        seq: item.seq,
        kind: item.kind,
        superseded: item.supersededInIntentSeq != null,
        taskId: item.taskId,
        taskStatus: (taskRow?.status as ActivityStatus | undefined) ?? null,
        reviewPending: taskRow?.review_state === 'pending',
        claimedBy: taskRow?.claimed_by ?? null,
        specCapabilityId: item.specCapabilityId,
        specPayload: item.specPayload,
        specCapabilityState:
          item.specCapabilityId == null
            ? null
            : specCapability == null
              ? 'missing'
              : specCapability.enabled
                ? 'enabled'
                : 'disabled',
        founderHoldsOriginate:
          item.specCapabilityId != null && originate.includes(item.specCapabilityId),
        specScopeKillSwitchEngaged:
          item.specCapabilityId != null &&
          this.#killSwitchEngagedFromStore(item.specCapabilityId),
      };
    });
    return { missionId: mission.id, missionStatus: mission.status, items };
  }

  /** Evidence-free eligible-worker read — the SAME directory/policy predicates enforcement uses. */
  #workerEligibilityFor(capabilityId: string): string[] {
    const cap = this.#capabilityFromStore(capabilityId);
    if (!cap) return [];
    return this.#store
      .listSpecialists()
      .filter((specialist) => {
        const granted = this.#grantOf(specialist.id);
        const assignability = this.#workers.assignability(specialist.id);
        const decision = evaluatePolicy(
          cap,
          { workerId: specialist.id, allowedCapabilities: [...granted] },
          this.#policyCtx,
        );
        return granted.includes(capabilityId) && assignability.assignable && decision.outcome !== 'deny';
      })
      .map((specialist) => specialist.id)
      .sort();
  }

  #missionExecutionState(mission: MissionRecord): MissionExecutionState {
    const live = mission.planItems.filter((item) => item.supersededInIntentSeq == null);
    const work = live.filter((item) => item.kind === 'work');
    const clarification = live.filter((item) => item.kind === 'needs_clarification');
    const linkedItems = work.filter((item) => item.taskId != null);
    const linkedTasks: MissionExecutionState['linkedTasks'] = linkedItems.map((item) => {
      const row = this.#db
        .prepare(`SELECT status, review_state, claimed_by, capability_id FROM op_tasks WHERE id = ?`)
        .get(item.taskId!) as
        | { status: string; review_state: string | null; claimed_by: string | null; capability_id: string }
        | undefined;
      const assignment = this.readMeta(item.taskId!)?.assignment ?? null;
      return {
        planItemSeq: item.seq,
        taskId: item.taskId!,
        status: (row?.status as ActivityStatus | undefined) ?? 'outcome_unknown',
        reviewPending: row?.review_state === 'pending',
        claimedBy: row?.claimed_by ?? null,
        assignment: assignment
          ? { workerId: assignment.workerId, assignedBy: assignment.assignedBy, assignedAt: assignment.assignedAt }
          : null,
        eligibleWorkers: row ? this.#workerEligibilityFor(row.capability_id) : [],
      };
    });
    const unspecified = work.filter((item) => item.taskId == null && item.specCapabilityId == null);
    const specified = work.filter((item) => item.specCapabilityId != null);
    const engagedSpecScopes = [
      ...new Set(
        specified
          .map((item) => item.specCapabilityId!)
          .filter((capabilityId) => this.queue.killSwitchEngaged(capabilityId)),
      ),
    ].sort();
    // Derived readiness, CATEGORICAL: every live work item is linked, every
    // linked task is terminal-complete, nothing awaits clarification and at
    // least one real work item exists. A recommendation, never a transition.
    const allWorkLinked = work.length > 0 && work.every((item) => item.taskId != null);
    const allComplete = linkedTasks.length > 0 && linkedTasks.every((task) => task.status === 'completed');
    const recommendation: MissionExecutionState['recommendation'] =
      allWorkLinked && allComplete && clarification.length === 0 ? 'ready_review' : 'none';
    return {
      missionId: mission.id,
      status: mission.status,
      planItems: {
        total: mission.planItems.length,
        superseded: mission.planItems.length - live.length,
        needsClarification: clarification.length,
        workUnspecified: unspecified.length,
        workSpecified: specified.length,
        linked: linkedItems.length,
      },
      linkedTasks,
      blockers: {
        unspecifiedWorkItems: unspecified.map((item) => item.seq),
        needsClarification: clarification.map((item) => item.seq),
        approvalPending: linkedTasks.filter((task) => task.status === 'needs_approval').map((task) => task.taskId),
        outcomeUnknown: linkedTasks.filter((task) => task.status === 'outcome_unknown').map((task) => task.taskId),
        blocked: linkedTasks.filter((task) => task.status === 'blocked').map((task) => task.taskId),
      },
      killSwitch: {
        global: this.queue.killSwitchEngaged(),
        orchestrate: this.queue.killSwitchEngaged(MISSION_ORCHESTRATE_CAPABILITY.id),
        engagedSpecScopes,
      },
      dependsOn: mission.dependsOn.map((missionId) => ({
        missionId,
        status: this.getMission(missionId)?.status ?? null,
      })),
      recommendation,
    };
  }

  /** The categorical execution-state read on its own — the Mission Room's truth. */
  getMissionExecutionState(missionId: string): OpsResult<MissionExecutionState> {
    if (!missionId) return fail('invalid_input', 'missionId is required');
    const mission = this.#missionRecord(missionId);
    if (!mission) return fail('unknown_mission', `Unknown mission: ${missionId}`);
    return ok(this.#missionExecutionState(mission));
  }

  /**
   * Assign a mission to a canonical project register entry, or clear the
   * assignment (`projectId: null`). A mission-directing act, so it carries
   * the MISSION gate (`hq.mission_command`), not the project one. The target
   * must exist and be `active`; terminal missions refuse (their record is
   * history). Changes the relationship column only — never the mission's
   * free-text `project` label, status, plan or intent history — and records
   * the move in the append-only mission event log plus the evidence chain.
   */
  assignMissionToProject(input: {
    missionId: string;
    projectId: string | null;
    requestedBy: string;
  }): OpsResult<MissionRecord> {
    if (!input.missionId || !input.requestedBy) {
      return fail('invalid_input', 'missionId and requestedBy are required');
    }
    const refusedCommander = this.#resolveMissionCommander(
      input.requestedBy,
      `assign mission ${input.missionId} to a project`,
    );
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#missionCapabilityGate('assign a mission to a project');
    if (refusedCapability) return refusedCapability;

    const projectId = input.projectId?.trim() || null;
    const at = nowIso();
    const privileged = this.#requirePrivilegedQueue();
    // Mission and project state are read INSIDE the IMMEDIATE transaction
    // (the amendMissionIntent precedent, issue #224): the write lock is taken
    // at BEGIN, so a concurrent project close — itself a reserve() write —
    // can no longer land between the active-project check and the UPDATE
    // (Opus Low on PR #263). An in-process interleave is unscriptable
    // (better-sqlite3 is synchronous); the lock is the cross-connection
    // defense, exactly as evidence.ts records.
    let refusal: OpsResult<MissionRecord> | null = null;
    privileged.reserve(() => {
      const current = this.#missionRecord(input.missionId);
      if (!current) {
        refusal = fail('unknown_mission', `Unknown mission: ${input.missionId}`);
        return;
      }
      if (isMissionTerminal(current.status)) {
        refusal = fail(
          'mission_terminal',
          `Mission ${input.missionId} is ${current.status}; its record is history`,
        );
        return;
      }
      if (projectId) {
        const target = this.#projectRecord(projectId);
        if (!target) {
          refusal = fail('unknown_project', `Unknown project: ${projectId}`);
          return;
        }
        if (target.status === 'closed') {
          refusal = fail(
            'project_closed',
            `Project ${projectId} is closed; reopen it before assigning missions to it`,
          );
          return;
        }
      }
      if (current.projectId === projectId) {
        // A replayed assignment is refused rather than re-applied: appending a
        // second identical event would forge history (the transition rule).
        refusal = fail(
          'invalid_input',
          projectId
            ? `Mission ${input.missionId} is already assigned to ${projectId}`
            : `Mission ${input.missionId} is not assigned to any project`,
        );
        return;
      }
      // `IS ?` is null-safe equality in SQLite, so one guarded UPDATE covers
      // both "currently unassigned" and "currently assigned to X". With the
      // reads inside the same transaction this CAS can no longer lose a
      // race; it stays as a cheap invariant, not the primary defense.
      const result = this.#db
        .prepare(
          `UPDATE hq_missions SET project_id = ?, updated_at = ?
           WHERE id = ? AND project_id IS ?`,
        )
        .run(projectId, at, input.missionId, current.projectId);
      if (result.changes === 0) {
        refusal = fail(
          'mission_status_changed',
          `Mission ${input.missionId} changed while the assignment was being decided`,
        );
        return;
      }
      appendMissionEvent(this.#db, {
        missionId: input.missionId,
        actor: input.requestedBy,
        kind: 'project_assigned',
        detail: { from: current.projectId, to: projectId },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'mission_project_assigned',
        payload: {
          missionId: input.missionId,
          from: current.projectId,
          to: projectId,
          executable: false,
        },
      });
    });
    if (refusal) return refusal;
    return ok(this.#missionRecord(input.missionId)!);
  }

  /**
   * The shared Founder-gate actor resolution behind mission AND project
   * commands (Phase 4 extracted it; the mission refusal texts are
   * byte-identical to their Phase 3 originals). An active HUMAN principal
   * holding the named originate grant; deny by default; a registered worker
   * is refused outright — `founderActNoun` names the act in the refusal
   * ("commanding a mission is a Founder act, and worker identity never
   * carries it").
   */
  #resolveFounderGateActor(
    actor: string,
    action: string,
    capabilityId: string,
    founderActNoun: string,
  ): OpsResult<never> | null {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}: a human principal is required`);
    }
    const resolved = this.#resolveRequester(actor, action);
    if (!resolved.ok) return resolved;
    if (resolved.data.kind === 'worker') {
      return fail(
        'not_permitted',
        `Registered worker ${actor} cannot ${action}: ${founderActNoun} is a Founder act, and worker identity never carries it`,
        { actor },
      );
    }
    if (!resolved.data.allowedCapabilities.includes(capabilityId)) {
      return fail(
        'not_permitted',
        `${actor} may not ${action}: the principal does not hold ${capabilityId}`,
        { actor },
      );
    }
    return null;
  }

  /**
   * The shared fail-closed capability gate behind mission AND project
   * commands. Reads the DATABASE row (never `queue.capabilities`) and never
   * repairs — registration is a separate configuration act. `classify` and
   * `drift` come from the owning module so each contract stays test-pinned
   * where it is defined.
   */
  #founderGateCapabilityGate(
    action: string,
    capabilityId: string,
    classify: (row: Capability | null) => 'missing' | 'altered' | 'disabled' | 'enabled',
    drift: (row: Capability) => string[],
    founderActNoun: string,
  ): OpsResult<never> | null {
    const row = this.#capabilityFromStore(capabilityId);
    const state = classify(row);
    if (state === 'enabled') return null;
    if (state === 'missing') {
      return fail(
        'unknown_capability',
        `Cannot ${action}: ${capabilityId} is not registered. ` +
          `Registering it is a separate, deliberate configuration action — ${founderActNoun} never performs it.`,
      );
    }
    if (state === 'altered') {
      const driftFields = drift(row!);
      return fail(
        'not_permitted',
        `Cannot ${action}: the ${capabilityId} definition no longer matches its reserved contract ` +
          `(drift: ${driftFields.join(', ')}). Re-registering it is a separate configuration action.`,
        { drift: driftFields },
      );
    }
    return fail(
      'capability_disabled',
      `Cannot ${action}: ${capabilityId} is disabled. Re-enabling it is a separate configuration action.`,
    );
  }

  #resolveMissionCommander(actor: string, action: string): OpsResult<never> | null {
    return this.#resolveFounderGateActor(
      actor,
      action,
      MISSION_COMMAND_CAPABILITY.id,
      'commanding a mission',
    );
  }

  #missionCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      MISSION_COMMAND_CAPABILITY.id,
      missionCommandCapabilityState,
      missionCommandContractDrift,
      'commanding a mission',
    );
  }

  #resolveProjectCommander(actor: string, action: string): OpsResult<never> | null {
    return this.#resolveFounderGateActor(
      actor,
      action,
      PROJECT_COMMAND_CAPABILITY.id,
      'commanding a project record',
    );
  }

  #projectCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      PROJECT_COMMAND_CAPABILITY.id,
      projectCommandCapabilityState,
      projectCommandContractDrift,
      'commanding a project record',
    );
  }

  #resolveMemoryRecorder(actor: string, action: string): OpsResult<never> | null {
    return this.#resolveFounderGateActor(
      actor,
      action,
      MEMORY_COMMAND_CAPABILITY.id,
      'recording company memory',
    );
  }

  #memoryCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      MEMORY_COMMAND_CAPABILITY.id,
      memoryCommandCapabilityState,
      memoryCommandContractDrift,
      'recording company memory',
    );
  }

  #missionRecord(id: string): MissionRecord | null {
    if (!this.#missionStorePresent) return null;
    return readMissionRecord(
      this.#db,
      id,
      this.#linkedTaskLookup,
      this.#capabilityFromStore(MISSION_COMMAND_CAPABILITY.id),
    );
  }

  /** A linked task's canonical display inputs, read from the one true row. */
  readonly #linkedTaskLookup: LinkedTaskLookup = (taskId) => {
    const row = this.#db
      .prepare(`SELECT status, review_state FROM op_tasks WHERE id = ?`)
      .get(taskId) as { status: string; review_state: string | null } | undefined;
    if (!row) return null;
    return { status: row.status as ActivityStatus, reviewPending: row.review_state === 'pending' };
  };

  // ---- projects (Phase 4 — Projects + Tasks + Dynamic AI Workforce, #262) ----

  /**
   * Create a canonical project register entry.
   *
   * A project organizes missions and executes nothing: no task, no approval,
   * no worker, no dispatch. Founder-only via the `hq.project_command`
   * originate grant and the fail-closed capability gate (the mission
   * CONFIGURATION-vs-INVOCATION trio). Transactional and idempotent on a
   * derived digest key; the client key is an input, never the key.
   */
  createProject(input: {
    name: string;
    purpose: string;
    stream?: string;
    /** Resolved principal id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ project: ProjectRecord; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const name = missionText('name', input.name, MAX_PROJECT_NAME_LENGTH, true);
    if (!name.ok) return fail('invalid_input', name.message);
    const purpose = missionText('purpose', input.purpose, MAX_PROJECT_PURPOSE_LENGTH, true);
    if (!purpose.ok) return fail('invalid_input', purpose.message);
    const stream = missionText('stream', input.stream, MAX_PROJECT_STREAM_LENGTH, false);
    if (!stream.ok) return fail('invalid_input', stream.message);
    const refusedCommander = this.#resolveProjectCommander(input.requestedBy, 'create a project');
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#projectCapabilityGate('create a project');
    if (refusedCapability) return refusedCapability;
    // Everything that will be PERSISTED is scanned before anything is written.
    try {
      assertNoSecretLikeContent({ name: name.value, purpose: purpose.value, stream: stream.value });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }
    const idempotencyKey = projectCommandIdempotencyKey({
      requestedBy: input.requestedBy,
      name: name.value!,
      purpose: purpose.value!,
      stream: stream.value,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    const id = `project-${uuid()}`;
    const at = nowIso();
    // Dedupe read, register write, module event and evidence in ONE IMMEDIATE
    // transaction (the commandMission shape): a service holding no privileged
    // grant refuses before any row exists, a failing evidence append rolls
    // the project back, and the dedupe decision cannot race a concurrent
    // writer past the UNIQUE idempotency index.
    const privileged = this.#requirePrivilegedQueue();
    let dedupedTo: string | null = null;
    privileged.reserve(() => {
      const existing = findProjectIdByIdempotencyKey(this.#db, idempotencyKey);
      if (existing) {
        dedupedTo = existing;
        return;
      }
      this.#db
        .prepare(
          `INSERT INTO hq_projects
             (id, name, stream, summary, status, created_at, updated_at,
              created_by, status_changed_at, status_changed_by, idempotency_key)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name.value,
          encodeStream(stream.value),
          purpose.value,
          at,
          at,
          input.requestedBy,
          at,
          input.requestedBy,
          idempotencyKey,
        );
      appendProjectEvent(this.#db, {
        projectId: id,
        actor: input.requestedBy,
        kind: 'created',
        toStatus: 'active',
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'project_created',
        payload: { projectId: id, idempotencyKey, executable: false },
      });
    });
    if (dedupedTo) {
      return ok({ project: this.#projectRecord(dedupedTo)!, deduplicated: true });
    }
    return ok({ project: this.#projectRecord(id)!, deduplicated: false });
  }

  /**
   * Update a project's register fields. An AUDITED register edit — the event
   * records which fields changed — not a history rewrite: `hq_project_events`
   * is append-only and untouched by this method's UPDATE. Closed projects
   * refuse edits (reopen first); an update that changes nothing writes
   * nothing, because an 'updated' event with no change would forge history.
   */
  updateProject(input: {
    projectId: string;
    name?: string;
    purpose?: string;
    /** undefined = unchanged; '' or null = clear the stream label. */
    stream?: string | null;
    requestedBy: string;
  }): OpsResult<ProjectRecord> {
    if (!input.projectId || !input.requestedBy) {
      return fail('invalid_input', 'projectId and requestedBy are required');
    }
    const nameSupplied = input.name !== undefined;
    const purposeSupplied = input.purpose !== undefined;
    const streamSupplied = input.stream !== undefined;
    if (!nameSupplied && !purposeSupplied && !streamSupplied) {
      return fail('invalid_input', 'Nothing to update: supply name, purpose or stream');
    }
    const name = nameSupplied
      ? missionText('name', input.name, MAX_PROJECT_NAME_LENGTH, true)
      : null;
    if (name && !name.ok) return fail('invalid_input', name.message);
    const purpose = purposeSupplied
      ? missionText('purpose', input.purpose, MAX_PROJECT_PURPOSE_LENGTH, true)
      : null;
    if (purpose && !purpose.ok) return fail('invalid_input', purpose.message);
    const stream = streamSupplied
      ? missionText('stream', input.stream ?? undefined, MAX_PROJECT_STREAM_LENGTH, false)
      : null;
    if (stream && !stream.ok) return fail('invalid_input', stream.message);

    const refusedCommander = this.#resolveProjectCommander(input.requestedBy, 'update a project');
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#projectCapabilityGate('update a project');
    if (refusedCapability) return refusedCapability;

    const current = this.#projectRecord(input.projectId);
    if (!current) return fail('unknown_project', `Unknown project: ${input.projectId}`);
    if (current.status === 'closed') {
      return fail(
        'project_closed',
        `Project ${input.projectId} is closed; reopen it before editing the register entry`,
      );
    }
    const nextName = name ? name.value! : current.name;
    const nextPurpose = purpose ? purpose.value! : current.purpose;
    const nextStream = stream ? stream.value : current.stream;
    const changed: string[] = [];
    if (nextName !== current.name) changed.push('name');
    if (nextPurpose !== current.purpose) changed.push('purpose');
    if (nextStream !== current.stream) changed.push('stream');
    if (changed.length === 0) return ok(current);
    try {
      assertNoSecretLikeContent({ name: nextName, purpose: nextPurpose, stream: nextStream });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    const at = nowIso();
    let raced = false;
    const privileged = this.#requirePrivilegedQueue();
    privileged.reserve(() => {
      const result = this.#db
        .prepare(
          `UPDATE hq_projects SET name = ?, summary = ?, stream = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(nextName, nextPurpose, encodeStream(nextStream), at, input.projectId);
      if (result.changes === 0) {
        raced = true;
        return;
      }
      appendProjectEvent(this.#db, {
        projectId: input.projectId,
        actor: input.requestedBy,
        kind: 'updated',
        detail: { changed },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'project_updated',
        payload: { projectId: input.projectId, changed, executable: false },
      });
    });
    if (raced) {
      return fail(
        'project_status_changed',
        `Project ${input.projectId} changed while the update was being decided`,
      );
    }
    return ok(this.#projectRecord(input.projectId)!);
  }

  /**
   * Move a project between `active` and `closed`. Every move demands a note
   * (two states means every move is a decision with a reason); a replayed
   * same-status move is refused rather than re-applied.
   */
  transitionProject(input: {
    projectId: string;
    to: string;
    note?: string;
    /** Optimistic guard: refuse if the project moved since it was read. */
    expectedStatus?: string;
    requestedBy: string;
  }): OpsResult<ProjectRecord> {
    if (!input.projectId || !input.requestedBy) {
      return fail('invalid_input', 'projectId and requestedBy are required');
    }
    if (!isProjectStatus(input.to)) {
      return fail('invalid_input', `Unknown project status: ${input.to}`);
    }
    if (input.expectedStatus != null && !isProjectStatus(input.expectedStatus)) {
      return fail('invalid_input', `Unknown project status: ${input.expectedStatus}`);
    }
    const noteField = missionText('note', input.note, MAX_PROJECT_NOTE_LENGTH, false);
    if (!noteField.ok) return fail('invalid_input', noteField.message);
    const note = noteField.value;
    if (!note) {
      return fail('invalid_input', `Moving a project to ${input.to} requires a note`);
    }

    const refusedCommander = this.#resolveProjectCommander(
      input.requestedBy,
      `move project ${input.projectId} to ${input.to}`,
    );
    if (refusedCommander) return refusedCommander;
    const refusedCapability = this.#projectCapabilityGate('transition a project');
    if (refusedCapability) return refusedCapability;

    const current = this.#projectRecord(input.projectId);
    if (!current) return fail('unknown_project', `Unknown project: ${input.projectId}`);
    if (input.expectedStatus && current.status !== input.expectedStatus) {
      return fail(
        'project_status_changed',
        `Project ${input.projectId} is ${current.status}, not ${input.expectedStatus}`,
        { status: current.status },
      );
    }
    if (current.status === input.to) {
      return fail('project_status_changed', `Project ${input.projectId} is already ${input.to}`, {
        status: current.status,
      });
    }
    if (!canTransitionProject(current.status, input.to)) {
      return fail(
        'invalid_project_transition',
        `Illegal project transition: ${current.status} -> ${input.to}`,
        {
          from: current.status,
          to: input.to,
          allowed: [...PROJECT_ALLOWED_TRANSITIONS[current.status]],
        },
      );
    }
    try {
      assertNoSecretLikeContent({ note });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    const at = nowIso();
    let raced = false;
    const privileged = this.#requirePrivilegedQueue();
    privileged.reserve(() => {
      const result = this.#db
        .prepare(
          `UPDATE hq_projects
           SET status = ?, updated_at = ?, status_changed_at = ?, status_changed_by = ?
           WHERE id = ? AND status = ?`,
        )
        .run(input.to, at, at, input.requestedBy, input.projectId, current.status);
      if (result.changes === 0) {
        raced = true;
        return;
      }
      appendProjectEvent(this.#db, {
        projectId: input.projectId,
        actor: input.requestedBy,
        kind: 'transitioned',
        fromStatus: current.status,
        toStatus: input.to as ProjectStatus,
        note,
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'project_transitioned',
        payload: {
          projectId: input.projectId,
          from: current.status,
          to: input.to,
          executable: false,
        },
      });
    });
    if (raced) {
      return fail(
        'project_status_changed',
        `Project ${input.projectId} changed status while the transition was being decided`,
      );
    }
    return ok(this.#projectRecord(input.projectId)!);
  }

  getProject(id: string): ProjectRecord | null {
    if (!id) return null;
    return this.#projectRecord(id);
  }

  listProjects(status?: ProjectStatus): ProjectRecord[] {
    if (!this.#projectStorePresent) return [];
    return listProjectIds(this.#db, status).map((id) => this.#projectRecord(id)!);
  }

  /**
   * Whether this database carries the Phase 4 project schema. False only for
   * a read-only handle over a pre-Phase-4 file; project reads then answer
   * empty/null and the snapshot's projects provenance states the absence.
   */
  projectStorePresent(): boolean {
    return this.#projectStorePresent;
  }

  #projectRecord(id: string): ProjectRecord | null {
    if (!this.#projectStorePresent) return null;
    return readProjectRecord(this.#db, id, this.#capabilityFromStore(PROJECT_COMMAND_CAPABILITY.id));
  }

  // ---- company memory (Phase 5 — Context + Mission Memory, #265) ----

  /**
   * Record one company memory entry — the ONE write path into hq_memory from
   * the application layer (issue #120's store, wired at last).
   *
   * A memory record is knowledge, never authority and never execution: it
   * changes no task status, burns no approval, dispatches nothing, and no
   * gate anywhere reads it. Founder-only via the `hq.memory_command`
   * originate grant and the fail-closed capability trio. "Changing" memory is
   * recording a successor via `supersedes`; the store is insert-only BY
   * ENGINE, so history cannot be rewritten by anyone, including this method.
   *
   * Order (the createProject/commandMission shape): bounds/vocabulary →
   * actor gate → capability gate → entity-existence probes (AFTER authority —
   * no existence oracle) → secret scan → derived idempotency key → one
   * IMMEDIATE reserve transaction (dedupe read, supersede/derivation
   * validation, insert, hq_events audit, op_evidence entry — atomically).
   */
  recordMemory(input: {
    kind: MemoryKind;
    title: string;
    body: string;
    /** Free-text project LABEL, never matched against the register. */
    project: string;
    missionId?: string;
    projectId?: string;
    taskId?: string;
    related?: RelatedRefs;
    sourceRefs?: string[];
    tags?: string[];
    derivedFrom?: string[];
    supersedes?: string;
    privacy?: MemoryPrivacy;
    /** Default CURRENT. SUPERSEDED refused — history is earned by a successor, not asserted. */
    status?: ArchiveStatus;
    recorded?: DatedValue;
    /** Resolved principal id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ record: MemoryBrowserView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    if (!isMemoryKind(input.kind)) {
      return fail('invalid_input', `kind must be one of: ${MEMORY_KINDS.join(', ')}`);
    }
    const privacy = input.privacy ?? 'internal';
    if (!isMemoryPrivacy(privacy)) {
      return fail('invalid_input', `privacy must be one of: ${MEMORY_PRIVACY_LEVELS.join(', ')}`);
    }
    const status = input.status ?? 'CURRENT';
    if (!isArchiveStatus(status)) {
      return fail('invalid_input', 'status is not a known archive status');
    }
    if (status === 'SUPERSEDED') {
      return fail(
        'invalid_input',
        'a record cannot be born SUPERSEDED — supersession is earned by recording a successor',
      );
    }
    const title = missionText('title', input.title, MAX_MEMORY_TITLE_LENGTH, true);
    if (!title.ok) return fail('invalid_input', title.message);
    const body = missionText('body', input.body, MAX_MEMORY_BODY_LENGTH, true);
    if (!body.ok) return fail('invalid_input', body.message);
    const project = missionText('project', input.project, MAX_MEMORY_PROJECT_LABEL_LENGTH, true);
    if (!project.ok) return fail('invalid_input', project.message);
    const tags = memoryList('tags', input.tags, MAX_MEMORY_TAG_LENGTH);
    if (!tags.ok) return fail('invalid_input', tags.message);
    const sourceRefs = memoryList('sourceRefs', input.sourceRefs, MAX_MEMORY_SOURCE_REF_LENGTH);
    if (!sourceRefs.ok) return fail('invalid_input', sourceRefs.message);
    const derivedFrom = memoryList('derivedFrom', input.derivedFrom, MAX_MEMORY_SOURCE_REF_LENGTH);
    if (!derivedFrom.ok) return fail('invalid_input', derivedFrom.message);
    const related = memoryRelatedRefs(input.related);
    if (!related.ok) return fail('invalid_input', related.message);
    if (input.kind === 'summary' && derivedFrom.value.length === 0) {
      return fail('invalid_input', 'a summary must name the records it derives from (derivedFrom)');
    }
    const missionId = input.missionId?.trim() || null;
    const projectId = input.projectId?.trim() || null;
    const taskId = input.taskId?.trim() || null;
    const supersedes = input.supersedes?.trim() || null;

    const refusedRecorder = this.#resolveMemoryRecorder(input.requestedBy, 'record memory');
    if (refusedRecorder) return refusedRecorder;
    const refusedCapability = this.#memoryCapabilityGate('record memory');
    if (refusedCapability) return refusedCapability;

    // Entity refs must name real canonical rows — existence probed only after
    // the authority gates above (no existence oracle for the ungranted).
    if (missionId && !this.#db.prepare(`SELECT 1 FROM hq_missions WHERE id = ?`).get(missionId)) {
      return fail('unknown_mission', `Unknown mission: ${missionId}`);
    }
    if (projectId && !this.#db.prepare(`SELECT 1 FROM hq_projects WHERE id = ?`).get(projectId)) {
      return fail('unknown_project', `Unknown project: ${projectId}`);
    }
    if (taskId && !this.#db.prepare(`SELECT 1 FROM op_tasks WHERE id = ?`).get(taskId)) {
      return fail('unknown_task', `Unknown task: ${taskId}`);
    }

    // Everything that will be PERSISTED is scanned before anything is written
    // (the store scans again — deliberate defense in depth, not redundancy).
    try {
      assertNoSecretLikeContent({
        title: title.value,
        body: body.value,
        project: project.value,
        tags: tags.value,
        sourceRefs: sourceRefs.value,
        related: related.value,
      });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    const memory = this.#memory;
    if (!memory) return fail('invalid_input', 'memory store unavailable on this database handle');
    const recorded: DatedValue =
      input.recorded ?? { date: nowIso(), confidence: 'exact', source: 'HQ control boundary' };
    const idempotencyKey = memoryCommandIdempotencyKey({
      requestedBy: input.requestedBy,
      kind: input.kind,
      title: title.value!,
      body: body.value!,
      project: project.value!,
      missionId,
      projectId,
      taskId,
      supersedes,
      derivedFrom: derivedFrom.value,
      privacy,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let recordedId: string | null = null;
    privileged.reserve(() => {
      const existing = memory.findIdByIdempotencyKey(idempotencyKey);
      if (existing) {
        dedupedTo = existing;
        return;
      }
      if (supersedes) {
        const predecessor = memory.get(supersedes);
        if (!predecessor) {
          refusal = { code: 'unknown_memory', message: `Cannot supersede unknown memory record: ${supersedes}` };
          return;
        }
        if (predecessor.status !== 'CURRENT') {
          refusal = {
            code: 'memory_conflict',
            message: `Cannot supersede memory record ${supersedes}: it is ${predecessor.status}, not CURRENT`,
          };
          return;
        }
      }
      for (const dep of derivedFrom.value) {
        if (!memory.get(dep)) {
          refusal = { code: 'unknown_memory', message: `Cannot derive from unknown memory record: ${dep}` };
          return;
        }
      }
      try {
        const record = memory.record({
          kind: input.kind,
          title: title.value!,
          body: body.value!,
          status,
          recorded,
          recordedBy: input.requestedBy,
          project: project.value!,
          missionId,
          projectId,
          taskId,
          derivedFrom: derivedFrom.value,
          related: related.value,
          sourceRefs: sourceRefs.value,
          tags: tags.value,
          supersedes,
          privacy,
          idempotencyKey,
        });
        recordedId = record.id;
      } catch (error) {
        const message = errorMessage(error);
        refusal = {
          code: message.startsWith('Invalid memory record') ? 'invalid_input' : 'memory_conflict',
          message,
        };
        return;
      }
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'memory_recorded',
        payload: {
          memoryId: recordedId,
          memoryKind: input.kind,
          supersedes,
          executable: false,
        },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    if (dedupedTo) {
      return ok({ record: memoryBrowserView(memory.get(dedupedTo)!), deduplicated: true });
    }
    return ok({ record: memoryBrowserView(memory.get(recordedId!)!), deduplicated: false });
  }

  /** One record by id, or null (including over a pre-Phase-5 read-only file). */
  getMemoryRecord(id: string): MemoryBrowserView | null {
    if (!id || !this.#memory) return null;
    const record = this.#memory.get(id);
    return record ? memoryBrowserView(record) : null;
  }

  /**
   * Browser-safe memory listing, newest recorded first. Empty over a
   * pre-Phase-5 file — zero records means zero records; nothing is invented.
   * Privacy is NOT filtered here: the Founder-gated route may show
   * founder_only, the snapshot artifact excludes it — each reading layer
   * enforces its own disclosure, per the schema's stated rule.
   */
  listMemory(filter?: {
    kind?: MemoryKind;
    status?: ArchiveStatus;
    missionId?: string;
    projectId?: string;
    taskId?: string;
    project?: string;
  }): MemoryBrowserView[] {
    if (!this.#memory) return [];
    let records = this.#memory.listAll();
    if (filter?.kind) records = records.filter((r) => r.kind === filter.kind);
    if (filter?.status) records = records.filter((r) => r.status === filter.status);
    if (filter?.missionId) records = records.filter((r) => r.missionId === filter.missionId);
    if (filter?.projectId) records = records.filter((r) => r.projectId === filter.projectId);
    if (filter?.taskId) records = records.filter((r) => r.taskId === filter.taskId);
    if (filter?.project) records = records.filter((r) => r.project === filter.project);
    return records
      .sort((a, b) => b.recorded.date.localeCompare(a.recorded.date) || a.id.localeCompare(b.id))
      .map(memoryBrowserView);
  }

  /**
   * Deterministic text search over memory via the EXISTING archive engine
   * (asArchiveRecord/searchMemory — no second index, no semantic scoring).
   */
  searchMemoryRecords(query: SearchQuery): { hits: { record: MemoryBrowserView; score: number }[]; total: number } {
    if (!this.#memory) return { hits: [], total: 0 };
    const all = this.#memory.listAll();
    const byProjectedId = new Map<string, CompanyMemoryRecord>(all.map((r) => [`memory-${r.id}`, r]));
    const hits = searchMemory(all, query).flatMap((hit) => {
      const record = byProjectedId.get(hit.record.id);
      return record ? [{ record: memoryBrowserView(record), score: hit.score }] : [];
    });
    return { hits, total: hits.length };
  }

  /**
   * Mission-scoped context: the canonical mission (its existing browser
   * projection — context invents no second projection) plus entity-linked
   * memory in deterministic groups. READ-TIME composition only: this method
   * writes nothing, and re-reading the mission afterwards returns identical
   * canonical truth. Context informs; it never grants.
   */
  getMissionContext(missionId: string): OpsResult<EntityContextView<MissionBrowserView>> {
    if (!missionId) return fail('invalid_input', 'missionId is required');
    const mission = this.getMission(missionId);
    if (!mission) return fail('unknown_mission', `Unknown mission: ${missionId}`);
    const at = nowIso();
    const memory = this.#memory;
    const taskIds = mission.planItems
      .map((item) => item.taskId)
      .filter((taskId): taskId is string => taskId != null);
    const groups = assembleMemoryGroups({
      direct: memory?.listByMissionId(missionId) ?? [],
      directLinkage: 'mission',
      taskLinked: memory ? taskIds.flatMap((taskId) => memory.listByTaskId(taskId)) : [],
      projectLinked:
        memory && mission.projectId ? memory.listByProjectRef(mission.projectId) : [],
      lookup: (id) => memory?.get(id) ?? null,
    });
    return ok({
      scope: 'mission',
      entityId: missionId,
      assembledAt: at,
      entity: {
        provenance: {
          mode: 'live',
          source: 'hq_missions via HeadquarterOperations.getMission (canonical aggregate, browser projection)',
          asOf: at,
        },
        data: missionBrowserView(mission),
      },
      memory: { provenance: memoryContextProvenance(`mission ${missionId}`, at), data: groups },
    });
  }

  /** Project-scoped context — direct project-linked memory plus the one-hop related walk. */
  getProjectContext(projectId: string): OpsResult<EntityContextView<ProjectBrowserView>> {
    if (!projectId) return fail('invalid_input', 'projectId is required');
    const project = this.getProject(projectId);
    if (!project) return fail('unknown_project', `Unknown project: ${projectId}`);
    const at = nowIso();
    const memory = this.#memory;
    const groups = assembleMemoryGroups({
      direct: memory?.listByProjectRef(projectId) ?? [],
      directLinkage: 'project',
      lookup: (id) => memory?.get(id) ?? null,
    });
    return ok({
      scope: 'project',
      entityId: projectId,
      assembledAt: at,
      entity: {
        provenance: {
          mode: 'live',
          source: 'hq_projects via HeadquarterOperations.getProject (canonical register, browser projection)',
          asOf: at,
        },
        data: projectBrowserView(project),
      },
      memory: { provenance: memoryContextProvenance(`project ${projectId}`, at), data: groups },
    });
  }

  /**
   * Task-scoped context. The canonical element is a MINIMAL browser-safe ref
   * — id, capability, status, createdAt — never the payload (the snapshot's
   * no-task-payload rule applies to context too).
   */
  getTaskContext(taskId: string): OpsResult<EntityContextView<TaskContextRef>> {
    if (!taskId) return fail('invalid_input', 'taskId is required');
    const row = this.#db
      .prepare(`SELECT id, capability_id, status, created_at FROM op_tasks WHERE id = ?`)
      .get(taskId) as
      | { id: string; capability_id: string; status: string; created_at: string }
      | undefined;
    if (!row) return fail('unknown_task', `Unknown task: ${taskId}`);
    const at = nowIso();
    const memory = this.#memory;
    const groups = assembleMemoryGroups({
      direct: memory?.listByTaskId(taskId) ?? [],
      directLinkage: 'task',
      lookup: (id) => memory?.get(id) ?? null,
    });
    return ok({
      scope: 'task',
      entityId: taskId,
      assembledAt: at,
      entity: {
        provenance: {
          mode: 'live',
          source: 'op_tasks minimal browser-safe columns (id, capability, status, createdAt — never the payload)',
          asOf: at,
        },
        data: {
          taskId: row.id,
          capabilityId: row.capability_id,
          status: row.status as ActivityStatus,
          createdAt: row.created_at,
        },
      },
      memory: { provenance: memoryContextProvenance(`task ${taskId}`, at), data: groups },
    });
  }

  /**
   * Whether this database carries the Phase 5 memory schema. False only for
   * a read-only handle over a pre-Phase-5 file; memory reads then answer
   * empty/null and the snapshot's memory provenance states the absence.
   */
  memoryStorePresent(): boolean {
    return this.#memoryStorePresent;
  }

  // ---- truth + evidence (Phase 7 — the truth/evidence projection) ----

  /**
   * Record one truth record — a CLAIMED or OBSERVED statement about a
   * canonical entity — the one write path into `hq_truth_records` from the
   * application layer.
   *
   * A truth record is a projection over evidence, never authority and never
   * execution: it changes no task status, burns no approval, dispatches
   * nothing, and no gate anywhere reads it. It is born `claimed` or
   * `observed` and can NEVER upgrade itself — `verified` and `accepted` are
   * derived from OTHER actors' records (`verifyTruth`, `acceptTruth`).
   *
   * Order (the recordMemory shape): bounds/vocabulary → actor gate (a
   * resolved worker or human holding `hq.truth_record`; `system` refused) →
   * capability trio (fail closed, never repaired) → subject existence (AFTER
   * authority — no existence oracle) → secret scan → derived idempotency key
   * → ONE IMMEDIATE reserve transaction: dedupe read, every evidence ref
   * must EXIST in `op_evidence` (fail closed), every related record must
   * exist and privacy must not leak downward, supersession authority, then
   * insert + stated relations + hq_events audit + op_evidence
   * `truth_recorded`, atomically.
   */
  recordTruth(input: {
    entityKind: TruthEntityKind;
    entityId: string;
    statement: string;
    /** Birth state, default `claimed`. `observed` requires at least one evidence ref. */
    bornState?: TruthBornState;
    /** `op_evidence` ids. References only — a truth record never carries an evidence body. */
    evidenceRefs?: string[];
    supports?: string[];
    contradicts?: string[];
    derivedFrom?: string[];
    supersedes?: string;
    privacy?: MemoryPrivacy;
    /** Resolved actor id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ record: TruthRecordView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    if (!isTruthEntityKind(input.entityKind)) {
      return fail('invalid_input', `entityKind must be one of: ${TRUTH_ENTITY_KINDS.join(', ')}`);
    }
    const bornState = input.bornState ?? 'claimed';
    if (!isTruthBornState(bornState)) {
      return fail(
        'invalid_input',
        `bornState must be one of: ${TRUTH_BORN_STATES.join(', ')} — verified and accepted are derived, never asserted`,
      );
    }
    const privacy = input.privacy ?? 'internal';
    if (!isMemoryPrivacy(privacy)) {
      return fail('invalid_input', `privacy must be one of: ${MEMORY_PRIVACY_LEVELS.join(', ')}`);
    }
    const entityId = missionText('entityId', input.entityId, MAX_TRUTH_ENTITY_ID_LENGTH, true);
    if (!entityId.ok) return fail('invalid_input', entityId.message);
    const statement = missionText('statement', input.statement, MAX_TRUTH_STATEMENT_LENGTH, true);
    if (!statement.ok) return fail('invalid_input', statement.message);
    const evidenceRefs = truthIdList('evidenceRefs', input.evidenceRefs);
    if (!evidenceRefs.ok) return fail('invalid_input', evidenceRefs.message);
    const supports = truthIdList('supports', input.supports);
    if (!supports.ok) return fail('invalid_input', supports.message);
    const contradicts = truthIdList('contradicts', input.contradicts);
    if (!contradicts.ok) return fail('invalid_input', contradicts.message);
    const derivedFrom = truthIdList('derivedFrom', input.derivedFrom);
    if (!derivedFrom.ok) return fail('invalid_input', derivedFrom.message);
    const supersedes = input.supersedes?.trim() || null;
    if (bornState === 'observed' && evidenceRefs.value.length === 0) {
      return fail(
        'invalid_input',
        'an observation must reference at least one existing evidence entry; a statement with no evidence is a claim',
      );
    }
    if (supports.value.some((id) => contradicts.value.includes(id))) {
      return fail('invalid_input', 'a record cannot both support and contradict the same record');
    }
    if (supersedes && (supports.value.includes(supersedes) || contradicts.value.includes(supersedes))) {
      return fail('invalid_input', 'a record cannot supersede a record it also supports or contradicts');
    }

    const refusedActor = this.#resolveTruthActor(input.requestedBy, 'record truth', TRUTH_RECORD_CAPABILITY.id);
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#truthRecordCapabilityGate('record truth');
    if (refusedCapability) return refusedCapability;
    if (!this.#truthStorePresent) return fail('invalid_input', 'truth store unavailable on this database handle');

    // Subject existence, probed only AFTER the authority gates above.
    const subject = this.#truthSubject(input.entityKind, entityId.value!);
    if (!subject.exists) {
      return fail('unknown_entity', `Unknown ${input.entityKind}: ${entityId.value}`, {
        entityKind: input.entityKind,
        entityId: entityId.value,
      });
    }
    if (subject.founderOnly && privacy !== 'founder_only') {
      return fail(
        'invalid_input',
        `a truth record about founder_only ${input.entityKind} ${entityId.value} must itself be founder_only`,
      );
    }
    try {
      assertNoSecretLikeContent({ statement: statement.value });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    const idempotencyKey = truthRecordIdempotencyKey({
      requestedBy: input.requestedBy,
      entityKind: input.entityKind,
      entityId: entityId.value!,
      statement: statement.value!,
      bornState,
      evidenceRefs: evidenceRefs.value,
      privacy,
      supersedes,
      supports: supports.value,
      contradicts: contradicts.value,
      derivedFrom: derivedFrom.value,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let recordedId: string | null = null;
    privileged.reserve(() => {
      const existing = this.#db
        .prepare(`SELECT id FROM hq_truth_records WHERE idempotency_key = ?`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      // Every evidence ref must name a REAL op_evidence entry — fail closed.
      const missingEvidence = this.#missingEvidenceIds(evidenceRefs.value);
      if (missingEvidence.length > 0) {
        refusal = {
          code: 'unknown_evidence',
          message: `Unknown evidence id(s): ${missingEvidence.join(', ')} — a truth record may only reference evidence that exists`,
          details: { missing: missingEvidence },
        };
        return;
      }
      const graph = loadTruthGraph(this.#db);
      const byId = new Map(graph.records.map((r) => [r.id, r]));
      const related = [
        ...supports.value.map((id) => ({ id, via: 'supports' })),
        ...contradicts.value.map((id) => ({ id, via: 'contradicts' })),
        ...derivedFrom.value.map((id) => ({ id, via: 'derivedFrom' })),
        ...(supersedes ? [{ id: supersedes, via: 'supersedes' }] : []),
      ];
      for (const { id, via } of related) {
        const target = byId.get(id);
        if (!target) {
          refusal = { code: 'unknown_truth', message: `Unknown truth record in ${via}: ${id}` };
          return;
        }
        if (target.privacy === 'founder_only' && privacy !== 'founder_only') {
          refusal = {
            code: 'invalid_input',
            message: `a record that ${via} founder_only truth record ${id} must itself be founder_only`,
          };
          return;
        }
      }
      if (supersedes) {
        const predecessor = byId.get(supersedes)!;
        if (predecessor.entityKind !== input.entityKind || predecessor.entityId !== entityId.value) {
          refusal = {
            code: 'truth_conflict',
            message: `Cannot supersede ${supersedes}: it is about ${predecessor.entityKind} ${predecessor.entityId}, not ${input.entityKind} ${entityId.value}`,
          };
          return;
        }
        const alreadyBy = graph.records.find((r) => r.supersedes === supersedes);
        if (alreadyBy) {
          refusal = {
            code: 'truth_conflict',
            message: `Cannot supersede ${supersedes}: already superseded by ${alreadyBy.id}. Contradict or supersede that record instead — history is never rewritten.`,
          };
          return;
        }
        // Superseding a record that was EVER verified or EVER accepted
        // displaces truth that other actors established; only the canonical
        // Founder gate may do that. Read from the immutable rows
        // (`establishedTruthTier`), NOT from the derived `state`: a later
        // refutation or contest lowers the state a record presents, and it
        // must never lower the authority needed to retire that record.
        const tier = establishedTruthTier(predecessor, graph);
        if (tier !== null) {
          const gate = this.#assertApprovalAuthority(
            input.requestedBy,
            `supersede ${tier} truth record ${supersedes}`,
          );
          if (gate && !gate.ok) {
            refusal = gate.error;
            return;
          }
        }
      }
      const id = uuid();
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_truth_records (id, entity_kind, entity_id, statement, born_state, recorded_by,
             recorded_at, evidence_refs, privacy, supersedes, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.entityKind,
          entityId.value,
          statement.value,
          bornState,
          input.requestedBy,
          at,
          JSON.stringify(evidenceRefs.value),
          privacy,
          supersedes,
          idempotencyKey,
        );
      const insertRelation = this.#db.prepare(
        `INSERT INTO hq_truth_relations (id, from_id, kind, to_kind, to_id, recorded_by, recorded_at)
         VALUES (?, ?, ?, 'truth', ?, ?, ?)`,
      );
      for (const toId of supports.value) insertRelation.run(uuid(), id, 'supports', toId, input.requestedBy, at);
      for (const toId of contradicts.value) {
        insertRelation.run(uuid(), id, 'contradicts', toId, input.requestedBy, at);
      }
      for (const toId of derivedFrom.value) {
        insertRelation.run(uuid(), id, 'derived_from', toId, input.requestedBy, at);
      }
      if (supersedes) insertRelation.run(uuid(), id, 'supersedes', supersedes, input.requestedBy, at);
      recordedId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `truth:${id}`,
        status: null,
        actor: input.requestedBy,
        summary: `Truth ${bornState}: ${input.entityKind} ${entityId.value}`,
        detail: { bornState, entityKind: input.entityKind, entityId: entityId.value, supersedes },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'truth_recorded',
        payload: {
          truthId: id,
          bornState,
          entityKind: input.entityKind,
          entityId: entityId.value,
          evidenceRefs: evidenceRefs.value,
          supersedes,
          contradicts: contradicts.value,
          executable: false,
        },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    if (dedupedTo) return ok({ record: this.#deriveTruthById(dedupedTo)!, deduplicated: true });
    return ok({ record: this.#deriveTruthById(recordedId!)!, deduplicated: false });
  }

  /**
   * Record one VERIFICATION over an existing truth record — the only way a
   * `claimed`/`observed` record becomes `verified` (derived: at least one
   * `confirmed` verdict and no `refuted` one).
   *
   * Real verification authority: the actor must resolve (worker or human)
   * and hold `hq.truth_verify` from its registry, the capability trio must
   * be intact, and the actor must NOT be the one who recorded the target —
   * a claim never verifies itself, and its author never verifies it. Every
   * verification carries verifier, target, method, evidence refs (which
   * must exist), timestamp, verdict and stated limitations. A `refuted`
   * verdict never erases anything: the record stays, visibly refuted.
   */
  verifyTruth(input: {
    truthId: string;
    method: VerificationMethod;
    verdict: VerificationVerdict;
    evidenceRefs: string[];
    limitations: string;
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ verification: TruthVerificationView; record: TruthRecordView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const truthId = input.truthId?.trim() ?? '';
    if (!truthId) return fail('invalid_input', 'truthId is required');
    if (!isVerificationMethod(input.method)) {
      return fail('invalid_input', `method must be one of: ${VERIFICATION_METHODS.join(', ')}`);
    }
    if (!isVerificationVerdict(input.verdict)) {
      return fail('invalid_input', `verdict must be one of: ${VERIFICATION_VERDICTS.join(', ')}`);
    }
    const evidenceRefs = truthIdList('evidenceRefs', input.evidenceRefs);
    if (!evidenceRefs.ok) return fail('invalid_input', evidenceRefs.message);
    if (evidenceRefs.value.length === 0) {
      return fail('invalid_input', 'a verification must reference at least one existing evidence entry');
    }
    const limitations = missionText('limitations', input.limitations, MAX_VERIFICATION_LIMITATIONS_LENGTH, true);
    if (!limitations.ok) {
      return fail(
        'invalid_input',
        `${limitations.message} — every verification states its limitations; write "none known" if that is the honest answer`,
      );
    }

    const refusedActor = this.#resolveTruthActor(input.requestedBy, 'verify truth', TRUTH_VERIFY_CAPABILITY.id);
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#truthVerifyCapabilityGate('verify truth');
    if (refusedCapability) return refusedCapability;
    if (!this.#truthStorePresent) return fail('invalid_input', 'truth store unavailable on this database handle');
    try {
      assertNoSecretLikeContent({ limitations: limitations.value });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }

    const idempotencyKey = truthVerificationIdempotencyKey({
      verifiedBy: input.requestedBy,
      truthId,
      method: input.method,
      verdict: input.verdict,
      evidenceRefs: evidenceRefs.value,
      limitations: limitations.value!,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let verificationId: string | null = null;
    privileged.reserve(() => {
      const target = this.#db.prepare(`SELECT * FROM hq_truth_records WHERE id = ?`).get(truthId) as
        | Record<string, unknown>
        | undefined;
      if (!target) {
        refusal = { code: 'unknown_truth', message: `Unknown truth record: ${truthId}` };
        return;
      }
      const existing = this.#db
        .prepare(`SELECT id FROM hq_truth_verifications WHERE idempotency_key = ?`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      if ((target.recorded_by as string) === input.requestedBy) {
        refusal = {
          code: 'not_permitted',
          message: `${input.requestedBy} recorded truth record ${truthId} and cannot verify it: a claim never upgrades itself`,
          details: { actor: input.requestedBy },
        };
        return;
      }
      const successor = this.#db
        .prepare(`SELECT id FROM hq_truth_records WHERE supersedes = ?`)
        .get(truthId) as { id: string } | undefined;
      if (successor) {
        refusal = {
          code: 'truth_conflict',
          message: `Truth record ${truthId} is superseded by ${successor.id}; verify the current record instead`,
        };
        return;
      }
      const missingEvidence = this.#missingEvidenceIds(evidenceRefs.value);
      if (missingEvidence.length > 0) {
        refusal = {
          code: 'unknown_evidence',
          message: `Unknown evidence id(s): ${missingEvidence.join(', ')} — a verification may only reference evidence that exists`,
          details: { missing: missingEvidence },
        };
        return;
      }
      const id = uuid();
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_truth_verifications (id, truth_id, verified_by, at, method, verdict, evidence_refs,
             limitations, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          truthId,
          input.requestedBy,
          at,
          input.method,
          input.verdict,
          JSON.stringify(evidenceRefs.value),
          limitations.value,
          idempotencyKey,
        );
      this.#db
        .prepare(
          `INSERT INTO hq_truth_relations (id, from_id, kind, to_kind, to_id, recorded_by, recorded_at)
           VALUES (?, ?, 'verified_by', 'verification', ?, ?, ?)`,
        )
        .run(uuid(), truthId, id, input.requestedBy, at);
      verificationId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `truth:${truthId}`,
        status: null,
        actor: input.requestedBy,
        summary: `Truth verification ${input.verdict}: ${truthId}`,
        detail: { verificationId: id, method: input.method, verdict: input.verdict },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'truth_verified',
        payload: {
          truthId,
          verificationId: id,
          method: input.method,
          verdict: input.verdict,
          evidenceRefs: evidenceRefs.value,
          executable: false,
        },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    const record = this.#deriveTruthById(truthId)!;
    const id = dedupedTo ?? verificationId!;
    return ok({
      verification: record.verifications.find((v) => v.id === id)!,
      record,
      deduplicated: dedupedTo !== null,
    });
  }

  /**
   * Founder ACCEPTANCE of a verified truth record — the only way a record
   * becomes `accepted`, and an explicit Founder-gated act on the canonical
   * mechanics (nothing parallel):
   *
   * - `#assertApprovalAuthority`: the SAME positive Founder gate approve/deny
   *   and the kill switch use — a registered, active human principal holding
   *   approval authority; workers, `system` and unknown ids refused, audited;
   * - `expectedDigest`: the approve-route rule — the Founder accepts exactly
   *   the basis the console showed; a moved basis refuses before any row;
   * - independence: the acceptor is neither the record's author nor any of
   *   its confirming verifiers (the requester-cannot-approve rule);
   * - the record must be exactly `verified` (derived through the PRIVATE
   *   enforcement-safe read, never a public projection), current, and free
   *   of unresolved contradictions — a contested record is refused, so the
   *   Founder resolves the contradiction explicitly rather than by accepting
   *   one side while the other still stands;
   * - an acceptance already on file deduplicates (same acceptor) or conflicts
   *   (another) ONLY while it still stands (`acceptanceStanding`); once a
   *   later refutation, supersession or contest lowered it, the request is
   *   judged on the record's current standing through the same ladder and
   *   refused there — "it was accepted before" is never a shortcut, and the
   *   engine's one-acceptance index means no second row can ever exist;
   * - the route additionally demands STEP-UP (live/control-api.ts).
   *
   * Acceptance executes nothing: no task, approval row, claim or dispatch is
   * touched, and no gate reads the acceptance to decide anything.
   */
  acceptTruth(input: {
    truthId: string;
    expectedDigest: string;
    note?: string;
    requestedBy: string;
  }): OpsResult<{ acceptance: TruthAcceptanceView; record: TruthRecordView; deduplicated: boolean }> {
    const truthId = input.truthId?.trim() ?? '';
    if (!truthId) return fail('invalid_input', 'truthId is required');
    const gate = this.#assertApprovalAuthority(input.requestedBy, 'accept a truth record');
    if (gate) return gate;
    if (!this.#truthStorePresent) return fail('invalid_input', 'truth store unavailable on this database handle');
    const note = missionText('note', input.note, MAX_ACCEPTANCE_NOTE_LENGTH, false);
    if (!note.ok) return fail('invalid_input', note.message);
    if (note.value) {
      try {
        assertNoSecretLikeContent({ note: note.value });
      } catch {
        return fail(
          'invalid_input',
          'The acceptance note looks like it contains a credential. Notes are stored permanently, so nothing was accepted.',
        );
      }
    }

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let acceptanceId: string | null = null;
    privileged.reserve(() => {
      // Re-derived INSIDE the write lock through the private path: the
      // decision below reads canonical rows, never a public read surface.
      const view = this.#deriveTruthById(truthId);
      if (!view) {
        refusal = { code: 'unknown_truth', message: `Unknown truth record: ${truthId}` };
        return;
      }
      const prior = view.acceptances[0];
      if (prior && view.acceptanceStanding === 'standing') {
        if (prior.acceptedBy === input.requestedBy) {
          dedupedTo = prior.id;
          return;
        }
        refusal = {
          code: 'truth_conflict',
          message: `Truth record ${truthId} is already accepted by ${prior.acceptedBy}; acceptance is one explicit act, never repeated`,
        };
        return;
      }
      // An acceptance that no longer STANDS (a later refutation, supersession
      // or contest) is never a shortcut: the request falls through to the
      // ordinary ladder below and is refused on the record's CURRENT
      // standing — one status per cause, exactly as a never-accepted record
      // in the same shape — never answered "already accepted".
      if (view.lifecycle === 'superseded') {
        refusal = {
          code: 'truth_conflict',
          message: `Truth record ${truthId} is superseded by ${view.supersededBy}; a superseded record cannot be accepted`,
        };
        return;
      }
      if (view.state !== 'verified') {
        refusal = {
          code: 'truth_not_verified',
          message:
            `Truth record ${truthId} is ${view.state} (verification: ${view.verification}); ` +
            'only a verified record can be accepted, and nothing here verifies it',
          details: { state: view.state, verification: view.verification, acceptanceStanding: view.acceptanceStanding },
        };
        return;
      }
      if (view.contested) {
        refusal = {
          code: 'truth_contested',
          message:
            `Truth record ${truthId} has an unresolved contradiction with ` +
            `${view.contradictions
              .filter((c) => c.resolution === 'unresolved')
              .map((c) => c.withId)
              .join(', ')}; resolve it explicitly (supersede or refute) before accepting`,
        };
        return;
      }
      if (view.recordedBy === input.requestedBy) {
        refusal = {
          code: 'not_permitted',
          message: `${input.requestedBy} recorded truth record ${truthId} and cannot accept it`,
          details: { actor: input.requestedBy },
        };
        return;
      }
      const confirming = view.verifications.filter((v) => v.verdict === 'confirmed');
      if (confirming.some((v) => v.verifiedBy === input.requestedBy)) {
        refusal = {
          code: 'not_permitted',
          message: `${input.requestedBy} verified truth record ${truthId} and cannot also accept it: verification and acceptance are separate authorities`,
          details: { actor: input.requestedBy },
        };
        return;
      }
      if (prior) {
        // Unreachable by derivation (a degraded acceptance always fails one of
        // the checks above) and closed by the engine's one-acceptance index
        // regardless; stated so no future reordering can insert a second row.
        refusal = {
          code: 'truth_conflict',
          message: `Truth record ${truthId} already carries an acceptance by ${prior.acceptedBy} (standing: ${view.acceptanceStanding}); acceptance is one explicit act, never repeated`,
        };
        return;
      }
      if (!input.expectedDigest || input.expectedDigest !== view.acceptanceDigest) {
        privileged.appendEvidence({
          actor: input.requestedBy,
          kind: 'truth_acceptance_refused_basis_changed',
          payload: { truthId, expected: input.expectedDigest ?? null, current: view.acceptanceDigest },
        });
        refusal = {
          code: 'action_digest_mismatch',
          message: `Truth record ${truthId}: the verification basis changed since it was presented; nothing was accepted`,
          details: { expected: input.expectedDigest ?? null, current: view.acceptanceDigest },
        };
        return;
      }
      const id = uuid();
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_truth_acceptances (id, truth_id, accepted_by, at, digest, verification_ids, note)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          truthId,
          input.requestedBy,
          at,
          view.acceptanceDigest,
          JSON.stringify(confirming.map((v) => v.id)),
          note.value,
        );
      this.#db
        .prepare(
          `INSERT INTO hq_truth_relations (id, from_id, kind, to_kind, to_id, recorded_by, recorded_at)
           VALUES (?, ?, 'accepted_by', 'acceptance', ?, ?, ?)`,
        )
        .run(uuid(), truthId, id, input.requestedBy, at);
      acceptanceId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `truth:${truthId}`,
        status: null,
        actor: input.requestedBy,
        summary: `Truth accepted: ${truthId}`,
        detail: { acceptanceId: id, digest: view.acceptanceDigest },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'truth_accepted',
        payload: {
          truthId,
          acceptanceId: id,
          digest: view.acceptanceDigest,
          verificationIds: confirming.map((v) => v.id),
          executable: false,
        },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    const record = this.#deriveTruthById(truthId)!;
    const id = dedupedTo ?? acceptanceId!;
    return ok({
      acceptance: record.acceptances.find((a) => a.id === id)!,
      record,
      deduplicated: dedupedTo !== null,
    });
  }

  /** One record's derived view, or null (including over a pre-Phase-7 read-only file). */
  getTruthRecord(id: string): TruthRecordView | null {
    if (!id || !this.#truthStorePresent) return null;
    return this.#deriveTruthById(id);
  }

  /**
   * Every truth record, newest first, with its derived state. Privacy is NOT
   * filtered here (the memory rule): the Founder-gated route may show
   * founder_only, the snapshot artifact excludes it — each reading layer
   * enforces its own disclosure.
   */
  listTruth(filter?: {
    entityKind?: TruthEntityKind;
    entityId?: string;
    state?: TruthState;
    lifecycle?: 'current' | 'superseded';
  }): TruthRecordView[] {
    if (!this.#truthStorePresent) return [];
    let views = [...this.#deriveAllTruth(loadTruthGraph(this.#db)).values()];
    if (filter?.entityKind) views = views.filter((v) => v.entityKind === filter.entityKind);
    if (filter?.entityId) views = views.filter((v) => v.entityId === filter.entityId);
    if (filter?.state) views = views.filter((v) => v.state === filter.state);
    if (filter?.lifecycle) views = views.filter((v) => v.lifecycle === filter.lifecycle);
    return views.sort((a, b) => b.seq - a.seq);
  }

  /**
   * Entity truth: the current records, the full history (oldest first,
   * bounded with the true total), the headline state and every unresolved
   * contradiction touching the entity. Read-time composition; writes nothing.
   */
  getEntityTruth(
    entityKind: TruthEntityKind,
    entityId: string,
    options: { limit?: number } = {},
  ): OpsResult<EntityTruthView> {
    if (!isTruthEntityKind(entityKind)) {
      return fail('invalid_input', `entityKind must be one of: ${TRUTH_ENTITY_KINDS.join(', ')}`);
    }
    if (!entityId) return fail('invalid_input', 'entityId is required');
    if (!this.#truthSubject(entityKind, entityId).exists) {
      return fail('unknown_entity', `Unknown ${entityKind}: ${entityId}`, { entityKind, entityId });
    }
    const at = nowIso();
    const limit = options.limit ?? TRUTH_SNAPSHOT_LIMIT;
    const graph = this.#truthStorePresent ? loadTruthGraph(this.#db) : emptyTruthGraph();
    const all = this.#deriveAllTruth(graph);
    const history = [...all.values()]
      .filter((v) => v.entityKind === entityKind && v.entityId === entityId)
      .sort((a, b) => a.seq - b.seq);
    const current = history.filter((v) => v.lifecycle === 'current');
    const ids = new Set(history.map((v) => v.id));
    const unresolved = listContradictions(graph, (id) => all.get(id) ?? null).filter(
      (pair) => pair.resolution === 'unresolved' && (ids.has(pair.a) || ids.has(pair.b)),
    );
    return ok({
      entityKind,
      entityId,
      currentState: entityCurrentState(current),
      current,
      history: history.slice(Math.max(0, history.length - limit)),
      total: history.length,
      truncated: history.length > limit,
      unresolvedContradictions: unresolved,
      provenance: {
        mode: 'live',
        source:
          'hq_truth_records / hq_truth_verifications / hq_truth_acceptances / hq_truth_relations via ' +
          'HeadquarterOperations (derived projection; evidence ids reference op_evidence)',
        asOf: at,
      },
    });
  }

  /** Every stated contradiction, judged — unresolved ones stay visible here until an explicit act settles them. */
  listTruthContradictions(): TruthContradictionPair[] {
    if (!this.#truthStorePresent) return [];
    const graph = loadTruthGraph(this.#db);
    const all = this.#deriveAllTruth(graph);
    return listContradictions(graph, (id) => all.get(id) ?? null);
  }

  /**
   * The bounded snapshot view. The reading layer's privacy decision is made
   * by the caller (`includeFounderOnly`); withheld rows stay in `total` and
   * are counted in `withheldFounderOnly`, and NOTHING else is aggregated over
   * them (review round 2): `byState`, `unresolvedContradictions` and
   * `awaitingAcceptance` span the set the reader may see, so arithmetic on
   * the artifact discloses no categorical fact about a private record.
   *
   * The records and the contradictions are read through the PRIVATE
   * derivation over the canonical graph, not through the public
   * `listTruth()` / `listTruthContradictions()` projections (Phase 10
   * correction — carry-forward base debt, the same shape as the Phase 9
   * High). This read decides an UNAUTHENTICATED disclosure: a same-realm
   * patch that wrapped the public method and relabelled `privacy` on the
   * real rows would otherwise publish a genuine founder_only statement AND
   * zero the `withheldFounderOnly` field beside it. `listTruth()` is
   * unchanged; it stays the Founder-gated route's projection.
   */
  truthSummary(options: { includeFounderOnly: boolean; limit?: number }): TruthSnapshotView {
    const limit = options.limit ?? TRUTH_SNAPSHOT_LIMIT;
    const graph = this.#truthStorePresent ? loadTruthGraph(this.#db) : emptyTruthGraph();
    const derived = this.#truthStorePresent ? this.#deriveAllTruth(graph) : new Map<string, TruthRecordView>();
    const all = [...derived.values()].sort((a, b) => b.seq - a.seq);
    const founderOnlyIds = new Set(all.filter((v) => v.privacy === 'founder_only').map((v) => v.id));
    const isFounderOnly = (id: string) => founderOnlyIds.has(id);
    const visible = options.includeFounderOnly ? all : all.filter((v) => !isFounderOnly(v.id));
    // A carried PUBLIC record still names its founder_only counterparts by id
    // through its relations; for a reader without the Founder gate those ids
    // are withheld too (and counted), never just the records.
    let withheldRelations = 0;
    const carried = visible.slice(0, limit).map((view) => {
      if (options.includeFounderOnly) return view;
      const projected = withholdFounderOnlyRelations(view, isFounderOnly);
      withheldRelations += projected.withheld;
      return projected.view;
    });
    // Aggregates over the FULL visible set (not the carried page), never over
    // withheld rows.
    const byState: Record<TruthState, number> = { claimed: 0, observed: 0, verified: 0, accepted: 0 };
    let awaitingAcceptance = 0;
    for (const view of visible) {
      // The CURRENT derived state: an acceptance that no longer stands is
      // counted under what the record derives now, never under `accepted`.
      byState[view.state] += 1;
      // Verified, current and uncontested — exactly the records the server
      // issued an acceptance digest for. A degraded acceptance never gets one.
      if (view.acceptanceDigest !== null) awaitingAcceptance += 1;
    }
    const unresolved = listContradictions(graph, (id) => derived.get(id) ?? null).filter((pair) => {
      if (pair.resolution !== 'unresolved') return false;
      if (options.includeFounderOnly) return true;
      return !isFounderOnly(pair.a) && !isFounderOnly(pair.b);
    });
    return {
      total: all.length,
      byState,
      unresolvedContradictions: unresolved.length,
      awaitingAcceptance,
      withheldFounderOnly: all.length - visible.length,
      withheldFounderOnlyRelations: withheldRelations,
      records: carried,
      contradictions: unresolved.slice(0, limit),
    };
  }

  /** Whether this database carries the Phase 7 truth schema (false only for a read-only pre-Phase-7 file). */
  truthStorePresent(): boolean {
    return this.#truthStorePresent;
  }

  /**
   * Actor resolution for the two truth capabilities. Unlike the Founder-gate
   * trio, a WORKER may hold these (a reviewer worker verifies a builder's
   * claim) — but only through its directory grant, never by self-assertion,
   * and `system` is refused outright because an unattributed truth act is
   * exactly the fabrication this phase exists to make impossible.
   */
  #resolveTruthActor(actor: string, action: string, capabilityId: string): OpsResult<never> | null {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}: a resolved worker or human principal is required`);
    }
    const resolved = this.#resolveRequester(actor, action);
    if (!resolved.ok) return resolved;
    if (!resolved.data.allowedCapabilities.includes(capabilityId)) {
      return fail(
        'not_permitted',
        `${actor} may not ${action}: ${
          resolved.data.kind === 'worker' ? 'the worker directory grants' : 'the principal holds'
        } no ${capabilityId}`,
        { actor },
      );
    }
    return null;
  }

  #truthRecordCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      TRUTH_RECORD_CAPABILITY.id,
      truthRecordCapabilityState,
      truthRecordContractDrift,
      'recording truth',
    );
  }

  #truthVerifyCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      TRUTH_VERIFY_CAPABILITY.id,
      truthVerifyCapabilityState,
      truthVerifyContractDrift,
      'verifying truth',
    );
  }

  /** Which of these ids name no op_evidence entry. Reads the canonical chain table directly. */
  #missingEvidenceIds(ids: readonly string[]): string[] {
    const probe = this.#db.prepare(`SELECT 1 FROM op_evidence WHERE id = ?`);
    return ids.filter((id) => probe.get(id) === undefined);
  }

  /**
   * Does the subject exist, and is it founder_only (memory)? Reads the
   * canonical tables directly; a store absent on a read-only handle answers
   * "does not exist" truthfully rather than throwing at the first prepare.
   */
  #truthSubject(kind: TruthEntityKind, id: string): { exists: boolean; founderOnly: boolean; updatedAt: string | null; superseded: boolean } {
    const none = { exists: false, founderOnly: false, updatedAt: null, superseded: false };
    switch (kind) {
      case 'mission': {
        if (!this.#missionStorePresent) return none;
        const row = this.#db.prepare(`SELECT updated_at FROM hq_missions WHERE id = ?`).get(id) as
          | { updated_at: string }
          | undefined;
        return row ? { exists: true, founderOnly: false, updatedAt: row.updated_at, superseded: false } : none;
      }
      case 'project': {
        if (!this.#projectStorePresent) return none;
        const row = this.#db.prepare(`SELECT updated_at FROM hq_projects WHERE id = ?`).get(id) as
          | { updated_at: string }
          | undefined;
        return row ? { exists: true, founderOnly: false, updatedAt: row.updated_at, superseded: false } : none;
      }
      case 'task': {
        const row = this.#db.prepare(`SELECT updated_at FROM op_tasks WHERE id = ?`).get(id) as
          | { updated_at: string }
          | undefined;
        return row ? { exists: true, founderOnly: false, updatedAt: row.updated_at, superseded: false } : none;
      }
      case 'memory': {
        if (!this.#memoryStorePresent) return none;
        const row = this.#db.prepare(`SELECT privacy, status FROM hq_memory WHERE id = ?`).get(id) as
          | { privacy: string; status: string }
          | undefined;
        return row
          ? { exists: true, founderOnly: row.privacy === 'founder_only', updatedAt: null, superseded: row.status !== 'CURRENT' }
          : none;
      }
      case 'worker':
        return this.#db.prepare(`SELECT 1 FROM hq_specialists WHERE id = ?`).get(id) !== undefined
          ? { exists: true, founderOnly: false, updatedAt: null, superseded: false }
          : none;
      case 'capability':
        return this.#db.prepare(`SELECT 1 FROM op_capabilities WHERE id = ?`).get(id) !== undefined
          ? { exists: true, founderOnly: false, updatedAt: null, superseded: false }
          : none;
    }
  }

  /** Categorical staleness of a record against its subject's canonical row. Never a tie-breaker. */
  #truthSubjectDrift(record: TruthRecordRow): SubjectDrift {
    const subject = this.#truthSubject(record.entityKind, record.entityId);
    if (!subject.exists) return 'subject_missing';
    if (subject.superseded) return 'subject_superseded';
    if (subject.updatedAt == null) return 'not_evaluated';
    return subject.updatedAt > record.recordedAt ? 'subject_changed_since_record' : 'none';
  }

  /** Derive every record in the graph once — the one implementation every read and every gate shares. */
  #deriveAllTruth(graph: TruthGraph): Map<string, TruthRecordView> {
    const out = new Map<string, TruthRecordView>();
    for (const record of graph.records) {
      out.set(record.id, deriveTruthRecord(record, graph, this.#truthSubjectDrift(record)));
    }
    return out;
  }

  /**
   * PRIVATE, enforcement-safe derivation of one record — reads canonical rows
   * through `#db` and the module's pure function only. `acceptTruth` decides
   * on THIS; the public `getTruthRecord` merely calls it, so patching the
   * public surface changes what the patcher sees and nothing that is decided.
   */
  #deriveTruthById(id: string): TruthRecordView | null {
    const graph = loadTruthGraph(this.#db);
    const record = graph.records.find((r) => r.id === id);
    if (!record) return null;
    return deriveTruthRecord(record, graph, this.#truthSubjectDrift(record));
  }

  // ---- Phase 8: authority + risk + external action gateway ----

  /**
   * Propose one external action against a canonical task — the ONLY way an
   * action intent comes into existence. Executes nothing.
   *
   * The proposer must resolve (worker or human, never `system`) and hold the
   * task's capability from its own registry. The adapter and action type must
   * be ones this deployment was constructed with; the provider the task is
   * bound to must be the provider the adapter executes as (no substitution,
   * decided here and again at execution); every context ref must name a real
   * `op_evidence` entry or `hq_truth_records` row (referenced, never copied,
   * and never granting anything). Risk is assessed by the one deterministic
   * function from the CANONICAL capability row and the adapter's declared
   * contract — the proposer's inputs can only escalate it.
   */
  proposeAction(input: {
    taskId: string;
    adapterId: string;
    actionType: string;
    target: string;
    payload: Record<string, unknown>;
    missionId?: string;
    risk?: ActionRiskEscalations;
    contextEvidenceRefs?: string[];
    contextTruthRefs?: string[];
    /** Resolved actor id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ action: ActionView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const taskId = input.taskId?.trim() ?? '';
    if (!taskId) return fail('invalid_input', 'taskId is required');
    const adapterId = input.adapterId?.trim() ?? '';
    const actionType = input.actionType?.trim() ?? '';
    if (!adapterId || !actionType || !ACTION_TYPE_PATTERN.test(actionType)) {
      return fail('invalid_input', 'adapterId and a well-formed actionType are required');
    }
    const target = missionText('target', input.target, MAX_ACTION_TARGET_LENGTH, true);
    if (!target.ok) return fail('invalid_input', target.message);
    if (input.payload == null || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
      return fail('invalid_input', 'payload must be a plain object');
    }
    const payloadJson = canonicalJson(input.payload);
    if (payloadJson.length > MAX_ACTION_PAYLOAD_CHARS) {
      return fail('invalid_input', `payload exceeds ${MAX_ACTION_PAYLOAD_CHARS} canonical characters`);
    }
    // BOTH guards, deliberately: the evidence heuristic catches `token: value`
    // in free text, and the browser guard's KEY rule catches `{ token: '…' }`
    // as a field — which the JSON encoding hides from the first pattern. The
    // payload is stored permanently and handed verbatim to an adapter.
    try {
      assertNoSecretLikeContent(input.payload);
      assertBrowserSafe(input.payload, 'payload');
      assertBrowserSafe({ target: target.value }, 'target');
    } catch {
      return fail(
        'invalid_input',
        'The action payload or target looks like it contains a credential. An action intent is stored permanently and its digest travels to the browser, so nothing was proposed.',
      );
    }
    const escalations = input.risk ?? {};
    for (const key of ['productionScope', 'spend', 'credentialSensitivity', 'legalCompliance'] as const) {
      if (escalations[key] !== undefined && typeof escalations[key] !== 'boolean') {
        return fail('invalid_input', `risk.${key} must be a boolean`);
      }
    }
    if (escalations.blastRadius !== undefined && !isActionBlastRadius(escalations.blastRadius)) {
      return fail('invalid_input', 'risk.blastRadius must be single, many or system');
    }
    const evidenceRefs = memoryList('contextEvidenceRefs', input.contextEvidenceRefs, 200);
    if (!evidenceRefs.ok) return fail('invalid_input', evidenceRefs.message);
    const truthRefs = memoryList('contextTruthRefs', input.contextTruthRefs, 200);
    if (!truthRefs.ok) return fail('invalid_input', truthRefs.message);
    if (evidenceRefs.value.length > MAX_ACTION_CONTEXT_REFS || truthRefs.value.length > MAX_ACTION_CONTEXT_REFS) {
      return fail('invalid_input', `context refs are bounded to ${MAX_ACTION_CONTEXT_REFS} entries each`);
    }
    const missionId = input.missionId?.trim() || null;

    // Identity first: an unknown actor learns nothing about which tasks exist.
    const actor = this.#resolveActor(input.requestedBy, 'propose an external action');
    if (!actor.ok) return actor;
    if (!this.#actionStorePresent) return fail('invalid_input', 'action ledger unavailable on this database handle');

    const task = this.#taskRowFromStore(taskId);
    if (!task) return fail('unknown_task', `Unknown task: ${taskId}`);
    if (!actor.data.allowedCapabilities.includes(task.capabilityId)) {
      return fail(
        'not_permitted',
        `${input.requestedBy} may not propose an external action for ${task.capabilityId}: ${
          actor.data.kind === 'worker' ? 'the worker directory grants' : 'the principal holds'
        } no such capability`,
        { actor: input.requestedBy, capabilityId: task.capabilityId },
      );
    }
    if (task.status === 'completed' || task.status === 'blocked') {
      return fail(
        'task_not_executing',
        `Task ${taskId} is ${task.status}; no external action can be proposed for it`,
        { status: task.status },
      );
    }
    const adapter = this.#actionAdapters.get(adapterId);
    if (!adapter) return fail('unknown_adapter', `Unknown external-action adapter: ${adapterId}`);
    const contract = adapter.actions[actionType];
    if (!contract) {
      return fail('unknown_adapter', `Adapter ${adapterId} declares no action type ${actionType}`, { adapterId });
    }
    const cap = this.#capabilityFromStore(task.capabilityId);
    if (!cap) return fail('unknown_capability', `Unknown capability: ${task.capabilityId}`);
    if (!cap.enabled) return fail('capability_disabled', `Capability ${cap.id} is disabled`);

    const binding = readProviderBinding(task.payload);
    if (binding.bound && binding.provider == null) {
      return fail('provider_binding_mismatch', `Task ${taskId} declares a malformed executionProvider; nobody may act on it`);
    }
    if (binding.bound && adapter.provider !== binding.provider) {
      return fail(
        'provider_binding_mismatch',
        `Task ${taskId} is bound to provider ${binding.provider} and adapter ${adapterId} executes as ${
          adapter.provider ?? 'no provider (local)'
        }. No substitution is made.`,
        { requiredProvider: binding.provider, adapterProvider: adapter.provider },
      );
    }
    const providerId = binding.bound ? binding.provider : adapter.provider;
    const dispatched = this.#claudeDispatchState(taskId);
    if (dispatched !== 'none') {
      return fail(
        'duplicate_external_action',
        `Task ${taskId} was already handed to the Claude GitHub dispatch lane (${dispatched}); one canonical task has one external execution path`,
        { dispatch: dispatched },
      );
    }
    if (missionId) {
      const mission = this.#missionStatusFromStore(missionId);
      if (!mission) return fail('unknown_mission', `Unknown mission: ${missionId}`);
      if (isMissionTerminal(mission.status) || mission.status === 'blocked') {
        return fail('mission_not_active', `Mission ${missionId} is ${mission.status}; it directs no external action`, {
          status: mission.status,
        });
      }
      const linked = this.#db
        .prepare(`SELECT 1 FROM hq_mission_plan_items WHERE mission_id = ? AND task_id = ?`)
        .get(missionId, taskId);
      if (!linked) {
        return fail('invalid_input', `Task ${taskId} is not linked to a plan item of mission ${missionId}`);
      }
    }
    const missingEvidence = this.#missingEvidenceIds(evidenceRefs.value);
    if (missingEvidence.length > 0) {
      return fail('unknown_evidence', `Unknown evidence id(s): ${missingEvidence.join(', ')}`, { missing: missingEvidence });
    }
    if (truthRefs.value.length > 0) {
      const probe = this.#truthStorePresent ? this.#db.prepare(`SELECT 1 FROM hq_truth_records WHERE id = ?`) : null;
      const missingTruth = truthRefs.value.filter((id) => probe == null || probe.get(id) === undefined);
      if (missingTruth.length > 0) {
        return fail('unknown_truth', `Unknown truth record(s): ${missingTruth.join(', ')}`, { missing: missingTruth });
      }
    }

    const risk = assessActionRisk({
      capability: { riskClass: cap.riskClass, sideEffect: cap.sideEffect },
      contract,
      escalations: {
        productionScope: escalations.productionScope === true,
        spend: escalations.spend === true,
        credentialSensitivity: escalations.credentialSensitivity === true,
        legalCompliance: escalations.legalCompliance === true,
        blastRadius: escalations.blastRadius,
      },
    });
    const payloadDigest = actionPayloadDigest(input.payload);
    const effectBase = sideEffectKeyBase({ taskId, adapterId, actionType, target: target.value!, payloadDigest });

    const privileged = this.#requirePrivilegedQueue();
    let dedupedTo: string | null = null;
    let createdId: string | null = null;
    privileged.reserve(() => {
      // The generation is part of the dedupe key: an identical proposal
      // dedupes while the side effect's attempt stands, and derives a FRESH
      // key only after a human reconciled that attempt as not executed.
      const generation = sideEffectGeneration(this.#db, effectBase);
      const idempotencyKey = actionIdempotencyKey({
        requestedBy: input.requestedBy,
        taskId,
        adapterId,
        actionType,
        target: target.value!,
        payloadDigest,
        missionId,
        idempotencyKey: input.idempotencyKey ?? null,
      }) + `:g${generation}`;
      const existing = this.#db
        .prepare(`SELECT id FROM hq_action_intents WHERE idempotency_key = ?`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      const id = `act-${uuid()}`;
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_action_intents (id, task_id, mission_id, capability_id, provider_id, adapter_id, action_type,
             target, payload, payload_digest, risk_level, risk_factors, visibility, reversibility, compensation,
             context_evidence_refs, context_truth_refs, requested_by, requested_at, side_effect_key_base, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          taskId,
          missionId,
          cap.id,
          providerId,
          adapterId,
          actionType,
          target.value,
          payloadJson,
          payloadDigest,
          risk.level,
          JSON.stringify(risk.factors),
          contract.visibility,
          contract.reversibility,
          contract.compensation ? JSON.stringify(contract.compensation) : null,
          JSON.stringify(evidenceRefs.value),
          JSON.stringify(truthRefs.value),
          input.requestedBy,
          at,
          effectBase,
          idempotencyKey,
        );
      this.#appendActionEvent(id, 'proposed', input.requestedBy, at, {
        riskLevel: risk.level,
        riskFactors: risk.factors,
        generation,
      });
      createdId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `action:${id}`,
        status: null,
        actor: input.requestedBy,
        summary: `External action proposed: ${adapterId}/${actionType} for task ${taskId} (${risk.level})`,
        detail: { taskId, adapterId, actionType, riskLevel: risk.level, missionId },
      });
      privileged.appendEvidence({
        taskId,
        actor: input.requestedBy,
        kind: 'action_proposed',
        payload: {
          actionId: id,
          adapterId,
          actionType,
          target: target.value,
          payloadDigest,
          providerId,
          riskLevel: risk.level,
          riskFactors: risk.factors,
          reversibility: contract.reversibility,
          compensationDeclared: contract.compensation != null,
          contextEvidenceRefs: evidenceRefs.value,
          contextTruthRefs: truthRefs.value,
          executable: false,
        },
      });
    });
    if (dedupedTo) return ok({ action: this.#actionView(dedupedTo)!, deduplicated: true });
    return ok({ action: this.#actionView(createdId!)!, deduplicated: false });
  }

  /**
   * Record that CURRENT canonical truth admits this action — the `authorized`
   * ledger event, written ONCE per action, carrying the exact snapshot the
   * Intent Guard will compare at execution. It is a record of what canonical
   * authority says right now, not a grant: every fact in it is re-derived
   * from the database rows inside the write lock, and nothing here consults a
   * patchable read.
   *
   * Only the worker holding the task's LIVE fenced claim may authorize (it is
   * the identity that will execute); humans never execute and are refused.
   */
  authorizeAction(input: { actionId: string; workerId: string; fence: number; now?: Date }): OpsResult<{ action: ActionView }> {
    const actionId = input.actionId?.trim() ?? '';
    if (!actionId) return fail('invalid_input', 'actionId is required');
    if (!input.workerId) return fail('invalid_input', 'workerId is required');
    if (!Number.isInteger(input.fence)) return fail('invalid_input', 'fence must be an integer');
    if (!this.#actionStorePresent) return fail('invalid_input', 'action ledger unavailable on this database handle');
    const now = input.now ?? new Date();
    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let taskId: string | null = null;
    privileged.reserve(() => {
      const intent = loadActionIntent(this.#db, actionId);
      if (!intent) {
        refusal = { code: 'unknown_action', message: `Unknown action: ${actionId}` };
        return;
      }
      taskId = intent.taskId;
      const state = deriveActionView(intent, loadActionEvents(this.#db, actionId)).state;
      if (state !== 'proposed') {
        refusal = {
          code: 'action_state_conflict',
          message: `Action ${actionId} is ${state}; authorization is written once, on a proposed action`,
          details: { state },
        };
        return;
      }
      const gate = this.#gatewayGate(intent, input.workerId, input.fence, now);
      if (!gate.ok) {
        refusal = gate.error;
        return;
      }
      const at = nowIso();
      const digest = authorizationDigest(gate.snapshot);
      this.#appendActionEvent(actionId, 'authorized', input.workerId, at, {
        digest,
        approvalId: gate.snapshot.approvalId,
        snapshot: gate.snapshot,
      });
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `action:${actionId}`,
        status: null,
        actor: input.workerId,
        summary: `External action authorized: ${intent.adapterId}/${intent.actionType} (${intent.riskLevel})`,
        detail: { taskId: intent.taskId, digest, approvalId: gate.snapshot.approvalId },
      });
      privileged.appendEvidence({
        taskId: intent.taskId,
        actor: input.workerId,
        kind: 'action_authorized',
        payload: {
          actionId,
          digest,
          approvalId: gate.snapshot.approvalId,
          taskActionDigest: gate.snapshot.taskActionDigest,
          providerId: gate.snapshot.providerId,
          adapterId: gate.snapshot.adapterId,
          missionIntentSeq: gate.snapshot.missionIntentSeq,
          riskLevel: gate.snapshot.riskLevel,
          executable: false,
        },
      });
    });
    if (refusal) return this.#refuseAction(actionId, taskId, 'authorize', refusal);
    return ok({ action: this.#actionView(actionId)! });
  }

  /**
   * Execute one authorized action through its adapter — the ONLY path in HQ
   * that performs a gateway side effect.
   *
   * Three steps, and the boundaries between them are the whole design:
   *
   *   1. INSIDE one IMMEDIATE write transaction: the Intent Guard re-derives
   *      the authorization snapshot from CURRENT canonical truth and refuses
   *      on any drift (payload/task digest, provider/adapter, approval identity
   *      or claim binding, mission intent version or status, capability
   *      contract); the kill switches are read from the row; the durable
   *      side-effect key is reserved by UNIQUE index; the `attempted` event is
   *      committed. If this cannot be written, nothing is executed.
   *   2. OUTSIDE the transaction: the adapter is called once. A throw is an
   *      UNKNOWN outcome, not a failure.
   *   3. INSIDE a second transaction: the terminal event. If it cannot be
   *      written the attempt stays open — retry-blocked — and the caller is
   *      told the outcome is unknown rather than handed a success no ledger
   *      supports.
   *
   * An action whose last event is `attempted` or `outcome_unknown` is refused
   * with `action_outcome_unknown`: an external side effect whose prior outcome
   * is unknown is NEVER retried automatically. Reconciliation is the only way
   * out, and it is a human act.
   */
  executeAction(input: {
    actionId: string;
    workerId: string;
    fence: number;
    now?: Date;
  }): OpsResult<{ action: ActionView; outcome: 'succeeded' | 'failed' | 'outcome_unknown' }> {
    const actionId = input.actionId?.trim() ?? '';
    if (!actionId) return fail('invalid_input', 'actionId is required');
    if (!input.workerId) return fail('invalid_input', 'workerId is required');
    if (!Number.isInteger(input.fence)) return fail('invalid_input', 'fence must be an integer');
    if (!this.#actionStorePresent) return fail('invalid_input', 'action ledger unavailable on this database handle');
    const now = input.now ?? new Date();
    const privileged = this.#requirePrivilegedQueue();

    // ---- step 1: guard + reservation, atomically ----
    let refusal: OpsError | null = null;
    let reserved: {
      intent: ActionIntentRow;
      adapter: ExternalActionAdapter;
      correlationId: string;
      effectKey: string;
      generation: number;
    } | null = null;
    let taskId: string | null = null;
    try {
      privileged.reserve(() => {
        const intent = loadActionIntent(this.#db, actionId);
        if (!intent) {
          refusal = { code: 'unknown_action', message: `Unknown action: ${actionId}` };
          return;
        }
        taskId = intent.taskId;
        const view = deriveActionView(intent, loadActionEvents(this.#db, actionId));
        if (view.state === 'attempted' || view.state === 'outcome_unknown') {
          refusal = {
            code: 'action_outcome_unknown',
            message:
              `Action ${actionId} has an external attempt whose outcome is ${
                view.state === 'attempted' ? 'not yet recorded' : 'unknown'
              } (correlation ${view.attempt?.correlationId ?? 'n/a'}). It is never retried automatically: ` +
              'reconcile it explicitly after checking the external system.',
            details: { state: view.state, correlationId: view.attempt?.correlationId ?? null },
          };
          return;
        }
        if (!stateAdmitsAttempt(view.state)) {
          refusal = {
            code: 'action_state_conflict',
            message:
              view.state === 'proposed'
                ? `Action ${actionId} is proposed and not yet authorized; authorization is a separate recorded step`
                : `Action ${actionId} is ${view.state}; a terminal action is never re-executed — propose a new one`,
            details: { state: view.state },
          };
          return;
        }
        const gate = this.#gatewayGate(intent, input.workerId, input.fence, now);
        if (!gate.ok) {
          refusal = gate.error;
          return;
        }
        // The Intent Guard proper: the authorized snapshot against the current one.
        const authorizedEvent = loadActionEvents(this.#db, actionId).find((e) => e.state === 'authorized')!;
        const authorizedSnapshot = authorizedEvent.detail.snapshot as AuthorizedSnapshot;
        const drift = snapshotDrift(authorizedSnapshot, gate.snapshot);
        if (drift.length > 0) {
          refusal = this.#classifyDrift(actionId, drift);
          return;
        }
        const generation = sideEffectGeneration(this.#db, intent.sideEffectKeyBase);
        const effectKey = sideEffectKey(intent.sideEffectKeyBase, generation);
        const holder = sideEffectHolder(this.#db, effectKey);
        if (holder) {
          refusal = {
            code: 'duplicate_external_action',
            message:
              `The same external side effect (task ${intent.taskId}, ${intent.adapterId}/${intent.actionType} on ` +
              `${intent.target}) was already attempted by action ${holder.actionId} at ${holder.at}. Not repeated.`,
            details: { holderActionId: holder.actionId, attemptedAt: holder.at },
          };
          return;
        }
        const correlationId = `${actionId}#${generation}`;
        const at = nowIso();
        this.#appendActionEvent(
          actionId,
          'attempted',
          input.workerId,
          at,
          { correlationId, generation, adapterId: gate.adapter.id, providerId: gate.snapshot.providerId },
          effectKey,
        );
        this.#store.appendEvent({
          subjectKind: 'system',
          subjectId: `action:${actionId}`,
          status: null,
          actor: input.workerId,
          summary: `External action attempted: ${intent.adapterId}/${intent.actionType} (${correlationId})`,
          detail: { taskId: intent.taskId, correlationId, generation },
        });
        privileged.appendEvidence({
          taskId: intent.taskId,
          actor: input.workerId,
          kind: 'action_attempted',
          payload: {
            actionId,
            correlationId,
            generation,
            adapterId: gate.adapter.id,
            providerId: gate.snapshot.providerId,
            authorizationDigest: authorizationDigest(gate.snapshot),
          },
        });
        reserved = { intent, adapter: gate.adapter, correlationId, effectKey, generation };
      });
    } catch (error) {
      // A UNIQUE violation on the side-effect key is the engine refusing a
      // concurrent duplicate — surfaced either by the index itself or, since
      // the secondary-index guard, by the BEFORE INSERT trigger that fires
      // first and names the key; anything else means the reservation could
      // not be written, and an unrecorded guard is no guard — nothing executes.
      const code = (error as { code?: string }).code;
      const reservedByTrigger =
        code === 'SQLITE_CONSTRAINT_TRIGGER' && errorMessage(error).includes('side_effect_key');
      if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT' || reservedByTrigger) {
        return this.#refuseAction(actionId, taskId, 'execute', {
          code: 'duplicate_external_action',
          message: 'The side-effect key was reserved concurrently by another attempt; nothing was executed.',
        });
      }
      return fail('operator_rejected', `The attempt could not be recorded (${errorMessage(error)}); nothing was executed.`, {
        actionId,
      });
    }
    if (refusal) return this.#refuseAction(actionId, taskId, 'execute', refusal);
    const run = reserved!;

    // ---- step 2: the external call, exactly once ----
    let outcome: AdapterOutcome;
    try {
      outcome = run.adapter.execute({
        actionId,
        taskId: run.intent.taskId,
        actionType: run.intent.actionType,
        target: run.intent.target,
        payload: run.intent.payload,
        correlationId: run.correlationId,
        sideEffectKey: run.effectKey,
      });
    } catch (error) {
      outcome = { ok: false, kind: 'unknown', message: `adapter threw: ${errorMessage(error).slice(0, 200)}` };
    }
    if (outcome == null || typeof outcome !== 'object' || typeof (outcome as { ok?: unknown }).ok !== 'boolean') {
      outcome = { ok: false, kind: 'unknown', message: 'adapter returned no recognisable outcome' };
    }

    // ---- step 3: the terminal record ----
    const terminal: 'succeeded' | 'failed' | 'outcome_unknown' = outcome.ok
      ? 'succeeded'
      : outcome.kind === 'unknown'
        ? 'outcome_unknown'
        : 'failed';
    let externalRef: Record<string, unknown> | null = null;
    let externalRefWithheld = false;
    if (outcome.ok && outcome.externalRef != null) {
      try {
        assertBrowserSafe(outcome.externalRef, 'externalRef');
        externalRef = outcome.externalRef;
      } catch {
        externalRefWithheld = true;
      }
    }
    // The adapter's message — whether it RETURNED one or THREW it (step 2 folds
    // the thrown text into `outcome.message`, so one scan here covers both
    // paths) — goes through the same guard as `externalRef` BEFORE storage.
    // Real APIs echo the token or the Authorization header in auth errors;
    // both stores below are engine-immutable and the evidence chain is hashed,
    // so a credential written here could never be removed (review round 2
    // proved it landed). Withheld is flagged, never silent.
    let message: string | null = outcome.ok ? null : String(outcome.message ?? '').slice(0, 500);
    let messageWithheld = false;
    if (message !== null) {
      try {
        assertBrowserSafe({ message }, 'message');
      } catch {
        message = null;
        messageWithheld = true;
      }
    }
    try {
      privileged.reserve(() => {
        const at = nowIso();
        this.#appendActionEvent(actionId, terminal, input.workerId, at, {
          correlationId: run.correlationId,
          externalRef,
          externalRefWithheld,
          message,
          messageWithheld,
        });
        this.#store.appendEvent({
          subjectKind: 'system',
          subjectId: `action:${actionId}`,
          status: null,
          actor: input.workerId,
          summary: `External action ${terminal}: ${run.intent.adapterId}/${run.intent.actionType} (${run.correlationId})`,
          detail: { taskId: run.intent.taskId, correlationId: run.correlationId, externalRefWithheld, messageWithheld },
        });
        privileged.appendEvidence({
          taskId: run.intent.taskId,
          actor: input.workerId,
          kind: `action_${terminal}`,
          payload: { actionId, correlationId: run.correlationId, externalRef, externalRefWithheld, message, messageWithheld },
        });
      });
    } catch (error) {
      return fail(
        'action_outcome_unknown',
        `The adapter reported ${terminal} but the outcome could not be recorded (${errorMessage(error)}). ` +
          'The attempt stays open and retry-blocked; reconcile it after checking the external system.',
        { actionId, correlationId: run.correlationId, reported: terminal },
      );
    }
    return ok({ action: this.#actionView(actionId)!, outcome: terminal });
  }

  /**
   * Close an open or unknown external attempt after a HUMAN checked the real
   * world. The same authority as reconciling an unknown dispatch: approval
   * authority, positively resolved; `system`, workers and the action's own
   * proposer are refused. `confirmed_not_executed` reopens a fresh side-effect
   * generation ONLY for an idempotent capability — for anything else the
   * uncertain execution is closed as done or failed after investigation.
   */
  reconcileAction(input: {
    actionId: string;
    decision: ActionReconcileDecision;
    note: string;
    requestedBy: string;
  }): OpsResult<{ action: ActionView }> {
    const actionId = input.actionId?.trim() ?? '';
    if (!actionId) return fail('invalid_input', 'actionId is required');
    if (!isActionReconcileDecision(input.decision)) {
      return fail('invalid_input', 'decision must be confirmed_succeeded, confirmed_failed or confirmed_not_executed');
    }
    const note = missionText('note', input.note, MAX_ACTION_NOTE_LENGTH, true);
    if (!note.ok) return fail('invalid_input', note.message);
    try {
      assertNoSecretLikeContent({ note: note.value });
    } catch {
      return fail('invalid_input', 'The reconciliation note looks like it contains a credential; nothing was recorded.');
    }
    const gate = this.#assertApprovalAuthority(input.requestedBy, 'reconcile an external action outcome');
    if (gate) return gate;
    if (!this.#actionStorePresent) return fail('invalid_input', 'action ledger unavailable on this database handle');
    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let taskId: string | null = null;
    privileged.reserve(() => {
      const intent = loadActionIntent(this.#db, actionId);
      if (!intent) {
        refusal = { code: 'unknown_action', message: `Unknown action: ${actionId}` };
        return;
      }
      taskId = intent.taskId;
      const view = deriveActionView(intent, loadActionEvents(this.#db, actionId));
      if (!stateAdmitsReconciliation(view.state)) {
        refusal = {
          code: 'action_state_conflict',
          message: `Action ${actionId} is ${view.state}; only an open or unknown attempt is reconciled`,
          details: { state: view.state },
        };
        return;
      }
      if (intent.requestedBy === input.requestedBy) {
        refusal = {
          code: 'not_permitted',
          message: `${input.requestedBy} proposed action ${actionId} and cannot reconcile its outcome: reconciliation requires an independent principal`,
          details: { actor: input.requestedBy },
        };
        return;
      }
      if (input.decision === 'confirmed_not_executed') {
        const cap = this.#capabilityFromStore(intent.capabilityId);
        if (!cap?.idempotent) {
          refusal = {
            code: 'not_permitted',
            message: `Capability ${intent.capabilityId} is not idempotent; an uncertain external execution cannot be reopened for another attempt — close it as succeeded or failed after investigation`,
            details: { capabilityId: intent.capabilityId },
          };
          return;
        }
      }
      const at = nowIso();
      this.#appendActionEvent(actionId, 'reconciled', input.requestedBy, at, {
        decision: input.decision,
        note: note.value,
        correlationId: view.attempt?.correlationId ?? null,
      });
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `action:${actionId}`,
        status: null,
        actor: input.requestedBy,
        summary: `External action reconciled ${input.decision}: ${intent.adapterId}/${intent.actionType}`,
        detail: { taskId: intent.taskId, decision: input.decision },
      });
      privileged.appendEvidence({
        taskId: intent.taskId,
        actor: input.requestedBy,
        kind: 'action_reconciled',
        payload: {
          actionId,
          decision: input.decision,
          note: note.value,
          correlationId: view.attempt?.correlationId ?? null,
          executable: false,
        },
      });
    });
    if (refusal) return this.#refuseAction(actionId, taskId, 'reconcile', refusal);
    return ok({ action: this.#actionView(actionId)! });
  }

  /** One action's derived view, or null (including over a pre-Phase-8 read-only file). */
  getAction(id: string): ActionView | null {
    if (!id || !this.#actionStorePresent) return null;
    return this.#actionView(id);
  }

  /** Every action, newest first, with its derived state; optionally narrowed. */
  listActions(filter?: { taskId?: string; missionId?: string; state?: ActionState }): ActionView[] {
    if (!this.#actionStorePresent) return [];
    if (filter?.state !== undefined && !isActionState(filter.state)) return [];
    return loadActionIntents(this.#db)
      .filter((row) => (filter?.taskId ? row.taskId === filter.taskId : true))
      .filter((row) => (filter?.missionId ? row.missionId === filter.missionId : true))
      .map((row) => deriveActionView(row, loadActionEvents(this.#db, row.id)))
      .filter((view) => (filter?.state ? view.state === filter.state : true));
  }

  /** Bounded list plus the true total, for the wire. */
  listActionsBounded(filter?: { taskId?: string; missionId?: string; state?: ActionState }): {
    actions: ActionView[];
    total: number;
    truncated: boolean;
  } {
    const all = this.listActions(filter);
    return { actions: all.slice(0, ACTION_READ_LIMIT), total: all.length, truncated: all.length > ACTION_READ_LIMIT };
  }

  /** Whether this database handle carries the Phase 8 ledger tables. */
  actionStorePresent(): boolean {
    return this.#actionStorePresent;
  }

  /**
   * Whether the gateway has ATTEMPTED an external action for this task —
   * open, unknown or succeeded. The Claude GitHub dispatch lane asks this so
   * one canonical task never has two external execution paths; a `failed` or
   * reconciled-not-executed attempt leaves nothing in flight.
   */
  gatewayActionHistory(taskId: string): GatewayActionHistory {
    return this.#gatewayActionHistoryFromStore(taskId);
  }

  /**
   * The same answer read from the ledger rows through `#db` — never through
   * the public `listActions`, which lives on the prototype and is patchable.
   * Published to the dispatch lane as the `gatewayActionHistoryFor` function
   * binding (the `killSwitchEngagedFor` recipe): that verdict decides whether
   * a public issue is published for a task the gateway already executed.
   */
  #gatewayActionHistoryFromStore(taskId: string): GatewayActionHistory {
    if (!taskId || !this.#actionStorePresent) return { state: 'none' };
    for (const row of loadActionIntents(this.#db)) {
      if (row.taskId !== taskId) continue;
      const view = deriveActionView(row, loadActionEvents(this.#db, row.id));
      if (view.state === 'attempted' || view.state === 'outcome_unknown' || view.state === 'succeeded') {
        return { state: view.state, actionId: view.id };
      }
      if (view.state === 'reconciled' && view.reconciliation?.decision === 'confirmed_succeeded') {
        return { state: 'succeeded', actionId: view.id };
      }
    }
    return { state: 'none' };
  }

  // ---- gateway internals ----

  #actionView(id: string): ActionView | null {
    const row = loadActionIntent(this.#db, id);
    if (!row) return null;
    return deriveActionView(row, loadActionEvents(this.#db, id));
  }

  #appendActionEvent(
    actionId: string,
    state: ActionState,
    actor: string,
    at: string,
    detail: Record<string, unknown>,
    effectKey: string | null = null,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO hq_action_events (id, action_id, state, actor, at, detail, side_effect_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(uuid(), actionId, state, actor, at, JSON.stringify(detail), effectKey);
  }

  /** A refusal is a fact worth keeping: best-effort evidence, then the typed error. Writes no ledger event. */
  #refuseAction(actionId: string, taskId: string | null, phase: string, error: OpsError): OpsResult<never> {
    try {
      this.#requirePrivilegedQueue().appendEvidence({
        taskId,
        actor: 'system',
        kind: 'action_refused',
        payload: { actionId, phase, code: error.code, details: error.details ?? null },
      });
    } catch {
      // A lost refusal diagnostic costs nothing; the refusal itself stands.
    }
    return { ok: false, error };
  }

  /** The canonical op_tasks row, read directly — never the patchable public `queue.get`. */
  #taskRowFromStore(taskId: string): {
    id: string;
    capabilityId: string;
    payload: Record<string, unknown>;
    idempotencyKey: string | null;
    status: ActivityStatus;
    fence: number;
    claimedBy: string | null;
    claimNonce: string | null;
    approvalId: string | null;
    createdBy: string;
  } | null {
    const row = this.#db.prepare(`SELECT * FROM op_tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload as string) as Record<string, unknown>;
    } catch {
      return null;
    }
    return {
      id: row.id as string,
      capabilityId: row.capability_id as string,
      payload,
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      status: row.status as ActivityStatus,
      fence: row.fence as number,
      claimedBy: (row.claimed_by as string | null) ?? null,
      claimNonce: (row.claim_nonce as string | null) ?? null,
      approvalId: (row.approval_id as string | null) ?? null,
      createdBy: row.created_by as string,
    };
  }

  #missionStatusFromStore(missionId: string): { status: MissionStatus; intentSeq: number } | null {
    if (!this.#missionStorePresent) return null;
    const row = this.#db.prepare(`SELECT status FROM hq_missions WHERE id = ?`).get(missionId) as
      | { status: MissionStatus }
      | undefined;
    if (!row) return null;
    const seq = this.#db.prepare(`SELECT MAX(seq) AS seq FROM hq_mission_intents WHERE mission_id = ?`).get(missionId) as
      | { seq: number | null }
      | undefined;
    return { status: row.status, intentSeq: seq?.seq ?? 0 };
  }

  /**
   * What the Claude GitHub dispatch lane already did with this task, read
   * from the canonical `op_evidence` rows through `#db` by the same rule
   * `dispatchHistory` applies (an `attempted` with no terminal is unknown;
   * `failed` closes it). This fact decides whether HQ executes an external
   * action, so it never reads `queue.evidence` — that handle is the
   * deliberately patchable convenience read for DISPLAY, and a forged
   * `queue.evidence.list` that hid the lane's entries used to let the gateway
   * execute a second external path for the same task (the reintroduced Low 7,
   * closed by the correction pass). Duplicated here rather than imported so
   * the application layer keeps not depending on a provider adapter;
   * `integration-seams` pins the kinds agree.
   */
  #claudeDispatchState(taskId: string): 'none' | 'unknown' | 'dispatched' {
    let pending = false;
    let dispatched = false;
    const kinds = this.#db.prepare(`SELECT kind FROM op_evidence WHERE task_id = ? ORDER BY seq`).all(taskId) as {
      kind: string;
    }[];
    for (const { kind } of kinds) {
      if (kind === 'claude_github_dispatch_attempted') pending = true;
      else if (kind === 'claude_github_dispatch_succeeded') {
        pending = false;
        dispatched = true;
      } else if (kind === 'claude_github_dispatch_failed') pending = false;
    }
    if (dispatched) return 'dispatched';
    return pending ? 'unknown' : 'none';
  }

  /**
   * A task's evidence rows read through `#db` in chain order — kind, time and
   * payload only, which is all a lane folding a history needs. Published as
   * the `taskEvidenceRowsFor` function binding (review round 2) so the Claude
   * dispatch lane's `dispatchHistory` — the read that gates a duplicate PUBLIC
   * publication — never goes through `queue.evidence.list`, the deliberately
   * patchable display surface. The same rows `EvidenceLog.list(taskId)` maps;
   * a payload that does not parse is an empty object rather than a throw, so a
   * corrupt row cannot turn a "dispatched" answer into an exception.
   */
  #taskEvidenceRowsFromStore(taskId: string): CanonicalEvidenceRow[] {
    if (!taskId) return [];
    const rows = this.#db
      .prepare(`SELECT kind, at, payload FROM op_evidence WHERE task_id = ? ORDER BY seq`)
      .all(taskId) as { kind: string; at: string; payload: string }[];
    return rows.map((row) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(row.payload);
        if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        payload = {};
      }
      return { kind: row.kind, at: row.at, payload };
    });
  }

  /** Turn snapshot drift into the one refusal whose cause outranks the others. */
  #classifyDrift(actionId: string, drift: readonly (keyof AuthorizedSnapshot)[]): OpsError {
    const has = (...keys: (keyof AuthorizedSnapshot)[]) => keys.some((k) => drift.includes(k));
    const details = { actionId, changed: [...drift] };
    if (has('taskActionDigest', 'payloadDigest')) {
      return {
        code: 'action_digest_mismatch',
        message: `Action ${actionId}: the approved action changed after authorization; nothing was executed`,
        details,
      };
    }
    if (has('providerId', 'adapterId')) {
      return {
        code: 'provider_binding_mismatch',
        message: `Action ${actionId}: the provider or adapter moved after authorization; no substitution is made`,
        details,
      };
    }
    if (has('approvalId', 'approvalDecidedBy', 'workerId', 'fence', 'claimNonce')) {
      return {
        code: 'action_approval_stale',
        message: `Action ${actionId}: the approval or the claim it was consumed by is not the one authorized; nothing was executed`,
        details,
      };
    }
    return {
      code: 'intent_changed',
      message: `Action ${actionId}: the mission intent, status or capability contract changed after authorization; re-propose against current intent`,
      details,
    };
  }

  /**
   * The gate every authorization AND every execution passes, over CURRENT
   * canonical rows read through `#db` and the enforcement-safe closures only:
   *
   *   worker permissions ∩ mission permissions ∩ policy ∩ approvals
   *
   * — the executing worker resolves, is assignable and holds the capability;
   * the adapter/action type are declared; the task is `running` under THIS
   * worker's live fenced claim; the capability row is intact and enabled;
   * the provider binding admits the adapter and the worker (no substitution);
   * the approval (where policy OR risk requires one) is approved, digest-bound
   * to the current task, consumed by this exact claim, unexpired, and not the
   * proposer's own decision; no kill-switch scope is engaged; the mission (if
   * referenced) is active; the Claude dispatch lane has not taken the task.
   * Returns the snapshot the Intent Guard binds and compares.
   */
  #gatewayGate(
    intent: ActionIntentRow,
    workerId: string,
    fence: number,
    now: Date,
  ):
    | { ok: true; snapshot: AuthorizedSnapshot; adapter: ExternalActionAdapter }
    | { ok: false; error: OpsError } {
    const refuse = (error: OpsResult<never> | OpsError): { ok: false; error: OpsError } =>
      'ok' in error ? { ok: false, error: (error as { ok: false; error: OpsError }).error } : { ok: false, error };
    const human = this.#rejectHumanExecution(workerId, 'execute an external action');
    if (human) return refuse(human);
    const assignability = this.#workers.assignability(workerId);
    if (!assignability.assignable) return refuse(this.#rejectNotAssignable(workerId, assignability, 'execute an external action'));
    if (!this.#grantOf(workerId).includes(intent.capabilityId)) {
      return refuse({
        code: 'not_permitted',
        message: `Worker ${workerId} is not allowed capability ${intent.capabilityId} (least privilege)`,
        details: { workerId, capabilityId: intent.capabilityId },
      });
    }
    const adapter = this.#actionAdapters.get(intent.adapterId);
    if (!adapter) return refuse({ code: 'unknown_adapter', message: `Unknown external-action adapter: ${intent.adapterId}` });
    if (!adapter.actions[intent.actionType]) {
      return refuse({ code: 'unknown_adapter', message: `Adapter ${intent.adapterId} declares no action type ${intent.actionType}` });
    }
    const task = this.#taskRowFromStore(intent.taskId);
    if (!task) return refuse({ code: 'unknown_task', message: `Unknown task: ${intent.taskId}` });
    if (task.capabilityId !== intent.capabilityId) {
      return refuse({
        code: 'action_digest_mismatch',
        message: `Task ${task.id} no longer names capability ${intent.capabilityId}; the action does not match its task`,
      });
    }
    if (task.status !== 'running' || task.claimedBy !== workerId || task.fence !== fence) {
      return refuse({
        code: 'task_not_executing',
        message:
          `Task ${task.id} is ${task.status}, claimed by ${task.claimedBy ?? 'nobody'} at fence ${task.fence}; ` +
          `an external action executes only under the live, started claim of the worker performing it`,
        details: { status: task.status, claimedBy: task.claimedBy, fence: task.fence },
      });
    }
    const cap = this.#capabilityFromStore(task.capabilityId);
    if (!cap) return refuse({ code: 'unknown_capability', message: `Unknown capability: ${task.capabilityId}` });
    if (!cap.enabled) return refuse({ code: 'capability_disabled', message: `Capability ${cap.id} is disabled` });

    const binding = readProviderBinding(task.payload);
    if (binding.bound && binding.provider == null) {
      return refuse({ code: 'provider_binding_mismatch', message: `Task ${task.id} declares a malformed executionProvider` });
    }
    if (binding.bound && (adapter.provider !== binding.provider || intent.providerId !== binding.provider)) {
      return refuse({
        code: 'provider_binding_mismatch',
        message: `Task ${task.id} is bound to provider ${binding.provider}; adapter ${adapter.id} executes as ${
          adapter.provider ?? 'no provider'
        }. No substitution is made.`,
        details: { requiredProvider: binding.provider, adapterProvider: adapter.provider, intentProvider: intent.providerId },
      });
    }
    if (adapter.provider !== null) {
      const declared = this.#db
        .prepare(`SELECT provider_id FROM op_worker_providers WHERE worker_id = ?`)
        .get(workerId) as { provider_id: string } | undefined;
      if (declared?.provider_id !== adapter.provider) {
        return refuse({
          code: 'provider_binding_mismatch',
          message: `Adapter ${adapter.id} executes as ${adapter.provider} and worker ${workerId} is declared as ${
            declared?.provider_id ?? 'no provider'
          }. Provider identity is declared, never inferred, and never substituted.`,
          details: { adapterProvider: adapter.provider, workerProvider: declared?.provider_id ?? null },
        });
      }
    }
    const providerId = binding.bound ? binding.provider : adapter.provider;

    const currentDigest = taskActionDigest(task);
    const policyRequires = approvalRequired(cap, this.#policyCtx);
    const riskRequires = riskRequiresApproval(intent.riskLevel);
    let approvalId: string | null = null;
    let approvalDecidedBy: string | null = null;
    if (policyRequires || riskRequires) {
      const approval = task.approvalId
        ? (this.#db
            .prepare(
              `SELECT id, decision, decided_by, action_digest, expires_at, consumed_at, consumed_by, consumed_task_id,
                      consumed_fence, consumed_claim_nonce FROM hq_approvals WHERE id = ?`,
            )
            .get(task.approvalId) as Record<string, unknown> | undefined)
        : undefined;
      if (!approval) {
        return refuse(
          riskRequires && !policyRequires
            ? {
                code: 'approval_required_by_risk',
                message:
                  `Action ${intent.id} is ${intent.riskLevel} risk and requires a bound Founder approval; task ${task.id} ` +
                  'carries none (its capability runs on standing policy). Risk escalation adds an approval requirement — it never removes one.',
                details: { riskLevel: intent.riskLevel, riskFactors: intent.riskFactors },
              }
            : { code: 'action_approval_stale', message: `Task ${task.id} carries no approval; nothing executes on none` },
        );
      }
      if (approval.decision !== 'approved') {
        return refuse({ code: 'action_approval_stale', message: `Task ${task.id}: the bound approval record is not an approval` });
      }
      if (approval.action_digest !== currentDigest) {
        return refuse({
          code: 'action_digest_mismatch',
          message: `Task ${task.id}: the action changed after Founder approval; the approval no longer binds it`,
        });
      }
      if (approvalExpiredAt({ expiresAt: (approval.expires_at as string | null) ?? null }, now)) {
        return refuse({ code: 'action_approval_stale', message: `Task ${task.id}: the Founder approval has expired; nothing executes on it` });
      }
      const bindingRejection = validateApprovalClaimBinding(
        {
          consumedAt: (approval.consumed_at as string | null) ?? null,
          consumedBy: (approval.consumed_by as string | null) ?? null,
          consumedTaskId: (approval.consumed_task_id as string | null) ?? null,
          consumedFence: (approval.consumed_fence as number | null) ?? null,
          consumedClaimNonce: (approval.consumed_claim_nonce as string | null) ?? null,
        },
        { taskId: task.id, workerId, fence, claimNonce: task.claimNonce },
      );
      if (bindingRejection) {
        return refuse({
          code: 'action_approval_stale',
          message: `Task ${task.id}: the approval was not consumed by this claim (${bindingRejection}); nothing executes on it`,
        });
      }
      approvalId = approval.id as string;
      approvalDecidedBy = (approval.decided_by as string | null) ?? null;
      if (approvalDecidedBy === intent.requestedBy || approvalDecidedBy === workerId) {
        return refuse({
          code: 'not_permitted',
          message: `${approvalDecidedBy} approved task ${task.id} and also ${
            approvalDecidedBy === workerId ? 'executes' : 'proposed'
          } action ${intent.id}: the requesting/executing party may not approve its own external action`,
          details: { approvedBy: approvalDecidedBy },
        });
      }
    }

    const engaged = this.#engagedKillSwitchScopeFromStore([
      GLOBAL_SCOPE,
      cap.id,
      EXTERNAL_ACTION_KILL_SCOPE,
      ...(providerId ? [providerKillSwitchScope(providerId)] : []),
      adapterKillSwitchScope(adapter.id),
    ]);
    if (engaged) {
      return refuse({
        code: 'kill_switch_engaged',
        message: `Kill switch is engaged for scope ${engaged}; no external action executes`,
        details: { scope: engaged },
      });
    }

    let missionIntentSeq: number | null = null;
    let missionStatus: string | null = null;
    if (intent.missionId) {
      const mission = this.#missionStatusFromStore(intent.missionId);
      if (!mission) return refuse({ code: 'unknown_mission', message: `Unknown mission: ${intent.missionId}` });
      if (isMissionTerminal(mission.status) || mission.status === 'blocked') {
        return refuse({
          code: 'mission_not_active',
          message: `Mission ${intent.missionId} is ${mission.status}; it directs no external action`,
          details: { status: mission.status },
        });
      }
      missionIntentSeq = mission.intentSeq;
      missionStatus = mission.status;
    }
    const dispatched = this.#claudeDispatchState(task.id);
    if (dispatched !== 'none') {
      return refuse({
        code: 'duplicate_external_action',
        message: `Task ${task.id} was already handed to the Claude GitHub dispatch lane (${dispatched}); one canonical task has one external execution path`,
        details: { dispatch: dispatched },
      });
    }

    return {
      ok: true,
      adapter,
      snapshot: {
        taskActionDigest: currentDigest,
        payloadDigest: intent.payloadDigest,
        approvalId,
        approvalDecidedBy,
        workerId,
        fence,
        claimNonce: task.claimNonce,
        providerId,
        adapterId: adapter.id,
        missionIntentSeq,
        missionStatus,
        capabilityRiskClass: cap.riskClass,
        riskLevel: intent.riskLevel,
      },
    };
  }

  // ---- collaboration (Phase 9 — Mission Room + Multi-AI Collaboration) ----

  /**
   * Open a collaboration session on ONE canonical mission — the only way a
   * session comes into existence. A Founder act (`hq.collaboration_command`,
   * the founder-gate trio): a human principal holding the grant; workers,
   * `system` and unknown ids refused. The mission must exist and be
   * non-terminal (a finished mission opens no room). The session carries no
   * lifecycle of its own: its standing is derived from the mission on every
   * read. Executes nothing, assigns nothing, creates no task.
   */
  openCollaborationSession(input: {
    missionId: string;
    title: string;
    purpose?: string;
    /**
     * How this session's own material is classified — the memory/truth
     * vocabulary, not a second privacy system. Defaults to `internal`; a
     * `founder_only` session is not carried by the unauthenticated snapshot
     * artifact at all.
     */
    privacy?: CollaborationPrivacy;
    /** Resolved actor id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ session: CollaborationSessionView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const missionId = input.missionId?.trim() ?? '';
    if (!missionId) return fail('invalid_input', 'missionId is required');
    const title = missionText('title', input.title, MAX_COLLABORATION_TITLE_LENGTH, true);
    if (!title.ok) return fail('invalid_input', title.message);
    const purpose = missionText('purpose', input.purpose, MAX_COLLABORATION_PURPOSE_LENGTH, false);
    if (!purpose.ok) return fail('invalid_input', purpose.message);
    if (input.privacy !== undefined && !isCollaborationPrivacy(input.privacy)) {
      return fail('invalid_input', `privacy must be one of: ${COLLABORATION_PRIVACIES.join(', ')}`);
    }
    const privacy: CollaborationPrivacy = input.privacy ?? DEFAULT_COLLABORATION_PRIVACY;

    const refusedActor = this.#resolveCollaborationCommander(input.requestedBy, 'open a collaboration session');
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#collaborationCommandCapabilityGate('open a collaboration session');
    if (refusedCapability) return refusedCapability;
    if (!this.#collaborationStorePresent) {
      return fail('invalid_input', 'collaboration store unavailable on this database handle');
    }
    try {
      assertNoSecretLikeContent({ title: title.value, purpose: purpose.value });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }
    const idempotencyKey = collaborationSessionIdempotencyKey({
      requestedBy: input.requestedBy,
      missionId,
      title: title.value!,
      purpose: purpose.value,
      privacy,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let createdId: string | null = null;
    privileged.reserve(() => {
      const existing = this.#db
        .prepare(`SELECT id FROM hq_collab_sessions WHERE idempotency_key = ?`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      // The mission's canonical status, read INSIDE the write lock through
      // `#db` — never `getMission`, a prototype method a same-realm caller
      // can patch. Probed only after the authority gates (no oracle).
      const mission = this.#missionStatusFromStore(missionId);
      if (!mission) {
        refusal = { code: 'unknown_mission', message: `Unknown mission: ${missionId}` };
        return;
      }
      if (isMissionTerminal(mission.status)) {
        refusal = {
          code: 'mission_terminal',
          message: `Mission ${missionId} is ${mission.status}; a finished mission opens no collaboration session`,
          details: { status: mission.status },
        };
        return;
      }
      const id = `collab-${uuid()}`;
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_collab_sessions (id, mission_id, title, purpose, privacy, opened_by, opened_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, missionId, title.value, purpose.value, privacy, input.requestedBy, at, idempotencyKey);
      createdId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `collaboration:${id}`,
        status: null,
        actor: input.requestedBy,
        summary: `Collaboration session opened on mission ${missionId}: ${title.value}`,
        detail: { sessionId: id, missionId, privacy },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'collaboration_session_opened',
        payload: { sessionId: id, missionId, missionIntentSeq: mission.intentSeq, privacy, executable: false },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    const id = dedupedTo ?? createdId!;
    return ok({ session: this.#sessionView(loadCollaborationSession(this.#db, id)!), deduplicated: dedupedTo !== null });
  }

  /**
   * Admit a REGISTERED execution worker to a session under one bounded role.
   * A Founder act (the same trio as opening). The worker must be a real,
   * assignable `hq_specialists` row — never a human principal, never an
   * unknown id, never an inactive worker — so no fake worker can ever appear
   * in a room. The role is assignment metadata: it grants no capability and
   * is read by nothing but this module's own membership check. The binding
   * recorded beside the admission is the CANONICAL one (declared provider,
   * registered model identity), read from the database, never asserted.
   * A repeated admission of the same (session, worker, role) deduplicates.
   */
  admitCollaborator(input: {
    sessionId: string;
    workerId: string;
    role: CollaborationRole;
    requestedBy: string;
  }): OpsResult<{ participant: ParticipantView; session: CollaborationSessionView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const sessionId = input.sessionId?.trim() ?? '';
    if (!sessionId) return fail('invalid_input', 'sessionId is required');
    const workerId = input.workerId?.trim() ?? '';
    if (!workerId) return fail('invalid_input', 'workerId is required');
    if (!isCollaborationRole(input.role)) {
      return fail('invalid_input', `role must be one of: ${COLLABORATION_ROLES.join(', ')}`);
    }
    const refusedActor = this.#resolveCollaborationCommander(input.requestedBy, 'admit a collaborator');
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#collaborationCommandCapabilityGate('admit a collaborator');
    if (refusedCapability) return refusedCapability;
    if (!this.#collaborationStorePresent) {
      return fail('invalid_input', 'collaboration store unavailable on this database handle');
    }
    const refusedWorker = this.#rejectNotACollaboratingWorker(workerId, 'be admitted to a collaboration session');
    if (refusedWorker) return refusedWorker;

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let createdId: string | null = null;
    privileged.reserve(() => {
      const session = loadCollaborationSession(this.#db, sessionId);
      if (!session) {
        refusal = { code: 'unknown_session', message: `Unknown collaboration session: ${sessionId}` };
        return;
      }
      const mission = this.#missionStatusFromStore(session.missionId);
      if (sessionStandingFor(mission?.status ?? null) === 'closed') {
        refusal = {
          code: 'session_closed',
          message: `Collaboration session ${sessionId} is closed: mission ${session.missionId} is ${mission?.status ?? 'gone'}`,
          details: { missionStatus: mission?.status ?? null },
        };
        return;
      }
      const existing = this.#db
        .prepare(`SELECT id FROM hq_collab_participants WHERE session_id = ? AND worker_id = ? AND role = ?`)
        .get(sessionId, workerId, input.role) as { id: string } | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      // Re-derived INSIDE the write lock, against the Wave-2 correction
      // `0b6c108` precedent ("revalidate all authority gates inside the write
      // lock"). The pre-lock check above stays where it is so the refusal
      // ORDER is unchanged (an unknown worker is still nobody before any
      // session is probed); this is the second reading, the one the INSERT
      // actually depends on.
      const refusedInLock = this.#rejectNotACollaboratingWorker(workerId, 'be admitted to a collaboration session');
      if (refusedInLock && !refusedInLock.ok) {
        refusal = refusedInLock.error;
        return;
      }
      const binding = this.#workerBindingFromStore(workerId);
      const id = `collab-p-${uuid()}`;
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_collab_participants (id, session_id, worker_id, role, provider_id, member_identity_key, admitted_by, admitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, sessionId, workerId, input.role, binding.providerId, binding.member?.identityKey ?? null, input.requestedBy, at);
      createdId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `collaboration:${sessionId}`,
        status: null,
        actor: input.requestedBy,
        summary: `Worker ${workerId} admitted as ${input.role} to collaboration session ${sessionId}`,
        detail: { sessionId, workerId, role: input.role, missionId: session.missionId },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: 'collaboration_participant_admitted',
        payload: {
          sessionId,
          missionId: session.missionId,
          workerId,
          role: input.role,
          providerId: binding.providerId,
          memberIdentityKey: binding.member?.identityKey ?? null,
          bindingSource: binding.source,
          executable: false,
        },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    const id = dedupedTo ?? createdId!;
    const row = this.#db.prepare(`SELECT * FROM hq_collab_participants WHERE id = ?`).get(id) as Record<string, unknown>;
    const participants = loadParticipants(this.#db, sessionId);
    const participant = participants.find((p) => p.id === (row.id as string))!;
    return ok({
      participant: participantView(participant),
      session: this.#sessionView(loadCollaborationSession(this.#db, sessionId)!),
      deduplicated: dedupedTo !== null,
    });
  }

  /**
   * Record one attributed contribution — the only way a contribution comes
   * into existence, and a WORKER act only:
   *
   * - identity: `requestedBy` must be a registered, assignable execution
   *   worker holding `hq.collaboration_contribute` in its directory grant;
   *   `system`, human principals and unknown ids are refused. The worker on
   *   the record IS the resolved actor — there is no field to name another;
   * - membership: the worker must have been admitted to THIS session, and
   *   `role` (when named) must be one it holds there; a worker holding one
   *   role need not name it, one holding several must;
   * - binding: the recorded provider/model is the CANONICAL binding read
   *   from `op_worker_providers` / `hq_ai_members` at write time. A
   *   `declaredBinding` must match it exactly or the write is refused
   *   (`provider_binding_mismatch`) — nothing is substituted or inferred;
   * - references: `taskId` (and a handoff's task) must be a task the
   *   session's mission links through a plan item; every evidence ref must
   *   exist; every truth ref must exist and not be founder_only; every stance
   *   target must be a contribution of the SAME session;
   * - handoff: `kind: 'handoff_request'` carries a structured request naming
   *   ANOTHER registered, assignable worker. It is a recommendation: it
   *   changes no claim, no fence, no `hq_op_task_meta.assignment`, and the
   *   canonical `assignTaskAsFounder` / `claimNext` read nothing here;
   * - authority: recording a contribution changes no mission field, no
   *   intent row, no plan item, no task, no approval and no truth state.
   *   Agreement stances are stored as stances, never as verification.
   */
  recordContribution(input: {
    sessionId: string;
    kind: ContributionKind;
    content: string;
    role?: CollaborationRole;
    taskId?: string;
    artifactRefs?: string[];
    /** `op_evidence` ids. References only. */
    evidenceRefs?: string[];
    /** `hq_truth_records` ids. References only — reading them decides nothing. */
    truthRefs?: string[];
    agreesWith?: string[];
    disagreesWith?: string[];
    respondsTo?: string[];
    /** What the worker CLAIMS to be. Must equal the canonical binding; never stored in its own right. */
    declaredBinding?: { providerId?: string; modelId?: string; modelVersion?: string };
    handoff?: { taskId: string; toWorkerId: string; reason: string };
    /** Resolved actor id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ contribution: ContributionView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const sessionId = input.sessionId?.trim() ?? '';
    if (!sessionId) return fail('invalid_input', 'sessionId is required');
    if (!isContributionKind(input.kind)) {
      return fail('invalid_input', `kind must be one of: ${CONTRIBUTION_KINDS.join(', ')}`);
    }
    if (input.role !== undefined && !isCollaborationRole(input.role)) {
      return fail('invalid_input', `role must be one of: ${COLLABORATION_ROLES.join(', ')}`);
    }
    const content = missionText('content', input.content, MAX_CONTRIBUTION_CONTENT_LENGTH, true);
    if (!content.ok) return fail('invalid_input', content.message);
    const taskId = input.taskId?.trim() || null;
    const artifactRefs = memoryList('artifactRefs', input.artifactRefs, MAX_COLLABORATION_REF_LENGTH);
    if (!artifactRefs.ok) return fail('invalid_input', artifactRefs.message);
    const evidenceRefs = truthIdList('evidenceRefs', input.evidenceRefs);
    if (!evidenceRefs.ok) return fail('invalid_input', evidenceRefs.message);
    const truthRefs = truthIdList('truthRefs', input.truthRefs);
    if (!truthRefs.ok) return fail('invalid_input', truthRefs.message);
    const agreesWith = truthIdList('agreesWith', input.agreesWith);
    if (!agreesWith.ok) return fail('invalid_input', agreesWith.message);
    const disagreesWith = truthIdList('disagreesWith', input.disagreesWith);
    if (!disagreesWith.ok) return fail('invalid_input', disagreesWith.message);
    const respondsTo = truthIdList('respondsTo', input.respondsTo);
    if (!respondsTo.ok) return fail('invalid_input', respondsTo.message);
    if (agreesWith.value.some((id) => disagreesWith.value.includes(id))) {
      return fail('invalid_input', 'a contribution cannot both agree and disagree with the same contribution');
    }
    let handoff: { taskId: string; toWorkerId: string; reason: string } | null = null;
    if (input.kind === 'handoff_request') {
      if (!input.handoff || typeof input.handoff !== 'object') {
        return fail('invalid_input', 'a handoff_request must carry handoff: { taskId, toWorkerId, reason }');
      }
      const handoffTask = input.handoff.taskId?.trim() ?? '';
      const toWorkerId = input.handoff.toWorkerId?.trim() ?? '';
      const reason = missionText('handoff.reason', input.handoff.reason, MAX_HANDOFF_REASON_LENGTH, true);
      if (!handoffTask || !toWorkerId) return fail('invalid_input', 'a handoff names a taskId and a toWorkerId');
      if (!reason.ok) return fail('invalid_input', reason.message);
      if (toWorkerId === input.requestedBy) {
        return fail('invalid_input', 'a handoff names ANOTHER worker; a worker cannot hand a task to itself');
      }
      handoff = { taskId: handoffTask, toWorkerId, reason: reason.value! };
    } else if (input.handoff !== undefined) {
      return fail('invalid_input', 'only a handoff_request carries a handoff');
    }
    const declared = input.declaredBinding;
    if (declared !== undefined) {
      if (declared == null || typeof declared !== 'object' || Array.isArray(declared)) {
        return fail('invalid_input', 'declaredBinding must be an object');
      }
      if ((declared.modelId === undefined) !== (declared.modelVersion === undefined)) {
        return fail('invalid_input', 'declaredBinding names modelId and modelVersion together, or neither');
      }
    }

    const refusedActor = this.#resolveContributor(input.requestedBy, 'record a contribution');
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#collaborationContributeCapabilityGate('record a contribution');
    if (refusedCapability) return refusedCapability;
    if (!this.#collaborationStorePresent) {
      return fail('invalid_input', 'collaboration store unavailable on this database handle');
    }
    try {
      assertNoSecretLikeContent({
        content: content.value,
        artifactRefs: artifactRefs.value,
        reason: handoff?.reason ?? null,
      });
    } catch (error) {
      return fail('invalid_input', errorMessage(error));
    }
    if (handoff) {
      const refusedTarget = this.#rejectNotACollaboratingWorker(handoff.toWorkerId, 'receive a handoff');
      if (refusedTarget) return refusedTarget;
    }

    const privileged = this.#requirePrivilegedQueue();
    let refusal: OpsError | null = null;
    let dedupedTo: string | null = null;
    let createdId: string | null = null;
    privileged.reserve(() => {
      const session = loadCollaborationSession(this.#db, sessionId);
      if (!session) {
        refusal = { code: 'unknown_session', message: `Unknown collaboration session: ${sessionId}` };
        return;
      }
      const mission = this.#missionStatusFromStore(session.missionId);
      if (sessionStandingFor(mission?.status ?? null) === 'closed') {
        refusal = {
          code: 'session_closed',
          message: `Collaboration session ${sessionId} is closed: mission ${session.missionId} is ${mission?.status ?? 'gone'}`,
          details: { missionStatus: mission?.status ?? null },
        };
        return;
      }
      // Membership: the roles THIS worker holds in THIS session, from the
      // canonical rows. A worker cannot contribute under a role it was not
      // admitted to, and cannot contribute at all where it was not admitted.
      const held = (
        this.#db
          .prepare(`SELECT role FROM hq_collab_participants WHERE session_id = ? AND worker_id = ? ORDER BY seq`)
          .all(sessionId, input.requestedBy) as { role: CollaborationRole }[]
      ).map((r) => r.role);
      if (held.length === 0) {
        refusal = {
          code: 'not_a_participant',
          message: `${input.requestedBy} was not admitted to collaboration session ${sessionId}; a contribution is recorded only for an admitted worker`,
          details: { workerId: input.requestedBy, sessionId },
        };
        return;
      }
      let role: CollaborationRole;
      if (input.role !== undefined) {
        if (!held.includes(input.role)) {
          refusal = {
            code: 'not_a_participant',
            message: `${input.requestedBy} holds role(s) ${held.join(', ')} in session ${sessionId}, not ${input.role}; a role is admission metadata and cannot be self-assigned`,
            details: { workerId: input.requestedBy, held, requested: input.role },
          };
          return;
        }
        role = input.role;
      } else if (held.length === 1) {
        role = held[0]!;
      } else {
        refusal = {
          code: 'invalid_input',
          message: `${input.requestedBy} holds several roles in session ${sessionId} (${held.join(', ')}); name the one this contribution is made in`,
          details: { held },
        };
        return;
      }
      // Provider/model truth, from the canonical rows — never from the input.
      const binding = this.#workerBindingFromStore(input.requestedBy);
      if (declared) {
        if (declared.providerId !== undefined && declared.providerId !== binding.providerId) {
          refusal = {
            code: 'provider_binding_mismatch',
            message:
              `${input.requestedBy} declares execution provider ${declared.providerId} but HQ's canonical declaration ` +
              `for it is ${binding.providerId ?? 'none (undeclared)'}. Provider identity is declared by the Founder, never ` +
              'asserted by the worker, and never substituted.',
            details: { declaredProvider: declared.providerId, canonicalProvider: binding.providerId },
          };
          return;
        }
        if (declared.modelId !== undefined) {
          const registered = binding.member;
          if (!registered || registered.modelId !== declared.modelId || registered.modelVersion !== declared.modelVersion) {
            refusal = {
              code: 'provider_binding_mismatch',
              message:
                `${input.requestedBy} declares model ${declared.modelId}@${declared.modelVersion} but HQ's registered identity ` +
                `for it is ${registered ? registered.identityKey : 'none (no registered AI member under this worker id)'}. ` +
                'Model identity is fixed at registration, never asserted by the worker, and never substituted.',
              details: {
                declaredModel: `${declared.modelId}@${declared.modelVersion}`,
                registeredIdentityKey: registered?.identityKey ?? null,
              },
            };
            return;
          }
        }
      }
      // Every reference must be real — and a task reference must be one the
      // session's mission actually links (one canonical task truth).
      const linkedProbe = this.#db.prepare(`SELECT 1 FROM hq_mission_plan_items WHERE mission_id = ? AND task_id = ?`);
      if (taskId && !linkedProbe.get(session.missionId, taskId)) {
        refusal = {
          code: 'invalid_input',
          message: `Task ${taskId} is not linked to a plan item of mission ${session.missionId}; a contribution references only the mission's own tasks`,
        };
        return;
      }
      if (handoff && !linkedProbe.get(session.missionId, handoff.taskId)) {
        refusal = {
          code: 'invalid_input',
          message: `Task ${handoff.taskId} is not linked to a plan item of mission ${session.missionId}; a handoff names only the mission's own tasks`,
        };
        return;
      }
      if (handoff) {
        // Re-derived INSIDE the write lock (Wave-2 correction `0b6c108`: every
        // authority gate is revalidated where the write happens). The pre-lock
        // check above is kept so the refusal order is unchanged; this is the
        // reading the INSERT depends on.
        const refusedTargetInLock = this.#rejectNotACollaboratingWorker(handoff.toWorkerId, 'receive a handoff');
        if (refusedTargetInLock && !refusedTargetInLock.ok) {
          refusal = refusedTargetInLock.error;
          return;
        }
      }
      const missingEvidence = this.#missingEvidenceIds(evidenceRefs.value);
      if (missingEvidence.length > 0) {
        refusal = {
          code: 'unknown_evidence',
          message: `Unknown evidence id(s): ${missingEvidence.join(', ')} — a contribution may only reference evidence that exists`,
          details: { missing: missingEvidence },
        };
        return;
      }
      if (truthRefs.value.length > 0) {
        // founder_only truth is refused with the SAME code as an absent id: a
        // worker learns nothing about private records by probing.
        const probe = this.#truthStorePresent
          ? this.#db.prepare(`SELECT privacy FROM hq_truth_records WHERE id = ?`)
          : null;
        const missingTruth = truthRefs.value.filter((id) => {
          const row = probe?.get(id) as { privacy: string } | undefined;
          return row === undefined || row.privacy === 'founder_only';
        });
        if (missingTruth.length > 0) {
          refusal = {
            code: 'unknown_truth',
            message: `Unknown truth record(s): ${missingTruth.join(', ')}`,
            details: { missing: missingTruth },
          };
          return;
        }
      }
      const sameSession = this.#db.prepare(`SELECT 1 FROM hq_collab_contributions WHERE id = ? AND session_id = ?`);
      for (const [via, ids] of [
        ['agreesWith', agreesWith.value],
        ['disagreesWith', disagreesWith.value],
        ['respondsTo', respondsTo.value],
      ] as const) {
        const missing = ids.filter((id) => sameSession.get(id, sessionId) === undefined);
        if (missing.length > 0) {
          refusal = {
            code: 'unknown_contribution',
            message: `Unknown contribution(s) in ${via}: ${missing.join(', ')} — a stance names a contribution of the same session`,
            details: { via, missing },
          };
          return;
        }
      }
      const idempotencyKey = contributionIdempotencyKey({
        workerId: input.requestedBy,
        sessionId,
        role,
        kind: input.kind,
        taskId,
        content: content.value!,
        artifactRefs: artifactRefs.value,
        evidenceRefs: evidenceRefs.value,
        truthRefs: truthRefs.value,
        agreesWith: agreesWith.value,
        disagreesWith: disagreesWith.value,
        respondsTo: respondsTo.value,
        handoff,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      const existing = this.#db
        .prepare(`SELECT id FROM hq_collab_contributions WHERE idempotency_key = ?`)
        .get(idempotencyKey) as { id: string } | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      const id = `collab-c-${uuid()}`;
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_collab_contributions (id, session_id, mission_id, task_id, worker_id, role, kind, content,
             artifact_refs, evidence_refs, truth_refs, provider_id, member_identity_key, binding_source,
             handoff_task_id, handoff_to_worker_id, handoff_reason, at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          sessionId,
          session.missionId,
          taskId,
          input.requestedBy,
          role,
          input.kind,
          content.value,
          JSON.stringify(artifactRefs.value),
          JSON.stringify(evidenceRefs.value),
          JSON.stringify(truthRefs.value),
          binding.providerId,
          binding.member?.identityKey ?? null,
          binding.source,
          handoff?.taskId ?? null,
          handoff?.toWorkerId ?? null,
          handoff?.reason ?? null,
          at,
          idempotencyKey,
        );
      const insertRelation = this.#db.prepare(
        `INSERT INTO hq_collab_relations (id, from_id, kind, to_id, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const toId of agreesWith.value) insertRelation.run(uuid(), id, 'agrees_with', toId, input.requestedBy, at);
      for (const toId of disagreesWith.value) insertRelation.run(uuid(), id, 'disagrees_with', toId, input.requestedBy, at);
      for (const toId of respondsTo.value) insertRelation.run(uuid(), id, 'responds_to', toId, input.requestedBy, at);
      createdId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `collaboration:${sessionId}`,
        status: null,
        actor: input.requestedBy,
        summary: `Contribution (${input.kind}) by ${input.requestedBy} as ${role} in session ${sessionId}`,
        detail: { contributionId: id, sessionId, missionId: session.missionId, kind: input.kind, role, taskId },
      });
      privileged.appendEvidence({
        taskId,
        actor: input.requestedBy,
        kind: 'collaboration_contributed',
        payload: {
          contributionId: id,
          sessionId,
          missionId: session.missionId,
          missionIntentSeq: mission?.intentSeq ?? null,
          taskId,
          kind: input.kind,
          role,
          providerId: binding.providerId,
          memberIdentityKey: binding.member?.identityKey ?? null,
          bindingSource: binding.source,
          evidenceRefs: evidenceRefs.value,
          truthRefs: truthRefs.value,
          agreesWith: agreesWith.value,
          disagreesWith: disagreesWith.value,
          handoff: handoff ? { taskId: handoff.taskId, toWorkerId: handoff.toWorkerId, advisory: true } : null,
          executable: false,
        },
      });
    });
    if (refusal) return { ok: false, error: refusal };
    const id = dedupedTo ?? createdId!;
    return ok({ contribution: this.#contributionViewById(id)!, deduplicated: dedupedTo !== null });
  }

  getCollaborationSession(id: string): CollaborationSessionView | null {
    if (!id || !this.#collaborationStorePresent) return null;
    const row = loadCollaborationSession(this.#db, id);
    return row ? this.#sessionView(row) : null;
  }

  /** Every session, newest first, with its derived standing; optionally one mission's. */
  listCollaborationSessions(filter?: { missionId?: string }): CollaborationSessionView[] {
    if (!this.#collaborationStorePresent) return [];
    return loadCollaborationSessions(this.#db, filter?.missionId?.trim() || undefined).map((row) => this.#sessionView(row));
  }

  /** Bounded list plus the true total, for the wire. */
  listCollaborationSessionsBounded(filter?: { missionId?: string }): {
    sessions: CollaborationSessionView[];
    total: number;
    truncated: boolean;
  } {
    const all = this.listCollaborationSessions(filter);
    return {
      sessions: all.slice(0, COLLABORATION_READ_LIMIT),
      total: all.length,
      truncated: all.length > COLLABORATION_READ_LIMIT,
    };
  }

  /** One session's contributions, newest first, with the true total. */
  listContributions(sessionId: string): { contributions: ContributionView[]; total: number } {
    if (!sessionId || !this.#collaborationStorePresent) return { contributions: [], total: 0 };
    const rows = loadContributions(this.#db, sessionId);
    const relations = loadSessionRelations(this.#db, sessionId);
    const ctx = this.#contributionContext(true);
    const views = rows.map((row) => deriveContributionView(row, rows, relations, ctx)).sort((a, b) => b.seq - a.seq);
    return { contributions: views, total: views.length };
  }

  /**
   * The Founder's Mission Room: the canonical mission, its execution state
   * (linked tasks, blockers, kill switches — the Phase 6 read), every
   * session with its admitted workers, the actual contributions, the
   * explicit disagreements, handoff requests beside the canonical claim /
   * assignment they did not change, the truth records about the mission and
   * its tasks, the tasks held at the Founder gate, recent orchestration runs and the external
   * actions on the ledger. Composition only — writes nothing, transitions
   * nothing, and invents no activity.
   */
  getMissionRoom(missionId: string): OpsResult<MissionRoomView> {
    const id = missionId?.trim() ?? '';
    if (!id) return fail('invalid_input', 'missionId is required');
    const mission = this.#missionRecord(id);
    if (!mission) return fail('unknown_mission', `Unknown mission: ${id}`);
    const at = nowIso();
    const execution = this.#missionExecutionState(mission);
    const linkedTaskIds = execution.linkedTasks.map((task) => task.taskId);
    const ctx = this.#contributionContext(true);

    const sessionRows = this.#collaborationStorePresent ? loadCollaborationSessions(this.#db, id) : [];
    const sessions: CollaborationSessionView[] = [];
    const contributions: ContributionView[] = [];
    const disagreements: DisagreementView[] = [];
    const handoffs: HandoffRequestView[] = [];
    const participants = new Map<string, MissionRoomView['participants'][number]>();
    for (const row of sessionRows) {
      const people = loadParticipants(this.#db, row.id);
      const rows = loadContributions(this.#db, row.id);
      const relations = loadSessionRelations(this.#db, row.id);
      sessions.push(deriveSessionView(row, mission.status, people, rows, relations));
      for (const person of people) {
        const entry = participants.get(person.workerId) ?? {
          workerId: person.workerId,
          roles: [],
          providerId: person.providerId,
          memberIdentityKey: person.memberIdentityKey,
        };
        if (!entry.roles.includes(person.role)) entry.roles.push(person.role);
        participants.set(person.workerId, entry);
      }
      for (const c of rows) contributions.push(deriveContributionView(c, rows, relations, ctx));
      disagreements.push(...deriveDisagreements(rows, relations));
      handoffs.push(...deriveHandoffRequests(rows, ctx.taskStateOf));
    }
    contributions.sort((a, b) => b.seq - a.seq);
    disagreements.sort((a, b) => b.at.localeCompare(a.at));
    handoffs.sort((a, b) => b.at.localeCompare(a.at));

    // DECIDED, not overlooked (Phase 9 correction, H1's adjacent audit): this
    // read stays on the public `listTruth` / `listTruthContradictions`
    // projections. `getMissionRoom` has exactly ONE caller and it is
    // Founder-gated (`missionRoomRoute`, behind `ResolvedFounder`), it carries
    // founder_only truth by design exactly as `GET /truth` does, and nothing
    // it returns crosses to another principal. A same-realm patch of those
    // methods therefore misinforms the patcher's own display and changes no
    // disclosure decision — the standard this module already records for
    // `readMeta` and the kill-switch reads. The context bundle is the
    // opposite case (it is assembled FOR another worker) and reads the
    // private derivation; see `assembleCollaborationContext`.
    const truthAll = this.listTruth().filter(
      (view) =>
        (view.entityKind === 'mission' && view.entityId === id) ||
        (view.entityKind === 'task' && linkedTaskIds.includes(view.entityId)),
    );
    const truthIds = new Set(truthAll.map((view) => view.id));
    const unresolved = this.listTruthContradictions().filter(
      (pair) => pair.resolution === 'unresolved' && (truthIds.has(pair.a) || truthIds.has(pair.b)),
    ).length;

    // What the Founder gate is HOLDING on this mission, read from the same
    // canonical fact the Founder Inbox and WHAT IS BLOCKED read
    // (`op_tasks.status = 'needs_approval'`).
    //
    // Corrected with Phase 10's M1, whose defect this shared: the list used to
    // select `hq_approvals` rows with `decision = 'pending'`, a state the
    // canonical facade never writes — `approveTask` and `denyTask` each insert
    // the row when the decision is MADE — so this card said "No approval is
    // pending on this mission's tasks" over a mission with real work held at
    // the gate. There is no approval id to name here, by design.
    const heldTaskIds = execution.linkedTasks.filter((task) => task.status === 'needs_approval').map((task) => task.taskId);
    const heldForApproval =
      heldTaskIds.length === 0
        ? []
        : (this.#db
            .prepare(
              `SELECT id, capability_id, created_by, updated_at FROM op_tasks
               WHERE id IN (${heldTaskIds.map(() => '?').join(',')})
               ORDER BY updated_at`,
            )
            .all(...heldTaskIds) as Record<string, unknown>[]).map((r) => ({
            taskId: r.id as string,
            capabilityId: r.capability_id as string,
            requestedBy: r.created_by as string,
            since: r.updated_at as string,
          }));

    const runs = listOrchestrationRuns(this.#db, id)
      .reverse()
      .slice(0, MISSION_ROOM_RUN_LIMIT)
      .map((run) => ({ runId: run.id, requestedBy: run.requestedBy, at: run.at, summary: run.summary }));

    const actionRows = this.#actionStorePresent
      ? loadActionIntents(this.#db).filter((row) => row.missionId === id || linkedTaskIds.includes(row.taskId))
      : [];
    const actions = actionRows.map((row) => {
      const view = deriveActionView(row, loadActionEvents(this.#db, row.id));
      return {
        id: view.id,
        taskId: view.taskId,
        adapterId: view.adapterId,
        actionType: view.actionType,
        riskLevel: view.riskLevel,
        state: view.state,
        requestedBy: view.requestedBy,
        requestedAt: view.requestedAt,
      };
    });

    return ok({
      missionId: id,
      mission: missionBrowserView(mission),
      execution,
      sessions,
      participants: [...participants.values()].sort((a, b) => a.workerId.localeCompare(b.workerId)),
      contributions: {
        items: contributions.slice(0, MISSION_ROOM_CONTRIBUTION_LIMIT),
        total: contributions.length,
        truncated: contributions.length > MISSION_ROOM_CONTRIBUTION_LIMIT,
      },
      disagreements,
      handoffRequests: handoffs,
      truth: {
        records: truthAll.slice(0, TRUTH_SNAPSHOT_LIMIT),
        total: truthAll.length,
        truncated: truthAll.length > TRUTH_SNAPSHOT_LIMIT,
        unresolvedContradictions: unresolved,
      },
      heldForApproval,
      recentRuns: runs,
      externalActions: {
        items: actions.slice(0, MISSION_ROOM_RUN_LIMIT),
        total: actions.length,
        truncated: actions.length > MISSION_ROOM_RUN_LIMIT,
      },
      assembledAt: at,
      provenance: {
        mode: 'live',
        source:
          'hq_missions / op_tasks / hq_collab_* / hq_truth_* / hq_approvals / hq_orchestration_runs / hq_action_intents ' +
          'via HeadquarterOperations.getMissionRoom (read-time composition of canonical projections; writes nothing)',
        asOf: at,
      },
    });
  }

  /**
   * Assemble the bounded context bundle a worker admitted under `role`
   * receives for a session — or, for a human holding the collaboration
   * command grant, an audit of exactly what that role would receive. A
   * worker may request only a role it holds in that session. Read-time
   * composition: persists nothing and changes no canonical truth.
   *
   * Scope is the whole design: the ONE mission's current structured intent
   * (never the raw order text), the ONE task's minimal ref when named (never
   * its payload), the session's own participants and contributions (never
   * another session's), truth records about the mission/its tasks that are
   * not founder_only, and entity-linked memory that is not founder_only —
   * each section only where `CONTEXT_SECTIONS_BY_ROLE` grants it, each list
   * bounded to `COLLABORATION_CONTEXT_LIMIT` with the true total stated, and
   * everything withheld counted rather than silently dropped.
   *
   * The gates a WORKER passes are the SAME ones `recordContribution` applies,
   * re-derived here rather than assumed (Phase 9 correction, Medium M2 — the
   * bundle previously survived every stop lever the write paths honour):
   *
   * - identity and grant through `#resolveContributor` (registered, assignable,
   *   `hq.collaboration_contribute` in the directory grant read by `#grantOf`);
   * - the capability trio through `#collaborationContributeCapabilityGate`,
   *   which reads the DATABASE row — a disabled or drifted capability closes
   *   the read exactly as it closes the write;
   * - membership in THIS session, from the canonical participant rows;
   * - the session's DERIVED standing, from `hq_missions.status` through `#db`:
   *   a cancelled/complete/failed mission closes the room, and a worker gets
   *   `session_closed` from the read just as it does from the write.
   *
   * The Founder-gated audit path is deliberately different on the last point:
   * a human holding `hq.collaboration_command` may still read a CLOSED
   * session's bundle, because auditing what a role received is precisely what
   * is needed after a mission is cancelled. It is a read that grants nothing
   * and hands nothing to a worker. Pinned by test.
   *
   * No-oracle rule (Low L4): for a WORKER, "this session does not exist" and
   * "you are not in this session" are the SAME refusal, byte for byte — the
   * discipline this module already applies to founder_only truth refs. A
   * worker already inside a session may be told it holds a different role
   * there; that discloses nothing it did not know.
   */
  assembleCollaborationContext(input: {
    sessionId: string;
    role: CollaborationRole;
    taskId?: string;
    requestedBy: string;
  }): OpsResult<CollaborationContextBundle> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const sessionId = input.sessionId?.trim() ?? '';
    if (!sessionId) return fail('invalid_input', 'sessionId is required');
    if (!isCollaborationRole(input.role)) {
      return fail('invalid_input', `role must be one of: ${COLLABORATION_ROLES.join(', ')}`);
    }
    const taskId = input.taskId?.trim() || null;
    // Identity first — an unknown id learns nothing about which sessions exist.
    if (input.requestedBy === 'system') {
      return fail('not_permitted', "'system' cannot assemble a context bundle: a resolved worker or human principal is required");
    }
    const isWorker = this.#isRegisteredWorker(input.requestedBy);
    if (isWorker) {
      // Identity + assignability + the directory grant, then the capability
      // trio from the DATABASE row — the same two gates, in the same order,
      // that `recordContribution` applies before it takes the write lock.
      const refusedActor = this.#resolveContributor(input.requestedBy, 'assemble a context bundle');
      if (refusedActor) return refusedActor;
      const refusedCapability = this.#collaborationContributeCapabilityGate('assemble a context bundle');
      if (refusedCapability) return refusedCapability;
    } else {
      const refused = this.#resolveCollaborationCommander(input.requestedBy, 'assemble a context bundle');
      if (refused) return refused;
      const refusedCapability = this.#collaborationCommandCapabilityGate('assemble a context bundle');
      if (refusedCapability) return refusedCapability;
    }
    if (!this.#collaborationStorePresent) {
      return fail('invalid_input', 'collaboration store unavailable on this database handle');
    }
    // ONE refusal for "no such session" and, for a worker, for "a session you
    // are not in" — identical code, message and details, so a worker cannot
    // use this read to enumerate which sessions exist (Low L4).
    const unknownSession = (): OpsResult<never> =>
      fail('unknown_session', `Unknown collaboration session: ${sessionId}`);
    const session = loadCollaborationSession(this.#db, sessionId);
    if (!session) return unknownSession();
    if (isWorker) {
      // The roles this worker actually holds HERE, from the canonical rows.
      const held = (
        this.#db
          .prepare(`SELECT role FROM hq_collab_participants WHERE session_id = ? AND worker_id = ? ORDER BY seq`)
          .all(sessionId, input.requestedBy) as { role: CollaborationRole }[]
      ).map((r) => r.role);
      if (held.length === 0) return unknownSession();
      if (!held.includes(input.role)) {
        return fail(
          'not_permitted',
          `${input.requestedBy} holds role(s) ${held.join(', ')} in session ${sessionId}, not ${input.role}; a worker receives only the bundle of a role it holds`,
          { workerId: input.requestedBy, held, requested: input.role },
        );
      }
      // The session's standing, DERIVED from the mission's canonical status
      // read through `#db` — never `getMission`, never a public projection.
      // A stop lever that closes the room for the write closes it for the read.
      const missionStatus = this.#missionStatusFromStore(session.missionId);
      if (sessionStandingFor(missionStatus?.status ?? null) === 'closed') {
        return fail(
          'session_closed',
          `Collaboration session ${sessionId} is closed: mission ${session.missionId} is ${missionStatus?.status ?? 'gone'}; a worker receives no bundle from a closed room`,
          { missionStatus: missionStatus?.status ?? null },
        );
      }
    }
    const mission = this.#missionRecord(session.missionId);
    if (!mission) return fail('unknown_mission', `Unknown mission: ${session.missionId}`);
    const linkedTaskIds = mission.planItems.map((item) => item.taskId).filter((t): t is string => t != null);
    if (taskId && !linkedTaskIds.includes(taskId)) {
      return fail('invalid_input', `Task ${taskId} is not linked to a plan item of mission ${mission.id}`);
    }
    const sections = CONTEXT_SECTIONS_BY_ROLE[input.role];
    const has = (section: ContextSection) => sections.includes(section);
    const at = nowIso();

    let task: TaskContextRef | null = null;
    if (has('task') && taskId) {
      const row = this.#db
        .prepare(`SELECT id, capability_id, status, created_at FROM op_tasks WHERE id = ?`)
        .get(taskId) as { id: string; capability_id: string; status: string; created_at: string } | undefined;
      if (row) task = { taskId: row.id, capabilityId: row.capability_id, status: row.status as ActivityStatus, createdAt: row.created_at };
    }

    const participants = has('participants') ? loadParticipants(this.#db, sessionId).map(participantView) : null;

    let contributions: CollaborationContextBundle['contributions'] = null;
    if (has('contributions')) {
      const rows = loadContributions(this.#db, sessionId);
      const relations = loadSessionRelations(this.#db, sessionId);
      const ctx = this.#contributionContext(false);
      const relevant = rows
        .filter((row) => (taskId ? row.taskId === taskId || row.taskId === null : true))
        .map((row) => deriveContributionView(row, rows, relations, ctx))
        .sort((a, b) => b.seq - a.seq);
      contributions = { items: relevant.slice(0, COLLABORATION_CONTEXT_LIMIT), total: relevant.length };
    }
    const otherSessionContributions = (
      this.#db
        .prepare(`SELECT COUNT(*) AS n FROM hq_collab_contributions WHERE mission_id = ? AND session_id <> ?`)
        .get(mission.id, sessionId) as { n: number }
    ).n;

    let truth: CollaborationContextBundle['truth'] = null;
    let founderOnlyTruth = 0;
    if (has('truth')) {
      const scopeTasks = taskId ? [taskId] : linkedTaskIds;
      // The PRIVATE derivation over the canonical graph — never `listTruth()`.
      //
      // `listTruth` is a public, patchable prototype method, and this bundle
      // crosses principals: it is assembled for ANOTHER worker. A same-realm
      // patch that wrapped the original and relabelled `privacy` on the real
      // rows both pushed a genuine founder_only record into a worker's bundle
      // and drove `withheld.founderOnlyTruth` to 0, so the bundle's own
      // honesty field concealed the disclosure (Phase 9 correction, High H1).
      // The same private derivation `#contributionContext` already uses is the
      // enforcement-safe read; the privacy filter runs on the derived row.
      const derived = this.#truthStorePresent
        ? [...this.#deriveAllTruth(loadTruthGraph(this.#db)).values()].sort((a, b) => b.seq - a.seq)
        : [];
      const about = derived.filter(
        (view) =>
          (view.entityKind === 'mission' && view.entityId === mission.id) ||
          (view.entityKind === 'task' && scopeTasks.includes(view.entityId)),
      );
      const visible = about.filter((view) => view.privacy !== 'founder_only');
      founderOnlyTruth = about.length - visible.length;
      truth = {
        items: visible.slice(0, COLLABORATION_CONTEXT_LIMIT).map((view) => ({
          id: view.id,
          entityKind: view.entityKind,
          entityId: view.entityId,
          statement: view.statement,
          state: view.state,
          contested: view.contested,
          evidenceRefs: [...view.evidenceRefs],
        })),
        total: visible.length,
      };
    }

    let memory: CollaborationContextBundle['memory'] = null;
    let founderOnlyMemory = 0;
    if (has('memory')) {
      const store = this.#memory;
      const notPrivate = (records: CompanyMemoryRecord[]): CompanyMemoryRecord[] => {
        const visible = records.filter((record) => record.privacy !== 'founder_only');
        founderOnlyMemory += records.length - visible.length;
        return visible;
      };
      const groups = taskId
        ? assembleMemoryGroups({
            direct: notPrivate(store?.listByTaskId(taskId) ?? []),
            directLinkage: 'task',
            lookup: (memoryId) => {
              const record = store?.get(memoryId) ?? null;
              if (record?.privacy === 'founder_only') {
                founderOnlyMemory += 1;
                return null;
              }
              return record;
            },
          })
        : assembleMemoryGroups({
            direct: notPrivate(store?.listByMissionId(mission.id) ?? []),
            directLinkage: 'mission',
            taskLinked: notPrivate(store ? linkedTaskIds.flatMap((t) => store.listByTaskId(t)) : []),
            projectLinked: notPrivate(store && mission.projectId ? store.listByProjectRef(mission.projectId) : []),
            lookup: (memoryId) => {
              const record = store?.get(memoryId) ?? null;
              if (record?.privacy === 'founder_only') {
                founderOnlyMemory += 1;
                return null;
              }
              return record;
            },
          });
      memory = { groups };
    }

    const view = missionBrowserView(mission);
    return ok({
      sessionId,
      missionId: mission.id,
      role: input.role,
      taskId,
      assembledAt: at,
      sections,
      mission: {
        id: view.id,
        title: view.title,
        objective: view.objective,
        scope: view.scope,
        constraints: [...view.constraints],
        acceptanceCriteria: view.acceptanceCriteria ? [...view.acceptanceCriteria] : null,
        status: view.status,
        priority: view.priority,
        blockReason: view.blockReason,
        intentSeq: view.intentHistory.reduce((max, entry) => Math.max(max, entry.seq), 0),
        planItems: view.planItems.map((item) => ({
          seq: item.seq,
          summary: item.summary,
          kind: item.kind,
          state: item.state,
          taskId: item.taskId,
          specCapabilityId: item.specCapabilityId,
        })),
      },
      task,
      participants,
      contributions,
      truth,
      memory,
      withheld: isWorker
        ? {
            audience: 'worker',
            founderOnlyMemory: founderOnlyMemory > 0,
            founderOnlyTruth: founderOnlyTruth > 0,
            otherSessionContributions,
          }
        : { audience: 'founder_audit', founderOnlyMemory, founderOnlyTruth, otherSessionContributions },
      provenance: {
        mode: 'live',
        source:
          `bounded role-scoped assembly for ${input.role} over hq_missions, hq_collab_* (this session only), ` +
          'hq_truth_records (internal only, through the private truth derivation over the canonical graph — never the ' +
          'public listTruth projection), hq_memory (entity-linked, internal only) via ' +
          'HeadquarterOperations.assembleCollaborationContext; raw intent bodies, task payloads and founder_only records never travel',
        asOf: at,
      },
    });
  }

  /**
   * The bounded snapshot view: counts HQ made over the sessions this reader
   * may see, plus the newest of them.
   *
   * The reading layer's privacy decision is the caller's
   * (`includeFounderOnly`, exactly as `truthSummary`) and it DEFAULTS to the
   * less-disclosing answer: a caller that says nothing gets no `founder_only`
   * session material. Withheld sessions stay in `sessions` and are counted in
   * `withheldFounderOnly`; nothing else aggregates over them, so arithmetic on
   * the artifact discloses no categorical fact about a private session.
   *
   * A carried session's free-text `purpose` is withheld unless the caller is
   * past a gate (`includeFounderOnly: true`): the privacy vocabulary has no
   * level that classifies text for an unauthenticated reader, so the
   * unauthenticated artifact never publishes one verbatim. The number
   * withheld is stated in `withheldPurposes` rather than silently nulled.
   *
   * The rows are read through `loadCollaborationSessions(#db)` + the private
   * `#sessionView`, NOT through the public `listCollaborationSessions()`
   * projection (Phase 10 correction, L1 — the Phase 9 High applied here).
   * This read decides an UNAUTHENTICATED disclosure, so a same-realm patch
   * that wrapped the public method and relabelled `privacy` on the real rows
   * would otherwise both publish a genuine founder_only room and zero the
   * `withheldFounderOnly` honesty field beside it.
   */
  collaborationSummary(options: { includeFounderOnly?: boolean; limit?: number } = {}): CollaborationSnapshotView {
    const limit = options.limit ?? COLLABORATION_SNAPSHOT_LIMIT;
    const includeFounderOnly = options.includeFounderOnly === true;
    const all = this.#collaborationStorePresent
      ? loadCollaborationSessions(this.#db).map((row) => this.#sessionView(row))
      : [];
    const sessions = includeFounderOnly ? all : all.filter((session) => session.privacy !== 'founder_only');
    const workers = new Set<string>();
    let contributions = 0;
    let disagreements = 0;
    let handoffRequests = 0;
    for (const session of sessions) {
      for (const participant of session.participants) workers.add(participant.workerId);
      contributions += session.contributionCount;
      disagreements += session.disagreementCount;
      handoffRequests += session.handoffRequestCount;
    }
    const page = sessions.slice(0, limit);
    return {
      sessions: all.length,
      withheldFounderOnly: all.length - sessions.length,
      withheldPurposes: includeFounderOnly ? 0 : page.filter((session) => session.purpose !== null).length,
      activeSessions: sessions.filter((session) => session.standing === 'active').length,
      workersAdmitted: workers.size,
      contributions,
      disagreements,
      handoffRequests,
      recent: includeFounderOnly ? page : page.map(snapshotSessionView),
    };
  }

  /** Whether this database handle carries the Phase 9 collaboration tables. */
  collaborationStorePresent(): boolean {
    return this.#collaborationStorePresent;
  }

  // ---- collaboration internals ----

  #resolveCollaborationCommander(actor: string, action: string): OpsResult<never> | null {
    return this.#resolveFounderGateActor(actor, action, COLLABORATION_COMMAND_CAPABILITY.id, 'commanding a collaboration');
  }

  #collaborationCommandCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      COLLABORATION_COMMAND_CAPABILITY.id,
      collaborationCommandCapabilityState,
      collaborationCommandContractDrift,
      'commanding a collaboration',
    );
  }

  #collaborationContributeCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      COLLABORATION_CONTRIBUTE_CAPABILITY.id,
      collaborationContributeCapabilityState,
      collaborationContributeContractDrift,
      'contributing to a collaboration',
    );
  }

  /**
   * Actor resolution for a contribution: a registered, assignable WORKER
   * holding `hq.collaboration_contribute` through its directory grant.
   * `system` is refused (an unattributed contribution is the fabricated
   * activity this phase forbids); a human principal is refused because
   * humans direct missions through mission command and a room's
   * contributions are worker acts; an unknown id is nobody.
   */
  #resolveContributor(actor: string, action: string): OpsResult<never> | null {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}: a resolved worker is required`);
    }
    const resolved = this.#resolveRequester(actor, action);
    if (!resolved.ok) return resolved;
    if (resolved.data.kind === 'human') {
      return fail(
        'not_permitted',
        `Human principal ${actor} cannot ${action}: contributions are worker acts; the Founder directs a mission through mission command`,
        { actor },
      );
    }
    if (!this.#grantOf(actor).includes(COLLABORATION_CONTRIBUTE_CAPABILITY.id)) {
      return fail(
        'not_permitted',
        `${actor} may not ${action}: the worker directory grants no ${COLLABORATION_CONTRIBUTE_CAPABILITY.id}`,
        { actor },
      );
    }
    return null;
  }

  /**
   * Whether `workerId` may appear in a room at all: a registered, assignable
   * execution worker — read through the enforcement closures — and never a
   * human principal (a human admitted "as a worker" would let human identity
   * read as worker identity). Unknown ids are nobody; nothing is invented.
   */
  #rejectNotACollaboratingWorker(workerId: string, action: string): OpsResult<never> | null {
    if (this.#principalOf(workerId)) {
      return fail(
        'not_permitted',
        `${workerId} is a human principal and cannot ${action}: humans direct missions and are never admitted as a collaborating worker`,
        { workerId },
      );
    }
    if (!this.#isRegisteredWorker(workerId)) {
      return fail(
        'unknown_principal',
        `Unknown worker ${workerId} cannot ${action}: only a registered execution worker can, and no worker is invented`,
        { workerId },
      );
    }
    const assignability = this.#workers.assignability(workerId);
    if (!assignability.assignable) return this.#rejectNotAssignable(workerId, assignability, action);
    return null;
  }

  /**
   * The canonical provider/model binding of a worker, read from the rows
   * through `#db`: the operator's declared execution provider
   * (`op_worker_providers`, routing vocabulary) and, when the registry schema
   * exists, the ACTIVE registered AI member under the same id
   * (`hq_ai_members`, registry vocabulary). The two vocabularies are disjoint
   * and are reported side by side — never compared, never inferred from the
   * specialist's vendor string. Absence is reported as absence.
   */
  #workerBindingFromStore(workerId: string): {
    providerId: string | null;
    member: { identityKey: string; modelId: string; modelVersion: string } | null;
    source: BindingSource;
  } {
    const declared = this.#db
      .prepare(`SELECT provider_id FROM op_worker_providers WHERE worker_id = ?`)
      .get(workerId) as { provider_id: string } | undefined;
    let member: { identityKey: string; modelId: string; modelVersion: string } | null = null;
    // The issue-#119 registry schema is ensured by whoever constructs an
    // `AiMemberRegistry` — possibly after this service. Probed at read time
    // so the ROW (never the registry object) answers, and a file with no such
    // table truthfully reports no registered model identity.
    const registryTable = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hq_ai_members'`)
      .get();
    if (registryTable !== undefined) {
      const row = this.#db
        .prepare(`SELECT identity_key, model_id, model_version FROM hq_ai_members WHERE id = ? AND status = 'active' AND enabled = 1`)
        .get(workerId) as { identity_key: string; model_id: string; model_version: string } | undefined;
      if (row) member = { identityKey: row.identity_key, modelId: row.model_id, modelVersion: row.model_version };
    }
    const providerId = declared?.provider_id ?? null;
    return {
      providerId,
      member,
      source: providerId ? (member ? 'declared_provider_and_registered_model' : 'declared_provider') : 'undeclared',
    };
  }

  #sessionView(row: CollaborationSessionRow): CollaborationSessionView {
    const mission = this.#missionStatusFromStore(row.missionId);
    return deriveSessionView(
      row,
      mission?.status ?? null,
      loadParticipants(this.#db, row.id),
      loadContributions(this.#db, row.id),
      loadSessionRelations(this.#db, row.id),
    );
  }

  #contributionViewById(id: string): ContributionView | null {
    const row = loadContribution(this.#db, id);
    if (!row) return null;
    const rows = loadContributions(this.#db, row.sessionId);
    return deriveContributionView(row, rows, loadSessionRelations(this.#db, row.sessionId), this.#contributionContext(true));
  }

  /**
   * The lookups a contribution derivation needs: the truth state each
   * referenced record derives NOW (through the Phase 7 derivation — so a
   * room full of agreement visibly moved nothing), withheld for founder_only
   * records unless the reader is past the Founder gate; and the canonical
   * task row beside a handoff (status, claim, Founder assignment).
   */
  #contributionContext(includeFounderOnly: boolean): ContributionDerivationContext {
    const truthStates = new Map<string, { state: TruthState; founderOnly: boolean }>();
    if (this.#truthStorePresent) {
      for (const view of this.#deriveAllTruth(loadTruthGraph(this.#db)).values()) {
        truthStates.set(view.id, { state: view.state, founderOnly: view.privacy === 'founder_only' });
      }
    }
    return {
      truthStateOf: (truthId) => {
        const entry = truthStates.get(truthId);
        if (!entry) return null;
        if (entry.founderOnly && !includeFounderOnly) return null;
        return entry.state;
      },
      taskStateOf: (taskId): HandoffCanonicalTaskState | null => {
        const row = this.#db.prepare(`SELECT status, claimed_by FROM op_tasks WHERE id = ?`).get(taskId) as
          | { status: string; claimed_by: string | null }
          | undefined;
        if (!row) return null;
        const assignment = this.readMeta(taskId)?.assignment ?? null;
        return {
          status: row.status as ActivityStatus,
          claimedBy: row.claimed_by ?? null,
          assignedWorkerId: assignment?.workerId ?? null,
          assignedBy: assignment?.assignedBy ?? null,
        };
      },
    };
  }

  // ---- Chief of Staff + Command Center (Phase 10) ----

  /**
   * Every canonical fact the derived command layer reads, gathered ONCE per
   * read through `#db` and the private derivations.
   *
   * ONE exception, and it is named rather than glossed: the handoff item's
   * canonical picture reads `this.readMeta(taskId)` inside
   * `#contributionContext.taskStateOf` — the pre-existing Phase 9 display
   * read, still a public prototype method. A same-realm patch of `readMeta`
   * reporting the handoff as already assigned REMOVES a real
   * `handoff_requested` item from the artifact (it cannot add a false one,
   * and it changes no claim, fence or assignment, all of which
   * `assignTaskAsFounder` reads off the canonical rows). Left deliberately —
   * fixing it belongs in the Phase 9 module it lives in — and recorded here
   * and in the Phase 10 doc's patchable-read audit. Every OTHER fact below
   * is read privately.
   *
   * That rule is the Phase 9 High finding applied ahead of time. The Founder
   * Inbox, the briefing and the snapshot section all cross a boundary: they
   * decide what a reader is told about `founder_only` truth, and the snapshot
   * section is published to an UNAUTHENTICATED artifact. A same-realm patch of
   * `listTruth()` that relabelled `privacy` on the real rows would therefore
   * both leak a genuine founder_only record and zero the honesty field beside
   * it — which is exactly what happened to the Phase 9 context bundle. So the
   * truth section here reads `#deriveAllTruth(loadTruthGraph(#db))`, the
   * contradiction list is judged from that same private derivation, the
   * capability rows come from `#capabilityFromStore`, the kill switches from
   * `#killSwitchEngagedFromStore`, the worker binding from
   * `#workerBindingFromStore`, eligibility from `#workerEligibilityFor`, and
   * every remaining row is read straight off `#db`.
   *
   * Nothing here is stored. `CommandFacts` is a value handed to the pure core
   * and dropped; an attention item exists exactly while its source predicate
   * holds on the canonical row and vanishes the moment the source is decided
   * elsewhere.
   */
  #commandFacts(): CommandFacts {
    const now = nowIso();
    const missionIds = this.#missionStorePresent ? listMissionIds(this.#db) : [];
    const taskRows = this.#db
      .prepare(
        `SELECT id, capability_id, status, review_state, claimed_by, created_by, created_at, updated_at,
                block_reason, submitted_by
         FROM op_tasks ORDER BY created_at, id`,
      )
      .all() as Record<string, unknown>[];
    const titleOf = this.#db.prepare(`SELECT title FROM hq_op_task_meta WHERE task_id = ?`);
    const tasks = taskRows.map((row) => ({
      id: row.id as string,
      capabilityId: row.capability_id as string,
      status: row.status as ActivityStatus,
      reviewPending: row.review_state === 'pending',
      claimedBy: (row.claimed_by as string | null) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      blockReason: (row.block_reason as string | null) ?? null,
      submittedBy: (row.submitted_by as string | null) ?? null,
      title: ((titleOf.get(row.id as string) as { title: string | null } | undefined)?.title ?? null) as string | null,
      // The SAME directory/policy predicates enforcement uses, so a task this
      // section calls claimable is one a real worker could genuinely claim.
      eligibleWorkers: this.#workerEligibilityFor(row.capability_id as string),
    }));
    const taskById = new Map(tasks.map((task) => [task.id, task]));

    const missions: MissionFact[] = missionIds.map((missionId) => {
      const record = this.#missionRecord(missionId)!;
      const live = record.planItems.filter((item) => item.supersededInIntentSeq == null);
      const specified = live.filter((item) => item.kind === 'work' && item.specCapabilityId != null);
      return {
        id: record.id,
        title: record.title,
        status: record.status,
        blockReason: record.blockReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        statusChangedAt: record.statusChangedAt,
        // null is the Founder's explicit "not supplied", never an empty list.
        acceptanceCriteriaStated: record.acceptanceCriteria !== null && record.acceptanceCriteria.length > 0,
        dependsOn: record.dependsOn.map((dependencyId) => ({
          missionId: dependencyId,
          // `#missionStatusFromStore`, not the public `getMission`: whether a
          // dependency is terminal decides whether an inbox item exists.
          status: this.#missionStatusFromStore(dependencyId)?.status ?? null,
        })),
        planItems: live.map((item) => ({
          seq: item.seq,
          kind: item.kind,
          taskId: item.taskId,
          specCapabilityId: item.specCapabilityId,
        })),
        linkedTasks: live
          .filter((item) => item.taskId != null)
          .map((item) => {
            const task = taskById.get(item.taskId!);
            return {
              taskId: item.taskId!,
              status: task?.status ?? 'outcome_unknown',
              reviewPending: task?.reviewPending ?? false,
              claimedBy: task?.claimedBy ?? null,
            };
          }),
        engagedSpecScopes: [
          ...new Set(
            specified
              .map((item) => item.specCapabilityId!)
              .filter((capabilityId) => this.#killSwitchEngagedFromStore(capabilityId)),
          ),
        ].sort(),
        specCapabilitiesUnavailable: [
          ...new Set(
            specified
              .map((item) => item.specCapabilityId!)
              .filter((capabilityId) => {
                const row = this.#capabilityFromStore(capabilityId);
                return row === null || !row.enabled;
              }),
          ),
        ].sort(),
      };
    });

    const approvals = (
      this.#db
        .prepare(
          `SELECT id, task_id, risk_class, requested_by, requested_at, decision, decided_by, decided_at,
                  expires_at, consumed_at
           FROM hq_approvals ORDER BY requested_at, id`,
        )
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id as string,
      taskId: (row.task_id as string | null) ?? null,
      riskClass: row.risk_class as string,
      requestedBy: row.requested_by as string,
      requestedAt: row.requested_at as string,
      decision: row.decision as string,
      decidedBy: (row.decided_by as string | null) ?? null,
      decidedAt: (row.decided_at as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
      consumedAt: (row.consumed_at as string | null) ?? null,
    }));

    const killSwitches = (
      this.#db
        .prepare(`SELECT scope, reason, engaged_by, engaged_at FROM op_kill_switch WHERE engaged = 1 ORDER BY scope`)
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      scope: row.scope as string,
      reason: (row.reason as string | null) ?? null,
      engagedBy: (row.engaged_by as string | null) ?? null,
      engagedAt: (row.engaged_at as string | null) ?? null,
    }));

    // Truth + contradictions, both from the PRIVATE derivation over the
    // canonical graph. `listTruth()` / `listTruthContradictions()` are public
    // prototype methods and this read decides disclosure — see the note above.
    const graph = this.#truthStorePresent ? loadTruthGraph(this.#db) : emptyTruthGraph();
    const derived = this.#truthStorePresent ? this.#deriveAllTruth(graph) : new Map<string, TruthRecordView>();
    const truth: TruthFact[] = [...derived.values()]
      .sort((a, b) => b.seq - a.seq)
      .map((view) => ({
        id: view.id,
        seq: view.seq,
        entityKind: view.entityKind,
        entityId: view.entityId,
        statement: view.statement,
        state: view.state,
        lifecycle: view.lifecycle,
        verification: view.verification,
        contested: view.contested,
        recordedBy: view.recordedBy,
        recordedAt: view.recordedAt,
        evidenceRefs: [...view.evidenceRefs],
        privacy: view.privacy,
        subjectDrift: view.subjectDrift,
        acceptanceDigest: view.acceptanceDigest,
        // The verifier's own words, verbatim: HQ never rewrites a stated
        // limitation and never resolves one.
        verificationLimitations: view.verifications
          .filter((verification) => verification.verdict === 'confirmed' && verification.limitations.trim() !== '')
          .map((verification) => verification.limitations),
      }));
    const contradictions = this.#truthStorePresent
      ? listContradictions(graph, (id) => derived.get(id) ?? null)
      : [];

    const actions = this.#actionStorePresent
      ? loadActionIntents(this.#db).map((row) => {
          const view = deriveActionView(row, loadActionEvents(this.#db, row.id));
          return {
            id: view.id,
            taskId: view.taskId,
            missionId: view.missionId,
            adapterId: view.adapterId,
            actionType: view.actionType,
            riskLevel: view.riskLevel,
            state: view.state,
            requestedBy: view.requestedBy,
            requestedAt: view.requestedAt,
            attemptedAt: view.attempt?.at ?? null,
          };
        })
      : [];

    const collaboration = this.#collaborationFacts();

    const specialists = this.#store.listSpecialists();
    const workers = specialists.map((specialist) => {
      const binding = this.#workerBindingFromStore(specialist.id);
      return {
        id: specialist.id,
        displayName: specialist.displayName,
        active: specialist.active,
        providerDeclared: binding.providerId,
        memberIdentityKey: binding.member?.identityKey ?? null,
        liveClaims: tasks.filter(
          (task) => task.claimedBy === specialist.id && LIVE_CLAIM_STATUSES.includes(task.status),
        ).length,
      };
    });

    const projects = this.#projectStorePresent
      ? (
          this.#db.prepare(`SELECT id, name, status FROM hq_projects ORDER BY name, id`).all() as Record<
            string,
            unknown
          >[]
        ).map((row) => ({
          id: row.id as string,
          name: row.name as string,
          status: row.status as string,
          missionIds: (
            this.#db.prepare(`SELECT id FROM hq_missions WHERE project_id = ? ORDER BY id`).all(row.id) as {
              id: string;
            }[]
          ).map((mission) => mission.id),
        }))
      : [];

    const memoryRecords = this.#memory?.listAll() ?? [];
    const memoryByKind: Record<string, number> = {};
    for (const record of memoryRecords) memoryByKind[record.kind] = (memoryByKind[record.kind] ?? 0) + 1;

    const capabilities = (
      this.#db
        .prepare(`SELECT id, risk_class, side_effect, enabled FROM op_capabilities ORDER BY id`)
        .all() as Record<string, unknown>[]
    ).map((row) => ({
      id: row.id as string,
      riskClass: row.risk_class as string,
      sideEffect: !!row.side_effect,
      enabled: !!row.enabled,
    }));

    const refusalEvidence: Record<string, number> = {};
    for (const kind of REFUSAL_EVIDENCE_KINDS) {
      refusalEvidence[kind] = (
        this.#db.prepare(`SELECT COUNT(*) AS n FROM op_evidence WHERE kind = ?`).get(kind) as { n: number }
      ).n;
    }

    return {
      now,
      missions,
      tasks,
      approvals,
      killSwitches,
      truth,
      contradictions,
      actions,
      collaboration,
      dispatchLane: this.#dispatchLaneFacts(),
      workers,
      projects,
      memory: {
        total: memoryRecords.length,
        current: memoryRecords.filter((record) => record.status === 'CURRENT').length,
        founderOnly: memoryRecords.filter((record) => record.privacy === 'founder_only').length,
        byKind: memoryByKind,
      },
      capabilities,
      // The run ledger is its own table and its own presence question — a
      // read-only pre-Phase-6 file has missions and no runs, and 0 there is a
      // statement about the ledger's absence, not an invented count.
      orchestrationRuns: orchestratorSchemaPresent(this.#db)
        ? (this.#db.prepare(`SELECT COUNT(*) AS n FROM hq_orchestration_runs`).get() as { n: number }).n
        : 0,
      refusalEvidence,
      stores: {
        missions: this.#missionStorePresent,
        projects: this.#projectStorePresent,
        memory: this.#memoryStorePresent,
        truth: this.#truthStorePresent,
        actions: this.#actionStorePresent,
        collaboration: this.#collaborationStorePresent,
        briefs: this.#briefStorePresent,
      },
    };
  }

  /**
   * The Phase 9 record as facts: sessions with their DERIVED standing and
   * their own privacy classification, the explicit disagreements, and the
   * handoff requests beside the canonical task picture read at derivation
   * time. Every row through `#db`.
   *
   * `row.privacy` is copied onto the session AND onto every disagreement and
   * handoff derived from it (Phase 10 correction, M1). Before that, the
   * command layer had no representation of session privacy at all, so a
   * `founder_only` room's existence, participants and activity were narrated
   * on the unauthenticated artifact by the two inbox items below while the
   * Phase 9 collaboration section beside them correctly withheld the room.
   */
  #collaborationFacts(): CommandFacts['collaboration'] {
    if (!this.#collaborationStorePresent) return { sessions: [], disagreements: [], handoffs: [] };
    const ctx = this.#contributionContext(true);
    const sessions: CommandFacts['collaboration']['sessions'] = [];
    const disagreements: CommandFacts['collaboration']['disagreements'] = [];
    const handoffs: CommandFacts['collaboration']['handoffs'] = [];
    for (const row of loadCollaborationSessions(this.#db)) {
      const missionStatus = this.#missionStatusFromStore(row.missionId)?.status ?? null;
      sessions.push({
        id: row.id,
        missionId: row.missionId,
        missionStatus,
        standing: sessionStandingFor(missionStatus),
        title: row.title,
        privacy: row.privacy,
      });
      const contributions = loadContributions(this.#db, row.id);
      const relations = loadSessionRelations(this.#db, row.id);
      for (const view of deriveDisagreements(contributions, relations)) {
        disagreements.push({
          sessionId: row.id,
          missionId: row.missionId,
          contributionId: view.contributionId,
          workerId: view.workerId,
          role: view.role,
          disputesId: view.disputesId,
          disputedWorkerId: view.disputedWorkerId,
          at: view.at,
          privacy: row.privacy,
        });
      }
      for (const view of deriveHandoffRequests(contributions, ctx.taskStateOf)) {
        handoffs.push({
          contributionId: view.contributionId,
          sessionId: row.id,
          missionId: row.missionId,
          taskId: view.taskId,
          fromWorkerId: view.fromWorkerId,
          toWorkerId: view.toWorkerId,
          at: view.at,
          canonical: view.canonical
            ? {
                status: view.canonical.status,
                claimedBy: view.canonical.claimedBy,
                assignedWorkerId: view.canonical.assignedWorkerId,
              }
            : null,
          privacy: row.privacy,
        });
      }
    }
    return { sessions, disagreements, handoffs };
  }

  /**
   * The Claude GitHub dispatch lane, per task, from the hash-chained evidence
   * rows — the SAME rule `#claudeDispatchState` enforces for the gateway's
   * duplicate check, so the two can never disagree about whether an issue was
   * published. `unknown` means an attempt exists with no terminal after it:
   * HQ does not know, and says so until a human reconciles it.
   */
  #dispatchLaneFacts(): CommandFacts['dispatchLane'] {
    // `id` and `seq` travel with the fold, not just `at`: the lane state is a
    // derivation, but ONE canonical `op_evidence` row establishes it, and a
    // reader that publishes an `op_evidence` source reference must carry that
    // row's own identity rather than the task's (Phase 10 correction, M2).
    const rows = this.#db
      .prepare(
        `SELECT id, seq, task_id, kind, at FROM op_evidence
         WHERE task_id IS NOT NULL AND kind IN (?, ?, ?)
         ORDER BY seq`,
      )
      .all(
        'claude_github_dispatch_attempted',
        'claude_github_dispatch_succeeded',
        'claude_github_dispatch_failed',
      ) as { id: string; seq: number; task_id: string; kind: string; at: string }[];
    // The fold is the SAME one `#claudeDispatchState` applies, per task,
    // including its stickiness: a recorded success means dispatched whatever
    // follows it, a recorded failure closes the attempt, and `pending` with
    // no terminal after it is the only unknown.
    type LaneRow = { id: string; seq: number; at: string };
    const folded = new Map<string, { pending: LaneRow | null; dispatched: LaneRow | null }>();
    for (const row of rows) {
      const entry = folded.get(row.task_id) ?? { pending: null, dispatched: null };
      const here: LaneRow = { id: row.id, seq: Number(row.seq), at: row.at };
      if (row.kind === 'claude_github_dispatch_attempted') entry.pending = here;
      else if (row.kind === 'claude_github_dispatch_succeeded') {
        entry.pending = null;
        entry.dispatched = here;
      } else entry.pending = null;
      folded.set(row.task_id, entry);
    }
    const out: CommandFacts['dispatchLane'] = [];
    for (const [taskId, entry] of folded) {
      // The row published is the one that ESTABLISHED the state: the success
      // row when the lane is dispatched, the unterminated attempt row when it
      // is unknown. Either way it is resolvable against `op_evidence`.
      const establishing = entry.dispatched ?? entry.pending;
      if (establishing === null) continue;
      out.push({
        taskId,
        state: entry.dispatched !== null ? 'dispatched' : 'unknown',
        at: establishing.at,
        evidenceId: establishing.id,
        evidenceSeq: establishing.seq,
      });
    }
    return out.sort((a, b) => a.taskId.localeCompare(b.taskId));
  }

  /** The newest canonical `hq_events` and `op_evidence` sequence numbers — the position a brief observed. */
  #canonicalWatermark(): CanonicalWatermark {
    const events = this.#db
      .prepare(`SELECT MAX(seq) AS seq FROM hq_events WHERE ${notABriefEvent(this.#briefStorePresent)}`)
      .get() as { seq: number | null };
    const evidence = this.#db
      .prepare(`SELECT MAX(seq) AS seq FROM op_evidence WHERE ${notABriefEvidence(this.#briefStorePresent)}`)
      .get() as { seq: number | null };
    return { eventSeq: events.seq ?? 0, evidenceSeq: evidence.seq ?? 0 };
  }

  /**
   * WHAT CHANGED: the canonical events appended after the last issued brief's
   * watermark, and the evidence kinds after its evidence watermark. With no
   * brief ever issued there is no watermark, so the section carries the
   * newest events overall and SAYS it is not a delta — an honest absence
   * rather than a delta against an invented zero.
   */
  #changedSince(latest: BriefRow | null, limit: number): ChangedView {
    const since = latest?.watermark.eventSeq ?? 0;
    const evidenceSince = latest?.watermark.evidenceSeq ?? 0;
    const rows = (
      latest
        ? this.#db
            .prepare(
              `SELECT seq, at, subject_kind, subject_id, status, actor, summary FROM hq_events
               WHERE seq > ? AND ${notABriefEvent(this.#briefStorePresent)} ORDER BY seq DESC`,
            )
            .all(since)
        : this.#db
            .prepare(
              `SELECT seq, at, subject_kind, subject_id, status, actor, summary FROM hq_events
               WHERE ${notABriefEvent(this.#briefStorePresent)} ORDER BY seq DESC`,
            )
            .all()
    ) as Record<string, unknown>[];
    const events: ChangedEventRef[] = rows.map((row) => ({
      seq: row.seq as number,
      at: row.at as string,
      subjectKind: row.subject_kind as string,
      subjectId: row.subject_id as string,
      status: (row.status as string | null) ?? null,
      actor: row.actor as string,
      summary: row.summary as string,
    }));
    const evidenceRows = (
      latest
        ? this.#db
            .prepare(`SELECT kind, COUNT(*) AS n FROM op_evidence WHERE seq > ? AND ${notABriefEvidence(this.#briefStorePresent)} GROUP BY kind`)
            .all(evidenceSince)
        : this.#db.prepare(`SELECT kind, COUNT(*) AS n FROM op_evidence WHERE ${notABriefEvidence(this.#briefStorePresent)} GROUP BY kind`).all()
    ) as { kind: string; n: number }[];
    return deriveChanged({
      since: latest,
      eventsAfter: events,
      eventsTotal: events.length,
      evidenceByKind: evidenceRows.map((row) => ({ kind: row.kind, count: row.n })),
      limit,
    });
  }

  /** The brief ledger's own state, for the sections that state it. */
  #briefLedgerState(): { total: number; latest: BriefView | null } {
    if (!this.#briefStorePresent) return { total: 0, latest: null };
    const rows = loadBriefs(this.#db);
    return { total: rows.length, latest: rows.length > 0 ? briefView(rows[0]!) : null };
  }

  /**
   * WHAT NEEDS ME: the Founder Inbox — a DERIVED attention queue over the
   * canonical stores. Every item REFERENCES the row it exists because of
   * (`source: { table, id }`) and duplicates no authority: nothing here
   * approves, reviews, verifies, assigns, claims, reconciles or executes, and
   * no gate anywhere reads an item.
   *
   * Nothing is persisted, so an item cannot outlive its cause: decide the
   * approval, review the task, resolve the contradiction or release the stop
   * through its own gated act and the item is simply not derived on the next
   * read.
   */
  founderInbox(options: { includeFounderOnly?: boolean; limit?: number } = {}): FounderInboxView {
    const facts = this.#commandFacts();
    return assembleFounderInbox({
      items: deriveFounderInbox(facts),
      at: facts.now,
      includeFounderOnly: options.includeFounderOnly === true,
      limit: options.limit ?? INBOX_READ_LIMIT,
    });
  }

  /**
   * The whole Command Center briefing: WHAT NEEDS ME / WHAT IS BLOCKED /
   * WHAT CHANGED / WHAT IS VERIFIED / WHAT IS UNKNOWN / WHAT CAN HQ SAFELY DO
   * NEXT, the recommendations that answer the inbox, the department
   * PROJECTIONS and the brief ledger's state.
   *
   * A read. It writes nothing, and every recommendation it carries is
   * `executable: false` — there is deliberately no facade method anywhere
   * that accepts a recommendation id.
   */
  founderBriefing(options: { includeFounderOnly?: boolean; limit?: number } = {}): FounderBriefingView {
    const facts = this.#commandFacts();
    const briefs = this.#briefLedgerState();
    return assembleBriefing({
      facts,
      changed: this.#changedSince(this.#briefStorePresent ? loadLatestBrief(this.#db) : null, CHANGED_EVENT_LIMIT),
      briefs,
      includeFounderOnly: options.includeFounderOnly === true,
      limit: options.limit ?? BRIEFING_SECTION_LIMIT,
    });
  }

  /**
   * The bounded snapshot section. The reading layer's privacy decision is the
   * caller's and defaults to the less disclosing answer, exactly as
   * `truthSummary` and `collaborationSummary` do it: without
   * `includeFounderOnly`, no item derived from a founder_only truth record is
   * carried and no number here aggregates over one.
   */
  commandCenterSummary(options: { includeFounderOnly?: boolean; limit?: number } = {}): CommandCenterSnapshotView {
    return assembleCommandCenterSnapshot({
      facts: this.#commandFacts(),
      briefs: this.#briefLedgerState(),
      includeFounderOnly: options.includeFounderOnly === true,
      limit: options.limit ?? COMMAND_CENTER_SNAPSHOT_LIMIT,
    });
  }

  /** Every issued brief receipt, newest first, bounded with the true total. */
  listBriefs(limit = BRIEF_READ_LIMIT): { briefs: BriefView[]; total: number; truncated: boolean } {
    if (!this.#briefStorePresent) return { briefs: [], total: 0, truncated: false };
    const rows = loadBriefs(this.#db);
    return { briefs: rows.slice(0, limit).map(briefView), total: rows.length, truncated: rows.length > limit };
  }

  /** One issued brief receipt, or null. */
  getBrief(id: string): BriefView | null {
    if (!id || !this.#briefStorePresent) return null;
    const row = loadBrief(this.#db, id);
    return row ? briefView(row) : null;
  }

  /** Whether this database handle carries the Phase 10 brief ledger. */
  briefStorePresent(): boolean {
    return this.#briefStorePresent;
  }

  /**
   * Issue ONE brief receipt — the single write this phase adds.
   *
   * A receipt, not a report: who issued it, when, the canonical watermarks it
   * observed (`hq_events` and `op_evidence` sequence numbers), the categorical
   * counts of the sets the briefing enumerated, and a content digest so a
   * later reader can check a re-derivation against what was issued. It stores
   * NO attention item, NO recommendation and NO document body, precisely so a
   * stale receipt can never be mistaken for current truth.
   *
   * Deliberately NOT a notification: nothing is sent anywhere, no timer issues
   * one, and there is no channel, webhook, email or schedule in this phase.
   *
   * A Founder act (`hq.founder_brief`, the founder-gate trio) resolved through
   * `#resolveFounderGateActor` — a human principal holding the grant; workers,
   * `system` and unknown ids refused. Idempotent on a derived key over the
   * actor and the watermarks: issuing twice with nothing appended in between
   * deduplicates to the first receipt rather than growing the ledger.
   */
  issueBrief(input: {
    /** Resolved actor id. Set by the boundary, never read from a body. */
    requestedBy: string;
    idempotencyKey?: string;
  }): OpsResult<{ brief: BriefView; deduplicated: boolean }> {
    if (!input.requestedBy) return fail('invalid_input', 'requestedBy is required');
    const refusedActor = this.#resolveFounderGateActor(
      input.requestedBy,
      'issue a Founder brief',
      FOUNDER_BRIEF_CAPABILITY.id,
      'issuing a Founder brief',
    );
    if (refusedActor) return refusedActor;
    const refusedCapability = this.#founderBriefCapabilityGate('issue a Founder brief');
    if (refusedCapability) return refusedCapability;
    if (!this.#briefStorePresent) {
      return fail('invalid_input', 'brief ledger unavailable on this database handle');
    }

    const privileged = this.#requirePrivilegedQueue();
    let dedupedTo: string | null = null;
    let createdId: string | null = null;
    privileged.reserve(() => {
      // Everything a receipt states is read INSIDE the write lock, so the
      // watermarks, the counts and the digest describe one instant of the
      // canonical record rather than three.
      const watermark = this.#canonicalWatermark();
      const idempotencyKey = briefIdempotencyKey({
        requestedBy: input.requestedBy,
        watermark,
        idempotencyKey: input.idempotencyKey ?? null,
      });
      const existing = this.#db.prepare(`SELECT id FROM hq_briefs WHERE idempotency_key = ?`).get(idempotencyKey) as
        | { id: string }
        | undefined;
      if (existing) {
        dedupedTo = existing.id;
        return;
      }
      // The Founder's own audience: a receipt the Founder signs states what
      // the Founder can see, founder_only material included.
      const briefing = assembleBriefing({
        facts: this.#commandFacts(),
        changed: this.#changedSince(loadLatestBrief(this.#db), CHANGED_EVENT_LIMIT),
        briefs: this.#briefLedgerState(),
        includeFounderOnly: true,
      });
      const counts = briefCountsOf(briefing);
      const digest = contentDigest(briefing);
      const id = `brief-${uuid()}`;
      const at = nowIso();
      this.#db
        .prepare(
          `INSERT INTO hq_briefs (id, issued_by, issued_at, event_seq, evidence_seq, content_digest, counts, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.requestedBy,
          at,
          watermark.eventSeq,
          watermark.evidenceSeq,
          digest,
          JSON.stringify(counts),
          idempotencyKey,
        );
      createdId = id;
      this.#store.appendEvent({
        subjectKind: 'system',
        subjectId: `brief:${id}`,
        status: null,
        actor: input.requestedBy,
        summary: `Founder brief issued over hq_events seq ${watermark.eventSeq} / op_evidence seq ${watermark.evidenceSeq}`,
        detail: { briefId: id, ...watermark, attention: counts.attention.total },
      });
      privileged.appendEvidence({
        actor: input.requestedBy,
        kind: BRIEF_EVIDENCE_KIND,
        payload: { briefId: id, ...watermark, contentDigest: digest, counts, executable: false },
      });
    });
    const id = dedupedTo ?? createdId!;
    return ok({ brief: briefView(loadBrief(this.#db, id)!), deduplicated: dedupedTo !== null });
  }

  #founderBriefCapabilityGate(action: string): OpsResult<never> | null {
    return this.#founderGateCapabilityGate(
      action,
      FOUNDER_BRIEF_CAPABILITY.id,
      founderBriefCapabilityState,
      founderBriefContractDrift,
      'issuing a Founder brief',
    );
  }

  // ---- Search + Company Memory + Ask Jenify (Phase 11) ----

  /**
   * Every canonical row search is allowed to see, projected ONCE per read.
   *
   * ENFORCEMENT-SAFE BY CONSTRUCTION. This corpus decides two things a hostile
   * same-realm patch would love to move: WHICH rows a reader is shown, and
   * WHICH of them are `founder_only`. So every row here is read through
   * `#db` or a private derivation, and NOT ONE fact comes from a public,
   * patchable prototype method — not `listMemory()`, not `listTruth()`, not
   * `listCollaborationSessions()`, not `listActions()`, not
   * `directory.listSpecialists()`, not `MemoryStore.listAll()`. This is the
   * Phase 9 High finding and the Phase 10 `#commandFacts` rule applied to a
   * surface whose whole job is disclosure, and unlike `#commandFacts` there is
   * no exception: Phase 11 reads no public method at all.
   *
   * `privacy` is copied from the canonical row for the three classified
   * sources (`hq_memory.privacy`, the DERIVED truth view's `privacy`,
   * `hq_collab_sessions.privacy`) and is `internal` for the six sources whose
   * canonical rows carry no privacy column — stated in the source registry
   * rather than assumed at each call site.
   *
   * Two payloads are deliberately NOT indexed and therefore can never be
   * quoted back: `op_tasks.payload` / `op_tasks.result`, and
   * `hq_action_intents.payload`. The snapshot's no-task-payload rule is a
   * disclosure rule, not a snapshot rule, so it applies to a Founder-gated
   * search result too. A task is searchable by its recorded title, capability
   * and block reason; an action by its type, adapter and target.
   *
   * Nothing here is stored. The corpus is a value handed to the pure core and
   * dropped: there is no index table, no query log and no result cache in this
   * phase, which is why search cannot become a second answer to "what does the
   * company hold".
   */
  #searchCorpus(): SearchCorpus {
    const builtAt = nowIso();
    const documents: SearchDocument[] = [];
    const bodyOf = (...parts: (string | null | undefined)[]): string =>
      parts
        .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
        .join(' — ')
        .slice(0, MAX_DOCUMENT_BODY_LENGTH);
    const push = (
      source: SearchSourceId,
      entityId: string,
      fields: Omit<SearchDocument, 'id' | 'source' | 'entityId' | 'table'>,
    ): void => {
      documents.push({
        id: `${source}:${entityId}`,
        source,
        entityId,
        table: searchSourceDescriptor(source).table,
        ...fields,
      });
    };

    // Missions — hq_missions straight off #db.
    if (this.#missionStorePresent) {
      const rows = this.#db
        .prepare(
          `SELECT id, title, objective, scope, status, block_reason, project, created_at, updated_at
           FROM hq_missions ORDER BY id`,
        )
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        push('mission', row.id as string, {
          title: row.title as string,
          body: bodyOf(row.objective as string, row.scope as string | null, row.block_reason as string | null),
          status: row.status as string,
          lifecycle: 'not_applicable',
          truthState: null,
          privacy: 'internal',
          at: (row.updated_at as string) ?? (row.created_at as string),
          project: ((row.project as string | null) ?? '').trim(),
          tags: [],
          evidenceRefs: [],
          refs: [{ kind: 'mission', id: row.id as string }],
        });
      }
    }

    // Projects — hq_projects straight off #db.
    if (this.#projectStorePresent) {
      const rows = this.#db
        .prepare(`SELECT id, name, stream, summary, status, created_at, updated_at FROM hq_projects ORDER BY id`)
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        push('project', row.id as string, {
          title: row.name as string,
          body: bodyOf(row.summary as string, row.stream as string),
          status: row.status as string,
          lifecycle: 'not_applicable',
          truthState: null,
          privacy: 'internal',
          at: (row.updated_at as string) ?? (row.created_at as string),
          project: row.name as string,
          tags: [row.stream as string].filter((tag) => tag !== ''),
          evidenceRefs: [],
          refs: [{ kind: 'project', id: row.id as string }],
        });
      }
    }

    // Tasks — the recorded title, capability and block reason. Never the
    // payload and never the result.
    const taskRows = this.#db
      .prepare(
        `SELECT t.id AS id, t.capability_id AS capability_id, t.status AS status, t.created_at AS created_at,
                t.updated_at AS updated_at, t.block_reason AS block_reason,
                m.title AS title, m.project AS project
         FROM op_tasks t LEFT JOIN hq_op_task_meta m ON m.task_id = t.id ORDER BY t.id`,
      )
      .all() as Record<string, unknown>[];
    for (const row of taskRows) {
      push('task', row.id as string, {
        title: ((row.title as string | null) ?? (row.capability_id as string)).trim(),
        body: bodyOf(row.capability_id as string, row.block_reason as string | null),
        status: row.status as string,
        lifecycle: 'not_applicable',
        truthState: null,
        privacy: 'internal',
        at: (row.updated_at as string) ?? (row.created_at as string),
        project: ((row.project as string | null) ?? '').trim(),
        tags: [],
        evidenceRefs: [],
        refs: [
          { kind: 'task', id: row.id as string },
          { kind: 'capability', id: row.capability_id as string },
        ],
      });
    }

    // Company memory — hq_memory read as ROWS through #db, deliberately not
    // through MemoryStore.listAll(): a public method on another class is a
    // patchable read, and this one decides which records are founder_only.
    if (this.#memoryStorePresent) {
      const rows = this.#db
        .prepare(
          `SELECT id, kind, title, body, status, privacy, recorded_date, recorded_source, project, tags,
                  mission_id, project_id, task_id
           FROM hq_memory ORDER BY id`,
        )
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        const refs: SearchEntityRef[] = [{ kind: 'memory', id: row.id as string }];
        if (row.mission_id) refs.push({ kind: 'mission', id: row.mission_id as string });
        if (row.project_id) refs.push({ kind: 'project', id: row.project_id as string });
        if (row.task_id) refs.push({ kind: 'task', id: row.task_id as string });
        push('memory', row.id as string, {
          title: row.title as string,
          body: bodyOf(row.body as string, row.kind as string, row.recorded_source as string | null),
          status: row.status as string,
          lifecycle: row.status === 'SUPERSEDED' ? 'superseded' : 'current',
          truthState: null,
          privacy: (row.privacy as MemoryPrivacy) ?? 'internal',
          at: row.recorded_date as string,
          project: ((row.project as string | null) ?? '').trim(),
          tags: safeStringList(row.tags as string | null),
          evidenceRefs: [],
          refs,
        });
      }
    }

    // Truth — the PRIVATE derivation over the canonical graph, exactly as
    // `#commandFacts` reads it. `state`, `lifecycle` and `privacy` are all
    // derived facts here, never stored flags a patch could relabel.
    if (this.#truthStorePresent) {
      for (const view of this.#deriveAllTruth(loadTruthGraph(this.#db)).values()) {
        push('truth', view.id, {
          title: view.statement,
          body: bodyOf(
            view.statement,
            view.entityKind,
            view.entityId,
            ...view.verifications
              .filter((verification) => verification.limitations.trim() !== '')
              .map((verification) => verification.limitations),
          ),
          status: view.state,
          lifecycle: view.lifecycle === 'superseded' ? 'superseded' : 'current',
          truthState: view.state,
          privacy: view.privacy,
          at: view.recordedAt,
          project: '',
          tags: [view.entityKind],
          evidenceRefs: [...view.evidenceRefs],
          refs: [truthEntityRef(view.entityKind, view.entityId)],
        });
      }
    }

    // Collaboration sessions — the Phase 9 loader over #db; `privacy` is the
    // session's own classification and is the disclosure decision here.
    if (this.#collaborationStorePresent) {
      for (const row of loadCollaborationSessions(this.#db)) {
        push('collaboration', row.id, {
          title: row.title,
          body: bodyOf(row.purpose),
          status: 'open',
          lifecycle: 'not_applicable',
          truthState: null,
          privacy: row.privacy === 'founder_only' ? 'founder_only' : 'internal',
          at: row.openedAt,
          project: '',
          tags: [],
          evidenceRefs: [],
          refs: [
            { kind: 'collaboration', id: row.id },
            { kind: 'mission', id: row.missionId },
          ],
        });
      }
    }

    // External action intents — the Phase 8 loader over #db. Type, adapter,
    // target and the risk vocabulary; never the payload.
    if (this.#actionStorePresent) {
      for (const row of loadActionIntents(this.#db)) {
        push('external_action', row.id, {
          title: `${row.actionType} via ${row.adapterId}`,
          body: bodyOf(row.target, row.riskLevel, row.visibility, row.reversibility, ...row.riskFactors),
          status: row.riskLevel,
          lifecycle: 'not_applicable',
          truthState: null,
          privacy: 'internal',
          at: row.requestedAt,
          project: '',
          tags: [row.adapterId, row.actionType],
          evidenceRefs: [...row.contextEvidenceRefs],
          refs: [
            { kind: 'external_action', id: row.id },
            { kind: 'task', id: row.taskId },
            ...(row.missionId ? [{ kind: 'mission' as const, id: row.missionId }] : []),
          ],
        });
      }
    }

    // Orchestration runs — hq_orchestration_runs straight off #db, and only
    // when the ledger genuinely exists on this handle.
    if (orchestratorSchemaPresent(this.#db)) {
      const rows = this.#db
        .prepare(`SELECT id, mission_id, requested_by, at, summary FROM hq_orchestration_runs ORDER BY id`)
        .all() as Record<string, unknown>[];
      for (const row of rows) {
        push('orchestration_run', row.id as string, {
          title: row.summary as string,
          body: bodyOf(row.summary as string, row.requested_by as string),
          status: 'recorded',
          lifecycle: 'not_applicable',
          truthState: null,
          privacy: 'internal',
          at: row.at as string,
          project: '',
          tags: [],
          evidenceRefs: [],
          refs: [
            { kind: 'orchestration_run', id: row.id as string },
            { kind: 'mission', id: row.mission_id as string },
          ],
        });
      }
    }

    // Workers — hq_specialists straight off #db, deliberately not through
    // `directory.listSpecialists()` (a public read on this instance).
    const workerRows = this.#db
      .prepare(`SELECT id, display_name, vendor, role, active FROM hq_specialists ORDER BY id`)
      .all() as Record<string, unknown>[];
    for (const row of workerRows) {
      push('worker', row.id as string, {
        title: row.display_name as string,
        body: bodyOf(row.role as string, row.vendor as string, row.id as string),
        status: row.active ? 'active' : 'inactive',
        lifecycle: 'not_applicable',
        truthState: null,
        privacy: 'internal',
        // hq_specialists carries no timestamp; the corpus states the read
        // instant rather than inventing a canonical one.
        at: builtAt,
        project: '',
        tags: [row.vendor as string, row.role as string].filter((tag) => tag !== ''),
        evidenceRefs: [],
        refs: [{ kind: 'worker', id: row.id as string }],
      });
    }

    return {
      documents,
      sources: [
        { id: 'mission', storePresent: this.#missionStorePresent },
        { id: 'project', storePresent: this.#projectStorePresent },
        // op_tasks and hq_specialists are core schema — present on every handle
        // this facade can be constructed over.
        { id: 'task', storePresent: true },
        { id: 'memory', storePresent: this.#memoryStorePresent },
        { id: 'truth', storePresent: this.#truthStorePresent },
        { id: 'collaboration', storePresent: this.#collaborationStorePresent },
        { id: 'external_action', storePresent: this.#actionStorePresent },
        { id: 'orchestration_run', storePresent: orchestratorSchemaPresent(this.#db) },
        { id: 'worker', storePresent: true },
      ],
      builtAt,
    };
  }

  /**
   * Unified deterministic search across every canonical source in the Phase 11
   * registry. A pure read: it appends no event, no evidence and no row, and
   * there is no table it could append one to.
   *
   * `includeFounderOnly` is the READER's right, decided by the calling layer
   * (the Founder-gated route passes true; the unauthenticated snapshot passes
   * false) and never by anything in the query. A query with no criterion at
   * all is refused rather than answered — see `normalizeSearchQuery`.
   */
  searchCompany(
    query: CompanySearchQuery,
    options: { includeFounderOnly?: boolean } = {},
  ): OpsResult<CompanySearchView> {
    const normalized = normalizeSearchQuery(query);
    if (!normalized.ok) return fail('invalid_input', normalized.message);
    return ok(
      runCompanySearch({
        corpus: this.#searchCorpus(),
        query,
        terms: normalized.terms,
        droppedTerms: normalized.droppedTerms,
        criteria: normalized.criteria,
        includeFounderOnly: options.includeFounderOnly === true,
        now: nowIso(),
      }),
    );
  }

  /**
   * Ask Jenify — one natural-language question, answered from canonical rows.
   *
   * RETRIEVE FIRST, THEN COMPOSE, and structurally so: this method retrieves
   * through the same corpus and the same adapter search uses, hands the
   * already-privacy-filtered, already-bounded documents to a pure composer,
   * and the composer has no database handle to reach past them with. When
   * retrieval returns nothing the answer is `insufficient_evidence` (or
   * `unknown` when there was nothing to retrieve on) — never a guess.
   *
   * This is not a model call. No prose is generated: the response is counts
   * and categorical states over the cited rows, and each row's own text
   * appears only as a quoted snippet beside the table and id it came from.
   *
   * A pure read, exactly like `searchCompany`: no write, no event, no
   * evidence, no capability, no authority. A question is not an act.
   */
  askJenify(input: {
    question: string;
    /** The READER's disclosure right, set by the calling layer. */
    includeFounderOnly?: boolean;
    /** Citations to read, clamped to [1, ASK_CITATION_LIMIT]. */
    limit?: number;
    retrieval?: RetrievalMode;
  }): OpsResult<AskAnswerView> {
    const question = (input.question ?? '').trim();
    if (question === '') return fail('invalid_input', 'question is required');
    if (question.length > MAX_QUESTION_LENGTH) {
      return fail('invalid_input', `question exceeds ${MAX_QUESTION_LENGTH} characters`);
    }
    const askedAt = nowIso();
    const corpus = this.#searchCorpus();
    const noStorePresent = corpus.sources.every((source) => !source.storePresent);

    // The reader's set, and the corpus-wide (never per-query) withheld count.
    const includeFounderOnly = input.includeFounderOnly === true;
    const readable = includeFounderOnly
      ? [...corpus.documents]
      : corpus.documents.filter((document) => document.privacy !== 'founder_only');
    const withheldFounderOnly = corpus.documents.length - readable.length;

    const normalized = normalizeSearchQuery({ text: question });
    const terms = normalized.ok ? normalized.terms : [];
    const droppedTerms = normalized.ok ? normalized.droppedTerms : 0;

    const { adapter, statement } = resolveRetrievalAdapter(input.retrieval ?? 'deterministic_lexical');
    // A question with no searchable term retrieves NOTHING. It deliberately
    // does not fall through to "return everything ordered by date", which is
    // what the adapter does for an empty term list when search supplies a
    // structured filter instead.
    const matched = terms.length === 0 ? [] : adapter.retrieve({ readable, terms });
    const limit = Math.min(Math.max(input.limit ?? ASK_CITATION_LIMIT, 1), ASK_CITATION_LIMIT);

    return ok(
      assembleAnswer({
        question,
        askedAt,
        terms,
        droppedTerms,
        retrieved: matched.slice(0, limit),
        considered: matched.length,
        sources: sourceStatuses(corpus, readable),
        withheldFounderOnly,
        retrieval: statement,
        noStorePresent,
      }),
    );
  }

  /**
   * The search source registry for the UNAUTHENTICATED artifact: which stores
   * exist, how many documents an unauthenticated reader could search, how many
   * classified documents were not searched, and which retrieval mode answers.
   *
   * No document, title, snippet, id, term, question or result crosses. The
   * counts span the reader's set only, and the withheld count is a property of
   * the corpus rather than of any query — the Phase 10 rule that no number may
   * aggregate over withheld material, plus the stronger Phase 11 rule that no
   * number may be a function of an attacker-chosen query.
   */
  searchIndexSummary(options: { includeFounderOnly?: boolean } = {}): SearchIndexSnapshotView {
    const corpus = this.#searchCorpus();
    const readable =
      options.includeFounderOnly === true
        ? [...corpus.documents]
        : corpus.documents.filter((document) => document.privacy !== 'founder_only');
    return {
      sources: sourceStatuses(corpus, readable),
      readableTotal: readable.length,
      withheldFounderOnly: corpus.documents.length - readable.length,
      retrieval: resolveRetrievalAdapter('deterministic_lexical').statement,
      note: SEARCH_SNAPSHOT_NOTE,
    };
  }

  /** Which canonical sources this build searches. A registry read; no rows. */
  searchSources(): readonly SearchSourceId[] {
    return SEARCH_SOURCES;
  }

  // ---- task metadata (console labels + advisory assignment) ----

  readMeta(taskId: string): TaskMeta | null {
    const row = this.#db.prepare(`SELECT * FROM hq_op_task_meta WHERE task_id = ?`).get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    const workerId = (row.assigned_worker_id as string | null) ?? null;
    return {
      taskId: row.task_id as string,
      project: (row.project as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      sourceProposalId: (row.source_proposal_id as string | null) ?? null,
      assignment: workerId
        ? {
            taskId: row.task_id as string,
            workerId,
            assignedBy: row.assigned_by as string,
            assignedAt: row.assigned_at as string,
            rationale: (row.assignment_rationale as string | null) ?? null,
          }
        : null,
    };
  }

  #upsertMeta(
    taskId: string,
    patch: {
      project?: string | null;
      title?: string | null;
      sourceProposalId?: string | null;
      assignedWorkerId?: string | null;
      assignedBy?: string | null;
      assignedAt?: string | null;
      assignmentRationale?: string | null;
    },
  ): void {
    const existing = this.readMeta(taskId);
    const next = {
      project: patch.project ?? existing?.project ?? null,
      title: patch.title ?? existing?.title ?? null,
      sourceProposalId: patch.sourceProposalId ?? existing?.sourceProposalId ?? null,
      assignedWorkerId: patch.assignedWorkerId ?? existing?.assignment?.workerId ?? null,
      assignedBy: patch.assignedBy ?? existing?.assignment?.assignedBy ?? null,
      assignedAt: patch.assignedAt ?? existing?.assignment?.assignedAt ?? null,
      assignmentRationale:
        patch.assignmentRationale ?? existing?.assignment?.rationale ?? null,
    };
    this.#db
      .prepare(
        `INSERT INTO hq_op_task_meta
           (task_id, project, title, source_proposal_id, assigned_worker_id, assigned_by, assigned_at, assignment_rationale)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           project = excluded.project,
           title = excluded.title,
           source_proposal_id = excluded.source_proposal_id,
           assigned_worker_id = excluded.assigned_worker_id,
           assigned_by = excluded.assigned_by,
           assigned_at = excluded.assigned_at,
           assignment_rationale = excluded.assignment_rationale`,
      )
      .run(
        taskId,
        next.project,
        next.title,
        next.sourceProposalId,
        next.assignedWorkerId,
        next.assignedBy,
        next.assignedAt,
        next.assignmentRationale,
      );
  }

  // ---- internals ----

  /**
   * Resolve an actor that must simply BE someone — an assignable worker or an
   * active human principal — without needing a capability grant. Used for
   * review and reconciliation, where the decisive property is independence
   * (enforced by the queue) rather than permission to act on a capability.
   * Deny by default: an unknown id is nobody and can do neither.
   */
  #resolveActor(actor: string, action: string): OpsResult<ResolvedRequester> {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}`);
    }
    return this.#resolveRequester(actor, action);
  }

  /**
   * Resolve who is opening work. A worker must be assignable; a human must be
   * a registered, active principal. Neither can supply its own allow-list.
   */
  #resolveRequester(actor: string, action: string): OpsResult<ResolvedRequester> {
    if (this.#workers.isRegistered(actor)) {
      const assignability = this.#workers.assignability(actor);
      if (!assignability.assignable) {
        return this.#rejectNotAssignable(actor, assignability, action);
      }
      return ok({ kind: 'worker', allowedCapabilities: this.#workers.allowedCapabilities(actor) });
    }
    const human = resolvePrincipal({ get: (id: string) => this.#principalOf(id) }, actor);
    if (!human.ok) {
      this.#requirePrivilegedQueue().appendEvidence({
        actor: 'system',
        kind: 'principal_rejected',
        payload: { actorId: actor, action, reason: human.reason },
      });
      return fail(
        'unknown_principal',
        `${actor} may not ${action}: not a registered worker, and ${human.reason.replace('principal_', 'the human principal is ')}`,
        { actor, reason: human.reason },
      );
    }
    // A human's grant is for ORIGINATING work only. It never reaches
    // claim/start — those paths are worker-only by construction.
    return ok({ kind: 'human', allowedCapabilities: human.principal.originateCapabilities });
  }

  /**
   * Founder-facing decisions require a registered, active human principal that
   * carries approval authority — deny by default.
   *
   * The earlier version of this guard authorized by elimination ("not a known
   * worker, therefore human"), which denied workers but admitted every unknown
   * string. Authority is now positive: an actor must BE someone, not merely
   * fail to be a worker. Any id the directory knows as a worker is still
   * refused outright, so worker identity can never carry approval authority.
   * All of this sits on top of — never instead of — the queue's own
   * self-approval guards, which still stop a requester approving its own action.
   */
  #assertApprovalAuthority(actor: string, action: string): OpsResult<never> | null {
    if (!actor) return fail('invalid_input', `An actor is required to ${action}`);
    if (actor === 'system') {
      return fail('not_permitted', `'system' cannot ${action}: a human principal is required`);
    }
    if (this.#isRegisteredWorker(actor)) {
      return fail(
        'not_permitted',
        `Registered worker ${actor} cannot ${action}: worker identity never carries approval authority`,
        { actor },
      );
    }
    // `{ get: … }` rather than the port itself: an own-property closure has no
    // prototype for a same-realm plugin to patch.
    const approver = resolveApprover({ get: (id: string) => this.#principalOf(id) }, actor);
    if (!approver.ok) {
      this.#requirePrivilegedQueue().appendEvidence({
        actor: 'system',
        kind: 'approval_authority_refused',
        payload: { actorId: actor, action, reason: approver.reason },
      });
      return fail('not_permitted', `${actor} may not ${action}: ${approver.reason}`, {
        actor,
        reason: approver.reason,
      });
    }
    return null;
  }

  /**
   * Execution is worker-only. A human principal may originate work and may
   * decide approvals; it can never hold a fenced claim, so `claimNext()` and
   * `startTask()` refuse it explicitly rather than letting it fall through the
   * worker-directory lookup with a confusing "unknown worker".
   */
  #rejectHumanExecution(actorId: string, action: string): OpsResult<never> | null {
    if (this.#isRegisteredWorker(actorId)) return null;
    if (!this.#principalOf(actorId)) return null;
    this.#requirePrivilegedQueue().appendEvidence({
      actor: 'system',
      kind: 'human_execution_refused',
      payload: { actorId, action },
    });
    return fail(
      'humans_do_not_execute',
      `Human principal ${actorId} may not ${action}: originating and approving work never grants execution capability`,
      { actorId },
    );
  }

  #rejectNotAssignable(
    workerId: string,
    assignability: WorkerAssignability,
    action: string,
    details: Record<string, unknown> = {},
  ): OpsResult<never> {
    const reason = assignability.assignable ? 'unknown' : assignability.reason;
    this.#requirePrivilegedQueue().appendEvidence({
      actor: 'system',
      kind: 'worker_not_assignable',
      payload: { workerId, action, reason },
    });
    return fail('worker_not_assignable', `Worker ${workerId} may not ${action}: ${reason}`, {
      workerId,
      reason,
      ...details,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The canonical `op_capabilities` row for a capability, for callers making an
 * ENFORCEMENT decision about its definition.
 *
 * A FUNCTION BINDING, not a method, and that is the whole point (issue #219,
 * Codex P1 on `2175fa2`). Two surfaces have now been patched out from under
 * this exact decision:
 *
 *   1. `queue.capabilities.get` — an own-property closure #200 documents as
 *      patchable. Replaced to report the reserved definition, a weakened row
 *      still classified the order and a Founder-gated direct order reached
 *      `queued`.
 *   2. `ops.capabilityRow(...)` — my replacement for (1), and a public
 *      prototype method, so it could simply be shadowed or overwritten.
 *      Same bypass, one layer up.
 *
 * An ES module binding cannot be reassigned by an importing module, and the
 * private static it calls is not a property of the class or of any instance.
 * So there is nothing on the path from this call to the database for a
 * same-realm caller to replace.
 *
 * `queue.capabilities` stays exactly as it is: the convenience read,
 * deliberately patchable, for callers that are DISPLAYING a capability rather
 * than deciding on one.
 */
export function capabilityRowFor(
  ops: HeadquarterOperations,
  capabilityId: string,
): Capability | null {
  return readCapabilityRow(ops, capabilityId);
}

/**
 * The canonical `op_kill_switch` answer for the global scope plus an optional
 * capability scope, for callers making an ENFORCEMENT decision (Phase 8,
 * Low 7). A FUNCTION BINDING for the reason `capabilityRowFor` is one: an ES
 * module binding cannot be reassigned by an importer, and the private closure
 * it calls is not a property of the class or of any instance. The Claude
 * dispatch lane's eligibility check reads through this; `queue.killSwitchEngaged`
 * stays as the deliberately patchable convenience read for DISPLAY.
 */
export function killSwitchEngagedFor(ops: HeadquarterOperations, capabilityId?: string): boolean {
  return readKillSwitchEngaged(ops, capabilityId);
}

/** What the gateway has attempted for a task: open, unknown, succeeded, or nothing. */
export type GatewayActionHistory =
  | { state: 'none' }
  | { state: 'attempted' | 'outcome_unknown' | 'succeeded'; actionId: string };

/**
 * The gateway's attempt history for a task read from the ledger rows, for the
 * Claude dispatch lane's one-external-path check — a FUNCTION BINDING like
 * `killSwitchEngagedFor`, because that verdict decides whether a public issue
 * is published and the public `gatewayActionHistory` method is a prototype
 * slot an importer can patch.
 */
export function gatewayActionHistoryFor(ops: HeadquarterOperations, taskId: string): GatewayActionHistory {
  return readGatewayActionHistory(ops, taskId);
}

/** One canonical `op_evidence` row as a deciding read needs it: kind, time, payload. */
export interface CanonicalEvidenceRow {
  kind: string;
  at: string;
  payload: Record<string, unknown>;
}

/**
 * A task's canonical evidence rows for a caller making an ENFORCEMENT decision
 * (review round 2): a FUNCTION BINDING like `killSwitchEngagedFor`, because the
 * Claude dispatch lane's `dispatchHistory` decides whether a public issue is
 * published a second time, and `queue.evidence.list` — which it used to read —
 * is the deliberately patchable convenience read for DISPLAY. That handle stays
 * exactly as it is for display callers.
 */
export function taskEvidenceRowsFor(ops: HeadquarterOperations, taskId: string): CanonicalEvidenceRow[] {
  return readTaskEvidenceRows(ops, taskId);
}

export function createHeadquarterOperations(
  db: HqDatabase,
  options: HeadquarterOperationsOptions = {},
): HeadquarterOperations {
  return new HeadquarterOperations(db, options);
}
