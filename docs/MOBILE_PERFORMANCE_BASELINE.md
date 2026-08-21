# JENIFY OS — Mobile Performance Baseline

> Established 2026-08-21 (Mobile+Offline+Language mission §19-A). Every future
> feature is measured against these numbers. Methodology: production `vite build`
> for bundles; API payloads measured over HTTP against the isolated demo
> environment with a Manager-role session (role-scoped payloads, founder data
> untouched). Re-measure with the same method after significant changes.

## Budgets (from research: MOBILE_LOWEND_UX.md; design target = 2 GB-RAM Android Go phone on congested 3G)

| Metric | Budget | Current | Status |
|---|---|---|---|
| Initial JS (gzip) | ≤ 75 kB | **69.08 kB** | ✅ headroom 5.9 kB |
| Initial JS (raw) | ≈ 215 kB guardrail | 214.95 kB | ✅ at guardrail — do not regress |
| Largest route chunk (gzip) | ≤ 40 kB | 8.20 kB (Settings) | ✅ |
| CSS (gzip) | ≤ 8 kB | 4.07 kB | ✅ |
| API JSON responses | compressed when > 1 kB | gzip/br via @fastify/compress | ✅ new this mission |
| Per-language bundle download | only the requested language | 28.3 kB raw (~5–6 kB gzipped) | ✅ |

## Bundle inventory (vite build, 2026-08-21)

Initial: `index` 214.95 kB (69.08 kB gz) + CSS 15.86 kB (4.07 kB gz).
Route-split chunks (gzip): Settings 8.20 · Production 6.02 · Reports 5.37 ·
Setup 4.23 · Sales 3.92 · Users 3.55 · Print 3.58 · useQuery 3.72 · Payments 3.15 ·
Inventory 2.95 · Deliveries 2.47 · Receiving 2.30 · Customers 2.34 · Sacks 2.18 ·
Audit 2.13 · Dashboard 1.59 · Credit 1.24 · ui 1.25 · queries 0.50.

## API payload baseline (Manager role, seeded demo data)

| Endpoint | Size (raw) | Time (localhost) |
|---|---|---|
| POST /api/auth/login | 972 B | 111 ms (argon2 hash — intentional) |
| GET /api/auth/me | 1.7 kB | 23 ms |
| GET /api/ui-config | 673 B | 6 ms |
| GET /api/dashboard | 2.2 kB | 21 ms |
| GET /api/stock | 2.8 kB | 7 ms |
| GET /api/movements | 6.7 kB | 16 ms |
| GET /api/reports/production?period=month | 1.3 kB | 9 ms |
| GET /api/i18n/{lang} | 28.3 kB | 9 ms |

Notes: sizes grow with tenant data — movements/reports need pagination review
before any tenant with high transaction volume (tracked). `/api/i18n` is the
largest routine payload; it is per-language only and now compressed; local
caching is a Phase O1 item (research: OFFLINE_SYNC_ARCHITECTURE.md).

## What is NOT yet measured (honest gaps)

- Real-device render time / INP on a low-end Android (needs the reference
  device the research recommends the Founder approve, or throttled-emulation
  runs once a frontend test harness exists — Milestone 1 WP7 decision).
- Amharic/Tigrinya label-length ratio vs English (measure once reviewed
  translations exist; layouts already wrap and never assume English length).
- Memory profile on 2 GB devices.

## Standing rules

1. New dependencies must justify their bytes against the initial-JS budget.
2. Every new route ships as a lazy chunk; nothing new joins the initial bundle
   without Team Lead sign-off.
3. API endpoints returning lists must state their growth story (pagination /
   period filter) when added.
4. Re-measure and update this file at every engineering gate.
