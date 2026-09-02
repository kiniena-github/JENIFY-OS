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

Hosted boot fails closed when:

- persistence is not explicitly `durable-volume`;
- the durable root is missing;
- the durable root is relative;
- the database path is relative;
- the database resolves outside the durable root;
- the database parent resolves outside the durable root through a symlink;
- `:memory:` is requested;
- the OS temporary tree is claimed as durable storage;
- SQLite cannot open or pass `PRAGMA quick_check`.

The durable root is never auto-created. If the configured mount is absent, HQ stays off instead of creating an ordinary container directory and pretending it is durable.

## Durability and concurrency

`@factoryos/hq-host` owns the persistence boundary. The HQ core still receives the same `HqDatabase`, so existing application transactions and invariants are unchanged.

Durable-volume mode applies:

- WAL journal mode;
- full synchronous durability;
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
5. rename it to the final backup filename only after verification.

A failed/partial backup is removed rather than presented as recoverable evidence.

## Recovery

Recovery deliberately refuses to overwrite an existing HQ database.

`restoreHqBackupToNewFile`:

1. verifies the source backup read-only;
2. copies it only to a path that does not exist;
3. verifies the restored copy;
4. removes the copy if verification fails.

Switching a live deployment from its current database to a restored database is a separate operator/Founder-controlled action. The recovery helper is therefore useful without becoming a destructive production button.

## Evidence required for Stage 3 acceptance

- hosted mode refuses ephemeral/local-file storage;
- canonical HQ rows survive close/reopen;
- idempotency uniqueness survives restart;
- lease/fence/claim state survives restart;
- online backup is integrity checked;
- recovery works only to a new file and refuses overwrite;
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
