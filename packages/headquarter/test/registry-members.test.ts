import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { MemberCapabilityRegistry } from '../src/registry/capabilities.js';
import { AiMemberRegistry, type RegisterMemberInput } from '../src/registry/members.js';
import { ProviderDirectory } from '../src/providers/directory.js';
import { createMockAdapter } from '../src/providers/mock.js';
import type { ProviderDescriptor } from '../src/providers/contracts.js';

const openaiDescriptor: ProviderDescriptor = {
  providerId: 'openai',
  displayName: 'OpenAI',
  kind: 'cloud',
  advertisedModels: [
    {
      modelId: 'gpt-generic',
      modelVersion: 'v1',
      advertisedCapabilities: ['coding', 'reasoning'],
      contextWindowTokens: 128000,
      defaultCostClass: 'medium',
      locality: 'cloud',
    },
  ],
};

const anthropicDescriptor: ProviderDescriptor = {
  providerId: 'anthropic',
  displayName: 'Anthropic',
  kind: 'cloud',
  advertisedModels: [
    {
      modelId: 'claude-generic',
      modelVersion: 'v2',
      advertisedCapabilities: ['coding', 'reasoning', 'design'],
      contextWindowTokens: 200000,
      defaultCostClass: 'medium',
      locality: 'cloud',
    },
  ],
};

function baseMember(overrides: Partial<RegisterMemberInput> = {}): RegisterMemberInput {
  return {
    id: 'member-1',
    displayName: 'Claude Worker One',
    providerId: 'openai',
    modelId: 'gpt-generic',
    modelVersion: 'v1',
    workerType: 'execution',
    locality: 'cloud',
    privacyClass: 'internal',
    costClass: 'medium',
    advertisedCapabilities: ['coding', 'reasoning'],
    grantedCapabilities: ['coding'],
    ...overrides,
  };
}

describe('AiMemberRegistry', () => {
  let db: HqDatabase;
  let capabilities: MemberCapabilityRegistry;
  let providers: ProviderDirectory;
  let members: AiMemberRegistry;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    capabilities = new MemberCapabilityRegistry(db);
    capabilities.register({ id: 'coding', domain: 'coding', description: 'General coding', riskClass: 'reversible' });
    capabilities.register({ id: 'reasoning', domain: 'reasoning', description: 'General reasoning', riskClass: 'read_only' });
    capabilities.register({ id: 'design', domain: 'design', description: 'Design work', riskClass: 'reversible' });

    providers = new ProviderDirectory();
    providers.register(createMockAdapter(openaiDescriptor));
    providers.register(createMockAdapter(anthropicDescriptor));

    members = new AiMemberRegistry(db, providers, capabilities);
  });

  // ---- scenario 1: unknown provider -----------------------------------

  it('scenario 1: rejects registration against an unknown provider', () => {
    expect(() => members.register(baseMember({ providerId: 'totally-unknown-vendor' }))).toThrow(/Unknown provider/);
  });

  // ---- scenario 4: duplicate member id -----------------------------------

  it('scenario 4: rejects a duplicate member id', () => {
    members.register(baseMember());
    expect(() => members.register(baseMember())).toThrow(/Duplicate AI member id/);
  });

  it('multiple workers of the same model coexist under different member ids', () => {
    members.register(baseMember({ id: 'worker-a' }));
    members.register(baseMember({ id: 'worker-b' }));
    const all = members.list();
    expect(all.map((m) => m.id).sort()).toEqual(['worker-a', 'worker-b']);
    expect(all[0].identityKey).toBe(all[1].identityKey);
  });

  it('granting an unregistered capability throws', () => {
    expect(() => members.register(baseMember({ grantedCapabilities: ['never.registered'] }))).toThrow(
      /Cannot grant capability/,
    );
  });

  it('granting a disabled capability throws', () => {
    capabilities.setEnabled('design', false);
    expect(() => members.register(baseMember({ grantedCapabilities: ['design'] }))).toThrow(/is disabled/);
  });

  it('granting a capability the member does not advertise is allowed but flagged with a warning', () => {
    const { warnings } = members.register(
      baseMember({ advertisedCapabilities: ['coding'], grantedCapabilities: ['coding', 'reasoning'] }),
    );
    expect(warnings.some((w) => w.includes('reasoning'))).toBe(true);
  });

  // ---- scenario 2: model upgrade via replace() ---------------------------

  it('scenario 2: replace() marks the old member replaced, activates the new one, preserves history, and hands over active work', () => {
    const { member: oldMember } = members.register(baseMember({ id: 'old-worker' }));
    members.assign('old-worker', 'task-123');

    const { oldMember: oldAfter, newMember, handoverRequired } = members.replace(
      'old-worker',
      baseMember({
        id: 'new-worker',
        providerId: 'anthropic',
        modelId: 'claude-generic',
        modelVersion: 'v2',
        advertisedCapabilities: ['coding', 'reasoning', 'design'],
        grantedCapabilities: ['coding', 'reasoning'],
      }),
      'founder',
    );

    expect(oldAfter.status).toBe('replaced');
    expect(oldAfter.replacedById).toBe('new-worker');
    expect(newMember.status).toBe('active');
    expect(handoverRequired).toHaveLength(1);
    expect(handoverRequired[0].taskRef).toBe('task-123');
    expect(members.listAssignments('old-worker')[0].status).toBe('handover_pending');

    const oldHistory = members.history('old-worker').map((h) => h.event);
    expect(oldHistory).toContain('replaced');
    const newHistory = members.history('new-worker').map((h) => h.event);
    expect(newHistory).toContain('registered');
    expect(newHistory).toContain('replaced_predecessor');

    // sanity: oldMember variable retained for readability of the assertions above
    expect(oldMember.id).toBe('old-worker');
  });

  it('replace() copies role eligibility only where the new member still satisfies the requirement', () => {
    members.defineRole('reviewer', ['coding', 'design'], 'Code + design reviewer');
    members.defineRole('coder', ['coding'], 'Plain coder');

    members.register(baseMember({ id: 'old-worker', grantedCapabilities: ['coding', 'design'] }));
    members.setRoleEligibility('old-worker', ['reviewer', 'coder']);

    const { newMember } = members.replace(
      'old-worker',
      baseMember({
        id: 'new-worker',
        providerId: 'anthropic',
        modelId: 'claude-generic',
        modelVersion: 'v2',
        advertisedCapabilities: ['coding', 'reasoning', 'design'],
        // deliberately missing 'design' so 'reviewer' is no longer satisfied
        grantedCapabilities: ['coding'],
      }),
      'founder',
    );

    expect(newMember.roleEligibility).toEqual(['coder']);
  });

  // ---- scenario 3: disabled member ---------------------------------------

  it('scenario 3: disable() excludes the member from assign(), preserves history/assignments, and returns handover requirements', () => {
    members.register(baseMember());
    members.assign('member-1', 'task-a');
    members.assign('member-1', 'task-b');

    const { member, handoverRequired } = members.disable('member-1', 'retiring model', 'founder');
    expect(member.status).toBe('disabled');
    expect(member.enabled).toBe(false);
    expect(handoverRequired).toHaveLength(2);
    expect(handoverRequired.every((a) => a.status === 'handover_pending')).toBe(true);

    // assign() must now refuse
    expect(() => members.assign('member-1', 'task-c')).toThrow(/not active/);

    // nothing was deleted
    expect(members.get('member-1')).not.toBeNull();
    expect(members.listAssignments('member-1')).toHaveLength(2);
    expect(members.history('member-1').map((h) => h.event)).toEqual(
      expect.arrayContaining(['registered', 'assigned', 'disabled']),
    );
  });

  it('disable() throws when the member is not currently active', () => {
    members.register(baseMember());
    members.disable('member-1', 'first disable', 'founder');
    expect(() => members.disable('member-1', 'second disable', 'founder')).toThrow(/expected 'active'/);
  });

  it('remove() marks the member removed without deleting any row, and hard delete does not exist on the class', () => {
    members.register(baseMember());
    const removed = members.remove('member-1', 'decommissioned', 'founder');
    expect(removed.status).toBe('removed');
    expect(members.get('member-1')).not.toBeNull();
    expect((members as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((members as unknown as Record<string, unknown>).hardDelete).toBeUndefined();
  });

  it('assign() refuses a member whose health is unavailable', () => {
    members.register(baseMember());
    members.setHealth('member-1', 'unavailable');
    expect(() => members.assign('member-1', 'task-x')).toThrow(/unavailable/);
  });

  it('completeAssignment() ends an active assignment and rejects completing it twice', () => {
    members.register(baseMember());
    const assignment = members.assign('member-1', 'task-x');
    const completed = members.completeAssignment(assignment.id);
    expect(completed.status).toBe('completed');
    expect(() => members.completeAssignment(assignment.id)).toThrow(/not active/);
  });

  // ---- scenario 8: identity binding + impersonation ----------------------

  it('scenario 8: verifyIdentity accepts the true identity and rejects a mismatched claim as impersonation', () => {
    members.register(baseMember());
    expect(members.verifyIdentity('member-1', { providerId: 'openai', modelId: 'gpt-generic', modelVersion: 'v1' })).toEqual({
      ok: true,
    });

    const rejected = members.verifyIdentity('member-1', {
      providerId: 'anthropic',
      modelId: 'claude-generic',
      modelVersion: 'v2',
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.reason).toMatch(/mismatch/i);

    const history = members.history('member-1').map((h) => h.event);
    expect(history).toContain('identity_verification_failed');
  });

  it('scenario 8: update() throws on any attempt to change an identity field, and displayName relabeling cannot alter identity', () => {
    members.register(baseMember());
    expect(() => members.update('member-1', { providerId: 'anthropic' } as never)).toThrow(/identity is immutable/);
    expect(() => members.update('member-1', { modelId: 'other-model' } as never)).toThrow(/identity is immutable/);
    expect(() => members.update('member-1', { modelVersion: 'v9' } as never)).toThrow(/identity is immutable/);
    expect(() => members.update('member-1', { id: 'renamed' } as never)).toThrow(/identity is immutable/);

    const { member } = members.update('member-1', { displayName: 'Renamed Worker' });
    expect(member.displayName).toBe('Renamed Worker');
    expect(member.identityKey).toBe('openai:gpt-generic:v1');
    expect(member.providerId).toBe('openai');
  });

  it('update() rejects attempts to touch lifecycle-managed fields directly', () => {
    members.register(baseMember());
    expect(() => members.update('member-1', { status: 'disabled' } as never)).toThrow(/lifecycle method/);
  });

  // ---- scenario 9: role reassignment compatibility -----------------------

  it('scenario 9: setRoleEligibility rejects a role whose required capabilities are not all granted, naming the missing ones', () => {
    members.defineRole('reviewer', ['coding', 'design'], 'Code + design reviewer');
    members.register(baseMember({ grantedCapabilities: ['coding'] })); // no 'design'

    expect(() => members.setRoleEligibility('member-1', ['reviewer'])).toThrow(/design/);
  });

  it('scenario 9: setRoleEligibility succeeds once all required capabilities are granted', () => {
    members.defineRole('reviewer', ['coding', 'reasoning'], 'Reviewer');
    members.register(baseMember({ grantedCapabilities: ['coding', 'reasoning'] }));
    const { member } = members.setRoleEligibility('member-1', ['reviewer']);
    expect(member.roleEligibility).toEqual(['reviewer']);
  });

  it('defineRole throws if it requires an unregistered capability', () => {
    expect(() => members.defineRole('ghost-role', ['never.registered'], 'bad role')).toThrow(/unregistered capability/);
  });

  it('workloadOf reflects only active assignments', () => {
    members.register(baseMember());
    const a = members.assign('member-1', 'task-a');
    members.assign('member-1', 'task-b');
    expect(members.workloadOf('member-1')).toBe(2);
    members.completeAssignment(a.id);
    expect(members.workloadOf('member-1')).toBe(1);
  });
});
