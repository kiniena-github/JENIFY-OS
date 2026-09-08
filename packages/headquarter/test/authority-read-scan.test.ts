/**
 * "No authority-deciding path reads a patchable convenience surface" is
 * enforced here rather than asserted in a document — and from round sixteen it
 * is DERIVED FROM THE DECLARED SURFACE rather than from a list of eight
 * hand-written surfaces (Wave 5, Critical 1 / 2, High 1 / 2, Medium 1, then
 * B-1 / B-3 / B-6 / B-7).
 *
 * ## The failure mode this file exists to end, and the one it committed itself
 *
 * The reviewer's own summary of four rounds of the same defect:
 *
 * > a hardened read gets installed next to an unhardened sibling, and the
 * > prose then describes the hardened one as though it covered both.
 *
 * This file's previous docblock said: "DEFAULT DENY over the whole of `src/`.
 * … A new call site anywhere in the package — in a file that does not exist
 * yet, in a function nobody has written — fails this test the day it is
 * added." That was FALSE. It was default-deny over call sites of EIGHT
 * ENUMERATED SURFACES. `OperatorQueue` declares seventeen public members; an
 * independent scan found nineteen non-comment `.queue.*` reads outside the
 * definition file, of which the shipped scan saw four. Six authority-relevant
 * reads were invisible to it, and three of those were exploited:
 *
 *  - `queue.selectClaimable` + `HeadquarterOperations.prototype.readMeta`
 *    (`claimNext`) — the Founder's assignment gate. `{"code":
 *    "assigned_to_other_worker"}` became `{"ok":true,"claimedBy":"jules"}`, and
 *    the stolen claim ran through to a REAL external adapter call while the
 *    canonical intent still named `claude` (Critical B-1);
 *  - `this.getProposal` (`promoteProposal`) — the one bridge from chat to
 *    executable work. An already-promoted proposal promoted a second time into
 *    a fresh `github.open_pr` task carrying a payload nobody proposed
 *    (High B-3);
 *  - `queue.approvalFor` (`claudeDispatchEligibility`) — a Founder-facing
 *    verdict. `{"eligible":false,"code":"approval_invalid"}` became
 *    `{"eligible":true}` on an approval expiring in the year 2000 (Medium
 *    B-6);
 *  - and two more the review named but did not exploit: `queue.providerOf`
 *    (provider identity, law 10, printed in the executor readiness verdict)
 *    and `queue.assignabilityProblem` (the handover freeze) — both migrated
 *    here anyway, because what is being closed is the CLASS.
 *
 * ## What is derived now
 *
 * The two censuses below are computed from the SOURCE of the two classes:
 *
 *  1. `queuePublicMembers()` parses the public members of `OperatorQueue` out
 *     of `src/operator/queue.ts`. Every read of any of them anywhere in `src/`
 *     outside the definition file must carry a written classification. A
 *     member added to that class is covered the day it is DECLARED, not the
 *     day somebody remembers to add it to a list.
 *  2. `facadePublicMembers()` does the same for `HeadquarterOperations`, and
 *     two censuses are taken against it: `this.<member>` reads INSIDE
 *     `service.ts` — which is where B-1's second spelling and B-3 lived, and
 *     which a rule about "reads from outside the module" would have missed —
 *     and `ops.<member>` reads from every other module.
 *
 * Counts, not booleans, for the reason `facade-write-scan.test.ts` learned the
 * hard way: a per-file boolean credits every other occurrence in the same
 * file. Equality in BOTH directions, so a classification that stops being
 * reachable fails too and the list cannot rot into a record of things that
 * used to be true.
 *
 * ## The three blind spots, closed by DENIAL rather than by resolution
 *
 * The previous scan matched property chains only, so `const q = ops.queue;
 * q.get(id)` (aliasing), `const { get } = ops.queue` (destructuring) and
 * `ops.queue['get'](id)` (computed access) were all invisible. Resolving them
 * needs a type-aware pass this file deliberately does not build. Instead every
 * `.queue` occurrence that is NOT immediately followed by `.<identifier>` is a
 * FAILURE, listed by file and line, unless it appears in `HANDLE_ESCAPES` with
 * a reason. Aliasing, destructuring, computed access and passing the handle as
 * a value are therefore all refused rather than silently missed. That is a
 * narrower guarantee than "we can see through aliases", and it is stated as
 * what it is.
 *
 * ## What this still cannot see, stated plainly
 *
 *  - A queue obtained WITHOUT a `.queue` property access — a future call site
 *    that constructs its own `OperatorQueue`, or receives one as a parameter
 *    named anything else — is not matched by either census. What bounds that
 *    today is that `OperatorQueue`'s own enforcement reads `#db` closures, so
 *    a second instance over the same database enforces the same rules.
 *  - `ops.<member>` reads are matched on receivers spelled `ops`, `operations`
 *    or `hq`. A facade bound to a differently-named local is not counted. The
 *    receiver census is a REPORT of what the package does today; the
 *    load-bearing halves are the two censuses over reads that decide.
 *  - It is a lexical scan over source text with comments blanked. It cannot
 *    tell a read that decides from a read that displays — that is what the
 *    written `reason` on every classification is for, and a reason is a claim
 *    a human made, not a fact this file proved.
 *
 * The second half of the file is the RUNTIME form of the same rule, and it is
 * derived too: every exported class in the worker-directory modules has every
 * method on its prototype replaced with a lie AT ONCE, and the enforced
 * answers must not move.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import * as ports from '../src/application/ports.js';
import * as registryDirectory from '../src/application/registry-directory.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { HeadquarterStore } from '../src/store/headquarter.js';
import { HumanPrincipalRegistry } from '../src/application/principals.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { openMemoryHqDatabase } from '../src/store/db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');

/**
 * Where `OperatorQueue` is DEFINED and published, which is not a read of it.
 * Named as a file rather than as lines so the exclusion cannot rot.
 */
const QUEUE_DEFINITION_FILE = 'src/operator/queue.ts';
/** Where `HeadquarterOperations` is defined. Its own `this.` reads get their own census. */
const FACADE_DEFINITION_FILE = 'src/application/service.ts';

/**
 * How a read is classified. `reason` is mandatory and is checked for length,
 * because "display" with no argument behind it is exactly the assertion this
 * file exists to replace.
 *
 *  - `display`    — forging it changes what the patcher sees and nothing that
 *                   is enforced.
 *  - `enforcement`— the call IS the enforcement boundary. Permitted only with
 *                   `guardedBy`: the name of a `#private` member that the
 *                   callee's own body reads, so a patched method changes no
 *                   row. Verified against the source, not taken on trust.
 */
interface Classification {
  kind: 'display' | 'enforcement';
  reason: string;
  guardedBy?: string;
}

/**
 * Every read of an `OperatorQueue` public member from outside its definition
 * file, classified. Asserted by EQUALITY in both directions.
 */
const QUEUE_READS: Readonly<Record<string, { count: number } & Classification>> = {
  'src/application/console.ts::listByStatus': {
    count: 4,
    kind: 'display',
    reason:
      'The Founder console renders approval cards and status columns. Nothing downstream decides on ' +
      'them: a forged list changes the page the patcher is looking at, and every act the page offers ' +
      'is a separate facade call that re-reads canonical rows.',
  },
  'src/application/service.ts::selectClaimable': {
    count: 1,
    kind: 'display',
    reason:
      'The PEEK in `claimNext`, used only to answer `nothing_claimable` and to name the head task. ' +
      'It decided the assignment gate until B-1; that gate now lives inside `OperatorQueue.claim`, ' +
      'which re-runs the whole selection through `#selectClaimableInternal` against `#db`.',
  },
  'src/application/service.ts::claim': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#assignmentIntentOf',
    reason:
      'The canonical claim. Safe mode, assignability, least privilege, the kill switch, provider ' +
      'binding and — since B-1 — the Founder assignment intent are all re-derived inside the method ' +
      'from `#db` closures, so a caller who replaces this slot writes no row at all.',
  },
  'src/application/service.ts::start': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#getApprovalRecord',
    reason:
      'The execution boundary. The approval digest, its time box and the claim binding are all ' +
      're-validated inside `start` against rows read through `#private` closures.',
  },
  'src/application/service.ts::heartbeat': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#assertFence',
    reason:
      'A lease extension. The fence is checked inside the method against the canonical row, so ' +
      'replacing this slot extends no lease and moves no claim.',
  },
  'src/application/service.ts::complete': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#assertFence',
    reason:
      'Result submission. Fenced, secret-scanned and — since B-4 — reserved, so the row write and ' +
      'the hash-chained append land together or not at all.',
  },
  'src/application/service.ts::fail': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#assertFence',
    reason:
      'The failure report. Fenced inside the method against the canonical row, and reserved since ' +
      'B-4 so the evidence append and the transition cannot come apart.',
  },
  'src/application/service.ts::listWorkerProviders': {
    count: 2,
    kind: 'display',
    reason:
      'The declared worker to provider map, rendered by `workerProviderDeclarations` and by the ' +
      'eligible-worker calculation. Provider identity that DECIDES is read through ' +
      '`declaredProviderFor`, and the binding itself is enforced inside `claim` via `#providerOf`.',
  },
  'src/application/service.ts::killSwitchEngaged': {
    count: 3,
    kind: 'display',
    reason:
      'All three are inside `#missionExecutionState`, the Mission Room derived READ projection. ' +
      '`kill-switch-enforcement-safe.test.ts` carries the behavioural proof: with the delegate ' +
      'forged the projection reports the lie AND the apply cycle beside it still reads ' +
      '`#killSwitchEngagedFromStore` and refuses with `op_tasks` empty.',
  },
  'src/live/snapshot.ts::capabilities': {
    count: 1,
    kind: 'display',
    reason:
      'The capability CATALOGUE rendered into the live snapshot. Every decision in the package is ' +
      'about ONE named capability and reads it through `capabilityRowFor`; `snapshot.ts` builds a ' +
      'body for a browser and decides nothing.',
  },
  'src/providers/claude/dispatch.ts::releaseClaim': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#assertFence',
    reason:
      'Releasing a claim the dispatch lane took and will not use. Fenced and reserved inside the ' +
      'method, and it only ever REMOVES a hold.',
  },
  'src/providers/claude/dispatch.ts::start': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#getApprovalRecord',
    reason:
      'The same execution boundary as the facade call above: the dispatch lane starts the task it ' +
      'just claimed, and `start` re-validates the approval digest, its time box and the claim ' +
      'binding inside itself before anything runs.',
  },
};

/**
 * The `.queue` occurrences that are NOT a property read of a public member —
 * aliasing, destructuring, computed access, or passing the handle as a value.
 *
 * DEFAULT DENY: anything not listed here fails, by file and line, because this
 * scan cannot see through any of those shapes and refuses rather than missing
 * them silently.
 */
const HANDLE_ESCAPES: Readonly<Record<string, string>> = {
  'src/application/service.ts:this.queue =':
    'The field initialiser. This IS the publication of the handle, not a read of it.',
  'src/application/service.ts:options.queue ??':
    'The composition root reading its own option before construction.',
  'src/application/service.ts:installQueueSafeModeGate(this.queue,':
    'The handle passed to the module function that installs the safe-mode gate — a `static {}` ' +
    'accessor over a `#private` array inside `OperatorQueue`, reachable no other way.',
};

/**
 * Every `this.<publicMember>` read inside `service.ts`, classified.
 *
 * This census exists because B-1 s second spelling and B-3 both lived here:
 * `HeadquarterOperations.prototype.readMeta` and
 * `HeadquarterOperations.prototype.getProposal` are prototype slots that the
 * class dispatches through against ITSELF, which a rule about "reads from
 * outside the module" would never have seen.
 */
const FACADE_SELF_READS: Readonly<Record<string, { count: number } & Classification>> = {
  'this.queue': {
    count: 13,
    kind: 'enforcement',
    guardedBy: '#assignmentIntentOf',
    reason:
      'The queue handle itself. What is read THROUGH it is classified member by member in ' +
      '`QUEUE_READS` above, and every shape that is not such a read is denied by `HANDLE_ESCAPES`.',
  },
  'this.directory': {
    count: 1,
    kind: 'display',
    reason:
      'The field initialiser in the constructor, not a read of the published view. The reads it ' +
      'publishes are own-property closures over `#store`, which are MORE patchable than a ' +
      'prototype method and not less — one assignment on the object a caller already holds, no ' +
      'prototype involved (round seventeen, Medium 2: the reason here used to say the opposite). ' +
      'What makes this `display` is therefore not the shape but the census below: every read of a ' +
      'published view from outside this file is enumerated with a written argument, default deny.',
  },
  'this.workers': {
    count: 1,
    kind: 'display',
    reason:
      'The field initialiser. Enforcement reads `#workers`, the private triple, which is what ' +
      '`bindDirectoryReads` resolves at bind time. Its published members are own-property ' +
      'closures like `directory`s and are covered by the same default-deny view census below.',
  },
  'this.assignTask': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#taskRowFromStore',
    reason:
      '`assignTaskAsFounder` delegating to the canonical assignment write, which re-reads the task ' +
      'row, the capability and the actor through `#private` closures. Replacing the slot writes no ' +
      'meta row and appends no evidence.',
  },
  'this.routeTask': {
    count: 1,
    kind: 'display',
    reason:
      '`evaluateTaskEligibility` producing the eligible-worker REPORT. It grants nothing; the claim ' +
      'path re-derives least privilege and assignability for itself.',
  },
  'this.getProposal': {
    count: 3,
    kind: 'display',
    reason:
      'Three RETURN values — the proposal just written, and the list projection. Both deciding ' +
      'call sites (`promoteProposal`, `rejectProposal`) were migrated to `#proposalFromStore` by ' +
      'B-3; this method now delegates there itself, so the two cannot drift.',
  },
  'this.createTask': {
    count: 2,
    kind: 'enforcement',
    guardedBy: '#capabilityFromStore',
    reason:
      '`promoteProposal` and `orchestrateMission` delegating to the canonical creator, which reads ' +
      'the capability row and resolves the requester through `#private` closures and enqueues ' +
      'through the privileged API. Replacing the slot creates no task.',
  },
  'this.linkMissionPlanItem': {
    count: 1,
    kind: 'enforcement',
    guardedBy: '#missionCapabilityGate',
    reason:
      'The mission apply cycle delegating to the canonical link write, which re-resolves the ' +
      'commander and the capability gate inside itself.',
  },
  'this.readMeta': {
    count: 2,
    kind: 'display',
    reason:
      'The Mission Room projection and the handover picture. The claim gate and `#upsertMeta` were ' +
      'moved to `#metaFromStore` by B-1 — the merge especially, because a read returning null there ' +
      'would have carried null into the assignment intent it does not name.',
  },
  'this.getMission': {
    count: 2,
    kind: 'display',
    reason:
      'Mission context assembly and a status label on the orchestration result. Neither writes nor ' +
      'gates anything; the mission WRITES re-resolve the commander and the capability gate.',
  },
  'this.getProject': {
    count: 1,
    kind: 'display',
    reason:
      'Project context assembly — a read bundle handed to a browser. Every project write goes ' +
      'through its own gate and re-reads `#projectRecord`.',
  },
  'this.listActions': {
    count: 1,
    kind: 'display',
    reason:
      'The bounded wrapper slicing its own unbounded read for a page. Forging it changes how many ' +
      'rows the patcher is shown and nothing about what the action gateway permits.',
  },
  'this.listCollaborationSessions': {
    count: 1,
    kind: 'display',
    reason:
      'The bounded wrapper slicing its own unbounded read for a page. Same argument as ' +
      '`listActions`: a page size is not an authority.',
  },
  'this.listTruth': {
    count: 1,
    kind: 'display',
    reason:
      'The Mission Room truth panel. A projection over derived truth; recording, verifying and ' +
      'accepting a truth each have their own gate and re-read the store.',
  },
  'this.listTruthContradictions': {
    count: 1,
    kind: 'display',
    reason:
      'The Mission Room contradiction panel. Same argument as `listTruth`: it lists what the store ' +
      'already derived, and resolving a contradiction is a separate gated act.',
  },
};

/**
 * Every `ops.<publicMember>` read of the facade from another module, by file
 * and member, with its exact count.
 *
 * Generated from the source and asserted by equality, so a read added anywhere
 * — including in a file that does not exist yet — fails this test until
 * somebody looks at it and its file's reason still holds. The per-FILE reason
 * below is the argument; the per-member counts are what stop a new read being
 * credited by an old one.
 */
const FACADE_READS: Readonly<Record<string, number>> = {
  'src/application/console.ts::readMeta': 1,
  'src/application/console.ts::policyContext': 1,
  'src/application/console.ts::queue': 4,
  'src/application/console.ts::killSwitchScopes': 1,
  'src/cli/workforce.ts::registerAiMember': 1,
  'src/cli/workforce.ts::disableAiMember': 1,
  'src/cli/workforce.ts::setAiMemberHealth': 1,
  'src/cli/workforce.ts::deactivateExecutionWorker': 1,
  'src/live/control-api.ts::lookupPrincipal': 1,
  'src/live/control-api.ts::listMissions': 1,
  'src/live/control-api.ts::listProjects': 1,
  'src/live/control-api.ts::listMemory': 1,
  'src/live/control-api.ts::memoryStorePresent': 1,
  'src/live/control-api.ts::searchMemoryRecords': 2,
  'src/live/control-api.ts::getMissionContext': 1,
  'src/live/control-api.ts::getProjectContext': 1,
  'src/live/control-api.ts::getTaskContext': 1,
  'src/live/control-api.ts::recordMemory': 1,
  'src/live/control-api.ts::orchestrateMission': 1,
  'src/live/control-api.ts::listTruth': 1,
  'src/live/control-api.ts::listTruthContradictions': 1,
  'src/live/control-api.ts::truthStorePresent': 1,
  'src/live/control-api.ts::getEntityTruth': 1,
  'src/live/control-api.ts::recordTruth': 1,
  'src/live/control-api.ts::verifyTruth': 1,
  'src/live/control-api.ts::acceptTruth': 1,
  'src/live/control-api.ts::listActionsBounded': 1,
  'src/live/control-api.ts::actionStorePresent': 1,
  'src/live/control-api.ts::getAction': 1,
  'src/live/control-api.ts::proposeAction': 1,
  'src/live/control-api.ts::reconcileAction': 1,
  'src/live/control-api.ts::listCollaborationSessionsBounded': 1,
  'src/live/control-api.ts::collaborationStorePresent': 1,
  'src/live/control-api.ts::getMissionRoom': 1,
  'src/live/control-api.ts::assembleCollaborationContext': 1,
  'src/live/control-api.ts::openCollaborationSession': 1,
  'src/live/control-api.ts::admitCollaborator': 1,
  'src/live/control-api.ts::founderBriefing': 1,
  'src/live/control-api.ts::briefStorePresent': 1,
  'src/live/control-api.ts::founderInbox': 1,
  'src/live/control-api.ts::issueBrief': 1,
  'src/live/control-api.ts::searchCompany': 1,
  'src/live/control-api.ts::askJenify': 1,
  'src/live/control-api.ts::listProductsBounded': 1,
  'src/live/control-api.ts::productStorePresent': 1,
  'src/live/control-api.ts::getProduct': 1,
  'src/live/control-api.ts::productPlanTemplate': 1,
  'src/live/control-api.ts::productReleaseReadiness': 1,
  'src/live/control-api.ts::createProduct': 1,
  'src/live/control-api.ts::moveProductLifecycle': 1,
  'src/live/control-api.ts::registerProductArtifact': 1,
  'src/live/control-api.ts::commandMission': 1,
  'src/live/control-api.ts::transitionMission': 1,
  'src/live/control-api.ts::amendMissionIntent': 1,
  'src/live/control-api.ts::createProject': 1,
  'src/live/control-api.ts::transitionProject': 1,
  'src/live/control-api.ts::updateProject': 1,
  'src/live/control-api.ts::assignMissionToProject': 1,
  'src/live/control-api.ts::linkMissionPlanItem': 1,
  'src/live/control-api.ts::workerProviderDeclarations': 1,
  'src/live/control-api.ts::listAiMembers': 1,
  'src/live/control-api.ts::directory': 1,
  'src/live/control-api.ts::evaluateTaskEligibility': 1,
  'src/live/control-api.ts::assignTaskAsFounder': 1,
  'src/live/control-api.ts::approveTask': 1,
  'src/live/control-api.ts::denyTask': 1,
  'src/live/control-api.ts::hqReliabilityPosture': 1,
  'src/live/control-api.ts::listRunsBounded': 1,
  'src/live/control-api.ts::listVerifiedBackupsBounded': 1,
  'src/live/control-api.ts::recoverInterruptedRuns': 1,
  'src/live/control-api.ts::reconcileRun': 1,
  'src/live/control-api.ts::hqIntelligencePosture': 1,
  'src/live/control-api.ts::listModelObservationsBounded': 1,
  'src/live/control-api.ts::listIntelligenceDecisionsBounded': 1,
  'src/live/control-api.ts::listIntelligenceCostEntriesBounded': 1,
  'src/live/control-api.ts::listIntelligenceBudgetsBounded': 1,
  'src/live/control-api.ts::intelligenceAnalytics': 1,
  'src/live/control-api.ts::recordModelObservation': 1,
  'src/live/control-api.ts::setIntelligenceBudget': 1,
  'src/live/orders.ts::createTask': 1,
  'src/live/orders.ts::appendSystemEvidence': 1,
  'src/live/snapshot.ts::workerProviderDeclarations': 1,
  'src/live/snapshot.ts::listAiMembers': 1,
  'src/live/snapshot.ts::memoryStorePresent': 2,
  'src/live/snapshot.ts::listMemory': 1,
  'src/live/snapshot.ts::truthStorePresent': 1,
  'src/live/snapshot.ts::truthSummary': 1,
  'src/live/snapshot.ts::collaborationStorePresent': 1,
  'src/live/snapshot.ts::collaborationSummary': 1,
  'src/live/snapshot.ts::commandCenterSummary': 1,
  'src/live/snapshot.ts::searchIndexSummary': 1,
  'src/live/snapshot.ts::productFactorySummary': 1,
  'src/live/snapshot.ts::reliabilitySummary': 1,
  'src/live/snapshot.ts::intelligenceSummary': 1,
  'src/live/snapshot.ts::policyContext': 1,
  'src/live/snapshot.ts::directory': 2,
  'src/live/snapshot.ts::queue': 1,
  'src/live/snapshot.ts::missionStorePresent': 1,
  'src/live/snapshot.ts::listMissions': 1,
  'src/live/snapshot.ts::projectStorePresent': 1,
  'src/live/snapshot.ts::listProjects': 1,
  'src/providers/claude/dispatch.ts::policyContext': 1,
  'src/providers/claude/dispatch.ts::queue': 2,
  'src/providers/claude/dispatch.ts::appendSystemEvidence': 1,
  'src/providers/claude/dispatch.ts::returnForFreshApproval': 1,
  'src/providers/claude/dispatch.ts::readMeta': 1,
  'src/providers/claude/dispatch.ts::reserveEvidence': 2,
  'src/providers/claude/dispatch.ts::claimNext': 1,
  'src/providers/claude/dispatch.ts::reconciliationAuthorityRefusal': 1,};

/**
 * Every read of a PUBLISHED OWN-PROPERTY VIEW (`ops.directory.x`,
 * `ops.workers.x`) from outside `service.ts`, member by member.
 *
 * These are the surfaces round sixteen's census treated as one opaque read per
 * file and the classification above excused as "no prototype to patch". They
 * are the most patchable surface the facade has: a plain assignment on the
 * object the caller already holds. DEFAULT DENY — a read that is not listed
 * here fails by file and member.
 */
const PUBLISHED_VIEW_READS: Readonly<Record<string, { count: number } & Classification>> = {
  'src/live/snapshot.ts::directory.listSpecialists': {
    count: 1,
    kind: 'display',
    reason:
      'The unauthenticated snapshot listing the roster for the static site. It decides nothing: ' +
      'what may appear in that file at all is governed by `unauthenticated-founder-text.test.ts`.',
  },
  'src/live/snapshot.ts::directory.latestStatusPerSubject': {
    count: 1,
    kind: 'display',
    reason:
      'The same snapshot rendering the latest status per subject. A patched closure changes the ' +
      'published page and no stored row, no claim, no approval and no external act.',
  },
  'src/live/control-api.ts::directory.listSpecialists': {
    count: 1,
    kind: 'display',
    reason:
      'The workforce route rendering the roster to the browser. Every act it offers is a separate ' +
      'facade call that re-resolves the worker through `#private` state before it writes anything.',
  },
};

/**
 * Why reads of the facade in each of these files cannot move an enforced
 * decision. Asserted by equality against the files `FACADE_READS` actually
 * names, so a new reader file needs a written argument before it passes.
 */
const FACADE_READER_REASONS: Readonly<Record<string, string>> = {
  'src/application/console.ts':
    'The Founder console projection. It renders cards; every act it offers is a separate facade ' +
    'call that re-reads canonical rows behind its own gates.',
  'src/cli/workforce.ts':
    'The workforce CLI. Its four writes are Founder-gated configuration acts enforced inside the ' +
    'facade — registration, disablement, health and deactivation each re-resolve the principal and ' +
    'the replacement-safety guard through `#private` state.',
  'src/live/control-api.ts':
    'The HTTP control plane. Every route here is a transport in front of a facade method that ' +
    'enforces for itself; a patched slot returns a lie to the browser and writes nothing. The two ' +
    'reads that DID decide something in this file — the task row and the capability row behind the ' +
    'approve route — were migrated to `taskRowFor` / `capabilityRowFor` in round fifteen.',
  'src/live/orders.ts':
    'The Direct Order seam. It creates a task through the facade, which classifies the capability ' +
    'from `#capabilityFromStore` and enqueues through the privileged API.',
  'src/live/snapshot.ts':
    'The unauthenticated snapshot builder. It publishes; it decides nothing. What may appear in it ' +
    'is governed by `unauthenticated-founder-text.test.ts` and the census there.',
  'src/providers/claude/dispatch.ts':
    'The one file in this list that can cause a REAL external side effect, and therefore the one ' +
    'whose reads were audited member by member: the task row, the capability row, the kill switch, ' +
    'the gateway history, the evidence rows, the approval record, the declared provider, the ' +
    'assignability answer and the specialist record are ALL read through module-private function ' +
    'bindings. What remains here is `policyContext` (a frozen options object), the queue mutations ' +
    'classified in `QUEUE_READS`, and reads whose only consumer is the text of a verdict.',
};

/* ------------------------------------------------------------------ */
/* The derivation                                                      */
/* ------------------------------------------------------------------ */

/** Every `.ts` file under `src/`, as repo-relative POSIX paths. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(SRC);
  return found.map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
}

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Blank out comments, preserving line structure.
 *
 * Comments are where the migration's REASONS live — every hardened call site
 * carries a note naming the surface it no longer reads — so a scan that
 * counted them would report the fix as the defect.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, before: string) => before + ' '.repeat(match.length - before.length));
}

/**
 * The PUBLIC members a class declares, parsed from its own source.
 *
 * This is the inversion. Nothing here names `get`, `approvalFor`,
 * `selectClaimable` or `readMeta`: the members come from the class body, so a
 * member added in a future phase is covered the day it is DECLARED.
 * `#private` members are invisible to the pattern by construction — `#` is not
 * in the identifier class — which is correct, since they are exactly the
 * surfaces a caller cannot reach.
 */
function publicMembers(relativeFile: string, className: string): string[] {
  const lines = read(relativeFile).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^export class ${className}\\b`).test(line));
  expect(start, `${className} not found in ${relativeFile}`).toBeGreaterThan(-1);
  const found: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\}/.test(lines[i])) break;
    const member = lines[i].match(
      /^ {2}(?:(?:readonly|static|async|get|set|public|private|protected)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<:=]/,
    );
    if (member && member[1] !== 'constructor') found.push(member[1]);
  }
  return found;
}

function queuePublicMembers(): string[] {
  return publicMembers(QUEUE_DEFINITION_FILE, 'OperatorQueue');
}

function facadePublicMembers(): string[] {
  return publicMembers(FACADE_DEFINITION_FILE, 'HeadquarterOperations');
}

/**
 * The body of one method, from its signature line to the matching closing
 * brace at class-member indentation. Used to check that an `enforcement`
 * classification's `guardedBy` is REAL.
 */
function methodBody(relativeFile: string, name: string): string {
  const lines = read(relativeFile).split('\n');
  const start = lines.findIndex((line) => new RegExp(`^ {2}${name}\\s*\\(`).test(line));
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    out.push(lines[i]);
    if (i > start && /^ {2}\}$/.test(lines[i])) break;
  }
  return out.join('\n');
}

/** `<file>::<member>` → occurrences, plus every `.queue` shape that is not one. */
function queueCensus(): {
  reads: Record<string, number>;
  escapes: { key: string; where: string }[];
  unknownMembers: string[];
} {
  const members = new Set(queuePublicMembers());
  const reads: Record<string, number> = {};
  const escapes: { key: string; where: string }[] = [];
  const unknownMembers: string[] = [];
  for (const relative of sourceFiles()) {
    if (relative === QUEUE_DEFINITION_FILE) continue;
    const source = withoutComments(read(relative));
    const pattern = /\.queue(?![A-Za-z0-9_$])\s*(?:\.\s*([A-Za-z_$][A-Za-z0-9_$]*))?/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length;
      if (match[1] && members.has(match[1])) {
        const key = `${relative}::${match[1]}`;
        reads[key] = (reads[key] ?? 0) + 1;
        continue;
      }
      if (match[1]) {
        unknownMembers.push(`${relative}:${line} .queue.${match[1]}`);
        continue;
      }
      // Aliasing, destructuring, computed access, or the handle passed as a
      // value. Keyed by the SHAPE on the line rather than by the line number,
      // so an exemption does not rot the moment a line is inserted above it.
      const text = source.split('\n')[line - 1] ?? '';
      const shape = text.trim().replace(/\s+/g, ' ');
      const escapeKey = Object.keys(HANDLE_ESCAPES).find(
        (candidate) => candidate.startsWith(`${relative}:`) && shape.includes(candidate.slice(relative.length + 1)),
      );
      escapes.push({ key: escapeKey ?? `${relative}:${shape}`, where: `${relative}:${line}` });
    }
  }
  return { reads, escapes, unknownMembers };
}

/** `this.<member>` → occurrences, inside `service.ts` only. */
function facadeSelfCensus(): Record<string, number> {
  const members = new Set(facadePublicMembers());
  const source = withoutComments(read(FACADE_DEFINITION_FILE));
  const counts: Record<string, number> = {};
  const pattern = /\bthis\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    if (!members.has(match[1])) continue;
    const key = `this.${match[1]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/**
 * The own-property VIEWS the facade publishes, and the members each one
 * declares — parsed from the class body, never listed here.
 *
 * A view is a `readonly <name>: {` field whose type is an inline object of
 * closures. `#private` fields are invisible to the pattern by construction,
 * which is correct: they are the surfaces a caller cannot reach at all.
 */
function publishedViews(): Record<string, string[]> {
  const lines = read(FACADE_DEFINITION_FILE).split('\n');
  const start = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  expect(start, 'HeadquarterOperations not found').toBeGreaterThan(-1);
  const views: Record<string, string[]> = {};
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\}/.test(lines[i])) break;
    const field = lines[i].match(/^ {2}(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*\{\s*$/);
    if (!field) continue;
    const members: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^ {2}\};?\s*$/.test(lines[j])) {
        i = j;
        break;
      }
      const member = lines[j].match(/^ {4}([A-Za-z_$][A-Za-z0-9_$]*)\s*:/);
      if (member) members.push(member[1]);
    }
    views[field[1]] = members;
  }
  return views;
}

/** `<file>::<view>.<member>` → occurrences, for view reads from every other module. */
function publishedViewCensus(): { reads: Record<string, number>; unknownMembers: string[] } {
  const views = publishedViews();
  const names = Object.keys(views).join('|');
  const reads: Record<string, number> = {};
  const unknownMembers: string[] = [];
  for (const relative of sourceFiles()) {
    if (relative === FACADE_DEFINITION_FILE) continue;
    const source = withoutComments(read(relative));
    const pattern = new RegExp(
      `\\b(?:ops|operations|hq)\\s*\\.\\s*(${names})\\s*\\.\\s*([A-Za-z_$][A-Za-z0-9_$]*)`,
      'g',
    );
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length;
      if (!views[match[1]].includes(match[2])) {
        unknownMembers.push(`${relative}:${line} .${match[1]}.${match[2]}`);
        continue;
      }
      const key = `${relative}::${match[1]}.${match[2]}`;
      reads[key] = (reads[key] ?? 0) + 1;
    }
  }
  return { reads, unknownMembers };
}

/** `<file>::<member>` → occurrences, for facade reads from every other module. */
function facadeReaderCensus(): Record<string, number> {
  const members = new Set(facadePublicMembers());
  const counts: Record<string, number> = {};
  for (const relative of sourceFiles()) {
    if (relative === FACADE_DEFINITION_FILE) continue;
    const source = withoutComments(read(relative));
    const pattern = /\b(?:ops|operations|hq)\s*\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      if (!members.has(match[1])) continue;
      const key = `${relative}::${match[1]}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

describe('the patchable-surface census is derived from the declared surface', () => {
  it('enumerates the public members of both classes from their own source', () => {
    const queue = queuePublicMembers();
    const facade = facadePublicMembers();
    // The derivation is worth nothing if it parses nothing. Both halves are
    // asserted: a plausible size, and members the file demonstrably declares —
    // including the four the review exploited or named.
    expect(queue.length).toBeGreaterThanOrEqual(15);
    for (const member of ['get', 'claim', 'approvalFor', 'providerOf', 'assignabilityProblem', 'selectClaimable']) {
      expect(queue, member).toContain(member);
    }
    expect(facade.length).toBeGreaterThanOrEqual(100);
    for (const member of ['readMeta', 'getProposal', 'claimNext', 'promoteProposal']) {
      expect(facade, member).toContain(member);
    }
    // And it walks the whole package, not three files.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(80);
    expect(files).toContain(FACADE_DEFINITION_FILE);
    expect(files).toContain(QUEUE_DEFINITION_FILE);
  });

  it('finds exactly the queue reads that are classified, with the counts stated', () => {
    const { reads } = queueCensus();
    const classified = Object.fromEntries(
      Object.entries(QUEUE_READS).map(([key, value]) => [key, value.count]),
    );
    expect(reads).toEqual(classified);
  });

  it('refuses every aliased, destructured or computed use of the queue handle', () => {
    const { escapes, unknownMembers } = queueCensus();
    // A read of a member the class does not declare is a scan failure, not a
    // pass: it means the parse and the source disagree.
    expect(unknownMembers).toEqual([]);
    const unexplained = escapes.filter((escape) => !(escape.key in HANDLE_ESCAPES));
    expect(unexplained.map((escape) => `${escape.where} ${escape.key}`)).toEqual([]);
    // Both directions: an exemption that stopped being reachable fails too.
    expect([...new Set(escapes.map((escape) => escape.key))].sort()).toEqual(
      Object.keys(HANDLE_ESCAPES).sort(),
    );
  });

  it('finds exactly the facade self-reads that are classified, with the counts stated', () => {
    const classified = Object.fromEntries(
      Object.entries(FACADE_SELF_READS).map(([key, value]) => [key, value.count]),
    );
    expect(facadeSelfCensus()).toEqual(classified);
  });

  it('finds exactly the facade reads from other modules that are recorded', () => {
    expect(facadeReaderCensus()).toEqual(FACADE_READS);
    // Every reader file carries a written argument, and no argument outlives
    // the file it was written about.
    const readerFiles = [...new Set(Object.keys(FACADE_READS).map((key) => key.split('::')[0]))].sort();
    expect(readerFiles).toEqual(Object.keys(FACADE_READER_REASONS).sort());
  });

  it('makes every classification carry a written reason, and every enforcement claim checkable', () => {
    for (const [key, value] of Object.entries({ ...QUEUE_READS, ...FACADE_SELF_READS })) {
      expect(value.reason.length, `${key}: the reason is what replaces the assertion`).toBeGreaterThan(80);
      expect(value.count, key).toBeGreaterThan(0);
      if (value.kind !== 'enforcement') {
        expect(value.guardedBy, `${key}: only an enforcement claim names a guard`).toBeUndefined();
        continue;
      }
      const guard = value.guardedBy;
      expect(guard, `${key}: an enforcement classification must name the guard`).toBeTruthy();
      expect(guard!.startsWith('#'), `${key}: a guard is a #private member`).toBe(true);
      // The guard must be REAL: the callee's own body must read it. Derived
      // from the source, so a guard that is renamed or deleted fails here.
      const member = key.includes('::') ? key.split('::')[1] : key.slice('this.'.length);
      const file = key.startsWith('this.') ? FACADE_DEFINITION_FILE : QUEUE_DEFINITION_FILE;
      const body =
        member === 'queue'
          ? read(QUEUE_DEFINITION_FILE)
          : methodBody(file, member) || methodBody(QUEUE_DEFINITION_FILE, member);
      expect(body, `${key}: could not read the body of ${member}`).not.toBe('');
      expect(body.includes(guard!), `${key}: ${member} does not read ${guard!}`).toBe(true);
    }
    for (const reason of Object.values({ ...HANDLE_ESCAPES, ...FACADE_READER_REASONS })) {
      expect(reason.length).toBeGreaterThan(60);
    }
  });

  it('publishes an enforcement-safe counterpart for every surface an authority needs', () => {
    // The `display` classifications above are only defensible because a
    // migration TARGET exists for each surface a decision reads. Derived from
    // the module rather than asserted: these are ES module bindings, so an
    // importer cannot replace them, and a missing one would mean a future call
    // site had nowhere to go but the patchable read.
    const service = read(FACADE_DEFINITION_FILE);
    for (const binding of [
      'export function taskRowFor(',
      'export function capabilityRowFor(',
      'export function killSwitchEngagedFor(',
      'export function taskEvidenceRowsFor(',
      'export function gatewayActionHistoryFor(',
      'export function proposalRowFor(',
      'export function approvalRecordFor(',
      'export function declaredProviderFor(',
      'export function assignabilityProblemFor(',
      'export function specialistRecordFor(',
    ]) {
      expect(service, binding).toContain(binding);
    }
  });

  /**
   * The PUBLISHED VIEWS — `ops.directory`, `ops.workers` and any future
   * sibling — read from outside `service.ts`, classified. DEFAULT DENY.
   *
   * Round sixteen's census counted `ops.directory` as one opaque read per
   * file and never asked WHICH member, and the classification above excused
   * the whole view on the ground that "there is no prototype to patch". That
   * was backwards, and `executorReadiness` was reading `ops.directory
   * .getSpecialist` on the line immediately above the comment claiming the
   * class was closed. One assignment on the published object moved
   * `registered`, `active` and `hasCapability` on a Founder-facing verdict
   * from `false,false,false` to `true,true,true` for a worker the directory
   * has never heard of.
   *
   * The view NAMES and their members are derived from the class body, so a
   * view added in a future phase is covered the day it is declared, and a
   * member added to an existing view is covered the day it is published.
   */
  it('classifies every read of a published own-property view from outside the facade, default deny', () => {
    const { reads, unknownMembers } = publishedViewCensus();
    // The derivation has to be looking at something: both published views and
    // the member the round-seventeen finding turned on.
    const views = publishedViews();
    expect(Object.keys(views).sort()).toEqual(['directory', 'workers']);
    expect(views.directory).toContain('getSpecialist');
    // A member read off a published view that the view does not declare means
    // the parse and the source disagree — a scan failure, not a pass.
    expect(unknownMembers).toEqual([]);
    const classified = Object.fromEntries(
      Object.entries(PUBLISHED_VIEW_READS).map(([key, value]) => [key, value.count]),
    );
    // Both directions: an unlisted read fails, and a listing that stopped
    // being reachable fails too.
    expect(reads).toEqual(classified);
    for (const [key, value] of Object.entries(PUBLISHED_VIEW_READS)) {
      expect(value.reason.length, `${key}: the reason is what replaces the assertion`).toBeGreaterThan(80);
      expect(value.kind, `${key}: an enforcement read belongs on a module binding`).toBe('display');
    }
  });

  it('reads the run ledger through the loader that corroborates a reconciliation', () => {
    // Critical B-2's structural half. `deriveRunRecord` is a pure fold and
    // cannot consult the evidence log itself, so the corroboration lives in
    // `loadRunEvents`. Derived rather than asserted: every `deriveRunRecord`
    // call in `src/` must be handed events that came from that loader, so a
    // future call site cannot fold raw rows and silently lose the witness.
    const reliability = withoutComments(read('src/application/reliability-command.ts'));
    expect(reliability).toContain('witnessReconciliations(db, runId, rows)');
    for (const relative of sourceFiles()) {
      const source = withoutComments(read(relative));
      const pattern = /deriveRunRecord\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*,\s*([^)]*)\)/g;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(source))) {
        const events = match[2].trim();
        const fromLoader = events.startsWith('loadRunEvents(') || events === 'events';
        expect(fromLoader, `${relative}: deriveRunRecord(..., ${events}) does not come from loadRunEvents`).toBe(true);
      }
    }
    // And the one `events` local that satisfies the rule above is itself
    // loaded, so the allowance is not a hole.
    const service = withoutComments(read(FACADE_DEFINITION_FILE));
    expect(service).toContain('const events = loadRunEvents(');
  });
});

/**
 * The runtime half. Every exported class in the two worker-directory modules
 * has EVERY prototype method replaced with a maximally permissive lie, all at
 * once, and the enforced answers must not move.
 *
 * Derived, not enumerated: the classes come from the module namespace and the
 * methods from `Object.getOwnPropertyNames` of each prototype. A fourth read
 * added to `WorkerDirectoryPort` in a future phase is attacked here without
 * anybody remembering to add it, which is the property the previous
 * regressions did not have.
 */
function withEveryDirectoryPrototypeLying<T>(body: () => T): T {
  const lies: Record<string, unknown> = {
    isRegistered: () => true,
    allowedCapabilities: () => [CAPS.indexDoc, CAPS.openPr, CAPS.readStatus, CAPS.dropIndex],
    assignability: () => ({ assignable: true }),
  };
  const saved: { proto: Record<string, unknown>; name: string; had: boolean; value: unknown }[] = [];
  for (const namespace of [ports, registryDirectory] as unknown as Record<string, unknown>[]) {
    for (const exported of Object.values(namespace)) {
      if (typeof exported !== 'function') continue;
      const proto = (exported as { prototype?: object }).prototype;
      if (!proto) continue;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const replacement = lies[name];
        if (replacement === undefined) continue;
        const target = proto as Record<string, unknown>;
        saved.push({
          proto: target,
          name,
          had: Object.prototype.hasOwnProperty.call(target, name),
          value: target[name],
        });
        target[name] = replacement;
      }
    }
  }
  // The attack has to actually take, or the test proves nothing.
  expect(saved.length).toBeGreaterThanOrEqual(6);
  try {
    return body();
  } finally {
    for (const { proto, name, had, value } of saved) {
      if (had) proto[name] = value;
      else delete proto[name];
    }
  }
}

describe('a lying worker-directory prototype changes nothing that is enforced', () => {
  it('refuses a claim by a worker the directory says holds nothing, in every composition', () => {
    // All three compositions `HeadquarterOperations` supports, because the
    // defect was that ONE of them (the `memberRegistry` branch) silently opted
    // out of the database-backed read.
    for (const composition of ['default', 'memberRegistry'] as const) {
      const db = openMemoryHqDatabase();
      const store = new HeadquarterStore(db);
      const members = new Map<string, unknown>();
      const ops = new HeadquarterOperations(db, {
        store,
        policyCtx: { preApprovedCapabilities: new Set<string>([CAPS.openPr]) },
        ...(composition === 'memberRegistry'
          ? {
              memberRegistry: {
                get: (id: string) => (members.get(id) ?? null) as never,
                listAssignments: () => [],
              },
            }
          : {}),
      });
      new CapabilityRegistry(db).register({
        id: CAPS.openPr,
        description: 'Open a branch-isolated PR',
        riskClass: 'external_side_effect',
        sideEffect: true,
        idempotent: true,
      });
      // Registered and ACTIVE, granted nothing. Least privilege is the only
      // thing between this worker and the task.
      store.upsertSpecialist({
        id: 'claude',
        displayName: 'Claude',
        vendor: 'anthropic',
        role: 'build_lead',
        allowedCapabilities: [],
        active: true,
      });
      members.set('claude', {
        id: 'claude',
        effectiveCapabilities: [],
        status: 'active',
        enabled: true,
        replacedById: null,
      });
      new HumanPrincipalRegistry(db).register({
        id: 'founder',
        displayName: 'Founder',
        originateCapabilities: [CAPS.openPr],
        approvalAuthority: true,
        active: true,
      });
      expectOk(
        ops.createTask({
          capabilityId: CAPS.openPr,
          payload: { pr: 1 },
          idempotencyKey: 'k1',
          requestedBy: 'founder',
        }),
      );

      const baseline = ops.claimNext('claude', CAPS.openPr);
      expect(baseline.ok, composition).toBe(false);
      if (!baseline.ok) expect(baseline.error.code, composition).toBe('not_permitted');

      const forged = withEveryDirectoryPrototypeLying(() => ops.claimNext('claude', CAPS.openPr));
      expect(forged.ok, composition).toBe(false);
      if (!forged.ok) expect(forged.error.code, composition).toBe('not_permitted');
      expect(
        (db.prepare(`SELECT claimed_by FROM op_tasks LIMIT 1`).get() as { claimed_by: string | null })
          .claimed_by,
        composition,
      ).toBeNull();
    }
  });

  it('refuses a DISABLED worker every read the facade publishes an answer for', () => {
    const fx = setupFixture();
    fx.store.upsertSpecialist({
      id: 'claude',
      displayName: 'Claude',
      vendor: 'anthropic',
      role: 'build_lead',
      allowedCapabilities: [CAPS.readStatus, CAPS.openPr, CAPS.indexDoc, CAPS.dropIndex],
      active: false,
    });
    const baseline = fx.ops.workers.assignability('claude');
    expect(baseline).toEqual({ assignable: false, reason: 'worker_inactive' });
    const forged = withEveryDirectoryPrototypeLying(() => fx.ops.workers.assignability('claude'));
    expect(forged).toEqual({ assignable: false, reason: 'worker_inactive' });
  });
});
