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

/** 22 characters of `[A-Za-z0-9_-]`, comfortably over the shape's 16. */
const TAIL = '-Slovan-Bratislava-1919';

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
