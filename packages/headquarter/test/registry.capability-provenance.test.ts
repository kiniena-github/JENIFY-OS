import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HQ_CAPABILITY_STACK,
  getHqCapabilityProvenance,
  type HqCapabilityDescriptor,
} from '../src/registry/capability-stack.js';

describe('fail-closed provenance resolution', () => {
  // Hostile/partial provenance records are cast through `as unknown as` on
  // purpose: they model untyped/config-sourced input the runtime must resolve
  // fail-closed, never to an invented 'reviewed' claim.
  const entry = (overrides: Record<string, unknown> = {}): HqCapabilityDescriptor =>
    ({
      id: 'provenance-fixture', title: 'Provenance Fixture', kind: 'skill', priority: 'core',
      domains: ['coding'], purpose: 'Fixture for provenance resolution.',
      cost: 'free', mode: 'agent_skill', installRequired: true, accountRequired: false,
      ...overrides,
    }) as unknown as HqCapabilityDescriptor;

  const expectUnreviewed = (capability: HqCapabilityDescriptor, label: string) => {
    const resolved = getHqCapabilityProvenance(capability);
    expect(resolved.reviewStatus, label).toBe('unreviewed');
    expect(resolved.reviewedRef, label).toBe('unknown');
  };

  it("resolves 'reviewed' only when status, ref and date are all genuinely recorded", () => {
    const resolved = getHqCapabilityProvenance(entry({
      provenance: { reviewStatus: 'reviewed', reviewedRef: ' abc1234 ', reviewedOn: '2026-08-29' },
    }));
    expect(resolved.reviewStatus).toBe('reviewed');
    expect(resolved.reviewedRef).toBe('abc1234');
  });

  it('falls back to unreviewed/unknown for every partial or blank combination', () => {
    expectUnreviewed(entry(), 'no provenance at all');
    expectUnreviewed(entry({ provenance: {} }), 'empty provenance object');
    // Status alone is not a review — a real review recorded BOTH ref and date.
    expectUnreviewed(entry({ provenance: { reviewStatus: 'reviewed' } }), 'status only');
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'reviewed', reviewedRef: 'abc1234' } }),
      'missing reviewedOn',
    );
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'reviewed', reviewedOn: '2026-08-29' } }),
      'missing reviewedRef',
    );
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'reviewed', reviewedRef: '', reviewedOn: '2026-08-29' } }),
      'blank reviewedRef',
    );
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'reviewed', reviewedRef: '   ', reviewedOn: '2026-08-29' } }),
      'whitespace reviewedRef',
    );
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'reviewed', reviewedRef: 'abc1234', reviewedOn: '' } }),
      'blank reviewedOn',
    );
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'reviewed', reviewedRef: 'abc1234', reviewedOn: '   ' } }),
      'whitespace reviewedOn',
    );
    // A complete ref/date under an 'unreviewed' status is still unreviewed —
    // the recorded status is authoritative, data alone cannot upgrade it.
    expectUnreviewed(
      entry({ provenance: { reviewStatus: 'unreviewed', reviewedRef: 'abc1234', reviewedOn: '2026-08-29' } }),
      'unreviewed status with full data',
    );
  });

  it("resolves upstream from provenance, then the entry's source, then 'unknown'", () => {
    expect(getHqCapabilityProvenance(entry({
      source: 'https://example.test/source',
      provenance: { reviewStatus: 'unreviewed', upstream: 'https://example.test/upstream' },
    })).upstream).toBe('https://example.test/upstream');
    expect(getHqCapabilityProvenance(entry({
      source: 'https://example.test/source',
      provenance: { reviewStatus: 'unreviewed' },
    })).upstream).toBe('https://example.test/source');
    expect(getHqCapabilityProvenance(entry({ source: 'https://example.test/source' })).upstream)
      .toBe('https://example.test/source');
    expect(getHqCapabilityProvenance(entry()).upstream).toBe('unknown');
  });

  it("never lets a real catalog entry claim a 'reviewed' provenance it cannot support", () => {
    for (const capability of HQ_CAPABILITY_STACK) {
      const resolved = getHqCapabilityProvenance(capability);
      if (resolved.reviewStatus === 'reviewed') {
        // Honesty: a resolved review must be backed by a genuinely recorded ref+date.
        const recorded = (capability as HqCapabilityDescriptor).provenance;
        expect(recorded?.reviewStatus, capability.id).toBe('reviewed');
        expect(recorded?.reviewedRef?.trim(), capability.id).toBeTruthy();
        expect(recorded?.reviewedOn?.trim(), capability.id).toBeTruthy();
        expect(resolved.reviewedRef, capability.id).not.toBe('unknown');
      } else {
        expect(resolved.reviewedRef, capability.id).toBe('unknown');
      }
    }
  });
});

describe('project settings truthfulness (.claude/settings.json)', () => {
  // Resolve from this test file's location, not process.cwd(): vitest runs with
  // the package as its root, but the settings file lives at the repo root.
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const settings = JSON.parse(
    readFileSync(resolve(repoRoot, '.claude', 'settings.json'), 'utf8'),
  ) as {
    extraKnownMarketplaces: Record<string, Record<string, unknown>>;
    enabledPlugins: Record<string, unknown>;
  };

  it('declares no autoUpdate on any marketplace entry', () => {
    // Project-scope autoUpdate is not a supported/enforced setting here (#208
    // review) — declaring it would claim an update policy nothing enforces.
    for (const [name, marketplace] of Object.entries(settings.extraKnownMarketplaces)) {
      expect('autoUpdate' in marketplace, name).toBe(false);
    }
  });

  it('states enabled-plugin breadth honestly: 4 collections, far fewer than the catalog', () => {
    const enabled = Object.keys(settings.enabledPlugins).sort();
    // Pin the exact current set so "enabled in project settings" can never be
    // read as "the whole approved catalog is installed."
    expect(enabled).toEqual([
      'example-skills@anthropic-agent-skills',
      'gsap-skills@gsap-skills',
      'product-innovation@wondelai-skills',
      'ux-design@wondelai-skills',
    ]);
    expect(enabled.length).toBeLessThan(HQ_CAPABILITY_STACK.length / 2);
  });

  it('only enables plugins from declared marketplaces', () => {
    const marketplaces = new Set(Object.keys(settings.extraKnownMarketplaces));
    for (const key of Object.keys(settings.enabledPlugins)) {
      const marketplace = key.split('@')[1];
      expect(marketplace, key).toBeTruthy();
      expect(marketplaces.has(marketplace!), key).toBe(true);
    }
  });
});
