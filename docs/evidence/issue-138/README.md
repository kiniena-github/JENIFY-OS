# Issue #138 — Headquarter UI evidence

Fresh screenshots and the measured no-horizontal-overflow proof for the
Headquarter advanced UI/UX upgrade.

Regenerate everything with:

```
npm run build:site --workspace @factoryos/headquarter
npm run evidence:ui --workspace @factoryos/headquarter
cp packages/headquarter/dist/ui-evidence/*.jpeg docs/evidence/issue-138/
```

`dist/` is gitignored derived output; the copies here exist only so the Founder
and reviewers can see the pages without running a browser. They are point-in-time
renders of the sample bundle (`packages/headquarter/sample-data/hq-sample.json`),
which is reconstructed from real GitHub-visible activity and is labelled as such
on every page — they are not production screenshots.

## Files

`<page>--desktop-1440.jpeg`, `<page>--mobile-390.jpeg`, `<page>--mobile-360.jpeg`
for each of the seven pages: command-center, projects, executive-room,
direct-chats, specialists, approvals, archive.

## Measured overflow result

`tools/ui-evidence.mjs` asserts, in Chromium, for every page at every width:

```
document.documentElement.scrollWidth <= window.innerWidth
document.body.scrollWidth            <= window.innerWidth
```

Widths: 1440, 1024, 414, 390, 360, 320 px. See `overflow-before-after.txt` for
the full table, including the same measurement run against `main` before the
change (which is how the reported 390px defect was reproduced).
