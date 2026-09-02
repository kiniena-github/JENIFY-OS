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
import type { ActivityStatus } from '../contracts/events.js';
import type { WorkerDescriptor, WorkerRole } from '../contracts/workers.js';
import { evaluatePolicy, type PolicyContext, type PolicyDecision } from '../operator/policy.js';
import { taskActionDigest, type ApprovalRejection } from '../operator/approvals.js';
import { assertNoSecretLikeContent, type EvidenceEntry } from '../operator/evidence.js';
import { CapabilityRegistry, type Capability } from '../operator/capabilities.js';
import {
  OperatorQueue,
  type OperatorTask,
  type PrivilegedQueueApi,
  type ReconcileDecision,
} from '../operator/queue.js';
import {
  ProviderBindingViolation,
  ProviderDeclarationRejected,
  WorkerProviderDirectory,
  type WorkerProviderRecord,
} from '../operator/provider-binding.js';
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
  | 'replacement_blocked';

export interface OpsError {
  code: OpsErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export type OpsResult<T> = { ok: true; data: T } | { ok: false; error: OpsError };

function fail(code: OpsErrorCode, message: string, details?: Record<string, unknown>): OpsResult<never> {
  return { ok: false, error: { code, message, details } };
}

function ok<T>(data: T): OpsResult<T> {
  return { ok: true, data };
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

  constructor(db: HqDatabase, options: HeadquarterOperationsOptions = {}) {
    this.#db = db;
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
    this.#store = options.store ?? new HeadquarterStore(db);
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
    if (this.queue.killSwitchEngaged(task.capabilityId)) {
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
    if (this.queue.killSwitchEngaged(capabilityId)) {
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

export function createHeadquarterOperations(
  db: HqDatabase,
  options: HeadquarterOperationsOptions = {},
): HeadquarterOperations {
  return new HeadquarterOperations(db, options);
}
