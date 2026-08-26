/**
 * Headquarter information architecture — the seven core modules (war room
 * #41, order C) and the data contracts their read models are built from.
 *
 * Ownership split (issues #42/#43): this package owns the contracts and the
 * backend store; Jules owns the UI presentation built on top of them.
 */

export const HQ_MODULES = [
  'command_center',
  'projects',
  'executive_room',
  'direct_chats',
  'specialist_directory',
  'founder_approvals',
  'archive_knowledge',
] as const;

export type HqModule = (typeof HQ_MODULES)[number];

/** Command Center lanes — the Founder's five-question dashboard (issue #43). */
export const COMMAND_CENTER_LANES = [
  'now',
  'done_today',
  'blocked',
  'waiting_for_founder',
  'next',
] as const;

export type CommandCenterLane = (typeof COMMAND_CENTER_LANES)[number];

export interface ProjectRecord {
  id: string;
  name: string;
  /** e.g. 'jenify-os', 'qos', 'jenify-news', 'company-infra'. */
  stream: string;
  summary: string;
  /** Canonical activity status of the project as a whole. */
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  taskId: string | null;
  projectId: string | null;
  /** What the Founder is being asked to approve, in plain language. */
  ask: string;
  /** Risk class from the capability registry that forced this gate. */
  riskClass: string;
  requestedBy: string;
  requestedAt: string;
  decision: 'pending' | 'approved' | 'denied';
  decidedAt: string | null;
  /** Founder's note; required on deny. */
  decisionNote: string | null;
}

export interface ChatMessage {
  id: string;
  /** Thread id: 'executive-room' or 'dm:<workerId>'. */
  threadId: string;
  author: string;
  at: string;
  body: string;
  refs?: string[];
}

/**
 * Archive/Knowledge reference record. The full historical metadata schema
 * (year/month/project/category, CURRENT/SUPERSEDED/… lifecycle,
 * predecessor/successor links, inferred-date confidence) is Jules-owned per
 * issue #43; Headquarter core only stores stable references into it so the
 * two implementations do not collide.
 */
export interface ArchiveRef {
  id: string;
  title: string;
  /** Opaque locator into the Jules-owned archive store. */
  locator: string;
  projectId: string | null;
  addedAt: string;
}

export interface CommandCenterSnapshot {
  generatedAt: string;
  lanes: Record<CommandCenterLane, CommandCenterItem[]>;
}

export interface CommandCenterItem {
  subjectKind: string;
  subjectId: string;
  status: string;
  summary: string;
  actor: string;
  at: string;
}
