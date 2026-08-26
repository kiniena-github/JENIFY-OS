import { describe, expect, it } from 'vitest';
import { reconstructArchive, linkEvolutionChain } from '../src/archive/inventory.js';
import { monthlyView, projectEvolutionView, listProjects } from '../src/archive/views.js';
import { buildIndex, search, tokenize } from '../src/archive/search.js';

const OPTS = { defaultProject: 'JENIFY-OS', fallbackDate: '2026-01-01' };

function fixtures() {
  const records = reconstructArchive(
    [
      { kind: 'file', id: 'q0', title: 'QOS chatbot upgrade V0', project: 'QOS', category: 'upgrade', date: '2026-06-10', dateSource: 'manual', location: 'drive://q0' },
      { kind: 'file', id: 'q1', title: 'QOS chatbot upgrade V1', project: 'QOS', category: 'upgrade', date: '2026-07-15', dateSource: 'manual', location: 'drive://q1' },
      { kind: 'file', id: 'q2', title: 'QOS chatbot upgrade V2', project: 'QOS', category: 'upgrade', date: '2026-08-20', dateSource: 'manual', location: 'drive://q2' },
      { kind: 'report', id: 'news', title: 'Jenify News 0.2.0 checkpoint', project: 'Jenify News', category: 'report', date: '2026-08-20', dateSource: 'manual', location: 'repo://jenify-news' },
      { kind: 'issue', id: '43', title: 'Stream 2 Headquarter UI', project: 'JENIFY-OS', category: 'ai-task', date: '2026-08-26T10:01:18Z', dateSource: 'github-api', location: 'https://github.com/kiniena-github/JENIFY-OS/issues/43' },
    ],
    OPTS,
  );
  return linkEvolutionChain(records, ['file-q0', 'file-q1', 'file-q2']);
}

describe('monthly view', () => {
  it('groups by year/month, newest month first, chronological within a month', () => {
    const groups = monthlyView(fixtures());
    expect(groups.map((group) => `${group.year}-${group.month}`)).toEqual(['2026-08', '2026-07', '2026-06']);
    const august = groups[0];
    expect(august.records.map((record) => record.id)).toEqual(['file-q2', 'report-news', 'issue-43']);
  });
});

describe('project evolution view', () => {
  it('follows predecessor/successor chains per project', () => {
    const chains = projectEvolutionView(fixtures(), 'QOS');
    expect(chains).toHaveLength(1);
    expect(chains[0].entries.map((entry) => entry.id)).toEqual(['file-q0', 'file-q1', 'file-q2']);
    expect(chains[0].entries.map((entry) => entry.status)).toEqual(['SUPERSEDED', 'SUPERSEDED', 'CURRENT']);
  });

  it('lists distinct projects', () => {
    expect(listProjects(fixtures())).toEqual(['JENIFY-OS', 'Jenify News', 'QOS']);
  });
});

describe('search foundations', () => {
  it('answers "show every QOS chatbot upgrade" without folder hunting', () => {
    const index = buildIndex(fixtures());
    const hits = search(index, { text: 'qos chatbot upgrade' });
    expect(hits.map((hit) => hit.record.id).sort()).toEqual(['file-q0', 'file-q1', 'file-q2']);
  });

  it('applies structured filters (project, category, status, year)', () => {
    const index = buildIndex(fixtures());
    expect(search(index, { project: 'QOS', status: 'CURRENT' }).map((hit) => hit.record.id)).toEqual(['file-q2']);
    expect(search(index, { category: 'ai-task' })).toHaveLength(1);
    expect(search(index, { project: 'QOS', year: '2026' })).toHaveLength(3);
    expect(search(index, { text: 'chatbot', project: 'Jenify News' })).toHaveLength(0);
  });

  it('uses AND semantics over tokens', () => {
    const index = buildIndex(fixtures());
    expect(search(index, { text: 'headquarter chatbot' })).toHaveLength(0);
  });

  it('tokenizes case-insensitively and drops single characters', () => {
    expect(tokenize('QOS Chatbot-Upgrade V2!')).toEqual(['qos', 'chatbot', 'upgrade', 'v2']);
  });
});
