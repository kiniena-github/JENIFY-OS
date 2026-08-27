/**
 * Schema for the AI Member Registry + Capability Registry (issue #119).
 *
 * Deliberately its OWN DDL, applied on top of an existing `HqDatabase`
 * (`../store/db.ts`) rather than edited into it — this feature is additive
 * and must not touch the Universal Operator's tables or migration path.
 * `ensureRegistrySchema` is idempotent (safe to call every time a registry
 * class is constructed, and safe to call repeatedly in tests).
 */

import type { HqDatabase } from '../store/db.js';

const REGISTRY_DDL = `
CREATE TABLE IF NOT EXISTS hq_member_capabilities (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  risk_class TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hq_member_roles (
  role_id TEXT PRIMARY KEY,
  required_capabilities TEXT NOT NULL,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hq_ai_members (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  worker_type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  locality TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  cost_class TEXT NOT NULL,
  context_window_tokens INTEGER,
  tool_metadata TEXT NOT NULL DEFAULT '{}',
  -- Roles a registrar intentionally assigned. NOT eligibility: eligibility is
  -- derived from current capabilities/role requirements on every read
  -- (see registry/eligibility.ts) and is deliberately never stored, so it
  -- cannot go stale when a capability or a role definition changes.
  assigned_roles TEXT NOT NULL DEFAULT '[]',
  advertised_capabilities TEXT NOT NULL DEFAULT '[]',
  granted_capabilities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  health TEXT NOT NULL DEFAULT 'unknown',
  health_checked_at TEXT,
  benchmarks TEXT NOT NULL DEFAULT '[]',
  replaced_by_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_ai_members_identity ON hq_ai_members(identity_key);
CREATE INDEX IF NOT EXISTS idx_hq_ai_members_status ON hq_ai_members(status);

-- Append-only. No row is ever updated or deleted (issue #119: "no deletes
-- anywhere" — removal of a member is a status change, never a row delete,
-- and every lifecycle transition is recorded here for audit).
CREATE TABLE IF NOT EXISTS hq_ai_member_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL,
  at TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hq_ai_member_history_member ON hq_ai_member_history(member_id, seq);

CREATE TABLE IF NOT EXISTS hq_ai_member_assignments (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  task_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_hq_ai_member_assignments_member ON hq_ai_member_assignments(member_id, status);
`;

/**
 * Upgrades a database created before eligibility became derived (issue #131):
 * the old `role_eligibility` column stored eligibility directly, which is
 * exactly the state that could go stale. Its values were the registrar's
 * assignments, so they carry over verbatim into `assigned_roles`; the legacy
 * column is left in place (never read again) rather than dropped, so the
 * upgrade cannot lose data on any SQLite version.
 */
function migrateLegacyRoleEligibilityColumn(db: HqDatabase): void {
  const columns = db.prepare(`PRAGMA table_info(hq_ai_members)`).all() as { name: string }[];
  const names = new Set(columns.map((c) => c.name));
  if (names.has('assigned_roles') || !names.has('role_eligibility')) return;

  db.exec(`ALTER TABLE hq_ai_members ADD COLUMN assigned_roles TEXT NOT NULL DEFAULT '[]'`);
  db.exec(`UPDATE hq_ai_members SET assigned_roles = role_eligibility`);
}

export function ensureRegistrySchema(db: HqDatabase): void {
  db.exec(REGISTRY_DDL);
  migrateLegacyRoleEligibilityColumn(db);
}
