/**
 * Stage 3 durable-filesystem policy.
 *
 * Mount-boundary attestation proved the durable root is a real mount whose
 * identity matches the opened descriptor — but the parser discarded everything
 * after the mountinfo separator, so `tmpfs`, `ramfs` or a container overlay root
 * satisfied the gate while every same-device/same-mount check still passed.
 * Canonical HQ state would then vanish on workload replacement.
 *
 * These are the deterministic, unprivileged proofs of the allow/refuse decision
 * itself: real kernel mount data where it is available, synthetic mountinfo
 * lines where a specific filesystem class has to be present on demand.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  absoluteFilesystemRefusal,
  classifyDurableFilesystem,
  parseAttestedFilesystems,
  parseMountInfo,
  KERNEL_VIRTUAL_FILESYSTEMS,
  KNOWN_EPHEMERAL_FILESYSTEMS,
  KNOWN_PERSISTENT_FILESYSTEMS,
  UNSUPPORTED_SHARED_FILESYSTEMS,
} from '../src/durable-filesystem.js';

function mountLine(
  mountPoint: string,
  filesystemType: string,
  {
    mountOptions = 'rw,relatime',
    mountSource = '/dev/synthetic-durable',
    superOptions = 'rw',
    optional = 'shared:1',
  } = {},
): string {
  return `42 27 0:31 / ${mountPoint} ${mountOptions} ${optional} - ${filesystemType} ${mountSource} ${superOptions}`;
}

describe('mountinfo parsing keeps filesystem metadata', () => {
  it('preserves the fields after the separator, which the durable gate depends on', () => {
    const [boundary] = parseMountInfo(mountLine('/durable', 'ext4', { mountSource: '/dev/vdb' }));

    expect(boundary).toMatchObject({
      mountId: 42,
      mountPoint: '/durable',
      filesystemType: 'ext4',
      mountSource: '/dev/vdb',
    });
    expect(boundary!.mountOptions).toContain('rw');
    expect(boundary!.superOptions).toContain('rw');
  });

  it('reads the separator past a variable number of optional fields', () => {
    const [boundary] = parseMountInfo(
      mountLine('/durable', 'xfs', { optional: 'shared:1 master:2 propagate_from:3 unbindable' }),
    );

    expect(boundary?.filesystemType).toBe('xfs');
  });

  it('parses a mount with no optional fields at all', () => {
    const [boundary] = parseMountInfo(mountLine('/durable', 'btrfs', { optional: '' }).replace('  ', ' '));

    expect(boundary?.filesystemType).toBe('btrfs');
  });

  it('unescapes octal sequences in the mount point and mount source', () => {
    const [boundary] = parseMountInfo(
      mountLine('/durable\\040volume', 'ext4', { mountSource: '/dev/disk\\040by-id' }),
    );

    expect(boundary?.mountPoint).toBe('/durable volume');
    expect(boundary?.mountSource).toBe('/dev/disk by-id');
  });

  it('lowercases the filesystem type so classification cannot be case-dodged', () => {
    expect(parseMountInfo(mountLine('/durable', 'TmpFS'))[0]?.filesystemType).toBe('tmpfs');
  });

  it('drops entries whose post-separator section is missing or truncated', () => {
    // The old parser accepted these as valid boundaries because it never looked
    // past field 5. An entry that cannot be evaluated must attest nothing.
    expect(parseMountInfo('42 27 0:31 / /durable rw,relatime shared:1')).toHaveLength(0);
    expect(parseMountInfo('42 27 0:31 / /durable rw,relatime shared:1 - ext4')).toHaveLength(0);
    expect(parseMountInfo('42 27 0:31 / /durable rw,relatime - ext4 /dev/vdb')).toHaveLength(0);
    expect(parseMountInfo('not-a-mountinfo-line')).toHaveLength(0);
    expect(parseMountInfo('')).toHaveLength(0);
  });

  it('parses the real kernel mount table with a filesystem type on every entry', () => {
    if (process.platform !== 'linux') return;

    const boundaries = parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'));

    expect(boundaries.length).toBeGreaterThan(0);
    for (const boundary of boundaries) {
      expect(boundary.filesystemType).not.toBe('');
      expect(boundary.mountPoint.startsWith('/')).toBe(true);
    }
  });
});

describe('durable-filesystem classification', () => {
  it('refuses tmpfs even though it is a genuine mount boundary', () => {
    const verdict = classifyDurableFilesystem(parseMountInfo(mountLine('/durable', 'tmpfs'))[0]!);

    expect(verdict.durable).toBe(false);
    expect(verdict).toMatchObject({ refusal: 'ephemeral' });
  });

  it('refuses a container overlay/ephemeral root', () => {
    const verdict = classifyDurableFilesystem(
      parseMountInfo(mountLine('/', 'overlay', { mountSource: 'overlay' }))[0]!,
    );

    expect(verdict).toMatchObject({ durable: false, refusal: 'ephemeral' });
  });

  it('refuses every known ephemeral and kernel-virtual class', () => {
    for (const filesystemType of [...KNOWN_EPHEMERAL_FILESYSTEMS, ...KERNEL_VIRTUAL_FILESYSTEMS]) {
      const verdict = classifyDurableFilesystem(
        parseMountInfo(mountLine('/durable', filesystemType))[0]!,
      );
      expect(verdict.durable, `${filesystemType} must never be attested as durable`).toBe(false);
    }
  });

  it('refuses network, clustered, FUSE and passthrough filesystems as unsupported here', () => {
    for (const filesystemType of UNSUPPORTED_SHARED_FILESYSTEMS) {
      expect(
        classifyDurableFilesystem(parseMountInfo(mountLine('/durable', filesystemType))[0]!),
      ).toMatchObject({ durable: false, refusal: 'unsupported-shared' });
    }
    // Subtyped FUSE filesystems classify by their base type.
    expect(
      classifyDurableFilesystem(parseMountInfo(mountLine('/durable', 'fuse.sshfs'))[0]!),
    ).toMatchObject({ durable: false, refusal: 'unsupported-shared' });
  });

  it('accepts the permitted block-backed persistent classes', () => {
    for (const filesystemType of KNOWN_PERSISTENT_FILESYSTEMS) {
      expect(
        classifyDurableFilesystem(parseMountInfo(mountLine('/durable', filesystemType))[0]!),
      ).toEqual({ durable: true, basis: 'known-persistent' });
    }
  });

  it('refuses a persistent filesystem mounted read-only', () => {
    expect(
      classifyDurableFilesystem(
        parseMountInfo(mountLine('/durable', 'ext4', { mountOptions: 'ro,relatime' }))[0]!,
      ),
    ).toMatchObject({ durable: false, refusal: 'read-only' });
    expect(
      classifyDurableFilesystem(
        parseMountInfo(mountLine('/durable', 'ext4', { superOptions: 'ro' }))[0]!,
      ),
    ).toMatchObject({ durable: false, refusal: 'read-only' });
  });

  it('refuses an unknown filesystem instead of assuming it persists', () => {
    expect(
      classifyDurableFilesystem(parseMountInfo(mountLine('/durable', 'somenewfs'))[0]!),
    ).toMatchObject({ durable: false, refusal: 'unclassified' });
  });

  it('accepts an unclassified filesystem only when the operator attests it explicitly', () => {
    const boundary = parseMountInfo(mountLine('/durable', 'somenewfs'))[0]!;

    expect(classifyDurableFilesystem(boundary, ['somenewfs'])).toEqual({
      durable: true,
      basis: 'operator-attested',
    });
    // The attestation is scoped to what it names, not a blanket relaxation.
    expect(classifyDurableFilesystem(boundary, ['otherfs'])).toMatchObject({ durable: false });
  });

  it('never lets an operator attestation promote an absolutely refused filesystem', () => {
    for (const filesystemType of [
      ...KNOWN_EPHEMERAL_FILESYSTEMS,
      ...KERNEL_VIRTUAL_FILESYSTEMS,
      ...UNSUPPORTED_SHARED_FILESYSTEMS,
    ]) {
      const verdict = classifyDurableFilesystem(
        parseMountInfo(mountLine('/durable', filesystemType))[0]!,
        [filesystemType],
      );
      expect(verdict.durable, `${filesystemType} must stay refused despite attestation`).toBe(false);
    }
  });

  it('refuses every real tmpfs and virtual mount the kernel currently reports', () => {
    if (process.platform !== 'linux') return;

    // Real mount data, no simulation: any Linux host has several of these, and
    // not one of them may pass the durable gate.
    const boundaries = parseMountInfo(readFileSync('/proc/self/mountinfo', 'utf8'));
    const nonDurable = boundaries.filter(
      (boundary) =>
        KNOWN_EPHEMERAL_FILESYSTEMS.includes(boundary.filesystemType) ||
        KERNEL_VIRTUAL_FILESYSTEMS.includes(boundary.filesystemType),
    );

    expect(nonDurable.length).toBeGreaterThan(0);
    for (const boundary of nonDurable) {
      expect(
        classifyDurableFilesystem(boundary).durable,
        `${boundary.mountPoint} (${boundary.filesystemType}) must be refused`,
      ).toBe(false);
    }
  });
});

describe('operator filesystem attestation parsing', () => {
  it('treats an unset or blank value as no attestation', () => {
    expect(parseAttestedFilesystems(undefined)).toEqual({ ok: true, values: [] });
    expect(parseAttestedFilesystems('   ')).toEqual({ ok: true, values: [] });
  });

  it('normalizes and de-duplicates the listed types', () => {
    expect(parseAttestedFilesystems(' SomeNewFS , somenewfs ,otherfs ')).toEqual({
      ok: true,
      values: ['somenewfs', 'otherfs'],
    });
  });

  it('refuses wildcards and malformed entries rather than widening blindly', () => {
    for (const raw of ['*', 'ext4,*', 'some fs', 'ext4;xfs', '../etc']) {
      expect(parseAttestedFilesystems(raw).ok, `"${raw}" must be refused`).toBe(false);
    }
  });

  it('refuses to attest a known ephemeral, virtual or unsupported filesystem', () => {
    for (const filesystemType of ['tmpfs', 'ramfs', 'overlay', 'proc', 'nfs', 'fuse.sshfs']) {
      const result = parseAttestedFilesystems(filesystemType);
      expect(result.ok, `${filesystemType} must not be attestable`).toBe(false);
      if (!result.ok) expect(result.detail).toContain('FACTORYOS_HQ_DURABLE_FS_ALLOW');
    }
    // One bad entry refuses the whole list; it is not silently filtered out.
    expect(parseAttestedFilesystems('somenewfs,tmpfs').ok).toBe(false);
  });

  it('agrees with classification about what is absolutely refused', () => {
    for (const filesystemType of [
      ...KNOWN_EPHEMERAL_FILESYSTEMS,
      ...KERNEL_VIRTUAL_FILESYSTEMS,
      ...UNSUPPORTED_SHARED_FILESYSTEMS,
    ]) {
      expect(absoluteFilesystemRefusal(filesystemType)).toBeDefined();
      expect(parseAttestedFilesystems(filesystemType).ok).toBe(false);
    }
    for (const filesystemType of KNOWN_PERSISTENT_FILESYSTEMS) {
      expect(absoluteFilesystemRefusal(filesystemType)).toBeUndefined();
    }
  });
});
