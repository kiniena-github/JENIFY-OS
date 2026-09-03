/**
 * Which mounted Linux filesystem may be attested as hosted JENIFY HQ durable
 * storage (Phase 2, Stage 3).
 *
 * Mount-boundary attestation proves that a volume really is mounted at the
 * configured durable root and that the opened root descriptor belongs to it. It
 * does NOT prove the mount survives workload replacement: `tmpfs`, `ramfs`, a
 * container overlay/ephemeral root and lifecycle-managed bind mounts are all
 * genuine mount boundaries whose contents can disappear on reboot or on the
 * next deploy. A gate that stops at "is a mount boundary" therefore accepts
 * storage that loses canonical HQ state, with every same-device/same-mount
 * cross-check still passing.
 *
 * There is no provider-neutral kernel bit named "durable". This module therefore
 * applies a conservative fail-closed policy to the provenance that Linux
 * `/proc/self/mountinfo` does expose:
 *
 * - known ephemeral / virtual / unsupported shared filesystems are refused;
 * - read-only filesystems are refused;
 * - a mount whose mount-root is not `/` is refused even when backed by ext4/xfs,
 *   because that is the kernel signature of a bind/subtree mount and does not
 *   establish whole-volume ownership at the configured durable root;
 * - only then may a supported local filesystem class be considered eligible.
 *
 * This deliberately prefers a false refusal over silently accepting a
 * lifecycle-managed `emptyDir`/bind mount as canonical HQ storage. A future
 * provider-specific or operator-provenance mechanism may widen that boundary,
 * but doing so is outside this Stage 3 provider-neutral correction.
 */

/**
 * Block-backed local filesystems permitted as hosted durable storage once the
 * mount itself also passes the whole-volume provenance checks below.
 */
export const KNOWN_PERSISTENT_FILESYSTEMS: readonly string[] = [
  'bcachefs',
  'btrfs',
  'ext2',
  'ext3',
  'ext4',
  'ext4dev',
  'f2fs',
  'jfs',
  'nilfs2',
  'reiser4',
  'reiserfs',
  'xfs',
  'zfs',
];

export const KNOWN_EPHEMERAL_FILESYSTEMS: readonly string[] = [
  'aufs',
  'cramfs',
  'devtmpfs',
  'erofs',
  'initramfs',
  'iso9660',
  'overlay',
  'overlayfs',
  'ramfs',
  'rootfs',
  'squashfs',
  'tmpfs',
  'zram',
];

export const KERNEL_VIRTUAL_FILESYSTEMS: readonly string[] = [
  'autofs',
  'binfmt_misc',
  'bpf',
  'cgroup',
  'cgroup2',
  'configfs',
  'debugfs',
  'devpts',
  'efivarfs',
  'fusectl',
  'hugetlbfs',
  'mqueue',
  'nsfs',
  'proc',
  'procfs',
  'pstore',
  'securityfs',
  'selinuxfs',
  'sysfs',
  'tracefs',
];

export const UNSUPPORTED_SHARED_FILESYSTEMS: readonly string[] = [
  '9p',
  'afs',
  'beegfs',
  'ceph',
  'cifs',
  'fuse',
  'fuseblk',
  'gfs2',
  'glusterfs',
  'lustre',
  'moosefs',
  'nfs',
  'nfs4',
  'ocfs2',
  's3ql',
  'smb2',
  'smb3',
  'smbfs',
  'virtiofs',
  'vboxsf',
];

const PERSISTENT = new Set(KNOWN_PERSISTENT_FILESYSTEMS);
const EPHEMERAL = new Set(KNOWN_EPHEMERAL_FILESYSTEMS);
const KERNEL_VIRTUAL = new Set(KERNEL_VIRTUAL_FILESYSTEMS);
const UNSUPPORTED_SHARED = new Set(UNSUPPORTED_SHARED_FILESYSTEMS);
const FILESYSTEM_TYPE_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;

export interface MountBoundary {
  /** mountinfo field 1: the kernel's mount identity for this mount. */
  mountId: number;
  /** mountinfo field 4, unescaped: root of this mount within its backing filesystem. */
  mountRoot: string;
  /** mountinfo field 5, unescaped: where the mount is attached. */
  mountPoint: string;
  /** First post-separator field, lowercased: the filesystem type. */
  filesystemType: string;
  /** Second post-separator field, unescaped: the mount source. */
  mountSource: string;
  /** mountinfo field 6: per-mount options. */
  mountOptions: readonly string[];
  /** Third post-separator field: filesystem-wide options. */
  superOptions: readonly string[];
}

export type DurableFilesystemRefusal =
  | 'unreadable'
  | 'ephemeral'
  | 'kernel-virtual'
  | 'unsupported-shared'
  | 'read-only'
  | 'lifecycle-managed'
  | 'unclassified';

export type DurableFilesystemVerdict =
  | { durable: true; basis: 'known-persistent' | 'operator-attested' }
  | { durable: false; refusal: DurableFilesystemRefusal; detail: string };

/** proc(5) octal-unescape for mountinfo pathname/source fields. */
export function decodeMountInfoField(field: string): string {
  return field.replace(/\\([0-3][0-7][0-7])/g, (_match, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

function splitOptions(field: string | undefined): readonly string[] {
  if (!field) return [];
  return field
    .split(',')
    .map((option) => option.trim())
    .filter((option) => option.length > 0);
}

/** Parse `/proc/self/mountinfo` without discarding provenance fields. */
export function parseMountInfo(content: string): MountBoundary[] {
  const boundaries: MountBoundary[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    const separator = fields.indexOf('-', 6);
    if (separator < 6 || fields.length < separator + 4) continue;

    const mountId = Number(fields[0]);
    const mountRoot = decodeMountInfoField(fields[3] ?? '');
    const mountPoint = decodeMountInfoField(fields[4] ?? '');
    const filesystemType = (fields[separator + 1] ?? '').toLowerCase();
    if (
      !Number.isSafeInteger(mountId) ||
      mountId < 0 ||
      !mountRoot ||
      !mountPoint ||
      !filesystemType
    ) {
      continue;
    }

    boundaries.push({
      mountId,
      mountRoot,
      mountPoint,
      filesystemType,
      mountSource: decodeMountInfoField(fields[separator + 2] ?? ''),
      mountOptions: splitOptions(fields[5]),
      superOptions: splitOptions(fields[separator + 3]),
    });
  }
  return boundaries;
}

function normalizeFilesystemType(raw: string): string {
  return raw.trim().toLowerCase();
}

function baseFilesystemType(type: string): string {
  const dot = type.indexOf('.');
  return dot === -1 ? type : type.slice(0, dot);
}

export function absoluteFilesystemRefusal(
  filesystemType: string,
): { refusal: DurableFilesystemRefusal; detail: string } | undefined {
  const type = normalizeFilesystemType(filesystemType);
  if (!type || !FILESYSTEM_TYPE_PATTERN.test(type)) {
    return {
      refusal: 'unreadable',
      detail: `"${filesystemType}" is not a readable filesystem type`,
    };
  }
  const base = baseFilesystemType(type);
  if (EPHEMERAL.has(type) || EPHEMERAL.has(base)) {
    return {
      refusal: 'ephemeral',
      detail: `${type} is a known ephemeral or read-only image filesystem; its contents do not survive reboot or workload replacement`,
    };
  }
  if (KERNEL_VIRTUAL.has(type) || KERNEL_VIRTUAL.has(base)) {
    return {
      refusal: 'kernel-virtual',
      detail: `${type} is a kernel virtual filesystem with no persistent storage behind it`,
    };
  }
  if (UNSUPPORTED_SHARED.has(type) || UNSUPPORTED_SHARED.has(base)) {
    return {
      refusal: 'unsupported-shared',
      detail: `${type} is a network, clustered, userspace or passthrough filesystem; Stage 3 does not assume it behaves like a local SQLite disk, and enabling one is a separate architecture decision rather than a configuration switch`,
    };
  }
  return undefined;
}

/**
 * Whether a mounted filesystem may hold hosted HQ canonical state.
 *
 * A supported backing filesystem is not sufficient evidence by itself. Linux
 * exposes the mount's `root` field: bind/subtree mounts have a non-`/` root and
 * may be lifecycle-managed even while backed by ext4/xfs. Stage 3 therefore
 * refuses them rather than treating the backing filesystem class as proof of
 * persistence.
 */
export function classifyDurableFilesystem(
  boundary: Pick<
    MountBoundary,
    'filesystemType' | 'mountRoot' | 'mountSource' | 'mountOptions' | 'superOptions'
  >,
  attested: readonly string[] = [],
): DurableFilesystemVerdict {
  const type = normalizeFilesystemType(boundary.filesystemType);
  const absolute = absoluteFilesystemRefusal(type);
  if (absolute) return { durable: false, ...absolute };

  if (boundary.mountOptions.includes('ro') || boundary.superOptions.includes('ro')) {
    return {
      durable: false,
      refusal: 'read-only',
      detail: `${type} is mounted read-only, so it cannot hold the canonical HQ database`,
    };
  }

  if (boundary.mountRoot !== '/') {
    return {
      durable: false,
      refusal: 'lifecycle-managed',
      detail:
        `${type} is mounted from backing-filesystem subtree ${JSON.stringify(boundary.mountRoot)} ` +
        `(source ${JSON.stringify(boundary.mountSource)}). A bind/subtree mount can be lifecycle-managed ` +
        'and disappear with the workload even when backed by ext4/xfs; Stage 3 requires a whole-filesystem mount at the durable root',
    };
  }

  if (PERSISTENT.has(type)) return { durable: true, basis: 'known-persistent' };
  if (attested.map(normalizeFilesystemType).includes(type)) {
    return { durable: true, basis: 'operator-attested' };
  }

  return {
    durable: false,
    refusal: 'unclassified',
    detail:
      `${type} is not a filesystem class Stage 3 recognizes as durable local storage. ` +
      'Hosted HQ refuses unknown filesystems instead of assuming they persist; an operator ' +
      'who knows this whole-filesystem mount is durable must attest its filesystem type explicitly with ' +
      'FACTORYOS_HQ_DURABLE_FS_ALLOW',
  };
}

export type AttestedFilesystemsResult =
  | { ok: true; values: readonly string[] }
  | { ok: false; detail: string };

export function parseAttestedFilesystems(raw: string | undefined): AttestedFilesystemsResult {
  const trimmed = raw?.trim();
  if (!trimmed) return { ok: true, values: [] };

  const values: string[] = [];
  for (const entry of trimmed.split(',')) {
    const type = normalizeFilesystemType(entry);
    if (!type) continue;
    if (!FILESYSTEM_TYPE_PATTERN.test(type)) {
      return {
        ok: false,
        detail: `FACTORYOS_HQ_DURABLE_FS_ALLOW entry "${entry.trim()}" is not a filesystem type; wildcards and blanket values are refused`,
      };
    }
    const absolute = absoluteFilesystemRefusal(type);
    if (absolute) {
      return {
        ok: false,
        detail: `FACTORYOS_HQ_DURABLE_FS_ALLOW cannot attest ${type} as durable: ${absolute.detail}`,
      };
    }
    if (!values.includes(type)) values.push(type);
  }
  return { ok: true, values };
}
