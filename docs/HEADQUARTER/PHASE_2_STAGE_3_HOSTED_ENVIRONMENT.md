# JENIFY HQ — Phase 2 Stage 3 Hosted Environment Contract

This file is the normative hosted environment contract for the Stage 3 durable-persistence candidate under issue #227. It supplements `PHASE_2_STAGE_3_DURABLE_PERSISTENCE.md` and does not authorize a hosting provider, paid service, production deployment, DNS change, credential creation, or production migration.

A hosted process must explicitly declare all of the following:

```text
FACTORYOS_HQ_CONTROL=1
FACTORYOS_HQ_RUNTIME=hosted
FACTORYOS_HQ_PERSISTENCE=durable-volume
FACTORYOS_HQ_DURABLE_ROOT=/mounted/durable-volume
FACTORYOS_HQ_DB=/mounted/durable-volume/hq.sqlite
FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE=operator:<stable-volume-id>
```

`FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE` is **mandatory** in hosted durable-volume mode. Its accepted provider-neutral forms are:

```text
operator:<stable-volume-id>
provider:<stable-volume-id>
```

The `<stable-volume-id>` must identify the specific durable volume expected to survive workload replacement. It is an operator/provider attestation value, **not a secret**, and must not contain credentials, API keys, tokens, passwords, or connection strings. A missing, empty, malformed, or unsupported provenance value fails hosted startup closed.

Using the `provider:` form records provenance only; it does not select, activate, purchase, or approve any provider. Provider selection and production activation remain separate Founder gates.

Optional hosted settings remain:

```text
FACTORYOS_HQ_BACKUP_DIR=/mounted/durable-volume/backups
FACTORYOS_HQ_DURABLE_FS_ALLOW=<comma-separated filesystem types>
```

The filesystem-type override is not a substitute for `FACTORYOS_HQ_DURABLE_VOLUME_PROVENANCE`. Both the kernel/filesystem durability checks and the stable-volume provenance gate must pass.

Local/workstation mode remains unchanged and does not require the hosted provenance variable.
