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
import { liveSnapshotFromOperations, SNAPSHOT_MISSION_LIMIT } from '../live/snapshot.js';
import { CONNECTION_CATALOG } from '../live/connections.js';
import { SNAPSHOT_FILENAME } from '../ui/live-refresh.js';
import { PROVIDER_REGISTRY, type SecretsEnv } from '../routing/providers.js';
import { probeCodex } from '../providers/codex/probe.js';
import { connectionProbesWithGitHubDispatch } from '../providers/claude/connection.js';
import { ghCliTransport } from '../providers/claude/transport.js';
import { transportRouteAvailability } from '../providers/claude/dispatch-availability.js';
import { missingFlagValueMessage, readFlag } from './flags.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function flag(name: string, fallback: string | null = null): string | null {
  // The same three-outcome rule the other local-admin CLIs use (issue #224,
  // Codex P2 on `f9383dc`). Not flagged for this file, but it is the identical
  // parser and the identical hazard: a trailing `--db` used to fall back to the
  // DEFAULT database silently, so a mistyped path published a snapshot of a
  // store nobody meant to read. Leaving one of three CLIs on the known-bad
  // parser would be the same "wired one caller" mistake this round already
  // corrected twice.
  const reading = readFlag(process.argv.slice(2), name);
  if (reading.kind === 'missing_value') {
    console.error(missingFlagValueMessage(name));
    process.exit(2);
  }
  return reading.kind === 'value' ? reading.value : fallback;
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

// The GitHub row is answered by the REAL transport here, and only here
// (issue #221, Codex P2 on `1d5b3bf`).
//
// This CLI is the one production path that runs on the Founder workstation —
// the machine that actually holds the `gh` session — and it is what refreshes
// the Connection Center's live data. The static site build deliberately does
// NOT do this: it runs in CI, where spawning `gh` would observe a runner rather
// than the Founder's machine, and where a build must not make provider calls.
// So the page's live refresh tells the truth about the transport, and the
// build-time render keeps its honest configuration-only answer.
const transport = ghCliTransport();

// What CLAUDE dispatchability actually depends on HERE (issue #224).
//
// `CLAUDE_ROUTINE_*` are GitHub Actions secrets the workflow needs; they are
// deliberately absent on the Founder workstation, where dispatch happens
// through the authenticated `gh` transport instead. Deriving the verdict from
// their absence would report a successfully dispatched order as blocked
// forever, in exactly the environment this lane is built for.
//
// The shared, reviewed derivation — the same one the server host uses
// (issue #224, Codex P2 on `9fd1f1c`). The inline version this replaces
// collapsed every negative to null, including a LIVE one: `gh auth status`
// calls the API, so a non-zero exit means the session is missing, expired or
// revoked. Discarding that let `directOrderDispatchBlocked` fall back to
// environment inference, and a workstation that happens to carry
// `CLAUDE_ROUTINE_*` then wrote a snapshot reporting CLAUDE orders as ready
// while the only real transport would refuse them.
//
// Fixing the server host and leaving this one was the same mistake in
// miniature that the earlier round already caught here: adding a shared seam
// and wiring one caller is not wiring it.
const dispatchAvailability = transportRouteAvailability(transport).providerDispatchable;

const snapshot = liveSnapshotFromOperations(ops, {
  now: new Date().toISOString(),
  env: observeFacts(),
  mode: 'live',
  connectionProbes: connectionProbesWithGitHubDispatch(transport),
  dispatchAvailability,
  // The WRITTEN artefact is bounded (newest N; counts and provenance keep
  // the total honest). The live /state route stays unbounded on purpose.
  missionLimit: SNAPSHOT_MISSION_LIMIT,
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
