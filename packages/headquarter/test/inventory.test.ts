import { describe, expect, it } from 'vitest';
import {
  createGitLogAdapter,
  createGitHubExportAdapter,
  createStaticExportAdapter,
  linkEvolutionChain,
  reconstructArchive,
  versionFromTitle,
  type EvidenceItem,
} from '../src/archive/inventory.js';
import { validateArchiveRecord } from '../src/archive/schema.js';

const OPTS = { defaultProject: 'JENIFY-OS', fallbackDate: '2026-01-01' };

describe('git log adapter', () => {
  it('parses %H/%aI/%s records separated by unit/record separators', () => {
    const raw =
      'ed20eb2427119502582ddc18be9badcc4d1a4ad9\x1f2026-08-26T09:40:00+00:00\x1fMerge PR #27: Fix Gemini 3.7 worker model routing\x1e' +
      'c939c99aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f2026-08-26T08:00:00+00:00\x1fRemove temporary workflow\x1e';
    const items = createGitLogAdapter(raw, {
      project: 'JENIFY-OS',
      repoUrl: 'https://github.com/kiniena-github/JENIFY-OS',
    }).collect();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'commit',
      id: 'ed20eb2',
      project: 'JENIFY-OS',
      category: 'code-change',
      dateSource: 'git',
      location: 'https://github.com/kiniena-github/JENIFY-OS/commit/ed20eb2427119502582ddc18be9badcc4d1a4ad9',
    });
  });
});

describe('github export adapter', () => {
  it('maps issues and PRs with original URLs preserved', () => {
    const items = createGitHubExportAdapter({
      repo: 'kiniena-github/JENIFY-OS',
      issues: [{ number: 43, title: 'Stream 2', created_at: '2026-08-26T10:01:18Z', labels: ['ai-task'] }],
      pullRequests: [{ number: 36, title: 'Codex review', created_at: '2026-08-26T07:43:51Z' }],
    }).collect();
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: 'issue',
      category: 'ai-task',
      location: 'https://github.com/kiniena-github/JENIFY-OS/issues/43',
    });
    expect(items[1]).toMatchObject({
      kind: 'pull_request',
      location: 'https://github.com/kiniena-github/JENIFY-OS/pull/36',
    });
  });
});

describe('reconstruction', () => {
  it('produces valid records, keeps originals, and never mutates inputs', () => {
    const evidence: EvidenceItem[] = [
      {
        kind: 'report',
        id: 'monthly-2026-07',
        title: 'July report',
        date: '2026-07-31',
        dateSource: 'filename',
        location: 'docs/reports/2026-07.md',
      },
    ];
    const frozen = JSON.parse(JSON.stringify(evidence));
    const records = reconstructArchive(evidence, OPTS);
    expect(evidence).toEqual(frozen); // sources untouched
    expect(records[0].sourceRef).toBe('docs/reports/2026-07.md');
    expect(validateArchiveRecord(records[0])).toEqual([]);
  });

  it('assigns date confidence by evidence source', () => {
    const records = reconstructArchive(
      [
        { kind: 'commit', id: 'abc', title: 'x', date: '2026-08-01T00:00:00Z', dateSource: 'git', location: 'l1' },
        { kind: 'file', id: 'f', title: 'y', date: '2026-08-02', dateSource: 'filename', location: 'l2' },
        { kind: 'report', id: 'r', title: 'z', location: 'l3' },
      ],
      OPTS,
    );
    expect(records.map((record) => record.created.confidence)).toEqual(['exact', 'inferred', 'estimated']);
    expect(records[2].created.date).toBe('2026-01-01'); // fallback, flagged estimated
  });

  it('is deterministic for the same evidence', () => {
    const items = createStaticExportAdapter('drive-export', [
      { kind: 'file', id: 'plan', title: 'QOS plan V2', location: 'drive://plan' },
    ]).collect();
    expect(reconstructArchive(items, OPTS)).toEqual(reconstructArchive(items, OPTS));
  });

  it('extracts version tokens from titles', () => {
    expect(versionFromTitle('Corporate structure V0 draft')).toBe('V0');
    expect(versionFromTitle('Close R4 bug-family matrix')).toBe('R4');
    expect(versionFromTitle('No version here')).toBe('v1');
  });
});

describe('evolution chain linking', () => {
  it('links predecessor/successor and marks earlier entries SUPERSEDED', () => {
    const records = reconstructArchive(
      [
        { kind: 'file', id: 'v0', title: 'QOS chatbot V0', date: '2026-06-01', dateSource: 'manual', location: 'a' },
        { kind: 'file', id: 'v1', title: 'QOS chatbot V1', date: '2026-07-01', dateSource: 'manual', location: 'b' },
        { kind: 'file', id: 'v2', title: 'QOS chatbot V2', date: '2026-08-01', dateSource: 'manual', location: 'c' },
      ],
      OPTS,
    );
    const linked = linkEvolutionChain(records, ['file-v0', 'file-v1', 'file-v2']);
    expect(linked[0]).toMatchObject({ predecessorId: null, successorIds: ['file-v1'], status: 'SUPERSEDED' });
    expect(linked[1]).toMatchObject({ predecessorId: 'file-v0', successorIds: ['file-v2'], status: 'SUPERSEDED' });
    expect(linked[2]).toMatchObject({ predecessorId: 'file-v1', successorIds: [], status: 'CURRENT' });
  });

  it('never downgrades terminal statuses and rejects unknown ids', () => {
    const records = reconstructArchive(
      [
        { kind: 'file', id: 'v0', title: 'Plan V0', date: '2026-06-01', dateSource: 'manual', location: 'a', status: 'REJECTED' },
        { kind: 'file', id: 'v1', title: 'Plan V1', date: '2026-07-01', dateSource: 'manual', location: 'b' },
      ],
      OPTS,
    );
    const linked = linkEvolutionChain(records, ['file-v0', 'file-v1']);
    expect(linked[0].status).toBe('REJECTED');
    expect(() => linkEvolutionChain(records, ['missing'])).toThrow(/unknown record id/);
  });
});
