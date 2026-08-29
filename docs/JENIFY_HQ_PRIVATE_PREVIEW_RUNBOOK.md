# JENIFY HQ — Private Preview Runbook

Issue #219, preview-hosting fallback. This runbook lets the Founder privately
preview the **static build of the HQ site** while Vercel Git integration
remains unavailable. It changes nothing in production, touches no existing
Vercel project, and requires no credentials.

---

## 1. What this preview actually is (and is not)

The preview is the output of `npm run build:site --workspace @factoryos/headquarter`:
**9 static HTML pages plus one `hq-snapshot.json`**, rendered from the committed
sample bundle `packages/headquarter/sample-data/hq-sample.json`.

Facts, verified against the code and a real build (2026-08-28):

- The snapshot's headline **mode is `sample`**. The provenance vocabulary in
  `packages/headquarter/src/live/provenance.ts` is `sample` / `reconstructed` /
  `live`, and the snapshot's overall mode is the *weakest* of its sections —
  one sample section means the whole snapshot says SAMPLE. In this build the
  operational, workforce, capability and activity sections are all `sample`.
  (The connections section alone reports `live` because environment-fact
  *presence* is genuinely probed on the build machine — names only, never
  values — but it cannot lift the overall claim.)
- **No Founder session, no tenant data, no HQ database.** The build CLI
  (`packages/headquarter/src/cli/build-site.ts`) renders a JSON data file; it
  never opens the HQ store. Its operational console section is explicitly
  `emptyFounderConsole` — zero tasks, zero approvals, and the provenance says
  so ("no HQ database was opened by this build").
- Therefore: **a static preview is NOT a live HQ console.** It shows layout,
  navigation, and hand-authored demonstration data. It shows no real company
  state, no real operations, and proves nothing about the running system. The
  pages themselves render SAMPLE provenance chips; do not present the preview
  as anything more than that.
- The build fails closed rather than emit an unsafe artefact: the secret-scan
  and no-absolute-path contracts are enforced by
  `packages/headquarter/test/build-site-artifact.test.ts` against the real CLI
  output. Even so, treat the preview as private (Section 3).

## 2. Build it locally

From the repo root:

```
npm run build:site --workspace @factoryos/headquarter
```

Observed real output:

```
Rendered 9 Headquarter pages → packages/headquarter/dist/site
Wrote hq-snapshot.json (mode: sample, as of 2026-08-26T10:30:00Z)
```

Output directory: `packages/headquarter/dist/site/` — 10 files:

| File | Purpose |
|---|---|
| `index.html` | Entry page |
| `headquarters.html` | HQ overview |
| `approvals.html` | Approvals |
| `archive.html` | Archive browser |
| `connections.html` | Connection status |
| `direct-chats.html` | Direct chats |
| `executive-room.html` | Executive room |
| `projects.html` | Projects |
| `specialists.html` | Specialists |
| `hq-snapshot.json` | Freshness snapshot the pages poll |

`dist/` is gitignored; the built site never enters version control.

Note: each page polls `hq-snapshot.json` (same directory, relative URL) for a
freshness badge. Served over HTTP this shows LIVE/STALE against the render
timestamp; opened directly from `file://` the poll cannot fetch and the badge
truthfully degrades to OFFLINE. Serve over HTTP for the intended experience.

## 3. Hosting option A — local loopback (zero-risk default)

Nothing leaves the machine. From the repo root:

```
npx serve packages/headquarter/dist/site -l 127.0.0.1:4173
```

Then open http://127.0.0.1:4173/ . (`npx serve` downloads the `serve` package
on first use; any equivalent static file server bound to 127.0.0.1 is fine —
e.g. `python -m http.server 4173 --bind 127.0.0.1` run inside the dist/site
directory.)

- Bound to loopback: not reachable from the network.
- No account, no credentials, no third party, no cost.
- **This is the recommended option.** Use option B only if the preview must be
  viewable from another device.

Teardown: stop the server (Ctrl+C). Done.

## 4. Hosting option B — a NEW, separate, private Vercel project

> **WARNING — QOS Ethiopia project isolation.**
> Never reuse, relink, or overwrite the existing QOS Ethiopia Vercel project
> for this preview. Do not deploy from a directory linked to it, do not select
> it when the CLI asks "Link to existing project?", and never attach any
> production domain or change any DNS record. The HQ preview must be a
> brand-new project with a throwaway name (e.g. `jenify-hq-preview`).

This is a Founder-executed, manual action. **No AI session deploys.** No
deployment has been performed and no Vercel project exists as of this runbook;
nothing below implies otherwise.

### Why there is deliberately no `vercel.json` in this repo

Two honest reasons:

1. **Privacy cannot be expressed in `vercel.json`.** The thing that makes a
   Vercel deployment private — Deployment Protection ("Vercel Authentication"
   on the free plan, restricting access to the project's Vercel team members)
   — is a per-project **dashboard setting**, not a file setting. A
   `vercel.json` would therefore give false comfort: it cannot deliver the one
   property this runbook requires.
2. **A repo-root `vercel.json` is ambient configuration.** If this repository
   were ever Git-linked to any Vercel project in the future, a committed
   `vercel.json` would silently apply. Deploying a pre-built static directory
   needs no build configuration at all, so committing one adds risk and no
   value.

The manual settings below replace it.

### Steps (Founder, on their own machine and Vercel account)

1. Build locally first (Section 2). Verify the console line says
   `mode: sample`.
2. Create the project by deploying the **dist directory only** — never the
   repo root:

   ```
   cd packages/headquarter/dist/site
   vercel deploy
   ```

   When prompted:
   - "Set up and deploy?" → yes.
   - "Link to existing project?" → **No.** Create a new project, e.g.
     `jenify-hq-preview`. (If the QOS project's name is ever offered,
     decline.)
   - Directory to deploy → `.` (the current dist/site directory).
   - Build settings → none / no framework. It is already-built static output;
     there must be no build command, no install command, no output directory
     override.
3. Do **not** run `vercel --prod` and do not promote the deployment to
   production within the new project either — preview deployments are
   sufficient and keep the "nothing is production" property literal.
4. Immediately make it private: in the Vercel dashboard for
   `jenify-hq-preview` → Settings → Deployment Protection → enable Vercel
   Authentication for **all deployments**. Verify by opening the preview URL
   in a private/incognito window: it must demand a Vercel login, not show the
   pages.
5. Do not add any custom domain to the project. Do not touch DNS anywhere.
6. Share the preview URL only with intended Vercel-team viewers.

Cost note: a static 10-file deployment fits Vercel's free tier; do not enable
any paid feature for this preview.

### Teardown (zero production impact)

Vercel dashboard → `jenify-hq-preview` → Settings → Delete Project. Because
the project is new, standalone, un-domained, and Git-unlinked, deleting it
affects nothing else — not the QOS project, not this repository, not any DNS.
Locally, `git status` stays clean throughout: the deploy reads only the
gitignored `dist/site` directory. If the CLI created a `.vercel/` folder
inside `dist/site`, it is inside the gitignored dist tree; delete it with the
rest of `dist/` if desired (`dist/` is fully regenerable via Section 2).

## 5. Founder-only configuration that is deliberately NOT done

None of the following exists in this preview, none is seeded anywhere in the
repository, and none can be guessed or defaulted by an AI session:

- **The `(realmId, accountId) → principal` Founder binding**
  (`FACTORYOS_HQ_FOUNDER_MAP`). Unset means *nobody is the Founder* and every
  HQ control stays off — a valid, fail-closed state
  (`packages/server/src/services/headquarter-host.ts`). Malformed JSON is
  refused loudly (`founder_map_malformed`), never normalised.
- **The `FACTORYOS_HQ_*` variables for a genuinely live console:**
  `FACTORYOS_HQ_CONTROL=1` (master switch; anything else ⇒ OFF),
  `FACTORYOS_HQ_DB=<path-to-hq-sqlite>` (required once the switch is on; no
  invented default), `FACTORYOS_HQ_ALLOWED_ORIGINS=<csv>` (unset ⇒ every
  mutation refused), `FACTORYOS_HQ_MUTATIONS=1` (otherwise reads only),
  `FACTORYOS_HQ_SITE_DIR=<path-to-dist-site>` (same-origin `/hq/` mount,
  gated to the mapped Founder; unset ⇒ nothing served).
- **Any credential, token, API key, or provider secret.** The static build
  observes only the *presence* of declared fact names; no value travels into
  the artefact, and the artefact test suite fails the build if one does.

Without all of the above, the system is fail-closed and read-only by
construction. This static preview needs none of it and configures none of it.

## 6. Rollback summary

| Action taken | Undo | Production impact |
|---|---|---|
| Local build (`dist/site`) | delete `packages/headquarter/dist/` (gitignored, regenerable) | none |
| Loopback server | Ctrl+C | none |
| New Vercel preview project | delete the project in the dashboard | none — new project, no domain, no Git link |

Nothing in this runbook writes to any database, any DNS record, the QOS
Ethiopia project, or the Mesob pilot.

## 7. What this preview does NOT prove

- Not that the live HQ console works: no server, no `FACTORYOS_HQ_*` gating,
  no Founder auth, no control API is exercised.
- Not that any connection is really usable: the connections section reflects
  fact *presence* on the build machine at build time, not authenticated,
  working integrations.
- Not anything about real operations: every operational number is from the
  hand-authored sample bundle or is an honest empty console.
- Not the same-origin `/hq/` serving path (`FACTORYOS_HQ_SITE_DIR` through the
  API server) — the preview serves the files directly, bypassing that mount
  and its Founder gate.
- Not Vercel Git integration — this is precisely the fallback for its absence.
- Not mobile/production performance, custom-domain behaviour, or anything
  behind a login.

The preview proves one thing: the 9 static HQ pages render and navigate as
built, showing SAMPLE data, viewable privately.
