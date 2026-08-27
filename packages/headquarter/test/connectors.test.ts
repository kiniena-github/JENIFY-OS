import { describe, expect, it } from 'vitest';
import {
  ConnectorRegistry,
  DRIVE_READ_ACCESS,
  GITHUB_READ_ACCESS,
  UnimplementedConnectorError,
  applyStaleness,
  confirmedRecords,
  createDriveConnector,
  createGitHubConnector,
  evaluateStaleness,
  initialSyncState,
  listRecords,
  provenanceNote,
  summarizeConnectorState,
  syncConnector,
  toEvidenceItems,
} from '../src/connectors/index.js';
import { reconstructArchive } from '../src/archive/inventory.js';
import { validateArchiveRecord } from '../src/archive/schema.js';

const REPO = 'kiniena-github/JENIFY-OS';
const FETCHED = '2026-08-27T12:00:00Z';

function githubSnapshot(overrides: Parameters<typeof createGitHubConnector>[0] | null = null) {
  return createGitHubConnector(
    overrides ?? {
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [
        {
          number: 140,
          title: 'Retry HQ lane G — GitHub + Drive connectors',
          body: 'Implement safe connector adapters.',
          created_at: '2026-08-27T10:44:57Z',
          updated_at: '2026-08-27T12:13:11Z',
          labels: ['ai-task', 'claude'],
          html_url: `https://github.com/${REPO}/issues/140`,
        },
      ],
      pullRequests: [
        {
          number: 128,
          title: 'HQ lane C: provider-neutral AI Member Registry',
          created_at: '2026-08-27T08:48:22Z',
          updated_at: '2026-08-27T09:00:00Z',
        },
      ],
      commits: [
        {
          sha: '0ef16f7a1b2c3d4e5f60718293a4b5c6d7e8f900',
          message: 'HQ: editable organization + workforce runtime model (#126)',
          authored_at: '2026-08-27T07:00:00Z',
        },
      ],
    },
  ).snapshot();
}

describe('github connector', () => {
  it('indexes issues, PRs and commits with exact provenance and canonical locators', () => {
    const snapshot = githubSnapshot();
    expect(snapshot.state).toBe('ok');
    expect(snapshot.complete).toBe(true);
    expect(snapshot.stateReason).toBeNull();
    expect(snapshot.records.map((record) => record.id)).toEqual([
      'github:commit:0ef16f7a1b2c3d4e5f60718293a4b5c6d7e8f900',
      'github:issue:140',
      'github:pull_request:128',
    ]);

    const issue = snapshot.records.find((record) => record.id === 'github:issue:140');
    expect(issue?.provenance).toMatchObject({
      connector: `github:${REPO}`,
      sourceSystem: 'github',
      sourceId: '140',
      sourceType: 'issue',
      locator: `https://github.com/${REPO}/issues/140`,
      locatorLinkable: true,
      sourceVersion: '2026-08-27T12:13:11Z',
      sourceUpdatedAt: '2026-08-27T12:13:11Z',
      observedAt: FETCHED,
      sourceConfidence: 'confirmed',
      dateConfidence: 'exact',
      lifecycle: 'active',
    });
    expect(issue?.category).toBe('ai-task');
    expect(issue?.evidence.refs).toEqual({ issues: [140] });

    const commit = snapshot.records.find((record) => record.provenance.sourceType === 'commit');
    // A commit is immutable: its sha is its version marker.
    expect(commit?.provenance.sourceVersion).toBe('0ef16f7a1b2c3d4e5f60718293a4b5c6d7e8f900');
  });

  it('is deterministic: the same input yields byte-identical snapshots', () => {
    expect(JSON.stringify(githubSnapshot())).toBe(JSON.stringify(githubSnapshot()));
  });

  it('records with no source date are flagged, never given an invented date', () => {
    const snapshot = createGitHubConnector({
      repo: REPO,
      fetchedAt: FETCHED,
      issues: [{ number: 7, title: 'Undated issue' }],
    }).snapshot();
    const record = snapshot.records[0];
    expect(record.provenance.dateConfidence).toBe('estimated');
    expect(record.evidence.date).toBeUndefined();
  });

  it('rejects a malformed repository rather than guessing one', () => {
    expect(() => createGitHubConnector({ repo: 'not-a-repo', fetchedAt: FETCHED })).toThrow(/invalid repository/);
  });
});

describe('drive connector', () => {
  const driveInput = {
    accessLabel: 'founder-drive-readonly',
    fetchedAt: FETCHED,
    files: [
      {
        id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
        name: 'QOS Ethiopia plan V2',
        mimeType: 'application/vnd.google-apps.document',
        createdTime: '2026-06-01T09:00:00Z',
        modifiedTime: '2026-08-20T11:00:00Z',
        version: 42,
        webViewLink: 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit',
        owners: [{ displayName: 'Founder', emailAddress: 'founder@example.com' }],
      },
    ],
  };

  it('indexes files by id with a vetted link and Drive-authoritative dates', () => {
    const snapshot = createDriveConnector(driveInput, { project: 'QOS' }).snapshot();
    const record = snapshot.records[0];
    expect(record.id).toBe('drive:file:1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(record.provenance).toMatchObject({
      sourceSystem: 'google-drive',
      sourceType: 'file',
      locatorLinkable: true,
      sourceVersion: '42',
      sourceUpdatedAt: '2026-08-20T11:00:00Z',
      dateConfidence: 'exact',
      lifecycle: 'active',
    });
    expect(record.evidence.dateSource).toBe('drive-api');
    expect(record.category).toBe('document');
  });

  it('never indexes owner email addresses', () => {
    const snapshot = createDriveConnector(driveInput, { project: 'QOS' }).snapshot();
    expect(JSON.stringify(snapshot)).not.toContain('founder@example.com');
    expect(JSON.stringify(snapshot)).toContain('Founder');
  });

  it('marks a trashed file deleted instead of dropping it', () => {
    const snapshot = createDriveConnector(
      { ...driveInput, files: [{ ...driveInput.files[0], trashed: true }] },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.records[0].provenance.lifecycle).toBe('deleted');
  });

  it('falls back to an inert drive:// locator when there is no usable link', () => {
    const snapshot = createDriveConnector(
      { ...driveInput, files: [{ ...driveInput.files[0], webViewLink: undefined }] },
      { project: 'QOS' },
    ).snapshot();
    expect(snapshot.records[0].provenance.locator).toBe('drive://1AbCdEfGhIjKlMnOpQrStUvWxYz012345');
    expect(snapshot.records[0].provenance.locatorLinkable).toBe(false);
  });

  it('requires a non-secret access label', () => {
    expect(() => createDriveConnector({ accessLabel: '', fetchedAt: FETCHED }, { project: 'QOS' })).toThrow(
      /accessLabel is required/,
    );
  });
});

describe('incremental sync', () => {
  const connectorName = `github:${REPO}`;

  it('first sync adds every record; an immediate re-sync changes nothing (idempotent)', () => {
    const snapshot = githubSnapshot();
    const first = syncConnector(initialSyncState(connectorName, 'github'), snapshot);
    expect(first.plan.added).toHaveLength(3);
    expect(first.plan.authoritative).toBe(true);

    const second = syncConnector(first.state, snapshot);
    expect(second.plan.added).toEqual([]);
    expect(second.plan.updated).toEqual([]);
    expect(second.plan.disappeared).toEqual([]);
    expect(second.plan.unchanged).toHaveLength(3);
    expect(second.state.records).toEqual(first.state.records);
  });

  it('detects a changed source by digest, not by re-observation', () => {
    const first = syncConnector(initialSyncState(connectorName, 'github'), githubSnapshot());
    const edited = createGitHubConnector({
      repo: REPO,
      fetchedAt: '2026-08-27T13:00:00Z',
      issues: [
        {
          number: 140,
          title: 'Retry HQ lane G — GitHub + Drive connectors (edited)',
          created_at: '2026-08-27T10:44:57Z',
          updated_at: '2026-08-27T13:00:00Z',
        },
      ],
      page: { complete: false },
    }).snapshot();
    const second = syncConnector(first.state, edited);
    expect(second.plan.updated).toEqual(['github:issue:140']);
    expect(second.state.records['github:issue:140'].title).toContain('(edited)');
  });

  it('retiring happens only on a complete read, and preserves the record', () => {
    const first = syncConnector(initialSyncState(connectorName, 'github'), githubSnapshot());
    const shrunk = createGitHubConnector({
      repo: REPO,
      fetchedAt: '2026-08-28T12:00:00Z',
      issues: [
        {
          number: 140,
          title: 'Retry HQ lane G — GitHub + Drive connectors',
          body: 'Implement safe connector adapters.',
          created_at: '2026-08-27T10:44:57Z',
          updated_at: '2026-08-27T12:13:11Z',
          labels: ['ai-task', 'claude'],
        },
      ],
    }).snapshot();
    const second = syncConnector(first.state, shrunk);
    expect(second.plan.disappeared).toEqual(['github:commit:0ef16f7a1b2c3d4e5f60718293a4b5c6d7e8f900', 'github:pull_request:128']);
    const retired = second.state.records['github:pull_request:128'];
    // Retired, not deleted: provenance and the original locator survive.
    expect(retired.provenance.lifecycle).toBe('unavailable');
    expect(retired.provenance.locator).toBe(`https://github.com/${REPO}/pull/128`);
    expect(retired.provenance.observedAt).toBe(FETCHED);
    expect(confirmedRecords(second.state).map((record) => record.id)).toEqual(['github:issue:140']);
  });

  it('refuses to apply a snapshot from a different connector', () => {
    const state = initialSyncState('drive:other', 'drive');
    expect(() => syncConnector(state, githubSnapshot())).toThrow(/cannot be applied/);
  });
});

describe('staleness', () => {
  it('a never-confirmed connector is stale, and a fresh one is not', () => {
    const empty = initialSyncState('drive:founder-drive-readonly', 'drive');
    expect(evaluateStaleness(empty, FETCHED).stale).toBe(true);
    const synced = syncConnector(empty, createDriveConnector(
      { accessLabel: 'founder-drive-readonly', fetchedAt: FETCHED, files: [] },
      { project: 'QOS' },
    ).snapshot());
    expect(evaluateStaleness(synced.state, FETCHED).stale).toBe(false);
  });

  it('downgrades records past the freshness budget without losing them', () => {
    const first = syncConnector(initialSyncState(`github:${REPO}`, 'github'), githubSnapshot());
    const later = applyStaleness(first.state, '2026-08-30T12:00:00Z');
    expect(later.lastState).toBe('stale');
    expect(listRecords(later)).toHaveLength(3);
    expect(listRecords(later).every((record) => record.provenance.sourceConfidence === 'stale')).toBe(true);
    expect(confirmedRecords(later)).toEqual([]);
    // Idempotent: applying it again does not compound.
    expect(applyStaleness(later, '2026-08-30T12:00:00Z')).toEqual(later);
  });
});

describe('registry', () => {
  it('lists implemented connectors alongside declared-but-unbuilt kinds', () => {
    const registry = new ConnectorRegistry().register(createGitHubConnector({ repo: REPO, fetchedAt: FETCHED }));
    const listed = registry.list();
    expect(listed.filter((entry) => entry.status === 'implemented').map((entry) => entry.name)).toEqual([
      `github:${REPO}`,
    ]);
    expect(listed.filter((entry) => entry.status === 'planned').map((entry) => entry.kind)).toEqual([
      'gmail',
      'calendar',
      'jenify_web',
      'jenify_products',
      'media',
    ]);
  });

  it('rejects a duplicate registration and reports unimplemented kinds truthfully', () => {
    const registry = new ConnectorRegistry();
    registry.register(createGitHubConnector({ repo: REPO, fetchedAt: FETCHED }));
    expect(() => registry.register(createGitHubConnector({ repo: REPO, fetchedAt: FETCHED }))).toThrow(
      /already registered/,
    );
    const fake = { name: 'gmail:founder', kind: 'gmail' as const, access: GITHUB_READ_ACCESS, snapshot: () => {
      throw new Error('unreachable');
    } };
    expect(() => registry.register(fake)).toThrow(UnimplementedConnectorError);
  });

  it('refuses any connector whose declared access could mutate the source', () => {
    const registry = new ConnectorRegistry();
    const writer = createDriveConnector(
      { accessLabel: 'writer', fetchedAt: FETCHED },
      { project: 'QOS', access: { mode: 'read_only', scopes: ['https://www.googleapis.com/auth/drive.file.write'] } },
    );
    expect(() => registry.register(writer)).toThrow(/implies mutation/);
    expect(DRIVE_READ_ACCESS.scopes.every((scope) => scope.includes('readonly'))).toBe(true);
  });
});

describe('archive pipeline integration', () => {
  it('connector evidence feeds the existing reconstruction pipeline unchanged', () => {
    const github = syncConnector(initialSyncState(`github:${REPO}`, 'github'), githubSnapshot()).state;
    const drive = syncConnector(
      initialSyncState('drive:founder-drive-readonly', 'drive'),
      createDriveConnector(
        {
          accessLabel: 'founder-drive-readonly',
          fetchedAt: FETCHED,
          files: [
            {
              id: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345',
              name: 'QOS Ethiopia plan V2',
              createdTime: '2026-06-01T09:00:00Z',
              modifiedTime: '2026-08-20T11:00:00Z',
            },
          ],
        },
        { project: 'QOS' },
      ).snapshot(),
    ).state;

    const records = reconstructArchive([...toEvidenceItems(github), ...toEvidenceItems(drive)], {
      defaultProject: 'JENIFY-OS',
      fallbackDate: '2026-01-01',
    });
    expect(records).toHaveLength(4);
    expect(records.flatMap((record) => validateArchiveRecord(record))).toEqual([]);
    // Drive metadata is an authoritative timestamp, like git and the GitHub API.
    const driveRecord = records.find((record) => record.project === 'QOS');
    expect(driveRecord?.created).toMatchObject({ confidence: 'exact', source: 'drive-api' });
    expect(driveRecord?.version).toBe('V2');
  });

  it('retired evidence is excluded from the archive feed by default', () => {
    const first = syncConnector(initialSyncState(`github:${REPO}`, 'github'), githubSnapshot());
    const emptied = createGitHubConnector({ repo: REPO, fetchedAt: '2026-08-28T12:00:00Z' }).snapshot();
    const second = syncConnector(first.state, emptied);
    expect(toEvidenceItems(second.state)).toEqual([]);
    expect(toEvidenceItems(second.state, { includeInactive: true })).toHaveLength(3);
  });

  it('summarises connector state honestly for the Founder UI', () => {
    const state = syncConnector(initialSyncState(`github:${REPO}`, 'github'), githubSnapshot()).state;
    expect(summarizeConnectorState(state)).toBe(
      `github:${REPO}: ok; 3 of 3 record(s) confirmed current; last complete confirmation ${FETCHED}`,
    );
    expect(provenanceNote([])).toBe('No connectors configured.');
  });
});
