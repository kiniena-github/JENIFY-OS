/**
 * Static HQ site builder: renders the full Headquarter page set from a
 * canonical data bundle to dist/site/. Local files only — no network,
 * no deployment.
 * Usage: npm run build:site --workspace @factoryos/headquarter [-- path/to/data.json]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, type HeadquarterData } from '../ui/site.js';
import type { ArchiveRecord } from '../archive/schema.js';

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

const site = buildSite(data);
const outDir = join(packageRoot, 'dist', 'site');
mkdirSync(outDir, { recursive: true });
for (const [file, html] of site) {
  writeFileSync(join(outDir, file), html);
}
console.log(`Rendered ${site.size} Headquarter pages → ${outDir}`);
