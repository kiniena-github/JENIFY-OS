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
 *
 * Round ten, Medium 2 — the title of the second block below USED TO OUTRUN
 * ITS ASSERTIONS. It said "frozen in its CONTENTS" while asserting only that
 * four own, shadowing properties throw, and an own property shadows the
 * prototype for direct property access ONLY: `Set.prototype.clear.call(x)`
 * reaches the internal slot without reading a property of `x` at all, and
 * emptied `QUEUED_UNREACHABLE_STATUSES` in one statement — the same cost as the
 * `.clear()` the stubs refused. `deepFreeze` now hands out a `Proxy` over the
 * collection instead of the collection, and the assertions below execute the
 * prototype spelling, the `forEach` third-argument escape, and the reads that
 * had to keep working, so the title is earned rather than advertised.
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

  it('refuses the prototype spelling too, which reaches the slot without reading a property', async () => {
    const { QUEUED_UNREACHABLE_STATUSES } = await import('../src/contracts/events.js');
    const target = QUEUED_UNREACHABLE_STATUSES as unknown as Set<string>;
    const before = [...target].sort();
    expect(before.length).toBeGreaterThan(0);
    const member = before[0]!;
    // Each of these is the one-statement exploit the own-property stubs did not
    // reach: an own `clear` shadows `x.clear()` and nothing else.
    for (const attempt of [
      () => Set.prototype.clear.call(target),
      () => Set.prototype.delete.call(target, member),
      () => Set.prototype.add.call(target, 'queued'),
    ]) {
      expect(attempt).toThrow(TypeError);
    }
    expect([...target].sort()).toEqual(before);
    expect(target.size).toBe(before.length);
    // The decision this vocabulary is read by still sees its member, which is
    // the whole point: an emptied set stops `task_beyond_claiming` firing.
    expect(target.has(member)).toBe(true);
  });

  it('hands `forEach` no reference that mutates, having handed out the raw collection before', async () => {
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    const frozen = deepFreeze(new Set(['review_passed', 'completed'])) as Set<string>;
    const handed: unknown[] = [];
    const visited: string[] = [];
    frozen.forEach((entry, _key, collection) => {
      visited.push(entry);
      handed.push(collection);
    });
    expect(visited).toEqual(['review_passed', 'completed']);
    // `Set.prototype.forEach` passes the collection it was called on as a third
    // argument. Forwarding the raw target there was a one-statement escape.
    expect(handed).toHaveLength(2);
    for (const collection of handed) {
      expect(collection).toBe(frozen);
      expect(() => Set.prototype.clear.call(collection as Set<string>)).toThrow(TypeError);
      expect(() => (collection as Set<string>).clear()).toThrow(TypeError);
    }
    expect([...frozen]).toEqual(['review_passed', 'completed']);
  });

  it('keeps every read a caller of this package actually performs', async () => {
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    const frozen = deepFreeze(new Set(['a', 'b'])) as Set<string>;
    expect(frozen instanceof Set).toBe(true);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.prototype.toString.call(frozen)).toBe('[object Set]');
    expect(frozen.has('a')).toBe(true);
    expect(frozen.has('zz')).toBe(false);
    expect(frozen.size).toBe(2);
    expect([...frozen]).toEqual(['a', 'b']);
    expect(Array.from(frozen)).toEqual(['a', 'b']);
    expect([...frozen.keys()]).toEqual(['a', 'b']);
    expect([...frozen.values()]).toEqual(['a', 'b']);
    expect([...frozen.entries()]).toEqual([
      ['a', 'a'],
      ['b', 'b'],
    ]);
    expect([...new Set(frozen)]).toEqual(['a', 'b']);
    // Method identity is stable, so a caller holding `set.has` keeps holding it.
    expect(frozen.has).toBe(frozen.has);
    const frozenMap = deepFreeze(new Map([['k', 1]])) as Map<string, number>;
    expect(frozenMap instanceof Map).toBe(true);
    expect(frozenMap.get('k')).toBe(1);
    expect(frozenMap.has('k')).toBe(true);
    expect(frozenMap.size).toBe(1);
    expect([...frozenMap]).toEqual([['k', 1]]);
    for (const attempt of [
      () => Map.prototype.clear.call(frozenMap),
      () => Map.prototype.delete.call(frozenMap, 'k'),
      () => Map.prototype.set.call(frozenMap, 'k2', 2),
    ]) {
      expect(attempt).toThrow(TypeError);
    }
    expect([...frozenMap]).toEqual([['k', 1]]);
  });

  it('reaches a collection held INSIDE a frozen structure, and one that holds itself', async () => {
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    // "All the way down" would stop at the raw Set a frozen object happens to
    // hold, unless the property is repointed at the view.
    const nested = deepFreeze({ vocabulary: new Set(['open', 'closed']), rows: [new Map([['a', 1]])] }) as {
      vocabulary: Set<string>;
      rows: Map<string, number>[];
    };
    expect(() => Set.prototype.clear.call(nested.vocabulary)).toThrow(TypeError);
    expect(() => Map.prototype.clear.call(nested.rows[0]!)).toThrow(TypeError);
    expect([...nested.vocabulary]).toEqual(['open', 'closed']);
    expect([...nested.rows[0]!]).toEqual([['a', 1]]);

    // A collection reached through a cycle has to resolve to the view as well,
    // or the cycle itself hands out the raw reference.
    const selfReferential = new Set<unknown>(['x']);
    selfReferential.add(selfReferential);
    const frozenCycle = deepFreeze(selfReferential) as Set<unknown>;
    const entries = [...frozenCycle];
    expect(entries[0]).toBe('x');
    expect(entries[1]).toBe(frozenCycle);
    expect(() => Set.prototype.clear.call(entries[1] as Set<unknown>)).toThrow(TypeError);
    expect(frozenCycle.size).toBe(2);
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

/**
 * Wave 5 correction round ten, MEDIUM 3 — the named bypass the own-mutator fix
 * did not close.
 *
 * Installing own throwing `add`/`delete`/`clear` shadows the prototype for a
 * direct call and for nothing else: `Set.prototype`'s methods operate on the
 * receiver's internal `[[SetData]]` slot and never read its properties.
 * Executed against the previous head:
 *
 * ```
 * own .clear()              -> threw
 * Set.prototype.clear.call  -> SUCCEEDED (size 86 -> 0 on QUERY_STOPWORDS)
 * Map.prototype.delete.call -> SUCCEEDED
 * ```
 *
 * And it reached a real gate: emptying `QUEUED_UNREACHABLE_STATUSES` by
 * prototype call flipped `assignTask` on a COMPLETED task from
 * `refused: task_beyond_claiming` to ACCEPTED.
 */
describe('a frozen collection is immutable through the PROTOTYPE too, not only through its own properties', () => {
  it('refuses Set.prototype.clear/add/delete called on the frozen vocabulary', async () => {
    const { QUEUED_UNREACHABLE_STATUSES } = await import('../src/contracts/events.js');
    const target = QUEUED_UNREACHABLE_STATUSES as unknown as Set<string>;
    const before = [...QUEUED_UNREACHABLE_STATUSES].sort();
    expect(before.length).toBeGreaterThan(0);
    for (const attempt of [
      () => Set.prototype.clear.call(target),
      () => Set.prototype.delete.call(target, before[0]!),
      () => Set.prototype.add.call(target, 'queued'),
    ]) {
      expect(attempt).toThrow(TypeError);
    }
    expect([...QUEUED_UNREACHABLE_STATUSES].sort()).toEqual(before);
  });

  it('refuses the same on the retrieval stopword set, which the exploit emptied', async () => {
    const { QUERY_STOPWORDS } = await import('../src/application/search-command.js');
    const target = QUERY_STOPWORDS as unknown as Set<string>;
    const before = QUERY_STOPWORDS.size;
    expect(before).toBeGreaterThan(0);
    expect(() => Set.prototype.clear.call(target)).toThrow(TypeError);
    expect(QUERY_STOPWORDS.size).toBe(before);
  });

  it('refuses Map.prototype.set/delete/clear on a frozen Map', async () => {
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    const frozen = deepFreeze(new Map([['k', { nested: ['v'] }]]));
    const target = frozen as unknown as Map<string, unknown>;
    for (const attempt of [
      () => Map.prototype.clear.call(target),
      () => Map.prototype.delete.call(target, 'k'),
      () => Map.prototype.set.call(target, 'k2', 1),
    ]) {
      expect(attempt).toThrow(TypeError);
    }
    expect(frozen.get('k')!.nested).toEqual(['v']);
    expect(frozen.size).toBe(1);
  });

  it('a reference the caller kept before freezing cannot reach the view', async () => {
    // Wave 5 correction round eleven, Low 1. The proxy target used to BE the
    // caller's object, so "the raw collection never escapes" was a property of
    // the CALL SITES: a caller that named its collection before freezing it
    // kept a mutable reference, and `Set.prototype.clear.call(named)` emptied
    // the frozen view through it — executed, `frozen.size` 2 -> 0. It is now a
    // property of the module, because the view is over a private copy.
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    const named = new Set(['review_passed', 'completed']);
    const frozen = deepFreeze(named) as Set<string>;
    expect(frozen.size).toBe(2);
    // The caller's own object is still an ordinary Set — this test does not
    // claim `deepFreeze` reaches back and freezes what it was handed.
    Set.prototype.clear.call(named);
    expect(named.size).toBe(0);
    // The frozen view is untouched, which is the whole property.
    expect(frozen.size).toBe(2);
    expect([...frozen].sort()).toEqual(['completed', 'review_passed']);
    // And the same for a Map, plus an addition through the retained reference.
    const namedMap = new Map([['k', 1]]);
    const frozenMap = deepFreeze(namedMap) as Map<string, number>;
    Map.prototype.set.call(namedMap, 'k2', 2);
    Map.prototype.delete.call(namedMap, 'k');
    expect(frozenMap.size).toBe(1);
    expect(frozenMap.get('k')).toBe(1);
    expect(frozenMap.has('k2')).toBe(false);
  });

  it('reading a frozen collection really does behave as it did — constructor included', async () => {
    // Wave 5 correction round eleven, Low 2. The `get` trap bound every
    // function-valued property, `constructor` among them, so
    // `frozen.constructor === Set` was FALSE while the module header said
    // reading "behaves exactly as it did".
    const { deepFreeze } = await import('../src/contracts/freeze.js');
    const frozenSet = deepFreeze(new Set(['a'])) as Set<string>;
    const frozenMap = deepFreeze(new Map([['k', 1]])) as Map<string, number>;
    expect(frozenSet.constructor).toBe(Set);
    expect(frozenMap.constructor).toBe(Map);
    // The properties the walker and the vocabularies actually depend on.
    expect(frozenSet instanceof Set).toBe(true);
    expect(frozenMap instanceof Map).toBe(true);
    expect(Object.isFrozen(frozenSet)).toBe(true);
    // And handing `constructor` back unbound opens nothing: the mutators still
    // refuse by both spellings.
    expect(() => Set.prototype.clear.call(frozenSet)).toThrow(TypeError);
    expect(() => (frozenSet as unknown as { clear: () => void }).clear()).toThrow(TypeError);
    expect(frozenSet.size).toBe(1);
  });

  it('forEach hands the callback the VIEW, never the collection it hides', async () => {
    const { QUERY_STOPWORDS } = await import('../src/application/search-command.js');
    const before = QUERY_STOPWORDS.size;
    let seen: unknown = null;
    QUERY_STOPWORDS.forEach((_value, _value2, set) => {
      seen ??= set;
    });
    expect(seen).toBe(QUERY_STOPWORDS);
    expect(() => Set.prototype.clear.call(seen as Set<string>)).toThrow(TypeError);
    expect(QUERY_STOPWORDS.size).toBe(before);
  });

  it('the gate the exploit flipped stays refused: assignTask on a completed task', async () => {
    // The consequence, not just the collection. `assignmentBarrier` reads
    // `QUEUED_UNREACHABLE_STATUSES.has(task.status)`; emptying it by prototype
    // call turned a refusal into an acceptance.
    const { QUEUED_UNREACHABLE_STATUSES } = await import('../src/contracts/events.js');
    const { setupFixture, CAPS, expectOk } = await import('./application.fixture.js');
    const fx = setupFixture();
    const created = expectOk(
      fx.ops.createTask({
        capabilityId: CAPS.readStatus,
        payload: { repo: 'jenify-os' },
        requestedBy: 'claude',
      }),
    );
    const claimed = expectOk(fx.ops.claimNext('claude', CAPS.readStatus, undefined, created.task.id));
    expectOk(fx.ops.startTask(claimed.id, 'claude', claimed.fence));
    expectOk(fx.ops.submitResult(claimed.id, 'claude', claimed.fence, { ok: true }));

    expect(() => Set.prototype.clear.call(QUEUED_UNREACHABLE_STATUSES as unknown as Set<string>)).toThrow(
      TypeError,
    );
    const refused = fx.ops.assignTask(claimed.id, 'codex', 'founder');
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.error.code).toBe('task_beyond_claiming');
  });
});
