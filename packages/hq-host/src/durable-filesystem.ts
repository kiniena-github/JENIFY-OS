/**
 * Which mounted Linux filesystem may be attested as hosted JENIFY HQ durable
 * storage (Phase 2, Stage 3).
 *
 * Mount-boundary attestation proves that a volume really is mounted at the
 * configured durable root and that the opened root descriptor belongs to it. It
 * does NOT prove the mount survives workload replacement: `tmpfs`, `ramfs`, a
 * container overlay/ephemeral root and the kernel's virtual filesystems are all
 * genuine mount boundaries whose contents disappear on reboot or on the next
 * deploy. A gate that stops at "is a mount boundary" therefore accepts storage
 * that loses canonical HQ state, with every same-device/same-mount cross-check
 * still passing.
 *
 * There is no provider-neutral positive proof that a given mount is backed by
 * persistent media — the kernel does not expose durability, only filesystem
 * identity. So this is deliberately a CONSERVATIVE ALLOW/REFUSE policy over the
 * filesystem metadata `/proc/self/mountinfo` does expose:
 *
 * - a small allow-list of block-backed local filesystem classes that are the
 *   only ones Stage 3's single-process/single-writer SQLite topology has been
 *   reasoned about on;
 * - explicit refusal classes for filesystems that are known non-durable
 *   (ephemeral), known virtual (kernel), or persistent-but-not-supported here
 *   (network/clustered/FUSE/paravirtual passthrough, whose locking and fsync
 *   semantics are a separate architecture decision — see the Stage 3 doc);
 * - refusal of everything else as UNCLASSIFIED, because "unknown" must never
 *   read as "durable".
 *
 * The only widening is a narrow operator attestation
 * (`FACTORYOS_HQ_DURABLE_FS_ALLOW`) that can move an *unclassified* filesystem
 * type into the allowed set. It can never re-classify a known-ephemeral, a
 * kernel-virtual or an unsupported shared/indirect filesystem: those refusals
 * are absolute, so the default cannot be silently weakened by configuration.
 *
 * This inspects kernel mount information only. It names no cloud/provider
 * service and selects no vendor.
 */

/**
 * Block-backed local filesystems permitted as hosted durable storage.
 *
 * Journaling/CoW POSIX filesystems on a real device, i.e. the class Stage 3's
 * WAL + `synchronous=FULL` SQLite durability argument was made against. FAT and
 * NTFS families are intentionally absent: no reliable POSIX ownership/locking
 * semantics for a live SQLite writer.
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

/**
 * Filesystems whose contents are lifecycle-managed and lost on reboot or
 * workload replacement, plus read-only image filesystems that can never hold a
 * writable canonical database. Never attestable, by configuration or otherwise.
 */
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

/**
 * Kernel virtual filesystems. Mount boundaries with no persistent storage
 * behind them at all. Never attestable.
 */
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

/**
 * Filesystems that may well be persistent but are NOT supported as Stage 3 HQ
 * storage: network/clustered/userspace/paravirtual passthrough mounts whose
 * locking, caching and fsync semantics differ from a local SQLite disk. The
 * Stage 3 doc already refuses to assume a network filesystem behaves like one,
 * so these are refused here rather than silently attested — and they are not
 * operator-attestable either: enabling one is an architecture decision with its
 * own review, not an environment variable.
 */
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

/** A filesystem type as it may appear in mountinfo, e.g. `ext4`, `fuse.sshfs`. */
const FILESYSTEM_TYPE_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;

export interface MountBoundary {
  /** mountinfo field 1: the kernel's mount identity for this mount. */
  mountId: number;
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
  | 'unclassified';

export type DurableFilesystemVerdict =
  | { durable: true; basis: 'known-persistent' | 'operator-attested' }
  | { durable: false; refusal: DurableFilesystemRefusal; detail: string };

/**
 * proc(5) escapes space, tab, newline and backslash in the root, mount-point
 * and mount-source fields as octal sequences. Decode them so a mount point with
 * a space still compares equal to the resolved durable root.
 */
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

/**
 * Parse `/proc/self/mountinfo`.
 *
 * Fields 1-6 are positional; then come a variable number of optional
 * `tag[:value]` fields, a literal `-` separator, and finally the filesystem
 * type, the mount source and the super options. The earlier version of this
 * parser read only fields 1 and 5 and discarded everything after the separator,
 * which is exactly why an ephemeral filesystem could satisfy the durable-root
 * gate. Lines whose post-separator section is missing or truncated are dropped
 * rather than guessed at: an entry we cannot read fully must not be able to
 * attest anything.
 */
export function parseMountInfo(content: string): MountBoundary[] {
  const boundaries: MountBoundary[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    const fields = line.split(' ');
    // Optional fields begin at index 6 and are never exactly "-"; the mount
    // root (index 3) and mount point (index 4) are absolute paths, so the first
    // "-" at or after index 6 is the separator.
    const separator = fields.indexOf('-', 6);
    // Filesystem type, mount source AND super options must all be present: a
    // truncated entry cannot be evaluated for durability, so it is not allowed
    // to attest anything.
    if (separator < 6 || fields.length < separator + 4) continue;

    const mountId = Number(fields[0]);
    const mountPoint = decodeMountInfoField(fields[4] ?? '');
    const filesystemType = (fields[separator + 1] ?? '').toLowerCase();
    if (!Number.isSafeInteger(mountId) || mountId < 0 || !mountPoint || !filesystemType) continue;

    boundaries.push({
      mountId,
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

/** `fuse.sshfs` and friends are classified by their `fuse` base type. */
function baseFilesystemType(type: string): string {
  const dot = type.indexOf('.');
  return dot === -1 ? type : type.slice(0, dot);
}

/**
 * Why a filesystem type can never be attested as durable, or `undefined` if the
 * type carries no absolute refusal. Shared by classification and by validation
 * of the operator allow-list, so the two can never disagree about what is
 * refusable.
 */
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
 * `attested` is the operator allow-list. It can only promote an UNCLASSIFIED
 * filesystem type; every absolute refusal above outranks it.
 */
export function classifyDurableFilesystem(
  boundary: Pick<MountBoundary, 'filesystemType' | 'mountOptions' | 'superOptions'>,
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
      'who knows this mount is durable must attest it explicitly with ' +
      'FACTORYOS_HQ_DURABLE_FS_ALLOW',
  };
}

export type AttestedFilesystemsResult =
  | { ok: true; values: readonly string[] }
  | { ok: false; detail: string };

/**
 * Parse `FACTORYOS_HQ_DURABLE_FS_ALLOW`: a comma-separated list of filesystem
 * types the operator attests as durable.
 *
 * Fails closed on anything it cannot read as a narrow, reviewable widening:
 * wildcards and malformed types are refused, and so is any attempt to name a
 * known-ephemeral, kernel-virtual or unsupported shared filesystem — that would
 * silently weaken the default gate, which is the one thing this override must
 * not be able to do.
 */
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
