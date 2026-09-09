/**
 * Wave 5, correction round ten — Low 2: the NFKD mark-strip's new refusal
 * class, executed rather than described.
 *
 * The round-seven mark-strip closed a real evasion (a combining mark splitting
 * a credential shape in two while leaving every character of the key present),
 * and its cost was measured as "no new refusal on accented prose in five
 * languages". A hyphenated proper NAME is not prose, and the measurement did
 * not reach it: `ŠK-Slovan-Bratislava-1919` passed before the wave — `Š` is a
 * precomposed `Lu` that `NFKC` leaves alone — and is refused now, because the
 * `NFKD` strip folds it to `S` and the case-insensitive `sk-` rule fires.
 *
 * The decision recorded at `redaction.ts` is to DISCLOSE rather than narrow the
 * `sk-` shape, because the ASCII spelling of the same string was already
 * refused before this wave and narrowing a credential rule to buy back an
 * availability cost is a change in the direction of under-refusal. A disclosure
 * is only worth anything if it is exact, so this file executes the class rather
 * than restating the sentence: which letters reach it, that they all do, that
 * neighbouring accented names do not, and — the half that must never move —
 * that the evasion the fold exists for is still caught.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertBrowserSafe } from '../src/live/redaction.js';

const REDACTION_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'live',
  'redaction.ts',
);

/** Whether the guard refuses the snapshot this string is carried on. */
function refuses(text: string): boolean {
  try {
    assertBrowserSafe({ text });
    return false;
  } catch {
    return true;
  }
}

/**
 * Every non-ASCII letter whose NFKD mark-strip leaves exactly one ASCII letter,
 * keyed by that letter. Derived from the Unicode tables the fold actually uses,
 * so a future change to the fold changes this set rather than being argued
 * around it.
 */
function lettersFoldingTo(target: 's' | 'k'): string[] {
  const found: string[] = [];
  for (let codePoint = 0x80; codePoint <= 0x2ffff; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    if (!/\p{L}/u.test(character)) continue;
    const folded = character.normalize('NFKD').replace(/[\p{Mn}\p{Me}]/gu, '');
    if (folded.toLowerCase() === target) found.push(character);
  }
  return found;
}

/** The mark-strip alone, which is the step round seven added. */
function strip(value: string): string {
  return value.normalize('NFKD').replace(/[\p{Mn}\p{Me}]/gu, '');
}

/**
 * Everything the enumeration above is structurally blind to.
 *
 * `lettersFoldingTo` walks only `\p{L}` characters and keeps only folds of
 * length one, so two shapes can never appear in it however far the fold moves:
 * a NON-letter that folds to a single `s`/`k`, and any character whose fold is
 * MULTI-character and ends in an s-like letter behind a non-alphanumeric — the
 * second of which reaches the `sk-` shape when an ordinary `k` follows it. The
 * whole plane is walked here, without either filter, so the two shapes are
 * enumerated rather than assumed absent (round twelve, Low 1).
 */
function reachesTheShapeOutsideTheLetterEnumeration(): {
  nonLetterSingle: string[];
  multiCharacter: string[];
} {
  const enumerated = new Set([...lettersFoldingTo('s'), ...lettersFoldingTo('k')]);
  const nonLetterSingle: string[] = [];
  const multiCharacter: string[] = [];
  for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint += 1) {
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
    const character = String.fromCodePoint(codePoint);
    if (enumerated.has(character)) continue;
    const folded = strip(character).toLowerCase();
    if (folded === 's' || folded === 'k') nonLetterSingle.push(character);
    else if (folded.length > 1 && /[^\p{L}\p{N}]s$/u.test(folded)) multiCharacter.push(character);
  }
  return { nonLetterSingle, multiCharacter };
}

/** 22 characters of `[A-Za-z0-9_-]`, comfortably over the shape's 16. */
const TAIL = '-Slovan-Bratislava-1919';

describe('the shapes the letter enumeration cannot see are enumerated separately', () => {
  /**
   * The defect this block exists for: the sibling describe below is titled
   * "exactly … and no wider", and its evidence is `lettersFoldingTo`, which can
   * only ever return single `\p{L}` characters folding to one letter. Two whole
   * shapes were therefore invisible to it while the title claimed completeness.
   * They are enumerated and named here, and — the half that decides whether the
   * disclosure was wrong or merely imprecise — each is shown to have been
   * refused BEFORE the mark-strip existed, so none of them is a cost the fold
   * added.
   */
  it('names every non-letter and multi-character fold that reaches the sk- shape', () => {
    const { nonLetterSingle, multiCharacter } = reachesTheShapeOutsideTheLetterEnumeration();

    // Exactly the three the plane holds, by name, so a future Unicode or fold
    // change that adds a fourth fails here instead of passing invisibly.
    expect(multiCharacter).toEqual(['℁', '㎧', '㎮']);
    expect(multiCharacter.map((character) => strip(character))).toEqual(['a/s', 'm∕s', 'rad∕s']);
    // And the eight non-letters, which the `\p{L}` filter also drops.
    expect(nonLetterSingle).toEqual([
      'Ⓚ',
      'Ⓢ',
      'ⓚ',
      'ⓢ',
      '\u{1CCE0}',
      '\u{1CCE8}',
      '\u{1F13A}',
      '\u{1F142}',
    ]);

    // Every one of them really does reach a refusal — the multi-character ones
    // need an ordinary `k` after them, because their fold ENDS in the s.
    for (const character of multiCharacter) {
      expect(refuses(`${character}k${TAIL}`), `${character} + k`).toBe(true);
    }
    for (const character of nonLetterSingle) {
      const folded = strip(character).toLowerCase();
      const probe = folded === 's' ? `${character}K${TAIL}` : `S${character}${TAIL}`;
      expect(refuses(probe), character).toBe(true);
    }
  });

  it('shows none of them is a cost the mark-strip added, by running the pipeline without it', () => {
    // The pre-round-seven pipeline is this one minus the `NFKD` strip. If a
    // string already folded to the shape under `NFKC` alone, the strip did not
    // newly refuse it, and it is not in the class the disclosure describes.
    const { nonLetterSingle, multiCharacter } = reachesTheShapeOutsideTheLetterEnumeration();
    const beforeTheStrip = (value: string): boolean => /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/i.test(
      value.normalize('NFKC'),
    );
    for (const character of multiCharacter) {
      expect(beforeTheStrip(`${character}k${TAIL}`), `${character} was already refused`).toBe(true);
    }
    for (const character of nonLetterSingle) {
      const folded = strip(character).toLowerCase();
      const probe = folded === 's' ? `${character}K${TAIL}` : `S${character}${TAIL}`;
      expect(beforeTheStrip(probe), `${character} was already refused`).toBe(true);
    }
    // The control: the string the fold really DID newly refuse does NOT fold to
    // the shape without the strip, which is what makes it the class.
    expect(beforeTheStrip('ŠK-Slovan-Bratislava-1919')).toBe(false);
    expect(refuses('ŠK-Slovan-Bratislava-1919')).toBe(true);
  });

  it('no longer claims the single-letter enumeration is the whole class', () => {
    const source = fs.readFileSync(REDACTION_SOURCE, 'utf8');
    expect(source).not.toMatch(/Nothing else in the class exists/);
    // And the shapes it was blind to are named where the class is stated.
    expect(source).toContain('℁');
    expect(source).toContain('㎮');
  });
});

describe('the mark-strip’s new refusal class is exactly the s-then-k prefix, and no wider', () => {
  it('refuses every non-ASCII spelling of the two-letter head, and the ASCII head already was', () => {
    // The pre-existing over-breadth: this is what the fold added SPELLINGS of,
    // rather than a refusal class the fold invented.
    expect(refuses(`SK${TAIL}`)).toBe(true);

    const sLike = lettersFoldingTo('s');
    const kLike = lettersFoldingTo('k');
    expect(sLike.length).toBeGreaterThan(0);
    expect(kLike.length).toBeGreaterThan(0);
    // The class named in the disclosure, executed at both positions.
    const survivors = sLike.filter((letter) => !refuses(`${letter}K${TAIL}`));
    expect(survivors, 'every s-like letter must reach the same refusal').toEqual([]);
    const kSurvivors = kLike.filter((letter) => !refuses(`S${letter}${TAIL}`));
    expect(kSurvivors, 'every k-like letter must reach the same refusal').toEqual([]);
    // And the one the reviewer executed, by name.
    expect(refuses('ŠK-Slovan-Bratislava-1919')).toBe(true);
  });

  it('leaves an accented hyphenated name that does not spell s-then-k alone', () => {
    // The disclosure claims the class is the PREFIX and nothing wider. These
    // are the neighbouring shapes it would have swallowed if it were not.
    for (const name of [
      'Škoda-Auto-Mladá-Boleslav',
      'Sköldebrand-Åkerström-Handelsbolaget',
      'Ćwikliński-Żółkiewski-Przedsiębiorstwo',
      'Mesob-Salt-Factory-Addis-Ababa',
      'Müller-Röchling-Salzwerke-Jahresbericht',
    ]) {
      expect(refuses(name), name).toBe(false);
    }
  });

  it('keeps refusing nothing on the legitimate multi-script strings the fold was measured against', () => {
    for (const text of [
      'የመሶብ ጨው ፋብሪካ አዲስ አበባ ኢትዮጵያ ምርት ሪፖርት 2026',
      'ООО «Технострой-Инжиниринг» отчёт о производстве соли 2026',
      'Ελληνικά Αλυκαί Α.Ε. — έκθεση παραγωγής αλατιού 2026',
      'Société Générale d’Exploitation — rapport trimestriel, chiffre d’affaires',
      'İstanbul Tuz Sanayi ve Ticaret Anonim Şirketi — üretim raporu',
      'Công ty Cổ phần Muối Việt Nam — báo cáo sản xuất năm 2026',
      'מפעל המלח בע״מ דוח ייצור שנתי',
      'شركة الملح المحدودة تقرير الإنتاج السنوي ٢٠٢٦',
      'नमक कारखाना प्राइवेट लिमिटेड उत्पादन रिपोर्ट',
      'บริษัท เกลือไทย จำกัด รายงานการผลิต',
    ]) {
      expect(refuses(text), text).toBe(false);
    }
  });
});

describe('the disclosure states the class in numbers the fold actually produces', () => {
  it('matches the two counts written at the fold to the two counts measured through it', () => {
    // A disclosure is only worth the precision it carries, and a hand-written
    // number goes stale the first time the fold changes. So the two counts in
    // `redaction.ts` are compared to the counts derived above: widening or
    // narrowing the fold fails here until the sentence is re-measured.
    const source = fs.readFileSync(REDACTION_SOURCE, 'utf8');
    const claimed = /(\d+)\s*\n?\s*\*?\s*non-ASCII letters fold to `s`[\s\S]{0,200}?and (\d+) fold\s*\n?\s*\*?\s*to `k`/.exec(
      source.replace(/\r/g, ''),
    );
    expect(claimed, 'the fold must state how many letters reach the class').toBeTruthy();
    expect(Number(claimed![1])).toBe(lettersFoldingTo('s').length);
    expect(Number(claimed![2])).toBe(lettersFoldingTo('k').length);
    // And the class itself has to be named, not merely counted.
    expect(source).toMatch(/newly refused/i);
    expect(source).toMatch(/ŠK-Slovan-Bratislava-1919/);
  });
});

describe('disclosing the false positive does not move the evasion direction', () => {
  it('still catches every mark and unassigned code point the fold was added for', () => {
    // The five the round-eight review confirmed caught. A narrowing of the fold
    // to buy back the refusal class above would show up here first.
    const evasions: [string, string][] = [
      ['U+0301 COMBINING ACUTE ACCENT', 'sk-ÁBCDEFGHIJKLMNOP0123'],
      ['U+20DD COMBINING ENCLOSING CIRCLE', 'sk-A⃝BCDEFGHIJKLMNOP0123'],
      ['U+0378 unassigned', 'sk-A͸BCDEFGHIJKLMNOP0123'],
      ['U+05BF HEBREW POINT RAFE', 'sk-AֿBCDEFGHIJKLMNOP0123'],
      ['U+0E31 THAI CHARACTER MAI HAN AKAT', 'sk-AัBCDEFGHIJKLMNOP0123'],
    ];
    for (const [label, text] of evasions) {
      expect(refuses(text), label).toBe(true);
    }
    // The unobscured control, so a guard that refused everything would not pass
    // this test by accident.
    expect(refuses('sk-ABCDEFGHIJKLMNOP0123')).toBe(true);
    expect(refuses('a perfectly ordinary sentence about salt production')).toBe(false);
  });
});

/**
 * Wave 5, correction round fourteen — Low 5: a real refusal class the disclosed
 * cost did not name, GIT BRANCH NAMES.
 *
 * The shipped disclosure prices the `sk-` rule's availability cost in accented
 * proper names and in prose. It does not mention the one string shape this
 * repository's own automation protocol mandates by name: a branch, spelled
 * `ai/<issue>-<slug>` or `claude/<slug>`, which routinely reaches facade text
 * fields (a mission title, a task title, a plan-item summary, a note). A slug
 * that begins `sk-` and runs long enough is refused, and a Founder or worker
 * pasting one gets a credential refusal for a branch name.
 *
 * Measured rather than described, and the boundary is measured too, because
 * "branch names are refused" would be as wrong in the other direction: the rule
 * is anchored at a non-alphanumeric boundary and needs 16 following characters,
 * so the great majority of real branch names pass and the refusal is narrow.
 *
 * The DECISION is unchanged and is the same one round ten recorded: disclose
 * rather than narrow. `sk-` followed by sixteen key characters is the shape of a
 * live OpenAI key, the ASCII spelling was refused before this wave, and
 * narrowing a credential rule to buy back an availability cost is a change in
 * the direction of under-refusal. What changes is that the cost is now stated
 * where a reader will meet it.
 */
describe('the refusal class the disclosed cost did not name: git branch names', () => {
  /** Branch names this repository's own protocol produces, and near neighbours. */
  const BRANCHES: readonly { name: string; refused: boolean }[] = [
    // Refused: `sk-` at a boundary with sixteen or more following characters.
    { name: 'feature/sk-rework-of-the-evaporation-model', refused: true },
    { name: 'ai/271-sk-rework-of-the-evaporation-model', refused: true },
    { name: 'claude/sk-rework-of-the-evaporation', refused: true },
    { name: 'sk-rework-of-the-evaporation-model', refused: true },
    // The boundary itself, both sides of it.
    { name: 'feature/sk-abcdefghijklmnop', refused: true },
    { name: 'feature/sk-abcdefghijklmno', refused: false },
    // Passed: everything else, including the shapes that look closest.
    { name: 'ai/267-sk-rework', refused: false },
    { name: 'docs/sk-notes', refused: false },
    { name: 'feature/task-scheduler-improvements', refused: false },
    { name: 'feature/skew-correction', refused: false },
    { name: 'ai/12-skip-broken-test', refused: false },
    { name: 'ai/267-rowid-guard', refused: false },
    { name: 'claude/wave5-fix', refused: false },
    { name: 'release/2026-09', refused: false },
    { name: 'main', refused: false },
  ];

  it('refuses exactly the branch names whose slug carries a full key shape', () => {
    for (const branch of BRANCHES) {
      expect(refuses(branch.name), branch.name).toBe(branch.refused);
    }
    // The class is real and it is NARROW, and both halves are the disclosure.
    expect(BRANCHES.filter((branch) => branch.refused).length).toBe(5);
    expect(BRANCHES.filter((branch) => !branch.refused).length).toBe(10);
  });

  it('is what the anchored rule and its length bound produce, not an accident', () => {
    const source = fs.readFileSync(REDACTION_SOURCE, 'utf8');
    // The two properties the boundary above depends on. If either moves, the
    // table above stops describing the behaviour and this fails with it.
    expect(source).toContain('(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}');
  });

  it('the disclosure names this class where a reader would meet it', () => {
    const page = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'docs',
        'HEADQUARTER',
        'PHASE_13_ADVANCED_RELIABILITY.md',
      ),
      'utf8',
    );
    expect(page).toContain('a git BRANCH NAME');
    expect(page).toContain('feature/sk-rework-of-the-evaporation-model');
  });
});
