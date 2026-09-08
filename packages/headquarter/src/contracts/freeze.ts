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
 * recursed into, and its mutators are replaced with own, non-configurable
 * properties that THROW — the same failure mode a write to a frozen property
 * has under ESM's always-strict semantics. Reading (`has`, `get`, `size`,
 * iteration) is untouched, because reading is what a vocabulary is for.
 */
const SET_MUTATORS: readonly string[] = Object.freeze(['add', 'delete', 'clear']);
const MAP_MUTATORS: readonly string[] = Object.freeze(['set', 'delete', 'clear']);

/**
 * Replace a collection's mutators with throwing stubs, in place.
 *
 * Own, non-writable, non-configurable and non-enumerable: they shadow the
 * prototype methods for this instance only, they survive the `Object.freeze`
 * that follows, and they do not show up in an enumeration of the value.
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

export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const target = value as unknown as object;
  if (seen.has(target)) return value;
  seen.add(target);
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    // Only DATA properties are recursed into. Reading an accessor here would
    // execute someone else's getter as a side effect of freezing, which is not
    // this function's business.
    if (!descriptor || !('value' in descriptor)) continue;
    deepFreeze(descriptor.value, seen);
  }
  // The two containers whose contents live outside their own properties. Done
  // BEFORE `Object.freeze`, because a frozen object takes no new property.
  if (target instanceof Set) {
    for (const entry of target as Set<unknown>) deepFreeze(entry, seen);
    refuseCollectionMutation(target, 'Set');
  } else if (target instanceof Map) {
    for (const [key, entry] of target as Map<unknown, unknown>) {
      deepFreeze(key, seen);
      deepFreeze(entry, seen);
    }
    refuseCollectionMutation(target, 'Map');
  }
  return Object.freeze(value);
}
