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
 *    against the write markers, so a mutator cannot be hidden by being called
 *    a read;
 *  - the dispositions the round-seven corrections turn on are ALSO proven
 *    behaviourally, against a real file-backed database with a real latched
 *    finding, at the bottom of this file. A derivation that drifted from the
 *    runtime would fail there.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS } from './application.fixture.js';
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

  it('nothing on the READ list reaches a write — the list cannot hide a mutator', () => {
    const byName = new Map(facadeMethods().map((m) => [m.name, m]));
    const stale = READS.filter((name) => !byName.has(name));
    expect(stale, 'READ list names a method that no longer exists').toEqual([]);
    const writers = READS.filter((name) => byName.get(name)!.writes);
    expect(writers).toEqual([]);
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
