/**
 * Connector → archive integration.
 *
 * Connector output must flow through the EXISTING inventory pipeline
 * (`reconstructArchive`) with provenance intact, and must never turn a
 * reference into a rewritten copy of the original evidence.
 */
import { describe, expect, it } from 'vitest';
import { createConnectorSourceAdapter, connectorTags, toEvidenceItems } from '../src/connectors/bridge.js';
import { syncDrive } from '../src/connectors/drive.js';
import { syncGitHub } from '../src/connectors/github.js';
import { createConnectorIndex, listIndexEntries } from '../src/connectors/sync.js';
import { reconstructArchive } from '../src/archive/inventory.js';
import { validateArchiveRecord } from '../src/archive/schema.js';
import type { PageResult } from '../src/connectors/types.js';

const NOW = '2026-08-27T12:00:00Z';
const REPO = 'kiniena-github/JENIFY-OS';
const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
const ARCHIVE_OPTS = { defaultProject: 'JENIFY-OS', fallbackDate: '2026-01-01' };

const page =
  (items: unknown[]): ((cursor: string | null) => Promise<PageResult>) =>
  async () => ({ ok: true, page: { items, nextCursor: null } });

async function githubIndex() {
  const index = createConnectorIndex('github');
  await syncGitHub({
    config: { repo: REPO },
    index,
    now: NOW,
    fetchPage: page([
      { kind: 'issue', number: 140, title: 'Retry HQ lane G', created_at: '2026-08-27T10:44:57Z' },
      { kind: 'pull_request', number: 46, title: 'HQ foundation', created_at: '2026-08-26T10:00:00Z' },
      { kind: 'commit', sha: '0ef16f7cafebabecafebabecafebabecafebabe1', title: 'HQ: workforce model' },
    ]),
  });
  return index;
}

describe('evidence mapping', () => {
  it('produces valid archive records through the existing pipeline', async () => {
    const entries = listIndexEntries(await githubIndex());
    const records = reconstructArchive(toEvidenceItems(entries, { project: 'JENIFY-OS' }), ARCHIVE_OPTS);

    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(validateArchiveRecord(record)).toEqual([]);
    }
  });

  it('points sourceRef at the preserved original, never at a copy', async () => {
    const entries = listIndexEntries(await githubIndex());
    const records = reconstructArchive(toEvidenceItems(entries, { project: 'JENIFY-OS' }), ARCHIVE_OPTS);
    const issue = records.find((r) => r.id.endsWith('issue-140'));

    expect(issue?.sourceRef).toBe(`https://github.com/${REPO}/issues/140`);
    expect(issue?.related.issues).toEqual([140]);
    expect(issue?.created).toMatchObject({ date: '2026-08-27T10:44:57Z', confidence: 'exact' });
  });

  it('namespaces ids so a GitHub number and a Drive id cannot collide', async () => {
    const drive = createConnectorIndex('drive');
    await syncDrive({
      config: { folderId: 'root', authState: 'authorized' },
      index: drive,
      now: NOW,
      fetchPage: page([{ id: FILE_ID, name: 'Plan', version: 1, createdTime: '2026-05-01T09:00:00Z' }]),
    });

    const items = [
      ...toEvidenceItems(listIndexEntries(await githubIndex()), { project: 'JENIFY-OS' }),
      ...toEvidenceItems(listIndexEntries(drive), { project: 'JENIFY-OS' }),
    ];
    const ids = reconstructArchive(items, ARCHIVE_OPTS).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(`file-drive-drive_file-${FILE_ID}`);
  });

  it('carries the connector date judgement instead of re-deriving it', async () => {
    const drive = createConnectorIndex('drive');
    await syncDrive({
      config: { folderId: 'root', authState: 'authorized' },
      index: drive,
      now: NOW,
      // Modified time only — inferred, not exact.
      fetchPage: page([{ id: FILE_ID, name: 'Undated draft', modifiedTime: '2026-08-20T14:30:00Z' }]),
    });

    const [record] = reconstructArchive(
      toEvidenceItems(listIndexEntries(drive), { project: 'JENIFY-OS' }),
      ARCHIVE_OPTS,
    );
    expect(record.created).toMatchObject({ date: '2026-08-20T14:30:00Z', confidence: 'inferred' });
  });

  it('marks a vanished source ARCHIVED while keeping its reference', async () => {
    const index = await githubIndex();
    await syncGitHub({ config: { repo: REPO }, index, now: '2026-08-28T12:00:00Z', fetchPage: page([]) });

    const records = reconstructArchive(
      toEvidenceItems(listIndexEntries(index), { project: 'JENIFY-OS' }),
      ARCHIVE_OPTS,
    );
    expect(records.every((r) => r.status === 'ARCHIVED')).toBe(true);
    expect(records.find((r) => r.id.endsWith('issue-140'))?.sourceRef).toBe(
      `https://github.com/${REPO}/issues/140`,
    );
  });

  it('tags records with lifecycle and confidence so nothing reads as more certain than it is', async () => {
    const entries = listIndexEntries(await githubIndex());
    const tags = connectorTags(entries[0]);
    expect(tags).toContain('connector:github');
    expect(tags).toContain('lifecycle:active');
    expect(tags).toContain('source-confidence:confirmed');
    expect(tags).toContain('date-confidence:estimated');
  });

  it('feeds the existing SourceAdapter contract without a second pipeline', async () => {
    const adapter = createConnectorSourceAdapter(listIndexEntries(await githubIndex()), {
      project: 'JENIFY-OS',
    });
    expect(adapter.name).toBe('connector:github');
    const collected = adapter.collect();
    expect(collected).toHaveLength(3);
    // The adapter hands out copies; mutating them cannot corrupt the index.
    collected[0].title = 'tampered';
    expect(adapter.collect()[0].title).not.toBe('tampered');
  });

  it('is deterministic: identical index, identical evidence items', async () => {
    const a = toEvidenceItems(listIndexEntries(await githubIndex()), { project: 'JENIFY-OS' });
    const b = toEvidenceItems(listIndexEntries(await githubIndex()), { project: 'JENIFY-OS' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
