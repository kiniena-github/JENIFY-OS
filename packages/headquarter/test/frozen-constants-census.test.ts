/// <reference types="vite/client" />
/**
 * Wave 5, correction round seven — MEDIUM NEW-5: the freeze census enumerates
 * `src/`, not `package.json#exports`.
 *
 * The shipped pinning test (`reliability-verdict-durability.test.ts`) walks the
 * sixteen public entry points and asserts every exported ALL-CAPS object is
 * frozen. That is a real property and it stays; what it CANNOT see is a module
 * that is not re-exported from an entry point — and that is where the unfrozen
 * count regrew to 26 distinct bindings over 225.
 *
 * The load-bearing one was `PROJECT_ALLOWED_TRANSITIONS`
 * (`src/contracts/project.ts`), which `canTransitionProject` is the gate at
 * `service.ts`'s project-transition path: `PROJECT_ALLOWED_TRANSITIONS.active
 * .length = 0` flips `canTransitionProject('active', 'closed')` from true to
 * false. That direction is narrowing — a local denial of service on a Founder
 * act rather than an authority widening — and it is stated as what it is rather
 * than dressed up. The other 24 are `ui/spatial/*` floor geometry and
 * presentation maps, the two `providers/codex/*` closed vocabularies and the
 * review schema, `providers/claude/*`'s evidence-kind map and repo-slug
 * pattern, and `ui/control-console.ts`'s fetch allow-list: presentation and
 * lane-local contracts, none of them an authority gate, and they are frozen
 * anyway because "this one is on the enforcement path and that one is not" is
 * exactly the judgement that goes stale.
 *
 * Separately, `deepFreeze`'s "It freezes ALL THE WAY DOWN" was not true of a
 * `Set` or a `Map`: entries are not own properties, so a frozen
 * `QUEUED_UNREACHABLE_STATUSES` accepted `.delete()` and `.add()` and
 * `QUERY_STOPWORDS` accepted `.clear()`. Both are pinned below.
 */

import { describe, expect, it } from 'vitest';

/**
 * Every module under `src/`, by enumeration.
 *
 * `src/cli/**` is excluded: those modules read `process.argv` and open
 * databases at import time, so importing them here would execute a CLI rather
 * than inspect a constant. They export no vocabulary any decision in the
 * package reads — a CLI is a caller of this package, not a gate inside it.
 */
const MODULES = import.meta.glob('../src/**/*.ts');

describe('every exported closed vocabulary in src/ is frozen, by enumeration over the tree', () => {
  it('finds no unfrozen ALL-CAPS export in any module, re-exported or not', async () => {
    const seen = new Set<object>();
    const unfrozen: string[] = [];
    let files = 0;
    for (const [path, load] of Object.entries(MODULES)) {
      if (path.startsWith('../src/cli/')) continue;
      files += 1;
      const namespace = (await load()) as Record<string, unknown>;
      for (const [name, value] of Object.entries(namespace)) {
        // ALL-CAPS is how this package spells a declared constant; an object or
        // an array is what a `length = 0` or a property rewrite can reach.
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
        if (value == null || typeof value !== 'object') continue;
        // Deduped by object IDENTITY, so a re-export is one binding and not two.
        if (seen.has(value as object)) continue;
        seen.add(value as object);
        if (!Object.isFrozen(value)) unfrozen.push(`${name} @ ${path}`);
      }
    }
    expect(unfrozen).toEqual([]);
    // Floors, so a narrowing of the enumeration is visible rather than quietly
    // passing over an empty set. 131 modules and 225 distinct bindings at this
    // head; the entry-point scan reaches 202 of them.
    expect(files).toBeGreaterThanOrEqual(131);
    expect(seen.size).toBeGreaterThanOrEqual(225);
  });

  it('freezes the gate the entry-point scan could not see', async () => {
    const { PROJECT_ALLOWED_TRANSITIONS, PROJECT_STATUSES, canTransitionProject } = await import(
      '../src/contracts/project.js'
    );
    expect(canTransitionProject('active', 'closed')).toBe(true);
    // The exploit itself, not only `Object.isFrozen`. Under ESM — always strict
    // — the write THROWS.
    expect(() => {
      (PROJECT_ALLOWED_TRANSITIONS.active as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
    expect(() => {
      (PROJECT_ALLOWED_TRANSITIONS as unknown as Record<string, unknown>).active = [];
    }).toThrow(TypeError);
    expect(() => {
      (PROJECT_STATUSES as unknown as { length: number }).length = 0;
    }).toThrow(TypeError);
    expect(canTransitionProject('active', 'closed')).toBe(true);
    expect(canTransitionProject('closed', 'active')).toBe(true);
  });
});

describe('a frozen Set or Map is frozen in its CONTENTS, not only in its shape', () => {
  it('refuses add, delete and clear on the vocabulary a task’s reachability is decided by', async () => {
    const { QUEUED_UNREACHABLE_STATUSES } = await import('../src/contracts/events.js');
    expect(Object.isFrozen(QUEUED_UNREACHABLE_STATUSES)).toBe(true);
    const before = [...QUEUED_UNREACHABLE_STATUSES].sort();
    expect(before.length).toBeGreaterThan(0);
    const member = before[0]!;
    for (const attempt of [
      () => (QUEUED_UNREACHABLE_STATUSES as unknown as Set<string>).delete(member),
      () => (QUEUED_UNREACHABLE_STATUSES as unknown as Set<string>).add('queued'),
      () => (QUEUED_UNREACHABLE_STATUSES as unknown as Set<string>).clear(),
    ]) {
      expect(attempt).toThrow(TypeError);
    }
    // Reading is untouched: a vocabulary exists to be read.
    expect([...QUEUED_UNREACHABLE_STATUSES].sort()).toEqual(before);
    expect(QUEUED_UNREACHABLE_STATUSES.has(member)).toBe(true);
  });

  it('refuses the same on the retrieval stopword set', async () => {
    const { QUERY_STOPWORDS } = await import('../src/application/search-command.js');
    const before = QUERY_STOPWORDS.size;
    expect(before).toBeGreaterThan(0);
    expect(() => (QUERY_STOPWORDS as unknown as Set<string>).clear()).toThrow(TypeError);
    expect(() => (QUERY_STOPWORDS as unknown as Set<string>).add('jenify')).toThrow(TypeError);
    expect(QUERY_STOPWORDS.size).toBe(before);
  });

  it('leaves an ordinary Set alone: this is a property of deepFreeze, not of Set', async () => {
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    const ordinary = new Set(['a']);
    ordinary.add('b');
    expect(ordinary.size).toBe(2);
    const frozen = deepFreeze(new Map([['k', { nested: ['v'] }]]));
    expect(() => (frozen as unknown as Map<string, unknown>).set('k2', 1)).toThrow(TypeError);
    expect(() => (frozen as unknown as Map<string, unknown>).delete('k')).toThrow(TypeError);
    // ALL THE WAY DOWN really is all the way down now: the VALUE inside the map
    // is frozen too.
    expect(Object.isFrozen(frozen.get('k'))).toBe(true);
    expect(Object.isFrozen(frozen.get('k')!.nested)).toBe(true);
    expect(frozen.get('k')!.nested).toEqual(['v']);
  });
});
