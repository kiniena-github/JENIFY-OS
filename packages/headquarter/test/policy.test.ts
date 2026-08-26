import { beforeEach, describe, expect, it } from 'vitest';
import { openMemoryHqDatabase, type HqDatabase } from '../src/store/db.js';
import { CapabilityRegistry } from '../src/operator/capabilities.js';
import { evaluatePolicy } from '../src/operator/policy.js';

const worker = (caps: string[]) => ({ workerId: 'claude', allowedCapabilities: caps });

describe('policy risk gates', () => {
  let db: HqDatabase;
  let registry: CapabilityRegistry;

  beforeEach(() => {
    db = openMemoryHqDatabase();
    registry = new CapabilityRegistry(db);
    registry.register({
      id: 'repo.read_status',
      description: 'Read repo/CI status',
      riskClass: 'read_only',
      sideEffect: false,
      idempotent: true,
    });
    registry.register({
      id: 'github.open_pr',
      description: 'Open a branch-isolated PR',
      riskClass: 'external_side_effect',
      sideEffect: true,
      idempotent: true,
    });
    registry.register({
      id: 'dns.change_production',
      description: 'Change production DNS',
      riskClass: 'founder_gate',
      sideEffect: true,
      idempotent: false,
    });
  });

  it('denies unknown capabilities by default', () => {
    const d = evaluatePolicy(registry.get('nope'), worker(['nope']));
    expect(d.outcome).toBe('deny');
  });

  it('denies workers outside their allow-list (least privilege)', () => {
    const d = evaluatePolicy(registry.get('repo.read_status'), worker([]));
    expect(d.outcome).toBe('deny');
  });

  it('allows read-only capabilities for allowed workers', () => {
    const d = evaluatePolicy(registry.get('repo.read_status'), worker(['repo.read_status']));
    expect(d.outcome).toBe('allow');
  });

  it('gates external side effects on approval without standing pre-approval', () => {
    const d = evaluatePolicy(registry.get('github.open_pr'), worker(['github.open_pr']));
    expect(d.outcome).toBe('needs_approval');
  });

  it('honors Founder standing pre-approval for a specific capability', () => {
    const d = evaluatePolicy(registry.get('github.open_pr'), worker(['github.open_pr']), {
      preApprovedCapabilities: new Set(['github.open_pr']),
    });
    expect(d.outcome).toBe('allow');
  });

  it('founder-gated capabilities always need approval, even when pre-approved', () => {
    const d = evaluatePolicy(registry.get('dns.change_production'), worker(['dns.change_production']), {
      preApprovedCapabilities: new Set(['dns.change_production']),
    });
    expect(d.outcome).toBe('needs_approval');
  });

  it('denies disabled capabilities', () => {
    registry.setEnabled('repo.read_status', false);
    const d = evaluatePolicy(registry.get('repo.read_status'), worker(['repo.read_status']));
    expect(d.outcome).toBe('deny');
  });

  it('refuses to register a read_only capability with side effects', () => {
    expect(() =>
      registry.register({
        id: 'bad.cap',
        description: 'contradictory',
        riskClass: 'read_only',
        sideEffect: true,
        idempotent: true,
      }),
    ).toThrow(/cannot be read_only/);
  });
});
