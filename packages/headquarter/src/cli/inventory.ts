/**
 * Inventory CLI: reconstruct canonical archive records from the repo's own
 * GitHub-visible history (git log + an exported issues/PRs snapshot).
 *
 * Read-only over sources; writes only a derived JSON under dist/.
 * Usage: npm run inventory --workspace @factoryos/headquarter
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GIT_LOG_FORMAT,
  createGitLogAdapter,
  createGitHubExportAdapter,
  reconstructArchive,
  type GitHubExport,
} from '../archive/inventory.js';
import { validateArchiveRecord } from '../archive/schema.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = join(packageRoot, '..', '..');

const rawLog = execFileSync('git', ['log', `--pretty=format:${GIT_LOG_FORMAT}`], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

const adapters = [
  createGitLogAdapter(rawLog, {
    project: 'JENIFY-OS',
    repoUrl: 'https://github.com/kiniena-github/JENIFY-OS',
  }),
];

const exportPath = join(packageRoot, 'sample-data', 'github-export.json');
if (existsSync(exportPath)) {
  const exportData = JSON.parse(readFileSync(exportPath, 'utf8')) as GitHubExport;
  adapters.push(createGitHubExportAdapter(exportData));
}

const evidence = adapters.flatMap((adapter) => adapter.collect());
const records = reconstructArchive(evidence, {
  defaultProject: 'JENIFY-OS',
  fallbackDate: '2026-01-01',
});

const invalid = records.flatMap((record) => {
  const errors = validateArchiveRecord(record);
  return errors.length > 0 ? [{ id: record.id, errors }] : [];
});
if (invalid.length > 0) {
  console.error('Invalid reconstructed records:', JSON.stringify(invalid, null, 2));
  process.exit(1);
}

const outDir = join(packageRoot, 'dist');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'archive-inventory.json');
writeFileSync(outPath, JSON.stringify(records, null, 2));
console.log(`Reconstructed ${records.length} archive records from ${adapters.length} source adapter(s) → ${outPath}`);
