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
} from '../src/registry/capability-stack.js';
import type { HqCapabilityCost } from '../src/registry/capability-stack.js';

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

describe('the Founder spend gate fails closed', () => {
  it('gates compute_only, because free weights are not free compute', () => {
    const computeOnly = HQ_CAPABILITY_STACK.filter((c) => c.cost === 'compute_only');
    expect(computeOnly.length).toBeGreaterThan(0);
    for (const capability of computeOnly) {
      expect(capabilityRequiresFounderSpendGate(capability), capability.id).toBe(true);
      expect(capabilityMayAutoSelect(capability), capability.id).toBe(false);
    }
  });

  it('gates an unrecognized future cost tier rather than letting it through', () => {
    const unknownCost = {
      ...HQ_CAPABILITY_STACK[0],
      cost: 'some_tier_invented_next_year' as HqCapabilityCost,
    };
    expect(capabilityRequiresFounderSpendGate(unknownCost)).toBe(true);
    expect(capabilityMayAutoSelect(unknownCost)).toBe(false);
  });

  it('still lets genuinely free and already-subscribed tiers through', () => {
    for (const cost of ['free', 'free_tier', 'existing_subscription'] as const) {
      expect(capabilityRequiresFounderSpendGate({ ...HQ_CAPABILITY_STACK[0], cost })).toBe(false);
    }
  });

  it('gates every remaining declared cost tier', () => {
    for (const cost of ['paid_optional', 'usage_billed', 'compute_only', 'mixed'] as const) {
      expect(capabilityRequiresFounderSpendGate({ ...HQ_CAPABILITY_STACK[0], cost }), cost).toBe(true);
    }
  });
});

describe('deep research does not depend on an unauthenticated community MCP', () => {
  it('makes NotebookLM optional and keeps an approved non-optional path', () => {
    const stages = HQ_CAPABILITY_RECIPES['research.deep'];
    const notebookStages = stages.filter((s) => s.capabilityIds.includes('notebooklm-mcp'));
    for (const stage of notebookStages) expect(stage.optional, stage.name).toBe(true);

    const required = stages.filter((s) => !s.optional);
    expect(required.length).toBeGreaterThan(0);
    for (const stage of required) {
      expect(stage.capabilityIds).not.toContain('notebooklm-mcp');
    }
  });

  it('never leaves an intent whose only required capability is account-gated and experimental', () => {
    for (const [intent, stages] of Object.entries(HQ_CAPABILITY_RECIPES)) {
      for (const stage of stages.filter((s) => !s.optional)) {
        const allExperimental = stage.capabilityIds.every(
          (id) => getHqCapability(id)?.experimental === true,
        );
        expect(allExperimental, `${intent}/${stage.name}`).toBe(false);
      }
    }
  });
});

describe('capability names resolve in the form humans actually write them', () => {
  it('resolves the documented legacy display forms', () => {
    expect(resolveHqCapabilityId('Magic MCP')).toBe('21st-mcp');
    expect(resolveHqCapabilityId('Framer Motion')).toBe('motion');
  });

  it('resolves slug, spaced, underscored and padded forms identically', () => {
    for (const form of ['magic-mcp', 'Magic MCP', 'magic_mcp', '  MAGIC   MCP  ']) {
      expect(resolveHqCapabilityId(form), form).toBe('21st-mcp');
    }
  });

  it('still resolves plain ids and still rejects unknown names', () => {
    expect(resolveHqCapabilityId('21st-mcp')).toBe('21st-mcp');
    expect(resolveHqCapabilityId('Claude Code')).toBe('claude-code');
    expect(resolveHqCapabilityId('not-a-capability')).toBeNull();
    expect(resolveHqCapabilityId('')).toBeNull();
  });

  it('normalizes without collapsing two distinct capabilities onto one key', () => {
    const keys = HQ_CAPABILITY_STACK.map((c) => normalizeHqCapabilityKey(c.id));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never lets an alias shadow a real capability id', () => {
    const ids = new Set(HQ_CAPABILITY_STACK.map((c) => normalizeHqCapabilityKey(c.id)));
    for (const [alias, target] of Object.entries(HQ_CAPABILITY_ALIASES)) {
      const key = normalizeHqCapabilityKey(alias);
      if (ids.has(key)) expect(resolveHqCapabilityId(alias), alias).toBe(key);
      else expect(resolveHqCapabilityId(alias), alias).toBe(target);
    }
  });
});
