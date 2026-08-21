# JENIFY OFFLINE / AFRICA HARDWARE DEPLOYMENT REPORT

> Workstream **R8** of the JENIFY OS research program · 2026-08-21 · RESEARCH ONLY — no code changes.
> Author role: jenify-offline-infra (with jenify-product-research evaluation rules).
> Scope: real operating environments for African businesses (power, connectivity, devices, peripherals,
> LAN, site nodes, backup/UPS), how comparable products handle offline, and concrete recommended
> deployment profiles for JENIFY OS with cost brackets and failure scenarios.

**Confidence legend:** [H] verified from multiple/primary sources · [M] single credible source or
marketplace listings · [L] inference, stale listing, or volatile figure — verify before relying on it.

**Currency assumptions (approximate, Aug 2026, [L] — always re-verify at purchase time; the birr has
been volatile since the 2024 float):** ETB ≈ 150/US$ · KSh ≈ 130/US$ · NGN ≈ 1,500/US$ · ZAR ≈ 18/US$.
All "$" figures below are approximate USD equivalents of in-market local prices, not import prices.

---

## 1. The operating environment JENIFY must assume

### 1.1 Power — the primary hostile force

- Ethiopia experiences on the order of **39 outages and ~21 hours of downtime per month** against a
  legal aspiration of 10–15 interruptions *per year* ([Energy for Growth Hub](https://energyforgrowth.org/article/electricity-price-hikes-are-not-enough-getting-reliable-power-in-ethiopia-requires-5-key-governance-reforms/), accessed 2026-08-21) [M].
  EEU's own figures: average **15.6 hours of interruption per customer per month** (Sep 2025),
  improving to ~11 h (Feb 2026), worsening again by May 2026 ([fsxbusiness](https://www.fsxbusiness.com/ethiopia-electric-utility-steps-up-grid-maintenance), accessed 2026-08-21) [M].
- A 2023 study of 600 Ethiopian manufacturers put average outage losses at **ETB 51,777 (~$976) per
  firm per month — ~9× the typical electricity bill, ~2.2% of monthly sales** ([ScienceDirect](https://www.sciencedirect.com/science/article/abs/pii/S014098832500893X), accessed 2026-08-21) [M].
- Voltage quality is as dangerous as outages: Ethiopian 220 V supply is widely reported as unstable
  (brownouts/surges), which kills unprotected power supplies ([Sinalda voltage overview](https://www.sinalda.com/world-voltages/africa/voltage-ethiopia/), accessed 2026-08-21) [M].
- **Mesob-specific:** Mekelle/Tigray was reconnected to the national grid only in Dec 2022 after the
  war, and supply was reported erratic during restoration ([VOA](https://www.voanews.com/a/ethiopia-s-state-owned-electric-company-says-tigray-s-capital-mekelle-reconnected-/6866260.html); [Addis Standard](https://addisstandard.com/news-ethiopia-reconnects-tigrays-capital-to-national-power-grid/), accessed 2026-08-21) [H for 2022 facts].
  Current (2025–26) Tigray-specific reliability data is thin — **open question: get ground truth from
  the Mesob founder** [L].
- South African load-shedding market data (useful proxy for backup-power costs continent-wide): a
  small router/POS UPS is R1,500–3,000 (~$85–165); a 3 kW inverter + 5 kWh battery for lights/fridge/
  till is R15,000–20,000 (~$830–1,100); only ~18% of SMEs have solar, 26% use generators
  ([Energy Bee guide](https://energybee.co.za/guides/load-shedding-solutions-backup-power-south-africa-2025), accessed 2026-08-21) [M].

**Design consequence:** every JENIFY deployment must treat a power cut *mid-write* as a routine event,
not an incident. SQLite WAL + synchronous better-sqlite3 transactions are the right base; the untested
part is our own discipline (kill-mid-transaction tests, disk-full tests — agent rule, not yet in suite).

### 1.2 Connectivity — cheap-ish mobile data, scarce fixed lines, no cloud assumption

- Mobile data $/GB (cable.co.uk 2025 comparison): **Ethiopia ~$0.93, Nigeria ~$0.66–0.71, Kenya
  ~$0.84–2.92 (sources differ), Ghana ~$0.61–0.85; continental average ~$3.51/GB**
  ([Intelpoint](https://intelpoint.co/insights/uganda-and-mauritius-offer-africas-cheapest-1gb-data-at-0-02-while-madagascar-ranks-highest-in-the-top-20-at-0-32/); [Techeconomy](https://techeconomy.ng/nigeria-among-countries-with-cheapest-data-rates/); [Technext](https://technext24.com/2025/02/18/nigerias-internet-costs-and-7-countries/), accessed 2026-08-21) [M].
- Fixed broadband in Ethiopia: Ethio Telecom residential entry tier moved **698 → 998 ETB/month
  (~$6.70) for 5 → 7 Mbps** in a mandatory March-2026 migration (+43%); Kenya/South Africa entry tiers
  offer 10–20 Mbps for comparable money ([Kulu Media](https://www.kulu-media.com/ethio-telecom-residential-broadband-price-increase/), accessed 2026-08-21) [M].
  Safaricom Ethiopia raised mobile data prices ~44% in the same period ([Techpoint](https://techpoint.africa/insight/techpoint-digest-1252/)) [M].
- **Starlink is NOT licensed in Ethiopia.** April-2025 reports of a license were publicly denied by the
  Ethiopian Communications Authority ("entirely false and misleading", July 2025); grey-market kits are
  sold from Kenya ([Birr Metrics](https://birrmetrics.com/ethiopia-denies-granting-starlink-license-as-satellite-internet-expansion-faces-regulatory-pushback/); [Rest of World](https://restofworld.org/2025/starlink-cheaper-internet-africa/), accessed 2026-08-21) [M — conflicting reports; treat as unavailable].
  Elsewhere in Africa, Starlink is often price-competitive with leading ISPs — relevant for future
  non-Ethiopian tenants only [M].

**Design consequence:** JENIFY's zero-internet stance is correct and is a genuine differentiator
(§3). Bandwidth matters only for *future* sync: a day of SME business events is well under 1 MB, so
even at $1/GB, sync transport cost is negligible — **latency/absence of connectivity is the problem,
never volume.** USB sneakernet must remain a first-class transport in any future sync design.

### 1.3 Device market realities (in-market prices, Aug 2026 unless noted)

| Class | In-market reality | Approx. price | Source / confidence |
|---|---|---|---|
| Entry Android phone (ET) | Tecno Pop/Spark, itel A60, Infinix Smart — the workhorses. Budget band "under ETB 10,000" | ETB 3,500–10,000 (~$25–70); the ETB 3,000 Pop 5C listing may predate devaluation | [mobile57](https://www.mobile57.com/et/phones/tecno/), [Jiji ET](https://jiji.com.et/mobile-phones/tecno-spark), [Bunapress 2025](https://bunapress.com/) · [M]; low-end figure [L] |
| Android tablet (ET) | Jiji ET: 8,478 tablet listings. Low tier generic (e.g. "Bestrio") ETB 14,000; Realme Pad ETB 33–35k; Samsung Tab A11 ETB 59k | ETB 14,000–59,000 (~$95–390) for usable tiers | [Jiji ET tablets](https://jiji.com.et/tablets), fetched 2026-08-21 · [M] |
| Android tablet (NG/KE) | Jumia NG from ~₦59,000 (~$39, generic); brand tablets substantially more | $40–200 | [Jumia NG](https://www.jumia.com.ng/other-tablets/) · [M] |
| Used office desktop (ET) | Scarce: Jiji ET has ~3,600 desktop vs ~318,000 laptop listings. Used Dell OptiPlex seen at ETB 6,500 (~$43) | $45–150 | [Jiji ET computers](https://jiji.com.et/computers-and-laptops), fetched 2026-08-21 · [M]; scarcity [H] |
| Used laptop (ET) | Used Dell Vostro ~ETB 30,000; HP EliteBook i5 ETB 71–105k. **Laptops dominate the Ethiopian market** — and a laptop has a built-in UPS | ETB 30,000–105,000 (~$200–700) | same · [M] |
| Mini-PC / NUC-class (KE/NG) | GMKtec NucBox G2 (Intel N100, 12 GB, 512 GB SSD) sold in Nairobi; Jiji KE minis from KSh 5,000 used; Jiji NG from ₦28,000; refurb N100 units ~$100 internationally | new N100-class ~$150–280 in-market; used minis $40–120 | [Microless KE](https://ke.microless.com/product/gmktec-desktop-mini-pc-windows-11-pro-intel-n100-12gb-ddr5-512gb-ssd-dual-lan-mini-computer-1000mbps-4k-triple-display-wifi6-bt5-2-energy-efficient-nucbox-g2/), [Jiji KE](https://jiji.co.ke/16-desktop-computers/mini), [Slickdeals](https://slickdeals.net/f/18469096-minisforum-un100p-mini-pc-refurb-n100-16gb-ddr4-512gb-ssd-wi-fi-6-2-5g-lan-99-95) · [M] |
| Raspberry-Pi-class | Pi 5: $45 (1 GB, Dec 2025) to $145 (16 GB); 2025 price *increases*, weak "rest of world" stock; ET/KE street prices carry heavy import markup | $45–145 list; poor availability outside SA | [raspberrypi.com](https://www.raspberrypi.com/news/1gb-raspberry-pi-5-now-available-at-45-and-memory-driven-price-rises/), [CNX](https://www.cnx-software.com/2025/12/01/raspberry-pi-5-1gb-launched-for-45-most-other-pi-4-5-models-get-a-price-increase/) · [H list price, M availability] |
| Thermal receipt printer (ET) | E-POS ECO250 ETB 9,500; Xprinter Q838L ETB 12,500; generics ETB 10–13k in Addis | ETB 9,500–13,000 (~$63–87) | [Engocha](https://engocha.com/s/Thermal-Printer), [Jiji ET](https://jiji.com.et/385-printers/thermal) · [M] |
| Thermal receipt printer (KE) | 58 mm Bluetooth from ~KSh 5,500; 80 mm Epson/Bixolon Ethernet KSh 20,000–35,500 | $43–275 | [TDK KE](https://www.tdk.co.ke/best-thermal-pos-receipt-printers-in-kenya/) · [M] |
| Barcode scanner (KE) | Wired 1D laser ~KSh 7,000; 1D/2D wireless+USB ~KSh 14,000; branded 2D KSh 19k+ | $54–150 | [TDK](https://www.tdk.co.ke/product/1d-and-2d-qr-code-barcode-scanners-wirelessusb-wired-scanning/), [Jiji KE](https://jiji.co.ke/299-barcode-scanners) · [M] |
| A4 mono laser (KE) | Canon i-SENSYS class KSh 17,000–20,000; HP LaserJet tiers to KSh 75k | $130–580 | [mtech](https://mtech.co.ke/catalogue/category/printers/canon-printer/), [Overtech](https://overtech.co.ke/product-category/printers-scanners/hp-printers/) · [M] |
| Line-interactive UPS (KE) | Mecer 650 VA KSh 8,500; APC Easy 650 VA KSh 11,500; Delta 1500 VA/900 W KSh 12,400 | $66–96 | [Almiria](https://www.almiriatechstore.co.ke/uninterruptible-power-supply-ups-shop-in-kenya/), [Jumia KE](https://www.jumia.co.ke/uninterruptible-power-supply/) · [M] |
| LAN gear | Consumer Wi-Fi router / 5-port switch, ubiquitous | $15–40 | market knowledge · [M] |

**Raspberry-Pi reality check [H]:** the Pi's known failure mode is **SD-card corruption on power
loss** — extensively documented ([Hackaday](https://hackaday.com/2022/03/09/raspberry-pi-and-the-story-of-sd-card-corruption/),
[Pi forums](https://forums.raspberrypi.com/viewtopic.php?t=253104)). In an environment with ~39
outages/month this is disqualifying unless paired with UPS + SSD/industrial storage, at which point
an N100 mini-PC or a used laptop is cheaper in-market, faster, and x86 (no ARM build/test burden).
**Recommendation: Pi-class is NOT the JENIFY site node.** A used *laptop* is the secret weapon: it is
the cheapest node with an integrated battery (a free multi-hour UPS), integrated screen/keyboard
(no extra purchase), and the deepest local repair ecosystem.

---

## 2. How comparable products handle offline — lessons

| System | Offline model | What actually happens | Lesson for JENIFY |
|---|---|---|---|
| **Odoo POS** | Browser SPA preloads products/customers into IndexedDB; sells offline; syncs queued orders on reconnect | Must open the session online; refunds/gateways/stock updates unavailable offline; **unsynced orders can be lost if the browser cache is cleared or crashes** ([Odoo forum](https://www.odoo.com/forum/help-1/can-odoo-pos-work-without-internet-offline-mode-without-custom-module-303143), [Netilligence](https://www.netilligence.ae/blogs/can-odoo-18-pos-work-offline-understanding-offline-mode/)) [H] | Browser storage is a cache, never a ledger. JENIFY's stance (server-side SQLite is the only source of truth; PWA caches shell only) is the correct inversion of Odoo's weakness. |
| **ERPNext** | Native offline POS existed to v12, then **removed**; current POS needs the server; community sells custom sync add-ons ([Frappe forum](https://discuss.frappe.io/t/pos-offline-mode-erpnext-14-or-15/121783), [GH #29068](https://github.com/frappe/erpnext/issues/29068)) [H] | Cloud-first vendors keep failing at bolted-on offline | Offline bolted on later fails; local-first from day one (JENIFY's position) is the durable answer. This is a top-3 competitive weakness to exploit in ERPNext/Odoo-vs-JENIFY positioning. |
| **Square** | Card payments captured offline, uploaded later | Merchant carries decline risk; **72 h expiry (24 h recommended), $100 default cap**; expired offline payments are unrecoverable ([Square support](https://squareup.com/help/us/en/article/7777-process-card-payments-with-offline-mode)) [H] | Offline *money capture* needs explicit risk windows, caps, and expiry policy — never silent acceptance. Any future JENIFY offline capture queue needs the same explicitness (queue age visible, hard limits). |
| **Loyverse** (widely used free POS in African small retail) | Sells offline on the device; syncs to cloud later | Refunds, new-customer registration, item edits **disabled offline**; cloud account mandatory ([Loyverse help](https://help.loyverse.com/help/offline-work-of-pos)) [H] | A *reduced, explicitly-labeled* offline capability set is acceptable UX; ambiguity is not. Also: "free but your data lives on our servers" is a JENIFY counter-pitch. |
| **Dynamics 365 Commerce POS** | Each register has a local offline database, periodic sync ([MS docs](https://learn.microsoft.com/en-us/dynamics365/unified-operations/retail/pos-offline-functionality)) [M] | Enterprise-grade but heavy, consultant-dependent | The per-register local DB validates the site-node idea; the implementation weight is what JENIFY must NOT copy. |
| **M-PESA / mobile-money agents** | USSD-first (works on any phone, no data); agents as human trust layer; SMS receipts | SMS receipt delays are national news; robust reversal flows and fallbacks are the survival kit ([TechTrends KE](https://techtrendske.co.ke/2025/09/11/m-pesa-sms-delays-in-kenya/), [fintechmarker](https://fintechmarker.com/m-pesa-why-old-school-ussd-still-wins-in-african-mobile-money/)) [M] | The dominant African financial rail is designed around *degraded channels + explicit reversals* — exactly JENIFY's cancel/reverse/audited-correction doctrine. Paper printouts remain the receipt of record where SMS/data fail. |
| **Field-sales apps (FieldPro, Delta Sales, BeatRoute)** | Offline-first mobile capture, auto-sync when network returns; standard for African FMCG distribution ([FieldPro](https://www.fieldproapp.com/mobile-app), [Delta](https://deltasalesapp.com/blog/top-field-force-management-app-in-africa)) [M] | Proven demand for disconnected *capture* (visits, orders) with later sync | Future JENIFY offline capture should target this shape: low-risk documents (drafts/orders) queue offline; *posting* happens at the node. |
| **Tally Prime Gold (India)** | **LAN multi-user against one server box's data folder; offline license activation; no internet at all** ([tallyatcloud](https://www.tallyatcloud.com/article/how-multi-user-tally-works-network-setup-speed-boost-user-control-explained-2025-guide/552/0/1)) [M] | The dominant SME back-office pattern in a market of millions of businesses | **The single-box LAN server is a proven, boring, massively validated pattern.** JENIFY's architecture is Tally's topology with a modern web UI — keep it boring. |

**Synthesis:** nobody in this comparison set silently merges financial records. The successful patterns
are (a) local server as source of truth, (b) reduced explicit offline capability on satellite devices,
(c) queues with visible age/limits, (d) reversals instead of edits. JENIFY's existing invariants
(append-only ledger, cancel/reverse only, UUIDv7, versioned settings, shell-only service worker
`packages/web/public/sw.js`) already encode these — the gap is *operational* (hardware, power, backup,
LAN serving), not conceptual.

---

## 3. JENIFY today — repo-verified baseline

- Single box, `127.0.0.1:3001` Fastify + better-sqlite3 (WAL), web via Vite dev/preview proxy; **no
  productized LAN serving** (tracked T3) and both dev and preview bind localhost by default — today's
  deployment is effectively *one machine, one browser* (`docs/FACTORY_OS_CURRENT_STATE.md` §7).
- DB `data/factoryos.sqlite` lives **inside a OneDrive-synced folder** — a known WAL corruption vector
  (tracked T2). Observed in `data/`: live DB + 4 manual `backup-*.sqlite` snapshots + a `backups/` dir;
  the About panel surfaces the newest `backup-*.sqlite` mtime (`routes/admin.ts` system-info).
- PWA: `sw.js` caches static shell only; API and navigation always network — business data is never
  stale. Correct and deliberately minimal.
- Sync-ready primitives already in place: UUIDv7 everywhere, append-only `stock_movements` and
  `audit_events`, versioned `tenant_settings`/`role_permissions`, document snapshots
  (pricing/VAT/branding versions), stored-UTC timestamps.
- Runtime is `tsx` (no compiled dist), `logger:false`, no TLS (LAN trust boundary), no rate limiting —
  acceptable on one box, all relevant the moment a LAN profile ships.

**Verdict:** the *architecture* is offline-correct and ahead of Odoo/ERPNext on this axis. The
*deployment* is one laptop away from a single-point-of-failure story, with its only copy of the
business inside a cloud-sync folder that is also its biggest corruption risk.

---

## 4. Recommended deployment profiles

> Prices are in-market brackets (Aug 2026, [M] unless noted); local-currency examples from §1.3.
> "Setup effort" assumes one technically-comfortable person following a written runbook.

### Profile 1 — MICRO: single shop, one device (~$200–400, half a day)

| Item | Choice | Approx. cost |
|---|---|---|
| Node + screen + battery | **Used business laptop** (i5-class, 8 GB, SSD — e.g. ETB ~30,000 in Addis) | $150–250 |
| Receipts (optional) | 58 mm USB/Bluetooth thermal printer | $45–90 |
| Backup media | 2 × USB flash drives (rotated) | $10–15 |
| Power | None needed — the laptop battery IS the UPS (hours of bridging) | $0 |

- JENIFY server + browser run on the same laptop, exactly the current Mesob pattern. The shop phone
  is *not* a server: JENIFY's Node/better-sqlite3 stack does not run on Android as a product
  (Termux is a hobbyist hack, not a deployment) — **the honest smallest unit today is one laptop.**
  A phone-only micro runtime (embedded local DB app) is a future research item, not a profile.
- The phone still matters as: hotspot (if any sync/report export ever), camera (future document
  capture), and off-site backup carrier (copy the nightly snapshot to the phone weekly).
- **Must survive:** power cut mid-posting (WAL + transactions; verify with kill-tests) · laptop
  theft/disk death (USB snapshot rotation, one copy stored away from the shop) · zero internet forever
  (already true) · battery degradation on used laptops (check cycle count at purchase [L]).

### Profile 2 — SME: shop/distributor, 2–6 concurrent users (~$650–1,300, 1–2 days)

| Item | Choice | Approx. cost |
|---|---|---|
| Site node | New N100-class mini-PC (12 GB/512 GB SSD) **or** used SFF desktop | $120–280 |
| UPS | Line-interactive 650–1500 VA with AVR (voltage regulation matters as much as runtime) | $66–100 |
| LAN | Wi-Fi router + 5-port switch, JENIFY on a dedicated SSID | $25–45 |
| Client devices | 2–4 cheap Android tablets (ETB 14–35k class) and/or existing phones/laptops | $200–500 |
| Receipts | 80 mm USB/Ethernet thermal printer | $90–160 |
| Scanning | 1D/2D USB barcode scanner (when item barcoding is configured) | $55–110 |
| Documents | A4 mono laser (invoices/delivery notes) | $130–160 |
| Backup media | 2 × USB drives + 1 microSD/phone copy | $15 |

- **Blocker to note (not to fix here):** this profile requires productized LAN serving — server bound
  to the LAN IP, `web/dist` served by Fastify (T3), and an explicit LAN-only trust statement (no TLS →
  isolated SSID/VLAN, strong Wi-Fi password, cookie posture reviewed). Until T3 lands, Profile 2
  cannot be delivered.
- Tablets are *browsers*, not data holders — a stolen tablet loses zero business data (server-side
  masking and sessions already assume this).
- **Must survive:** router failure (fallback: any phone hotspot re-creates the LAN; node keeps
  running) · concurrent posting collisions (D12 numbering race becomes real at 2+ users — must be
  fixed before this profile ships) · power cut (UPS bridges node + router ≥ 15–30 min; clients are
  battery devices anyway) · node disk death (nightly snapshot + USB rotation; any laptop on the LAN
  can be promoted by restoring the snapshot — document this drill).

### Profile 3 — FACTORY: the current Mesob single-box pattern, evaluated (~$850–1,900, 2–3 days)

**Evaluation of what exists:** the instinct is right (local-first, WAL, append-only, no cloud), and it
passed a full founder-validated pilot. Four operational hazards keep it from being go-live-grade:

1. **Live WAL DB inside OneDrive** (T2) — the single most likely way Mesob loses data. Move the
   deployment directory out of OneDrive *before* anything else; let OneDrive (or anything) sync only
   the cold snapshot directory, never the live DB. Cost: zero. Value: prevents the worst scenario.
2. **Dev-server production** (T3) — `tsx` + Vite preview is fine for the pilot, wrong for a factory
   floor: no service supervision, no auto-restart after power-loss reboot. The box must boot straight
   into JENIFY without a human running `npm run dev`.
3. **One box = the whole factory.** If it dies, operations stop until repair. The counter is not a
   cluster — it is a **cold standby**: any second laptop + last night's snapshot + a written 30-minute
   restore drill, rehearsed monthly.
4. **Backups are human discipline, not schedule.** Four manual snapshots exist (good instinct);
   codify: nightly automated snapshot (SQLite `VACUUM INTO`/online backup — never a file copy of a
   live WAL DB), weekly USB rotation, monthly off-site copy, monthly restore test surfaced in the
   About panel (which already reports last-backup age).

**Recommended factory kit (Mesob-shaped):**

| Item | Choice | Approx. cost |
|---|---|---|
| Site node | Dedicated mini-PC/business desktop, SSD, auto-power-on-after-outage BIOS setting | $200–400 |
| Standby | Keep the current laptop as warm standby + office client | $0 (owned) |
| UPS | 1500 VA line-interactive w/ AVR for node + router + one screen; graceful-shutdown trigger | $96–150 |
| LAN | Router + switch; optional cheap tablets at receiving/production/QC stations (post-T3) | $25–350 |
| Printers | 80 mm thermal (gate/dispatch) + A4 laser (invoices, QC certificates) | $220–320 |
| Scanner | 2D scanner (future batch/pack barcodes) | $55–110 |
| Backup media | 3 × USB drives, one always off-site | $20 |
| Optional power depth | Small inverter + battery for multi-hour outages (Ethiopian reality: outages exceed UPS runtime) | $300–800 [M, SA proxy pricing] |

- **Must survive:** multi-hour grid outage (UPS → graceful shutdown → battery-laptop standby keeps
  *reading* ability; paper continues; catch up entries after power returns) · power cut mid-posting
  (WAL; add kill-mid-transaction tests) · disk death/theft/fire (snapshot + off-site copy + restore
  drill) · OneDrive/file-sync corruption (move the live DB out — this is the one scenario that can
  silently destroy history) · staff error (append-only + reversals already protect) · long weekend
  unattended (auto-restart on power return; About panel shows backup age on Monday).

### Profile 4 — MULTI-SITE: site nodes + future sync (architecture direction ONLY)

No engine design here; direction consistent with the repo's sync-ready primitives and Decision
2026-08-17 (*local-first, sync-ready*). Explicit conflict story goes to jenify-architect before any
implementation (offline-infra rule 2).

- **Topology:** each site runs a Profile-2/3 node that **owns** its warehouses, document sequences
  (site-prefixed numbering), and users. One node (HQ or the factory) is the aggregation point.
- **Sync = append-only event shipping, store-and-forward.** Posted ledger transactions are *facts
  that happened at a site*: they replicate outward verbatim and are **never merged, edited, or
  conflict-resolved — a "conflict" on a posted transaction is by construction impossible if only the
  owning site may post to its own warehouses.** Corrections travel as new reversal/correction events,
  exactly as they do locally today. UUIDv7 already guarantees collision-free identity; stored-UTC
  timestamps and versioned settings give a defensible ordering story.
- **The only true conflict surface is shared master data and configuration** (items, parties, prices,
  role matrices). Direction: explicit ownership (HQ authors, sites consume read-only) as the boring
  default; anything fancier needs the architect review.
- **Transport-agnostic by design:** nightly 4G push (a day of events ≪ 1 MB — see §1.2), LAN when
  co-located, and **USB sneakernet as a first-class, not degraded, transport** for zero-connectivity
  sites. Cloud relay only ever with explicit Founder approval (principle 7).
- **First deliverable on this road is NOT sync:** it is the **read-only owner digest export** (roadmap
  risk #4) — a signed snapshot/report the owner can carry or send over any channel. It exercises the
  export/import seam cheaply and answers the one competitor demo that currently beats JENIFY
  (remote owner visibility) without any distributed-systems risk.
- **Hardware:** n × site node ($400–900 each all-in) + aggregation node ($300–500). No new device
  classes needed.
- **Never:** two sites posting into one warehouse; distributed transactions; automatic merge of any
  financial document; sync that can double-post (offline-infra rule 1 — reject outright).

---

## 5. Cross-cutting power & backup doctrine (all profiles)

**Power:**
1. Prefer nodes with built-in batteries (laptops) at the low end; below factory tier a laptop beats
   desktop + UPS on both cost and resilience.
2. Where a desktop/mini-PC node is used: **line-interactive UPS with AVR** (brownouts kill more
   hardware than blackouts [M]); UPS covers node + router only — clients are battery devices.
3. BIOS "restore power state after loss" ON; JENIFY as an auto-starting service, so the site recovers
   from an outage with zero human steps.
4. Outages longer than UPS runtime are *normal* (Ethiopia: hours, not minutes): the doctrine is
   graceful shutdown → paper continues → catch-up entry after power returns. JENIFY's fast manual
   entry is the offline mode for pen-and-paper hours.
5. Surge protection on every printer/scanner PSU (cheap strips, $5–10) — peripherals die first.

**Backup (the "3-2-1 lite" for African SMEs):**
1. **Nightly automated snapshot** via SQLite online backup / `VACUUM INTO` into a local `backups/`
   directory — never a raw file copy of a live WAL database, and never OneDrive/Drive sync of the
   live DB (the corruption vector we currently have as T2).
2. **Weekly USB rotation** (2–3 sticks, one always off-premises — the owner's home is a fine
   off-site). A phone can carry the weekly copy where USB discipline fails.
3. **Monthly restore drill** — a backup that has never been restored is a hope, not a backup. Target:
   any spare laptop running from last night's snapshot in ≤ 30 minutes, from a printed one-page
   runbook.
4. **Surface it:** the About panel already shows last-backup age — treat "backup older than 48 h" as
   an operational red flag for the owner, same status as an overdue invoice.
5. Future option (local-only, no cloud): Litestream-style continuous WAL shipping to a *second local
   disk/USB target* would cut the recovery point from "yesterday" to "seconds"
   ([litestream.io](https://litestream.io/how-it-works/)) [H mechanism]. Value-add later; the nightly
   snapshot + drill is the non-negotiable floor now.

**Riskiest failure scenarios, ranked by (likelihood × damage) across profiles:**

| # | Scenario | Hits | Current exposure | Doctrine answer |
|---|---|---|---|---|
| 1 | File-sync client corrupts live WAL DB | P3 today | **HIGH (T2 open)** | Move live DB out of OneDrive; sync cold snapshots only |
| 2 | Node disk death / theft with stale backups | all | HIGH (manual backups) | Nightly snapshot + USB rotation + restore drill |
| 3 | Multi-hour outage mid-shift | all | MEDIUM | UPS → graceful shutdown → paper → catch-up entry |
| 4 | Power cut mid-transaction | all | LOW-MED (untested) | WAL + transactions; add kill/disk-full tests |
| 5 | Concurrent posting race on LAN | P2/P3 | MEDIUM (D12 open) | Fix atomic numbering before any multi-user profile |
| 6 | Router/Wi-Fi failure | P2/P3 | LOW | Node unaffected; hotspot fallback; wired printer path |
| 7 | Browser/PWA serving stale UI | all | LOW (sw is shell-only) | Keep sw.js minimal; version-stamped assets |
| 8 | Future sync double-post/merge | P4 | N/A (no engine) | Site-ownership + append-only shipping; reject merge designs outright |

---

## 6. Recommendations ranked by value ÷ complexity

1. **Move the live DB out of OneDrive** (T2). Zero cost, kills the #1 data-loss scenario. *Do first.*
2. **Codify the backup doctrine** (§5): nightly snapshot, USB rotation, monthly restore drill, printed
   one-page runbook per profile. Near-zero cost, converts hope into recovery.
3. **Adopt the standard BOMs** (§4) as the official JENIFY deployment profiles; used-laptop micro tier
   and N100-mini-PC + AVR-UPS site node as the recommended units. Pure documentation/procurement.
4. **Productize single-box operation** (T3 + service supervision + auto-start after power loss) before
   Mesob go-live — the factory must reboot into JENIFY unattended.
5. **Failure-scenario tests** (kill-mid-transaction, disk-full, restore-from-snapshot) in the server
   suite — cheap, directly de-risks scenarios #2/#4, satisfies offline-infra rule 5.
6. **Fix D12 (atomic document numbering) before any multi-user LAN profile ships.**
7. **Owner digest export before any sync work** — the cheapest counter to the only competitor
   advantage (remote visibility), and it exercises the future sync seam safely.
8. **Multi-site architecture memo** (site-ownership + append-only event shipping + USB transport) to
   jenify-architect when tenant #2/multi-site demand is real — direction in §4.4, no engine until then.
9. **Do NOT pursue:** Raspberry-Pi site nodes (SD corruption + availability), phone-as-server
   deployments (stack mismatch), browser-storage offline queues (Odoo's documented weakness), or any
   sync design in which posted ledger transactions can merge.

**Open questions for the Founder / Team Lead:**
- Ground truth on Mekelle grid reliability and Mesob's actual on-site hardware today (what exactly
  does Henok own — laptop model, printer, UPS, router?).
- Appetite for a modest hardware budget at go-live (~$250–400: UPS + USB drives + thermal printer)?
- Owner-visibility channel preference (printed digest, USB, phone file) given the no-cloud rule.
- ETB pricing volatility: re-quote all local prices at purchase time; this report's brackets are
  Aug-2026 marketplace snapshots.

---

## Team Lead summary (10 lines)

1. Environment verified: Ethiopia ≈ 39 outages/~21 h down per month, unstable voltage, ~$0.93/GB data, no Starlink license — power, not bandwidth, is the enemy; JENIFY's zero-internet stance is a real differentiator.
2. Comparables: Odoo/ERPNext offline is bolted-on and fragile (browser-queue data loss; ERPNext removed offline POS); Square caps+expires offline payments; Loyverse disables actions offline; Tally's LAN single-box pattern validates JENIFY's topology at massive scale.
3. Nobody credible merges financial records in sync — JENIFY's append-only/reverse-only doctrine is the industry-converged answer; keep it absolute.
4. Profile 1 (micro, $200–400): one used laptop (built-in battery = free UPS) + optional 58 mm printer; phone-as-server is not viable with our stack — say so honestly.
5. Profile 2 (SME, $650–1,300): N100 mini-PC node + AVR UPS + tablets-as-browsers; blocked on T3 (LAN serving) and D12 (numbering race) before it can ship.
6. Profile 3 (factory/Mesob, $850–1,900): architecture is right, operations aren't yet — move DB out of OneDrive (T2), auto-start service, cold-standby laptop, codified nightly backup + monthly restore drill.
7. Profile 4 (multi-site): direction only — site-owned warehouses, append-only event shipping, USB sneakernet as first-class transport, master-data ownership at HQ; conflict story to jenify-architect before any build.
8. Rejected: Raspberry-Pi nodes (SD corruption under our outage profile), browser offline queues, any merge-based sync.
9. Top 3 actions by value/complexity: (a) DB out of OneDrive, (b) codified backup doctrine + restore drill, (c) owner digest export before any sync engine.
10. Open: Mesob's actual on-site hardware + Mekelle grid ground truth from the Founder; ~$250–400 go-live hardware budget decision; all ETB prices are Aug-2026 snapshots — re-quote at purchase.
