# JENIFY OS — Mobile & Low-End Device UX Report

> Workstream **R10** of the JENIFY OS research program · 2026-08-21 · RESEARCH ONLY — no code changed.
> Authors: jenify-ux-engineer (role) with jenify-product-research support.
> Founder mandate under study: **MOBILE-FIRST · LOW-END-DEVICE-FIRST · BAD-INTERNET-FIRST · LOW-BANDWIDTH-FIRST**, with deliberately simplified role-based mobile experiences (warehouse worker sees RECEIVE / MOVE / ISSUE / COUNT / LOOKUP — not the desktop menu).
> Grounded in: `packages/web` (React 18 + Vite SPA; ~214 kB / 69 kB gzip initial budget; `styles.css` single ≤900 px breakpoint; minimal `public/sw.js` PWA shell; server-driven i18n via `/api/i18n/{lang}`), `docs/research/ROLE_EXPERIENCE_SIMPLICITY.md` (R5 — role homes and click budgets), `docs/research/OFFLINE_HARDWARE_DEPLOYMENT.md` (R8 — offline architecture; not re-argued here).
> Confidence labels on every claim: **HIGH** (authoritative/multiple independent sources) · **MEDIUM** (single source, vendor claim, or review aggregate — plausible but not independently verified) · **LOW** (our inference; or no source found — always said explicitly). No number in this report is invented; where we could not source a figure, we say so.

---

## 0. The frame: what the mandate means judged by the five principles

| Principle | What mobile-low-end-first demands |
|---|---|
| **FAST** | Interactive in ≤3 s on a ~$80 phone over 3G; every tap answers in <200 ms. Speed is a feature the competition (Odoo mobile, SAP) demonstrably fails to deliver (§C.4). |
| **SIMPLE** | A worker role gets a verb list, not a module tree. R5's "one person, one job, one screen" becomes literal on a 5-inch screen. |
| **FLEXIBLE** | The same core serves desktop office roles and phone worker roles — role/device experiences are **configuration** (nav sets, home screens, target sizes), not forks. |
| **LOCAL** | No runtime dependency on any CDN, font service, or app store. The PWA is served from the factory's own node; fonts and icons ship in the bundle. |
| **INTELLIGENT** | The system types for the worker: defaults, lookup-first entry, scan-shaped inputs, numerals over sentences. |

**The one-sentence conclusion:** stay a PWA on the existing React stack, but treat a **2 GB-RAM Android Go phone on a congested 3G cell** as the primary design target — and enforce that with budgets, a reference device, and a worker-mode UI profile, not with good intentions. **[LOW — our synthesis; everything below is the evidence.]**

---

## A. Low-end Android performance

### A.1 The device reality (what a "phone" means in our market)

- Transsion (TECNO + Infinix + itel) held **~48% of African smartphone shipments in 2025** (40.5 M units); devices **below $200 were 81% of all shipments**. **[MEDIUM — trade press summarizing analyst data: [Gizmochina/Canalys-derived](https://www.gizmochina.com/2026/02/25/transsion-captures-48-as-africa-smartphone-market-grows-13-in-2025/), [TelecomLead](https://telecomlead.com/latest-news/africa-emerges-as-the-fastest-growing-smartphone-market-in-2025-what-buyers-need-to-know-122255)]**
- The volume tier is itel A-series / TECNO Spark Go class: roughly **$75–110**, 2–4 GB physical RAM (vendor "up to 16 GB" figures include virtual RAM — ignore them for performance planning), entry MediaTek SoCs, 720p screens. **[MEDIUM — vendor/retail summaries: [accio itel guide](https://www.accio.com/business/itel-best-selling-phone), [accio Spark guide](https://www.accio.com/biz-cheap/tecno-spark-budget-phone); exact SoC per model not verified here]**
- Google now **mandates Android Go edition** for low-RAM devices: required at ≤2 GB from Android 10/11, extended to 2–3 GB with Android 15 and toward 4 GB with Android 16. Translation: a large share of phones our users hold run the stripped-down Go stack with aggressive app eviction. **[MEDIUM — [Android Go, Wikipedia](https://en.wikipedia.org/wiki/Android_Go), [XDA](https://www.xda-developers.com/android-go-edition-requirement-new-low-ram-devices/), [PhoneArena](https://www.phonearena.com/news/google-changes-minimum-ram-requirement-android-devices_id126083)]**
- Alex Russell's 2026 performance-inequality baseline (global P75 device) is a **Samsung Galaxy A24-class phone (Helio G99, <$250)** — and low-end Android single-core CPU is **~9× slower than a contemporary iPhone**, with mid-tier still >3.5× slower. Our market's median device is *below* this global P75, so his budgets are a **ceiling**, not a target. **[HIGH for the published baseline/numbers — [Performance Inequality Gap 2026](https://infrequently.org/2025/11/performance-inequality-gap-2026/); LOW for "our median is below P75" — directionally certain from the shipment data above, but no East-Africa-specific percentile source found]**
- Android version mix in Africa: Statcounter publishes it ([Africa Android version share](https://gs.statcounter.com/android-version-market-share/mobile/africa/2025)) but we did not extract a verified breakdown; **treat the exact version split as unsourced**. Design consequence regardless: assume old WebView/Chromium versions in the field and avoid bleeding-edge web APIs without fallback. **[LOW — number not extracted; the design rule is our inference]**

### A.2 JS main-thread cost: the budgets

From the same 2026 baseline (9 Mbps down / 3 Mbps up / 100 ms RTT network profile) **[HIGH — [source](https://infrequently.org/2025/11/performance-inequality-gap-2026/)]**:

| Load target | JS-heavy stack (50% JS) | Markup-centric stack (15% JS) |
|---|---|---|
| 3 seconds | 1.2 MiB total / **0.62 MiB JS** | 2.0 MiB total / 0.3 MiB JS |
| 5 seconds | 2.3 MiB total / 1.15 MiB JS | 3.7 MiB total / 0.57 MiB JS |

- JS costs more per byte than any other resource because it must be parsed, compiled, and executed on that 9×-slower single core; "the P75 device places a hard cap on the amount of JavaScript that is reasonable for any website to rely on." **[HIGH — same source]**
- **Where JENIFY stands:** initial bundle ≈ 214 kB raw / 69 kB gzip (CLAUDE.md budget, route-split per page). That is comfortably inside even the 3-second JS-heavy budget — the current stack is *not* the problem; **regression is the risk**. React 18 + ReactDOM is the majority of that initial payload; Preact (~3–4 kB gzip, `preact/compat`) exists as an escape hatch if the budget ever breaks, at the cost of ecosystem risk. **[HIGH for our own bundle numbers (repo); MEDIUM for Preact sizing/compat — [nimblechapps comparison](https://www.nimblechapps.com/blog/preact-vs-react-the-ultimate-performance-showdown-2025), [alphabold](https://www.alphabold.com/preact-vs-react/)]**

### A.3 What dies on these phones (failure modes)

1. **Big hydrating SPAs.** Multi-hundred-kB JS bundles blow the 3–5 s window outright; SPAs in the field average ~1 soft navigation per hard navigation, so the SPA tax is often paid for nothing. **[HIGH — [Performance Inequality Gap 2026](https://infrequently.org/2025/11/performance-inequality-gap-2026/)]** JENIFY's SPA is defensible *because* it is small and route-split — that defense is the budget, not the architecture. **[LOW — inference]**
2. **Browser-wrapped desktop ERP.** Odoo's mobile app is the browser experience requiring a connection for most tasks; user reviews call the product "ridiculously slow," with loading spinners long enough to "get some coffee." This is the anti-pattern the mandate exists to avoid. **[MEDIUM — review aggregates: [GetApp](https://www.getapp.com/sales-software/a/odoo/reviews/), [Capterra](https://www.capterra.com/p/135618/Odoo/reviews/), [tatvamasilabs](https://tatvamasilabs.com/odoo-review/)]**
3. **Unvirtualized long lists and wide tables.** Rendering hundreds of DOM rows on a Helio A22-class CPU janks scrolling and can OOM-evict the tab on Go devices. **[LOW — standard practitioner knowledge; no single citation; consistent with the CPU data above]**
4. **Heavy chart/animation libraries, large images, web fonts fetched from CDNs.** Each competes for the same starved main thread and 3G pipe; images and CSS deliver more experience per byte than JS, so spend the byte budget there when forced to choose. **[HIGH for the byte-for-byte claim — same Russell source; LOW for the specific library warning — inference]**
5. **Background tab eviction.** Android Go kills backgrounded apps/tabs aggressively; any in-progress form state that lives only in component memory is lost when a worker switches to answer a call. Draft persistence (localStorage/IndexedDB) is a correctness feature on this tier, not a nicety. **[MEDIUM for aggressive eviction — [Android Go docs](https://developer.android.com/guide/topics/androidgo), [Google's Go optimization posts](https://android-developers.googleblog.com/2022/09/optimize-for-android-go-lessons-from-google-apps-part-1.html); LOW for the design consequence — inference]**

### A.4 PWA vs native at this tier

- **PWA case:** Twitter Lite (the canonical emerging-market PWA) cut data use ~70% and weighed ~600 kB — under 3% of the native app's footprint; PWAs skip store distribution (no store account, no review latency, no forced updates over metered data) and run on any modern browser including budget Androids. **[MEDIUM — widely reported case study: [brainhub](https://brainhub.eu/library/pwa-vs-native), [magicbell](https://www.magicbell.com/blog/pwa-vs-native-app-when-to-build-installable-progressive-web-app)]**
- **Native case:** reliable background execution, full hardware access, OS integration. None of these is on JENIFY's worker-flow critical path today; camera-based barcode scanning *is* available to the web platform. **[MEDIUM for the tradeoff framing — same sources; LOW for "none on critical path" — our product judgment]**
- **JENIFY-specific decider:** LOCAL. A PWA served from the factory's own node needs no Google account, no Play Store, no store tax, and updates the moment the local server updates — on the factory Wi-Fi, costing zero mobile data. A native app would reintroduce every distribution dependency the LOCAL principle forbids. **[LOW — inference from principles, but a strong one]**
- **PWA caveats to engineer around:** iOS is irrelevant here (Android ~85% of Africa mobile OS **[MEDIUM — [Statcounter](https://gs.statcounter.com/os-market-share/mobile/africa)]**), but old WebViews/browsers are not — feature-detect, and keep the service worker conservative (the current `sw.js` — cache-first static shell, network-only API — is exactly right as a foundation).

### A.5 Security risks (performance tier interacts with security)

- Old Android = old, unpatched browser engines; assume the client is the least trusted component (JENIFY already enforces permissions and financial masking server-side — that is the correct posture; keep it). **[LOW for version claim absent extracted data; HIGH that server-side enforcement is the mitigation — repo fact]**
- Anything cached on-device is exposed to loss/theft of a cheap, often unlocked phone: OWASP M2/M9 insecure data storage; the Microsoft Teams cleartext-token incident shows even majors get it wrong. Rules for us: never cache API responses in the service worker (already true), never store financial figures client-side beyond the live session, short-lived tokens, and any *future* offline queue encrypted at rest with remote revocation (R8's domain). **[HIGH for OWASP/Teams — [OWASP M2](https://owasp.org/www-project-mobile-top-10/2014-risks/m2-insecure-data-storage), [digital.ai on Teams tokens](https://digital.ai/catalyst-blog/when-local-storage-becomes-a-liability-why-data-at-rest-security-matters/); LOW for our specific rules — inference]**

### A.6 RECOMMENDED JENIFY APPROACH — performance

1. **Stay PWA, stay React — but freeze the budget in CI:** initial route ≤ 75 kB gzip JS (today ~69), any single route chunk ≤ 40 kB gzip, no new runtime dependency >10 kB gzip without Team Lead sign-off. Preact/compat is the named plan-B if React itself ever becomes the blocker — not before.
2. **Adopt a reference device class:** "2 GB RAM Android Go, entry MediaTek, 720p, 3G" — and buy 1–2 real itel/TECNO units (~$80–100 each; Founder approval needed for the purchase). Until then: Chrome DevTools 6× CPU throttle + "Slow 3G" is the merge gate for worker-facing pages.
3. **Interaction budget:** INP < 200 ms on the throttled profile for every worker action; virtualize any list that can exceed ~50 rows; paginate at the API (already the pattern).
4. **Draft persistence** for in-progress worker forms (survive tab eviction/accidental close).
5. **No CDN anything:** fonts, icons, libraries all bundled and served from the local node (Ethiopic font: §D.6).

---

## B. African mobile, device, and network realities

### B.1 Connectivity and affordability (Sub-Saharan Africa)

- Smartphone adoption in SSA: **~54% (2024), forecast 81% by 2030** — the lowest of any region; 4G is only forecast to *overtake 3G* around 2030 (~50% of connections). Plan for 3G as the normal case for years. **[HIGH — [GSMA Mobile Economy SSA 2024](https://event-assets.gsma.com/pdf/GSMA_ME_SSA_2024_Web.pdf), [GSMA Mobile Economy Africa](https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-economy/africa/)]**
- The **usage gap** (covered by a network but not using mobile internet) is ~60% — the world's largest; the binding constraints are device cost, skills, and data cost, not coverage. **[HIGH — GSMA, same sources]**
- A 4G-capable device costs **~26% of monthly GDP per capita in SSA** (vs 16% in other LMICs) — device affordability is the single largest adoption barrier. Workers will not have good phones; some will have none (see open question §E.3). **[HIGH — [GSMA smartphone adoption report](https://www.gsma.com/about-us/regions/africa/wp-content/uploads/2025/11/GSMA-SmartPhone_Adoption_Report_sm.pdf)]**
- Data cost: World Bank puts 1 GB at **2.4% of average monthly income in SSA — and ~5% for the poorest 40%**; other 2025 compilations put the continental average at ~5.7–5.8%. The sources disagree on methodology; all agree it exceeds the UN 2% affordability benchmark. **Every megabyte JENIFY sends is somebody's money.** **[MEDIUM — figures conflict across [World Bank via Kenyan Wallstreet](https://kenyanwallstreet.com/expensive-mobile-data-is-stalling-africas-digital-leap-world-bank), [Ecofin](https://www.ecofinagency.com/news/2407-47820-mobile-data-costs-still-too-high-in-sub-saharan-africa-says-world-bank), [TechAfrica News](https://techafricanews.com/2025/04/24/affordability-what-is-the-true-cost-of-digital-inclusion-in-africa/); we report the range, not one number]**

### B.2 Ethiopia specifics

- Data price is regionally cheap: **~$0.93 for 2 GB (≈$0.47/GB)** on Ethio Telecom, with Safaricom Ethiopia competing on price; pay-as-you-go 2G/3G at 0.20 Birr/MB. **[MEDIUM — [Shega on Ethio Telecom pricing](https://shega.co/news/here-are-the-new-ethio-telecom-prices-what-you-need-to-know), [technext comparison](https://technext24.com/2025/02/18/nigerias-internet-costs-and-7-countries/)]**
- Coverage: 3G covered ~98% of the population by 2023; 4G ~33% and expanding — Ethio Telecom announced 4G in **93 cities** (Dec 2025). City speeds ~8–20 Mbps down / 2–10 Mbps up where 4G exists. **[MEDIUM — [GSMA Ethiopia report](https://www.gsma.com/about-us/regions/sub-saharan-africa/wp-content/uploads/2024/10/GSMA_Ethiopia-Report_Oct-2024_v2-1.pdf), [Ethical Business](https://ethicalbusiness.africa/2025/12/16/ethio-telecom-expands-4g-coverage-to-93-cities-in-nationwide-connectivity-push/), [livingethio](https://livingethio.com/site/blog/internet-and-mobile-data-speeds-in-ethiopia-what-you-need-to-know)]**
- Devices: on Ethio Telecom's network, ~34.3 M smartphones ≈ **41.8% of connected devices — ~56% are feature phones**; a separate estimate puts smartphone penetration of the *population* as low as ~15%. The two figures measure different things; both say the same operational truth: **many Mesob-adjacent people hold feature phones, and smartphone owners hold cheap ones.** Telebirr's ~57.6 M registered users show the ceiling is high when the product respects local constraints. **[MEDIUM — conflicting bases: [Shega](https://shega.co/news/ethio-telecom-rolls-out-17-advanced-4-g-feature-phones-to-shrink-ethiopia-s-digital-divide), [ts2.tech overview](https://ts2.tech/en/inside-ethiopias-internet-boom-fiber-optics-5g-dreams-and-starlink-skies/), [ZTE release](https://www.zte.com.cn/global/about/news/ZTE-s-Signal-Reach-Program-in-Africa-advances-digital-inclusion-with-sustainable-networks-in-Ethiopia.html)]**
- **Tigray (Mesob's region):** telecom was cut for ~2 years during the war; service restoration began after the Nov 2022 peace agreement (Mekelle Dec 2022; 27 towns by Jan 2023); by Nov 2023 Ethio Telecom reported 1,800 km of fiber repaired, 466 stations restored, and 4G launched in Mekelle, Shire, Adigrat, and Axum. Infrastructure is real but young and previously war-damaged — outage resilience is not theoretical here. **[MEDIUM — [Ecofin](https://www.ecofinagency.com/telecom/0901-44164-ethio-telecom-restores-telecom-services-in-27-tigrayan-towns), [Ethiopian Monitor](https://ethiopianmonitor.com/2022/12/28/ethio-telecom-restores-telecom-services-to-mekelle-city/), [Fana](https://www.fanamc.com/english/ethio-telecom-launches-4g-internet-service-in-tigray-region/)]**
- Power: intermittent electricity and phones charged overnight or at charging kiosks are common realities in the region; we found no rigorous recent uptime statistic for Tigray specifically — **unsourced; treat as an assumption to validate with the Founder.** **[LOW — no source; flagged honestly]**

### B.3 Failure modes to design against

Connection state is not binary: expect **captive-portal Wi-Fi, 2G fallback mid-session, high-latency congested 3G, and metered data users who disable data between tasks**. An app that treats "online" as the default and "offline" as an error inverts the reality. **[LOW — inference from B.1/B.2; the architectural answer is R8's offline queue, not this report]**

### B.4 Security risks

SIM-swap and shared-phone patterns are common in mobile-money markets; device possession must never equal identity. PIN re-auth for posting actions on remembered devices, and server-side session revocation, are the mitigations (see §C.6). **[LOW — inference; mobile-money precedent MEDIUM via M-PESA/Telebirr PIN norms]**

### B.5 RECOMMENDED JENIFY APPROACH — network reality

1. **Design point = congested 3G, not 4G:** every worker flow must complete acceptably at ~1 Mbps / 300 ms RTT. Factory floor primary transport should be the **local node over LAN/Wi-Fi (zero mobile data, zero telecom dependency)** — mobile data is the fallback, not the plan. This is LOCAL working *for* the mandate.
2. **Data budget per workflow:** a full worker shift (≈30 transactions) should cost **< 2 MB** of transfer after first load; the PWA shell is cached so day-2 load is near-zero. Measure and log payload sizes per endpoint in dev.
3. **No images/logos/fonts on transactional paths** beyond the cached shell; JSON responses paginated and field-trimmed for list views.
4. **Visible connection state + queued-write UX** are the UX contract for R8's offline work: a worker must always know "saved on device" vs "posted to server", in words and color.

---

## C. Mobile ERP/POS UX patterns

### C.1 What wins in African/emerging-market apps

- **M-PESA Super App (Kenya):** shipped an explicit **offline mode** ("complete transactions even without data bundles"), mini-apps, and biometric/PIN confirmation for transactions — the region's dominant financial UX assumes intermittency and confirms every money-moving action. **[MEDIUM — [Safaricom press release](https://www.safaricom.co.ke/media-center-landing/press-releases/safaricom-launches-m-pesa-super-app-with-offline-mode-and-mini-appss), [TechCabal](https://techcabal.com/2021/06/25/safaricom-launches-m-pesa-super-app-with-offline-mode-mini-apps/)]**
- **Wave (Senegal/Côte d'Ivoire):** ~23 M users won with radical simplicity — QR codes instead of menu trees, near-zero fees, one clear action per screen, backed by human agents for onboarding. Lesson: in low-digital-literacy markets, **simplicity plus a human fallback beats feature count**. **[MEDIUM — [PanAfrican Visions](https://panafricanvisions.com/2026/05/how-wave-built-a-23-million-user-fintech-empire-in-africa/), [TriplePundit](https://triplepundit.com/2025/wave-mobile-money-cote-divoire/), [African Business](https://african.business/2023/04/technology-information/senegal-is-experiencing-mobile-money-revolution-says-waves-west-africa-director)]**
- **Khatabook / OkCredit (India, the ledger-app model closest to JENIFY's book-keeping heart):** succeeded by **digitizing an existing habit (the khata) rather than teaching accounting**; OTP-only signup, offline-friendly design, regional-language UI, SMS payment reminders. Tier-2/3 merchants adopted without training. **[MEDIUM — [miracuves](https://miracuves.com/blog/what-is-khatabook-and-how-does-it-work/), [Slant POS comparison](https://blog.slantco.com/khatabook-vs-okcredit-indias-bookkeeping-apps-compared/)]**
- **Telebirr (the app Mesob staff most likely already use):** praised for Amharic/Tigrinya/Oromo support, criticized for cramped layouts and small fonts — Ethiopian users prefer spacious layouts and larger type. This is the local floor and the local warning. **[MEDIUM — carried over from R5 §2.2, [UX review](https://biruksidea.medium.com/ethiotelecom-tele-birr-ui-ux-design-review-part-1-a877011fd5ee)]**

### C.2 The mechanical patterns (standards-grade)

- **Touch targets:** Material Design 48×48 dp with ≥8 dp spacing; WCAG 2.2 AA floor is 24×24 CSS px, AAA/Apple 44 px; average fingertip 16–20 mm, and small targets raise error rates sharply. **JENIFY today: `.btn-sm` min-height 28 px, `.btn` 34 px, bumped to 40 px under 900 px (`styles.css:340,425-426`) — all below the 48 px worker-glove bar.** **[HIGH for standards — [Material/Android](https://support.google.com/accessibility/android/answer/7101858?hl=en), [WCAG 2.5.8 guide](https://testparty.ai/blog/wcag-target-size-guide), [LogRocket summary](https://blog.logrocket.com/ux-design/all-accessible-touch-target-sizes/); HIGH for our own CSS — repo fact]**
- **Bottom navigation** with ≤5 destinations in the thumb zone is the mobile-app norm (vs the desktop sidebar-drawer JENIFY currently shows under 900 px). **[MEDIUM — Material convention plus thumb-zone research summarized in the target-size sources above; no single canonical citation pulled]**
- **Cards, not tables, on phones:** the consensus responsive pattern converts each row to a card — key field as title, status and one primary action prominent, detail on tap. Horizontally scrolling tables (JENIFY's current `table-wrap`) are the documented last resort. **[MEDIUM — practitioner consensus: [Pencil & Paper table UX](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables), [appnroll 5 solutions](https://medium.com/appnroll-publication/5-practical-solutions-to-make-responsive-data-tables-ff031c48b122), [lightit](https://lightit.io/blog/responsivetables/)]**
- **Scan/lookup-first entry:** keyboard entry errs ~1 in 300 keystrokes; barcode scanning practically eliminates entry error (vendor-cited "1 in 36 trillion" — treat as marketing, but the direction is uncontested) and well-designed scan workflows reduce fatigue-driven mistakes. Camera scanning works in the browser; no scanner hardware exists at Mesob yet, so the pattern to adopt *now* is **lookup-first**: type-3-letters → pick from short list, never free-type an item/customer name. **[MEDIUM for error rates — [Dynamics Mobile](https://www.dynamicsmobile.com/insights/barcode-scanning-best-practices-eliminating-picking-errors-in-your-warehouse), [Lowry](https://lowrysolutions.com/blog/8-common-warehouse-challenges-solved-by-barcode-scanning-systems/); LOW for the Mesob-specific staging — inference]**
- **Role-specific home screens and quick actions** are fully argued in R5 (SAP Fiori's own 1-user/1-use-case/≤3-screens rule; POS zero-training bar; approvals inbox). This report adds only the mobile shape of those conclusions. **[HIGH that R5 documents this — repo fact]**

### C.3 Failure modes (what to refuse to build)

1. **Responsive-shrunk desktop** (JENIFY's current ≤900 px mode is exactly this — R5 §3.2-5): drawer nav + pinch-scroll tables + 28 px buttons is unusable with wet, gloved, or hurried hands. **[HIGH — repo fact + standards above]**
2. **Deep menu trees on mobile.** Odoo/ERPNext's module-first navigation transplanted to a phone produces the days-long onboarding JENIFY exists to beat (R5 §2.6). **[MEDIUM — carried from R5 citations]**
3. **Modal-heavy flows.** Modals on small screens with software keyboards cause scroll-trap and lost input; prefer full-screen steps with a sticky primary button. **[LOW — practitioner consensus, no single citation]**
4. **Super-app drift.** Telebirr's own reviewers flag its growing clutter; JENIFY worker mode must stay a verb list even as the platform grows — complexity is a permission (R5 corollary 5). **[MEDIUM/LOW]**

### C.4 Security risks

- **Shared/loaned phones and walk-away sessions:** a phone left on a sack pile with a live session is an audit-trail killer (R5 §3.2-7 flagged the shared-terminal version). Mitigations: short idle re-lock with **PIN fast-unlock** (full password only on cold login), one-tap user switching on shared devices, server-side device/session revocation list. **[LOW for specifics — inference; MEDIUM that PIN-per-transaction is the regional norm — M-PESA/Telebirr precedent above]**
- **Confirm-before-post is a security control, not only UX:** the M-PESA mandatory confirmation screen (action + amount + counterparty + cancel) before anything moves is already JENIFY practice for money/stock — keep it sacred on mobile even when it costs a tap. **[HIGH — carried from R5 §2.2 verified sources]**
- Financial masking stays server-side (`maskMoney`/`stripFinancial`) — the simplified worker UI must never be the only thing hiding money. Already true; protect it. **[HIGH — repo fact]**

### C.5 Performance implications

Card lists render fewer DOM nodes than wide tables; bottom-nav + role homes cut navigation round-trips (fewer route chunks fetched over 3G); lookup-first entry replaces large dropdown payloads with tiny search queries. The simple UI *is* the fast UI on this tier. **[LOW — inference, consistent with §A budgets]**

### C.6 RECOMMENDED JENIFY APPROACH — worker mode

1. **A "worker mode" UI profile, not a second app:** same React app, same routes, same permissions — a per-role presentation profile (extending R5's role homes / `dashboardFocus`) that switches phone-width worker roles to: **bottom nav of ≤5 verbs** (warehouse: RECEIVE · MOVE · ISSUE · COUNT · LOOKUP), full-screen step flows, card lists, 48 px minimum targets (56 px primary buttons), numerals-first display. Office/desktop roles keep the current shell. Core-vs-config: the verb set per role is **tenant configuration**, not code.
2. **One verb = one screen = one confirm.** Every posting flow ends in an M-PESA-style confirmation (what, how much, where, who) with a full-width POST button and an explicit cancel.
3. **Lookup-first everywhere** (items, customers, locations): search-as-you-type against indexed short lists; design the input row so a future camera/bluetooth scan drops into the same field (scan-ready shape now, scanner hardware later).
4. **Session model for phones:** 8–12 h session + 2–5 min idle screen-lock with 4-digit PIN unlock; posting actions always re-attributed to the unlocked user; Founder-visible device list with revoke.
5. **Do not build:** offline queue UI before R8's architecture lands; camera scanning before a barcode/label decision exists; any worker-mode feature that requires new server business rules (this profile is presentation + config only).

---

## D. Multilingual mobile UX (Amharic · Tigrinya · future Arabic)

### D.1 Script facts that shape the UI

Ethiopic (Ge'ez script, used by both Amharic and Tigrinya) **[HIGH — [r12a Amharic orthography notes](https://r12a.github.io/scripts/ethi/am), the authoritative i18n reference]**:

- **Left-to-right**, alphabetic baseline — no bidi work needed for Ethiopic itself.
- **No letter case.** CSS `text-transform: uppercase` is a no-op; any design language that encodes meaning in ALL-CAPS (buttons, table headers) silently loses that channel in Amharic/Tigrinya. Use weight/size/color instead.
- **A syllabary of 450+ characters** (each glyph = consonant+vowel); minimal shaping/contextual complexity, so rendering is technically straightforward — the cost is font coverage and legibility, not shaping engines.
- **Modern text is space-separated and wraps word-by-word without hyphenation**; the traditional wordspace `፡` still appears, and native punctuation (`።` full stop, `፣` comma, etc.) is in live use. Line-break rules forbid certain punctuation at line start.
- **Western (ASCII) digits are standard** in contemporary text — quantity/money entry and display can stay purely numeric across all three languages. This is a gift to worker-mode design: numerals are the universal layer (R5 §2.2's literacy findings).

### D.2 Fonts and legibility on low-res screens

- **Noto Sans Ethiopic** is the reference UI font: 9 weights + variable, designed for screen legibility, full Ethiopic Unicode coverage ("no tofu"). **[HIGH for the font's existence/coverage — [Google Fonts specimen](https://fonts.google.com/noto/specimen/Noto%2BSans%2BEthiopic), [Noto docs](https://notofonts.github.io/noto-docs/specimen/NotoSansEthiopic/); MEDIUM for legibility claims — the foundry's own documentation]**
- Android generally ships Noto fonts for major scripts, so Ethiopic text usually renders on modern Android without shipping a font — but **we found no authoritative statement of which Android versions/OEM builds include Ethiopic coverage**, and cheap OEM builds strip fonts. JENIFY already lists `'Noto Sans Ethiopic', 'Nyala'` in its stack (`styles.css:24`) but does not ship the font — rendering quality is currently at the mercy of each device. **[LOW for universal Android coverage — unsourced; HIGH for our own CSS — repo fact]**
- Many fidel forms are distinguished by small strokes, leg-length differences, and tiny ring marks; at small sizes on 720p screens these distinctions blur. Telebirr is criticized locally for exactly this (small fonts, cramped layout — §C.1). **We found no published minimum-size study for Ethiopic on screen** — the sizes below are engineering judgment to be validated with Mesob staff. **[LOW — honest gap; MEDIUM for the Telebirr criticism]**

### D.3 Label length: Amharic/Tigrinya vs English

**No published corpus comparison of Amharic/Tigrinya vs English UI-string lengths was found — we state that plainly rather than invent a ratio.** **[LOW — absence of source]** What we can ground:

- Because each Ethiopic glyph carries a whole syllable, character *counts* are typically lower than Latin for the same word, but each glyph is wider and visually denser, so **rendered width is not predictable from character count**. **[LOW — inference from script structure, HIGH-sourced structure via r12a/omniglot]**
- Localization practice for unknown-expansion languages is settled: flexible containers, wrap-not-truncate, no fixed-width labels, `min-height` not `height`, and **pseudo-localization testing before translation**; German's 30–50% expansion is the standard stress case to design headroom for. **[HIGH for the practice — [POEditor](https://poeditor.com/blog/text-expansion-and-contraction-localization/), [SimpleLocalize](https://simplelocalize.io/blog/posts/text-expansion-ui-localization/), [LocaleProof cheat sheet](https://localeproof.com/blog/text-expansion-by-language/)]**
- JENIFY has a live advantage: the translations table is already in the product (`/api/translations`, Settings → Languages). Once real Amharic/Tigrinya strings land (roadmap T8), we can **measure our own expansion ratios on our own labels** — the only ratio that matters. **[HIGH — repo fact]**

### D.4 Input methods

- Ethiopic's 450+ characters make phone keyboards genuinely hard; the dominant solutions are phonetic/SERA transliteration (type Latin, get fidel) and predictive fidel keyboards — Gboard supports Amharic, and third-party keyboards (FynGeez, Mela, Keyman) are widespread. Typing speed and confidence vary enormously between users. **[MEDIUM — [academic virtual-keyboard paper](https://www.academia.edu/4142320/The_%E1%88%80%E1%88%88%E1%88%90_Virtual_Ethiopic_Keyboard_for_Smart_Phones), [Keyman](https://keyman.com/en/keyboards/h/amharic/), [typeamharic](https://www.typeamharic.com/how-to-write-amharic-on-computer-keyboard-android-and-iphone)]**
- **Design consequence [LOW — inference, but central]:** worker mode should be designed so that a worker can complete a full shift **without typing a single Ethiopic character** — pickers, lookup lists, numerals, and yes/no confirms carry the flow; free-text (notes, reasons) accepts whatever keyboard the user has and is never required for posting.
- Search/normalization must accept both ASCII space and Ethiopic wordspace `፡`, and both `.` and `።`, when matching names — a Tigrinya-typed customer name must be findable. **[LOW — inference from D.1 script facts]**

### D.5 RTL readiness (future Arabic country packs)

- Ethiopic is LTR; the RTL requirement is entirely about the roadmap (Arabic-speaking markets). The settled architecture: **CSS logical properties** (`margin-inline-start`, `padding-inline-end`, `inset-inline-*`) + `dir` attribute on the root, which by practitioner estimate handles ~80% of RTL adaptation automatically; branch on `direction === 'rtl'`, never `locale === 'ar'`; maintain an icon-mirroring policy (arrows mirror; objects don't). **[MEDIUM — [better-i18n RTL guide](https://better-i18n.com/en/blog/rtl-support-css-react-guide/), [Untitled UI RTL docs](https://www.untitledui.com/react/docs/rtl), [logical-properties overview](https://medium.com/@dimuthupinsara/mastering-rtl-ltr-layouts-with-css-logical-properties-4bc0fccd2014)]**
- Adopting logical properties **now**, while `styles.css` is one small file, is nearly free; retrofitting after ten more modules is a rewrite. This is FLEXIBLE applied to CSS. **[LOW — inference]**

### D.6 RECOMMENDED JENIFY APPROACH — multilingual mobile

1. **Ship Noto Sans Ethiopic with the app** (WOFF2, Regular + Medium subset to the Ethiopic block, served from the local node and cached by `sw.js` — LOCAL, no Google Fonts at runtime; subset size to be measured against the byte budget before adoption). Keep the current system-font stack as fallback.
2. **Type scale for Ethiopic:** body ≥16 px, worker-mode primary text 18–20 px, line-height ≥1.6, never render Ethiopic below 14 px; validate with Mesob staff on the reference device (D.2's honest gap becomes a field test, not a guess).
3. **Case-free design language:** remove any reliance on capitalization for hierarchy; headers/buttons differentiate by weight and size so English and Amharic look equally structured.
4. **Wrap, never truncate, worker-facing labels**; pseudo-locale stress build in dev; once T8 translations land, run a label-width audit on the 50 most-used keys and fix layouts, not translations.
5. **Zero-required-Ethiopic-typing rule** for worker mode (D.4); search normalizes `፡`/`።`/spacing variants.
6. **Adopt CSS logical properties now**; add `dir="ltr"` explicitly at the root and an icon-mirroring convention, so the first Arabic country pack is a translation + `dir` flip, not a re-layout.

---

## E. Cross-cutting: budgets, test matrix, open questions

### E.1 The budgets (proposed as CI/merge gates)

| Budget | Value | Basis |
|---|---|---|
| Initial JS (gzip) | ≤ 75 kB (today ~69) | §A.2 — well inside the 0.62 MiB/3 s ceiling with 8× headroom for the low-end reality below global P75 |
| Any route chunk (gzip) | ≤ 40 kB | §A.2 |
| Worker-shift data transfer | < 2 MB / ~30 transactions | §B.1 data-cost evidence |
| INP (6× CPU throttle) | < 200 ms | §A.6 |
| Touch targets (worker mode) | ≥ 48 px, primary ≥ 56 px | §C.2 standards |
| Ethiopic body text | ≥ 16 px, lh ≥ 1.6 | §D.6 (to be field-validated) |

### E.2 Minimum test matrix

Chrome DevTools 6× CPU + Slow 3G (every worker-facing PR) · one real itel/TECNO reference device (pending Founder purchase approval) · Amharic + Tigrinya pseudo/real locale render pass · 360×640 and 360×800 viewports.

### E.3 Open questions for the Founder (never fabricated, so asked)

1. **What phones do Mesob staff actually carry?** (Model/RAM inventory — one hour of asking beats every statistic in §B.) Do warehouse/production workers have personal smartphones at all, or does Mesob provide shared devices?
2. Approval to purchase 1–2 reference devices (~$100 each)?
3. Is factory Wi-Fi coverage planned for the yard/warehouse (making LAN the worker transport per §B.5), and what is the realistic power/outage pattern at the site (§B.2's unsourced assumption)?
4. Barcode/label printing ambitions and timeline (decides when scan-first upgrades from "input shape" to "feature")?
5. T8 translation completion: who authors the Amharic/Tigrinya strings we will measure and field-test against (§D.3)?

### E.4 Sequencing note (for the Team Lead, not a milestone plan)

The cheapest high-value order implied by this report: role homes + quick actions (R5, still unbuilt) → worker-mode presentation profile + touch/typography fixes (§C.6, §D.6) → shipped Ethiopic font + logical-properties refactor (§D.6) → R8 offline queue → scan hardware. Each step is independently shippable and none touches server business rules. **[LOW — our recommendation, Founder decides]**
