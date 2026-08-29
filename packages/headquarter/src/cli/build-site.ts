/**
 * Static HQ site builder: renders the full Headquarter page set from a
 * canonical data bundle to dist/site/. Local files only — no network,
 * no deployment.
 * Usage: npm run build:site --workspace @factoryos/headquarter [-- path/to/data.json]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import type { SourceMode } from '../live/provenance.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, bundleAsOf, type HeadquarterData } from '../ui/site.js';
import { SNAPSHOT_FILENAME } from '../ui/live-refresh.js';
import type { ArchiveRecord } from '../archive/schema.js';
import { assessConnections, CONNECTION_CATALOG } from '../live/connections.js';
import { buildHqSnapshot, emptyFounderConsole } from '../live/snapshot.js';
import { PROVIDER_REGISTRY, type SecretsEnv } from '../routing/providers.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataPath = process.argv[2] ?? join(packageRoot, 'sample-data', 'hq-sample.json');
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
/**
 * The strongest provenance a SYNTHETIC section may claim in a static build.
 *
 * The rule, stated once so both call sites share it: a section whose data came
 * out of the bundle may carry the bundle's own mode, because that claim is
 * about the bundle and its author is entitled to make it. A section whose data
 * is fabricated here — `emptyFounderConsole`, a hard-coded `[]` — may not,
 * because the bundle never supplied it and cannot vouch for it.
 *
 * Never `live` either way: this command opens no database, so nothing in it was
 * read from the canonical store. Only `hq:snapshot`, which does open the store,
 * can establish live provenance (issue #200, Codex exact-head findings on
 * `f221826` and `135ae58` — the console section first, then the capability
 * section, which had the same shape and was missed the first time).
 */
function staticSectionMode(declared: SourceMode | undefined): SourceMode {
  if (declared === 'reconstructed') return 'reconstructed';
  return 'sample';
}

const asOf = bundleAsOf(data);
const snapshot = buildHqSnapshot({
  generatedAt: asOf,
  note: data.note,
  console: {
    data: emptyFounderConsole(asOf),
    // This section can NEVER be live, whatever the bundle claims about itself.
    //
    // It is `emptyFounderConsole` — this command does not open the HQ store, by
    // design. A bundle setting `sourceMode: 'live'` therefore used to stamp
    // LIVE provenance on a deliberately empty operational section, and since
    // the emitted snapshot shares the HTML's `asOf`, the freshness poll then
    // reported LIVE over state that was fabricated rather than read (issue
    // #200, Codex exact-head finding on `f221826`). The bundle's own mode is a
    // claim about the bundle; it cannot vouch for a section whose contents
    // nothing produced.
    //
    // `live` is refused rather than trusted here, which is the same rule the
    // browser applies at the other end of this pipeline: only positive live
    // provenance may say LIVE, and only `hq:snapshot` — which does open the
    // store — can establish it.
    provenance: {
      mode: staticSectionMode(data.sourceMode),
      source: `static bundle ${dataPath} (no HQ database was opened by this build)`,
      asOf,
      note:
        'Operational sections are rendered from the bundle, not read from op_tasks. A static ' +
        'build cannot report live operational state; run `npm run hq:snapshot` for that.',
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
    provenance: { mode: data.sourceMode ?? 'sample', source: `bundle.specialists (${dataPath})`, asOf },
  },
  capabilities: {
    // Synthetic, exactly like the console section: always the hard-coded empty
    // array, and the source line beside it says no registry was opened. A
    // bundle declaring `live` was telling section consumers that zero
    // capabilities is live canonical state.
    data: [],
    provenance: {
      mode: staticSectionMode(data.sourceMode),
      source: 'no capability registry is open in a static build',
      asOf,
    },
  },
  activity: {
    data: data.events,
    provenance: { mode: data.sourceMode ?? 'sample', source: `bundle.events (${dataPath})`, asOf },
  },
});

writeFileSync(join(outDir, SNAPSHOT_FILENAME), `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`Rendered ${site.size} Headquarter pages → ${outDir}`);
console.log(`Wrote ${SNAPSHOT_FILENAME} (mode: ${snapshot.mode}, as of ${snapshot.generatedAt})`);
