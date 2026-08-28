/**
 * Single-file Headquarter preview builder (issue #196): renders the site from
 * a canonical data bundle and folds all seven pages into one self-contained
 * HTML file that opens in a normal browser with no server and no deployment.
 *
 * Local files only — no network, no deployment, no secrets.
 * Usage: npm run build:preview --workspace @factoryos/headquarter [-- path/to/data.json]
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, type HeadquarterData } from '../ui/site.js';
import { buildPreviewBundle } from '../ui/preview-bundle.js';
import type { ArchiveRecord } from '../archive/schema.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataPath = process.argv[2] ?? join(packageRoot, 'sample-data', 'hq-sample.json');
const data = JSON.parse(readFileSync(dataPath, 'utf8')) as HeadquarterData;

const inventoryPath = join(packageRoot, 'dist', 'archive-inventory.json');
if (existsSync(inventoryPath)) {
  const reconstructed = JSON.parse(readFileSync(inventoryPath, 'utf8')) as ArchiveRecord[];
  const known = new Set(data.archive.map((record) => record.id));
  data.archive = [...data.archive, ...reconstructed.filter((record) => !known.has(record.id))];
}

/** The commit is stated, never guessed: omitted entirely if git cannot say. */
function currentCommit(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: packageRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

const html = buildPreviewBundle({
  site: buildSite(data),
  commit: currentCommit(),
  provenanceNote: data.note,
});

const outDir = join(packageRoot, 'dist', 'preview');
const outFile = join(outDir, 'jenify-hq-preview.html');
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, html);
console.log(`Bundled the Headquarter preview (${html.length} bytes) → ${outFile}`);
