import { describe, expect, it } from 'vitest';
import {
  HQ_CAPABILITY_ALIASES,
  HQ_CAPABILITY_RECIPES,
  HQ_CAPABILITY_STACK,
  capabilityMayAutoSelect,
  capabilityRequiresFounderSpendGate,
  getHqCapability,
  normalizeHqCapabilityKey,
  resolveHqCapabilityId,
  type HqCapabilityDescriptor,
} from '../src/registry/capability-stack.js';

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

describe('compute_only Founder spend gate (hostile zeroComputeAssessment inputs)', () => {
  // A compute_only entry that would otherwise auto-select (core priority,
  // non-reference kind, no account, no review gate) — so the ONLY thing standing
  // between it and auto-selection is the zero-compute assessment. Hostile inputs
  // are cast through `as unknown as` on purpose: they model untyped/config-sourced
  // records the compiler would otherwise reject, which is exactly what the
  // runtime gate must survive.
  const computeOnly = (assessment?: unknown): HqCapabilityDescriptor =>
    ({
      id: 'hostile-local-model', title: 'Hostile Local Model', kind: 'model', priority: 'core',
      domains: ['local_ai'], purpose: 'Hostile fixture: compute_only with a suspect assessment.',
      cost: 'compute_only', mode: 'local_model', installRequired: true, accountRequired: false,
      ...(assessment === undefined ? {} : { zeroComputeAssessment: assessment }),
    }) as unknown as HqCapabilityDescriptor;

  const expectGated = (capability: HqCapabilityDescriptor, label: string) => {
    expect(capabilityRequiresFounderSpendGate(capability), `${label} must stay spend-gated`).toBe(true);
    expect(capabilityMayAutoSelect(capability), `${label} must not auto-select`).toBe(false);
  };

  it('stays gated with no assessment at all', () => {
    expectGated(computeOnly(), 'missing assessment');
  });

  it('stays gated with a completely empty assessment object', () => {
    expectGated(computeOnly({}), 'empty assessment');
  });

  it('stays gated when zeroIncrementalCost is missing, false, or truthy-but-not-true', () => {
    const rest = { basis: 'runs on already-owned HQ hardware', recordedOn: '2026-08-29' };
    expectGated(computeOnly({ ...rest }), 'zeroIncrementalCost missing');
    expectGated(computeOnly({ zeroIncrementalCost: false, ...rest }), 'zeroIncrementalCost false');
    // Truthy values that are not literally `true` must not pass an `=== true` gate.
    expectGated(computeOnly({ zeroIncrementalCost: 1, ...rest }), 'zeroIncrementalCost 1');
    expectGated(computeOnly({ zeroIncrementalCost: 'true', ...rest }), "zeroIncrementalCost 'true'");
  });

  it('stays gated when basis is missing or blank', () => {
    const rest = { zeroIncrementalCost: true, recordedOn: '2026-08-29' };
    expectGated(computeOnly({ ...rest }), 'basis missing');
    expectGated(computeOnly({ ...rest, basis: '' }), 'basis empty');
    expectGated(computeOnly({ ...rest, basis: '   ' }), 'basis whitespace-only');
  });

  it('stays gated when recordedOn is missing or blank', () => {
    const rest = { zeroIncrementalCost: true, basis: 'runs on already-owned HQ hardware' };
    expectGated(computeOnly({ ...rest }), 'recordedOn missing');
    expectGated(computeOnly({ ...rest, recordedOn: '' }), 'recordedOn empty');
    expectGated(computeOnly({ ...rest, recordedOn: '   ' }), 'recordedOn whitespace-only');
  });

  it('positive control: a complete assessment lifts the spend gate only', () => {
    const assessed = computeOnly({
      zeroIncrementalCost: true,
      basis: 'runs on already-owned, already-powered HQ hardware',
      recordedOn: '2026-08-29',
    });
    expect(capabilityRequiresFounderSpendGate(assessed)).toBe(false);
    // NOTE: passing the spend gate does NOT imply auto-select on its own —
    // auto-select additionally requires core priority, a non-reference kind,
    // no accountRequired and no reviewBeforeInstall. Same assessment plus an
    // account gate still cannot auto-select:
    const accountGated = { ...assessed, accountRequired: true } as HqCapabilityDescriptor;
    expect(capabilityMayAutoSelect(accountGated)).toBe(false);
  });

  it('gates every real compute_only catalog entry, since none carries an assessment', () => {
    const computeOnlyEntries = HQ_CAPABILITY_STACK.filter((capability) => capability.cost === 'compute_only');
    // Pin the current membership so a new compute_only entry re-triggers scrutiny here.
    expect(computeOnlyEntries.map((capability) => capability.id).sort()).toEqual(['minimax-h3', 'qwen-3-8']);
    for (const capability of computeOnlyEntries) {
      expect('zeroComputeAssessment' in capability, capability.id).toBe(false);
      expect(capabilityRequiresFounderSpendGate(capability), capability.id).toBe(true);
      expect(capabilityMayAutoSelect(capability), capability.id).toBe(false);
    }
  });
});

describe('alias and display-form normalization', () => {
  it('normalizes documented display forms to slug keys', () => {
    expect(normalizeHqCapabilityKey('Magic MCP')).toBe('magic-mcp');
    expect(normalizeHqCapabilityKey('Framer Motion')).toBe('framer-motion');
    expect(normalizeHqCapabilityKey(' 21st MCP ')).toBe('21st-mcp');
    expect(normalizeHqCapabilityKey('framer_motion')).toBe('framer-motion');
    expect(normalizeHqCapabilityKey('FRAMER-Motion')).toBe('framer-motion');
    // Extra internal whitespace collapses to a single hyphen.
    expect(normalizeHqCapabilityKey('Magic \t  MCP')).toBe('magic-mcp');
  });

  it('resolves documented display/legacy forms to real catalog ids', () => {
    expect(resolveHqCapabilityId('Magic MCP')).toBe('21st-mcp');
    expect(resolveHqCapabilityId('Framer Motion')).toBe('motion');
    expect(resolveHqCapabilityId(' 21st MCP ')).toBe('21st-mcp');
    expect(resolveHqCapabilityId('framer_motion')).toBe('motion');
    expect(resolveHqCapabilityId('CLAUDE CODE')).toBe('claude-code');
  });

  it('resolves unknown names to null instead of fabricating a capability', () => {
    for (const unknown of ['Photoshop', 'totally-unknown-tool', '', '   ']) {
      expect(resolveHqCapabilityId(unknown), JSON.stringify(unknown)).toBeNull();
      expect(getHqCapability(unknown), JSON.stringify(unknown)).toBeNull();
    }
  });

  it('keeps every alias pointed at a real catalog id', () => {
    const ids = new Set<string>(HQ_CAPABILITY_STACK.map((capability) => capability.id));
    for (const [alias, target] of Object.entries(HQ_CAPABILITY_ALIASES)) {
      expect(ids.has(target), `${alias} -> ${target}`).toBe(true);
      // Aliases map away from stale names — an alias key must not shadow a real id.
      expect(ids.has(alias), alias).toBe(false);
    }
  });
});

describe('recipe fallback reachability', () => {
  it('keeps research.deep runnable without the community/experimental NotebookLM MCP', () => {
    const stages = HQ_CAPABILITY_RECIPES['research.deep'];
    const required = stages.filter((stage) => stage.optional !== true);
    expect(required.length).toBeGreaterThan(0);
    // NotebookLM may only ever appear in optional stages — the documented
    // fallback (the ordinary approved research route) must be reachable
    // through the catalog even when NotebookLM is unavailable.
    for (const stage of stages) {
      if (stage.capabilityIds.includes('notebooklm-mcp')) {
        expect(stage.optional, stage.name).toBe(true);
      }
    }
    for (const stage of required) {
      expect(stage.capabilityIds).not.toContain('notebooklm-mcp');
    }
  });

  it('never makes a required stage depend solely on a review-first/experimental/community-account capability', () => {
    // "Gated" here means the capability is a normal state to be unavailable:
    // review-before-install, experimental, or a community tool behind an
    // account. (First-party account-gated core tools like claude-code are the
    // routed workers themselves, not the fallback concern.) Every required
    // stage containing such a capability must offer an ungated alternative in
    // the same stage, so the recipe stays reachable without it.
    const isGated = (capability: HqCapabilityDescriptor) =>
      capability.reviewBeforeInstall === true ||
      capability.experimental === true ||
      (capability.community === true && capability.accountRequired);
    for (const [intent, stages] of Object.entries(HQ_CAPABILITY_RECIPES)) {
      for (const stage of stages) {
        if (stage.optional === true) continue;
        const capabilities = stage.capabilityIds.map((id) => getHqCapability(id)!);
        if (!capabilities.some(isGated)) continue;
        expect(
          capabilities.some((capability) => !isGated(capability)),
          `${intent}/${stage.name} requires a gated capability with no ungated alternative`,
        ).toBe(true);
      }
    }
  });
});
