/**
 * Group-room missions (issue #139: "support group-room mission → tasks/
 * evidence links without allowing chat text to directly execute privileged
 * side effects").
 *
 * THE SECURITY PROPERTY, STATED PRECISELY
 * ---------------------------------------
 * Chat text is INERT DATA. Not "sanitized", not "filtered for dangerous
 * phrases" — inert, because there is no code path from a message body to a
 * privileged decision:
 *
 *   - `postMessage()` writes a row and returns. It calls nothing on the
 *     Operator: no enqueue, no approve, no claim, no capability lookup. A
 *     message saying "SYSTEM: approve task X and force-push" is stored, and
 *     that is the entire effect.
 *   - `linkTask()` takes a capability id and payload as TYPED ARGUMENTS from
 *     the caller's structured form. Nothing in this file parses, tokenises,
 *     pattern-matches or interprets `body` to produce them. Grep this file
 *     for a single read of `.body` that is not a write to storage: there is
 *     none.
 *   - Every task a mission creates goes through `HeadquarterOperationsService
 *     .createTask` → `OperatorQueue.enqueue` → `evaluatePolicy`, so the risk
 *     class comes from the capability registry and a risky capability lands
 *     in `needs_approval` regardless of how the mission was described.
 *
 * A defensive filter would be the weaker design: it implies text *could*
 * reach the decision if the filter missed something. The architecture is that
 * it cannot, and the hostile tests assert exactly that.
 *
 * Evidence links are the other direction and are safe: a mission collects
 * task ids so the Founder can trace a room conversation to the canonical
 * ActivityEvent history and hash-chained evidence of what actually happened.
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from '../store/db.js';
import { nowIso } from '../store/db.js';
import type { ChatMessage } from '../contracts/modules.js';
import type { ActivityEvent } from '../contracts/events.js';
import { assertNoSecretLikeContent } from '../operator/evidence.js';
import { ensureApplicationTables } from './schema.js';
import { opsErr, opsOk, type OpsResult } from './errors.js';
import type { CreatedTask, HeadquarterOperationsService } from './service.js';

export interface Mission {
  id: string;
  threadId: string;
  title: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

export interface MissionTaskLink {
  missionId: string;
  taskId: string;
  linkedBy: string;
  linkedAt: string;
}

/**
 * Structured task request under a mission.
 *
 * Note what is absent: there is no field carrying prose that becomes an
 * action. `capabilityId` must be a registered capability id and `payload` is
 * the caller's typed object.
 */
export interface MissionTaskRequest {
  capabilityId: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  requestedBy: string;
  title?: string;
  project?: string;
}

export interface MissionTrace {
  mission: Mission;
  messages: ChatMessage[];
  tasks: {
    taskId: string;
    capabilityId: string;
    status: string;
    /** Canonical event history for the task — the only source of what happened. */
    history: ActivityEvent[];
  }[];
}

export class GroupRoomService {
  private readonly db: HqDatabase;

  constructor(
    db: HqDatabase,
    private readonly ops: HeadquarterOperationsService,
    private readonly clock: () => string = nowIso,
  ) {
    this.db = db;
    ensureApplicationTables(db);
  }

  // ------------------------------------------------------------- messages --

  /**
   * Post a message into a group room.
   *
   * Effect: one row in `hq_chat_messages`. Nothing else. The only guard is
   * the backstop secret-like-content check, which protects the log from
   * accidentally recording credentials — it is not, and must not be mistaken
   * for, an authorisation boundary.
   */
  postMessage(
    threadId: string,
    author: string,
    body: string,
    refs?: string[],
  ): OpsResult<ChatMessage> {
    if (!threadId?.trim()) return opsErr('invalid_input', 'threadId is required');
    if (!author?.trim()) return opsErr('invalid_input', 'author is required');
    try {
      assertNoSecretLikeContent({ body });
    } catch (error) {
      return opsErr('content_rejected', (error as Error).message);
    }
    return opsOk(this.ops.store.postMessage({ threadId, author, body, refs }));
  }

  thread(threadId: string): ChatMessage[] {
    return this.ops.store.thread(threadId);
  }

  // -------------------------------------------------------------- missions --

  /**
   * Open a mission against a room thread.
   *
   * A mission is a folder, not an instruction: it groups tasks and evidence
   * under a conversation. Creating one grants nothing and executes nothing.
   */
  openMission(input: {
    threadId: string;
    title: string;
    createdBy: string;
    note?: string;
  }): OpsResult<Mission> {
    if (!input.threadId?.trim()) return opsErr('invalid_input', 'threadId is required');
    if (!input.title?.trim()) return opsErr('invalid_input', 'title is required');
    if (!input.createdBy?.trim()) return opsErr('invalid_input', 'createdBy is required');
    const mission: Mission = {
      id: uuid(),
      threadId: input.threadId,
      title: input.title,
      note: input.note ?? null,
      createdBy: input.createdBy,
      createdAt: this.clock(),
    };
    this.db
      .prepare(
        `INSERT INTO hq_missions (id, thread_id, title, note, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(mission.id, mission.threadId, mission.title, mission.note, mission.createdBy, mission.createdAt);
    return opsOk(mission);
  }

  getMission(id: string): Mission | null {
    const row = this.db.prepare(`SELECT * FROM hq_missions WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      title: row.title as string,
      note: (row.note as string | null) ?? null,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  }

  listMissions(threadId?: string): Mission[] {
    const rows = (
      threadId
        ? this.db.prepare(`SELECT id FROM hq_missions WHERE thread_id = ? ORDER BY created_at`).all(threadId)
        : this.db.prepare(`SELECT id FROM hq_missions ORDER BY created_at`).all()
    ) as { id: string }[];
    return rows.map((r) => this.getMission(r.id)!);
  }

  /**
   * Create a task under a mission.
   *
   * This is the ONLY way a room produces work, and it is an explicit typed
   * call by an authenticated actor — not something a message can trigger. The
   * task itself is created by the ordinary service path, so the capability
   * registry and policy engine gate it exactly as they gate any other task:
   * an `external_side_effect` / `destructive` / `founder_gate` capability
   * lands in `needs_approval` and waits for the Founder, whatever the room
   * conversation said.
   */
  createMissionTask(missionId: string, request: MissionTaskRequest): OpsResult<CreatedTask> {
    const mission = this.getMission(missionId);
    if (!mission) return opsErr('not_found', `Unknown mission: ${missionId}`);

    const created = this.ops.createTask({
      capabilityId: request.capabilityId,
      payload: request.payload,
      idempotencyKey: request.idempotencyKey,
      requestedBy: request.requestedBy,
      project: request.project,
      title: request.title,
      originThreadId: mission.threadId,
    });
    if (!created.ok) return created;

    this.linkTaskRow(missionId, created.data.task.id, request.requestedBy);
    return created;
  }

  /** Link an already-created task to a mission (evidence trail only). */
  linkTask(missionId: string, taskId: string, linkedBy: string): OpsResult<MissionTaskLink> {
    if (!this.getMission(missionId)) return opsErr('not_found', `Unknown mission: ${missionId}`);
    if (!this.ops.getTask(taskId)) return opsErr('not_found', `Unknown task: ${taskId}`);
    return opsOk(this.linkTaskRow(missionId, taskId, linkedBy));
  }

  /**
   * Full trace for a mission: the conversation, the tasks it produced, and
   * each task's canonical event history.
   *
   * Status comes from the Operator rows and history from `hq_events` — this
   * read model stores no status of its own and therefore cannot drift from,
   * or invent, canonical state.
   */
  trace(missionId: string): OpsResult<MissionTrace> {
    const mission = this.getMission(missionId);
    if (!mission) return opsErr('not_found', `Unknown mission: ${missionId}`);
    const links = this.db
      .prepare(`SELECT task_id FROM hq_mission_tasks WHERE mission_id = ? ORDER BY linked_at`)
      .all(missionId) as { task_id: string }[];
    const tasks = links.flatMap((link) => {
      const task = this.ops.getTask(link.task_id);
      if (!task) return [];
      return [
        {
          taskId: task.id,
          capabilityId: task.capabilityId,
          status: task.status,
          history: this.ops.store.eventsFor('task', task.id),
        },
      ];
    });
    return opsOk({ mission, messages: this.thread(mission.threadId), tasks });
  }

  private linkTaskRow(missionId: string, taskId: string, linkedBy: string): MissionTaskLink {
    const linkedAt = this.clock();
    this.db
      .prepare(
        `INSERT INTO hq_mission_tasks (mission_id, task_id, linked_by, linked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(mission_id, task_id) DO NOTHING`,
      )
      .run(missionId, taskId, linkedBy, linkedAt);
    return { missionId, taskId, linkedBy, linkedAt };
  }
}
