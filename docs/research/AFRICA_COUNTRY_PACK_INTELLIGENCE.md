# JENIFY AFRICA COUNTRY PACK INTELLIGENCE REPORT

**Workstream:** R3 — Country Pack / Localization research (research only, no code)
**Author:** jenify-country-localization (with jenify-product-research rules applied)
**Date:** 2026-08-21 · All web sources accessed 2026-08-19/21 unless noted
**Status:** Intelligence input for Team Lead — NOT an implementation spec

---

## 0. How to read this report

**Confidence labels** on findings:

| Label | Meaning |
|---|---|
| **HIGH** | Multiple recent, independent sources agree |
| **MED** | Single credible source, or recent but secondary sources |
| **LOW** | Conflicting, dated, or thin sourcing — treat as a lead, not a fact |

**`[VERIFY-LOCAL]`** — mandatory marker on EVERY tax / legal / compliance / payroll item in
this report. Per the R3 critical rule: **no tax or legal finding here may be implemented as
behavior.** Each such item needs confirmation by a local accountant/lawyer or the revenue
authority's primary text before any JENIFY pack encodes it. Where this report and local
counsel disagree, local counsel wins. VAT/tax behavior is additionally **Founder-approval
territory** (localization agent rule 2).

**Country-pack framing.** A JENIFY country pack = configuration + adapters (translations,
currency/FX config, document templates, calendar/format settings, payment-adapter
implementations, tax-adapter implementations, payroll extension config) packaged like a
tenant/sector template. Nothing in this report implies `if (country === 'XX')` logic in core.
Ethiopia is live (ETB, Ethiopian calendar display-only, Amharic/Tigrinya, Africa/Addis_Ababa).

**The single most important structural finding up front:** in 8 of the 10 countries studied,
invoicing software is (or is about to become) a **government-certified, government-connected
component** — Kenya eTIMS, Ethiopia Directive 1142/2026, Rwanda EBM/CIS, Ghana E-VAT/CIS,
Uganda EFRIS, Tanzania VFD, Egypt ETA, Morocco DGI/Simpl-TVA, Nigeria FIRSMBS. A country pack
is therefore not just "config + adapters" — for most target countries it includes a
**regulatory certification/integration project** with the revenue authority (accreditation,
Developer IDs, sandbox testing, digital signatures). This changes pack cost estimates and
build order, and it is also JENIFY's moat once done: certified local compliance is exactly
what QuickBooks/Xero-class imports lack.

---

## 1. ETHIOPIA 🇪🇹 (LIVE — tenant #1 country)

**Snapshot:** ~120M people; JENIFY's home market; cash-heavy, state-led digitization
accelerating fast (Telebirr, e-invoicing directive). Already live in JENIFY.

**Languages & scripts**
- Amharic (working language, **Ethiopic/Geʽez script**), Tigrinya (Ethiopic), Afaan Oromo
  (Latin), Somali (Latin), English in formal business. **No RTL.** (HIGH — stable fact)
- Ethiopic script needs proper font coverage (e.g., Noto Sans Ethiopic) in PDFs/print — already
  proven in JENIFY. Geʽez numerals exist but are not used in business documents. (HIGH)

**Currency & FX**
- ETB, floating since 29 Jul 2024 (NBE reform). Official rate ≈ **158–162 ETB/USD** with a
  parallel market ≈ 180+ (Jul 2026); continued depreciation, NBE FX auctions ongoing.
  (HIGH — [Addis Insight](https://addisinsight.net/2026/08/01/two-years-of-the-float-2-65b-in-imf-funding-24-nbe-auctions-and-a-birr-that-keeps-sliding/),
  [worlddata.info](https://www.worlddata.info/currencies/etb-ethiopian-birr.php))
- Implication: JENIFY's snapshot-rate model (accounting in tenant default currency; foreign
  amounts converted once at a stored rate) is the right call — but rate staleness matters at
  this depreciation speed; packs should encourage frequent manual rate updates. Official vs
  parallel spread is a business reality JENIFY must not paper over (tenant chooses its rate).

**Payments & mobile money**
- **Telebirr** (Ethio Telecom): ~58.6M users, 6.88T ETB cumulative transactions — dominant.
  **M-Pesa Ethiopia** (Safaricom): ~5.2M active users, negligible revenue share so far.
  EthSwitch provides interbank/wallet interoperability. (HIGH —
  [Addis Insight](https://addisinsight.net/2026/01/29/ethio-telecom-customer-base-reaches-87-1-million-as-telebirr-transactions/),
  [Kenyan Wall Street](https://kenyanwallstreet.com/telebirr-m-pesa-analysis))
- `[VERIFY-LOCAL]` **Cash payment cap: payments above ETB 30,000 must go through bank/cheque/
  NBE-approved channels** (introduced with the 2025 income tax amendment). Confidence MED
  ([Workpay](https://www.myworkpay.com/blogs/ethiopia-new-income-tax-law-2025), Jul 2025).
  If confirmed, JENIFY payment recording could *warn* (not block) on large cash entries —
  Founder decision.
- Pack adapters to design for (architecture only, no live integration without Founder
  approval): Telebirr, CBE Birr, EthSwitch rails.

**Banking**
- State-dominated: CBE is by far the largest; private banks (Awash, Dashen, Abyssinia, etc.)
  growing. Sector opening to foreign banks under 2024 banking reform. (MED) Bank statements/
  reconciliation are largely manual — CSV import is the realistic integration level.

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT **15%** under Proclamation **1341/2024** + implementing **Regulation 570/2026**.
  (HIGH — [Taxdo](https://taxdo.com/resources/countries/am/ethiopia), Kiya & Associates)
- **E-invoicing Directive No. 1142/2026** (Ministry of Revenues): self-contained 31-article
  regime; only **Ministry-authorized sales-registration software** may issue invoices; API
  integration with the Ministry platform; an annex lists **26 business sectors for which
  offline resilience is mandatory** (a striking, JENIFY-friendly design); go-live reported
  imminent in 2026. (MED-HIGH —
  [Kiya & Associates](https://kiyalaw.com/insights/ethiopia-e-invoicing-directive-1142-2026/),
  [Eagle Advocates](https://eagleadvocates.com/ethiopia-electronic-invoicing-system-directive-1142/),
  [The Reporter](https://www.thereporterethiopia.com/36959/)). Exact effective dates, phase
  thresholds, invoice field/QR specs, and the authorization procedure for software vendors are
  **not yet pinned down — top-priority open question for the live tenant.**
- Income tax amendment **Proclamation 1395/2025** (effective 1 Jul 2025): monthly exemption
  raised to ETB 2,000; six brackets; lowest rate 15%; top 35% above ETB 14,000/month; new
  **Minimum Alternative Tax 2.5% of turnover**. (HIGH —
  [EY](https://www.ey.com/en_gl/technical/tax-alerts/ethiopia-issues-a-new-income-tax-proclamation),
  [Chambers](https://chambers.com/articles/what-s-changed-under-ethiopia-s-new-income-tax-amendment-proclamation-no-1395-2025))
  **Action check:** confirm whether the current Mesob payroll/tax config already reflects the
  1395/2025 brackets.
- Turnover tax for non-VAT-registered businesses and withholding rules exist — rates under the
  new proclamations not verified here. (LOW)

**Invoice & document conventions**
- Bilingual Amharic/English invoices common; TIN of seller (and often buyer), sequential
  numbers, VAT shown separately; fiscal-printer receipts historically required in retail.
  (MED, `[VERIFY-LOCAL]` for mandatory fields under Directive 1142/2026)

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- PAYE per 1395/2025 above; private-sector pension ~7% employee + 11% employer (Proc.
  715/2011 lineage). (MED) Labour Proclamation 1156/2019 governs leave/termination. (MED)

**Dates, numbers, calendars**
- Ethiopian calendar (13 months, New Year ≈ 11 Sep, ~7–8 year offset) — **already supported
  in JENIFY as display-only**. Gregorian dd/mm/yyyy also used. Decimal point, comma thousands.
  Timezone Africa/Addis_Ababa (no DST). (HIGH)

**Devices, connectivity, power**
- Low smartphone penetration; Ethiopia is one of six GSMA **$30–40 affordable-handset pilot
  countries (2026)** alongside DRC, Nigeria, Rwanda, Tanzania, Uganda. (HIGH —
  [GSMA](https://www.gsma.com/newsroom/press-release/pioneering-affordable-access-in-africa-gsma-and-handset-affordability-coalition-members-identify-six-african-countries-to-pilot-affordable-40-smartphones/))
- Connectivity: Ethio Telecom + Safaricom ET; outages and periodic shutdown risk; frequent
  power cuts. **JENIFY's local-first architecture is a structural advantage here.** (HIGH)

**Cloud & hosting**
- No hyperscaler region. Wingu operates local data-center capacity (~15 MW); more announced.
  (MED — [Console Connect report](https://blog.consoleconnect.com/powering-africas-digital-future-the-rise-of-cloud-data-centres-and-network-resilience))
  Data-residency preference is strong in practice.

**Software landscape**
- Legacy Peachtree/Sage 50 habit in accounting; HansaWorld (via Addis Software); local ERPs:
  ZalaTech, Marakisoft, Addis Software; Odoo/ERPNext implementers emerging. (MED —
  [ZalaTech](https://zalatechs.com/exploring-the-current-erp-software-development-trends-in-ethiopia/),
  [Addis Software](https://addissoftware.com/products/accounting-and-finance-erp/))
  No dominant modern SME cloud product → open field for JENIFY.

**Messaging channels**
- **Telegram is unusually dominant in Ethiopia** (business groups, file sharing), alongside
  WhatsApp; SMS still essential for notifications. (MED) Pack notification design should not
  assume WhatsApp-first here.

**Implementation reality & pack implications**
- Manual records, cash culture, training-intensive onboarding — already known from Mesob.
- **The e-invoicing directive is the #1 watch item:** JENIFY may need Ministry authorization
  as invoicing software for its own home market. Recommend Team Lead commissions a legal read
  of Directive 1142/2026 (Amharic original) before any invoice-module changes.

---

## 2. KENYA 🇰🇪

**Snapshot:** ~55M people; Africa's most sophisticated SME-payments market; compliance-tech
(eTIMS) and M-Pesa integration are table stakes for business software. Natural pack #2.

**Languages & scripts**
- English + Swahili co-official; business software runs in English; Swahili UI is a
  differentiator for micro-SMEs. Latin script only, **no RTL**. (HIGH)

**Currency & FX**
- KES ≈ **129.5/USD** (Aug 2026); stable since 2024. (HIGH —
  [exchange-rates.org](https://www.exchange-rates.org/exchange-rate-history/usd-kes-2026))
  Low FX drama → simple currency config.

**Payments & mobile money**
- **M-Pesa is the economy's payment rail:** FY2026 (to Mar 2026) — **KES 41.68T across 46.4B
  transactions; 40M+ monthly active users; ~89% mobile-money share.** Business products: Lipa
  na M-Pesa (Buy Goods/Till, Paybill, Pochi la Biashara). (HIGH —
  [Veira statistics](https://veirahq.com/statistics/mpesa-mobile-money-statistics-kenya),
  [Veira Lipa guide](https://veirahq.com/blog/lipa-na-mpesa/))
- **Pesalink** (bank instant rail) turned aggressive in 2026: 19 banks cut fees — free ≤ KES
  1,000, flat KES 20 up to 999,999 — now a real business-payment alternative. (HIGH —
  [People Daily](https://peopledaily.digital/insights/pesalink-vs-m-pesa-charges-which-is-cheaper-in-2026-after-19-banks-slash-transfer-fees))
- Pack adapters: M-Pesa (C2B confirmation/STK-push architecture), Pesalink, bank CSV import.
  Safaricom Daraja API is well documented — good first non-Ethiopian payment adapter target.

**Banking**
- Deep, competitive: Equity, KCB, Co-op, NCBA, Absa KE etc.; mature internet/mobile banking;
  fintech-dense. Statement export culture exists → reconciliation import is feasible early. (HIGH)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT standard **16%**. (HIGH — PwC Tax Summaries)
- **eTIMS is mandatory and enforced, and applies beyond VAT-registered businesses** (any
  person carrying on business). Fully live B2B/B2C/B2G with (near) real-time reporting to KRA.
  Invoice must carry seller KRA PIN, timestamps, unique invoice identifiers, **QR code**, and
  buyer PIN when the buyer wants input-VAT/expense claims. Integration models: OSCU (online)
  / VSCU (virtual, supports offline batching). (HIGH —
  [vatit](https://vatit.com/e-invoicing-guide/kenya/),
  [Veira eTIMS fields](https://veirahq.com/blog/etims-invoice-requirements/),
  [Pagero](https://www.pagero.com/compliance/regulatory-updates/kenya))
- **Since 1 Jan 2026 KRA cross-validates declared income/expenses against eTIMS/TIMS data,
  withholding records and customs data** — non-eTIMS invoices are becoming worthless for
  deductions; eTIMS registration now also gates Tax Compliance Certificates. (HIGH —
  [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2025/12/tnf-kenya-requirements-for-obtaining-tax-compliance-certificate.html),
  [PKF](https://www.pkfea.com/media/wxgnftjw/kenya-tax-alert-etims-2025-dec-02.pdf))
- Finance Act 2025: tax invoice required at time of supply for **all** supplies (taxable or
  not). (MED — [Ramco compliance summary](https://www.ramco.com/payce/payroll-compliance-kenya))
- **A Kenya pack without certified eTIMS integration is not a viable product.** JENIFY would
  need to build/certify an eTIMS integration (OSCU/VSCU) — treat as a distinct sub-project.

**Invoice & document conventions**
- eTIMS-controlled: KRA control numbers + QR; "ETR receipt" vocabulary persists from the old
  fiscal-printer era. PIN on documents everywhere. (HIGH, spec details `[VERIFY-LOCAL]`)

**Payroll & employment (indicative, `[VERIFY-LOCAL]`) — Kenya payroll churns yearly**
- PAYE bands 10%→35% (top band above KES 800k/month). (MED)
- **SHIF** (replaced NHIF Oct 2024): 2.75% of gross, min KES 300, no cap; one 2026 source
  reports a new employer-side 1.375% contribution — **conflicting, LOW confidence, verify
  carefully**. ([helloduty](https://helloduty.com/blogs/pay-as-you-earn-paye-kra-the-ultimate-guide))
- **NSSF year-4 (Feb 2026):** LEL 9,000 / UEL 108,000; max KES 6,480 employee + 6,480
  employer. (HIGH — [payecalculator.co.ke](https://www.payecalculator.co.ke/statutory-changes))
- Affordable Housing Levy: 1.5% employee + 1.5% employer. (HIGH)
- Lesson: Kenya payroll must be **versioned configuration** (JENIFY's append-only settings
  model fits) — statutory parameters change every February lately.

**Dates, numbers, calendars**
- dd/mm/yyyy, decimal point, comma thousands, Gregorian only, Africa/Nairobi (no DST). (HIGH)

**Devices, connectivity, power**
- Relatively high smartphone use; good 4G in population centers; power largely reliable with
  occasional outages; Nairobi is a regional tech hub. (HIGH) Offline-first still valued
  outside cities.

**Cloud & hosting**
- Strongest East African cloud story: ~18 data centers (Nairobi Tier III/IV: Digital Realty,
  iXAfrica, PAIX, Safaricom Cloud); Microsoft/G42 geothermal DC (100 MW target); AWS local
  zone planned. (MED-HIGH —
  [Console Connect](https://blog.consoleconnect.com/powering-africas-digital-future-the-rise-of-cloud-data-centres-and-network-resilience))
  Cloud-hosted JENIFY would be acceptable here; local-first remains a differentiator upcountry.

**Software landscape (competitors)**
- QuickBooks (weak on eTIMS — needs manual work), Sage, Tally (trade/distribution), Zoho Books
  (eTIMS-ready), ERPNext with M-Pesa + KRA integrations, local ZYNO Books (native eTIMS +
  M-Pesa sync). (MED —
  [elitemindz](https://elitemindz.co/blog/best-accounting-software-kenya),
  [Frappe/ERPNext Kenya](https://frappe.io/erpnext/kenya),
  [itkenya](https://itkenya.com/quickbooks-vs-erpnext-kenya/))
- Read: crowded but shallow — locals win on compliance, globals on polish. JENIFY's angle:
  **operations + manufacturing depth + offline + compliance in one**, not accounting-only.

**Messaging channels**
- WhatsApp ~97% of internet users — highest in Africa; SMS remains the OTP/notification
  backbone (Africa's Talking API culture). (MED-HIGH —
  [askyazi](https://www.askyazi.com/useful-data-sources-for-africa/whatsapp-usage-across-africa-key-statistics-insights-for-2025))

**Implementation reality & pack implications**
- Sophisticated buyers, price-sensitive, expect M-Pesa + eTIMS out of the box; strong local
  accountant/consultant channel to partner with. Pack = Swahili translations (optional), KES
  config, eTIMS adapter (certified), M-Pesa adapter, Kenya payroll config. **Highest-value
  next pack, but the eTIMS certification is the critical path.**

---

## 3. NIGERIA 🇳🇬

**Snapshot:** ~225M people, Africa's largest market; brand-new tax code effective Jan 2026;
massive fintech rails; unreliable grid; enormous SME base running on WhatsApp + POS agents.

**Languages & scripts**
- English official (business standard); Hausa/Yoruba/Igbo major; Nigerian Pidgin lingua
  franca. Latin script; **no RTL needed in practice**. (HIGH)

**Currency & FX**
- NGN ≈ **1,349–1,393/USD** (Aug 2026), floating since mid-2023; volatility moderated vs
  2023–24 but history argues for conservative FX design. (HIGH —
  [Wise](https://wise.com/us/currency-converter/usd-to-ngn-rate/history)) Parallel-market
  spread now small. Snapshot-rate model fine; expect tenants quoting USD prices internally.

**Payments & mobile money**
- **NIBSS NIP**: ~11B transactions in 2024; a next-gen **Nigeria Payments System (NPS,
  ISO 20022)** is being phased in to replace NIP. (HIGH —
  [NIBSS](https://nibss-plc.com.ng/nibss-instant-payment/),
  [Ecofin](https://www.ecofinagency.com/news-finances/1111-50352-nigeria-launches-national-payment-stack-targets-faster-digital-transactions))
- Fintech wallets at national scale: **OPay 50M+ users, ~$12B monthly volume; PalmPay 35M+
  users, ~15M daily transactions, 1M+ agents.** POS agent networks bridge the cash economy.
  Cards weak; bank-transfer-at-checkout is the norm. (HIGH —
  [Technext](https://technext24.com/2026/03/25/opay-palmpay-infrastructure-gaming-boom/),
  [NIBSS/PalmPay](https://nibss-plc.com.ng/palmpay-integrates-with-nibss-for-reliable-transactions-reaches-35m-users/))
- Pack adapters: bank-transfer reconciliation (NIP references), OPay/PalmPay/Paystack/
  Flutterwave-style collection adapters (architecture only).

**Banking**
- Big, sophisticated banks (Access, Zenith, GTBank, UBA, First Bank); heavy CBN regulation;
  BVN/NIN identity layers; corporate internet banking mature. (HIGH)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- **Nigeria Tax Act 2025 + Tax Administration Act 2025 effective 1 Jan 2026** (old VAT Act
  repealed). VAT stays **7.5%**; food, healthcare, education, rent, transport zero-rated or
  exempt; input-VAT recovery broadened to services and fixed assets; "small company" CIT
  exemption tightened to ≤ ₦50M turnover (≤ ₦250M fixed assets). (HIGH —
  [EY](https://www.ey.com/en_gl/technical/tax-alerts/nigeria-tax-act-2025-has-been-signed-highlights),
  [BDO](https://www.bdo.global/en-gb/insights/tax/indirect-tax/nigeria-new-legislation-includes-important-changes-to-vat-rules),
  [Forvis Mazars](https://www.forvismazars.com/ng/en/services/tax/nigeria-s-tax-reform-in-focus/2025-nta-vat-key-business-changes))
- **E-invoicing (FIRSMBS "Merchant Buyer Solution")**: launched Apr 2025; mandatory for large
  taxpayers (> ₦5B turnover) from **1 Nov 2025**; **medium/small VAT-registered businesses
  from 1 Jan 2026**; B2B/B2G/B2C in scope; FIRS is now a **Peppol Authority**; NITDA 2024
  guidelines define formats/security. Enforcement pace for SMEs in practice: unclear. (HIGH
  on mandate, LOW on SME enforcement reality —
  [EY](https://www.ey.com/en_gl/technical/tax-alerts/nigerias-federal-inland-revenue-service-rolls-out-e-invoicing-platform),
  [Global VAT Compliance](https://www.globalvatcompliance.com/globalvatnews/nigeria-e-invoicing-rollout-key-updates-2026/),
  [Pagero](https://www.pagero.com/compliance/regulatory-updates/nigeria))
- Personal income tax rewritten by NTA 2025 (higher tax-free threshold, new bands) — details
  not verified here. (LOW) State-level PAYE administration adds real complexity (36 states +
  FCT). (MED)

**Invoice & document conventions**
- Post-2026: FIRSMBS validation references on invoices for in-scope businesses; TIN usage;
  WHT credit notes are a daily-life reality for B2B. (MED, `[VERIFY-LOCAL]`)

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- Pension: 8% employee + 10% employer (PenCom); NHF 2.5%; NSITF 1%; ITF 1% (employer,
  thresholds apply); PAYE per new NTA bands (verify). (MED)

**Dates, numbers, calendars**
- dd/mm/yyyy, decimal point, Gregorian, Africa/Lagos (no DST). (HIGH)

**Devices, connectivity, power**
- Smartphone ~50%±; data affordability a real constraint; **grid power unreliable —
  generators/solar are standard business kit** → offline-first and low-bandwidth design are
  decisive advantages. GSMA affordable-handset pilot country. (HIGH —
  [GSMA Mobile Economy Africa 2026](https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-economy/africa/))

**Cloud & hosting**
- 16 DCs (Lagos: Rack Centre, Equinix/MainOne); Azure Stack via Liquid C2; **no hyperscaler
  region**; local clouds (Nobus, Layer3, Galaxy Backbone) sell data-sovereignty + naira
  billing. NDPA 2023 data-protection law. (MED —
  [Console Connect](https://blog.consoleconnect.com/powering-africas-digital-future-the-rise-of-cloud-data-centres-and-network-resilience))

**Software landscape (competitors)**
- Sage, QuickBooks; **Odoo has strong SME traction**; Zoho Books; Tally/ERPNext via partner
  firms; many thin local products. (MED —
  [Softcodes](https://softcodes.com.ng/blog/top-10-accounting-and-erp-software-in-nigeria/))
  Nothing owns "operations for SME manufacturers/distributors offline" — JENIFY's slot.

**Messaging channels**
- WhatsApp ~95% of internet users; WhatsApp *is* the storefront for millions of MSMEs; SMS
  (Termii et al.) for OTP/alerts. (HIGH —
  [techeconomy](https://techeconomy.ng/whatsapp-operating-system-for-african-smes/))

**Implementation reality & pack implications**
- Huge upside, high friction: state fragmentation, power costs, enforcement uncertainty, and
  a demanding price point. Strong local developer ecosystem → partner-led implementation is
  realistic. Pack: NGN config, FIRSMBS/Peppol adapter architecture, transfer-reconciliation
  UX, generator-friendly offline behavior. **Build after East Africa cluster unless a
  concrete Nigerian anchor customer appears.**

---

## 4. SOUTH AFRICA 🇿🇦

**Snapshot:** ~62M people; Africa's most mature, regulated, competitive business-software
market. Load shedding is (for now) over. Hard market to enter, valuable to eventually serve.

**Languages & scripts**
- 12 official languages; business software in English; Afrikaans/Zulu/Xhosa UI nice-to-have.
  Latin script, no RTL. (HIGH)

**Currency & FX**
- ZAR fully floating and liquid, ≈ 17–18/USD historically (2025–26); low config risk;
  **verify live rate at pack build**. (MED)

**Payments & mobile money**
- Card + EFT dominate the formal economy; **PayShap** (instant, 14 banks) scaling hard: 45M
  transactions/month by late 2025; 839M transactions worth R774B from launch to Mar 2026;
  Capitec Pay and wallet apps rising; mobile money in the Kenyan sense never took off; cash
  persists in townships. (HIGH —
  [Stitch](https://stitch.money/blog/real-time-payments-in-south-africa-the-state-of-payshap-in-2026),
  [IT-Online](https://it-online.co.za/2026/03/31/314222/))

**Banking**
- World-class: Standard Bank, FNB, Absa, Nedbank, Capitec; excellent digital banking, bank
  feeds available to software vendors (Xero/Sage model). (HIGH)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT **15%** — the 2025 increase to 15.5%/16% was **reversed** (May 2025) and the Feb 2026
  budget kept 15%. (HIGH —
  [EY](https://taxnews.ey.com/news/2025-0943-south-african-vat-rate-increase-reversed-vat-rate-to-remain-at-15-percent-from-1-may-2025),
  [vatcalc](https://www.vatcalc.com/south-africa/south-africa-vat-rise/))
- **No e-invoicing mandate today.** SARS released a **Digital VAT Model consultation on
  17 Aug 2026** (SARS Modernisation 3.0): structured e-invoicing + near-real-time reporting,
  decentralized exchange model, phased from 2026/27 pilots toward **mandatory e-invoicing
  ~2030** starting with large B2B; comments due 16 Oct 2026. (HIGH —
  [SARS](https://www.sars.gov.za/types-of-tax/value-added-tax/vat-modernisation/),
  [vatupdate](https://www.vatupdate.com/2026/08/20/sars-launches-consultation-on-digital-vat-modernisation/),
  [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2026/02/south-africa-tax-authority-confirms-multi-year-e-invoicing-digital-reporting-reform.html))
  → SA pack needs classic VAT-Act-compliant tax invoices now, Peppol-style readiness later.
- POPIA (data protection) applies to any hosted offering. (HIGH)

**Invoice & document conventions**
- "Tax invoice" wording, supplier+customer VAT numbers above thresholds, sequential numbering
  — well-documented VAT Act s20 requirements. (HIGH, field detail `[VERIFY-LOCAL]`)

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- PAYE via SARS tables; UIF 1% + 1% (capped); SDL 1%; EMP201 monthly / EMP501 bi-annual
  reconciliation; BCEA/LRA labour framework is strict. Payroll here is a serious product in
  itself (Sage/PaySpace own it) — **JENIFY should NOT lead with SA payroll.** (HIGH)

**Dates, numbers, calendars**
- Conventions differ from the rest of anglophone Africa: **yyyy/mm/dd widely used; decimal
  COMMA and space thousands separator (R1 234,56) are official style**, though point-decimal
  is common in software. Gregorian, Africa/Johannesburg. (MED-HIGH) → number/date formatting
  must be pack config, which JENIFY's design already assumes.

**Devices, connectivity, power**
- Best in Africa: high smartphone penetration, LTE/5G, fibre. **Load shedding suspended —
  455 consecutive days as of 14 Aug 2026** (Eskom recovery + 10GW+ private solar), though
  localized "load reduction" persists in some suburbs. (HIGH —
  [Eskom](https://www.eskom.co.za/eskom-marks-300-days-without-loadshedding-as-sustained-generation-performance-maintains-grid-stability-and-energy-security/),
  [Energy for Growth](https://energyforgrowth.org/article/how-south-africa-ended-load-shedding-without-new-infrastructure/))

**Cloud & hosting**
- Only country studied with full hyperscaler regions: AWS Cape Town, 2 Azure regions; high
  cloud adoption. Local-first is *less* of a differentiator here. (HIGH)

**Software landscape (competitors)**
- **Sage/Pastel is entrenched** ("most SA accountants trained on Pastel"); Xero growing
  fast (premium price ~R1,700/mo top tiers); QuickBooks present; strong accountant channel
  drives purchases. (HIGH —
  [ITHQ](https://ithq.co.za/blog/accounting-software-south-africa-sme),
  [ODEA](https://odea.co.za/xero-vs-sage-vs-quickbooks-south-africa/))

**Messaging channels**
- WhatsApp ~94–96% of internet users; 74% of SMEs use WhatsApp for customers; township
  commerce is WhatsApp-native. (MED-HIGH —
  [allAfrica](https://allafrica.com/stories/202510200166.html))

**Implementation reality & pack implications**
- Mature, saturated, accountant-gatekept, regulation-heavy. **Lowest strategic priority of
  the ten for JENIFY entry** — enter later via a niche (manufacturing SMEs underserved by
  accounting-first tools), or opportunistically with an anchor customer.

---

## 5. GHANA 🇬🇭

**Snapshot:** ~34M people; MoMo-fluent economy; 2026 VAT overhaul simplified rates; E-VAT
clearance-model e-invoicing going universal in 2026.

**Languages & scripts**
- English official; Twi/Akan, Ewe, Ga, Dagbani spoken; Latin script, no RTL. (HIGH)

**Currency & FX**
- GHS (cedi) — historically volatile with a sharp 2025 appreciation episode; treat any rate
  as stale immediately; **verify live rate at pack build**. (MED)

**Payments & mobile money**
- **MTN MoMo ~60% market share; 26.7M active wallets (2025, +13.6% YoY)**; Telecel Cash and
  AT Money the rest; GhIPSS interoperability (MMI, GH-Link, Ghana QR). (HIGH —
  [News Ghana](https://newsghana.com.gh/ghana-ends-e-levy-as-mtn-ceases-mobile-money-charges/))
- **E-levy (1% electronic transfer tax) ABOLISHED 2 Apr 2025** — removed a major friction on
  digital payments. (HIGH —
  [Graphic Online](https://www.graphic.com.gh/business/business-news/mtn-ghana-abolishes-1-e-levy-as-new-tax-reforms-take-effect.html))

**Banking**
- Consolidated post-2018 cleanup; GCB, Ecobank, Stanbic, Absa, Fidelity; decent digital
  banking. (MED)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- **2026 budget VAT overhaul:** effective rate cut 21.9% → **20%**; 1% COVID levy abolished;
  NHIL (2.5%) + GETFund (2.5%) folded into the VAT base and **now input-deductible**
  (previously a cascading cost); VAT registration threshold raised to **GHS 750,000**. (HIGH —
  [KPMG](https://kpmg.com/us/en/taxnewsflash/news/2025/11/ghana-tax-measures-2026-budget.html),
  [Crowe](https://www.crowe.com/gh/news/ghana-vat-reform-2026),
  [VATabout](https://vatabout.com/ghana-vat-reform-2026-higher-thresholds-lower-rates))
  The old VAT+levies cascade was notoriously hard to compute — a tax-adapter architecture
  must handle "levies on base, VAT on base+levies" style stacking generically.
- **E-VAT e-invoicing:** clearance model — invoices approved by GRA's Virtual Sales Data
  Controller before issuance, via a **Certified Invoicing System (CIS)**; mandatory for all
  VAT-registered businesses (incl. non-resident digital) from Jan 2026, no threshold; EFD Act
  enforcement planned early 2026. (HIGH —
  [Pagero](https://www.pagero.com/us/compliance/regulatory-updates/ghana),
  [EDICOM](https://edicomgroup.com/blog/b2b-evat-electronic-invoicing-ghana),
  [vatcalc](https://www.vatcalc.com/ghana/ghana-e-vat-electronic-invoicing-rollout/))
  → Ghana pack requires **CIS certification** of JENIFY invoicing.

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- PAYE graduated; SSNIT: 13% employer + 5.5% employee (13.5% to SSNIT tier 1, 5% to tier 2
  occupational schemes). (MED)

**Dates, numbers, calendars**
- dd/mm/yyyy, decimal point, Gregorian, Africa/Accra (GMT, no DST). (HIGH)

**Devices, connectivity, power**
- Mid-tier smartphone penetration; "dumsor" power-instability history — currently improved
  but businesses keep backup power; 4G decent in the south. (MED)

**Cloud & hosting**
- No hyperscaler region; local/regional DCs (MTN, Onix); moderate cloud adoption. (MED)

**Software landscape (competitors)**
- Tally, QuickBooks, Sage; partner firms carry ERPNext/Odoo/TallyPrime (e.g., Prymage);
  local POS/CIS vendors emerging around the E-VAT mandate. (MED —
  [Prymage](https://prymage.com/insights/best-erp-software-ghana-2026/))

**Messaging channels**
- WhatsApp ~92% of internet users; MoMo + WhatsApp is the SME commerce stack. (MED)

**Implementation reality & pack implications**
- Straightforward English-language market; the twin regulatory items (new VAT math + CIS
  certification) are the pack's substance. Good mid-order candidate after East Africa.

---

## 6. TANZANIA 🇹🇿

**Snapshot:** ~65M people; Swahili-first market; long-established fiscal-device culture
(EFD→VFD); mobile money deep and multi-provider.

**Languages & scripts**
- **Swahili is the primary business/government language** (stronger than in Kenya); English
  secondary. Latin script, no RTL. (HIGH) → Swahili translations matter more here than
  anywhere; one Swahili translation pack serves TZ/KE/UG with terminology overrides.

**Currency & FX**
- TZS ≈ 2,500–2,700/USD recent years; moderate depreciation; **verify live rate**. (MED)

**Payments & mobile money**
- M-Pesa (Vodacom), Mixx by Yas (ex-Tigo Pesa), Airtel Money, Halopesa; >60% adult
  penetration, 40M+ registered users; TIPS (Tanzania Instant Payment System) provides
  interoperability. (MED-HIGH —
  [IMARC](https://www.imarcgroup.com/africa-mobile-money-market))

**Banking**
- CRDB and NMB dominate; agent banking widespread. (MED)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT **18%** mainland; **Zanzibar has a separate revenue authority and VAT regime (15%)**
  — a pack subtlety unique in this set. (MED; Zanzibar detail LOW — verify)
- **Fiscal receipts are mandatory for essentially all business sales** via EFD (hardware) or
  **VFD (Virtual Fiscal Device — cloud/software)** reporting into TRA's EFDMS; VFD accounts
  need TIN+VRN and TRA approval; API integration with token auth; receipt verification
  service exists. VFD supplier accreditation carries capital/experience requirements — but
  businesses can use approved VFD services with their own POS/ERP. (HIGH —
  [TRA](https://www.tra.go.tz/page/efd-vfd-suppliers),
  [Tally](https://tallysolutions.com/ssa/vat/vfd-tanzania/),
  [vatupdate booklet Jul 2026](https://www.vatupdate.com/2026/07/07/tanzania-e-invoicing-e-reporting-country-booklet/))
  → JENIFY path: integrate with an accredited VFD provider first; own accreditation later.

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- PAYE progressive (top 30%); NSSF 10% + 10%; SDL 3.5% (employer, headcount threshold); WCF
  0.5–1%. (MED)

**Dates, numbers, calendars**
- dd/mm/yyyy, decimal point, Gregorian, Africa/Dar_es_Salaam. Swahili day/month names in UI
  are appreciated. (HIGH)

**Devices, connectivity, power**
- Lower smartphone penetration (GSMA $30–40 pilot country); connectivity patchy outside
  cities; power interruptions common → offline-first advantage. (HIGH)

**Cloud & hosting**
- Limited local DC capacity; no hyperscaler; data hosting mostly Kenya/SA or on-prem. (MED)

**Software landscape (competitors)**
- Tally strong; QuickBooks; a cottage industry of VFD-integration vendors (ninoPOS,
  Powercomputers, eazsell); no dominant SME operations platform. (MED)

**Messaging channels**
- WhatsApp very high; SMS essential; USSD still a primary business interface for payments. (MED)

**Implementation reality & pack implications**
- Natural third/fourth pack in an East-Africa cluster: reuses Swahili, EAC-style VAT logic,
  and the "fiscalized receipt" adapter pattern built for Kenya. VFD-provider partnership is
  the pragmatic entry.

---

## 7. UGANDA 🇺🇬

**Snapshot:** ~48M people; EFRIS is one of Africa's most aggressive e-invoicing enforcement
regimes; mobile money near-universal among adults.

**Languages & scripts**
- English + Swahili official; **Luganda** the major vernacular. Latin script, no RTL. (HIGH)

**Currency & FX**
- UGX ≈ 3,500–3,800/USD recent years; relatively stable; **verify live rate**. (MED)

**Payments & mobile money**
- MTN MoMo + Airtel Money: **36.7M active mobile-money users; >70% of adults**; mobile money
  is the default SME rail. (MED-HIGH —
  [marketdataforecast](https://www.marketdataforecast.com/market-reports/africa-mobile-money-market))
- `[VERIFY-LOCAL]` A 0.5% levy on mobile-money **withdrawals** has applied since 2018 —
  confirm current status. (LOW)

**Banking**
- Stanbic, Centenary, Absa, dfcu; agent banking growing. (MED)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT **18%**. (HIGH)
- **EFRIS**: e-receipts/e-invoices with **real-time transmission to URA**; mandatory for all
  VAT-registered taxpayers, PLUS (from 1 Jul 2025) mandatory for **12 named sectors
  regardless of VAT status** (incl. manufacturing, construction, transport, ICT, wholesale/
  retail fuel…). **Aug 2026 enforcement: income-tax expense deductions denied unless
  supported by EFRIS e-invoices.** Integration via EFDs, URA portal, or system-to-system
  API. (HIGH —
  [URA EFRIS](https://ura.go.ug/en/efris/),
  [Ankole Times](https://ankoletimes.co.ug/news/national/ura-expands-efris-requirements-as-12-business-sectors-face-mandatory-electronic-invoicing/),
  [New Vision Aug 2026](https://www.newvision.co.ug/category/news/ura-tightens-efris-rules-warns-businesses-ove-NV_238536_082026))
  → manufacturing is in the 12 sectors: **any Ugandan factory tenant needs EFRIS from day 1.**

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- PAYE 10/20/30% + 10% surcharge on very high incomes; NSSF 5% employee + 10% employer;
  Local Service Tax. (MED)

**Dates, numbers, calendars**
- dd/mm/yyyy, decimal point, Gregorian, Africa/Kampala. (HIGH)

**Devices, connectivity, power**
- Low smartphone penetration (GSMA pilot country); data cost high relative to income; power
  and connectivity interruptions routine → offline-first essential. (HIGH)

**Cloud & hosting**
- Minimal local capacity (Azure Stack via Liquid C2 noted); hosting typically Kenya/SA. (MED)

**Software landscape (competitors)**
- Tally/QuickBooks habit; EFRIS-integration vendors (Greytrix et al.); no strong local SME
  operations platform. (MED)

**Messaging channels**
- WhatsApp dominant; USSD/SMS critical beyond smartphones. (MED)

**Implementation reality & pack implications**
- Small-ticket market, but EFRIS + manufacturing overlap makes it strategically aligned with
  JENIFY's factory DNA, and it reuses the East-Africa cluster (Swahili optional, 18% VAT,
  real-time fiscalization adapter). Good pack #3/#4 candidate.

---

## 8. RWANDA 🇷🇼

**Snapshot:** ~14M people; small but the region's cleanest regulatory environment; strongest
state push for cashless + digital tax; certification regime is explicit and documented.

**Languages & scripts**
- Kinyarwanda + English + French + Swahili all official; English is government/education
  language since 2008; Latin script, no RTL. (HIGH)

**Currency & FX**
- RWF ≈ 1,400–1,500/USD recent years, managed crawl, relatively stable; **verify live
  rate**. (MED)

**Payments & mobile money**
- MTN MoMo dominant + Airtel Money; very high adult financial inclusion; government services
  via Irembo normalize digital payment habits. (MED)

**Banking**
- Bank of Kigali dominant; BPR (KCB); I&M; small, modern sector. (MED)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT **18%**. (HIGH)
- **EBM (Electronic Billing Machine) regime: EVERY registered taxpayer must issue an EBM
  receipt/invoice for EVERY sale — cash, MoMo, or bank — signed by an RRA-authorized Sales
  Data Controller (SDC).** Current generation EBM 2.1 / VSDC / OSDC APIs; hardware "black
  boxes" replaced by cloud integration. (HIGH —
  [RRA tax handbook](https://tax-handbook.rra.gov.rw/handbook/explanation-of-ebms/),
  [EDICOM](https://edicomgroup.com/blog/mandatory-einvoicing-rwanda-eis))
- **Software must be RRA CIS-certified with a Developer ID to legally connect to the OSDC
  API.** Penalties: 10× evaded VAT (first offence), 20× (repeat), up to 30-day closure.
  (MED-HIGH — [Rexolia](https://rexolia.com/blog/ebm-compliance-in-rwanda-what-every-shop-owner-must-know/),
  [paybill.ke](https://paybill.ke/blogs/rra-ebm-compliance/))
  → Rwanda is the clearest statement of the pan-African pattern: **JENIFY itself must be a
  certified invoicing system to operate.** Small market = low-risk place to learn the
  certification playbook.

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- PAYE progressive 0–30% (bands revised 2023–24); RSSB pension + maternity + CBHI
  contributions. (LOW-MED — verify current rates)

**Dates, numbers, calendars**
- dd/mm/yyyy, decimal point, Gregorian, Africa/Kigali. (HIGH)

**Devices, connectivity, power**
- Improving fast; Kigali well connected; 4G coverage broad (KTRN wholesale network); GSMA
  affordable-handset pilot country; rural smartphone access still limited. (MED)

**Cloud & hosting**
- New DC investment announced; government cloud-forward; data residency valued. (MED)

**Software landscape (competitors)**
- EBM-certified POS/invoicing vendors; QuickBooks/Sage in accounting firms; no dominant SME
  operations platform. (MED)

**Messaging channels**
- WhatsApp high; SMS standard. (MED)

**Implementation reality & pack implications**
- Smallest revenue opportunity in this set, but **best learning environment**: clear rules,
  one honest API regime, English-friendly. Candidate for the "certification pilot" pack that
  de-risks Kenya/Uganda/Tanzania adapters.

---

## 9. EGYPT 🇪🇬

**Snapshot:** ~107M people; largest Arabic-speaking market; the continent's most mature
e-invoicing regime after Kenya; **first country in this set that forces RTL investment**.

**Languages & scripts**
- **Arabic — RTL.** English common in business. Arabic-Indic digits (٠١٢٣…) appear in
  documents alongside Western digits. (HIGH)
- → An Egypt pack requires platform-level RTL support (layout mirroring, bidi text in PDFs,
  Arabic fonts) — the localization layer's largest single investment in this report. RTL is
  already contemplated in the JENIFY translation-layer design but is unproven.

**Currency & FX**
- EGP ≈ **50.3/USD** (Aug 2026); serial devaluations 2016/2022/2024, flexible regime since
  Mar 2024; devaluation risk persists. (HIGH —
  [exchange-rates.org](https://www.exchange-rates.org/converter/usd-egp)) Snapshot-rate model
  fine; businesses commonly think in USD for imports.

**Payments & mobile money**
- **InstaPay** (CBE instant A2A rail): ~16M users mid-2025 trending 20M+, 1.1B transactions
  worth EGP 2.4T in H1 2025 — the default transfer rail. **Fawry**: 53M+ consumers, 250k+
  touchpoints (bill-pay/cash-in network). Mobile wallets (Vodafone Cash etc.): EGP 943B in
  Q2 2025, +72% YoY. Meeza national card scheme. Cash still heavy. (HIGH —
  [Chambers Fintech 2026](https://practiceguides.chambers.com/practice-guides/fintech-2026/egypt/trends-and-developments),
  [allbusiness.africa](https://allbusiness.africa/insights/egyptian-fintech-2026))

**Banking**
- NBE, Banque Misr (state giants), CIB (private leader); CBE runs an assertive digital
  agenda. (HIGH)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT standard **14%**. (HIGH — Avalara)
- **E-invoicing (ETA): mandatory B2B since Apr 2023** — pre-clearance model: approved
  XML/JSON, **digital signature (HSM/USB token)**, UUID assigned by ETA before issuance;
  unregistered invoices are invalid for input VAT. **B2C e-receipts** mandatory and expanding
  since Jan 2025 (POS/ERP linked to ETA; reporting within 24–72h). 2026 = enforcement stage;
  **VAT registration threshold cut to EGP 250,000 with registration required by
  31 Mar 2026** — pulls micro-SMEs into the regime. (HIGH —
  [Avalara](https://www.avalara.com/us/en/vatlive/country-guides/africa-and-middle-east/egypt-vat/egyptian-e-invoicing.html),
  [vatupdate Feb 2026](https://www.vatupdate.com/2026/02/23/briefing-document-podcast-e-invoicing-e-reporting-in-egypt/),
  [datavalue](https://datavalue.solutions/egypt-e-invoicing-eta-2026-sme-guide/))
  → Egypt pack = ETA integration project (signature hardware handling included) + Arabic
  item-coding (EGS/GS1 product codes are required on e-invoices — MED, verify).

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- Salary tax progressive to 27.5%; social insurance ≈ 11% employee / 18.75% employer on a
  capped base. (MED)

**Dates, numbers, calendars**
- **Work week Sunday–Thursday; weekend Friday–Saturday** — scheduling/payroll/reporting
  configs must support a non-Mon-Fri week (pack-level "week definition" setting; also useful
  for other markets). Gregorian for business; Hijri ceremonial. dd/mm/yyyy; Arabic decimal
  conventions in Arabic documents. Africa/Cairo — **Egypt re-introduced DST (since 2023)**;
  timezone library must handle it. (MED-HIGH)

**Devices, connectivity, power**
- Large, urbanized market; decent smartphones and 4G in cities; power generally stable
  post-2015 crisis (occasional summer cuts). (MED)

**Cloud & hosting**
- Growing local DC market; data-localization sensitivities; no hyperscaler region (regional
  Azure/AWS served from Middle East/EU). (MED)

**Software landscape (competitors)**
- **Odoo is exceptionally strong (170–187 Egyptian partners — among the densest globally)**;
  local Arabic-first products: Daftra, Zemam, eDariba; Microsoft Dynamics via partners; SAP
  in enterprise; ERPNext implementations with ETA modules. (MED —
  [Azdan](https://www.azdan.com/blog/erp-companies-egypt),
  [buildn](https://buildn.tech/en/blog/erp-system-egypt))
  Crowded ERP-lite market; JENIFY's differentiation = manufacturing operations + offline.

**Messaging channels**
- WhatsApp near-universal among internet users; Facebook commerce large. (MED)

**Implementation reality & pack implications**
- High reward, high cost: RTL + ETA + signature infrastructure + a competitive Odoo
  ecosystem. **Do not attempt before RTL is platform-proven.** Sensible sequencing: build
  RTL for Egypt only when an Arabic-market strategy (Egypt + North Africa + possibly Sudan/
  Gulf later) justifies it as one investment.

---

## 10. MOROCCO 🇲🇦

**Snapshot:** ~38M people; francophone business culture with Arabic; stable currency; brand
new CTC e-invoicing rollout (2026–27); cash still ~84% of payment volume.

**Languages & scripts**
- Arabic (RTL) + **Amazigh (Tifinagh script, official but rare in business software)**;
  **French dominates business documents** — invoices are typically French. (HIGH)
  → A Morocco pack leads with **French** (Latin, LTR) and offers Arabic as overlay — French
  translation pack is the reusable asset (whole francophone Africa).

**Currency & FX**
- MAD managed against a EUR/USD basket; ≈ 9–10/USD historically; the most stable currency in
  this report; **verify live rate**. (MED-HIGH)

**Payments & mobile money**
- **Cash ≈ 83.7% of payment volume (2026); ~53% of adults unbanked.** CMI dominates card
  acquiring; **Maroc Pay** national interoperable wallet infrastructure (Bank Al-Maghrib +
  HPS Switch), 10M+ wallets but low usage; cards 47% of e-commerce. (HIGH —
  [GlobalData via MEED](https://www.meed.com/moroccos-payments-shift-remains-cash-led),
  [baas.ma](https://www.baas.ma/en/blog/paiement-mobile-maroc-maroc-pay))

**Banking**
- Strong regional banks: Attijariwafa, BCP, Bank of Africa — all expanding across francophone
  Africa (a future distribution insight); good corporate banking. (HIGH)

**Tax & compliance — every item `[VERIFY-LOCAL]`**
- VAT standard **20%** with reduced rates (7/10/14% categories). (MED-HIGH)
- **E-invoicing (DGI, CTC pre-clearance via Simpl-TVA, UBL 2.1):**
  Wave 1 **1 Jan 2026** — large companies (turnover > 200M MAD) + public-sector suppliers;
  Wave 2 **1 Jul 2026** — 10–200M MAD;
  Wave 3 **1 Jan 2027** — SMEs/micro + self-employed > 500k MAD. (HIGH —
  [vatcalc](https://www.vatcalc.com/morocco/morocco-e-invoicing-2026/),
  [EDICOM](https://edicomgroup.com/blog/morocco-electronic-invoicing),
  [Crystal IT](https://crystalit.ma/en/blog/calendrier-facturation-electronique-maroc-dgi))
  → by the time a JENIFY Morocco pack ships, e-invoicing will cover its whole SME target.
- CNSS social security; IR progressive (top ~37% after 2025 finance law). (MED)

**Invoice & document conventions**
- French-language invoices with ICE (Identifiant Commun de l'Entreprise), IF (tax ID), RC
  (trade register) numbers; strict mention requirements. (MED, `[VERIFY-LOCAL]`)

**Payroll & employment (indicative, `[VERIFY-LOCAL]`)**
- CNSS ≈ 6.74% employee / ~21% employer (incl. AMO health); IR withholding monthly. (MED)

**Dates, numbers, calendars**
- **French formats: dd/mm/yyyy, decimal comma, space thousands (1 234,56 MAD).** Weekend
  Sat–Sun (unlike Egypt); Ramadan reduced hours; Hijri dates ceremonial. Africa/Casablanca —
  **permanent UTC+1 with clock changes around Ramadan** — a genuinely tricky timezone;
  rely on IANA tzdata, never hardcode. (MED-HIGH)

**Devices, connectivity, power**
- Good mobile coverage (IAM, Orange, inwi), 5G launching; power reliable; better basic
  infrastructure than most of the list. (MED)

**Cloud & hosting**
- Local DCs (N+One, inwi, Maroc Datacenter); CNDP data-protection law 09-08; EU-adjacent
  compliance culture. (MED)

**Software landscape (competitors)**
- **Sage very strong (French software heritage)**; local: Crystal IT, Hisab (e-invoicing
  focus); Odoo strong in francophone markets; HPS is a homegrown global payment-tech
  champion. (MED — [Crystal IT](https://crystalit.ma/en/blog/logiciel-facturation-maroc))

**Messaging channels**
- WhatsApp very high; business formality favors email/PDF more than sub-Saharan peers. (MED)

**Implementation reality & pack implications**
- Gateway to francophone Africa: the French language pack, French document conventions, and
  decimal-comma number formats built here are reusable in Côte d'Ivoire/Senegal/Cameroon.
  Enter after East/West anglophone packs unless francophone demand appears first.

---

## 11. COMPARISON MATRIX

Rates/statuses summarized from the country sections; **every tax cell `[VERIFY-LOCAL]`**.
FX ≈ Aug 2026, indicative only.

| Country | Currency (≈/USD) | VAT std | E-invoicing status (Aug 2026) | Software certification needed? | Primary business rails | Languages (pack) | Script/RTL | Offline priority | Hyperscaler region | SME software competition |
|---|---|---|---|---|---|---|---|---|---|---|
| **Ethiopia** (live) | ETB ~159 (par. ~180) | 15% | Directive 1142/2026 — imminent, centralized | **Yes** (Ministry-authorized software) | Telebirr, banks, cash (cap ETB 30k) | am, ti, om, en | Ethiopic / no RTL | **Critical** | No | Low |
| **Kenya** | KES ~129 | 16% | **Live+enforced** (eTIMS, all businesses) | **Yes** (OSCU/VSCU) | M-Pesa (89%), Pesalink | en, sw | Latin | High | Partial (local zone planned) | **High** |
| **Nigeria** | NGN ~1,350–1,390 | 7.5% | Live large-taxpayers; SMEs from Jan 2026 (FIRSMBS/Peppol) | Yes (access-point model) | NIP transfers, OPay/PalmPay, POS agents, cash | en (+ha, yo, ig) | Latin | **Critical** | No | Medium |
| **South Africa** | ZAR ~17–18 | 15% | None yet; consultation Aug 2026, mandate ~2030 | Not yet | Cards, EFT, PayShap | en (+af, zu, xh) | Latin | Low-Med | **Yes (AWS+Azure)** | **Very high** |
| **Ghana** | GHS (volatile — verify) | 15%+2×2.5% levies (eff. 20%) | Mandatory all VAT-registered from Jan 2026 (CIS clearance) | **Yes** (CIS) | MTN MoMo (60%), GhIPSS | en (+tw, ee) | Latin | Medium | No | Medium |
| **Tanzania** | TZS ~2,5–2,7k | 18% (Zanzibar 15% — verify) | Live (EFD/VFD fiscal receipts, all sales) | Yes (or partner with accredited VFD) | M-Pesa/Mixx/Airtel, TIPS | **sw**, en | Latin | High | No | Low-Med |
| **Uganda** | UGX ~3,5–3,8k | 18% | **Live+enforced** (EFRIS; 12 sectors incl. manufacturing regardless of VAT) | Yes (EFRIS integration) | MTN MoMo/Airtel (70%+ adults) | en (+lg, sw) | Latin | High | No | Low |
| **Rwanda** | RWF ~1,4–1,5k | 18% | **Live+enforced** (EBM every sale, every taxpayer) | **Yes (CIS cert + Developer ID)** | MTN MoMo, banks | rw, en, fr | Latin | Medium | No | Low |
| **Egypt** | EGP ~50 | 14% | **Live+enforced** (ETA B2B since 2023; B2C e-receipts; threshold now EGP 250k) | **Yes** (ETA integration + digital signature) | InstaPay, Fawry, wallets, cash | **ar (RTL)**, en | **Arabic / RTL** | Medium | No | **High (Odoo density)** |
| **Morocco** | MAD ~9–10 | 20% (multi-rate) | Phasing: Jan 2026 large → Jan 2027 SMEs (Simpl-TVA, UBL 2.1) | Yes (CTC clearance) | Cash (84%), CMI cards, Maroc Pay | **fr**, ar (+ber) | Latin+Arabic / partial RTL | Low-Med | No | Medium-High |

Cross-cutting facts: WhatsApp is ≥90% of internet users in every country studied
([askyazi](https://www.askyazi.com/useful-data-sources-for-africa/whatsapp-usage-across-africa-key-statistics-insights-for-2025));
SSA smartphone adoption ~54% (2024) → 81% (2030), with a 63% "covered but offline" usage gap
([GSMA](https://www.gsma.com/solutions-and-impact/connectivity-for-good/mobile-economy/africa/));
$30–40 handset pilots 2026 in DRC, Ethiopia, Nigeria, Rwanda, Tanzania, Uganda.

---

## 12. RECOMMENDED COUNTRY-PACK BUILD ORDER (Ethiopia live)

Ranking weighs: market size × regulatory feasibility × reuse of existing JENIFY assets ×
fit with FAST/SIMPLE/FLEXIBLE/LOCAL/INTELLIGENT × certification cost. **This is a research
recommendation — sequencing is a Founder/Team Lead decision.**

**Phase 0 — Ethiopia hardening (now).** Directive 1142/2026 may soon require JENIFY to be
Ministry-authorized invoicing software *in its home market*. Commission a legal read; design
the generic **fiscalization adapter interface** (issue → sign/clear → receive control
number/QR → print/store; offline queue + replay) against Ethiopia + Kenya + Rwanda specs
simultaneously so one interface fits all. This single interface is the most reusable artifact
of the whole program.

1. **Kenya** — largest realistic near-term commercial market; English/Swahili (no new
   script); M-Pesa adapter is the highest-value payment adapter in Africa; eTIMS is
   well-documented with a public sandbox. Critical path: eTIMS OSCU/VSCU certification.
2. **Rwanda** — tiny market, but the cheapest place to **prove the certification playbook**
   (CIS cert + Developer ID + OSDC API) and validate the fiscalization interface end-to-end.
   Could run in parallel with late-stage Kenya work.
3. **Uganda** — EFRIS overlaps JENIFY's manufacturing DNA (factories must fiscalize
   regardless of VAT status); heavy reuse of the East-Africa cluster.
4. **Tanzania** — completes the EAC cluster; Swahili-first UI; pragmatic entry via an
   accredited VFD partner rather than own accreditation.
5. **Ghana** — first West-African pack; English; new simplified VAT math (still needs a
   levy-stacking-capable tax adapter); CIS certification required.
6. **Nigeria** — biggest prize; enter once FIRSMBS SME enforcement reality is observable and
   ideally with an anchor customer; budget for state-level payroll variance and Peppol-based
   e-invoicing.
7. **Morocco** — builds the French language pack + decimal-comma formats + CTC/UBL adapter;
   unlocks francophone Africa.
8. **Egypt** — gate on the **RTL platform investment**; largest Arabic market but toughest
   combination (RTL + ETA signatures + Odoo-dense competition).
9. **South Africa** — last of the ten: most competitive, least regulatory urgency (e-invoicing
   ~2030), least offline advantage. Enter niche-first (manufacturing SMEs) if at all.

Cluster logic: **one Swahili translation pack + one fiscalization interface + one mobile-money
adapter pattern covers KE/TZ/UG/RW (~180M people).** One French pack + decimal-comma formats
covers MA + future CI/SN/CM. One RTL investment covers EG + future Arabic markets.

---

## 13. ADDITIONAL RECOMMENDED COUNTRIES (beyond the ten)

Priority additions, in order:

1. **Zambia** — English; ZRA **Smart Invoice already mandatory for all VAT-registered since
   1 Oct 2024** (input VAT only claimable on Smart Invoices); GDP growth ~6.8% (2026); mining
   supply-chain SMEs. Regulatory model mirrors the East-Africa pattern JENIFY will already
   have. (HIGH — [EDICOM](https://edicomgroup.com/blog/mandatory-electronic-invoicing-zambia-smart-invoice),
   [Cygnet](https://www.cygnet.one/products/cygnet-tax/e-invoicing/zambia-mandate/)) `[VERIFY-LOCAL]`
2. **Côte d'Ivoire** — francophone anchor; **FNE e-invoicing launched Jul 2025, all taxpayers
   migrated by 31 Jan 2026**; XOF (stable, euro-pegged); strong growth; reuses the Morocco
   French pack. (HIGH — [vatcalc](https://www.vatcalc.com/cote-divoire/cote-divoire-e-invoicing/)) `[VERIFY-LOCAL]`
3. **Senegal** — XOF zone twin; Wave/Orange Money mobile-money culture; ~7%/yr growth
   trajectory; active public-finance reform program. E-invoicing status unconfirmed in this
   research — verify. (MED — [AfDB](https://www.afdb.org/en/news-and-events/senegal-african-development-bank-grants-20-billion-cfa-francs-accelerate-economic-reforms-and-strengthen-public-finance-governance-95927))
4. **DRC** — ~100M people, GSMA handset-pilot country, huge informal trade with East Africa;
   dual-currency reality (CDF/USD) is a genuine product test; infrastructure hardest of all —
   a later, opportunistic entry. (MED)
5. **Cameroon** — XAF anchor for Central Africa; bilingual French/English — bridges both of
   JENIFY's language packs. (MED)
6. Watchlist: **Mozambique** (Vodacom M-Pesa strength), **Botswana/Namibia** (stable,
   SA-adjacent), **Tunisia** (mature e-invoicing since 2016, Arabic/French), **Zimbabwe**
   (FDMS fiscalization exists but ZiG currency volatility makes the accounting model risky).

---

## 14. OPEN QUESTIONS FOR TEAM LEAD (never invent — ask)

1. Ethiopia Directive 1142/2026: exact effective dates, phase thresholds, software
   authorization procedure, offline-sector annex contents — needs the Amharic primary text +
   local counsel. **Affects the live tenant.**
2. Does Mesob payroll config already reflect Income Tax Amendment 1395/2025 brackets?
3. Kenya SHIF employer-side 1.375% contribution — conflicting sources; verify before any
   Kenya payroll design.
4. eTIMS certification route for a local-first system: is VSCU offline batching sufficient
   for JENIFY's architecture, and what is the certification lead time/cost?
5. Rwanda CIS certification: cost, timeline, and whether a foreign developer can hold a
   Developer ID directly.
6. Egypt: are EGS/GS1 item codes mandatory for all e-invoice lines (major product-data
   implication)?
7. Nigeria: actual SME enforcement of FIRSMBS during 2026 — monitor before committing.
8. Zanzibar's separate VAT regime — confirm before any Tanzania scope statement.

---

## 15. TEAM LEAD SUMMARY (10 lines)

1. Africa's defining compliance trend: invoicing software must be **government-certified and
   government-connected** in 8 of 10 studied countries — a cost, and JENIFY's moat.
2. Ethiopia's own e-invoicing Directive 1142/2026 is imminent and may require Ministry
   authorization of JENIFY — top-priority legal verification for the live tenant.
3. Build ONE generic fiscalization-adapter interface (issue→clear→QR→offline queue); it
   serves Kenya, Rwanda, Uganda, Tanzania, Ghana, Egypt, Morocco, Zambia with per-pack config.
4. Recommended order: Kenya → Rwanda (cert pilot) → Uganda → Tanzania → Ghana → Nigeria →
   Morocco → Egypt → South Africa; add Zambia and Côte d'Ivoire to the roadmap.
5. The EAC cluster (KE/RW/UG/TZ) shares Swahili, 16–18% VAT patterns, mobile-money rails —
   ~180M people from largely reusable pack assets.
6. M-Pesa (Kenya) is the single highest-value payment adapter; Telebirr, MTN MoMo, InstaPay
   follow the same adapter pattern.
7. Egypt is the RTL gate: defer Arabic markets until RTL is a deliberate platform investment;
   Morocco leads with French (reusable across francophone Africa).
8. Offline-first is decisive in Ethiopia, Nigeria, Uganda, Tanzania (power/connectivity);
   least valuable in South Africa — which is also the most saturated market (enter last).
9. WhatsApp ≥90% everywhere studied; SMS/USSD remain the notification floor; Ethiopia is
   unusually Telegram-heavy.
10. NOTHING tax/legal in this report is implementable as-is — every such item is marked
    `[VERIFY-LOCAL]` and needs local professional confirmation + Founder approval first.
