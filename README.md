# FactoryOS

A configurable, offline-capable manufacturing operations platform.
One maintainable codebase; each factory is an isolated, branded tenant.

**Mesob Salt Factory** (Mekelle, Tigray) is the first configured factory.

## How to run it (local, no internet required after install)

Open a terminal in this folder and run:

```
npm install          # first time only (needs internet once)
npm run seed:mesob   # first time only — creates the Mesob factory + logins
npm run dev          # starts the system
```

Then open **http://localhost:5173** in your browser.

Sign in with the accounts listed in `data/mesob-logins.txt`
(created by the seed — keep that file private). The `owner` account
sees everything; the other five accounts show what each role sees.

To start over with a clean factory: stop the system, delete
`data/factoryos.sqlite*`, and run `npm run seed:mesob` again.

## Suggested first walkthrough (as owner)

1. **Raw Salt Receiving** — receive 10 ton from Afdera Salt Supplier into
   Warehouse A, Save & approve. Stock appears in **Inventory** as batch RAW-0001.
2. **Inventory → Warehouse Transfers** — move 5,000 kg from A to B.
3. **Production → Washing** — consume 5,000 kg from RAW-0001, output 4,600 kg
   (loss is calculated automatically).
4. **Production → Iodization & Quality Test** — consume the washing batch,
   record iodine added, complete, then record a test result. Try a **Failed**
   result first: packaging is blocked until a passed result is approved.
5. **Production → Packaging** — convert approved iodized salt into 1kg packs.
   Good packs appear in **Inventory → Finished Products**.
6. **Settings → Prices & VAT** — enter your prices before selling.
7. **Customers** — add a customer with a credit limit.
8. **Sales / Invoices** — sell packs; confirming reserves stock.
9. **Deliveries** — dispatch (stock leaves the warehouse) and mark delivered.
10. **Payments** — record money; one payment can settle several invoices.
11. **Reports** and the **Dashboard** reconcile with everything you did.
12. Switch the language (top right) — Tigrinya shows the Tigray flag; labels
    are editable under **Settings → Languages & Translations**.

## Tests

```
npm test
```

runs the business-rule suites: tenant isolation, permissions and financial
visibility, stock-ledger identities, reservations, unit conversions, batch
genealogy, QC gates, reversals, payment allocations, report reconciliation,
and a full end-to-end workflow over the real HTTP API.

## Architecture (for developers)

npm workspaces monorepo:

| Package | Contents |
|---|---|
| `packages/shared` | Platform vocabulary: permission model, statuses, unit helpers |
| `packages/server` | Fastify API + SQLite (Drizzle) + all business services |
| `packages/web` | React UI shell and screens (tenant-configurable labels/branding) |
| `packages/config-mesob` | **Everything Mesob-specific**: seed, roles, items, stages, brand assets |

Core rules the platform enforces everywhere:

- Stock balances are derived from an append-only movement ledger; nothing
  edits a balance directly.
- Posted documents are never deleted — cancel, reverse, or correct with a
  reason, all audited.
- A stage flagged `requiresQc` only releases output after a passed **and
  approved** test; retests never overwrite earlier results.
- Financial values are hidden server-side from roles without the
  `view_financial` permission.
- Every tenant's data is isolated by `tenant_id` on every table.

The database is a single local SQLite file (`data/factoryos.sqlite`) —
operations continue with no internet. All rows use UUIDs and full audit
history so a future cloud/site-server synchronization layer can be added
without a rebuild.
