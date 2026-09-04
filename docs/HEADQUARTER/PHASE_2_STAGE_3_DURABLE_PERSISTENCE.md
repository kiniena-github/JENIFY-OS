# JENIFY HQ — Phase 2 Stage 3 Durable Persistence

Status: implementation candidate for issue #227. Provider-neutral only; no hosting purchase, production credential, DNS, or production migration is authorized by this document.

## Decision for Stage 3

Keep the proven synchronous SQLite HQ store and put it behind an explicit host persistence boundary.

Hosted Stage 3 topology is:

- one long-lived HQ process;
- one SQLite database;
- WAL mode;
- `synchronous=FULL` in durable-volume mode;
- one provider-mounted durable filesystem volume;
- one opened-inode attestation step before hosted control is allowed;
- no serverless/ephemeral filesystem;
- no horizontal/multi-writer replicas in this stage.

Why: the existing HQ authority/application/store code relies deeply on synchronous SQLite transactions, uniqueness, leases and fencing. Replacing the database engine at the same time as separating/hosting HQ would change too many correctness properties together. A durable mounted volume preserves the already-reviewed semantics while removing dependence on the Founder workstation.

This does **not** choose a vendor. Fly/Render/Railway/another suitable host can be evaluated later at the Founder provider gate. The code contains no provider name or credential.

## Stage 3 security / writer boundary

Stage 3 is deliberately a **single-process / single-writer** persistence architecture. Its durability and race guarantees cover the canonical HQ process, normal filesystem/path substitution races, crashes, retries, and concurrent API/browser activity inside that one process.

Stage 3 does **not** claim to remain safe if an arbitrary second process running with the same OS permissions is allowed raw write access to the live database, backup partial inode, or recovery source inode while SQLite integrity verification is in progress. Such a process can perform an A→B→A in-place rewrite around `PRAGMA quick_check`; inode identity and endpoint hashes cannot prove which intermediate bytes SQLite inspected. Pretending otherwise would overstate the security model.

Accordingly, a Hosted HQ provider may only be accepted later if its runtime enforces the declared topology operationally: one HQ writer process/replica, a private durable volume, and no unrelated same-identity process with raw write access to HQ persistence files. Horizontal replicas, sidecars or maintenance processes that can mutate those files are outside Stage 3 and require a separate architecture/security review before they are enabled.

The existing descriptor, inode, mount, hash and publication checks remain as defense in depth. They detect pathname substitution and ordinary in-place changes, but they are **not** represented as an immutable-snapshot primitive against a malicious same-permission raw writer. If Jenify later requires that stronger threat model, Stage 3 must be upgraded to a kernel-backed immutable snapshot/sealing primitive or a storage architecture that provides equivalent transactional isolation before making that claim.

This is a clarification of the already-declared single-writer topology, not permission to weaken Founder gates or run multiple writers.

## Environment contract

Existing local mode remains compatible:

```text
FACTORYOS_HQ_CONTROL=1
FACTORYOS_HQ_DB=/path/to/hq.sqlite
```

Local runtime defaults to `local-file` persistence.

A hosted process must explicitly declare:

```text
FACTORYOS_HQ_CONTROL=1
FACTORYOS_HQ_RUNTIME=hosted
FACTORYOS_HQ_PERSISTENCE=durable-volume
FACTORYOS_HQ_DURABLE_ROOT=/mounted/durable-volume
FACTORYOS_HQ_DB=/mounted/durable-volume/hq.sqlite
FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE=operator:<stable-volume-id>
```

All six are mandatory. `FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE` is the operator's
or provider's explicit assertion that the volume mounted at the durable root is a
*named, persistent* volume that survives workload replacement — the one durability
fact the kernel cannot supply. Mount metadata proves mount identity and filesystem
class, but an ephemeral cloud instance-store or a lifecycle-scoped CSI volume
presents as the same ext4/xfs class as a durable block volume, so filesystem type
alone is not durability provenance. Accepted forms:

```text
FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE=operator:<stable-volume-id>
FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE=provider:<stable-volume-id>
```

Use `operator:` when a human operator attests the volume, `provider:` when the
hosting platform's own stable volume identifier is used. The identifier must be
3–128 characters of `A-Z a-z 0-9 . _ : / -`, starting alphanumeric, and should be
the volume's stable identity (for example `operator:jenify-hq-volume-01` or
`provider:vol-0a1b2c3d4e5f`) so the attestation stays reviewable and points at one
specific volume across restarts. It is **not a secret and not a credential**: it
names a volume, grants no access, and is printed to the boot log as reviewable
evidence — never put a token, key or connection string in it. The value is
provider-neutral and selects no vendor. Hosted boot fails closed when it is
missing, malformed, or carries an unrecognized prefix. It is unused in local-file
mode.

Optional:

```text
FACTORYOS_HQ_BACKUP_DIR=/mounted/durable-volume/backups
FACTORYOS_HQ_DURABLE_FS_ALLOW=<comma-separated filesystem types>
```

`FACTORYOS_HQ_DURABLE_FS_ALLOW` is a narrow operator override for the durable
filesystem-class gate (see *Durable mount attestation* below). It can only
promote an otherwise-**unclassified** filesystem type into the allowed set; it
can never attest a known-ephemeral (`tmpfs`, `ramfs`, overlay, …), kernel-virtual,
or unsupported network/clustered/FUSE/passthrough filesystem, and a malformed or
wildcard value fails the boot closed. When set, the attested types are printed to
the boot log so the widening is always reviewable. It is unused in local-file
mode.

The hosted database file itself must be pre-created as a **regular file** on the mounted durable volume before HQ starts. Stage 3 deliberately does not create a missing hosted DB through a pathname that could be swapped during startup. Final-component DB symlinks are refused even when they currently resolve inside the durable root.

Hosted Stage 3 currently requires Linux `/proc/self/fd` so the process can bind SQLite's first writable/migrating connection to the already-open durable inode and then prove that SQLite itself holds that same inode. This is an OS-level safety gate, not a cloud-vendor choice. Local/workstation mode does not depend on procfs and remains portable.

Hosted boot fails closed when:

- persistence is not explicitly `durable-volume`;
- `FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE` is missing or malformed — no
  `operator:`/`provider:` prefix, or no stable volume identifier after it (see
  *Environment contract* above);
- the durable root is missing;
- the configured durable root is not itself a mounted-volume boundary — an
  ordinary directory of the same name, present in the image/container but with
  no volume mounted at it, is refused (see *Durable mount attestation* below);
- the volume mounted at the durable root is on a non-persistent filesystem —
  `tmpfs`, `ramfs`, a container overlay/ephemeral root, a kernel-virtual
  filesystem, or a read-only image filesystem is refused even though it is a
  genuine mount boundary; an unrecognized filesystem is also refused unless the
  operator attests it via `FACTORYOS_HQ_DURABLE_FS_ALLOW` (see *Durable mount
  attestation* below);
- the durable root is relative;
- the database path is relative;
- the database file is missing instead of pre-created;
- the final database path is a symlink;
- the database resolves outside the durable root;
- the database parent resolves outside the durable root through a symlink;
- the database pathname changes while SQLite is starting;
- the inode SQLite actually opens cannot be proven to match the anchored durable inode;
- SQLite initialization opens a regular file outside the durable root;
- Linux procfs descriptor attestation is unavailable in hosted mode;
- `:memory:` is requested;
- the OS temporary tree is claimed as durable storage;
- SQLite cannot enter effective WAL + `synchronous=FULL` mode;
- SQLite cannot open or pass `PRAGMA quick_check`.

In hosted durable-volume mode the durability modes are established and verified,
and the opened inode attested, **before** any schema-creating or migrating
transaction runs. `openHqDatabase` is a migrating open, so the hosted path uses
the split `connectHqDatabaseUnmigrated` + `migrateHqDatabase` pair instead: first
boot and every later migration commit under proven WAL + `synchronous=FULL`
rather than under whatever `synchronous` the SQLite build happens to default to,
and a boot refused by any earlier gate writes no schema to the volume at all.

The durable root is never auto-created. If the configured mount is absent, HQ stays off instead of creating an ordinary container directory and pretending it is durable.

## Opened-inode attestation

Path checks alone are not enough because another process could replace a filename or parent component between a pre-check and SQLite's open. A check performed only after a normal pathname-based SQLite open is also too late, because that open may already have enabled WAL, executed DDL, or applied migrations to the wrong file.

Hosted Stage 3 therefore:

1. opens the already-existing DB with `O_NOFOLLOW` and holds that file descriptor as an anchor;
2. resolves that **descriptor** through `/proc/self/fd` and verifies its inode is inside the durable root;
3. snapshots the process file-descriptor table;
4. opens SQLite through `/proc/self/fd/<anchor-fd>`, so the **first writable/migrating connection** is bound to the already-proven inode before WAL setup, DDL, or schema upgrades can write;
5. enables and reads back the required durable modes;
6. verifies the configured pathname still names the anchored inode;
7. diffs the descriptor table and requires SQLite to hold a newly opened descriptor for the same anchored DB inode;
8. requires every regular file opened during that synchronous SQLite initialization, including WAL/SHM sidecars when present, to resolve inside the durable root;
9. only then releases the anchor and allows HQ to continue booting.

If the configured pathname is swapped after the anchor is acquired, startup still fails, but any initialization writes that occur before that refusal remain bound to the anchored durable inode rather than following the hostile replacement.

This binds both the first mutation and the final safety decision to the file SQLite actually opened rather than to a pathname that can be swapped and swapped back.

## Durable mount attestation

Proving that the database and backups share the durable root's filesystem is not
enough on its own: it cannot tell a mounted durable volume apart from a plain
directory baked into the image at the same path. If the expected volume were
absent but the mount-point directory existed, HQ could otherwise boot on
ephemeral storage and later lose canonical state.

Hosted durable mode therefore reads the kernel's own mount table
(`/proc/self/mountinfo`) and requires an entry mounted **exactly at the
configured durable root**, whose mount identity matches the opened root
descriptor. No such entry exists for an ordinary directory, so hosted HQ stays
off instead of running on ephemeral storage. This is provider-neutral — it
inspects kernel mount information, never a cloud/provider service — and the
configured root must be the mount point itself, not a subdirectory of a mount.
Local/workstation mode does not perform mount attestation and stays portable.

**Being a mount boundary is necessary but not sufficient.** `tmpfs`, `ramfs`, a
container overlay/ephemeral root and the kernel's virtual filesystems are all
genuine mount boundaries whose contents disappear on reboot or on the next
workload replacement — and each has a real mount identity, so it passes every
same-device/same-mount cross-check. A gate that stopped at "is a mount boundary"
would let canonical HQ state boot onto storage that later evaporates. The mount
table also carries the filesystem type and source of each entry; the earlier
parser discarded everything after the mountinfo `-` separator, which is exactly
what left that hole open.

Hosted durable mode therefore also evaluates the attested entry's filesystem
class, under a deliberately **conservative allow/refuse policy** (there is no
provider-neutral positive proof that a mount is backed by persistent media — the
kernel exposes filesystem identity, not durability):

- a small allow-list of block-backed local POSIX filesystems (ext2/3/4, xfs,
  btrfs, zfs, f2fs, …) — the class Stage 3's WAL + `synchronous=FULL` SQLite
  durability argument was reasoned about;
- absolute refusal of known-ephemeral filesystems (`tmpfs`, `ramfs`, overlay,
  squashfs, zram, …), kernel-virtual filesystems (proc, sysfs, cgroup, …), and
  network/clustered/FUSE/paravirtual passthrough filesystems (nfs, cifs, ceph,
  9p, virtiofs, fuse.*, …) whose locking/fsync semantics are a separate
  architecture decision, and of any read-only mount;
- refusal of everything else as **unclassified** — "unknown" must never read as
  "durable".

The only widening is `FACTORYOS_HQ_DURABLE_FS_ALLOW`, a narrow operator
attestation that can move an *unclassified* filesystem type into the allowed set.
It can never re-classify a known-ephemeral, kernel-virtual or unsupported shared
filesystem — those refusals outrank it — so the default gate cannot be silently
weakened by configuration; a wildcard or malformed value fails closed, and any
attested types are printed to the boot log. This is not a vendor/provider
selection; it is an OS-level operator statement about a mount the operator
controls.

## Durability and concurrency

`@factoryos/hq-host` owns the persistence boundary. The HQ core still receives the same `HqDatabase`, so existing application transactions and invariants are unchanged.

Durable-volume mode applies:

- WAL journal mode and read-back verification that effective mode is really `wal`;
- full synchronous durability and read-back verification that effective value is really `FULL`;
- 5 second SQLite busy timeout;
- WAL autocheckpointing;
- best-effort checkpoint on graceful host close.

Stage 3 is intentionally **single-process / single-writer topology**. Multiple browser/API requests are supported by the one canonical HQ process. Horizontal replicas are not silently enabled; if HQ later needs them, that becomes a separate architecture decision and test gate rather than assuming a network filesystem behaves like a local SQLite disk.

## Backup

The persistence adapter provides an online SQLite backup operation:

1. checkpoint best-effort;
2. **reserve the partial inode first** with `O_CREAT|O_EXCL|O_RDWR` and keep the descriptor;
3. run the SQLite online backup **through that descriptor** (`/proc/self/fd/<fd>` on Linux), so the object SQLite writes is the reserved inode and no substitutable pathname is exposed while the backup runs;
4. re-prove that the partial pathname still names the reserved inode, that the opened object did not change, and that SQLite actually wrote it;
5. take a SHA-256 proof of the bytes through the retained descriptor before the integrity check;
6. open the reserved descriptor read-only and run `PRAGMA quick_check`;
7. re-prove the bytes after the check and require an identical proof, then re-prove the pathname identity;
8. `fsync` the reserved inode and publish it with an atomic no-replace hard-link operation;
9. re-prove the published bytes against the pinned proof before reporting success; if they differ, withdraw the published name and `fsync` the directory so the withdrawal is itself durable;
10. commit the directory entry (attested backup-directory descriptor in hosted mode, parent-directory `fsync` in local-file mode).

Recursive creation of the backup directory adds a new directory link into the
durable root (and into any intermediate components). fsyncing the backup
directory alone commits the files inside it but not those links, so a crash
after a reported-successful backup could lose the whole directory and the
recovery point with it.

Every successful backup therefore recommits the parent-directory chain, whether
or not this invocation created it. Keying the commit off "did THIS invocation's
`mkdir` create it" was not enough: an earlier backup can create the hierarchy
and then crash or fail before its parent-link `fsync` completes, after which
every later invocation sees the directories already present, records nothing as
newly created, and commits only the backup directory.

The chain runs from the backup directory's own parent up to an anchor this
process never creates, so the work stays bounded:

- **durable-volume mode** — the anchor is `FACTORYOS_HQ_DURABLE_ROOT`, whose own
  link belongs to the mount. The chain is therefore bounded to the configured
  backup path and never climbs above the attested volume. Any failure in the
  chain fails the backup closed.
- **local-file mode** — there is no attested volume boundary, so the anchor is
  the filesystem root, capped at 32 components. The backup directory's own
  parent is still required; ancestors above it are best-effort, because a
  workstation path can climb into system directories the process may traverse
  but not open for reading.

Like every directory `fsync` here this is POSIX-only, preserving the portable
local/workstation contract.

Verification and publication are bound to the exact inode the backup wrote, not to whatever a pathname happens to resolve to afterwards. A partial substituted at any point around `db.backup()` is refused rather than published, and an unproven pathname is never deleted on the caller's behalf.

**Rollback is scoped to this invocation's own entry.** What a publication
attempt actually published is established from the retained partial descriptor's
link count across the hard link — never from a stat read back from the
destination pathname, which is exactly the read another actor can poison. If the
destination has been replaced between the link and the identity check, the
comparison fails, the backup fails closed, and the replacement is preserved
untouched: this invocation never unlinks a file it did not create. The distinct
case where the link SOURCE was substituted, so our own link attached an inode we
never verified, is still withdrawn — unverified bytes must not survive under the
final backup name — but only while the entry is provably the extra hard link we
added (not our verified inode, still the inode the source names, still multiply
linked), so the substituted file keeps its own name and its data.

Within the declared single-writer topology, the before/after content proofs detect ordinary in-place mutation during verification. They do **not** make the inode immutable and do not close an adversarial A→B→A rewrite performed by an unauthorized same-permission raw writer. Such a writer is outside the Stage 3 threat boundary defined above.

A concurrent backup using the same final name cannot replace an existing verified recovery point. A failed/partial backup is removed rather than presented as recoverable evidence.

## Recovery

Recovery deliberately refuses to overwrite an existing HQ database.

`restoreHqBackupToNewFile`:

1. opens the source with `O_NOFOLLOW` and retains the descriptor;
2. pins a SHA-256 content proof around read-only `PRAGMA quick_check` as defense in depth within the single-writer topology;
3. copies only to a path that does not exist, using exclusive creation, and records the exact inode created by that invocation;
4. requires the copied bytes, the source re-read after the copy, and the destination read back afterwards to reproduce the pinned proof;
5. verifies the restored copy read-only and re-proves the destination inode identity;
6. `fsync`s the restored inode and then the destination **parent directory**, so the new directory entry is durably committed before success is reported;
7. re-proves the destination contents against the pinned state as the last act before returning;
8. removes a failed copy only when the destination still names that exact created inode, and `fsync`s the parent directory after doing so.

Retaining descriptors closes pathname substitution. Content proofs detect normal mutation and accidental interference, but—by explicit Stage 3 design—are not claimed to provide immutable-snapshot security against an arbitrary same-permission raw writer executing an ABA rewrite around integrity verification.

**Platform note.** The directory `fsync` is a POSIX operation. Windows exposes no directory handle to `fsync` through Node and commits directory metadata with the file, so the child-identity proof runs on every platform while the `fsync` itself is skipped there — requiring it would break the documented portable local/workstation backup and recovery contract rather than strengthen it. Hosted durable mode is Linux-only and always performs it.

If another process wins a race to create or replace the destination, its file is never deleted by the recovery helper.

Switching a live deployment from its current database to a restored database is a separate operator/Founder-controlled action. The recovery helper is therefore useful without becoming a destructive production button.

## Evidence required for Stage 3 acceptance

- hosted mode refuses ephemeral/local-file storage;
- hosted mode refuses an ordinary directory masquerading as the durable root when no volume is mounted there, and accepts a correctly attested mount;
- hosted mode refuses an ephemeral filesystem (`tmpfs`/overlay/…) mounted exactly at the durable root even when its mount identity matches, refuses read-only and unclassified filesystems, and accepts a permitted persistent filesystem; the operator attestation widens only the unclassified case and can never attest a known-ephemeral/virtual/unsupported filesystem;
- hosted mode refuses missing/symlink DB entries and requires opened-inode attestation;
- a first backup into a newly created backup directory durably commits the new directory link before success, and so does a later backup into a pre-existing directory whose link was never committed (including a retry after the creating invocation failed), with the recommitted chain bounded to the configured backup path and never climbing above the attested durable root;
- a destination replaced between publication and the identity check is detected, the replacement is preserved rather than unlinked, and the invocation's own published inode is still withdrawn when rejection requires it;
- a path swap after descriptor anchoring cannot redirect DDL/migrations/WAL writes to the replacement target;
- canonical HQ rows survive close/reopen;
- idempotency uniqueness survives restart;
- lease/fence/claim state survives restart;
- effective WAL/FULL durability is read back and verified;
- online backup is integrity checked and no-replace under supported single-writer operation;
- backup verification/publication stay bound to the pre-reserved inode SQLite wrote;
- ordinary in-place changes observed across verification are refused;
- a rejected backup publication and a rejected restore are both withdrawn durably;
- an in-place rewrite of the recovery destination after its content proof is refused before success is reported;
- local-file backup and recovery still work on platforms without directory `fsync`;
- recovery works only to a new file, refuses overwrite, and preserves concurrently created destinations;
- successful recovery `fsync`s the destination parent directory before returning;
- the accepted provider/runtime later enforces the declared one-process/one-writer operational boundary and does not grant unrelated same-identity processes raw write access to HQ persistence files;
- standalone HQ process reopens the same canonical state after a full close;
- full HQ/server/HQ-host/HQ-server tests and relevant typechecks/build pass;
- exact-head CI passes;
- fresh independent Codex review finds no material issue.

The acceptance claim explicitly excludes adversarial same-permission A→B→A mutation during SQLite verification. Supporting that stronger attacker model would require immutable snapshot/sealing or an equivalent storage architecture and a new security review.

## What Stage 3 does not do

- no paid hosting purchase;
- no production deployment;
- no production database migration;
- no production secret creation;
- no DNS/custom domain;
- no Postgres/libSQL/cloud-DB choice;
- no horizontal replica promise;
- no hostile same-permission raw-writer / immutable-snapshot guarantee;
- no Phase 3 UI/3D implementation.

Those remain later gates or later phases.
