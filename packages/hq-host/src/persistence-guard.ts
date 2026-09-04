/**
 * Public/host entry guard for Stage 3 persistence.
 *
 * `persistence.ts` deliberately keeps a 32-directory work cap for portable
 * local/workstation backups. Hosted durable-volume mode may never silently hit
 * that cap: a backup reported durable must have its complete directory-entry
 * chain committed back to the attested durable-root anchor.
 *
 * Hosted mode also needs positive provenance that the mounted filesystem is a
 * volume the operator/provider asserts survives workload replacement. Linux
 * mount metadata can prove mount identity and filesystem class, but it cannot
 * distinguish a persistent block volume from lifecycle-scoped instance/CSI
 * storage of the same ext4/xfs class. Stage 3 therefore requires an explicit,
 * reviewable operator/provider volume identity before opening canonical state.
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
const DURABLE_PROVENANCE_PATTERN = /^(operator|provider):[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;

function insideOrEqual(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function requireHostedDurableProvenance(
  env: Record<string, string | undefined>,
  config: HqPersistenceConfig,
  log: (line: string) => void,
): boolean {
  if (config.runtime !== 'hosted' || config.mode !== 'durable-volume') return true;

  const provenance = env.FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE?.trim() ?? '';
  if (!DURABLE_PROVENANCE_PATTERN.test(provenance)) {
    log(
      '[hq] Persistence refused: hosted durable-volume mode requires ' +
        'FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE=operator:<stable-volume-id> or ' +
        'provider:<stable-volume-id>. The identifier is an explicit operator/provider assertion ' +
        'that this mounted volume survives workload replacement; filesystem type alone is not durability provenance.',
    );
    return false;
  }

  log(`[hq] durable volume provenance: ${provenance}`);
  return true;
}

/**
 * Resolve as much of a not-yet-created backup path as the filesystem can prove.
 * Existing ancestors are realpathed so a symlink cannot hide either a path
 * escape or a directory chain deeper than its configured spelling.
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

function hostedBackupParentDepth(config: HqPersistenceConfig): number {
  if (config.mode !== 'durable-volume' || !config.durableRoot) return 0;

  const durableRoot = path.resolve(config.durableRoot);
  const projected = projectedRealBackupRoot(config.backupRoot);
  if (!insideOrEqual(durableRoot, projected)) {
    throw new Error(
      'FACTORYOS_HQ_BACKUP_DIR resolves outside FACTORYOS_HQ_DURABLE_ROOT through an existing ancestor; hosted startup refuses before any backup directories can be created',
    );
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

  let depth: number;
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

  if (depth > MAX_COMMITTED_PARENT_DIRECTORIES) {
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
  if (!requireHostedDurableProvenance(env, config, log)) return null;
  if (refuseHostedDepth(config, log)) return null;
  return config;
}

export function openHqPersistence(
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.log(line),
): HqPersistence | null {
  const config = resolveHqPersistenceConfig(env, log);
  if (!config) return null;

  // Re-enter the unchanged persistence owner only after the hosted provenance
  // and path-depth/containment contracts are proven. Under Stage 3's declared
  // single-process/single-writer private-volume topology there is no supported
  // actor that can rewrite the configuration/path between this proof and open.
  return openHqPersistenceUnchecked(env, log);
}
