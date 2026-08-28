/**
 * Live HQ snapshot CLI (issue #200, scope A).
 *
 * Reads the canonical HQ store on this machine and writes the browser-safe
 * snapshot the rendered pages poll. This is the LIVE counterpart to
 * `build-site.ts`, which renders a static data bundle and can only honestly
 * claim `sample`.
 *
 *   npm run hq:snapshot --workspace @factoryos/headquarter -- \
 *     [--db <path>] [--out <file>]
 *
 * Read-only, and enforced rather than asserted: the database is opened with
 * `openHqDatabaseReadOnly`, so SQLite itself refuses every write on the
 * connection. That matters because the ordinary open is a MIGRATING one — it
 * creates the file when absent, switches the journal to WAL and applies DDL —
 * so this tool used to alter the Founder's schema on every run while
 * describing itself as read-only, and a typo in `--db` created an empty
 * database that was then published as LIVE HQ state. Every call it makes
 * (`founderConsole`, the specialist directory, the capability registry, the
 * event log) is a read path, and it refuses to write an artefact that
 * `live/redaction.ts` cannot prove is free of credentials.
 *
 * Local only. No network, no deployment.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openHqDatabaseReadOnly } from '../store/db.js';
import { HeadquarterOperations } from '../application/service.js';
import { liveSnapshotFromOperations } from '../live/snapshot.js';
import { CONNECTION_CATALOG } from '../live/connections.js';
import { SNAPSHOT_FILENAME } from '../ui/live-refresh.js';
import { PROVIDER_REGISTRY, type SecretsEnv } from '../routing/providers.js';
import { probeCodex } from '../providers/codex/probe.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function flag(name: string, fallback: string | null = null): string | null {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  return index === -1 || index + 1 >= argv.length ? fallback : (argv[index + 1] ?? fallback);
}

/** Observe fact PRESENCE only — the same convention routing already uses. */
function observeFacts(): SecretsEnv {
  const names = new Set([
    ...CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts),
    ...Object.values(PROVIDER_REGISTRY).flatMap((provider) => [
      ...provider.requiredSecrets,
      ...provider.requiredLocalFacts,
    ]),
  ]);
  const env: SecretsEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value != null && value.trim() !== '') env[name] = value;
  }
  for (const [name, value] of Object.entries(probeCodex().facts)) env[name] = value;
  return env;
}

const dbPath = flag('db');
const outPath = flag('out') ?? join(packageRoot, 'dist', 'site', SNAPSHOT_FILENAME);

// Read-only at the CONNECTION, not merely by convention: SQLite refuses every
// write on this handle, and a missing database file is an error rather than a
// new empty one silently reported as LIVE HQ state.
let db;
try {
  db = openHqDatabaseReadOnly(dbPath ?? undefined);
} catch (error) {
  console.error(
    `Could not open the Headquarter database read-only at ${dbPath ?? '(default path)'}: ` +
      `${(error as Error).message}\n` +
      'This tool only projects an existing store. Creating or migrating one is the job of the ' +
      'process that owns it — run that first, or pass --db with the right path.',
  );
  process.exit(1);
}
const ops = new HeadquarterOperations(db);

const snapshot = liveSnapshotFromOperations(ops, {
  now: new Date().toISOString(),
  env: observeFacts(),
  mode: 'live',
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`Wrote a ${snapshot.mode} snapshot → ${outPath}`);
console.log(
  `  approvals ${snapshot.counts.approvals} · in flight ${snapshot.counts.inFlight} · ` +
    `blocked ${snapshot.counts.blocked} · queued ${snapshot.counts.queued}`,
);
console.log(
  `  connections: ${snapshot.connections.data
    .map((connection) => `${connection.id}=${connection.state}`)
    .join(', ')}`,
);
