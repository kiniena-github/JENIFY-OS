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
```

Optional:

```text
FACTORYOS_HQ_BACKUP_DIR=/mounted/durable-volume/backups
```

The hosted database file itself must be pre-created as a **regular file** on the mounted durable volume before HQ starts. Stage 3 deliberately does not create a missing hosted DB through a pathname that could be swapped during startup. Final-component DB symlinks are refused even when they currently resolve inside the durable root.

Hosted Stage 3 currently requires Linux `/proc/self/fd` so the process can bind SQLite's first writable/migrating connection to the already-open durable inode and then prove that SQLite itself holds that same inode. This is an OS-level safety gate, not a cloud-vendor choice. Local/workstation mode does not depend on procfs and remains portable.

Hosted boot fails closed when:

- persistence is not explicitly `durable-volume`;
- the durable root is missing;
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

Verification and publication are bound to the exact inode the backup wrote, not to whatever a pathname happens to resolve to afterwards. A partial substituted at any point around `db.backup()` is refused rather than published, and an unproven pathname is never deleted on the caller's behalf.

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
- hosted mode refuses missing/symlink DB entries and requires opened-inode attestation;
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
