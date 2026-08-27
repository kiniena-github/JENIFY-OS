/**
 * Regression suite for issue #131 — the High-severity defect independent
 * review found in PR #128: `update()` could reduce `grantedCapabilities`
 * while leaving the stored `roleEligibility` untouched, so a member stayed
 * marked eligible for a role it could no longer perform and `rankMembers()`
 * would route role-gated work to it.
 *
 * The invariant these tests defend: role eligibility is always the truth
 * derived from the member's CURRENT effective capabilities and the CURRENT
 * requirements of the role. No mutation path may leave a stale value behind,
 * and no persistence path may resurrect one.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { AiMemberRegistry, type RegisterMemberInput } from '../src/registry/members.js';
import { rankMembers } from '../src/registry/routing.js';
import { exportRegistry, importRegistry } from '../src/registry/serialization.js';
import { ensureRegistrySchema } from '../src/registry/db.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { createMockAdapter } from '../src/providers/mock.js';
import type { ProviderDescriptor } from '../src/providers/contracts.js';

const NOW = new Date('2026-08-27T00:00:00.000Z');

/**
 * Two unrelated providers — the registry must stay provider-neutral, so no
 * test here may depend on which vendor happens to occupy a role.
 */
const openaiDescriptor: ProviderDescriptor = {
  providerId: 'openai',
  displayName: 'OpenAI',
  kind: 'cloud',
  advertisedModels: [
    {
      modelId: 'gpt-generic',
      modelVersion: 'v1',
      advertisedCapabilities: ['coding', 'reasoning', 'research', 'design'],
      contextWindowTokens: 128000,
      defaultCostClass: 'medium',
      locality: 'cloud',
    },
  ],
};

const localDescriptor: ProviderDescriptor = {
  providerId: 'local-custom',
  displayName: 'Local model',
  kind: 'local',
  advertisedModels: [
    {
      modelId: 'llama-generic',
      modelVersion: 'v1',
      advertisedCapabilities: ['coding', 'reasoning', 'research', 'design'],
      contextWindowTokens: 32000,
      defaultCostClass: 'free',
      locality: 'local',
    },
  ],
};

const ALL_CAPS = ['coding', 'reasoning', 'research', 'design'] as const;

function baseMember(overrides: Partial<RegisterMemberInput> = {}): RegisterMemberInput {
  return {
    id: 'worker-1',
    displayName: 'Worker One',
    providerId: 'openai',
    modelId: 'gpt-generic',
    modelVersion: 'v1',
    workerType: 'execution',
    locality: 'cloud',
    privacyClass: 'internal',
    costClass: 'medium',
    advertisedCapabilities: [...ALL_CAPS],
    grantedCapabilities: [...ALL_CAPS],
    ...overrides,
  };
}

describe('role eligibility is derived truth, never stale state (issue #131)', () => {
  let db: HqDatabase;
  let capabilities: MemberCapabilityRegistry;
  let providers: ProviderDirectory;
  let registry: AiMemberRegistry;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    capabilities = new MemberCapabilityRegistry(db);
    providers = new ProviderDirectory();
    providers.register(createMockAdapter(openaiDescriptor));
    providers.register(createMockAdapter(localDescriptor));
    registry = new AiMemberRegistry(db, providers, capabilities);

    capabilities.register({ id: 'coding', domain: 'coding', description: 'Writes code', riskClass: 'reversible' });
    capabilities.register({ id: 'reasoning', domain: 'reasoning', description: 'Reasons', riskClass: 'read_only' });
    capabilities.register({ id: 'research', domain: 'research', description: 'Researches', riskClass: 'read_only' });
    capabilities.register({ id: 'design', domain: 'design', description: 'Designs', riskClass: 'read_only' });

    // Deliberately overlapping requirements — see case 5.
    registry.defineRole('lead-engineer', ['coding', 'reasoning'], 'Leads engineering work');
    registry.defineRole('reviewer', ['reasoning'], 'Reviews work');
    registry.defineRole('researcher', ['research', 'reasoning'], 'Researches');
  });

  // ---- 1 --------------------------------------------------------------
  it('case 1: a member holding every required capability is eligible for the role', () => {
    const { member } = registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));

    expect(member.roleEligibility).toEqual(['lead-engineer']);
    expect(member.assignedRoles).toEqual(['lead-engineer']);
    expect(member.suspendedRoles).toEqual([]);
    expect(registry.get('worker-1')!.roleEligibility).toEqual(['lead-engineer']);
  });

  // ---- 2 --------------------------------------------------------------
  it('case 2: revoking one required capability makes the member ineligible immediately', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));

    const { member, warnings } = registry.update('worker-1', {
      grantedCapabilities: ['coding', 'research', 'design'], // 'reasoning' revoked
    });

    expect(member.roleEligibility).toEqual([]);
    expect(member.suspendedRoles).toEqual([
      { roleId: 'lead-engineer', missingCapabilities: ['reasoning'], reason: 'missing_capabilities' },
    ]);
    // The assignment itself is kept, so the Founder's intent is not destroyed.
    expect(member.assignedRoles).toEqual(['lead-engineer']);
    // ...and the suspension is never silent.
    expect(warnings.some((w) => w.includes('lead-engineer'))).toBe(true);
    expect(registry.history('worker-1').map((h) => h.event)).toContain('role_eligibility_suspended');
    // A second, independent read agrees — nothing stale was written anywhere.
    expect(registry.get('worker-1')!.roleEligibility).toEqual([]);
  });

  // ---- 3 --------------------------------------------------------------
  it('case 3: restoring the capability makes the member eligible again', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    registry.update('worker-1', { grantedCapabilities: ['coding'] });
    expect(registry.get('worker-1')!.roleEligibility).toEqual([]);

    const { member } = registry.update('worker-1', { grantedCapabilities: ['coding', 'reasoning'] });

    expect(member.roleEligibility).toEqual(['lead-engineer']);
    expect(member.suspendedRoles).toEqual([]);
    expect(registry.history('worker-1').map((h) => h.event)).toContain('role_eligibility_restored');
  });

  // ---- 4 --------------------------------------------------------------
  it('case 4: revoking an unrelated capability leaves valid eligibility untouched', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));

    const { member, warnings } = registry.update('worker-1', {
      grantedCapabilities: ['coding', 'reasoning'], // 'research'/'design' revoked, neither is required
    });

    expect(member.roleEligibility).toEqual(['lead-engineer']);
    expect(member.suspendedRoles).toEqual([]);
    expect(warnings.filter((w) => w.includes('no longer eligible'))).toEqual([]);
  });

  // ---- 5 --------------------------------------------------------------
  it('case 5: overlapping roles are each judged on their own requirements', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer', 'reviewer', 'researcher'] }));

    // 'coding' is required only by lead-engineer; reviewer and researcher survive.
    const afterCoding = registry.update('worker-1', {
      grantedCapabilities: ['reasoning', 'research', 'design'],
    }).member;
    expect(afterCoding.roleEligibility).toEqual(['reviewer', 'researcher']);
    expect(afterCoding.suspendedRoles.map((s) => s.roleId)).toEqual(['lead-engineer']);

    // 'reasoning' is required by all three — losing it must suspend all three.
    const afterReasoning = registry.update('worker-1', { grantedCapabilities: ['research', 'design'] }).member;
    expect(afterReasoning.roleEligibility).toEqual([]);
    expect(afterReasoning.suspendedRoles.map((s) => s.roleId).sort()).toEqual([
      'lead-engineer',
      'researcher',
      'reviewer',
    ]);
  });

  // ---- 6 --------------------------------------------------------------
  it('case 6: removing several capabilities in a single update cannot leave stale eligibility', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer', 'reviewer', 'researcher'] }));

    const { member } = registry.update('worker-1', { grantedCapabilities: [] });

    expect(member.roleEligibility).toEqual([]);
    expect(member.effectiveCapabilities).toEqual([]);
    expect(member.suspendedRoles).toHaveLength(3);
    for (const roleId of ['lead-engineer', 'reviewer', 'researcher']) {
      const ranked = rankMembers(registry.list(), { requiredCapability: 'reasoning', roleId, now: NOW });
      expect(ranked[0].excluded).toBeTruthy();
    }
  });

  // ---- 7 --------------------------------------------------------------
  it('case 7: adding capabilities updates eligibility for roles already assigned', () => {
    registry.register(baseMember({ grantedCapabilities: ['coding'], roleEligibility: [] }));
    // Assigning a role the member cannot perform is refused outright...
    expect(() => registry.setRoleEligibility('worker-1', ['lead-engineer'])).toThrow(/reasoning/);

    registry.update('worker-1', { grantedCapabilities: ['coding', 'reasoning'] });
    // ...and becomes possible only once the capability is actually held.
    const { member } = registry.setRoleEligibility('worker-1', ['lead-engineer']);

    expect(member.roleEligibility).toEqual(['lead-engineer']);
    expect(member.effectiveCapabilities).toEqual(['coding', 'reasoning']);
  });

  // ---- 8 --------------------------------------------------------------
  it('case 8: repeated and no-op updates are idempotent and never corrupt eligibility', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer', 'reviewer'] }));

    for (let i = 0; i < 3; i += 1) {
      registry.update('worker-1', { grantedCapabilities: ['coding', 'reasoning'] });
      expect(registry.get('worker-1')!.roleEligibility).toEqual(['lead-engineer', 'reviewer']);
    }
    for (let i = 0; i < 3; i += 1) {
      registry.update('worker-1', { grantedCapabilities: ['coding'] });
      expect(registry.get('worker-1')!.roleEligibility).toEqual([]);
    }
    // Updates that touch nothing capability-related leave eligibility alone.
    registry.update('worker-1', { displayName: 'Renamed Worker' });
    expect(registry.get('worker-1')!.roleEligibility).toEqual([]);

    registry.update('worker-1', { grantedCapabilities: ['coding', 'reasoning'] });
    expect(registry.get('worker-1')!.roleEligibility).toEqual(['lead-engineer', 'reviewer']);

    // Suspension is recorded once per transition, not once per repeated update.
    const events = registry.history('worker-1').map((h) => h.event);
    expect(events.filter((e) => e === 'role_eligibility_suspended')).toHaveLength(1);
    expect(events.filter((e) => e === 'role_eligibility_restored')).toHaveLength(1);
  });

  // ---- 9 --------------------------------------------------------------
  it('case 9: a disabled or removed member is never assignable or routable', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    registry.assign('worker-1', 'task-1');

    const { handoverRequired } = registry.disable('worker-1', 'stood down', 'founder');
    expect(handoverRequired).toHaveLength(1);
    expect(handoverRequired[0].status).toBe('handover_pending');

    expect(() => registry.assign('worker-1', 'task-2')).toThrow(/not active/);
    const ranked = rankMembers(registry.list(), {
      requiredCapability: 'coding',
      roleId: 'lead-engineer',
      now: NOW,
    });
    expect(ranked[0].excluded).toMatch(/not active/);

    registry.remove('worker-1', 'retired', 'founder');
    expect(() => registry.assign('worker-1', 'task-3')).toThrow(/not active/);
    // History survives removal — audit stays trustworthy.
    expect(registry.history('worker-1').map((h) => h.event)).toEqual(
      expect.arrayContaining(['registered', 'assigned', 'disabled', 'removed']),
    );
  });

  // ---- 10 -------------------------------------------------------------
  it('case 10: reopening the registry over the same database does not resurrect eligibility', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    registry.update('worker-1', { grantedCapabilities: ['coding'] });

    const reopened = new AiMemberRegistry(db, providers, new MemberCapabilityRegistry(db));
    expect(reopened.get('worker-1')!.roleEligibility).toEqual([]);
    expect(reopened.get('worker-1')!.assignedRoles).toEqual(['lead-engineer']);
  });

  it('case 10: no stored column holds eligibility that a read could trust', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    registry.update('worker-1', { grantedCapabilities: ['coding'] });

    const row = db.prepare('SELECT * FROM hq_ai_members WHERE id = ?').get('worker-1') as Record<string, unknown>;
    expect(Object.keys(row)).not.toContain('role_eligibility');
    expect(JSON.parse(row.assigned_roles as string)).toEqual(['lead-engineer']);
  });

  it('case 10: an export/import round trip cannot carry stale eligibility into a fresh database', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    registry.update('worker-1', { grantedCapabilities: ['coding'] });

    const snapshot = exportRegistry(db);
    // Hostile/legacy snapshot: forge eligibility the grants do not support.
    snapshot.members[0].roleEligibility = ['lead-engineer'];
    snapshot.members[0].effectiveCapabilities = ['coding', 'reasoning'];

    const targetDb = openMemoryHqDatabase();
    expect(importRegistry(targetDb, snapshot, { providerDirectory: providers }).ok).toBe(true);

    const imported = new AiMemberRegistry(targetDb, providers, new MemberCapabilityRegistry(targetDb));
    expect(imported.get('worker-1')!.roleEligibility).toEqual([]);
    expect(imported.get('worker-1')!.effectiveCapabilities).toEqual(['coding']);
  });

  it('case 10: import rejects a member assigned to a role the snapshot does not define', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    const snapshot = exportRegistry(db);
    snapshot.roles = snapshot.roles.filter((r) => r.roleId !== 'lead-engineer');

    const result = importRegistry(openMemoryHqDatabase(), snapshot, { providerDirectory: providers });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.message.includes("assigned role 'lead-engineer'"))).toBe(true);
  });

  it('case 10: a database written before eligibility was derived is upgraded, not trusted', () => {
    const legacyDb = openMemoryHqDatabase();
    ensureRegistrySchema(legacyDb);
    legacyDb.exec('DROP TABLE hq_ai_members');
    // The pre-#131 shape: eligibility stored in its own column.
    legacyDb.exec(`
      CREATE TABLE hq_ai_members (
        id TEXT PRIMARY KEY, display_name TEXT NOT NULL, provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL, model_version TEXT NOT NULL, identity_key TEXT NOT NULL,
        worker_type TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, locality TEXT NOT NULL,
        privacy_class TEXT NOT NULL, cost_class TEXT NOT NULL, context_window_tokens INTEGER,
        tool_metadata TEXT NOT NULL DEFAULT '{}', role_eligibility TEXT NOT NULL DEFAULT '[]',
        advertised_capabilities TEXT NOT NULL DEFAULT '[]', granted_capabilities TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active', health TEXT NOT NULL DEFAULT 'unknown',
        health_checked_at TEXT, benchmarks TEXT NOT NULL DEFAULT '[]', replaced_by_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
    // A row carrying exactly the defect: eligible for a role it cannot perform.
    legacyDb
      .prepare(
        `INSERT INTO hq_ai_members (id, display_name, provider_id, model_id, model_version, identity_key,
          worker_type, locality, privacy_class, cost_class, tool_metadata, role_eligibility,
          advertised_capabilities, granted_capabilities, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-1',
        'Legacy',
        'openai',
        'gpt-generic',
        'v1',
        'openai:gpt-generic:v1',
        'execution',
        'cloud',
        'internal',
        'medium',
        '{}',
        JSON.stringify(['lead-engineer']),
        '[]',
        JSON.stringify(['coding']),
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z',
      );

    const legacyCaps = new MemberCapabilityRegistry(legacyDb);
    legacyCaps.register({ id: 'coding', domain: 'coding', description: 'c', riskClass: 'reversible' });
    legacyCaps.register({ id: 'reasoning', domain: 'reasoning', description: 'r', riskClass: 'read_only' });
    const legacyRegistry = new AiMemberRegistry(legacyDb, providers, legacyCaps);
    legacyRegistry.defineRole('lead-engineer', ['coding', 'reasoning'], 'Leads engineering work');

    const member = legacyRegistry.get('legacy-1')!;
    // The assignment is preserved by the upgrade...
    expect(member.assignedRoles).toEqual(['lead-engineer']);
    // ...but the stale eligibility it used to confer is gone.
    expect(member.roleEligibility).toEqual([]);
  });

  // ---- 11 -------------------------------------------------------------
  it('case 11: existing capability, role and member guarantees are unchanged', () => {
    const { member, warnings } = registry.register(
      baseMember({ advertisedCapabilities: ['coding'], grantedCapabilities: ['coding', 'reasoning'] }),
    );
    // A grant the provider never advertised is allowed but flagged.
    expect(warnings.some((w) => w.includes("'reasoning'"))).toBe(true);
    expect(member.identityKey).toBe('openai:gpt-generic:v1');

    // Deny by default: unregistered capabilities are never grantable.
    expect(() => registry.update('worker-1', { grantedCapabilities: ['nonexistent'] })).toThrow(/Unregistered/);
    expect(() => registry.defineRole('bad-role', ['nonexistent'], 'x')).toThrow(/unregistered capability/);
    // Identity is immutable.
    expect(() => registry.update('worker-1', { modelVersion: 'v2' } as never)).toThrow(/immutable/);
    // Derived and intent fields cannot be written through update() either.
    expect(() => registry.update('worker-1', { roleEligibility: ['lead-engineer'] } as never)).toThrow(
      /lifecycle method/,
    );
    expect(() => registry.update('worker-1', { assignedRoles: ['lead-engineer'] } as never)).toThrow(
      /lifecycle method/,
    );
    expect(() => registry.setRoleEligibility('worker-1', ['unknown-role'])).toThrow(/Unknown role/);
  });

  it('case 11: a rejected update leaves neither the member nor its history changed', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    const before = registry.get('worker-1')!;
    const historyBefore = registry.history('worker-1').length;

    // Validation fails, so the member write and its history entry must both
    // be rolled back rather than leaving partial authorization state.
    expect(() =>
      registry.update('worker-1', { displayName: 'Half-applied', grantedCapabilities: ['nonexistent'] }),
    ).toThrow(/Unregistered/);

    const after = registry.get('worker-1')!;
    expect(after.displayName).toBe(before.displayName);
    expect(after.grantedCapabilities).toEqual(before.grantedCapabilities);
    expect(after.roleEligibility).toEqual(['lead-engineer']);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(registry.history('worker-1')).toHaveLength(historyBefore);
  });

  // ---- 12 -------------------------------------------------------------
  it('case 12 (Jules #131 regression): a revoked capability cannot leave a member routable for the role', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));

    // Before: the member is the chosen candidate for role-gated work.
    const before = rankMembers(registry.list(), {
      requiredCapability: 'coding',
      roleId: 'lead-engineer',
      now: NOW,
    });
    expect(before[0].excluded).toBeUndefined();
    expect(before[0].member.id).toBe('worker-1');

    // The exact reported mutation: update() reduces grantedCapabilities.
    registry.update('worker-1', { grantedCapabilities: ['coding', 'research', 'design'] });

    // After: routing must refuse it for that role even though the request's
    // own requiredCapability ('coding') is still held — this is the precise
    // gap the reviewers found.
    const after = rankMembers(registry.list(), {
      requiredCapability: 'coding',
      roleId: 'lead-engineer',
      now: NOW,
    });
    expect(after[0].excluded).toMatch(/not currently eligible/);
    expect(after.filter((r) => !r.excluded)).toEqual([]);
  });

  // ---- adjacent variants of the same stale-derived-state bug ------------
  it('adjacent: tightening a role definition immediately narrows eligibility', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'], grantedCapabilities: ['coding', 'reasoning'] }));
    expect(registry.get('worker-1')!.roleEligibility).toEqual(['lead-engineer']);

    registry.defineRole('lead-engineer', ['coding', 'reasoning', 'design'], 'Now also needs design');

    const member = registry.get('worker-1')!;
    expect(member.roleEligibility).toEqual([]);
    expect(member.suspendedRoles[0].missingCapabilities).toEqual(['design']);
    const ranked = rankMembers(registry.list(), { requiredCapability: 'coding', roleId: 'lead-engineer', now: NOW });
    expect(ranked[0].excluded).toBeTruthy();
  });

  it('adjacent: relaxing a role definition restores eligibility without re-assignment', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'], grantedCapabilities: ['coding', 'reasoning'] }));
    registry.defineRole('lead-engineer', ['coding', 'reasoning', 'design'], 'Tightened');
    expect(registry.get('worker-1')!.roleEligibility).toEqual([]);

    registry.defineRole('lead-engineer', ['coding'], 'Relaxed');
    expect(registry.get('worker-1')!.roleEligibility).toEqual(['lead-engineer']);
  });

  it('adjacent: disabling a capability registry-wide withdraws it from eligibility and routing', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));

    capabilities.setEnabled('reasoning', false);

    const member = registry.get('worker-1')!;
    // The grant record is preserved for audit...
    expect(member.grantedCapabilities).toContain('reasoning');
    // ...but it confers nothing while the capability is disabled.
    expect(member.effectiveCapabilities).not.toContain('reasoning');
    expect(member.roleEligibility).toEqual([]);
    expect(rankMembers([member], { requiredCapability: 'reasoning', now: NOW })[0].excluded).toMatch(
      /capability-mismatch/,
    );

    capabilities.setEnabled('reasoning', true);
    expect(registry.get('worker-1')!.roleEligibility).toEqual(['lead-engineer']);
  });

  it('adjacent: a replacement member only inherits roles its own capabilities support', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer', 'reviewer'] }));

    const { newMember } = registry.replace(
      'worker-1',
      baseMember({
        id: 'worker-2',
        displayName: 'Local replacement',
        providerId: 'local-custom',
        modelId: 'llama-generic',
        locality: 'local',
        costClass: 'free',
        grantedCapabilities: ['reasoning'], // cannot do lead-engineer's 'coding'
      }),
      'founder',
    );

    expect(newMember.assignedRoles).toEqual(['reviewer']);
    expect(newMember.roleEligibility).toEqual(['reviewer']);
    expect(registry.get('worker-1')!.status).toBe('replaced');
    expect(registry.get('worker-1')!.replacedById).toBe('worker-2');
  });

  it('adjacent: any provider can hold any role — no member is structurally irreplaceable', () => {
    registry.register(baseMember({ roleEligibility: ['lead-engineer'] }));
    registry.register(
      baseMember({
        id: 'worker-local',
        displayName: 'Local worker',
        providerId: 'local-custom',
        modelId: 'llama-generic',
        locality: 'local',
        costClass: 'free',
        roleEligibility: ['lead-engineer'],
      }),
    );

    registry.remove('worker-1', 'founder swapped the provider', 'founder');

    const ranked = rankMembers(registry.list(), {
      requiredCapability: 'coding',
      roleId: 'lead-engineer',
      now: NOW,
    });
    expect(ranked[0].member.id).toBe('worker-local');
    expect(ranked[0].excluded).toBeUndefined();
  });
});
