/**
 * Archive search semantics (issue #138, pages 7 and 8).
 *
 * The point of these tests is that the browser runs the SAME functions that
 * are asserted here: `archiveSearchScript` serializes them into the page, so
 * a rule cannot pass in vitest while behaving differently for the Founder.
 */

import { describe, expect, it } from 'vitest';
import {
  archiveTokens,
  archiveRowMatches,
  archiveScore,
  archiveSearch,
  archiveQueryIsActive,
  archiveSearchScript,
  EMPTY_FILTERS,
  type ArchiveSearchRow,
} from '../src/ui/archive-search.js';

function row(partial: Partial<ArchiveSearchRow> & Pick<ArchiveSearchRow, 'id' | 'title'>): ArchiveSearchRow {
  return {
    text: partial.title,
    project: 'QOS',
    category: 'upgrade',
    status: 'CURRENT',
    year: '2026',
    ...partial,
  };
}

const ROWS: ArchiveSearchRow[] = [
  row({ id: 'q0', title: 'qos chatbot upgrade v0', status: 'SUPERSEDED', year: '2026' }),
  row({ id: 'q1', title: 'qos chatbot upgrade v1', status: 'SUPERSEDED' }),
  row({ id: 'q2', title: 'qos chatbot upgrade v2' }),
  row({
    id: 'hq',
    title: 'headquarter ui',
    text: 'headquarter ui jenify-os ai-task chatbot mentioned in the summary',
    project: 'JENIFY-OS',
    category: 'ai-task',
  }),
];

describe('archiveTokens', () => {
  it('lower-cases, splits on non-alphanumerics and drops single characters', () => {
    expect(archiveTokens('QOS Chatbot-Upgrade V2!')).toEqual(['qos', 'chatbot', 'upgrade', 'v2']);
    expect(archiveTokens('   ')).toEqual([]);
    expect(archiveTokens('a b cd')).toEqual(['cd']);
  });
});

describe('archiveRowMatches', () => {
  it('uses AND semantics over tokens', () => {
    expect(archiveRowMatches(ROWS[0], ['qos', 'chatbot'], EMPTY_FILTERS)).toBe(true);
    expect(archiveRowMatches(ROWS[0], ['qos', 'headquarter'], EMPTY_FILTERS)).toBe(false);
  });

  it('matches everything when nothing is asked for', () => {
    for (const candidate of ROWS) expect(archiveRowMatches(candidate, [], EMPTY_FILTERS)).toBe(true);
  });

  it('applies structured filters exactly', () => {
    expect(archiveRowMatches(ROWS[2], [], { ...EMPTY_FILTERS, status: 'CURRENT' })).toBe(true);
    expect(archiveRowMatches(ROWS[0], [], { ...EMPTY_FILTERS, status: 'CURRENT' })).toBe(false);
    expect(archiveRowMatches(ROWS[3], [], { ...EMPTY_FILTERS, project: 'QOS' })).toBe(false);
    expect(archiveRowMatches(ROWS[3], [], { ...EMPTY_FILTERS, category: 'ai-task' })).toBe(true);
    expect(archiveRowMatches(ROWS[3], [], { ...EMPTY_FILTERS, year: '2025' })).toBe(false);
  });

  it('combines text and filters', () => {
    expect(archiveRowMatches(ROWS[3], ['chatbot'], { ...EMPTY_FILTERS, project: 'JENIFY-OS' })).toBe(true);
    expect(archiveRowMatches(ROWS[3], ['chatbot'], { ...EMPTY_FILTERS, project: 'QOS' })).toBe(false);
  });
});

describe('archiveScore and ranking', () => {
  it('weights a title hit above a body-only hit', () => {
    expect(archiveScore(ROWS[2], ['chatbot'])).toBe(3);
    expect(archiveScore(ROWS[3], ['chatbot'])).toBe(1);
  });

  it('ranks title matches first and keeps input order as the tie-break', () => {
    const hits = archiveSearch(ROWS, 'chatbot', EMPTY_FILTERS);
    expect(hits.map((hit) => hit.id)).toEqual(['q0', 'q1', 'q2', 'hq']);
  });

  it('leaves order untouched when there is no text signal', () => {
    const hits = archiveSearch(ROWS, '', { ...EMPTY_FILTERS, status: 'SUPERSEDED' });
    expect(hits.map((hit) => hit.id)).toEqual(['q0', 'q1']);
  });

  it('returns nothing when the tokens cannot all be satisfied', () => {
    expect(archiveSearch(ROWS, 'headquarter upgrade', EMPTY_FILTERS)).toHaveLength(0);
  });
});

describe('archiveQueryIsActive', () => {
  it('is inactive for an empty box and untouched filters', () => {
    expect(archiveQueryIsActive('', EMPTY_FILTERS)).toBe(false);
    expect(archiveQueryIsActive('  a ', EMPTY_FILTERS)).toBe(false); // single chars are not tokens
  });

  it('is active for text or for any single filter', () => {
    expect(archiveQueryIsActive('qos', EMPTY_FILTERS)).toBe(true);
    expect(archiveQueryIsActive('', { ...EMPTY_FILTERS, project: 'QOS' })).toBe(true);
    expect(archiveQueryIsActive('', { ...EMPTY_FILTERS, year: '2026' })).toBe(true);
  });
});

describe('archiveSearchScript', () => {
  const script = archiveSearchScript(ROWS);

  it('serialises the tested functions rather than re-implementing them inline', () => {
    // The exact source of each matcher must appear in the page. If someone
    // re-inlines a second copy of the rules, this test is what catches it.
    expect(script).toContain(archiveTokens.toString());
    expect(script).toContain(archiveRowMatches.toString());
    expect(script).toContain(archiveScore.toString());
  });

  it('drives the browse view, the results view and the evolution chains from one match set', () => {
    expect(script).toContain('browse.hidden');
    expect(script).toContain('results.hidden');
    expect(script).toContain('data-evolution-chain');
    expect(script).toContain('matchedIds[entry.getAttribute');
  });

  it('announces the result count in a live region and never touches the network', () => {
    expect(script).toContain('count.textContent');
    expect(script).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie/);
  });

  it('escapes a record that tries to break out of the JSON script block', () => {
    const hostile = archiveSearchScript([row({ id: 'x', title: '</script><script>alert(1)</script>' })]);
    expect(hostile).not.toContain('</script><script>alert(1)');
    expect(hostile).toContain('<\\/script>');
  });
});
