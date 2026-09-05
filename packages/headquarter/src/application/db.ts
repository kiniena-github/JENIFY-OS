/**
 * Module-owned schema for the Headquarter application/service layer (HQ lane
 * F, issue #139 / #122).
 *
 * Deliberately additive and self-contained: `src/store/db.ts` is the
 * foundation's file and is NOT edited by this lane, so lane F can land beside
 * the other special-mission lanes without schema conflicts. Both tables here
 * are PRESENTATION AND ROUTING METADATA ONLY.
 *
 * SECURITY NOTE — nothing in these tables is authority:
 * - `hq_op_task_meta` carries a task's project/title (so the Founder console
 *   can label it) and an ADVISORY assignment intent. It can never grant a
 *   capability, approve an action, or change a task's canonical status; the
 *   Operator queue never reads it.
 * - `hq_mission_proposals` holds INERT group-room proposals. A proposal is not
 *   a task and executes nothing; only an explicit promotion by an actor that
 *   already holds the capability turns one into a real Operator task, and that
 *   task then passes through the unchanged policy/approval/claim/fence gates.
 */

import type { HqDatabase } from '../store/db.js';

const APPLICATION_DDL = `
CREATE TABLE IF NOT EXISTS hq_op_task_meta (
  task_id TEXT PRIMARY KEY,
  project TEXT,
  title TEXT,
  source_proposal_id TEXT,
  assigned_worker_id TEXT,
  assigned_by TEXT,
  assigned_at TEXT,
  assignment_rationale TEXT
);

CREATE TABLE IF NOT EXISTS hq_mission_proposals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  source_message_id TEXT,
  capability_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  idempotency_key TEXT,
  digest TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  proposed_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  task_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_mission_proposals_status
  ON hq_mission_proposals(status, proposed_at);
`;

/**
 * Idempotent; safe to call on every construction of the service.
 *
 * Never attempts DDL on a READ-ONLY handle (the `hq:snapshot` path): a
 * read-only connection can only OBSERVE, and a file predating these tables
 * must be read truthfully, never migrated from a path that promised to write
 * nothing.
 */
export function ensureApplicationSchema(db: HqDatabase): void {
  if (db.readonly) return;
  db.exec(APPLICATION_DDL);
}
