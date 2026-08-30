import { describe, expect, it } from 'vitest';
import {
  HQ_CAPABILITY_ALIASES,
  HQ_CAPABILITY_RECIPES,
  HQ_CAPABILITY_STACK,
  capabilityMayAutoSelect,
  capabilityRequiresFounderSpendGate,
  getHqCapability,
  getHqCapabilityProvenance,
  normalizeHqCapabilityKey,
  resolveHqCapabilityId,
  type HqCapabilityDescriptor,
} from '../src/registry/capability-stack.js';

/**
 * Synthetic, otherwise auto-selectable compute_only entry. Malformed
 * assessments are cast through `unknown` on purpose: the descriptor can be
 * populated from untyped config, and the fail-closed rule must hold for
 * shapes the type system would normally reject.
 */
function computeOnlyEntry(zeroComputeAssessment?: unknown): HqCapabilityDescriptor {
  const entry = {
    id: 'synthetic-local-model',
    title: 'Synthetic Local Model',
    kind: 'model',
    priority: 'core',
    domains: ['local_ai'],
    purpose: 'Synthetic compute-only entry for spend-gate regression tests.',
    cost: 'compute_only',
    mode: 'local_model',
    installRequired: true,
    accountRequired: false,
    ...(arguments.length > 0 ? { zeroComputeAssessment } : {}),
  };
  return entry as unknown as HqCapabilityDescriptor;
}

const COMPLETE_ASSESSMENT = {
  zeroIncrementalCost: true,
  basis: 'Runs on already-owned, already-powered local HQ hardware.',
  recordedOn: '2026-08-29',
} as const;

describe('HQ approved capability catalog', () => {
  it('uses unique stable ids', () => {
    const ids = HQ_CAPABILITY_STACK.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not pretend policy approval is live connection evidence', () => {
    for (const capability of HQ_CAPABILITY_STACK) {
      expect('connected' in capability).toBe(false);
      expect('connectionState' in capability).toBe(false);
      expect('lastVerifiedAt' in capability).toBe(false);
    }
  });

  it('maps deprecated names to current tools instead of duplicating them', () => {
    expect(HQ_CAPABILITY_ALIASES['magic-mcp']).toBe('21st-mcp');
    expect(resolveHqCapabilityId('magic-mcp')).toBe('21st-mcp');
    expect(getHqCapability('magic-mcp')?.title).toBe('21st MCP');
    expect(resolveHqCapabilityId('framer-motion')).toBe('motion');
  });

  it('never auto-selects billable, mixed-cost, account-required, or review-first tools', () => {
    for (const capability of HQ_CAPABILITY_STACK) {
      const reviewFirst =
        'reviewBeforeInstall' in capability && capability.reviewBeforeInstall === true;
      if (
        capabilityRequiresFounderSpendGate(capability) ||
        capability.accountRequired ||
        reviewFirst
      ) {
        expect(capabilityMayAutoSelect(capability), capability.id).toBe(false);
      }
    }
  });

  it('keeps design-reference sites as manual references rather than connectors', () => {
    for (const id of ['mobbin', 'awwwards', 'cosmos', 'pinterest', 'namethatui'] as const) {
      const capability = getHqCapability(id);
      expect(capability?.kind).toBe('reference');
      expect(capability?.mode).toBe('web_reference');
    }
  });

  it('encodes the approved premium web workflow in the correct order', () => {
    const stages = HQ_CAPABILITY_RECIPES['web.build'];
    expect(stages.map((stage) => stage.name)).toEqual([
      'reference', 'design', 'components', 'animation', 'build', 'audit',
    ]);
    expect(stages.find((stage) => stage.name === 'design')?.capabilityIds).toEqual([
      'frontend-design', 'ui-ux-pro-max',
    ]);
    expect(stages.find((stage) => stage.name === 'audit')?.capabilityIds).toEqual([
      'refactoring-ui', 'ux-heuristics',
    ]);
  });

  it('only references registered capability ids from recipes', () => {
    const ids = new Set(HQ_CAPABILITY_STACK.map((capability) => capability.id));
    for (const stages of Object.values(HQ_CAPABILITY_RECIPES)) {
      for (const stage of stages) {
        for (const id of stage.capabilityIds) expect(ids.has(id), id).toBe(true);
      }
    }
  });

  it('keeps NotebookLM community/experimental and review-first', () => {
    const notebook = getHqCapability('notebooklm-mcp');
    expect(notebook?.community).toBe(true);
    expect(notebook?.experimental).toBe(true);
    expect(notebook?.reviewBeforeInstall).toBe(true);
    expect(notebook?.accountRequired).toBe(true);
  });

  it('keeps Hyliox optional and gated rather than a required dependency', () => {
    const hyliox = getHqCapability('hyliox');
    expect(hyliox?.priority).toBe('later');
    expect(hyliox?.cost).toBe('paid_optional');
    expect(hyliox?.reviewBeforeInstall).toBe(true);
  });
});

describe('compute_only Founder spend gate (fail closed)', () => {
  const hostileCases: readonly [label: string, entry: HqCapabilityDescriptor][] = [
    ['no zeroComputeAssessment at all', computeOnlyEntry()],
    ['zeroComputeAssessment: {}', computeOnlyEntry({})],
    ['zeroComputeAssessment: null', computeOnlyEntry(null)],
    ['zeroComputeAssessment: undefined value', computeOnlyEntry(undefined)],
    [
      'zeroIncrementalCost missing',
      computeOnlyEntry({ basis: 'local hardware', recordedOn: '2026-08-29' }),
    ],
    [
      'zeroIncrementalCost: false',
      computeOnlyEntry({ ...COMPLETE_ASSESSMENT, zeroIncrementalCost: false }),
    ],
    [
      "zeroIncrementalCost: the string 'true'",
      computeOnlyEntry({ ...COMPLETE_ASSESSMENT, zeroIncrementalCost: 'true' }),
    ],
    [
      'zeroIncrementalCost: 1',
      computeOnlyEntry({ ...COMPLETE_ASSESSMENT, zeroIncrementalCost: 1 }),
    ],
    [
      'zeroIncrementalCost: truthy object, not literal true',
      computeOnlyEntry({ ...COMPLETE_ASSESSMENT, zeroIncrementalCost: { assessed: true } }),
    ],
    [
      'basis missing',
      computeOnlyEntry({ zeroIncrementalCost: true, recordedOn: '2026-08-29' }),
    ],
    ['basis: empty string', computeOnlyEntry({ ...COMPLETE_ASSESSMENT, basis: '' })],
    ['basis: whitespace only', computeOnlyEntry({ ...COMPLETE_ASSESSMENT, basis: '   ' })],
    [
      'recordedOn missing',
      computeOnlyEntry({ zeroIncrementalCost: true, basis: 'local hardware' }),
    ],
    ['recordedOn: empty string', computeOnlyEntry({ ...COMPLETE_ASSESSMENT, recordedOn: '' })],
    [
      'recordedOn: whitespace only',
      computeOnlyEntry({ ...COMPLETE_ASSESSMENT, recordedOn: ' \t ' }),
    ],
  ];

  it.each(hostileCases)('stays gated and never auto-selects with %s', (_label, entry) => {
    expect(capabilityRequiresFounderSpendGate(entry)).toBe(true);
    expect(capabilityMayAutoSelect(entry)).toBe(false);
  });

  it('releases the gate only for a genuinely complete assessment (positive control)', () => {
    const assessed = computeOnlyEntry(COMPLETE_ASSESSMENT);
    expect(capabilityRequiresFounderSpendGate(assessed)).toBe(false);
    expect(capabilityMayAutoSelect(assessed)).toBe(true);
  });

  it('does not let a complete assessment bypass the account or review gates', () => {
    const accountGated = {
      ...computeOnlyEntry(COMPLETE_ASSESSMENT),
      accountRequired: true,
    } as HqCapabilityDescriptor;
    expect(capabilityRequiresFounderSpendGate(accountGated)).toBe(false);
    expect(capabilityMayAutoSelect(accountGated)).toBe(false);

    const reviewGated = {
      ...computeOnlyEntry(COMPLETE_ASSESSMENT),
      reviewBeforeInstall: true,
    } as HqCapabilityDescriptor;
    expect(capabilityRequiresFounderSpendGate(reviewGated)).toBe(false);
    expect(capabilityMayAutoSelect(reviewGated)).toBe(false);
  });
});

describe('capability provenance resolution (fail closed)', () => {
  const base = (): HqCapabilityDescriptor => computeOnlyEntry();

  it('resolves absent provenance to unreviewed with upstream from source', () => {
    const withSource = {
      ...base(),
      source: 'https://example.invalid/upstream',
    } as HqCapabilityDescriptor;
    expect(getHqCapabilityProvenance(withSource)).toEqual({
      upstream: 'https://example.invalid/upstream',
      reviewedRef: 'unknown',
      reviewStatus: 'unreviewed',
    });
  });

  it("resolves absent provenance and absent source to 'unknown'", () => {
    expect(getHqCapabilityProvenance(base())).toEqual({
      upstream: 'unknown',
      reviewedRef: 'unknown',
      reviewStatus: 'unreviewed',
    });
  });

  it("never reads 'reviewed' from a partial or blank review record", () => {
    const partials: readonly unknown[] = [
      { reviewStatus: 'reviewed' },
      { reviewStatus: 'reviewed', reviewedRef: 'v1.2.3' },
      { reviewStatus: 'reviewed', reviewedOn: '2026-08-29' },
      { reviewStatus: 'reviewed', reviewedRef: '', reviewedOn: '2026-08-29' },
      { reviewStatus: 'reviewed', reviewedRef: '   ', reviewedOn: '2026-08-29' },
      { reviewStatus: 'reviewed', reviewedRef: 'v1.2.3', reviewedOn: '' },
      { reviewStatus: 'reviewed', reviewedRef: 'v1.2.3', reviewedOn: '  ' },
    ];
    for (const provenance of partials) {
      const entry = { ...base(), provenance } as unknown as HqCapabilityDescriptor;
      const resolved = getHqCapabilityProvenance(entry);
      expect(resolved.reviewStatus, JSON.stringify(provenance)).toBe('unreviewed');
      expect(resolved.reviewedRef, JSON.stringify(provenance)).toBe('unknown');
    }
  });

  it('prefers a recorded upstream over the source fallback', () => {
    const entry = {
      ...base(),
      source: 'https://example.invalid/source',
      provenance: { upstream: 'https://example.invalid/real-upstream', reviewStatus: 'unreviewed' },
    } as HqCapabilityDescriptor;
    expect(getHqCapabilityProvenance(entry).upstream).toBe('https://example.invalid/real-upstream');
  });

  it("reads 'reviewed' only from a genuinely complete record, trimming the ref", () => {
    const entry = {
      ...base(),
      provenance: {
        upstream: 'https://example.invalid/upstream',
        reviewStatus: 'reviewed',
        reviewedRef: '  v1.2.3  ',
        reviewedOn: '2026-08-29',
      },
    } as HqCapabilityDescriptor;
    expect(getHqCapabilityProvenance(entry)).toEqual({
      upstream: 'https://example.invalid/upstream',
      reviewedRef: 'v1.2.3',
      reviewStatus: 'reviewed',
    });
  });

  it('never presents provenance as install/connection evidence', () => {
    const entry = {
      ...base(),
      provenance: {
        reviewStatus: 'reviewed',
        reviewedRef: 'v1.2.3',
        reviewedOn: '2026-08-29',
        connected: true,
        enabled: true,
      },
    } as unknown as HqCapabilityDescriptor;
    const resolved = getHqCapabilityProvenance(entry);
    expect(Object.keys(resolved).sort()).toEqual(['reviewStatus', 'reviewedRef', 'upstream']);
    expect('connected' in resolved).toBe(false);
    expect('enabled' in resolved).toBe(false);
    expect('installed' in resolved).toBe(false);
  });
});

describe('display-form alias normalization', () => {
  it('resolves documented display forms to the current catalog ids', () => {
    expect(getHqCapability('Magic MCP')?.id).toBe('21st-mcp');
    expect(resolveHqCapabilityId('Framer Motion')).toBe('motion');
  });

  it('resolves spacing, underscore and case variants', () => {
    for (const variant of ['magic_mcp', '  MAGIC   MCP  ', 'Magic_MCP', 'MAGIC-MCP']) {
      expect(resolveHqCapabilityId(variant), variant).toBe('21st-mcp');
    }
    for (const variant of ['framer_motion', 'FRAMER  MOTION', ' Framer_Motion ']) {
      expect(resolveHqCapabilityId(variant), variant).toBe('motion');
    }
    expect(resolveHqCapabilityId('21st MCP')).toBe('21st-mcp');
    expect(getHqCapability(' 21ST_MCP ')?.id).toBe('21st-mcp');
  });
});

describe('research.deep recipe reachability', () => {
  it('keeps the account-gated NotebookLM stage optional', () => {
    const stages = HQ_CAPABILITY_RECIPES['research.deep'];
    const notebookStages = stages.filter((stage) =>
      stage.capabilityIds.includes('notebooklm-mcp'),
    );
    expect(notebookStages.length).toBeGreaterThan(0);
    for (const stage of notebookStages) expect(stage.optional).toBe(true);
  });

  it('keeps an approved fallback reachable through a non-optional stage', () => {
    const stages = HQ_CAPABILITY_RECIPES['research.deep'];
    // At least one required stage must be usable through already-approved
    // means: no Founder spend gate, no review-before-install, not
    // experimental/community, and not the account-gated NotebookLM path.
    const reachableFallbacks = stages.filter(
      (stage) =>
        stage.optional !== true &&
        stage.capabilityIds.length > 0 &&
        stage.capabilityIds.every((id) => {
          const capability = getHqCapability(id);
          return (
            capability !== null &&
            id !== 'notebooklm-mcp' &&
            !capabilityRequiresFounderSpendGate(capability) &&
            capability.reviewBeforeInstall !== true &&
            capability.experimental !== true &&
            capability.community !== true
          );
        }),
    );
    expect(reachableFallbacks.length).toBeGreaterThan(0);
  });
});

// The blocks above pin the corrected behaviours themselves. These pin the
// catalog's own integrity — the assumptions those blocks rest on, which would
// otherwise drift silently as entries are added.

describe('catalog integrity the corrections rest on', () => {
  it('normalizes display forms to slug keys at the key layer, not just via lookup', () => {
    // There is no other normalization layer, so this function IS the contract
    // for documented display-form names.
    expect(normalizeHqCapabilityKey('Magic MCP')).toBe('magic-mcp');
    expect(normalizeHqCapabilityKey(' 21st MCP ')).toBe('21st-mcp');
    expect(normalizeHqCapabilityKey('framer_motion')).toBe('framer-motion');
    expect(normalizeHqCapabilityKey('FRAMER \t Motion')).toBe('framer-motion');
  });

  it('resolves an unknown name to null instead of fabricating a capability', () => {
    // Fail-closed at the lookup boundary: a name HQ does not know must not
    // resolve to a neighbouring entry or an empty descriptor.
    for (const unknown of ['Photoshop', 'totally-unknown-tool', '', '   ']) {
      expect(resolveHqCapabilityId(unknown), JSON.stringify(unknown)).toBeNull();
      expect(getHqCapability(unknown), JSON.stringify(unknown)).toBeNull();
    }
  });

  it('keeps every alias pointed at a real id, and never shadowing one', () => {
    const ids = new Set<string>(HQ_CAPABILITY_STACK.map((capability) => capability.id));
    for (const [alias, target] of Object.entries(HQ_CAPABILITY_ALIASES)) {
      expect(ids.has(target), `${alias} -> ${target}`).toBe(true);
      // An alias maps AWAY from a stale name; if it also named a real entry the
      // alias branch would silently win over the real one.
      expect(ids.has(alias), alias).toBe(false);
    }
  });

  it('pins which entries are compute_only, and that none yet carries an assessment', () => {
    // A new compute_only entry must re-trigger scrutiny here rather than
    // inheriting the gate silently.
    const computeOnly = HQ_CAPABILITY_STACK.filter((capability) => capability.cost === 'compute_only');
    expect(computeOnly.map((capability) => capability.id).sort()).toEqual(['minimax-h3', 'qwen-3-8']);
    for (const capability of computeOnly) {
      expect('zeroComputeAssessment' in capability, capability.id).toBe(false);
      expect(capabilityRequiresFounderSpendGate(capability), capability.id).toBe(true);
    }
  });

  it('never leaves any recipe depending solely on a normally-unavailable capability', () => {
    // Generalizes the research.deep property to the whole catalog. "Gated"
    // means it is a normal state to be unavailable: review-before-install,
    // experimental, or a community tool behind an account. (First-party
    // account-gated core tools like claude-code are the routed workers
    // themselves, not the fallback concern.) Every required stage holding one
    // must offer an ungated alternative in the same stage.
    const isGated = (capability: HqCapabilityDescriptor) =>
      capability.reviewBeforeInstall === true ||
      capability.experimental === true ||
      (capability.community === true && capability.accountRequired === true);

    for (const [intent, stages] of Object.entries(HQ_CAPABILITY_RECIPES)) {
      for (const stage of stages) {
        if (stage.optional === true) continue;
        const resolved = stage.capabilityIds
          .map((id) => getHqCapability(id))
          .filter((capability): capability is HqCapabilityDescriptor => capability !== null);
        if (!resolved.some(isGated)) continue;
        expect(
          resolved.some((capability) => !isGated(capability)),
          `${intent}/${stage.name} has no ungated alternative`,
        ).toBe(true);
      }
    }
  });
});
