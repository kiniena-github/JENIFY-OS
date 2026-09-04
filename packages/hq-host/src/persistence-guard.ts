/**
 * Public/host entry guard for Stage 3 persistence.
 *
 * `persistence.ts` deliberately keeps a 32-directory work cap for portable
 * local/workstation backups. Hosted durable-volume mode may never silently hit
 * that cap: a backup reported durable must have its complete directory-entry
 * chain committed back to the attested durable-root anchor.
 *
 * Until the local cap is split out of the underlying implementation, hosted
 * configurations whose fully resolved backup path would require more than 32
 * parent-directory commits are rejected fail-closed before the database opens.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  openHqPersistence as openHqPersistenceUnchecked,
  resolveHqPersistenceConfig as resolveHqPersistenceConfigUnchecked,
  type HqPersistence,
  type HqPersistenceConfig,
} from './persistence.js';

const MAX_COMMITTED_PARENT_DIRECTORIES = 32;

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

/**
 * Resolve as much of a not-yet-created backup path as the filesystem can prove.
 * Existing ancestors are realpathed so a symlink cannot hide a path whose
 * eventual directory chain is deeper than its configured spelling.
 */
function projectedRealBackupRoot(backupRoot: string): string {
  let existing = path.resolve(backupRoot);
  const missing: string[] = [];

  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }

  const realExisting = fs.realpathSync(existing);
  return path.resolve(realExisting, ...missing);
}

function hostedBackupParentDepth(config: HqPersistenceConfig): number | null {
  if (config.mode !== 'durable-volume' || !config.durableRoot) return 0;

  const durableRoot = path.resolve(config.durableRoot);
  const projected = projectedRealBackupRoot(config.backupRoot);
  if (!insideOrEqual(durableRoot, projected)) {
    // The underlying persistence boundary owns the existing path-escape refusal.
    return null;
  }

  const relative = path.relative(durableRoot, projected);
  if (relative === '') return 0;
  return relative.split(path.sep).filter(Boolean).length;
}

function refuseHostedDepth(
  config: HqPersistenceConfig,
  log: (line: string) => void,
): boolean {
  if (config.mode !== 'durable-volume') return false;

  let depth: number | null;
  try {
    depth = hostedBackupParentDepth(config);
  } catch (error) {
    log(
      `[hq] Persistence refused: could not prove the hosted backup parent chain before startup: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return true;
  }

  if (depth != null && depth > MAX_COMMITTED_PARENT_DIRECTORIES) {
    log(
      `[hq] Persistence refused: FACTORYOS_HQ_BACKUP_DIR requires ${depth} parent-directory commits beneath FACTORYOS_HQ_DURABLE_ROOT, exceeding the hosted Stage 3 durability limit of ${MAX_COMMITTED_PARENT_DIRECTORIES}.`,
    );
    return true;
  }
  return false;
}

export function resolveHqPersistenceConfig(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistenceConfig | null {
  const config = resolveHqPersistenceConfigUnchecked(env, log);
  if (!config) return null;
  if (refuseHostedDepth(config, log)) return null;
  return config;
}

export function openHqPersistence(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistence | null {
  const config = resolveHqPersistenceConfig(env, log);
  if (!config) return null;

  // Re-enter the unchanged persistence owner only after the hosted path-depth
  // contract is proven. Under Stage 3's declared single-process/single-writer
  // private-volume topology there is no supported actor that can rewrite the
  // configuration/path between this proof and the open.
  return openHqPersistenceUnchecked(env, log);
}
