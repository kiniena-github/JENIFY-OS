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
 * row breaks every hash after it and `verifyIntentChain` reports it. The
 * mission row's `state`/`block_reason`/`updated_at` are the only columns any
 * UPDATE in this file touches, and only through `recordTransition`, which
 * writes the event in the same statement sequence.
 */

import { createHash } from 'node:crypto';
import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import { canonicalJson } from '../operator/approvals.js';
import type { ActorAuthentication } from '../live/local-trust.js';
import type { DirectOrderRoute } from '../live/orders.js';
import { isMissionState, type MissionState } from './states.js';
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
}

export type IntentKind = 'original' | 'amendment';

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
    this.#db
      .prepare(
        `INSERT INTO hq_missions
           (id, idempotency_key, title, project, state, block_reason, requested_by,
            actor_authentication, requested_route, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
   * The ONLY update in this module. Moves the mission's current state and
   * appends the history row that explains it, together. The caller has
   * already asserted the transition is legal; this method records, it does
   * not decide.
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

  /** APPEND. The previous row's hash is read and chained; nothing is overwritten. */
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
   * Recompute the chain from genesis and compare. False means a historical
   * row no longer hashes to what the row after it was chained to — an edit,
   * a deletion, or an insertion out of order.
   */
  verifyIntentChain(missionId: string): boolean {
    let prev = GENESIS_HASH;
    for (const record of this.listIntent(missionId)) {
      if (record.prevHash !== prev) return false;
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
      if (expected !== record.hash) return false;
      prev = record.hash;
    }
    return true;
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
  };
}
