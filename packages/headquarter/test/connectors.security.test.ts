/**
 * Hostile-input and truthfulness regression tests for the HQ connectors
 * (issue #140 / #123, lane G). Every case here is an attempt to make a
 * connector either leak something, invent something, or quietly lose
 * something. None of them may succeed.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNoSecretMaterial,
  classifyLocator,
  confirmedRecords,
  createDriveConnector,
  createGitHubConnector,
  initialSyncState,
  listRecords,
  sanitizeText,
  scrubSecrets,
  summarizeConnectorState,
  syncConnector,
  toEvidenceItems,
} from '../src/connectors/index.js';
import { renderSourceRef } from '../src/ui/render.js';
import { reconstructArchive } from '../src/archive/inventory.js';

const REPO = 'kiniena-github/JENIFY-OS';
const FETCHED = '2026-08-27T12:00:00Z';
const DRIVE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

/* ------------------------------------------------------------------ */
/* No secret serialization                                             */
/* ------------------------------------------------------------------ */

describe('no secret serialization', () => {
  it('drops credential-keyed values entirely rather than truncating them', () => {
    const { value, redactedPaths } = scrubSecrets({
      id: 'x',
      access_token: 'ya29.a0AfH6SMB-super-secret-token-value',
      nested: { client_secret: 'abc123', refresh_token: 'r-1' },
      owners: [{ displayName: 'Founder', authorization: 'Bearer abc' }],
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('ya29');
    expect(serialized).not.toContain('abc123');
    expect(serialized).toContain('Founder');
    expect(redactedPaths).toEqual([
      'access_token',
      'nested.client_secret',
      'nested.refresh_token',
      'owners.0.authorization',
    ]);
  });

  it('redacts credential shapes hidden in free text', () => {
    expect(sanitizeText('token is ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 300)).toBe('token is [redacted]');
    expect(sanitizeText('-----BEGIN RSA PRIVATE KEY-----', 300)).toContain('[redacted]');
    expect(sanitizeText('password: hunter2000', 300)).toBe('[redacted]');
  });

  it('a hostile issue body carrying a token never reaches the index', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [
        {
          number: 1,
          title: 'Deploy notes',
          body: 'Use github_pat_11ABCDEFG0123456789abcdefghijklmnop to authenticate.',
          created_at: '2026-08-01T00:00:00Z',
        },
      ],
    }).snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('github_pat_11ABCDEFG');
    expect(serialized).toContain('[redacted]');
  });

  it('refuses an access descriptor that carries a credential', () => {
    expect(() =>
      createDriveConnector(
        { accessLabel: 'founder', fetchedAt: FETCHED },
        {
          project: 'QOS',
          access: {
            mode: 'read_only',
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
            // @ts-expect-error — the type forbids it; the guard enforces it at runtime too.
            refresh_token: '1//0gSuperSecret',
          },
        },
      ),
    ).toThrow(/secret-like material/);
  });

  it('assertNoSecretMaterial passes on a clean snapshot', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [{ number: 2, title: 'Clean issue', created_at: '2026-08-01T00:00:00Z' }],
    }).snapshot();
    expect(() => assertNoSecretMaterial(snapshot, 'test')).not.toThrow();
  });
});

/* ------------------------------------------------------------------ */
/* XSS / link safety                                                   */
/* ------------------------------------------------------------------ */

describe('XSS and link safety', () => {
  it('never lets a hostile scheme become a linkable locator', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'http://github.com/x/y/issues/1',
      'https://user:pass@github.com/x/y',
      'https://github.com.evil.example/x/y',
    ]) {
      expect(classifyLocator(hostile, ['github.com']).linkable).toBe(false);
    }
    expect(classifyLocator(`https://github.com/${REPO}/issues/1`, ['github.com']).linkable).toBe(true);
  });

  it('a hostile webViewLink is demoted to an inert locator and reported', () => {
    const snapshot = createDriveConnector(
      {
        accessLabel: 'founder-drive-readonly',
        fetchedAt: FETCHED,
        files: [{ id: DRIVE_ID, name: 'Plan', webViewLink: 'javascript:alert(document.cookie)' }],
      },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.records[0].provenance.locatorLinkable).toBe(false);
    expect(snapshot.records[0].provenance.locator).toBe(`drive://${DRIVE_ID}`);
    expect(snapshot.issues.map((issue) => issue.code)).toContain('unsafe_locator');
  });

  it('a Drive link pointing at a different file id is rejected as an identity mismatch', () => {
    const snapshot = createDriveConnector(
      {
        accessLabel: 'founder-drive-readonly',
        fetchedAt: FETCHED,
        files: [
          {
            id: DRIVE_ID,
            name: 'Plan',
            webViewLink: 'https://docs.google.com/document/d/9ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ/edit',
          },
        ],
      },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.records[0].provenance.locator).toBe(`drive://${DRIVE_ID}`);
    expect(snapshot.issues.map((issue) => issue.code)).toContain('identity_mismatch');
  });

  it('a spoofed GitHub html_url is replaced by the canonical URL and reported', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [
        {
          number: 140,
          title: 'Legit-looking issue',
          created_at: '2026-08-01T00:00:00Z',
          html_url: 'https://evil.example/phish',
        },
      ],
    }).snapshot();
    expect(snapshot.records[0].provenance.locator).toBe(`https://github.com/${REPO}/issues/140`);
    expect(snapshot.issues.map((issue) => issue.code)).toContain('identity_mismatch');
  });

  it('script payloads survive as inert text and are escaped at render time', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [{ number: 3, title: '<script>alert("xss")</script>', created_at: '2026-08-01T00:00:00Z' }],
    }).snapshot();
    // Storage keeps the original text (escaping twice would corrupt it)...
    expect(snapshot.records[0].title).toBe('<script>alert("xss")</script>');
    // ...and the renderer, which is where it matters, escapes it.
    expect(renderSourceRef(snapshot.records[0].provenance.locator)).toBe(
      `<a href="https://github.com/${REPO}/issues/3">original</a>`,
    );
  });

  it('strips control characters and bidi overrides from untrusted titles', () => {
    const hostile = 'Legit\u0000 title\u202e gnihsihp\u200b';
    expect(sanitizeText(hostile, 300)).toBe('Legit title gnihsihp');
  });
});

/* ------------------------------------------------------------------ */
/* Malformed / untrusted metadata                                      */
/* ------------------------------------------------------------------ */

describe('malformed metadata', () => {
  it('drops unidentifiable items instead of inventing identifiers', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [
        { number: 'not-a-number', title: 'x' },
        { number: -4, title: 'x' },
        { number: 5, title: '   ' },
        { number: 6, title: 'kept', created_at: '2026-08-01T00:00:00Z' },
      ],
      commits: [{ sha: 'zzzz', message: 'bad sha' }],
    }).snapshot();
    expect(snapshot.records.map((record) => record.id)).toEqual(['github:issue:6']);
    expect(snapshot.issues.filter((issue) => issue.code === 'malformed_metadata')).toHaveLength(4);
  });

  it('ignores an invalid date rather than treating it as authoritative', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [{ number: 9, title: 'Bad date', created_at: 'yesterday-ish' }],
    }).snapshot();
    expect(snapshot.records[0].provenance.dateConfidence).toBe('estimated');
    const [archived] = reconstructArchive([snapshot.records[0].evidence], {
      defaultProject: 'JENIFY-OS',
      fallbackDate: '2026-01-01',
    });
    expect(archived.created).toMatchObject({ date: '2026-01-01', confidence: 'estimated' });
  });

  it('refuses a Drive id shaped like a URL', () => {
    const snapshot = createDriveConnector(
      {
        accessLabel: 'founder-drive-readonly',
        fetchedAt: FETCHED,
        files: [{ id: 'https://evil.example/x', name: 'Plan' }],
      },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.issues[0].code).toBe('malformed_metadata');
  });
});

/* ------------------------------------------------------------------ */
/* Connector failure truthfulness                                      */
/* ------------------------------------------------------------------ */

describe('connector failures never invent success', () => {
  it.each([
    ['unavailable', 'Drive host unreachable'],
    ['needs_auth', 'OAuth grant expired; re-authorization required'],
    ['blocked', 'Read refused by policy'],
    ['outcome_unknown', 'Request timed out; the read may or may not have completed'],
  ] as const)('surfaces %s with its real reason and no records', (state, reason) => {
    const snapshot = createDriveConnector(
      { accessLabel: 'founder-drive-readonly', fetchedAt: FETCHED, failure: { state, reason } },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.state).toBe(state);
    expect(snapshot.stateReason).toBe(reason);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.records).toEqual([]);
    expect(snapshot.issues[0].code).toBe('source_unavailable');
  });

  it('an empty successful read is NOT a failure — and says so', () => {
    const snapshot = createDriveConnector(
      { accessLabel: 'founder-drive-readonly', fetchedAt: FETCHED, files: [] },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.state).toBe('ok');
    expect(snapshot.complete).toBe(true);
    expect(snapshot.records).toEqual([]);
  });

  it('a failed read never deletes previously ingested records', () => {
    const good = createDriveConnector(
      {
        accessLabel: 'founder-drive-readonly',
        fetchedAt: FETCHED,
        files: [{ id: DRIVE_ID, name: 'Plan', createdTime: '2026-06-01T09:00:00Z' }],
      },
      { project: 'QOS' },
    ).snapshot();
    const first = syncConnector(initialSyncState('drive:founder-drive-readonly', 'drive'), good);

    const failed = createDriveConnector(
      {
        accessLabel: 'founder-drive-readonly',
        fetchedAt: '2026-08-28T12:00:00Z',
        failure: { state: 'needs_auth', reason: 'OAuth grant expired' },
      },
      { project: 'QOS' },
    ).snapshot();
    const second = syncConnector(first.state, failed);

    expect(second.plan).toEqual({
      added: [],
      updated: [],
      unchanged: [],
      disappeared: [],
      authoritative: false,
    });
    expect(listRecords(second.state)).toHaveLength(1);
    // Retained, but no longer claiming to be current...
    expect(second.state.records[`drive:file:${DRIVE_ID}`].provenance.sourceConfidence).toBe('unconfirmed');
    expect(confirmedRecords(second.state)).toEqual([]);
    // ...and the last confirmation time is not moved forward by a failed read.
    expect(second.state.lastConfirmedAt).toBe(FETCHED);
    expect(second.state.lastSyncAt).toBe(FETCHED);
    expect(summarizeConnectorState(second.state)).toContain('needs_auth');
    expect(summarizeConnectorState(second.state)).toContain('OAuth grant expired');
  });
});

/* ------------------------------------------------------------------ */
/* Partial pagination                                                  */
/* ------------------------------------------------------------------ */

describe('partial pagination', () => {
  const page1 = createGitHubConnector({
    repo: REPO,
    fetchedAt: FETCHED,
    issues: [
      { number: 1, title: 'One', created_at: '2026-08-01T00:00:00Z' },
      { number: 2, title: 'Two', created_at: '2026-08-02T00:00:00Z' },
    ],
    page: { complete: false, cursor: 'page-2' },
  }).snapshot();

  it('reports partial state, a resume cursor and downgraded confidence', () => {
    expect(page1.state).toBe('partial');
    expect(page1.complete).toBe(false);
    expect(page1.cursor).toBe('page-2');
    expect(page1.records.every((record) => record.provenance.sourceConfidence === 'partial')).toBe(true);
    expect(page1.issues.map((issue) => issue.code)).toContain('partial_page');
    expect(confirmedRecords(syncConnector(initialSyncState(`github:${REPO}`, 'github'), page1).state)).toEqual([]);
  });

  it('a record absent from a partial page is never treated as removed', () => {
    const first = syncConnector(initialSyncState(`github:${REPO}`, 'github'), page1);
    const page2 = createGitHubConnector({
      repo: REPO,
      fetchedAt: '2026-08-27T12:05:00Z',
      issues: [{ number: 3, title: 'Three', created_at: '2026-08-03T00:00:00Z' }],
      page: { complete: false, cursor: 'page-3' },
    }).snapshot();
    const second = syncConnector(first.state, page2);
    expect(second.plan.added).toEqual(['github:issue:3']);
    expect(second.plan.disappeared).toEqual([]);
    expect(listRecords(second.state)).toHaveLength(3);
    expect(second.state.cursor).toBe('page-3');
    // A partial sweep never counts as a full confirmation.
    expect(second.state.lastConfirmedAt).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Duplicates, retries, provenance                                     */
/* ------------------------------------------------------------------ */

describe('duplicate ingestion, retries and provenance preservation', () => {
  it('the same item twice in one read collapses to one record', () => {
    const issue = { number: 11, title: 'Same', created_at: '2026-08-01T00:00:00Z' };
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [issue, { ...issue }],
    }).snapshot();
    expect(snapshot.records).toHaveLength(2); // both mapped...
    const synced = syncConnector(initialSyncState(`github:${REPO}`, 'github'), snapshot);
    // ...but they share one stable id, so the index holds exactly one.
    expect(Object.keys(synced.state.records)).toEqual(['github:issue:11']);
  });

  it('replaying an identical snapshot three times is a no-op after the first', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [{ number: 12, title: 'Retry me', created_at: '2026-08-01T00:00:00Z' }],
    }).snapshot();
    let state = initialSyncState(`github:${REPO}`, 'github');
    const plans = [];
    for (let i = 0; i < 3; i += 1) {
      const result = syncConnector(state, snapshot);
      state = result.state;
      plans.push(result.plan);
    }
    expect(plans[0].added).toEqual(['github:issue:12']);
    expect(plans[1]).toEqual(plans[2]);
    expect(plans[2].added).toEqual([]);
    expect(plans[2].unchanged).toEqual(['github:issue:12']);
  });

  it('sync never mutates its inputs', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [{ number: 13, title: 'Frozen', created_at: '2026-08-01T00:00:00Z' }],
    }).snapshot();
    const before = initialSyncState(`github:${REPO}`, 'github');
    const frozenState = JSON.parse(JSON.stringify(before));
    const frozenSnapshot = JSON.parse(JSON.stringify(snapshot));
    syncConnector(before, snapshot);
    expect(before).toEqual(frozenState);
    expect(snapshot).toEqual(frozenSnapshot);
  });

  it('an edited source keeps the original identity and evidence pointer', () => {
    const first = syncConnector(
      initialSyncState(`github:${REPO}`, 'github'),
      createGitHubConnector({
        repo: REPO,
        fetchedAt: FETCHED,
        issues: [{ number: 14, title: 'Original title', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z' }],
      }).snapshot(),
    );
    const second = syncConnector(
      first.state,
      createGitHubConnector({
        repo: REPO,
        fetchedAt: '2026-08-29T00:00:00Z',
        issues: [{ number: 14, title: 'Rewritten title', created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-28T00:00:00Z' }],
      }).snapshot(),
    );
    const record = second.state.records['github:issue:14'];
    expect(record.provenance.sourceId).toBe('14');
    expect(record.provenance.locator).toBe(`https://github.com/${REPO}/issues/14`);
    expect(record.provenance.sourceUpdatedAt).toBe('2026-08-28T00:00:00Z');
    // The evidence pointer still addresses the untouched original.
    expect(toEvidenceItems(second.state)[0].location).toBe(`https://github.com/${REPO}/issues/14`);
  });
});
