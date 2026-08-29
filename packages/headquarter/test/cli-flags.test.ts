/**
 * Command-line flag reading (issue #224, Codex P2 on `f9383dc`).
 *
 * ## The defect
 *
 * Both local-admin CLIs carried a parser that could not tell "the flag was not
 * given" from "the flag was given without a value", and that would take the
 * next OPTION as a value. Two malformed invocations therefore mutated the
 * canonical HQ database instead of printing usage:
 *
 *   - `--route` as the last token read as absent, fell through to the `AUTO`
 *     default, and placed an order on a route nobody named.
 *   - `--instruction --route CLAUDE` created a Founder-gated, hash-chained
 *     order whose instruction was the literal string `--route`.
 *
 * These commands write to the HQ database, so parsing loosely is the wrong
 * default: a typo must refuse, not write.
 *
 * The rule is tested here rather than in the CLIs, which call `main()` at
 * import time and so cannot be imported at all.
 */

import { describe, expect, it } from 'vitest';
import { missingFlagValueMessage, readFlag } from '../src/cli/flags.js';

describe('a flag that was never given is absent', () => {
  it('reports absent, so the caller’s own default applies', () => {
    expect(readFlag(['--local-admin', '--dry-run'], 'route')).toEqual({ kind: 'absent' });
    expect(readFlag([], 'route')).toEqual({ kind: 'absent' });
  });

  it('does not match a different flag that merely shares a prefix', () => {
    // `--db` must not be answered by `--dbg`, and `--as` not by `--assume`.
    expect(readFlag(['--dbg', 'x'], 'db')).toEqual({ kind: 'absent' });
    expect(readFlag(['--assume', 'x'], 'as')).toEqual({ kind: 'absent' });
  });
});

describe('a flag given a real value reads it', () => {
  it('takes the following token', () => {
    expect(readFlag(['--route', 'CLAUDE'], 'route')).toEqual({ kind: 'value', value: 'CLAUDE' });
  });

  it('takes a value containing spaces, equals signs or a leading dash', () => {
    // A single dash is not an option token; `--declare-provider a=B` is a real
    // invocation this CLI supports.
    expect(readFlag(['--instruction', 'do the thing'], 'instruction')).toEqual({
      kind: 'value',
      value: 'do the thing',
    });
    expect(readFlag(['--declare-provider', 'worker=CLAUDE'], 'declare-provider')).toEqual({
      kind: 'value',
      value: 'worker=CLAUDE',
    });
    expect(readFlag(['--project', '-mesob'], 'project')).toEqual({ kind: 'value', value: '-mesob' });
  });

  it('reads only the first occurrence of a repeated flag', () => {
    // Not merged and not last-wins: silently picking one of two contradictory
    // values is its own quiet surprise.
    expect(readFlag(['--route', 'CLAUDE', '--route', 'CODEX'], 'route')).toEqual({
      kind: 'value',
      value: 'CLAUDE',
    });
  });
});

describe('a flag given NO value refuses instead of falling back', () => {
  /** The `--route` trailing case: it used to read as absent and become AUTO. */
  it('reports missing_value when the flag is the last token', () => {
    expect(readFlag(['--local-admin', '--route'], 'route')).toEqual({ kind: 'missing_value' });
  });

  /** The `--instruction --route CLAUDE` case: the instruction became `--route`. */
  it('never consumes a following option token as the value', () => {
    expect(readFlag(['--instruction', '--route', 'CLAUDE'], 'instruction')).toEqual({
      kind: 'missing_value',
    });
    // And the flag that WAS given properly still reads correctly, so the
    // refusal is about the malformed one only.
    expect(readFlag(['--instruction', '--route', 'CLAUDE'], 'route')).toEqual({
      kind: 'value',
      value: 'CLAUDE',
    });
  });

  it('reports missing_value for an empty inline value', () => {
    expect(readFlag(['--route='], 'route')).toEqual({ kind: 'missing_value' });
  });

  it('is distinguishable from absent, which is the whole point', () => {
    // The old parser returned null for both, which is how a malformed
    // invocation became a silent default.
    expect(readFlag(['--route'], 'route').kind).toBe('missing_value');
    expect(readFlag([], 'route').kind).toBe('absent');
  });
});

describe('--name=value is the escape hatch for a value starting with dashes', () => {
  it('accepts an inline value', () => {
    expect(readFlag(['--route=CLAUDE'], 'route')).toEqual({ kind: 'value', value: 'CLAUDE' });
  });

  it('lets an instruction legitimately begin with two dashes', () => {
    expect(readFlag(['--instruction=--dry-run is not enough'], 'instruction')).toEqual({
      kind: 'value',
      value: '--dry-run is not enough',
    });
  });

  it('preserves equals signs inside the value', () => {
    expect(readFlag(['--declare-provider=worker=CLAUDE'], 'declare-provider')).toEqual({
      kind: 'value',
      value: 'worker=CLAUDE',
    });
  });

  it('wins over a positional reading, so an explicit value is never overridden', () => {
    expect(readFlag(['--route=CODEX', '--route', 'CLAUDE'], 'route')).toEqual({
      kind: 'value',
      value: 'CODEX',
    });
  });
});

describe('the refusal explains itself, including the escape hatch', () => {
  it('names the flag, says nothing was written, and shows both forms', () => {
    const message = missingFlagValueMessage('route');
    expect(message).toContain('--route');
    expect(message).toContain('Nothing was read, resolved or written');
    expect(message).toContain('--route=<value>');
    // The escape hatch is useless if it is not mentioned where it is needed.
    expect(message).toContain('begins with two dashes');
  });
});
