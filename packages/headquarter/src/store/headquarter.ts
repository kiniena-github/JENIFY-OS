/**
 * Headquarter backend store — the data layer behind the seven HQ modules.
 * UI presentation on top of these read models is Jules-owned (issue #43).
 */

import { v4 as uuid } from 'uuid';
import type { HqDatabase } from './db.js';
import { nowIso } from './db.js';
import {
  isActivityStatus,
  type ActivityEvent,
  type NewActivityEvent,
} from '../contracts/events.js';
import type {
  ApprovalRequest,
  ArchiveRef,
  ChatMessage,
  CommandCenterItem,
  CommandCenterLane,
  CommandCenterSnapshot,
  ProjectRecord,
} from '../contracts/modules.js';
import type { WorkerDescriptor } from '../contracts/workers.js';

export class HeadquarterStore {
  constructor(private db: HqDatabase) {}

  // ---- canonical event log ----

  appendEvent(event: NewActivityEvent): ActivityEvent {
    if (event.status !== null && !isActivityStatus(event.status)) {
      throw new Error(`Unknown activity status: ${event.status}`);
    }
    const id = uuid();
    const at = nowIso();
    const res = this.db
      .prepare(
        `INSERT INTO hq_events (id, at, subject_kind, subject_id, status, actor, summary, detail, refs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        at,
        event.subjectKind,
        event.subjectId,
        event.status,
        event.actor,
        event.summary,
        event.detail ? JSON.stringify(event.detail) : null,
        event.refs ? JSON.stringify(event.refs) : null,
      );
    return { ...event, id, at, seq: Number(res.lastInsertRowid) };
  }

  eventsFor(subjectKind: string, subjectId: string): ActivityEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM hq_events WHERE subject_kind = ? AND subject_id = ? ORDER BY seq`)
      .all(subjectKind, subjectId) as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  /** Latest event per subject — the basis of every status dashboard. */
  latestStatusPerSubject(): ActivityEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM hq_events e
         JOIN (SELECT subject_kind, subject_id, MAX(seq) AS seq FROM hq_events
               WHERE status IS NOT NULL GROUP BY subject_kind, subject_id) latest
           ON latest.seq = e.seq
         ORDER BY e.seq DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map(rowToEvent);
  }

  // ---- Command Center read model ----

  /**
   * Lane mapping from canonical statuses (the one Jules's dashboard binds to):
   * NOW = running/assigned, DONE TODAY = completed today,
   * BLOCKED = blocked/review_failed/outcome_unknown,
   * WAITING FOR FOUNDER = needs_approval, NEXT = queued.
   */
  commandCenterSnapshot(now: Date = new Date()): CommandCenterSnapshot {
    const lanes: Record<CommandCenterLane, CommandCenterItem[]> = {
      now: [],
      done_today: [],
      blocked: [],
      waiting_for_founder: [],
      next: [],
    };
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    for (const e of this.latestStatusPerSubject()) {
      const item: CommandCenterItem = {
        subjectKind: e.subjectKind,
        subjectId: e.subjectId,
        status: e.status!,
        summary: e.summary,
        actor: e.actor,
        at: e.at,
      };
      switch (e.status) {
        case 'running':
        case 'assigned':
          lanes.now.push(item);
          break;
        case 'completed':
        case 'review_passed':
          if (e.at >= dayStart) lanes.done_today.push(item);
          break;
        case 'blocked':
        case 'review_failed':
        case 'outcome_unknown':
          lanes.blocked.push(item);
          break;
        case 'needs_approval':
          lanes.waiting_for_founder.push(item);
          break;
        case 'queued':
          lanes.next.push(item);
          break;
      }
    }
    return { generatedAt: nowIso(), lanes };
  }

  // ---- Projects ----

  upsertProject(p: Omit<ProjectRecord, 'createdAt' | 'updatedAt'>): ProjectRecord {
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO hq_projects (id, name, stream, summary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, stream = excluded.stream,
           summary = excluded.summary, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(p.id, p.name, p.stream, p.summary, p.status, at, at);
    return this.getProject(p.id)!;
  }

  getProject(id: string): ProjectRecord | null {
    const r = this.db.prepare(`SELECT * FROM hq_projects WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      name: r.name as string,
      stream: r.stream as string,
      summary: r.summary as string,
      status: r.status as string,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
    };
  }

  listProjects(): ProjectRecord[] {
    const rows = this.db.prepare(`SELECT id FROM hq_projects ORDER BY name`).all() as { id: string }[];
    return rows.map((r) => this.getProject(r.id)!);
  }

  // ---- Founder Approval Center ----

  requestApproval(req: {
    taskId?: string | null;
    projectId?: string | null;
    ask: string;
    riskClass: string;
    requestedBy: string;
  }): ApprovalRequest {
    const id = uuid();
    this.db
      .prepare(
        `INSERT INTO hq_approvals (id, task_id, project_id, ask, risk_class, requested_by, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, req.taskId ?? null, req.projectId ?? null, req.ask, req.riskClass, req.requestedBy, nowIso());
    return this.getApproval(id)!;
  }

  decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    note: string | null,
    decidedBy = 'founder',
  ): ApprovalRequest {
    const existing = this.getApproval(id);
    if (!existing) throw new Error(`Unknown approval: ${id}`);
    if (existing.decision !== 'pending') throw new Error(`Approval ${id} already decided`);
    if (decision === 'denied' && !note) throw new Error('A denial requires a decision note');
    if (decidedBy === existing.requestedBy || decidedBy === 'system') {
      throw new Error(`Actor ${decidedBy} cannot decide an approval it requested itself`);
    }
    this.db
      .prepare(
        `UPDATE hq_approvals SET decision = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?`,
      )
      .run(decision, nowIso(), decidedBy, note, id);
    return this.getApproval(id)!;
  }

  getApproval(id: string): ApprovalRequest | null {
    const r = this.db.prepare(`SELECT * FROM hq_approvals WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      taskId: (r.task_id as string | null) ?? null,
      projectId: (r.project_id as string | null) ?? null,
      ask: r.ask as string,
      riskClass: r.risk_class as string,
      requestedBy: r.requested_by as string,
      requestedAt: r.requested_at as string,
      decision: r.decision as ApprovalRequest['decision'],
      decidedAt: (r.decided_at as string | null) ?? null,
      decidedBy: (r.decided_by as string | null) ?? null,
      decisionNote: (r.decision_note as string | null) ?? null,
      actionDigest: (r.action_digest as string | null) ?? null,
      expiresAt: (r.expires_at as string | null) ?? null,
      consumedAt: (r.consumed_at as string | null) ?? null,
      consumedBy: (r.consumed_by as string | null) ?? null,
      consumedTaskId: (r.consumed_task_id as string | null) ?? null,
      consumedFence: (r.consumed_fence as number | null) ?? null,
      consumedClaimNonce: (r.consumed_claim_nonce as string | null) ?? null,
    };
  }

  pendingApprovals(): ApprovalRequest[] {
    const rows = this.db
      .prepare(`SELECT id FROM hq_approvals WHERE decision = 'pending' ORDER BY requested_at`)
      .all() as { id: string }[];
    return rows.map((r) => this.getApproval(r.id)!);
  }

  // ---- Executive Room / Direct Chats ----

  postMessage(msg: { threadId: string; author: string; body: string; refs?: string[] }): ChatMessage {
    const id = uuid();
    const at = nowIso();
    this.db
      .prepare(
        `INSERT INTO hq_chat_messages (id, thread_id, author, at, body, refs) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, msg.threadId, msg.author, at, msg.body, msg.refs ? JSON.stringify(msg.refs) : null);
    return { id, threadId: msg.threadId, author: msg.author, at, body: msg.body, refs: msg.refs };
  }

  thread(threadId: string): ChatMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM hq_chat_messages WHERE thread_id = ? ORDER BY at, id`)
      .all(threadId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      threadId: r.thread_id as string,
      author: r.author as string,
      at: r.at as string,
      body: r.body as string,
      refs: r.refs ? JSON.parse(r.refs as string) : undefined,
    }));
  }

  // ---- Specialist Directory ----

  upsertSpecialist(w: WorkerDescriptor): void {
    this.db
      .prepare(
        `INSERT INTO hq_specialists (id, display_name, vendor, role, allowed_capabilities, active)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, vendor = excluded.vendor,
           role = excluded.role, allowed_capabilities = excluded.allowed_capabilities, active = excluded.active`,
      )
      .run(w.id, w.displayName, w.vendor, w.role, JSON.stringify(w.allowedCapabilities), w.active ? 1 : 0);
  }

  getSpecialist(id: string): WorkerDescriptor | null {
    const r = this.db.prepare(`SELECT * FROM hq_specialists WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      displayName: r.display_name as string,
      vendor: r.vendor as string,
      role: r.role as WorkerDescriptor['role'],
      allowedCapabilities: JSON.parse(r.allowed_capabilities as string),
      active: !!r.active,
    };
  }

  listSpecialists(): WorkerDescriptor[] {
    const rows = this.db.prepare(`SELECT id FROM hq_specialists ORDER BY id`).all() as { id: string }[];
    return rows.map((r) => this.getSpecialist(r.id)!);
  }

  // ---- Archive/Knowledge references ----

  addArchiveRef(ref: { title: string; locator: string; projectId?: string | null }): ArchiveRef {
    const id = uuid();
    const at = nowIso();
    this.db
      .prepare(`INSERT INTO hq_archive_refs (id, title, locator, project_id, added_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, ref.title, ref.locator, ref.projectId ?? null, at);
    return { id, title: ref.title, locator: ref.locator, projectId: ref.projectId ?? null, addedAt: at };
  }

  listArchiveRefs(projectId?: string): ArchiveRef[] {
    const rows = (
      projectId
        ? this.db.prepare(`SELECT * FROM hq_archive_refs WHERE project_id = ? ORDER BY added_at`).all(projectId)
        : this.db.prepare(`SELECT * FROM hq_archive_refs ORDER BY added_at`).all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      title: r.title as string,
      locator: r.locator as string,
      projectId: (r.project_id as string | null) ?? null,
      addedAt: r.added_at as string,
    }));
  }
}

function rowToEvent(r: Record<string, unknown>): ActivityEvent {
  return {
    id: r.id as string,
    seq: r.seq as number,
    at: r.at as string,
    subjectKind: r.subject_kind as ActivityEvent['subjectKind'],
    subjectId: r.subject_id as string,
    status: (r.status as ActivityEvent['status']) ?? null,
    actor: r.actor as string,
    summary: r.summary as string,
    detail: r.detail ? JSON.parse(r.detail as string) : undefined,
    refs: r.refs ? JSON.parse(r.refs as string) : undefined,
  };
}
