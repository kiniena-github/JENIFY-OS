/**
 * Test support for hosted durable mount-boundary attestation.
 *
 * Production (see `assertDurableRootIsMountBoundary` in ../../src/persistence.ts)
 * refuses a configured durable root unless the kernel's /proc/self/mountinfo
 * shows a volume mounted EXACTLY at that root whose mount identity matches the
 * opened root descriptor. A real mounted volume cannot be created without
 * privileges CI does not have, so these helpers present an ordinary test
 * directory to that probe as though a durable volume were mounted at it — and
 * nothing else. Every device / mount-id / inode cross-check against the real
 * opened descriptors still runs unmodified, so the attestation being exercised
 * is real; only the mount table is simulated.
 *
 * The negative case (an unattested ordinary directory is refused) is proven
 * WITHOUT these helpers, against the real mount table.
 *
 * The synthetic entry declares a PERMITTED PERSISTENT filesystem class (`ext4`
 * on a block-device-shaped source) because that is what a real hosted durable
 * volume looks like. It used to declare `tmpfs`, which taught the suite that an
 * ephemeral filesystem is acceptable durable storage — the exact defect the
 * filesystem-class gate now refuses. `filesystemType` is only overridden by the
 * tests that deliberately synthesize a REFUSED filesystem.
 */

import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

function decodeMountInfoField(field: string): string {
  return field.replace(/\\([0-3][0-7][0-7])/g, (_match, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

function encodeMountInfoField(value: string): string {
  return value
    .replace(/\\/g, '\\134')
    .replace(/ /g, '\\040')
    .replace(/\t/g, '\\011')
    .replace(/\n/g, '\\012');
}

export interface SyntheticMountOptions {
  /** Declared filesystem type. Defaults to the permitted persistent class `ext4`. */
  filesystemType?: string;
  mountSource?: string;
  mountOptions?: string;
  superOptions?: string;
}

/**
 * The mount id of the real mount that actually owns `target` (longest matching
 * mount point). The descriptor opened on `target` reports exactly this id via
 * /proc/self/fdinfo, so reusing it keeps the simulated mount table internally
 * consistent with the real opened root descriptor.
 */
function owningMountId(mountInfo: string, target: string): number {
  const resolvedTarget = path.resolve(target);
  let best: { id: number; length: number } | null = null;
  for (const line of mountInfo.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    if (fields.length < 5) continue;
    const id = Number(fields[0]);
    if (!Number.isSafeInteger(id)) continue;
    const mountPoint = path.resolve(decodeMountInfoField(fields[4]));
    const isAncestor =
      resolvedTarget === mountPoint ||
      resolvedTarget.startsWith(mountPoint === '/' ? '/' : `${mountPoint}${path.sep}`);
    if (isAncestor && (!best || mountPoint.length > best.length)) {
      best = { id, length: mountPoint.length };
    }
  }
  if (!best) throw new Error(`no owning mount found for ${target} in /proc/self/mountinfo`);
  return best.id;
}

/**
 * The real /proc/self/mountinfo plus one synthetic line that presents `root` as
 * a mount point in its own right, with the mount id its owning mount already
 * reports. Accumulates across calls so several roots can be attested in one
 * test: it starts from whatever the current `fs.readFileSync` returns for the
 * mount table, which already includes any previously appended synthetic lines.
 */
export function syntheticMountInfoFor(
  root: string,
  read: typeof fs.readFileSync = fs.readFileSync,
  options: SyntheticMountOptions = {},
): string {
  const base = read('/proc/self/mountinfo', 'utf8') as string;
  const realRoot = fs.realpathSync(root);
  const mountId = owningMountId(base, realRoot);
  const filesystemType = options.filesystemType ?? 'ext4';
  const mountSource = options.mountSource ?? '/dev/synthetic-durable';
  const mountOptions = options.mountOptions ?? 'rw,relatime';
  const superOptions = options.superOptions ?? 'rw';
  const line =
    `${mountId} 1 0:0 / ${encodeMountInfoField(realRoot)} ${mountOptions} shared:1 - ` +
    `${filesystemType} ${encodeMountInfoField(mountSource)} ${superOptions}`;
  return `${base.replace(/\n?$/, '\n')}${line}\n`;
}

/**
 * Install (or extend) a `fs.readFileSync` spy so hosted mount-boundary
 * attestation treats `root` as a genuine mount boundary. Delegates every other
 * read — crucially /proc/self/fdinfo/<fd>, which supplies the real mount id the
 * synthetic line reuses — to the previously active implementation, so this
 * composes with a test that also stubs readFileSync as long as this is called
 * last. Cleaned up by `vi.restoreAllMocks()`.
 */
export function attestDurableMountBoundary(root: string, options: SyntheticMountOptions = {}): void {
  const previousRead = fs.readFileSync.bind(fs) as typeof fs.readFileSync;
  const synthetic = syntheticMountInfoFor(root, previousRead, options);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((candidate: unknown, options: unknown) => {
    if (String(candidate) === '/proc/self/mountinfo') return synthetic as never;
    return previousRead(candidate as never, options as never) as never;
  }) as typeof fs.readFileSync);
}
