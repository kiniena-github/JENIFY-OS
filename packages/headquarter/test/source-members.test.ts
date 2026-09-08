/**
 * The shared member slicer, asserted against the real files that depend on it
 * (Wave 5 correction round fourteen, Medium 15).
 *
 * `source-members.ts` is not a guard; it is the segmentation two guards' whole
 * answers are computed over. A slicer that silently stops recognising a
 * declaration shape does not fail — it folds that declaration into the
 * previous slice and quietly credits the wrong member. So the property asserted
 * here is COMPLETENESS over `service.ts` as it actually stands: every line that
 * opens a class member is the start of a slice, and no slice is a fold of two.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MEMBER_MODIFIERS,
  classMemberSlices,
  memberDeclarationName,
  sourceMemberSlices,
} from './source-members.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = path.join(HERE, '..', 'src', 'application', 'service.ts');
const QUEUE = path.join(HERE, '..', 'src', 'operator', 'queue.ts');

const CONTROL_WORDS = new Set([
  'if',
  'for',
  'switch',
  'while',
  'catch',
  'return',
  'constructor',
  'do',
  'else',
  'try',
]);

describe('the shared member slicer', () => {
  it('reads the identifier, not the modifiers', () => {
    expect(memberDeclarationName('  get policyContext(): PolicyContext {')).toBe('policyContext');
    expect(memberDeclarationName('  async dispatch(input: X): Promise<void> {')).toBe('dispatch');
    expect(memberDeclarationName('  static from(db: HqDatabase) {')).toBe('from');
    expect(memberDeclarationName('  private static async retry<T>(fn: () => T) {')).toBe('retry');
    expect(memberDeclarationName('  #resolveRequester(actor: string) {')).toBe('#resolveRequester');
    // A method literally named `get` is a member, not a bare modifier: the
    // modifier alternation requires trailing whitespace, which is what keeps
    // `OperatorQueue.get(id)` readable.
    expect(memberDeclarationName('  get(id: string): OperatorTask | null {')).toBe('get');
    // A FIELD declaration is not a member declaration for slicing: its
    // initializer lives in the constructor, and treating it as one would cut
    // the constructor's body in half.
    expect(memberDeclarationName('  readonly #getTask: (taskId: string) => OperatorTask | null;')).toBe(
      null,
    );
    // Nor is an ordinary statement or a doc line.
    expect(memberDeclarationName('   * async something(')).toBe(null);
    expect(memberDeclarationName('    const x = foo(1);')).toBe(null);
  });

  it('recognises EVERY modifier TypeScript allows before a member name', () => {
    for (const modifier of MEMBER_MODIFIERS) {
      expect(memberDeclarationName(`  ${modifier} member(): void {`), modifier).toBe('member');
    }
  });

  /**
   * The completeness property, DERIVED rather than enumerated.
   *
   * An independent, deliberately dumb scan: any line inside the class body at
   * exactly two-space indentation that ends in an open brace and contains a
   * parenthesis is a member declaration unless it is control flow. If the
   * slicer misses one of those, it folded a member into its predecessor — the
   * exact defect this file exists to prevent recurring. Listing the three
   * modifiers that were missing at `3fcc271` would go stale the moment a
   * fourth appears.
   */
  const foldedMembers = (file: string, classLine: RegExp): string[] => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const classStart = lines.findIndex((line) => classLine.test(line));
    expect(classStart, `${file} declares no class matching ${String(classLine)}`).toBeGreaterThan(-1);
    const sliced = new Set(
      classMemberSlices(lines.join('\n'), { fromLine: classStart, exclude: CONTROL_WORDS }).map(
        (slice) => slice.line,
      ),
    );
    const missed: string[] = [];
    for (let i = classStart + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/^ {2}\S/.test(line)) continue;
      if (!/\(/.test(line) || !/\{\s*$/.test(line)) continue;
      // A declaration must have an identifier before its parenthesis.
      const bare = /^ {2}(?:[A-Za-z_$][\w$]*\s+)*(#?[A-Za-z_$][\w$]*)\s*[(<]/.exec(line);
      if (!bare || CONTROL_WORDS.has(bare[1])) continue;
      if (!sliced.has(i)) missed.push(`${path.basename(file)}:${i + 1} ${line.trim()}`);
    }
    return missed;
  };

  it('folds no member of service.ts into its predecessor', () => {
    expect(foldedMembers(SERVICE, /^export class HeadquarterOperations\b/)).toEqual([]);
  });

  it('folds no member of queue.ts into its predecessor', () => {
    expect(foldedMembers(QUEUE, /^export class OperatorQueue\b/)).toEqual([]);
  });

  it('sees the accessor the previous facade slicer could not', () => {
    const source = fs.readFileSync(SERVICE, 'utf8');
    const classStart = source
      .split('\n')
      .findIndex((line) => /^export class HeadquarterOperations\b/.test(line));
    const names = classMemberSlices(source, { fromLine: classStart, exclude: CONTROL_WORDS }).map(
      (slice) => slice.name,
    );
    // The one member measured invisible at the frozen head. It is a READ, so
    // nothing was mis-decided by its absence — but its BODY was being credited
    // to whichever member preceded it, which is not a property anyone chose.
    expect(names).toContain('policyContext');
    // No duplicate line: a slice per declaration, in source order.
    const lines = classMemberSlices(source, { fromLine: classStart, exclude: CONTROL_WORDS }).map(
      (slice) => slice.line,
    );
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it('keeps module scope rather than dropping it', () => {
    const members = sourceMemberSlices(fs.readFileSync(SERVICE, 'utf8'));
    expect(members[0].kind).toBe('module');
    expect(members[0].line).toBe(0);
    // Every line of the file is in exactly one slice.
    const total = members.reduce((sum, member) => sum + member.body.split('\n').length, 0);
    expect(total).toBe(fs.readFileSync(SERVICE, 'utf8').split('\n').length);
    // Top-level functions are reported by bare name and marked as functions,
    // so a caller can tell `function missionText` from a member named the same.
    const missionText = members.find((member) => member.name === 'missionText');
    expect(missionText?.kind).toBe('function');
  });
});
