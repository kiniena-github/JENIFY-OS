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

Hosted Stage 3 currently requires Linux `/proc/self/fd` so the process can prove that the inode SQLite actually opened is the same inode that was anchored and verified inside the durable volume. This is an OS-level safety gate, not a cloud-vendor choice. Local/workstation mode does not depend on procfs and remains portable.

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

Path checks alone are not enough because another process could replace a filename or parent component between a pre-check and SQLite's open.

Hosted Stage 3 therefore:

1. opens the already-existing DB with `O_NOFOLLOW` and holds that file descriptor as an anchor;
2. resolves that **descriptor** through `/proc/self/fd` and verifies its inode is inside the durable root;
3. snapshots the process file-descriptor table;
4. opens SQLite and enables the required durable modes;
5. verifies the configured pathname still names the anchored inode;
6. diffs the descriptor table and requires SQLite to hold a newly opened descriptor for the same anchored DB inode;
7. requires every regular file opened during that synchronous SQLite initialization, including WAL/SHM sidecars when present, to resolve inside the durable root;
8. only then releases the anchor and allows HQ to continue booting.

This binds the safety decision to the file SQLite actually opened rather than to a pathname that can be swapped and swapped back.

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
2. SQLite online backup to a unique partial file;
3. open the result read-only;
4. run `PRAGMA quick_check`;
5. publish the verified backup with an atomic no-replace hard-link operation.

A concurrent backup using the same final name cannot replace an existing verified recovery point. A failed/partial backup is removed rather than presented as recoverable evidence.

## Recovery

Recovery deliberately refuses to overwrite an existing HQ database.

`restoreHqBackupToNewFile`:

1. verifies the source backup read-only;
2. copies it only to a path that does not exist using exclusive creation;
3. records the exact inode created by that invocation;
4. verifies the restored copy;
5. removes a failed copy only when the destination still names that exact created inode.

If another process wins a race to create or replace the destination, its file is never deleted by the recovery helper.

Switching a live deployment from its current database to a restored database is a separate operator/Founder-controlled action. The recovery helper is therefore useful without becoming a destructive production button.

## Evidence required for Stage 3 acceptance

- hosted mode refuses ephemeral/local-file storage;
- hosted mode refuses missing/symlink DB entries and requires opened-inode attestation;
- canonical HQ rows survive close/reopen;
- idempotency uniqueness survives restart;
- lease/fence/claim state survives restart;
- effective WAL/FULL durability is read back and verified;
- online backup is integrity checked and no-replace under races;
- recovery works only to a new file, refuses overwrite, and preserves concurrently created destinations;
- standalone HQ process reopens the same canonical state after a full close;
- full HQ/server/HQ-host/HQ-server tests and relevant typechecks/build pass;
- exact-head CI passes;
- fresh independent Codex review finds no material issue.

## What Stage 3 does not do

- no paid hosting purchase;
- no production deployment;
- no production database migration;
- no production secret creation;
- no DNS/custom domain;
- no Postgres/libSQL/cloud-DB choice;
- no horizontal replica promise;
- no Phase 3 UI/3D implementation.

Those remain later gates or later phases.
