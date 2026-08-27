import { describe, expect, it } from 'vitest';
import { rankMembers, type RoutingRequest } from '../src/registry/routing.js';
import type { AiMember } from '../src/registry/members.js';

const NOW = new Date('2026-08-27T00:00:00.000Z');

function makeMember(overrides: Partial<AiMember> = {}): AiMember {
  return {
    id: 'member-1',
    displayName: 'Test Member',
    providerId: 'openai',
    modelId: 'gpt-generic',
    modelVersion: 'v1',
    identityKey: 'openai:gpt-generic:v1',
    workerType: 'execution',
    enabled: true,
    locality: 'cloud',
    privacyClass: 'internal',
    costClass: 'medium',
    contextWindowTokens: 128000,
    toolMetadata: {},
    roleEligibility: [],
    advertisedCapabilities: ['coding'],
    grantedCapabilities: ['coding'],
    status: 'active',
    health: 'healthy',
    healthCheckedAt: null,
    benchmarks: [],
    replacedById: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const baseRequest: RoutingRequest = { requiredCapability: 'coding', now: NOW };

describe('rankMembers', () => {
  it('is a pure function: identical inputs produce identical output, no db/side effects', () => {
    const a = makeMember({ id: 'a' });
    const b = makeMember({ id: 'b' });
    const r1 = rankMembers([a, b], baseRequest);
    const r2 = rankMembers([a, b], baseRequest);
    expect(r1).toEqual(r2);
  });

  // ---- scenario 3: disabled member excluded from routing -----------------

  it('scenario 3: excludes a disabled member from ranking', () => {
    const disabled = makeMember({ id: 'disabled-one', status: 'disabled', enabled: false });
    const active = makeMember({ id: 'active-one' });
    const result = rankMembers([disabled, active], baseRequest);

    const disabledEntry = result.find((r) => r.member.id === 'disabled-one')!;
    expect(disabledEntry.excluded).toMatch(/not active/);

    const activeEntry = result.find((r) => r.member.id === 'active-one')!;
    expect(activeEntry.excluded).toBeUndefined();
  });

  it('excludes a member with health unavailable', () => {
    const unavailable = makeMember({ id: 'down', health: 'unavailable' });
    const result = rankMembers([unavailable], baseRequest);
    expect(result[0].excluded).toMatch(/unavailable/);
  });

  // ---- scenario 5: capability mismatch — advertised is not enough --------

  it('scenario 5: excludes a member that advertises the capability but was never granted it', () => {
    const advertisedOnly = makeMember({
      id: 'advertised-only',
      advertisedCapabilities: ['coding', 'image'],
      grantedCapabilities: ['coding'], // does NOT include 'image'
    });
    const result = rankMembers([advertisedOnly], { requiredCapability: 'image', now: NOW });
    expect(result[0].excluded).toMatch(/capability-mismatch/);
  });

  it('includes a member once the capability is actually granted', () => {
    const granted = makeMember({ id: 'granted', advertisedCapabilities: ['image'], grantedCapabilities: ['image'] });
    const result = rankMembers([granted], { requiredCapability: 'image', now: NOW });
    expect(result[0].excluded).toBeUndefined();
  });

  // ---- scenario 6: stale benchmark contributes nothing --------------------

  it('scenario 6: a stale benchmark contributes zero score and says so; a fresh one ranks higher', () => {
    const stale = makeMember({
      id: 'stale',
      benchmarks: [{ ref: 'coding', score: 95, recordedAt: '2025-01-01T00:00:00.000Z' }], // ~600 days old
    });
    const fresh = makeMember({
      id: 'fresh',
      benchmarks: [{ ref: 'coding', score: 60, recordedAt: '2026-08-20T00:00:00.000Z' }], // 7 days old
    });
    const result = rankMembers([stale, fresh], baseRequest);

    const staleEntry = result.find((r) => r.member.id === 'stale')!;
    expect(staleEntry.reasons.some((r) => /stale/.test(r))).toBe(true);

    const freshEntry = result.find((r) => r.member.id === 'fresh')!;
    expect(freshEntry.reasons.some((r) => /contributes \+/.test(r))).toBe(true);

    // fresh (with real benchmark evidence) outranks stale (whose evidence contributed 0)
    expect(result.findIndex((r) => r.member.id === 'fresh')).toBeLessThan(
      result.findIndex((r) => r.member.id === 'stale'),
    );
  });

  it('respects a custom benchmarkMaxAgeDays', () => {
    const member = makeMember({
      id: 'm',
      benchmarks: [{ ref: 'coding', score: 80, recordedAt: '2026-08-20T00:00:00.000Z' }], // 7 days old
    });
    const strict = rankMembers([member], { ...baseRequest, benchmarkMaxAgeDays: 1 });
    expect(strict[0].reasons.some((r) => /stale/.test(r))).toBe(true);

    const lenient = rankMembers([member], { ...baseRequest, benchmarkMaxAgeDays: 30 });
    expect(lenient[0].reasons.some((r) => /contributes \+/.test(r))).toBe(true);
  });

  // ---- scenario 7: locality policy ----------------------------------------

  it("scenario 7: 'local_only' excludes cloud members", () => {
    const cloud = makeMember({ id: 'cloud-member', locality: 'cloud' });
    const local = makeMember({ id: 'local-member', locality: 'local' });
    const result = rankMembers([cloud, local], { ...baseRequest, localityPolicy: 'local_only' });

    expect(result.find((r) => r.member.id === 'cloud-member')!.excluded).toMatch(/local_only/);
    expect(result.find((r) => r.member.id === 'local-member')!.excluded).toBeUndefined();
  });

  it("scenario 7: 'prefer_local' ranks a local member above an otherwise-equal cloud member", () => {
    const cloud = makeMember({ id: 'cloud-member', locality: 'cloud' });
    const local = makeMember({ id: 'local-member', locality: 'local' });
    const result = rankMembers([cloud, local], { ...baseRequest, localityPolicy: 'prefer_local' });

    expect(result[0].member.id).toBe('local-member');
    expect(result[0].reasons.some((r) => /prefer_local/.test(r))).toBe(true);
  });

  it("'any' locality policy does not exclude or boost either locality", () => {
    const cloud = makeMember({ id: 'cloud-member', locality: 'cloud' });
    const local = makeMember({ id: 'local-member', locality: 'local' });
    const result = rankMembers([cloud, local], { ...baseRequest, localityPolicy: 'any' });
    expect(result.every((r) => !r.excluded)).toBe(true);
  });

  // ---- other hard filters --------------------------------------------------

  it('excludes a member below the privacy floor', () => {
    const open = makeMember({ id: 'open-member', privacyClass: 'open' });
    const result = rankMembers([open], { ...baseRequest, privacyFloor: 'confidential' });
    expect(result[0].excluded).toMatch(/privacy class/);
  });

  it('excludes a member above the max cost class', () => {
    const premium = makeMember({ id: 'premium-member', costClass: 'premium' });
    const result = rankMembers([premium], { ...baseRequest, maxCostClass: 'medium' });
    expect(result[0].excluded).toMatch(/cost class/);
  });

  it('excludes a member not eligible for the requested role', () => {
    const noRole = makeMember({ id: 'no-role', roleEligibility: [] });
    const result = rankMembers([noRole], { ...baseRequest, roleId: 'reviewer' });
    expect(result[0].excluded).toMatch(/role/);
  });

  it('lower workload is preferred, all else equal', () => {
    const busy = makeMember({ id: 'busy' });
    const idle = makeMember({ id: 'idle' });
    const workloadOf = (id: string) => (id === 'busy' ? 5 : 0);
    const result = rankMembers([busy, idle], baseRequest, workloadOf);
    expect(result[0].member.id).toBe('idle');
  });

  it('lower cost class is preferred, all else equal', () => {
    const cheap = makeMember({ id: 'cheap', costClass: 'free' });
    const expensive = makeMember({ id: 'expensive', costClass: 'high' });
    const result = rankMembers([cheap, expensive], baseRequest);
    expect(result[0].member.id).toBe('cheap');
  });

  it('never grants, escalates, or widens permissions — routing is read-only over grantedCapabilities', () => {
    const member = makeMember({ id: 'm', grantedCapabilities: ['coding'] });
    const before = JSON.stringify(member);
    rankMembers([member], { requiredCapability: 'image', now: NOW });
    expect(JSON.stringify(member)).toBe(before);
  });
});
