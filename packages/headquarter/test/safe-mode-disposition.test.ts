/**
 * Every public write on the facade has a STATED safe-mode disposition, and the
 * statement is checked against the code (Wave 5 correction round seven, Medium 1).
 *
 * ## Why this file exists rather than one more table row
 *
 * Three separate reviews of this wave found a mutator that was in NEITHER
 * column of `PHASE_13_ADVANCED_RELIABILITY.md`'s safe-mode tables:
 * `authorizeAction` in the first, `registerExecutionWorker` and
 * `declareWorkerProvider` in round three, and in round seven `acceptTruth`,
 * `registerAiMember`, `disableAiMember`, `setAiMemberHealth`,
 * `postMissionMessage`, `reconcileTask`, `rejectProposal` and
 * `returnForFreshApproval` together. Each time the fix was to add the missing
 * rows, and each time the tables were presented as complete when they were not.
 *
 * A doc cannot enforce its own completeness, so this does: the two tables are
 * parsed out of the phase document, the same two sets are derived from
 * `application/service.ts`, and they must be equal in BOTH directions. A new
 * public mutator lands in the derived set and fails here until somebody writes
 * a row saying what safe mode does with it. A row for a method that no longer
 * has the disposition it claims fails here too.
 *
 * ## How the disposition is derived, and why that is honest
 *
 * The derivation reads the source, because that is where the answer actually
 * is: a method refuses in safe mode when its body calls `#safeModeRefusal`, or
 * a `#…CapabilityGate` helper that leaves `permittedInSafeMode` at its default
 * `false`. `#reliabilityCapabilityGate` is the single helper that passes
 * `true`, so the two methods behind it — `assessHqIntegrity` and
 * `recordVerifiedBackup` — derive as AVAILABLE, which is what they are and
 * what the table says.
 *
 * The source scan is a heuristic and is treated as one. Two guards keep it
 * from being a comfortable lie:
 *
 *  - the READ list below is explicit, and every name on it is re-checked
 *    against the write markers — and, since round ten (Medium 1), TRANSITIVELY
 *    rather than against the direct method body alone. `WRITE_MARKERS` is a
 *    regex over one body, so a read that reached a write through a helper was
 *    invisible to it: `reconciliationAuthorityRefusal` appends an
 *    `op_evidence` row through `#assertApprovalAuthority`, and
 *    `evaluateTaskEligibility` appends one through `this.routeTask`, and both
 *    sat on the READ list under an assertion that said "nothing on the READ
 *    list reaches a write — the list cannot hide a mutator". That sentence was
 *    false. It is now true, in the only way it can be: the reachability is
 *    computed through the call graph, everything it reaches is NAMED, and what
 *    each named member actually writes is MEASURED by table delta at the
 *    bottom of this file rather than asserted;
 *  - the dispositions the round-seven corrections turn on are ALSO proven
 *    behaviourally, against a real file-backed database with a real latched
 *    finding, at the bottom of this file. A derivation that drifted from the
 *    runtime would fail there.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS, expectOk, setupFixture } from './application.fixture.js';
import type { HqDatabase } from '../src/store/db.js';
import { fileFixture } from './reliability.fixture.js';
import {
  TRUTH_RECORD_CAPABILITY,
  TRUTH_VERIFY_CAPABILITY,
  registerTruthRecordCapability,
  registerTruthVerifyCapability,
} from '../src/application/truth-command.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');
const PHASE_13 = path.join(
  HERE,
  '..',
  '..',
  '..',
  'docs',
  'HEADQUARTER',
  'PHASE_13_ADVANCED_RELIABILITY.md',
);

/**
 * Public methods that write nothing. Explicit rather than derived, so adding a
 * method to it is a visible act — and cross-checked below against the same
 * write markers the derivation uses, so the list cannot be used to hide one.
 */
const READS: readonly string[] = [
  'killSwitchScopes',
  'classify',
  'reconciliationAuthorityRefusal',
  'workerProviderDeclarations',
  'replacementPlan',
  'assertReplacementSafe',
  'evaluateTaskEligibility',
  'listAiMembers',
  'getProposal',
  'listProposals',
  'getMission',
  'listMissions',
  'missionStorePresent',
  'getMissionIntentHistory',
  'getMissionExecutionState',
  'getProject',
  'listProjects',
  'projectStorePresent',
  'getProduct',
  'listProducts',
  'listProductsBounded',
  'productPlanTemplate',
  'productReleaseReadiness',
  'productFactorySummary',
  'productStorePresent',
  'getRun',
  'listRuns',
  'listRunsBounded',
  'listVerifiedBackupsBounded',
  'hqReliabilityPosture',
  'reliabilitySummary',
  'reliabilityStorePresent',
  'hqProcessIdentity',
  'intelligenceBudgetDecision',
  'intelligenceRoutingProposal',
  'getIntelligenceDecision',
  'listModelObservationsBounded',
  'listIntelligenceDecisionsBounded',
  'listIntelligenceCostEntriesBounded',
  'listIntelligenceBudgetsBounded',
  'intelligenceAnalytics',
  'hqIntelligencePosture',
  'intelligenceSummary',
  'intelligenceStorePresent',
  'getMemoryRecord',
  'listMemory',
  'searchMemoryRecords',
  'getMissionContext',
  'getProjectContext',
  'getTaskContext',
  'memoryStorePresent',
  'getTruthRecord',
  'listTruth',
  'getEntityTruth',
  'listTruthContradictions',
  'truthSummary',
  'truthStorePresent',
  'getAction',
  'listActions',
  'listActionsBounded',
  'actionStorePresent',
  'gatewayActionHistory',
  'getCollaborationSession',
  'listCollaborationSessions',
  'listCollaborationSessionsBounded',
  'listContributions',
  'getMissionRoom',
  'collaborationSummary',
  'collaborationStorePresent',
  'founderInbox',
  'founderBriefing',
  'commandCenterSummary',
  'listBriefs',
  'getBrief',
  'briefStorePresent',
  'searchCompany',
  'askJenify',
  'searchIndexSummary',
  'searchSources',
  'readMeta',
];

/**
 * READ-list members that DO write — an append to the audit chain and nothing
 * else — with the reason each is acceptable.
 *
 * Named rather than excused: an `op_evidence` append is a write, so the honest
 * classification is "a read that records that it was asked", not "a read". Both
 * are measured below, and the measurement is what enforces the word "and
 * nothing else".
 *
 *  - `reconciliationAuthorityRefusal` resolves whether an actor may decide an
 *    ambiguous external outcome, through the SAME `#assertApprovalAuthority`
 *    that `approveTask` and `denyTask` use. That helper AUDITS a refusal, on
 *    purpose: an attempt to decide an irreversible external act by someone who
 *    may not is exactly the thing HQ must not forget. The append happens only
 *    on a REFUSAL (measured: a registered worker and a resolved approver both
 *    append nothing), it names no new authority, and it creates no task,
 *    approval, claim or run;
 *  - `evaluateTaskEligibility` calls `this.routeTask`, whose `routing_evaluated`
 *    evidence note is why `/workforce/route` already sits on the control API's
 *    WRITE surface. The comment on `orchestrateMission`'s preview says so in
 *    those words. It changes no canonical state: the eligibility answer is
 *    computed from the capability registry and the directory allow-list, and
 *    the claim it might inform is refused under safe mode anyway.
 *
 * Both stay AVAILABLE under safe mode for the same reason `routeTask` and
 * `appendSystemEvidence` do — refusing them would leave HQ unable to record
 * that it was asked, which loses truth in the posture built for not losing it.
 */
const READS_THAT_APPEND_AUDIT_EVIDENCE: readonly string[] = [
  'reconciliationAuthorityRefusal',
  'evaluateTaskEligibility',
];

/**
 * READ-list members the CALL-GRAPH reachability names but that write nothing,
 * because the writing branch of the helper they call is one they cannot take.
 *
 * Listed rather than silently subtracted, because the static reachability is an
 * over-approximation and pretending otherwise in either direction would be the
 * same failure: claiming these append evidence would be as false as claiming
 * the two above do not. Measured below — both come back with an EMPTY table
 * delta.
 */
const READS_REACHING_A_WRITE_ONLY_ON_AN_UNTAKEN_BRANCH: readonly string[] = [
  'intelligenceBudgetDecision',
  'intelligenceRoutingProposal',
];

/** Markers that a method body reaches a write. */
const WRITE_MARKERS =
  /(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)|appendEvidence\(|appendEvent\(|#upsertMeta\(|#requirePrivilegedQueue\(\)|postMessage\(|registry\.(?:register|disable|setHealth|assign|update)\(|#workerProviderRegistrar\.|#appendRunEvent\(|this\.queue\.(?:start|heartbeat|complete|fail|claim)\(/;

const CONTROL_WORDS = new Set([
  'if',
  'for',
  'switch',
  'while',
  'catch',
  'return',
  'constructor',
  'do',
  'else',
  'try',
]);

interface MethodFacts {
  name: string;
  writes: boolean;
  refusedInSafeMode: boolean;
}

function facadeMethods(): MethodFacts[] {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  expect(classStart).toBeGreaterThan(-1);
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (match && !CONTROL_WORDS.has(match[1])) starts.push({ name: match[1], line: i });
  }
  const facts: MethodFacts[] = [];
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k].line;
    const to = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    const name = starts[k].name;
    if (name.startsWith('#')) continue;
    const body = lines.slice(from, to).join('\n');
    const gated =
      body.includes('#safeModeRefusal(') ||
      /#(?:mission|project|memory|product|intelligence|truthRecord|truthVerify|collaborationCommand|collaborationContribute|founderBrief)CapabilityGate\(/.test(
        body,
      ) ||
      body.includes('#founderGateCapabilityGate(');
    // The one helper that passes `permittedInSafeMode = true`.
    const permitted = /#reliabilityCapabilityGate\(/.test(body);
    facts.push({ name, writes: WRITE_MARKERS.test(body), refusedInSafeMode: gated && !permitted });
  }
  return facts;
}

/**
 * Every public method that reaches a write TRANSITIVELY, through the class's
 * own call graph.
 *
 * `#private` members are included in the graph (they are how a read reaches a
 * write) but never in the answer, which is about the public surface. A
 * fixpoint, so a chain of any length is followed.
 */
function transitiveWriters(): Set<string> {
  const lines = fs.readFileSync(SERVICE, 'utf8').split('\n');
  const classStart = lines.findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
  const starts: { name: string; line: number }[] = [];
  for (let i = classStart; i < lines.length; i += 1) {
    const match = /^ {2}(#?[A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(lines[i]);
    if (match && !CONTROL_WORDS.has(match[1])) starts.push({ name: match[1], line: i });
  }
  const bodies = new Map<string, string>();
  for (let k = 0; k < starts.length; k += 1) {
    const from = starts[k].line;
    const to = k + 1 < starts.length ? starts[k + 1].line : lines.length;
    // Overloads and re-declared names accumulate rather than overwrite.
    bodies.set(starts[k].name, (bodies.get(starts[k].name) ?? '') + lines.slice(from, to).join('\n'));
  }
  const writers = new Set<string>();
  for (const [name, body] of bodies) if (WRITE_MARKERS.test(body)) writers.add(name);
  const callees = new Map<string, Set<string>>();
  for (const [name, body] of bodies) {
    const found = new Set<string>();
    for (const call of body.matchAll(/this\.(#?[A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
      if (bodies.has(call[1])) found.add(call[1]);
    }
    callees.set(name, found);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, called] of callees) {
      if (writers.has(name)) continue;
      for (const callee of called) {
        if (writers.has(callee)) {
          writers.add(name);
          grew = true;
          break;
        }
      }
    }
  }
  return writers;
}

/** The first backticked identifier in each row of the table under `heading`. */
function tableIdentifiers(heading: string): string[] {
  const doc = fs.readFileSync(PHASE_13, 'utf8').split('\n');
  const at = doc.findIndex((line) => line.trim() === heading);
  expect(at, `heading not found: ${heading}`).toBeGreaterThan(-1);
  const names: string[] = [];
  let started = false;
  for (let i = at + 1; i < doc.length; i += 1) {
    const line = doc[i];
    if (line.startsWith('####') || line.startsWith('###') || line.startsWith('## ')) break;
    if (!line.startsWith('|')) {
      if (started) break;
      continue;
    }
    started = true;
    if (/^\|\s*-+/.test(line)) continue;
    const cell = line.split('|')[1] ?? '';
    const identifier = /`([A-Za-z_][A-Za-z0-9_]*)`/.exec(cell);
    if (identifier) names.push(identifier[1]);
  }
  return names;
}

const REFUSED_HEADING = '#### Every facade write REFUSED while safe mode is engaged';
const AVAILABLE_HEADING =
  '#### Every facade write LEFT AVAILABLE while safe mode is engaged, each with its reason';

describe('safe-mode disposition is stated for every facade write, and the statement matches the code', () => {
  it('every public method is a read, a refused write, or an available write — nothing is unclassified', () => {
    const methods = facadeMethods();
    expect(methods.length).toBeGreaterThan(100);
    const unclassified = methods.filter(
      (m) => !m.refusedInSafeMode && !m.writes && !READS.includes(m.name),
    );
    expect(unclassified.map((m) => m.name)).toEqual([]);
  });

  it('nothing on the READ list writes DIRECTLY — the list cannot hide a mutator', () => {
    const byName = new Map(facadeMethods().map((m) => [m.name, m]));
    const stale = READS.filter((name) => !byName.has(name));
    expect(stale, 'READ list names a method that no longer exists').toEqual([]);
    const writers = READS.filter((name) => byName.get(name)!.writes);
    expect(writers).toEqual([]);
  });

  it('every READ that reaches a write TRANSITIVELY is named, with what it writes', () => {
    // Round ten, Medium 1. The assertion above is a regex over one method body,
    // which is precisely why two mutators sat on the READ list under a sentence
    // that said none could. The call graph is followed instead, and everything
    // it reaches has to be classified by hand — with the classification then
    // MEASURED at the bottom of this file.
    const reaching = transitiveWriters();
    const unclassified = READS.filter(
      (name) =>
        reaching.has(name) &&
        !READS_THAT_APPEND_AUDIT_EVIDENCE.includes(name) &&
        !READS_REACHING_A_WRITE_ONLY_ON_AN_UNTAKEN_BRANCH.includes(name),
    );
    expect(
      unclassified,
      'a READ-list method reaches a write and is in neither classification list',
    ).toEqual([]);
    // The CONTRAST, spelled out, because it is the whole finding: the direct
    // predicate the previous round relied on reports both of these as
    // non-writers, and the measurement at the bottom of this file shows each
    // appending a row. A per-body regex cannot see through a helper, so the
    // sentence it was asked to enforce could never have been true.
    const direct = new Map(facadeMethods().map((method) => [method.name, method.writes]));
    for (const name of READS_THAT_APPEND_AUDIT_EVIDENCE) {
      expect(direct.get(name), `${name} should be invisible to the DIRECT predicate`).toBe(false);
    }
    // The derivation is not vacuous: the two the review found are still found.
    for (const name of READS_THAT_APPEND_AUDIT_EVIDENCE) {
      expect(reaching.has(name), `${name} is no longer seen to reach a write`).toBe(true);
      expect(READS).toContain(name);
    }
    for (const name of READS_REACHING_A_WRITE_ONLY_ON_AN_UNTAKEN_BRANCH) {
      expect(reaching.has(name), `${name} is no longer seen to reach a write`).toBe(true);
      expect(READS).toContain(name);
    }
  });

  it('the phase document REFUSED table names exactly the methods the code refuses', () => {
    const derived = facadeMethods()
      .filter((m) => m.refusedInSafeMode)
      .map((m) => m.name)
      .sort();
    const documented = [...tableIdentifiers(REFUSED_HEADING)].sort();
    expect(documented).toEqual(derived);
  });

  it('the phase document LEFT-AVAILABLE table names exactly the writes the code leaves available', () => {
    const derived = facadeMethods()
      .filter((m) => !m.refusedInSafeMode && m.writes)
      .map((m) => m.name)
      .sort();
    const documented = [...tableIdentifiers(AVAILABLE_HEADING)].sort();
    expect(documented).toEqual(derived);
  });

  it('no method is in both tables', () => {
    const refused = new Set(tableIdentifiers(REFUSED_HEADING));
    const both = tableIdentifiers(AVAILABLE_HEADING).filter((name) => refused.has(name));
    expect(both).toEqual([]);
  });

  it('the four methods this correction moved are each named in a table', () => {
    const named = new Set([
      ...tableIdentifiers(REFUSED_HEADING),
      ...tableIdentifiers(AVAILABLE_HEADING),
    ]);
    for (const name of [
      'acceptTruth',
      'registerAiMember',
      'disableAiMember',
      'setAiMemberHealth',
      'postMissionMessage',
      'reconcileTask',
      'rejectProposal',
      'returnForFreshApproval',
    ]) {
      expect(named.has(name), `${name} is in neither table`).toBe(true);
    }
  });
});

/**
 * The behavioural half. A latched `append_only_guard_missing` on a real file,
 * carried across a reopen, then the acts themselves — so the derivation above
 * cannot pass while the runtime disagrees with it.
 */
function latchedFixture() {
  const fx = fileFixture();
  registerTruthRecordCapability(fx.db);
  registerTruthVerifyCapability(fx.db);
  fx.principals.register({
    id: 'founder',
    displayName: 'Founder',
    originateCapabilities: [
      CAPS.readStatus,
      CAPS.openPr,
      'hq.reliability_command',
      TRUTH_RECORD_CAPABILITY.id,
      TRUTH_VERIFY_CAPABILITY.id,
    ],
    approvalAuthority: true,
    active: true,
  });
  fx.principals.register({
    id: 'analyst',
    displayName: 'Analyst',
    originateCapabilities: [TRUTH_RECORD_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  fx.principals.register({
    id: 'auditor',
    displayName: 'Auditor',
    originateCapabilities: [TRUTH_VERIFY_CAPABILITY.id],
    approvalAuthority: false,
    active: true,
  });
  return fx;
}

describe('the round-seven dispositions hold at runtime, not only in the source scan', () => {
  it('acceptTruth is refused while safe mode is engaged, and accepted while it is not', () => {
    const fx = latchedFixture();
    try {
      const evidenceId = (fx.ops.queue.evidence.list(fx.claim.taskId)[0] as { id: string }).id;
      const recorded = fx.ops.recordTruth({
        entityKind: 'task',
        entityId: fx.claim.taskId,
        statement: 'The line ran clean for the whole shift.',
        bornState: 'observed',
        evidenceRefs: [evidenceId],
        requestedBy: 'analyst',
        idempotencyKey: 'k1',
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      const truthId = recorded.data.record.id;
      const verified = fx.ops.verifyTruth({
        truthId,
        method: 'reproduced',
        verdict: 'confirmed',
        evidenceRefs: [evidenceId],
        limitations: 'Verified against the shift log only.',
        requestedBy: 'auditor',
        idempotencyKey: 'v1',
      });
      expect(verified.ok).toBe(true);

      // Healthy: the act lands.
      const healthy = fx.reopen('p-healthy');
      expect(healthy.ops.hqReliabilityPosture().integrity.safeMode).toBe(false);
      const before = healthy.ops.getTruthRecord(truthId);
      expect(before).not.toBeNull();
      expect(before!.acceptanceDigest).not.toBeNull();
      const admitted = healthy.ops.acceptTruth({
        truthId,
        expectedDigest: before!.acceptanceDigest ?? '',
        note: 'Founder signs off.',
        requestedBy: 'founder',
      });
      expect(admitted.ok).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it('acceptTruth is refused as safe_mode_engaged once a declared guard is missing', () => {
    const fx = latchedFixture();
    try {
      const evidenceId = (fx.ops.queue.evidence.list(fx.claim.taskId)[0] as { id: string }).id;
      const recorded = fx.ops.recordTruth({
        entityKind: 'task',
        entityId: fx.claim.taskId,
        statement: 'The line ran clean for the whole shift.',
        bornState: 'observed',
        evidenceRefs: [evidenceId],
        requestedBy: 'analyst',
        idempotencyKey: 'k1',
      });
      expect(recorded.ok).toBe(true);
      if (!recorded.ok) return;
      const truthId = recorded.data.record.id;
      expect(
        fx.ops.verifyTruth({
          truthId,
          method: 'reproduced',
          verdict: 'confirmed',
          evidenceRefs: [evidenceId],
          limitations: 'Verified against the shift log only.',
          requestedBy: 'auditor',
          idempotencyKey: 'v1',
        }).ok,
      ).toBe(true);

      const raw = fx.raw();
      raw.exec('DROP TRIGGER IF EXISTS trg_hq_truth_acceptances_no_erase');
      raw.close();

      const latched = fx.reopen('p-latched');
      const posture = latched.ops.hqReliabilityPosture();
      expect(posture.integrity.safeMode).toBe(true);
      expect(
        posture.integrity.observations.filter((o) => o.blocking).map((o) => o.finding),
      ).toContain('append_only_guard_missing');

      const view = latched.ops.getTruthRecord(truthId);
      expect(view).not.toBeNull();
      const refused = latched.ops.acceptTruth({
        truthId,
        expectedDigest: view!.acceptanceDigest ?? '',
        note: 'Founder signs off.',
        requestedBy: 'founder',
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error.code).toBe('safe_mode_engaged');
      // And nothing was written: the record is still merely verified.
      expect(latched.ops.getTruthRecord(truthId)!.acceptances).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it('registerAiMember is refused as safe_mode_engaged, and the refusal precedes the unconfigured-registry answer', () => {
    const fx = latchedFixture();
    try {
      const raw = fx.raw();
      raw.exec('DROP TRIGGER IF EXISTS trg_hq_truth_acceptances_no_erase');
      raw.close();
      const latched = fx.reopen('p-latched');
      expect(latched.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      const refused = latched.ops.registerAiMember({
        id: 'gpt-x',
        displayName: 'GPT X',
        providerId: 'openai',
        modelId: 'gpt-x',
        modelVersion: '1',
        workerType: 'execution',
        locality: 'cloud',
        privacyClass: 'internal',
        costClass: 'medium',
        grantedCapabilities: [CAPS.readStatus],
        founderId: 'founder',
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      // Categorically safe mode — NOT `workforce_registry_unconfigured`, which
      // is what this deployment would otherwise answer. The gate is first.
      expect(refused.error.code).toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  it('the narrowing mirror acts stay available: disableAiMember and setAiMemberHealth are not refused for safe mode', () => {
    const fx = latchedFixture();
    try {
      const raw = fx.raw();
      raw.exec('DROP TRIGGER IF EXISTS trg_hq_truth_acceptances_no_erase');
      raw.close();
      const latched = fx.reopen('p-latched');
      expect(latched.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      const disabled = latched.ops.disableAiMember({
        memberId: 'gpt-x',
        reason: 'Stood down for the duration of the incident.',
        founderId: 'founder',
      });
      expect(disabled.ok).toBe(false);
      if (disabled.ok) return;
      // Whatever it answers, it is never the safe-mode refusal: this direction
      // only ever removes an option.
      expect(disabled.error.code).not.toBe('safe_mode_engaged');

      const health = latched.ops.setAiMemberHealth({
        memberId: 'gpt-x',
        health: 'unavailable',
        founderId: 'founder',
      });
      expect(health.ok).toBe(false);
      if (health.ok) return;
      expect(health.error.code).not.toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });

  it('postMissionMessage, reconcileTask, rejectProposal and returnForFreshApproval are never refused for safe mode', () => {
    const fx = latchedFixture();
    try {
      const raw = fx.raw();
      raw.exec('DROP TRIGGER IF EXISTS trg_hq_truth_acceptances_no_erase');
      raw.close();
      const latched = fx.reopen('p-latched');
      expect(latched.ops.hqReliabilityPosture().integrity.safeMode).toBe(true);

      const posted = latched.ops.postMissionMessage({
        threadId: 'room-1',
        author: 'founder',
        body: 'The store is latched; here is what we know so far.',
      });
      expect(posted.ok).toBe(true);

      const proposal = latched.ops.proposeMission({
        threadId: 'room-1',
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        proposedBy: 'founder',
      });
      expect(proposal.ok).toBe(true);
      if (!proposal.ok) return;
      const rejected = latched.ops.rejectProposal(
        proposal.data.id,
        'founder',
        'Not while the store is latched.',
      );
      expect(rejected.ok).toBe(true);

      const returned = latched.ops.returnForFreshApproval(fx.claim.taskId);
      expect(returned.ok).toBe(true);

      const reconciled = latched.ops.reconcileTask(
        fx.claim.taskId,
        'confirmed_done',
        'founder',
        'Checked the real world; the PR is open.',
      );
      // It may be refused on canonical grounds — the task is not
      // `outcome_unknown` — but never because safe mode is engaged.
      if (!reconciled.ok) expect(reconciled.error.code).not.toBe('safe_mode_engaged');
    } finally {
      fx.cleanup();
    }
  });
});

/**
 * The MEASURED half of the round-ten classification (Medium 1).
 *
 * A static reachability answer is an over-approximation and a hand-written
 * reason is a claim. Both are settled here by counting rows in every table
 * before and after the call, so "appends one audit row and nothing else" and
 * "writes nothing at all" are facts rather than sentences.
 */
function tableCounts(db: HqDatabase): Record<string, number> {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[]
  ).map((row) => row.name);
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
  }
  return counts;
}

/** Which tables grew, and by how much. */
function rowsWritten(db: HqDatabase, act: () => unknown): Record<string, number> {
  const before = tableCounts(db);
  act();
  const after = tableCounts(db);
  const delta: Record<string, number> = {};
  for (const [table, count] of Object.entries(after)) {
    if (count !== (before[table] ?? 0)) delta[table] = count - (before[table] ?? 0);
  }
  return delta;
}

describe('what each classified READ actually writes, measured rather than asserted', () => {
  it('reconciliationAuthorityRefusal appends exactly one op_evidence row on a REFUSAL, and nothing else', () => {
    const fx = setupFixture();
    // A principal that exists but holds no approval authority: the refusal
    // path, which is the one that audits.
    expect(rowsWritten(fx.db, () => fx.ops.reconciliationAuthorityRefusal('analyst'))).toEqual({
      op_evidence: 1,
    });
    // An id that resolves to nothing at all: same audited refusal.
    expect(rowsWritten(fx.db, () => fx.ops.reconciliationAuthorityRefusal('nobody'))).toEqual({
      op_evidence: 1,
    });
    // And the two paths that are NOT a refusal of a human decider write
    // nothing, so the audit is scoped to the act it is about.
    expect(rowsWritten(fx.db, () => fx.ops.reconciliationAuthorityRefusal('founder'))).toEqual({});
    expect(rowsWritten(fx.db, () => fx.ops.reconciliationAuthorityRefusal('claude'))).toEqual({});
  });

  it('evaluateTaskEligibility appends exactly one op_evidence row, and nothing else', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        requestedBy: 'claude',
      }),
    );
    expect(rowsWritten(fx.db, () => fx.ops.evaluateTaskEligibility(created.task.id))).toEqual({
      op_evidence: 1,
    });
  });

  it('the two the call graph only SUSPECTS write nothing at all', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        requestedBy: 'claude',
      }),
    );
    expect(
      rowsWritten(fx.db, () =>
        fx.ops.intelligenceBudgetDecision({
          scopeKind: 'deployment',
          scopeId: 'deployment',
          window: 'total',
        }),
      ),
    ).toEqual({});
    expect(
      rowsWritten(fx.db, () =>
        fx.ops.intelligenceRoutingProposal({
          taskId: created.task.id,
          complexity: 'routine',
          contextSize: 'medium',
          workKind: 'coding',
        }),
      ),
    ).toEqual({});
  });

  it('a sample of the plain READ list writes nothing — the classification is not covering for the rest', () => {
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        requestedBy: 'claude',
      }),
    );
    for (const [name, act] of [
      ['killSwitchScopes', () => fx.ops.killSwitchScopes()],
      ['replacementPlan', () => fx.ops.replacementPlan('claude')],
      ['hqReliabilityPosture', () => fx.ops.hqReliabilityPosture()],
      ['commandCenterSummary', () => fx.ops.commandCenterSummary()],
      ['founderInbox', () => fx.ops.founderInbox()],
      ['getTaskContext', () => fx.ops.getTaskContext(created.task.id)],
      ['lookupPrincipal', () => fx.ops.lookupPrincipal('founder')],
    ] as [string, () => unknown][]) {
      expect(rowsWritten(fx.db, act), name).toEqual({});
    }
  });
});
