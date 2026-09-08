/**
 * One deep freeze, used everywhere a constant is on an ENFORCEMENT path.
 *
 * TypeScript's `readonly` and `as const` are compile-time only: they erase
 * completely, and an exported `const` object or array remains fully mutable at
 * runtime by anyone holding the module. That matters because HQ exports these
 * declarations as public package API and then DECIDES on them — a reserved
 * capability contract is what the drift gate compares a registry row against, a
 * closed vocabulary is what a membership check reads, and a `length = 0` on
 * either is not a convenience, it is the gate.
 *
 * The Wave 5 review proved both halves of that on real code. Before
 * `ENGINE_IMMUTABLE_TABLES` was frozen, one `ENGINE_IMMUTABLE_TABLES.length = 0`
 * emptied the append-only census and made a genuinely tampered file report
 * `safeMode: false`. And at the head this module was added to,
 * `RELIABILITY_COMMAND_RESERVED_CONTRACT` was still unfrozen: with a tampered
 * registry row the drift gate correctly REFUSED `assessHqIntegrity`, and
 * patching the reserved contract to match the tampered row made it ADMIT at
 * full depth — the gate defeated by rewriting the thing it compares against
 * (Medium A6). `REPORTABLE_RUN_OUTCOMES.length = 0` and `RUN_STATES.length = 0`
 * corrupted the unauthenticated snapshot's counts the same way.
 *
 * The fix is applied CONSISTENTLY rather than one constant at a time, because
 * "this one is on the enforcement path and that one is not" is exactly the
 * judgement that goes stale: every `*_RESERVED_CONTRACT` in the package is
 * frozen through this helper, and so is every closed vocabulary a decision or a
 * published count is keyed by. Under ESM — always strict — a write to a frozen
 * binding THROWS rather than failing silently.
 *
 * It freezes ALL THE WAY DOWN, because a shallow freeze is the same exploit one
 * level in: `entry.secondaryGuards.length = 0` was reachable while the array
 * that held `entry` was frozen. Cycles are handled, so a self-referential
 * declaration cannot make this recurse forever.
 *
 * **"ALL THE WAY DOWN" was NOT TRUE OF A `Set` OR A `Map`, and the sentence
 * that said so is corrected here rather than restated** (Wave 5 correction
 * round seven, Medium NEW-5). A collection's ENTRIES are not own properties, so
 * `Reflect.ownKeys` never reaches them and `Object.freeze` does not touch them:
 * a frozen `Set` accepts `.add()`, `.delete()` and `.clear()` exactly as an
 * unfrozen one does. Both of this package's `Set` vocabularies were reachable
 * that way — `QUEUED_UNREACHABLE_STATUSES`, which `service.ts` decides a task's
 * reachability on, and `QUERY_STOPWORDS`. `.delete()` on the first is the same
 * class of exploit as `ENGINE_IMMUTABLE_TABLES.length = 0`: it narrows a
 * closed vocabulary a decision is keyed by, without touching a single frozen
 * property.
 *
 * So a collection is frozen in CONTENT as well as in shape: its entries are
 * recursed into, and its write half throws — the same failure mode a write to
 * a frozen property has under ESM's always-strict semantics. Reading (`has`,
 * `get`, `size`, iteration) is untouched, because reading is what a vocabulary
 * is for.
 *
 * **AND THE OWN-MUTATOR VERSION OF THAT FIX WAS STILL BYPASSABLE BY THE
 * PROTOTYPE, which is what this module now closes** (Wave 5 correction round
 * ten, Medium 3). Installing own throwing `add`/`delete`/`clear` shadows the
 * prototype for `frozenSet.clear()` and for nothing else. `Set.prototype`'s
 * methods do not read the receiver's properties — they operate on its internal
 * `[[SetData]]` slot — so the shadowing was invisible to them. Executed
 * against the previous head:
 *
 * ```
 * own .clear()              -> threw
 * Set.prototype.clear.call  -> SUCCEEDED (size 86 -> 0 on QUERY_STOPWORDS)
 * Map.prototype.delete.call -> SUCCEEDED
 * ```
 *
 * And it reached a gate: emptying `QUEUED_UNREACHABLE_STATUSES` by prototype
 * call flipped `assignTask` on a COMPLETED task from
 * `refused: task_beyond_claiming` to ACCEPTED (`service.ts`'s
 * `assignmentBarrier`).
 *
 * No amount of property work can close that, because the vulnerable thing is
 * an internal slot rather than a property. So a frozen collection is no longer
 * a `Set` or a `Map` at all: it is a frozen VIEW object holding the real
 * collection in a closure, exposing the read half (`has`, `get`, `size`,
 * `keys`, `values`, `entries`, `forEach`, iteration) and throwing from the
 * write half. `Set.prototype.clear.call(view)` now throws
 * `TypeError: Method Set.prototype.clear called on incompatible receiver`,
 * because the view has no `[[SetData]]` slot to reach — and the collection
 * that does have one is named by nothing outside this module.
 *
 * The consequences, stated rather than discovered later: a deep-frozen `Set` or
 * `Map` is `ReadonlySet`/`ReadonlyMap` in shape and in behaviour but is NOT
 * `instanceof Set`/`instanceof Map`, and `deepFreeze` therefore RETURNS a
 * different object than it was given for those two types (its own callers
 * already use the return value, and a nested collection is written back into
 * its frozen parent). `forEach`'s third argument is the VIEW, never the inner
 * collection, so a callback cannot be handed the mutable thing the view exists
 * to hide.
 */
const SET_MUTATORS: readonly string[] = Object.freeze(['add', 'delete', 'clear']);
const MAP_MUTATORS: readonly string[] = Object.freeze(['set', 'delete', 'clear']);

/**
 * Install own, non-configurable throwing stubs for a collection view's write
 * half, so `view.clear()` fails the same way a write to a frozen property does.
 *
 * The view has no internal collection slot, so the PROTOTYPE route already
 * throws on its own; these exist so the direct call reports the same
 * `TypeError` it always did rather than `undefined is not a function`.
 */
function refuseCollectionMutation(target: object, kind: 'Set' | 'Map'): void {
  for (const name of kind === 'Set' ? SET_MUTATORS : MAP_MUTATORS) {
    Object.defineProperty(target, name, {
      value: () => {
        throw new TypeError(`Cannot call ${name} on a frozen ${kind}`);
      },
      writable: false,
      enumerable: false,
      configurable: false,
    });
  }
}

/** A frozen read-only view over a `Set` that nothing outside this module names. */
function frozenSetView<T>(inner: Set<T>): ReadonlySet<T> {
  const view = {
    get size(): number {
      return inner.size;
    },
    has: (value: T): boolean => inner.has(value),
    keys: (): SetIterator<T> => inner.keys(),
    values: (): SetIterator<T> => inner.values(),
    entries: (): SetIterator<[T, T]> => inner.entries(),
    forEach: (
      callback: (value: T, value2: T, set: ReadonlySet<T>) => void,
      thisArg?: unknown,
    ): void => {
      // `view`, never `inner`: the third argument of `Set.prototype.forEach` is
      // the set itself, and handing the real collection to a callback would
      // give away exactly what this view exists to withhold.
      inner.forEach((value, value2) => callback.call(thisArg, value, value2, view));
    },
    [Symbol.iterator]: (): SetIterator<T> => inner[Symbol.iterator](),
    [Symbol.toStringTag]: 'Set',
  } as unknown as ReadonlySet<T>;
  refuseCollectionMutation(view as unknown as object, 'Set');
  return Object.freeze(view);
}

/** A frozen read-only view over a `Map` that nothing outside this module names. */
function frozenMapView<K, V>(inner: Map<K, V>): ReadonlyMap<K, V> {
  const view = {
    get size(): number {
      return inner.size;
    },
    has: (key: K): boolean => inner.has(key),
    get: (key: K): V | undefined => inner.get(key),
    keys: (): MapIterator<K> => inner.keys(),
    values: (): MapIterator<V> => inner.values(),
    entries: (): MapIterator<[K, V]> => inner.entries(),
    forEach: (
      callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
      thisArg?: unknown,
    ): void => {
      inner.forEach((value, key) => callback.call(thisArg, value, key, view));
    },
    [Symbol.iterator]: (): MapIterator<[K, V]> => inner[Symbol.iterator](),
    [Symbol.toStringTag]: 'Map',
  } as unknown as ReadonlyMap<K, V>;
  refuseCollectionMutation(view as unknown as object, 'Map');
  return Object.freeze(view);
}

export function deepFreeze<T>(value: T, seen: Map<object, unknown> = new Map()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const target = value as unknown as object;
  // Cycles: the provisional entry is the value itself, so a self-referential
  // declaration terminates rather than recursing forever.
  if (seen.has(target)) return seen.get(target) as T;
  seen.set(target, value);
  // The two containers whose contents live outside their own properties, and
  // whose mutability lives in an internal slot rather than in a property. Both
  // are REPLACED by a frozen view — see the module comment.
  if (target instanceof Set) {
    const inner = new Set<unknown>();
    for (const entry of target as Set<unknown>) inner.add(deepFreeze(entry, seen));
    const view = frozenSetView(inner);
    seen.set(target, view);
    return view as unknown as T;
  }
  if (target instanceof Map) {
    const inner = new Map<unknown, unknown>();
    for (const [key, entry] of target as Map<unknown, unknown>) {
      inner.set(deepFreeze(key, seen), deepFreeze(entry, seen));
    }
    const view = frozenMapView(inner);
    seen.set(target, view);
    return view as unknown as T;
  }
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    // Only DATA properties are recursed into. Reading an accessor here would
    // execute someone else's getter as a side effect of freezing, which is not
    // this function's business.
    if (!descriptor || !('value' in descriptor)) continue;
    const frozen = deepFreeze(descriptor.value, seen);
    // A nested collection was REPLACED by its view, so the parent has to be
    // re-pointed at it — before `Object.freeze` below, which is why this
    // happens here rather than in the caller.
    if (frozen !== descriptor.value && descriptor.configurable) {
      Object.defineProperty(target, key, { ...descriptor, value: frozen });
    }
  }
  return Object.freeze(value);
}
