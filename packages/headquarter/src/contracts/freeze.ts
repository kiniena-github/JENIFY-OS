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
 */
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
  return Object.freeze(value);
}
