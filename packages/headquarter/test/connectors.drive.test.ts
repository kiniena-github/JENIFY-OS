/**
 * Drive adapter: reference-only ingestion, trash handling, revision choice,
 * and the credential/authorization contract.
 */
import { describe, expect, it } from 'vitest';
import {
  DRIVE_FOLDER_MIME,
  driveLocator,
  normalizeDriveFile,
  syncDrive,
  type DriveConnectorConfig,
} from '../src/connectors/drive.js';
import { createConnectorIndex } from '../src/connectors/sync.js';
import type { PageResult } from '../src/connectors/types.js';

const NOW = '2026-08-27T12:00:00Z';
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const CONFIG: DriveConnectorConfig = { folderId: 'root', authState: 'authorized' };

function normalized(raw: unknown, config: DriveConnectorConfig = CONFIG) {
  const result = normalizeDriveFile(raw, NOW, config);
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.item;
}

const page =
  (items: unknown[]): ((cursor: string | null) => Promise<PageResult>) =>
  async () => ({ ok: true, page: { items, nextCursor: null } });

describe('drive normalization', () => {
  it('records id, revision and a constructed canonical link', () => {
    const item = normalized({
      id: FILE_ID,
      name: 'JENIFY Master Plan.docx',
      mimeType: 'application/vnd.google-apps.document',
      createdTime: '2026-05-01T09:00:00Z',
      modifiedTime: '2026-08-20T14:30:00Z',
      version: 42,
      webViewLink: `https://drive.google.com/file/d/${FILE_ID}/view`,
    });

    expect(item.provenance).toMatchObject({
      connectorId: 'drive',
      sourceSystem: 'drive.google.com',
      container: 'root',
      nativeKind: 'drive_file',
      nativeId: FILE_ID,
      locator: `https://drive.google.com/file/d/${FILE_ID}/view`,
      revision: '42',
    });
    expect(item.sourceCreatedAt).toBe('2026-05-01T09:00:00Z');
    expect(item.dateConfidence).toBe('exact');
    expect(item.sourceConfidence).toBe('confirmed');
  });

  it('prefers version, then checksum, then modified time as the revision', () => {
    expect(normalized({ id: FILE_ID, version: 7, md5Checksum: 'abc', modifiedTime: '2026-01-01T00:00:00Z' }).provenance.revision).toBe('7');
    expect(normalized({ id: FILE_ID, md5Checksum: 'abc', modifiedTime: '2026-01-01T00:00:00Z' }).provenance.revision).toBe('abc');
    expect(normalized({ id: FILE_ID, modifiedTime: '2026-01-01T00:00:00Z' }).provenance.revision).toBe('2026-01-01T00:00:00Z');
    const none = normalized({ id: FILE_ID });
    expect(none.provenance.revision).toBeNull();
    expect(none.notes).toContain('no_revision_marker');
  });

  it('treats a modification-only timestamp as inferred, never exact', () => {
    const item = normalized({ id: FILE_ID, modifiedTime: '2026-08-20T14:30:00Z' });
    expect(item.sourceCreatedAt).toBeNull();
    expect(item.dateConfidence).toBe('inferred');
    expect(item.notes).toContain('created_time_missing');
  });

  it('classifies folders separately and links them as folders', () => {
    const item = normalized({ id: FILE_ID, name: 'Archive', mimeType: DRIVE_FOLDER_MIME });
    expect(item.provenance.nativeKind).toBe('drive_folder');
    expect(item.provenance.locator).toBe(driveLocator(FILE_ID, 'drive_folder'));
  });

  it('keeps a trashed file as a reference marked deleted at source', () => {
    const item = normalized({ id: FILE_ID, name: 'Old draft', trashed: true, version: 3 });
    expect(item.deletedAtSource).toBe(true);
    expect(item.provenance.nativeId).toBe(FILE_ID);
  });

  it('ignores a hostile webViewLink and downgrades confidence', () => {
    const item = normalized({
      id: FILE_ID,
      name: 'Phish',
      // eslint-disable-next-line no-script-url
      webViewLink: 'javascript:alert(1)',
    });
    expect(item.provenance.locator).toBe(`https://drive.google.com/file/d/${FILE_ID}/view`);
    expect(item.sourceConfidence).toBe('reported');
    expect(item.notes).toContain('reported_locator_unsafe');
  });

  it('rejects malformed file ids and non-objects', () => {
    expect(normalizeDriveFile({ id: '../../etc' }, NOW, CONFIG).ok).toBe(false);
    expect(normalizeDriveFile({ id: 'short' }, NOW, CONFIG).ok).toBe(false);
    expect(normalizeDriveFile({}, NOW, CONFIG).ok).toBe(false);
    expect(normalizeDriveFile('nope', NOW, CONFIG).ok).toBe(false);
  });
});

describe('drive authorization contract', () => {
  it('reports needs_auth without reading, and never as an empty listing', async () => {
    let fetched = false;
    const index = createConnectorIndex('drive');
    const outcome = await syncDrive({
      config: { folderId: 'root', authState: 'needs_auth' },
      index,
      now: NOW,
      fetchPage: async () => {
        fetched = true;
        return { ok: true, page: { items: [], nextCursor: null } };
      },
    });

    expect(fetched).toBe(false);
    expect(outcome.status).toBe('needs_auth');
    expect(outcome.authoritative).toBe(false);
    expect(outcome.problems[0]?.code).toBe('auth_required');
    expect(outcome.counts.observed).toBe(0);
  });

  it('reports unknown authorization as outcome_unknown, not as success', async () => {
    const outcome = await syncDrive({
      config: { folderId: 'root', authState: 'unknown' },
      index: createConnectorIndex('drive'),
      now: NOW,
      fetchPage: page([]),
    });
    expect(outcome.status).toBe('outcome_unknown');
  });

  it('never marks known files missing when authorization lapses', async () => {
    const index = createConnectorIndex('drive');
    await syncDrive({ config: CONFIG, index, now: NOW, fetchPage: page([{ id: FILE_ID, name: 'Plan', version: 1 }]) });
    expect(index.entries.get(`drive:drive_file:${FILE_ID}`)?.lifecycle).toBe('active');

    await syncDrive({
      config: { folderId: 'root', authState: 'needs_auth' },
      index,
      now: '2026-08-28T12:00:00Z',
      fetchPage: page([]),
    });
    expect(index.entries.get(`drive:drive_file:${FILE_ID}`)?.lifecycle).toBe('active');
  });

  it('refuses a config carrying OAuth material before touching Drive', () => {
    let fetched = false;
    expect(() =>
      syncDrive({
        config: { folderId: 'root', authState: 'authorized', refresh_token: 'ya29.abcdefghijklmnop' } as never,
        index: createConnectorIndex('drive'),
        now: NOW,
        fetchPage: async () => {
          fetched = true;
          return { ok: true, page: { items: [], nextCursor: null } };
        },
      }),
    ).toThrow(/credential-like field/);
    expect(fetched).toBe(false);
  });
});

describe('drive incremental sync', () => {
  it('detects a new version of an existing file without losing the old one', async () => {
    const index = createConnectorIndex('drive');
    await syncDrive({ config: CONFIG, index, now: NOW, fetchPage: page([{ id: FILE_ID, name: 'Plan', version: 1 }]) });
    const second = await syncDrive({
      config: CONFIG,
      index,
      now: '2026-08-28T12:00:00Z',
      fetchPage: page([{ id: FILE_ID, name: 'Plan v2', version: 2 }]),
    });

    expect(second.counts).toMatchObject({ ingested: 0, updated: 1 });
    const entry = index.entries.get(`drive:drive_file:${FILE_ID}`);
    expect(entry?.revisions.map((r) => r.revision)).toEqual(['1', '2']);
    expect(entry?.firstSeenAt).toBe(NOW);
  });

  it('marks a file that disappeared from a complete listing as missing at source', async () => {
    const index = createConnectorIndex('drive');
    await syncDrive({ config: CONFIG, index, now: NOW, fetchPage: page([{ id: FILE_ID, name: 'Plan', version: 1 }]) });
    const second = await syncDrive({
      config: CONFIG,
      index,
      now: '2026-08-28T12:00:00Z',
      fetchPage: page([]),
    });

    expect(second.counts.missing).toBe(1);
    expect(index.entries.get(`drive:drive_file:${FILE_ID}`)?.lifecycle).toBe('missing_at_source');
  });
});
