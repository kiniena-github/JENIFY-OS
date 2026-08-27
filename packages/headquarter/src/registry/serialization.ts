/**
 * No-vendor-lock-in export/import (issue #119, order 5).
 *
 * `exportRegistry` produces a plain, provider-neutral JSON snapshot —
 * members, capabilities, and roles only, using exactly the neutral fields
 * defined in `registry/members.ts` / `registry/capabilities.ts`. It never
 * contains an adapter instance, a vendor SDK object, or any credential —
 * `AiMember` itself already stores only a `providerId` string plus
 * data, never a live `ProviderAdapter`.
 *
 * A snapshot carries a member's DERIVED fields (`roleEligibility`,
 * `effectiveCapabilities`, `suspendedRoles`) for readability only — import
 * never reads them, because `insertMemberRow` persists just the assigned
 * roles and the target database recomputes eligibility itself. An edited or
 * legacy snapshot therefore cannot resurrect eligibility that the target's
 * own capabilities and role definitions do not support (issue #131).
 *
 * `importRegistry` re-validates every item against a *target* database and
 * `ProviderDirectory` and is deliberately **all-or-nothing**: if any item
 * fails validation, NOTHING is written and the full list of per-item errors
 * is returned so the caller can fix the snapshot and retry. This is safer
 * than a partial import silently leaving the registry in a state that
 * doesn't match either the old or the new snapshot.
 */

import type { HqDatabase } from '../store/db.js';
import { ensureRegistrySchema } from './db.js';
import {
  MEMBER_CAPABILITY_DOMAINS,
  MEMBER_RISK_CLASSES,
  MemberCapabilityRegistry,
  listAllCapabilities,
  type MemberCapability,
} from './capabilities.js';
import { insertMemberRow, insertRoleRow, listAllMembers, listAllRoles, type AiMember, type MemberRole } from './members.js';
import type { ProviderDirectory } from '../providers/directory.js';

export const REGISTRY_SCHEMA_VERSION = 1 as const;

export interface RegistrySnapshot {
  schemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  capabilities: MemberCapability[];
  roles: MemberRole[];
  members: AiMember[];
}

export interface ImportItemError {
  itemType: 'capability' | 'role' | 'member' | 'snapshot';
  id: string;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  errors: ImportItemError[];
  imported?: { capabilities: number; roles: number; members: number };
}

export function exportRegistry(db: HqDatabase): RegistrySnapshot {
  ensureRegistrySchema(db);
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    capabilities: listAllCapabilities(db),
    roles: listAllRoles(db),
    members: listAllMembers(db),
  };
}

/**
 * Validates every item in the snapshot against the target database and
 * provider directory, without writing anything. Returns the full list of
 * problems found (empty when the snapshot can be imported as-is).
 */
function validateSnapshot(
  db: HqDatabase,
  snapshot: RegistrySnapshot,
  providerDirectory: ProviderDirectory,
): ImportItemError[] {
  const errors: ImportItemError[] = [];

  for (const cap of snapshot.capabilities) {
    if (!(MEMBER_CAPABILITY_DOMAINS as readonly string[]).includes(cap.domain)) {
      errors.push({ itemType: 'capability', id: cap.id, message: `Unknown capability domain: ${cap.domain}` });
    }
    if (!(MEMBER_RISK_CLASSES as readonly string[]).includes(cap.riskClass)) {
      errors.push({ itemType: 'capability', id: cap.id, message: `Unknown risk class: ${cap.riskClass}` });
    }
  }
  const capabilityIds = new Set(snapshot.capabilities.map((c) => c.id));
  const roleIds = new Set(snapshot.roles.map((r) => r.roleId));

  for (const role of snapshot.roles) {
    for (const reqCap of role.requiredCapabilities) {
      if (!capabilityIds.has(reqCap)) {
        errors.push({
          itemType: 'role',
          id: role.roleId,
          message: `Requires capability '${reqCap}', which is not present in this snapshot`,
        });
      }
    }
  }

  for (const member of snapshot.members) {
    const expectedIdentityKey = `${member.providerId}:${member.modelId}:${member.modelVersion}`;
    if (member.identityKey !== expectedIdentityKey) {
      errors.push({
        itemType: 'member',
        id: member.id,
        message: `identityKey '${member.identityKey}' does not match provider/model/version ('${expectedIdentityKey}')`,
      });
    }
    if (!providerDirectory.has(member.providerId)) {
      errors.push({ itemType: 'member', id: member.id, message: `Unknown provider: ${member.providerId}` });
    }
    for (const capId of [...member.advertisedCapabilities, ...member.grantedCapabilities]) {
      if (!capabilityIds.has(capId)) {
        errors.push({
          itemType: 'member',
          id: member.id,
          message: `References capability '${capId}', which is not present in this snapshot`,
        });
      }
    }
    for (const roleId of member.assignedRoles) {
      if (!roleIds.has(roleId)) {
        errors.push({
          itemType: 'member',
          id: member.id,
          message: `Is assigned role '${roleId}', which is not present in this snapshot`,
        });
      }
    }
    const existing = db.prepare(`SELECT id FROM hq_ai_members WHERE id = ?`).get(member.id);
    if (existing) {
      errors.push({ itemType: 'member', id: member.id, message: `Member id already exists in the target database` });
    }
  }

  return errors;
}

/**
 * Imports a snapshot into `db`. All-or-nothing: on any validation error,
 * nothing is written and every problem is reported so the caller can see
 * the complete picture in one pass, not just the first failure.
 */
export function importRegistry(
  db: HqDatabase,
  snapshot: RegistrySnapshot,
  deps: { providerDirectory: ProviderDirectory },
): ImportResult {
  ensureRegistrySchema(db);
  if (snapshot.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        {
          itemType: 'snapshot',
          id: 'schemaVersion',
          message: `Unsupported schemaVersion: ${snapshot.schemaVersion} (expected ${REGISTRY_SCHEMA_VERSION})`,
        },
      ],
    };
  }

  const errors = validateSnapshot(db, snapshot, deps.providerDirectory);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const capRegistry = new MemberCapabilityRegistry(db);
  const tx = db.transaction(() => {
    for (const cap of snapshot.capabilities) capRegistry.register(cap);
    for (const role of snapshot.roles) insertRoleRow(db, role);
    for (const member of snapshot.members) insertMemberRow(db, member);
  });
  tx();

  return {
    ok: true,
    errors: [],
    imported: {
      capabilities: snapshot.capabilities.length,
      roles: snapshot.roles.length,
      members: snapshot.members.length,
    },
  };
}
