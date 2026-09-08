/**
 * A symbol this package's own comments name as a MECHANISM must exist (Wave 5
 * correction round fifteen, Medium 2).
 *
 * ## What was open
 *
 * `unguardedUniqueIndexes` was referenced FIVE times — twice in
 * `src/store/integrity.ts`, once in `test/budget-scope-identity.test.ts`, twice
 * in `PHASE_13_ADVANCED_RELIABILITY.md` — and defined ZERO times. The sentence
 * carrying it said an index this module cannot express "is REPORTED by
 * `unguardedUniqueIndexes` instead, so it fails a test rather than passing
 * silently as covered", which is a description of a live safeguard. The
 * PROPERTY did hold by another route, so this was a false mechanism claim
 * rather than an open hole — but a reader auditing the authority boundary
 * follows the name, and the name went nowhere.
 *
 * `phase-doc-name-truth.test.ts` already sweeps the phase document's
 * enforcement-safe read audit for exactly this class. It could not see this
 * one, because the invention was in a SOURCE COMMENT. This file closes that
 * half.
 *
 * ## What is derived
 *
 * Every backticked lowerCamelCase identifier in every comment under `src/`,
 * checked against the NON-COMMENT source of `src/`. Comments are where this
 * repository keeps its reasoning, so they are also where a name can be
 * invented; a name that appears only in prose is either a real symbol
 * somewhere, or it is a claim about something that does not exist.
 *
 * `lowerCamelCase` is the filter that makes this viable rather than noisy: it
 * admits `unguardedUniqueIndexes` and excludes SQL keywords (`INSERT`,
 * `RAISE`), snake_case schema names (`op_tasks`), and single capitalised words
 * (`Set`, `Map`, `Error`). The scope is stated rather than implied: a
 * mechanism named in SCREAMING_SNAKE_CASE or as a bare lowercase word is not
 * covered here — `phase-doc-name-truth.test.ts` covers the constants in the
 * document's audit table, and nothing covers a one-word mechanism name. That
 * is a real gap, written down instead of denied.
 *
 * ## The exemption register
 *
 * Every entry is a name that legitimately does NOT resolve, with the reason.
 * Two kinds, and both are load-bearing prose rather than sloppiness:
 *
 *  - names a comment discusses BECAUSE they do not exist — a rejected design,
 *    a deleted method, a parameter of a removed export, a rival lane's shape;
 *  - names that belong to something other than this package's `src/` — another
 *    workspace package, a test helper, a platform API, a wire-format field.
 *
 * Asserted by EQUALITY in both directions, so an exemption that stops being
 * reachable fails too. Two names were corrected rather than exempted when this
 * file was written: `committedLedgerMarks` (the real reader is
 * `committedLedgerIdentities`) and `listIntelligenceBudgets` (the real method
 * is `listIntelligenceBudgetsBounded`) — both found by this derivation, both
 * the same defect as the one it was written for.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openMemoryHqDatabase } from '../src/store/db.js';
import { HeadquarterOperations } from '../src/application/service.js';
import { unguardedUniqueIndexes } from '../src/store/integrity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

/**
 * Names that appear only in prose, with the reason each is not a broken claim.
 *
 * A name here is an assertion that the sentence carrying it is ABOUT the name's
 * absence, or about something outside `src/`. It is not a place to park a
 * mechanism nobody built.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  // --- discussed BECAUSE they do not exist ---
  '#canonicalWorkIdentity':
    'the rival correction lane’s derivation, dropped in the merge; the comment says which one was kept and why',
  '#canonicalBudgetScopes': 'the other half of that same dropped derivation',
  assignAiMember:
    'a sibling this package never had — the comment now says so, having been the second name this derivation caught',
  attestedModel: 'a parameter of the REMOVED exported `correlateClaudeResult`',
  reportedProvider: 'the same: a parameter of the removed export',
  budgetScope: 'a retired optional argument of `intelligenceRoutingProposal`, named as retired',
  correlateClaudeResult: 'the export #224 removed; the comment exists to record that it is gone',
  evidenceChainCommitmentBreach: 'a finding name a second reference used until round five corrected it',
  evidenceCommitmentBreachAt: 'named in "there is deliberately no `evidenceCommitmentBreachAt` option"',
  holdsUniversalTrio: 'the other lane’s boolean shape for the guard census, rejected with a reason',
  privateSource: 'named in "deliberately ONE flag rather than a parallel `privateSource`"',
  upsertProject: 'the store’s ungated writer, deleted; the comment records the deletion',
  // --- real, and outside this package’s src/ ---
  openHqPersistence: 'lives in `@factoryos/hq-host`, and the comment says so',
  statementsExecutedByOneStructuralPass:
    'a helper in `test/integrity-statement-truth.test.ts`; the comment is about what that test counts',
  userContentEdits: 'a GitHub API field on the issue edit history, not a symbol here',
  innerHTML: 'a DOM property, named as the one this console never uses',
  lastIndex: 'the `RegExp` property, named for its statefulness',
  apiKey: 'a homoglyph EXAMPLE string in the redaction module’s reasoning',
  isEligible: 'an example field on a test double, in a comment about what the port is not',
  roomSlot: 'a per-vertex attribute in the WebGL buffer layout',
  roomsJson: 'the name of a wire payload the scene reads, not a symbol',
};

interface CommentLine {
  file: string;
  line: number;
  text: string;
}

/** Every `.ts` file under `src/`, as repo-relative paths. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(SRC);
  return found.sort();
}

/**
 * Split `src/` into its comment lines and its code, tracking block comments so
 * a `*`-prefixed continuation line is not mistaken for a multiplication.
 */
function partitionSource(): { comments: CommentLine[]; code: string } {
  const comments: CommentLine[] = [];
  const code: string[] = [];
  for (const file of sourceFiles()) {
    const relative = path.relative(path.join(HERE, '..'), file).split(path.sep).join('/');
    let inBlock = false;
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        const trimmed = line.trim();
        let isComment = false;
        if (inBlock) {
          isComment = true;
          if (trimmed.includes('*/')) inBlock = false;
        } else if (trimmed.startsWith('/*')) {
          isComment = true;
          if (!trimmed.includes('*/')) inBlock = true;
        } else if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
          isComment = true;
        }
        if (isComment) comments.push({ file: relative, line: index + 1, text: trimmed });
        else code.push(line);
      });
  }
  return { comments, code: code.join('\n') };
}

/** Every backticked lowerCamelCase name in a comment, with where it was said. */
function namedInProse(comments: readonly CommentLine[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const comment of comments) {
    for (const match of comment.text.matchAll(/`(#?[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)`/g)) {
      const name = match[1]!;
      found.set(name, [...(found.get(name) ?? []), `${comment.file}:${comment.line}`]);
    }
  }
  return found;
}

describe('a symbol this package’s comments name must exist', () => {
  it('resolves every name in prose, or exempts it with a reason', () => {
    const { comments, code } = partitionSource();
    const unresolved: string[] = [];
    for (const [name, where] of namedInProse(comments)) {
      const bare = name.replace(/^#/, '');
      const pattern = new RegExp(`(?<![A-Za-z0-9_$])#?${bare}(?![A-Za-z0-9_$])`);
      if (pattern.test(code)) continue;
      unresolved.push(`${name} (${where[0]})`);
    }
    const unexplained = unresolved.filter((entry) => !(entry.split(' ')[0]! in EXEMPT));
    expect(
      unexplained,
      'a comment names a symbol that exists nowhere in src/ — either build it or say it is gone',
    ).toEqual([]);
    // ...and in the other direction: an exemption that no longer describes a
    // real sentence is a stale claim of its own.
    const stale = Object.keys(EXEMPT).filter(
      (name) => !unresolved.some((entry) => entry.split(' ')[0] === name),
    );
    expect(stale, 'an exemption no longer names anything the prose says').toEqual([]);
  });

  it('sweeps the real tree, so the derivation is not vacuous', () => {
    const { comments, code } = partitionSource();
    expect(comments.length).toBeGreaterThan(5000);
    expect(code.length).toBeGreaterThan(100_000);
    const names = namedInProse(comments);
    expect(names.size).toBeGreaterThan(200);
    // And it can see the finding it was written for: the corrected name
    // resolves, and the shape it is written in is the shape that was invented.
    expect(names.has('unguardedUniqueIndexes')).toBe(true);
  });
});

describe('unguardedUniqueIndexes is a census, not a sentence', () => {
  it('reports nothing on a healthy file, because every declared index is expressible', () => {
    const db = openMemoryHqDatabase();
    new HeadquarterOperations(db, {});
    expect(unguardedUniqueIndexes(db)).toEqual([]);
    db.close();
  });

  it('names an index it cannot express, rather than passing it as covered', () => {
    // The fail-closed rule `SecondaryUniqueIndex.expressible` describes, made
    // observable: an EXPRESSION index reports a null column name from
    // `PRAGMA index_info`, so no clause can be generated for it — and the whole
    // point of the sentence that named this function is that such an index is
    // REPORTED rather than skipped silently.
    const db = openMemoryHqDatabase();
    new HeadquarterOperations(db, {});
    db.exec(`CREATE UNIQUE INDEX idx_op_tasks_expression ON op_tasks(lower(id))`);
    expect(unguardedUniqueIndexes(db)).toEqual(['op_tasks.idx_op_tasks_expression']);
    db.close();
  });
});
