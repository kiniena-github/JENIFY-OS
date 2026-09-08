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
 * ## Why a `Set` or a `Map` needs more than `Object.freeze`
 *
 * A collection's ENTRIES are not own properties. `Reflect.ownKeys` never
 * reaches them and `Object.freeze` does not touch them, so a frozen `Set`
 * accepted `.add()`, `.delete()` and `.clear()` exactly as an unfrozen one did
 * (round seven, Medium NEW-5). Both of this package's `Set` vocabularies were
 * reachable that way — `QUEUED_UNREACHABLE_STATUSES`, which `service.ts`
 * decides a task's reachability on, and `QUERY_STOPWORDS`. Narrowing a closed
 * vocabulary a decision is keyed by is the same class of exploit as
 * `ENGINE_IMMUTABLE_TABLES.length = 0`, without touching one frozen property.
 *
 * Round seven answered it by installing own, non-configurable throwing
 * `add`/`set`/`delete`/`clear`. **That was not enough, and round ten is where
 * it is actually closed** (round ten, Medium 2). An own property shadows the
 * prototype for direct property access ONLY: `Set.prototype.clear.call(x)`
 * never reads a property of `x` at all, it reaches straight into the internal
 * slot, so it emptied a `deepFreeze`d `QUEUED_UNREACHABLE_STATUSES` in one
 * statement — the same cost as the `.clear()` the stubs had just refused.
 *
 * There is no way to make a REAL `Set` refuse that: the built-in mutators are
 * defined in terms of the [[SetData]] slot, and patching `Set.prototype` itself
 * would change every collection in the process, which this module has no
 * business doing. So a frozen collection is no longer handed out as a real
 * `Set`. It is handed out as a `Proxy` over one, and the raw collection is
 * closed over and never escapes:
 *
 * - `Set.prototype.clear.call(view)` — and `add`, `delete`, `set` — throw
 *   `TypeError: Method Set.prototype.clear called on incompatible receiver`,
 *   because a `Proxy` carries no [[SetData]] slot of its own.
 * - Direct `view.clear()` throws HQ's own `TypeError`, from an own,
 *   non-configurable stub installed on the target and returned verbatim by the
 *   trap (returning anything else would violate the proxy invariant for a
 *   non-configurable, non-writable own property).
 * - Reading is untouched, because reading is what a vocabulary is for: `has`,
 *   `get`, `size`, `forEach`, `keys`/`values`/`entries`, `for…of`, spread,
 *   `Array.from`, the ES2025 set-composition methods, `instanceof Set` and
 *   `Object.isFrozen` all behave exactly as they did.
 * - `forEach` is the one read that had to be rewritten rather than forwarded:
 *   it hands its callback the collection it was called on as a THIRD argument,
 *   and forwarding the raw target there leaked the very reference this view
 *   exists to withhold — a one-statement escape, executed before this sentence
 *   was written. The wrapper passes the view.
 *
 * "The raw collection never escapes" is a property of the CALL SITES as much as
 * of this module: the proxy target is the very object `deepFreeze` was handed,
 * so a caller that named its collection before freezing it would still hold a
 * mutable reference. Both of this package's frozen collections
 * (`QUEUED_UNREACHABLE_STATUSES` in `contracts/events.ts`, `QUERY_STOPWORDS` in
 * `application/search-command.ts`) construct the collection inline in the
 * `deepFreeze(...)` argument, so nothing outside this module names one. That is
 * stated rather than assumed, because it is the half a future call site could
 * break without touching this file.
 *
 * ## Two lanes fixed this, and this is the one that shipped
 *
 * Round ten reached the same defect from two directions. The other lane replaced
 * a frozen collection with a hand-built frozen VIEW OBJECT — no `[[SetData]]`
 * slot at all, so the prototype spelling throws for the same reason it throws
 * here. Its evidence, executed against the pre-fix head, is kept because it is
 * what made the defect real rather than theoretical:
 *
 * ```
 * own .clear()              -> threw
 * Set.prototype.clear.call  -> SUCCEEDED (size 86 -> 0 on QUERY_STOPWORDS)
 * Map.prototype.delete.call -> SUCCEEDED
 * ```
 *
 * and it reached a gate rather than only a constant: emptying
 * `QUEUED_UNREACHABLE_STATUSES` by prototype call flipped `assignTask` on a
 * COMPLETED task from `refused: task_beyond_claiming` to ACCEPTED
 * (`service.ts`'s `assignmentBarrier`). That consequence is pinned in
 * `test/frozen-constants-census.test.ts`.
 *
 * The `Proxy` is what ships, because the view object closed the bypass at the
 * cost of no longer BEING a collection: `deepFreeze(new Set(...)) instanceof
 * Set` would have become false, and `live/redaction.ts`'s walker branches on
 * `value instanceof Map` / `value instanceof Set` to reach a collection's
 * entries at all. A frozen vocabulary would have fallen through to the
 * own-property path and been walked as an empty object — a silent narrowing of
 * the credential scan, traded for a bypass that the `Proxy` closes just as
 * completely. Both lanes' assertions are kept and both pass against this
 * mechanism.
 *
 * The measured cost is real and is stated rather than waved away: a bare
 * `.has()` costs about 15 ns direct and about 38 ns through the view on this
 * machine. The package has exactly two frozen collections and two call sites —
 * one `.has()` per task in `service.ts`'s claiming decision, and one `.has()`
 * per query token in `search-command.ts` — so the added cost is bounded by a
 * few microseconds per search and is dominated by the SQLite work on either
 * side of it. There are no frozen collections on any loop hot enough for 23 ns
 * to be visible, and `deepFreeze` itself is only ever called at module load.
 */

const SET_MUTATORS: readonly string[] = Object.freeze(['add', 'delete', 'clear']);
const MAP_MUTATORS: readonly string[] = Object.freeze(['set', 'delete', 'clear']);

type CollectionKind = 'Set' | 'Map';

interface CollectionView<T extends object> {
  /** What callers are handed. The raw collection stays closed over. */
  readonly view: T;
  /**
   * Installs the throwing mutators. Deliberately separate from `view`, because
   * the entries have to be rewritten (a nested collection is replaced by its
   * own view) BEFORE the collection stops accepting writes, and the view has to
   * exist before that so a self-referential collection resolves to it.
   */
  readonly seal: () => void;
}

function contentFrozenCollection<T extends object>(target: T, kind: CollectionKind): CollectionView<T> {
  // Filled by `seal`. The trap closes over the map rather than the values, so
  // the view can be built first and sealed after the entries settle.
  const refusals = new Map<PropertyKey, () => never>();
  const forwarded = new Map<PropertyKey, unknown>();

  const view: T = new Proxy(target, {
    get(inner, property) {
      const refusal = refusals.get(property);
      // Returned verbatim: after `seal` these are non-configurable and
      // non-writable own properties of `inner`, and a proxy may not report a
      // different value for one.
      if (refusal !== undefined) return refusal;
      const already = forwarded.get(property);
      if (already !== undefined) return already;
      // `inner` as the receiver, never the proxy: the built-ins are defined on
      // the internal slot, which only the raw collection carries.
      const value = Reflect.get(inner, property, inner);
      // Non-functions — `size` above all — are read through every time, so a
      // stale value can never be served.
      if (typeof value !== 'function') return value;
      const bound =
        property === 'forEach'
          ? (callback: (...args: unknown[]) => unknown, thisArg?: unknown): void => {
              (value as (this: unknown, ...args: unknown[]) => unknown).call(
                inner,
                (entry: unknown, key: unknown) => callback.call(thisArg, entry, key, view),
              );
            }
          : (value as { bind: (thisArg: unknown) => unknown }).bind(inner);
      forwarded.set(property, bound);
      return bound;
    },
    // The target is frozen, so these would fail anyway — but a failed [[Set]]
    // only THROWS in strict mode, and a frozen vocabulary should refuse the
    // same way whatever the caller was compiled to.
    set(_inner, property) {
      throw new TypeError(`Cannot set ${String(property)} on a frozen ${kind}`);
    },
    defineProperty(_inner, property) {
      throw new TypeError(`Cannot define ${String(property)} on a frozen ${kind}`);
    },
    deleteProperty(_inner, property) {
      throw new TypeError(`Cannot delete ${String(property)} on a frozen ${kind}`);
    },
    setPrototypeOf() {
      throw new TypeError(`Cannot reassign the prototype of a frozen ${kind}`);
    },
  }) as T;

  const seal = (): void => {
    for (const name of kind === 'Set' ? SET_MUTATORS : MAP_MUTATORS) {
      const refusal = (): never => {
        throw new TypeError(`Cannot call ${name} on a frozen ${kind}`);
      };
      Object.defineProperty(target, name, {
        value: refusal,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      refusals.set(name, refusal);
    }
  };

  return { view, seal };
}

/**
 * `seen` maps an already-visited object to WHAT IT FREEZES TO, not merely to
 * the fact that it was visited: a collection freezes to a different reference
 * than it started as, and a cycle back into one has to resolve to the view.
 */
export function deepFreeze<T>(value: T, seen: WeakMap<object, unknown> = new WeakMap()): T {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const target = value as unknown as object;
  if (seen.has(target)) return seen.get(target) as T;
  // Provisional, so a cycle through a plain object terminates on the object
  // itself. A collection overwrites this with its view below, before its own
  // entries are walked.
  seen.set(target, value);

  const collection = target instanceof Set ? 'Set' : target instanceof Map ? 'Map' : null;
  const wrapper = collection === null ? null : contentFrozenCollection(target, collection);
  if (wrapper !== null) seen.set(target, wrapper.view);

  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    // Only DATA properties are recursed into. Reading an accessor here would
    // execute someone else's getter as a side effect of freezing, which is not
    // this function's business.
    if (!descriptor || !('value' in descriptor)) continue;
    const frozen = deepFreeze(descriptor.value, seen);
    // A nested collection freezes to a DIFFERENT reference, so the property has
    // to be repointed at it — otherwise "all the way down" would stop at the
    // raw `Set` a frozen object happens to hold.
    if (frozen !== descriptor.value && (descriptor.configurable === true || descriptor.writable === true)) {
      Object.defineProperty(target, key, { ...descriptor, value: frozen });
    }
  }

  if (collection === 'Set' && wrapper !== null) {
    const entries = [...(target as Set<unknown>)];
    const frozen = entries.map((entry) => deepFreeze(entry, seen));
    if (frozen.some((entry, index) => entry !== entries[index])) {
      // Rebuilt through the prototype in one pass so iteration order survives.
      // Still legal: `seal` has not run yet.
      Set.prototype.clear.call(target as Set<unknown>);
      for (const entry of frozen) Set.prototype.add.call(target as Set<unknown>, entry);
    }
    wrapper.seal();
    Object.freeze(target);
    return wrapper.view as T;
  }
  if (collection === 'Map' && wrapper !== null) {
    const entries = [...(target as Map<unknown, unknown>)];
    const frozen = entries.map(([key, entry]) => [deepFreeze(key, seen), deepFreeze(entry, seen)] as const);
    if (frozen.some(([key, entry], index) => key !== entries[index]![0] || entry !== entries[index]![1])) {
      Map.prototype.clear.call(target as Map<unknown, unknown>);
      for (const [key, entry] of frozen) Map.prototype.set.call(target as Map<unknown, unknown>, key, entry);
    }
    wrapper.seal();
    Object.freeze(target);
    return wrapper.view as T;
  }

  return Object.freeze(value);
}
