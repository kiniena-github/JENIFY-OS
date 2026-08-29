import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  HQ_CAPABILITY_STACK,
  getHqCapabilityProvenance,
} from '../src/registry/capability-stack.js';

// Resolve the repo root from this test file's location, never from the CWD,
// so the pins hold no matter where the suite is launched from.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SETTINGS_PATH = join(REPO_ROOT, '.claude', 'settings.json');

function collectKeys(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.push(key);
      collectKeys(child, found);
    }
  }
  return found;
}

describe('project settings truthfulness (.claude/settings.json)', () => {
  const raw = readFileSync(SETTINGS_PATH, 'utf8');

  it('is valid JSON', () => {
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("carries no 'autoUpdate' key anywhere (unsupported at project scope)", () => {
    const settings = JSON.parse(raw) as unknown;
    expect(collectKeys(settings)).not.toContain('autoUpdate');
    // Belt and braces: not even as a raw token someone re-adds in a comment-like form.
    expect(raw).not.toContain('autoUpdate');
  });

  it('enables exactly the four plugins the routing rule claims are enabled', () => {
    const settings = JSON.parse(raw) as { enabledPlugins?: Record<string, boolean> };
    const enabled = Object.entries(settings.enabledPlugins ?? {})
      .filter(([, on]) => on === true)
      .map(([name]) => name)
      .sort();
    expect(enabled).toEqual([
      'example-skills@anthropic-agent-skills',
      'gsap-skills@gsap-skills',
      'product-innovation@wondelai-skills',
      'ux-design@wondelai-skills',
    ]);
  });
});

describe('catalog provenance truthfulness', () => {
  it("resolves every entry to 'unreviewed' unless a genuinely complete review record exists", () => {
    for (const capability of HQ_CAPABILITY_STACK) {
      const recorded = (capability as { provenance?: unknown }).provenance as
        | { reviewStatus?: unknown; reviewedRef?: unknown; reviewedOn?: unknown }
        | undefined;
      const genuinelyComplete =
        recorded?.reviewStatus === 'reviewed' &&
        typeof recorded.reviewedRef === 'string' &&
        recorded.reviewedRef.trim().length > 0 &&
        typeof recorded.reviewedOn === 'string' &&
        recorded.reviewedOn.trim().length > 0;
      const resolved = getHqCapabilityProvenance(capability);
      expect(resolved.reviewStatus, capability.id).toBe(
        genuinelyComplete ? 'reviewed' : 'unreviewed',
      );
      if (!genuinelyComplete) {
        expect(resolved.reviewedRef, capability.id).toBe('unknown');
      }
    }
  });

  it('currently carries no reviewed upstream ref on any entry, as the routing rule states', () => {
    // This pins the routing rule's honest claim. If a real review ever records
    // a complete ref+date on an entry, update .claude/rules/hq-capability-routing.md
    // in the same change — do not delete this test to hide the drift.
    for (const capability of HQ_CAPABILITY_STACK) {
      expect(getHqCapabilityProvenance(capability).reviewStatus, capability.id).toBe('unreviewed');
    }
  });
});
