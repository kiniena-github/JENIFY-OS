/**
 * Additive schema for the Headquarter application layer (issue #139).
 *
 * DELIBERATELY NOT part of `store/db.ts`'s DDL: several HQ lanes are in
 * flight at once, and each one owning its own idempotent `ensure*Tables()`
 * keeps them from colliding in a single shared DDL string (the same pattern
 * lanes C and D use in PRs #128/#127).
 *
 * WHAT LIVES HERE — routing/labelling metadata ONLY:
 *   which project a task belongs to, its human title, which room it came
 *   from, and who the Founder *intends* to own it.
 *
 * WHAT NEVER LIVES HERE — task STATE:
 *   status, fence, claim, approval, review state, and results stay exclusively
 *   in the canonical Operator tables (`op_tasks`, `hq_approvals`) and the
 *   canonical event log (`hq_events`). This layer's read models JOIN against
 *   those; they never shadow, cache, or re-derive them. "Presentation never
 *   invents state" (§6b) is enforced structurally: there is no status column
 *   in any table below.
 */

import type { HqDatabase } from '../store/db.js';

const APPLICATION_DDL = `
CREATE TABLE IF NOT EXISTS hq_task_meta (
  task_id TEXT PRIMARY KEY,
  project TEXT,
  title TEXT,
  origin_thread_id TEXT,
  assigned_worker_id TEXT,
  assigned_by TEXT,
  assigned_at TEXT,
  classified_by TEXT,
  classified_at TEXT
);

CREATE TABLE IF NOT EXISTS hq_missions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_missions_thread ON hq_missions(thread_id);

CREATE TABLE IF NOT EXISTS hq_mission_tasks (
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, task_id)
);
`;

export function ensureApplicationTables(db: HqDatabase): void {
  db.exec(APPLICATION_DDL);
}
