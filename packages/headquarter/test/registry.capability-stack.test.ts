import { describe, expect, it } from 'vitest';
import {
  HQ_CAPABILITY_ALIASES,
  HQ_CAPABILITY_RECIPES,
  HQ_CAPABILITY_STACK,
  capabilityMayAutoSelect,
  capabilityRequiresFounderSpendGate,
  getHqCapability,
  resolveHqCapabilityId,
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
      if (
        capabilityRequiresFounderSpendGate(capability) ||
        capability.accountRequired ||
        capability.reviewBeforeInstall
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
