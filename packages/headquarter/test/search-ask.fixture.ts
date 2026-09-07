/**
 * Shared fixture for the Phase 11 search / Ask Jenify suites.
 *
 * Not a test file (no `.test.` in the name), so vitest's default glob does not
 * pick it up. Builds on the Phase 10 command-centre fixture — which already
 * carries the mission/memory/workforce/truth/collaboration trios, a Founder, a
 * grantless `analyst` human, four workers, one commanded mission and one real
 * canonical task — and adds the corpus a search suite needs:
 *
 *  - an INTERNAL memory record whose text is distinctive;
 *  - a FOUNDER_ONLY memory record whose text is equally distinctive, so a leak
 *    is a specific string a test can look for rather than a count;
 *  - a superseded memory chain, so staleness has a real subject;
 *  - an INTERNAL truth record carrying real op_evidence, confirmed so it
 *    derives `verified`;
 *  - a FOUNDER_ONLY truth record;
 *  - an INTERNAL and a FOUNDER_ONLY collaboration session.
 *
 * Every distinctive word is unique to exactly one record, so "did this string
 * cross the boundary" is decidable without reasoning about tokenization.
 */

import { commandCenterFixture, type CommandCenterFixture } from './command-center.fixture.js';
import { expectOk } from './application.fixture.js';

export interface SearchFixture extends CommandCenterFixture {
  /** internal memory: body contains `zircon`. */
  publicMemoryId: string;
  /** founder_only memory: title and body contain `obsidianfact`. */
  privateMemoryId: string;
  /** the SUPERSEDED predecessor in a two-record chain; body contains `krypton`. */
  supersededMemoryId: string;
  /** the CURRENT successor of that chain; body contains `krypton`. */
  currentMemoryId: string;
  /** internal truth record, confirmed → derives `verified`; statement contains `tantalum`. */
  publicTruthId: string;
  /** founder_only truth record; statement contains `obsidianclaim`. */
  privateTruthId: string;
  /** internal collaboration session; title contains `wolfram`. */
  publicSessionId: string;
  /** founder_only collaboration session; title contains `obsidianroom`. */
  privateSessionId: string;
}

export function searchFixture(): SearchFixture {
  const fx = commandCenterFixture();

  const publicMemory = expectOk(
    fx.ops.recordMemory({
      kind: 'decision',
      title: 'Compress the zircon hero asset',
      body: 'The zircon hero image blocks first paint and will be compressed before any layout change.',
      project: 'qos',
      missionId: fx.missionId,
      tags: ['performance'],
      requestedBy: 'founder',
    }),
  ).record;

  const privateMemory = expectOk(
    fx.ops.recordMemory({
      kind: 'founder_note',
      title: 'obsidianfact retainer terms',
      body: 'The obsidianfact retainer is renegotiated in Q4; do not discuss outside the Founder.',
      project: 'qos',
      privacy: 'founder_only',
      requestedBy: 'founder',
    }),
  ).record;

  const superseded = expectOk(
    fx.ops.recordMemory({
      kind: 'task_state',
      title: 'krypton budget, first cut',
      body: 'The krypton budget was set at four seconds.',
      project: 'qos',
      requestedBy: 'founder',
    }),
  ).record;
  const current = expectOk(
    fx.ops.recordMemory({
      kind: 'task_state',
      title: 'krypton budget, revised',
      body: 'The krypton budget is now two and a half seconds.',
      project: 'qos',
      supersedes: superseded.id,
      requestedBy: 'founder',
    }),
  ).record;

  const publicTruth = expectOk(
    fx.ops.recordTruth({
      entityKind: 'task',
      entityId: fx.taskId,
      statement: 'The tantalum measurement run completed on the release branch.',
      evidenceRefs: [fx.evidenceId],
      requestedBy: 'claude',
    }),
  ).record;
  expectOk(
    fx.ops.verifyTruth({
      truthId: publicTruth.id,
      method: 'inspected_evidence',
      verdict: 'confirmed',
      evidenceRefs: [fx.evidenceId],
      limitations: 'Inspected the recorded evidence entry only; the tantalum run was not repeated.',
      requestedBy: 'codex',
    }),
  );

  const privateTruth = expectOk(
    fx.ops.recordTruth({
      entityKind: 'mission',
      entityId: fx.missionId,
      statement: 'The obsidianclaim supplier contract is unsigned.',
      evidenceRefs: [fx.evidenceId],
      privacy: 'founder_only',
      requestedBy: 'founder',
    }),
  ).record;

  const publicSession = expectOk(
    fx.ops.openCollaborationSession({
      missionId: fx.missionId,
      title: 'wolfram speed room',
      purpose: 'Plan the wolfram load-time work',
      requestedBy: 'founder',
    }),
  ).session;
  const privateSession = expectOk(
    fx.ops.openCollaborationSession({
      missionId: fx.missionId,
      title: 'obsidianroom war room',
      purpose: 'Discuss the obsidianroom escalation',
      privacy: 'founder_only',
      requestedBy: 'founder',
    }),
  ).session;

  return {
    ...fx,
    publicMemoryId: publicMemory.id,
    privateMemoryId: privateMemory.id,
    supersededMemoryId: superseded.id,
    currentMemoryId: current.id,
    publicTruthId: publicTruth.id,
    privateTruthId: privateTruth.id,
    publicSessionId: publicSession.id,
    privateSessionId: privateSession.id,
  };
}

/** Every distinctive string that belongs to a founder_only record. */
export const PRIVATE_STRINGS: readonly string[] = ['obsidianfact', 'obsidianclaim', 'obsidianroom'];

/**
 * Did any founder_only string cross into the RECORD-DERIVED part of a payload?
 *
 * The caller's own words are stripped first — `question`, `terms`,
 * `ignoredTerms` and `criteria` echo what the reader typed, and a reader who
 * types a private word learns nothing by being shown it back. What must never
 * cross is a string that came from a ROW: a hit, a citation, a snippet, a
 * title or a composed sentence. Everything else in the payload is scanned.
 */
export function leaksPrivateString(payload: unknown): string | null {
  const echoKeys = new Set(['question', 'terms', 'ignoredTerms', 'criteria']);
  const encoded = JSON.stringify(payload ?? null, (key, value) =>
    echoKeys.has(key) ? '<caller echo, stripped>' : value,
  );
  for (const secret of PRIVATE_STRINGS) {
    if (encoded.includes(secret)) return secret;
  }
  return null;
}

/** Canonical row counts plus both append-only log watermarks, for a no-write proof. */
export function canonicalCensus(fx: SearchFixture): Record<string, number> {
  const tables = [
    'hq_missions',
    'hq_projects',
    'op_tasks',
    'hq_memory',
    'hq_truth_records',
    'hq_truth_verifications',
    'hq_truth_acceptances',
    'hq_collab_sessions',
    'hq_action_intents',
    'hq_specialists',
    'hq_approvals',
    'hq_events',
    'op_evidence',
    'hq_briefs',
  ];
  const census: Record<string, number> = {};
  for (const table of tables) {
    census[table] = (fx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }
  census['hq_events.maxSeq'] =
    ((fx.db.prepare(`SELECT MAX(seq) AS s FROM hq_events`).get() as { s: number | null }).s ?? 0);
  census['op_evidence.maxSeq'] =
    ((fx.db.prepare(`SELECT MAX(seq) AS s FROM op_evidence`).get() as { s: number | null }).s ?? 0);
  return census;
}
