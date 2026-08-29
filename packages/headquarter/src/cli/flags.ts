/**
 * Command-line flag reading for the HQ local-admin CLIs (issue #224, Codex P2
 * on `f9383dc`).
 *
 * ## The defect this closes
 *
 * Both `direct-order.ts` and `claude-dispatch.ts` carried the same parser:
 *
 * ```ts
 * const index = argv.indexOf(`--${name}`);
 * if (index === -1 || index + 1 >= argv.length) return null;
 * return argv[index + 1] ?? null;
 * ```
 *
 * It cannot tell "the flag was not given" from "the flag was given without a
 * value", and it will happily take the NEXT OPTION as a value. Two malformed
 * invocations therefore mutated canonical state instead of printing usage:
 *
 *   - `--route` as the last token returned null, which fell through to the
 *     `AUTO` default. The operator asked for a route, got silence, and an order
 *     was placed on a route they never named.
 *   - `--instruction --route CLAUDE` created a canonical, Founder-gated,
 *     hash-chained order whose instruction was the literal string `--route`.
 *
 * These are local-admin interfaces that write to the HQ database, so "parse
 * loosely and carry on" is the wrong default: a typo should refuse, not write.
 * Hence three outcomes rather than two, and the caller decides what a missing
 * value means for it.
 *
 * ## The `--name=value` escape hatch
 *
 * Rejecting a value that starts with `--` is what stops the second case, and it
 * costs the ability to pass a value that legitimately begins with two dashes —
 * an instruction like `--dry-run is not enough`, say. `--name=value` is
 * therefore accepted and is the documented way to pass such a value, so the
 * guard closes a real hole without closing a real use.
 */

export type FlagReading =
  /** The flag does not appear at all. The caller's default applies. */
  | { kind: 'absent' }
  /** The flag appears with a usable value. */
  | { kind: 'value'; value: string }
  /**
   * The flag appears but carries no usable value — it was last on the line, or
   * the next token is another option, or `--name=` was given empty. NEVER
   * silently treated as absent: that is the defect.
   */
  | { kind: 'missing_value' };

/**
 * Read one long flag from an argv slice.
 *
 * Pure and exported so the rule is executed by tests rather than asserted about
 * a CLI that calls `main()` at import time.
 *
 * `--name=value` is checked first, so an explicit inline value always wins over
 * positional interpretation. Only the FIRST occurrence is read; a repeated flag
 * is not merged, because silently concatenating or last-wins-ing a repeated
 * option is its own quiet surprise.
 */
export function readFlag(argv: readonly string[], name: string): FlagReading {
  const long = `--${name}`;
  const prefix = `${long}=`;
  const inline = argv.find((token) => token.startsWith(prefix));
  if (inline !== undefined) {
    const value = inline.slice(prefix.length);
    return value === '' ? { kind: 'missing_value' } : { kind: 'value', value };
  }
  const index = argv.indexOf(long);
  if (index === -1) return { kind: 'absent' };
  const next = argv[index + 1];
  // A following option token is another flag, not this one's value. Deny by
  // default: guessing here is how `--instruction --route CLAUDE` became an
  // order whose instruction was `--route`.
  if (next === undefined || next.startsWith('--')) return { kind: 'missing_value' };
  return { kind: 'value', value: next };
}

/**
 * The message a CLI shows when a flag was given without a value.
 *
 * Shared so both commands explain the same situation the same way, including
 * the escape hatch, which is useless if it is not mentioned where it is needed.
 */
export function missingFlagValueMessage(name: string): string {
  return (
    `--${name} was given without a value. Nothing was read, resolved or written: a local-admin ` +
    'command that writes to the HQ database refuses a malformed invocation rather than falling ' +
    `back to a default you did not choose. Pass --${name} <value>, or --${name}=<value> when the ` +
    'value itself begins with two dashes.'
  );
}
