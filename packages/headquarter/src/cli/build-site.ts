/**
 * Static HQ site builder: renders the full Headquarter page set from a
 * canonical data bundle to dist/site/. Local files only — no network,
 * no deployment.
 * Usage: npm run build:site --workspace @factoryos/headquarter [-- path/to/data.json]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, bundleAsOf, type HeadquarterData } from '../ui/site.js';
import { SNAPSHOT_FILENAME } from '../ui/live-refresh.js';
import type { ArchiveRecord } from '../archive/schema.js';
import { assessConnections, CONNECTION_CATALOG } from '../live/connections.js';
import { buildHqSnapshot, emptyFounderConsole, portableSourceLabel } from '../live/snapshot.js';
import { PROVIDER_REGISTRY, type SecretsEnv } from '../routing/providers.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(packageRoot, '..', '..');
const dataPath = process.argv[2] ?? join(packageRoot, 'sample-data', 'hq-sample.json');
// The label the snapshot's provenance carries. NEVER the resolved absolute
// path: the snapshot is served to the browser, so an absolute path would leak
// the build machine's filesystem layout — and it made the artefact differ
// byte-for-byte per checkout location, breaking reproducible builds
// (issue #200, integration-lane coordinator finding).
const dataPathLabel = portableSourceLabel(dataPath, repoRoot);
const data = JSON.parse(readFileSync(dataPath, 'utf8')) as HeadquarterData;

// If the inventory pipeline has produced reconstructed records, merge them in
// so the Archive page browses real repository history.
const inventoryPath = join(packageRoot, 'dist', 'archive-inventory.json');
if (existsSync(inventoryPath)) {
  const reconstructed = JSON.parse(readFileSync(inventoryPath, 'utf8')) as ArchiveRecord[];
  const known = new Set(data.archive.map((record) => record.id));
  data.archive = [...data.archive, ...reconstructed.filter((record) => !known.has(record.id))];
}

/**
 * Non-secret facts the build may observe (issue #200).
 *
 * Only the NAMES listed in the connection catalogue and the routing registry
 * are read, and only their presence is used. No value is copied into the
 * snapshot or into any rendered page — `live/redaction.ts` proves that on
 * every build, and the build fails rather than writing an unsafe artefact.
 *
 * Passing the real `process.env` straight through would be a needless widening
 * of what this process even looks at, so the observable set is explicit.
 */
const OBSERVABLE_FACTS = [
  ...new Set([
    ...CONNECTION_CATALOG.flatMap((descriptor) => descriptor.requiredFacts),
    ...Object.values(PROVIDER_REGISTRY).flatMap((provider) => [
      ...provider.requiredSecrets,
      ...provider.requiredLocalFacts,
    ]),
  ]),
];

const env: SecretsEnv = Object.fromEntries(
  OBSERVABLE_FACTS.map((fact) => [fact, process.env[fact]]).filter(([, value]) => value != null),
);

data.env = env;

const site = buildSite({ ...data, env });
const outDir = join(packageRoot, 'dist', 'site');
mkdirSync(outDir, { recursive: true });
for (const [file, html] of site) {
  writeFileSync(join(outDir, file), html);
}

/**
 * The snapshot the pages poll for freshness. Built from the same bundle the
 * pages were rendered from, so `generatedAt` matching the pages' "As of"
 * stamp is a true statement rather than a coincidence.
 *
 * The operational sections come from the bundle rather than from a live
 * database here — this CLI renders a data file, it does not open the HQ
 * store — so the snapshot declares the bundle's own mode. A bundle that
 * does not state a mode is treated as `sample`: the safest reading of "this
 * build never said where its data came from".
 */
const asOf = bundleAsOf(data);
const snapshot = buildHqSnapshot({
  generatedAt: asOf,
  note: data.note,
  console: {
    data: emptyFounderConsole(asOf),
    provenance: {
      mode: data.sourceMode ?? 'sample',
      source: `static bundle ${dataPathLabel} (no HQ database was opened by this build)`,
      asOf,
      note: 'Operational sections are rendered from the bundle, not read from op_tasks.',
    },
  },
  connections: {
    data: assessConnections(env, { now: asOf }),
    provenance: {
      // Connections are genuinely probed on this machine even in a static
      // build, so their mode is independent of the bundle's.
      mode: 'live',
      source: 'live/connections.assessConnections over observed environment facts',
      asOf,
    },
  },
  workforce: {
    data: data.specialists,
    provenance: { mode: data.sourceMode ?? 'sample', source: `bundle.specialists (${dataPathLabel})`, asOf },
  },
  capabilities: {
    data: [],
    provenance: {
      mode: data.sourceMode ?? 'sample',
      source: 'no capability registry is open in a static build',
      asOf,
    },
  },
  activity: {
    data: data.events,
    provenance: { mode: data.sourceMode ?? 'sample', source: `bundle.events (${dataPathLabel})`, asOf },
  },
});

writeFileSync(join(outDir, SNAPSHOT_FILENAME), `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`Rendered ${site.size} Headquarter pages → ${outDir}`);
console.log(`Wrote ${SNAPSHOT_FILENAME} (mode: ${snapshot.mode}, as of ${snapshot.generatedAt})`);
