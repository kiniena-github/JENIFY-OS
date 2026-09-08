/**
 * GitHub adapter: exact provenance, canonical locators, and rejection of
 * malformed or cross-repo metadata.
 */
import { describe, expect, it } from 'vitest';
import { githubLocator, normalizeGitHubItem, syncGitHub } from '../src/connectors/github.js';
import { createConnectorIndex } from '../src/connectors/sync.js';
import type { PageResult } from '../src/connectors/types.js';

const REPO = 'kiniena-github/JENIFY-OS';
const CONFIG = { repo: REPO };
const NOW = '2026-08-27T12:00:00Z';

function normalized(raw: unknown) {
  const result = normalizeGitHubItem(raw, NOW, CONFIG);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.item;
}

function rejection(raw: unknown): string {
  const result = normalizeGitHubItem(raw, NOW, CONFIG);
  if (result.ok) throw new Error('expected rejection');
  return result.reason;
}

describe('exact provenance', () => {
  it('preserves the issue number and constructs the canonical locator', () => {
    const item = normalized({
      kind: 'issue',
      number: 140,
      title: 'Retry HQ lane G',
      body: 'Implement safe GitHub + Drive connectors',
      created_at: '2026-08-27T10:44:57Z',
      updated_at: '2026-08-27T12:13:12Z',
      html_url: `https://github.com/${REPO}/issues/140`,
    });

    expect(item.provenance).toMatchObject({
      connectorId: 'github',
      sourceSystem: 'github.com',
      container: REPO,
      nativeKind: 'issue',
      nativeId: '140',
      locator: `https://github.com/${REPO}/issues/140`,
      revision: '2026-08-27T12:13:12Z',
      observedAt: NOW,
    });
    expect(item.sourceCreatedAt).toBe('2026-08-27T10:44:57Z');
    expect(item.sourceConfidence).toBe('confirmed');
    expect(item.dateConfidence).toBe('exact');
    expect(item.notes).toEqual([]);
  });

  it('keeps the full commit sha as identity and treats it as its own revision', () => {
    const sha = '63231454746fce624689458ca4d4e470acce08b7';
    const item = normalized({ kind: 'commit', sha, title: 'Merge Headquarter UI/archive foundation' });
    expect(item.provenance.nativeId).toBe(sha);
    expect(item.provenance.revision).toBe(sha);
    expect(item.provenance.locator).toBe(`https://github.com/${REPO}/commit/${sha}`);
  });

  it('builds distinct locators per kind', () => {
    expect(githubLocator(REPO, 'pull_request', '46')).toBe(`https://github.com/${REPO}/pull/46`);
    expect(githubLocator(REPO, 'issue', '46')).toBe(`https://github.com/${REPO}/issues/46`);
    expect(githubLocator(REPO, 'repository', REPO)).toBe(`https://github.com/${REPO}`);
  });

  it('marks a missing timestamp estimated instead of inventing one', () => {
    const item = normalized({ kind: 'issue', number: 7, title: 'No dates' });
    expect(item.sourceCreatedAt).toBeNull();
    expect(item.dateConfidence).toBe('estimated');
    expect(item.notes).toContain('created_at_missing');
    expect(item.notes).toContain('no_revision_marker');
  });
});

describe('untrusted metadata', () => {
  it('ignores a payload html_url that points elsewhere and downgrades confidence', () => {
    const item = normalized({
      kind: 'issue',
      number: 140,
      title: 'Spoofed link',
      html_url: 'https://evil.example.com/kiniena-github/JENIFY-OS/issues/140',
    });
    expect(item.provenance.locator).toBe(`https://github.com/${REPO}/issues/140`);
    expect(item.sourceConfidence).toBe('reported');
    expect(item.notes).toContain('reported_locator_unsafe');
  });

  it('ignores a javascript: html_url entirely', () => {
    const item = normalized({
      kind: 'issue',
      number: 5,
      title: 'XSS attempt',
      // eslint-disable-next-line no-script-url
      html_url: 'javascript:alert(document.cookie)',
    });
    expect(item.provenance.locator).toBe(`https://github.com/${REPO}/issues/5`);
    expect(item.linkSafe).toBe(true); // the CONSTRUCTED locator is safe
    expect(item.notes).toContain('reported_locator_unsafe');
    expect(item.sourceConfidence).toBe('reported');
  });

  it('flags a same-host locator that disagrees with the canonical one', () => {
    const item = normalized({
      kind: 'pull_request',
      number: 46,
      title: 'Mismatched',
      html_url: `https://github.com/${REPO}/pull/99`,
    });
    expect(item.provenance.locator).toBe(`https://github.com/${REPO}/pull/46`);
    expect(item.notes).toContain('reported_locator_mismatch');
  });

  it('does not mangle titles that legitimately contain markup', () => {
    const item = normalized({
      kind: 'issue',
      number: 8,
      title: 'Fix <Table> rendering & "quotes"',
    });
    // Escaping is the render layer's job; the record keeps the real title.
    expect(item.title).toBe('Fix <Table> rendering & "quotes"');
  });

  it('strips control characters and bidi overrides from titles', () => {
    // Every one of the four written as an ESCAPE (Wave 5 correction round six,
    // Low 6; the same finding arrived independently as round seven's Low
    // NEW-7). \u0000 was escaped while the bidi override and the bell beside
    // it were raw, so the fixture read as three characters in a source viewer,
    // one of them re-ordered the line around it, and `git diff` rendered the
    // whole file as `Bin 9424 -> 9429 bytes`. `test/source-text-hygiene.test.ts`
    // is the derived assertion that keeps every .ts file in this package free
    // of raw control characters and raw bidi controls.
    const item = normalized({ kind: 'issue', number: 9, title: 'a\u0000b\u202Ec\u0007d' });
    expect(item.title).toBe('a b c d');
  });
});

describe('rejections', () => {
  it('rejects an unknown item kind', () => {
    expect(rejection({ kind: 'release', number: 1 })).toMatch(/unknown item kind/);
  });

  it('rejects a non-object item', () => {
    expect(rejection('not-an-object')).toMatch(/not an object/);
    expect(rejection(null)).toMatch(/not an object/);
    expect(rejection([1, 2])).toMatch(/not an object/);
  });

  it('rejects issues without a positive integer number', () => {
    expect(rejection({ kind: 'issue', number: '140' })).toMatch(/positive integer/);
    expect(rejection({ kind: 'issue', number: -1 })).toMatch(/positive integer/);
    expect(rejection({ kind: 'issue', number: 1.5 })).toMatch(/positive integer/);
    expect(rejection({ kind: 'issue' })).toMatch(/positive integer/);
  });

  it('rejects malformed commit shas', () => {
    expect(rejection({ kind: 'commit', sha: 'zzzz' })).toMatch(/invalid commit sha/);
    expect(rejection({ kind: 'commit', sha: '../../etc/passwd' })).toMatch(/invalid commit sha/);
  });

  it('rejects an item claiming to belong to a different repository', () => {
    expect(
      rejection({ kind: 'issue', number: 1, full_name: 'someone-else/other-repo' }),
    ).toMatch(/does not match configured repo/);
  });

  it('rejects a malformed configured repo rather than guessing', () => {
    const result = normalizeGitHubItem({ kind: 'issue', number: 1 }, NOW, { repo: '../evil' });
    expect(result.ok).toBe(false);
  });
});

describe('syncGitHub', () => {
  const page = (items: unknown[]): ((cursor: string | null) => Promise<PageResult>) =>
    async () => ({ ok: true, page: { items, nextCursor: null } });

  it('ingests a mixed page and reports it as current', async () => {
    const index = createConnectorIndex('github');
    const outcome = await syncGitHub({
      config: CONFIG,
      index,
      now: NOW,
      fetchPage: page([
        { kind: 'issue', number: 140, title: 'Lane G', created_at: '2026-08-27T10:44:57Z' },
        { kind: 'pull_request', number: 46, title: 'HQ foundation', created_at: '2026-08-26T10:00:00Z' },
        { kind: 'commit', sha: '0ef16f7cafebabecafebabecafebabecafebabe1', title: 'HQ: workforce model' },
      ]),
    });

    expect(outcome.status).toBe('current');
    expect(outcome.counts).toMatchObject({ observed: 3, ingested: 3, rejected: 0 });
    expect(outcome.entries.map((e) => e.key)).toEqual([
      'github:commit:0ef16f7cafebabecafebabecafebabecafebabe1',
      'github:issue:140',
      'github:pull_request:46',
    ]);
  });

  it('counts a malformed item, keeps the good ones, and refuses to claim current', async () => {
    const index = createConnectorIndex('github');
    const outcome = await syncGitHub({
      config: CONFIG,
      index,
      now: NOW,
      fetchPage: page([{ kind: 'issue', number: 1, title: 'Good' }, { kind: 'nonsense' }]),
    });

    expect(outcome.counts).toMatchObject({ observed: 2, ingested: 1, rejected: 1 });
    expect(outcome.status).toBe('partial');
    expect(outcome.problems.map((p) => p.code)).toContain('malformed_item');
  });

  it('detects a reopened/edited issue as an update on the next sync', async () => {
    const index = createConnectorIndex('github');
    await syncGitHub({
      config: CONFIG,
      index,
      now: NOW,
      fetchPage: page([
        { kind: 'issue', number: 1, title: 'Original', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' },
      ]),
    });
    const second = await syncGitHub({
      config: CONFIG,
      index,
      now: '2026-08-28T12:00:00Z',
      fetchPage: page([
        { kind: 'issue', number: 1, title: 'Edited', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-28T09:00:00Z' },
      ]),
    });

    expect(second.counts).toMatchObject({ ingested: 0, updated: 1 });
    expect(index.entries.get('github:issue:1')?.revisions).toHaveLength(2);
  });

  it('refuses a config carrying a credential field, before any read happens', () => {
    let fetched = false;
    expect(() =>
      syncGitHub({
        // Deliberately hostile config shape.
        config: { repo: REPO, token: 'ghp_0123456789abcdefghij' } as never,
        index: createConnectorIndex('github'),
        now: NOW,
        fetchPage: async () => {
          fetched = true;
          return { ok: true, page: { items: [], nextCursor: null } };
        },
      }),
    ).toThrow(/credential-like field "token"/);
    expect(fetched).toBe(false);
  });
});
