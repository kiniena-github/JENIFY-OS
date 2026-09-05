/**
 * Mission persistence (issue #254, integration decision D3).
 *
 * ## What this store may touch
 *
 * The four mission tables in `store/db.ts` — `hq_missions`,
 * `hq_mission_tasks`, `hq_mission_intent`, `hq_mission_events` — and nothing
 * else. There is no statement in this file against `op_tasks`, `op_evidence`,
 * `op_capabilities`, `hq_approvals` or any other canonical table, and
 * `test/mission-core.test.ts` greps this module to keep it that way. Task
 * creation goes through `submitDirectOrder` (D5); this store only records the
 * LINK from a mission to the canonical task row that path returned.
 *
 * ## Why the handle is `#private`
 *
 * For the reason `HeadquarterOperations` learned four times over in #200: a
 * TypeScript `private` erases to a public property, and a public database
 * handle on an object a route holds is a raw-write path to every table in the
 * file. The store is constructed by the composition root from the SAME
 * connection the operations facade uses — that is what lets a mission and its
 * tasks commit or roll back together inside `ops.reserveEvidence` — and it
 * exposes only mission-scoped methods.
 *
 * ## Append-only, mechanically
 *
 * `hq_mission_intent` and `hq_mission_events` are only ever INSERTed into.
 * The intent rows are additionally hash-chained per mission
 * (`hash = sha256(prev_hash ‖ canonical row)`), so an edit to any historical
 * row breaks every hash after it and `verifyIntentChain` reports it.
 *
 * ## The chain has an anchored head (mutation-testing pass on `b3f72d1`, P1.3)
 *
 * A forward walk from genesis proves that every row still hashes to the row
 * before it. It proves NOTHING about rows that are no longer there at the
 * end: delete the newest amendment and every remaining row still chains
 * perfectly, so the walk reported `true` and the Mission Room showed
 * `chainIntact: true, revisions: 1` over a mission whose latest Founder
 * amendment had been erased with one DELETE. The docstring on
 * `verifyIntentChain` claimed a deletion would be reported; for the tail it
 * was not.
 *
 * So `appendIntent` also writes the new head hash and the row count onto the
 * mission row (`intent_head_hash`, `intent_count`), in the same transaction
 * as the intent row, and verification compares the recomputed head and count
 * against that anchor. Dropping the newest row(s) now leaves an anchor that
 * names a hash no remaining row carries, and the chain reports NOT intact.
 * The anchor is the only thing the walk cannot recompute from the rows, which
 * is exactly why it has to live somewhere else.
 *
 * A mission recorded before the anchor existed carries NULL in both columns.
 * Its chain is reported as verified-but-UNANCHORED: the forward walk still
 * runs and still catches an edit, a reorder or a middle deletion, but a tail
 * truncation is undetectable for that row until its next append anchors it.
 * Nothing backfills an anchor from the rows that happen to be present at
 * upgrade time, because that would bless whatever truncation may already have
 * happened. The verdict says which case it is, and the view publishes both
 * bits so no UI can read "unanchored" as "intact".
 *
 * ## The UPDATEs in this file, all of them
 *
 * `recordTransition` writes `state`/`block_reason`/`updated_at` together with
 * the event row that explains them; `appendIntent` writes the two anchor
 * columns together with the intent row they anchor. No other UPDATE exists,
 * and neither touches the other's columns.
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import type { ActorAuthentication } from '../live/local-trust.js';
import type { DirectOrderRoute } from '../live/orders.js';
import {
  isMissionState,
  isRecordedMissionEdgeLegal,
  MISSION_STATES,
  NEEDS_CLARIFICATION_REASON,
  type MissionState,
} from './states.js';
import type { IntentUnknown } from './intent.js';

/** The most missions a list read returns. Newest first; the rest are still in the table. */
export const MAX_MISSIONS_LISTED = 50;

export interface MissionRecord {
  id: string;
  idempotencyKey: string;
  title: string;
  project: string | null;
  state: MissionState;
  blockReason: string | null;
  requestedBy: string;
  actorAuthentication: ActorAuthentication;
  requestedRoute: DirectOrderRoute;
  createdAt: string;
  updatedAt: string;
  /**
   * The intent chain's anchored head — the hash of the newest intent row —
   * and how many rows the chain held when it was written. Both null for a
   * mission recorded before the anchor existed. See the module docstring.
   */
  intentHeadHash: string | null;
  intentCount: number | null;
}

export type IntentKind = 'original' | 'amendment';

/**
 * What `intentChainVerdict` can say about a mission's intent chain.
 *
 * `intact` is the answer a caller that wants one bit should read.
 * `anchored` says whether that bit covers tail truncation: false means the
 * mission row carries no head to compare against, so the forward walk is all
 * the verification there is. `reason` names the first failure found, so a
 * report can say WHAT is wrong rather than only that something is.
 */
export interface IntentChainVerdict {
  intact: boolean;
  anchored: boolean;
  reason:
    | null
    | 'unknown_mission'
    | 'link_broken'
    | 'row_rehashed'
    | 'head_mismatch'
    | 'count_mismatch';
}

export interface IntentRecord {
  seq: number;
  id: string;
  missionId: string;
  kind: IntentKind;
  /** The Founder's words. SERVER-SIDE ONLY — no projection publishes it. */
  command: string;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  unknowns: IntentUnknown[];
  needsClarification: boolean;
  stepCount: number;
  actor: string;
  actorAuthentication: ActorAuthentication;
  reason: string | null;
  at: string;
  prevHash: string;
  hash: string;
}

export interface MissionTaskLink {
  missionId: string;
  taskId: string;
  ordinal: number;
  intentId: string;
}

export interface MissionEvent {
  seq: number;
  id: string;
  missionId: string;
  fromState: MissionState | null;
  toState: MissionState;
  actor: string;
  reason: string | null;
  at: string;
}

/** The chain's genesis value. Same convention as the evidence log. */
const GENESIS_HASH = '0'.repeat(64);

function intentHash(prevHash: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(prevHash).update(canonicalJson(body)).digest('hex');
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export class MissionStore {
  readonly #db: HqDatabase;

  constructor(db: HqDatabase) {
    this.#db = db;
  }

  /* ---------------------------------------------------------------- */
  /* Missions                                                          */
  /* ---------------------------------------------------------------- */

  insertMission(input: {
    id: string;
    idempotencyKey: string;
    title: string;
    project: string | null;
    state: MissionState;
    blockReason: string | null;
    requestedBy: string;
    actorAuthentication: ActorAuthentication;
    requestedRoute: DirectOrderRoute;
    at: string;
  }): MissionRecord {
    // Anchored from birth: the chain of nothing has the genesis value as its
    // head and zero rows. Only a row that predates the anchor columns is ever
    // unanchored (NULL), so "unanchored" always means "upgraded in place",
    // never "freshly inserted by this code".
    this.#db
      .prepare(
        `INSERT INTO hq_missions
           (id, idempotency_key, title, project, state, block_reason, requested_by,
            actor_authentication, requested_route, created_at, updated_at,
            intent_head_hash, intent_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        input.id,
        input.idempotencyKey,
        input.title,
        input.project,
        input.state,
        input.blockReason,
        input.requestedBy,
        input.actorAuthentication,
        input.requestedRoute,
        input.at,
        input.at,
        GENESIS_HASH,
      );
    return this.getMission(input.id)!;
  }

  getMission(id: string): MissionRecord | null {
    const row = this.#db.prepare(`SELECT * FROM hq_missions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toMission(row) : null;
  }

  findByIdempotencyKey(key: string): MissionRecord | null {
    const row = this.#db.prepare(`SELECT * FROM hq_missions WHERE idempotency_key = ?`).get(key) as
      | Record<string, unknown>
      | undefined;
    return row ? toMission(row) : null;
  }

  /** Newest first, bounded. `countMissions` says how many exist in total. */
  listMissions(limit: number = MAX_MISSIONS_LISTED): MissionRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM hq_missions ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(Math.max(0, limit)) as Record<string, unknown>[];
    return rows.map(toMission);
  }

  countMissions(): number {
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM hq_missions`).get() as { n: number };
    return row.n;
  }

  /**
   * Store-wide tallies by recorded state, plus the clarification-blocked
   * subset — ONE query over every row, never a count over a listed window
   * (Opus second pass on `a849af8`, P1).
   *
   * Why this exists: `listMissions` is bounded to `MAX_MISSIONS_LISTED`, and
   * the attention counts the rooms light on were being taken over that window.
   * With 55 missions of which the 5 oldest were blocked, the list route
   * reported `blocked: 0`, the Command Room said nothing needed attention, and
   * the Mission Room sat quiet — five blocked missions were in the store and
   * none of them was in the window. A count that is a fact about the recorded
   * `state` column does not need the projection at all, so it is taken from
   * the column, across every row, and can be believed regardless of how many
   * missions the list carries.
   *
   * The clarification subset is decided EXACTLY as `missionView` decides
   * `needsClarification`: recorded `blocked` with a block reason that begins
   * with the reserved prefix. `substr` rather than `LIKE`, because the prefix
   * contains an underscore, which `LIKE` would read as a wildcard.
   */
  countMissionsByState(): { byState: Record<MissionState, number>; needsClarification: number } {
    const byState = {} as Record<MissionState, number>;
    for (const state of MISSION_STATES) byState[state] = 0;
    const rows = this.#db
      .prepare(`SELECT state, COUNT(*) AS n FROM hq_missions GROUP BY state`)
      .all() as { state: string; n: number }[];
    for (const row of rows) {
      if (isMissionState(row.state)) byState[row.state] = row.n;
    }
    const clarification = this.#db
      .prepare(
        `SELECT COUNT(*) AS n FROM hq_missions
         WHERE state = 'blocked' AND substr(block_reason, 1, length(?)) = ?`,
      )
      .get(NEEDS_CLARIFICATION_REASON, NEEDS_CLARIFICATION_REASON) as { n: number };
    return { byState, needsClarification: clarification.n };
  }

  /**
   * Moves the mission's current state and appends the history row that
   * explains it, together. The caller has already decided the transition is
   * right; this method records, it does not decide.
   *
   * It does REFUSE, though, to write an edge the history is not allowed to
   * hold (`isRecordedMissionEdgeLegal`: genesis, a table edge, or the one
   * documented `blocked → blocked` reason refresh). The mutation-testing pass
   * on `b3f72d1` found that this method never consulted the table at all,
   * while the table's test asserted "never a self-edge": a future caller
   * could have written `working → working` and nothing would have said no.
   * Every present caller checks the table first, so this throw is unreachable
   * from them; it exists for the caller that does not.
   */
  recordTransition(input: {
    missionId: string;
    fromState: MissionState | null;
    toState: MissionState;
    blockReason: string | null;
    actor: string;
    reason: string | null;
    at?: string;
  }): MissionEvent {
    if (!isRecordedMissionEdgeLegal(input.fromState, input.toState)) {
      throw new Error(
        `Refusing to record mission history edge ${String(input.fromState)} -> ${input.toState}: ` +
          'not a table edge, not genesis, and not the documented blocked -> blocked reason refresh.',
      );
    }
    const at = input.at ?? nowIso();
    const id = uuid();
    this.#db
      .prepare(`UPDATE hq_missions SET state = ?, block_reason = ?, updated_at = ? WHERE id = ?`)
      .run(input.toState, input.blockReason, at, input.missionId);
    this.#db
      .prepare(
        `INSERT INTO hq_mission_events (id, mission_id, from_state, to_state, actor, reason, at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.missionId, input.fromState, input.toState, input.actor, input.reason, at);
    return this.listEvents(input.missionId).find((event) => event.id === id)!;
  }

  listEvents(missionId: string): MissionEvent[] {
    const rows = this.#db
      .prepare(`SELECT * FROM hq_mission_events WHERE mission_id = ? ORDER BY seq`)
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      seq: row.seq as number,
      id: row.id as string,
      missionId: row.mission_id as string,
      fromState: isMissionState(row.from_state) ? row.from_state : null,
      toState: row.to_state as MissionState,
      actor: row.actor as string,
      reason: (row.reason as string | null) ?? null,
      at: row.at as string,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* Intent lock                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * APPEND. The previous row's hash is read and chained; nothing is
   * overwritten. The new row's hash and the new row count are then written to
   * the mission row as the chain's anchored head — see the module docstring
   * for why a chain without one cannot see its own tail go missing.
   */
  appendIntent(input: {
    missionId: string;
    kind: IntentKind;
    command: string;
    objective: string;
    constraints: string[];
    acceptanceCriteria: string[];
    unknowns: IntentUnknown[];
    needsClarification: boolean;
    stepCount: number;
    actor: string;
    actorAuthentication: ActorAuthentication;
    reason: string | null;
    at?: string;
  }): IntentRecord {
    const at = input.at ?? nowIso();
    const id = uuid();
    const last = this.#db
      .prepare(`SELECT hash FROM hq_mission_intent WHERE mission_id = ? ORDER BY seq DESC LIMIT 1`)
      .get(input.missionId) as { hash: string } | undefined;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const body = {
      id,
      missionId: input.missionId,
      kind: input.kind,
      command: input.command,
      objective: input.objective,
      constraints: input.constraints,
      acceptanceCriteria: input.acceptanceCriteria,
      unknowns: input.unknowns,
      needsClarification: input.needsClarification,
      stepCount: input.stepCount,
      actor: input.actor,
      actorAuthentication: input.actorAuthentication,
      reason: input.reason,
      at,
    };
    const hash = intentHash(prevHash, body);
    this.#db
      .prepare(
        `INSERT INTO hq_mission_intent
           (id, mission_id, kind, command, objective, constraints, acceptance_criteria, unknowns,
            needs_clarification, step_count, actor, actor_authentication, reason, at, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.missionId,
        input.kind,
        input.command,
        input.objective,
        JSON.stringify(input.constraints),
        JSON.stringify(input.acceptanceCriteria),
        JSON.stringify(input.unknowns),
        input.needsClarification ? 1 : 0,
        input.stepCount,
        input.actor,
        input.actorAuthentication,
        input.reason,
        at,
        prevHash,
        hash,
      );
    // The anchor. Counted from the table rather than incremented from the
    // previous anchor, so a legacy (NULL) anchor becomes a correct one on the
    // first append after the upgrade instead of NULL + 1.
    const count = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM hq_mission_intent WHERE mission_id = ?`)
      .get(input.missionId) as { n: number };
    this.#db
      .prepare(`UPDATE hq_missions SET intent_head_hash = ?, intent_count = ? WHERE id = ?`)
      .run(hash, count.n, input.missionId);
    return this.listIntent(input.missionId).find((record) => record.id === id)!;
  }

  /** Oldest first: the original order is always element 0. */
  listIntent(missionId: string): IntentRecord[] {
    const rows = this.#db
      .prepare(`SELECT * FROM hq_mission_intent WHERE mission_id = ? ORDER BY seq`)
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      seq: row.seq as number,
      id: row.id as string,
      missionId: row.mission_id as string,
      kind: row.kind as IntentKind,
      command: row.command as string,
      objective: row.objective as string,
      constraints: parseJsonArray<string>(row.constraints),
      acceptanceCriteria: parseJsonArray<string>(row.acceptance_criteria),
      unknowns: parseJsonArray<IntentUnknown>(row.unknowns),
      needsClarification: !!row.needs_clarification,
      stepCount: row.step_count as number,
      actor: row.actor as string,
      actorAuthentication: row.actor_authentication as ActorAuthentication,
      reason: (row.reason as string | null) ?? null,
      at: row.at as string,
      prevHash: row.prev_hash as string,
      hash: row.hash as string,
    }));
  }

  /**
   * Recompute the chain from genesis, then compare its head and length
   * against the anchor on the mission row. The one-bit form of
   * `intentChainVerdict`: false means an edit, a reordering, a deletion
   * ANYWHERE — the tail included, now that there is an anchor — or an
   * insertion out of order. For a mission with no anchor (recorded before
   * anchoring existed) the tail is the one thing this cannot see; read
   * `intentChainVerdict(...).anchored` to know whether that caveat applies.
   */
  verifyIntentChain(missionId: string): boolean {
    return this.intentChainVerdict(missionId).intact;
  }

  /**
   * The full verdict. Order of checks, and why: the forward walk first, so a
   * rehashed or middle-deleted row is named as such rather than showing up
   * only as a head mismatch; then the anchor, which is the only check that
   * can see a truncated tail.
   *
   * The count is compared as well as the head. The head alone would already
   * catch a dropped tail (the anchor names a hash no remaining row has), but
   * the count is cheap, it names a distinct failure, and it is a second fact
   * an attacker with raw access has to get right at the same time.
   */
  intentChainVerdict(missionId: string): IntentChainVerdict {
    const mission = this.getMission(missionId);
    if (!mission) return { intact: false, anchored: false, reason: 'unknown_mission' };
    const anchored = mission.intentHeadHash !== null && mission.intentCount !== null;
    let prev = GENESIS_HASH;
    let count = 0;
    for (const record of this.listIntent(missionId)) {
      if (record.prevHash !== prev) return { intact: false, anchored, reason: 'link_broken' };
      const expected = intentHash(prev, {
        id: record.id,
        missionId: record.missionId,
        kind: record.kind,
        command: record.command,
        objective: record.objective,
        constraints: record.constraints,
        acceptanceCriteria: record.acceptanceCriteria,
        unknowns: record.unknowns,
        needsClarification: record.needsClarification,
        stepCount: record.stepCount,
        actor: record.actor,
        actorAuthentication: record.actorAuthentication,
        reason: record.reason,
        at: record.at,
      });
      if (expected !== record.hash) return { intact: false, anchored, reason: 'row_rehashed' };
      prev = record.hash;
      count += 1;
    }
    if (!anchored) {
      // Verified as far as a forward walk can verify. Not a failure — a
      // mission upgraded in place has done nothing wrong — but not the full
      // check either, and the verdict says so rather than rounding up.
      return { intact: true, anchored: false, reason: null };
    }
    if (prev !== mission.intentHeadHash) return { intact: false, anchored: true, reason: 'head_mismatch' };
    if (count !== mission.intentCount) return { intact: false, anchored: true, reason: 'count_mismatch' };
    return { intact: true, anchored: true, reason: null };
  }

  /* ---------------------------------------------------------------- */
  /* Task links                                                        */
  /* ---------------------------------------------------------------- */

  /** Record that a canonical task belongs to a mission's plan. No task state is copied. */
  linkTask(link: MissionTaskLink): void {
    this.#db
      .prepare(
        `INSERT INTO hq_mission_tasks (mission_id, task_id, ordinal, intent_id) VALUES (?, ?, ?, ?)`,
      )
      .run(link.missionId, link.taskId, link.ordinal, link.intentId);
  }

  listTaskLinks(missionId: string): MissionTaskLink[] {
    const rows = this.#db
      .prepare(`SELECT * FROM hq_mission_tasks WHERE mission_id = ? ORDER BY ordinal`)
      .all(missionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      missionId: row.mission_id as string,
      taskId: row.task_id as string,
      ordinal: row.ordinal as number,
      intentId: row.intent_id as string,
    }));
  }
}

function toMission(row: Record<string, unknown>): MissionRecord {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    title: row.title as string,
    project: (row.project as string | null) ?? null,
    state: row.state as MissionState,
    blockReason: (row.block_reason as string | null) ?? null,
    requestedBy: row.requested_by as string,
    actorAuthentication: row.actor_authentication as ActorAuthentication,
    requestedRoute: row.requested_route as DirectOrderRoute,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    intentHeadHash: typeof row.intent_head_hash === 'string' ? row.intent_head_hash : null,
    intentCount: typeof row.intent_count === 'number' ? row.intent_count : null,
  };
}
