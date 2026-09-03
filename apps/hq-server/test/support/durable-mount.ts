/**
 * Test support for hosted durable mount-boundary attestation (see the matching
 * helper in `@factoryos/hq-host`). Production refuses a configured durable root
 * unless /proc/self/mountinfo shows a volume mounted exactly at it whose mount
 * identity matches the opened root descriptor. A real mount cannot be created
 * without privileges CI lacks, so this presents an ordinary test directory to
 * that probe as though a durable volume were mounted at it — and nothing else;
 * every real device/mount-id/inode cross-check still runs.
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

export function attestDurableMountBoundary(root: string): void {
  const previousRead = fs.readFileSync.bind(fs) as typeof fs.readFileSync;
  const base = previousRead('/proc/self/mountinfo', 'utf8') as string;
  const realRoot = fs.realpathSync(root);
  const mountId = owningMountId(base, realRoot);
  const line = `${mountId} 1 0:0 / ${encodeMountInfoField(realRoot)} rw,relatime shared:1 - tmpfs synthetic rw`;
  const synthetic = `${base.replace(/\n?$/, '\n')}${line}\n`;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((candidate: unknown, options: unknown) => {
    if (String(candidate) === '/proc/self/mountinfo') return synthetic as never;
    return previousRead(candidate as never, options as never) as never;
  }) as typeof fs.readFileSync);
}
