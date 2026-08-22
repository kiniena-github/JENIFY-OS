# ETHIOPIA E-INVOICING — VERIFICATION BRIEF & COMPLIANCE GATEWAY ARCHITECTURE

**Workstream:** Founder decision "Ethiopia e-invoicing: VERIFY FIRST. Build extensible integration
boundaries. Do NOT claim or implement legal compliance from unverified research."
**Author:** jenify-country-localization (africa-localization depth) · **Date:** 2026-08-22
**Status:** Verification brief + design-only architecture (mission §33). **No code. No compliance claims.**

---

## How every claim in Part 1 is labeled

| Label | Meaning |
|---|---|
| **[VERIFIED OFFICIAL FACT]** | Confirmed on a reachable government primary source (link given) |
| **[VERIFIED DIRECTIVE TEXT]** | Read directly by this research from the full 57-page bilingual (Amharic/English) PDF of the directive itself — an **unofficial copy** hosted by an Ethiopian law firm ([Eagle Advocates PDF](https://eagleadvocates.com/wp-content/uploads/2026/06/1142_የኤሌክትሮኒክ_ደረሰኝ_ሥርዓት_አስተዳደር_መመሪያ_ቁጥር_1142_2018.pdf), local copy retained in session scratchpad). Content corroborated by three independent professional analyses. Near-primary, but **not** an official government channel; the copy could differ from the final registered version. Article numbers cited. |
| **[SECONDARY SOURCE]** | Law firm / accounting firm / press analysis; no primary confirmation |
| **[UNCONFIRMED CLAIM]** | Single thin source, or conflicting sources — treat as a lead only |
| **[COULD NOT VERIFY]** | We tried the primary channel and it was unreachable or silent — stated plainly |

**Nothing in this document is legal advice, and nothing here may be encoded as product behavior
without local-counsel confirmation and Founder approval** (R3 rule, `AFRICA_COUNTRY_PACK_INTELLIGENCE.md` §0).

---

# PART 1 — VERIFICATION BRIEF FOR THE FOUNDER

## 1.0 Headline verification result

The directive **exists and we have read its full text**. The prior report's citation
"Directive 1142/2026" is essentially correct but imprecise: the instrument is numbered in the
**Ethiopian calendar as 1142/2018 E.C.**, rendered "1142/2026" in its own English column.
The two facts that matter most could **not** be verified:

1. **Whether it is legally in force yet.** Its own Article 31 makes entry into force conditional
   on (a) registration by the Ministry of Justice and (b) publication on the Ministry of Revenues
   website. **[COULD NOT VERIFY]** — `mor.gov.et` was unreachable from this environment on both
   HTTPS and HTTP (TLS certificate validation failure), so we could not check publication. No
   independent confirmation of MoJ registration found.
2. **When any taxpayer must actually comply.** The directive contains **no dates and no
   taxpayer-size thresholds**. Article 29(1) defers everything to an implementation schedule
   "issued by the Authority" — and **no such schedule could be found published anywhere**
   as of 2026-08-22. **[COULD NOT VERIFY]**

So: the legal regime is real and its mechanics are now known in detail; the *clock* is not.

## 1.1 Exact legal instrument

- **Name:** የኤሌክትሮኒክ ደረሰኝ ሥርዓት አስተዳደር መመሪያ ቁጥር 1142/2018 — official English rendering in the
  text itself: *"Electronic Invoicing System Administration Directive No. 1142/2026"*
  (Art. 1 Short Title). **[VERIFIED DIRECTIVE TEXT]**
- **Structure:** 31 articles + Annex 1 (sample invoice) + Annex 2 (26 sectors with mandatory
  offline capability). Bilingual Amharic/English; **Amharic is the authoritative column**.
  **[VERIFIED DIRECTIVE TEXT]**
- **Date on the instrument:** cover and signature page say Addis Ababa, **ሐምሌ 2018 ዓ.ም (Hamle
  2018 E.C. ≈ 8 Jul–6 Aug 2026)**; the English column of the signature page says "June, 2026
  G.C." — an internal inconsistency in the instrument's own translation. Law-firm analyses of it
  appeared 17 Jun–2 Jul 2026. **[VERIFIED DIRECTIVE TEXT]** (the discrepancy itself is a fact)
- **Issuing authority:** **Ministry of Revenues** (federal), signed by the Minister of Revenues,
  under Art. 19(4) of the Federal Tax Administration Proclamation No. 983/2016 (983/2008 E.C.)
  and Proclamation No. 1263/2021 (Executive Organs). **[VERIFIED DIRECTIVE TEXT]** (preamble + Art. 3)
- **Repeals:** Articles 8 and 23 of Tax Invoice Utilization and Administration Directive
  No. 149/2018 (149/2011 E.C., MoJ registration 165/2018) — the old e-invoice provisions.
  (Art. 30) **[VERIFIED DIRECTIVE TEXT]**
- **Government platform exists:** INSA (Information Network Security Administration) developed the
  "Electronic Invoice Management System" for the Ministry of Revenues; unveiled 8 Oct 2024 at a
  ceremony attended by the Prime Minister. **[VERIFIED OFFICIAL FACT]** —
  [insa.gov.et announcement](https://www.insa.gov.et/blog/INSA-Launches-Electronic-Invoice-Management-System)
- An **Inspection and Accreditation Board** for e-invoicing systems has reportedly been
  established by the Ministry under this directive. **[SECONDARY SOURCE]** —
  [The Reporter](https://www.thereporterethiopia.com/51673/) (article returns HTTP 403 to
  automated access; content known only from search excerpts).

### Correction to the prior intelligence report (important)

- `AFRICA_COUNTRY_PACK_INTELLIGENCE.md` cited a Reporter article as evidence that "go-live
  \[is\] reported imminent in 2026." That article
  ([thereporterethiopia.com/36959](https://www.thereporterethiopia.com/36959/)) is from
  **October 2023** and describes an earlier ITAS-era pilot announcement by then-Minister Aynalem
  Nigussie — it is **not** evidence about the 1142 rollout. **[SECONDARY SOURCE]**, mis-dated in
  our prior report; treat the "imminent go-live" framing as withdrawn.
- The VAT regulation referenced for invoice content is cited three different ways across sources:
  the directive's Amharic column consistently says **ደንብ ቁጥር 570/2017 (Regulation 570/2017 E.C.)**;
  its own English column renders this as "570/2024" (Art. 4(1)(a)) and "570/2026" (Art. 20(3)(a))
  in different places; external sources (ethiodata.et PDF, Haymanot & Advocates) call it
  **570/2025 G.C., issued March 2025**. Same instrument, sloppy calendar conversions. Our prior
  report's "570/2026" should be read as **Council of Ministers VAT Regulation No. 570/2017 E.C.
  (≈ 2025 G.C.)**. **[VERIFIED DIRECTIVE TEXT]** for the Amharic citation; G.C. equivalence
  **[SECONDARY SOURCE]**.

## 1.2 Who it applies to

- **Scope (Art. 3):** taxpayers that issue invoices under tax law; Sales Registration System
  suppliers; taxpayers using software exclusively for themselves; SaaS providers; e-commerce /
  digital marketplace operators. Applies to VAT-taxable transactions under Art. 3 of VAT
  Proclamation 1341/2024. **[VERIFIED DIRECTIVE TEXT]**
- **Core obligation (Art. 19(1), Art. 29(1)):** use of an electronic sales registration system
  integrated with the Ministry's Electronic Invoice Registration System is **mandatory for ALL
  taxpayers required to maintain books of account** — B2B, B2C and B2G alike. Any taxpayer may
  adopt voluntarily before being scheduled (Art. 19(2)). **[VERIFIED DIRECTIVE TEXT]**
- **No turnover thresholds, no taxpayer-size phase-in, no dates appear anywhere in the
  directive.** Phasing exists only as the Authority's future schedule (Art. 29(1)).
  **[VERIFIED DIRECTIVE TEXT]** (verified absence)
- **Exemption path (Art. 20):** banks, securities markets, digital payment processors, telecoms
  may be allowed summary reporting instead of per-transaction clearance; the Ministry may extend
  this to other sectors. Summary content prescribed (period, item, quantity, unit price, tax
  type/rate/amount, totals). **[VERIFIED DIRECTIVE TEXT]**

## 1.3 The clearance model (what "e-invoice" means here)

- **Pre-clearance, Rwanda/Egypt-style, not post-audit** (Art. 4(1)(c)): a compliant system may
  issue an invoice or receipt **only after** transmitting the transaction to the Electronic
  Invoice Registration System, having it validated, and receiving an **Invoice Registration
  Number (IRN), Receipt Registration Number (RRN) and QR code**, which must be printed/displayed
  legibly (Art. 4(1)(d)). Transmission must be real-time as the transaction occurs
  (Art. 4(1)(b)). The system must identify and compute the correct tax types (Art. 4(1)(e)).
  **[VERIFIED DIRECTIVE TEXT]**
- **Required invoice data fields:** at minimum the contents listed in **Art. 20 of VAT
  Regulation 570/2017 E.C.** plus the detail in the directive's **Annex 1 sample invoice**
  (Art. 4(1)(a)). In our PDF copy, Annex 1 renders as a non-extractable placeholder/image — the
  concrete field list **[COULD NOT VERIFY]** from this copy and must be obtained from the
  Ministry or the regulation text. Known VAT-regulation basics (supplier/recipient TIN & VAT
  numbers, serial number, description, quantity, unit price, VAT amount, totals) are
  **[SECONDARY SOURCE]**.
- **Taxpayer onboarding credentials (Art. 19(5)):** register on the Authority's Taxpayer Portal
  → obtain a **System Number, API Key, and Client Secret**; obtain a **Digital Signature
  Certificate from INSA or an authorized body**, bound to the taxpayer's TIN and the registered
  software's number. **[VERIFIED DIRECTIVE TEXT]**
- **Corrections are structured:** price adjustments via tax debit/credit notes; invoice
  cancellation requires a request to the Authority, with a 48-hour response window for
  supporting evidence (Arts. 25–27 area). Registered invoices cannot be silently altered —
  liability attaches to discrepancies (Art. 27). **[VERIFIED DIRECTIVE TEXT]**
  *(Directly compatible with JENIFY's immutable-operations principle.)*

## 1.4 Certification of invoicing SOFTWARE — yes, government approval is required

This is the section that determines JENIFY's obligations. All from the directive text.

- **Only Ministry-authorized software may issue invoices.** "Electronic invoice" is *defined*
  as a document issued by sales registration software authorized by the Ministry (Art. 2(1)).
  **[VERIFIED DIRECTIVE TEXT]**
- **Conformance licensing (Art. 4):** inspection/testing of integration with the Ministry
  system: clearance flow (IRN/RRN/QR), real-time transmission, correct tax computation,
  authentication controls, digital-signature-secured communication, and — for mobile/mPOS
  deployments — periodic **geo-location reporting** of the device (Art. 4(5)(a)).
  Offline-capable systems must implement the Authority's **"Offline Resiliency Specification"**
  (a separate technical document we have not seen — **[COULD NOT VERIFY]** its content).
  **[VERIFIED DIRECTIVE TEXT]**
- **INSA security clearance:** a software security assurance certificate from INSA, **not older
  than one month** at application/renewal (Art. 9 area; Art. 12(2)(a)). **[VERIFIED DIRECTIVE TEXT]**
- **Accreditation tracks and financial requirements (Art. 14):** applicant needs an
  Ethiopian-registered business license in software development/consultancy, degreed support
  professionals (2+ years experience), a support center (web + phone), and a **performance
  guarantee** (bank- or insurance-secured, renewable every 2 years, scaled by user count /
  aggregate sales up to **USD 250,000**):

  | Track | Min. professionals | Base guarantee |
  |---|---|---|
  | Sales Registration System **Supplier** (sells systems) — Art. 14(2) | 4 | **USD 30,000** |
  | **SaaS** service provider (subscription) — Art. 14(3) | 6 | **USD 50,000** |
  | E-commerce / **marketplace** operator — Art. 14(4) | — | **USD 25,000** |
  | Taxpayer's **exclusive-use** software — Art. 14(5) | — | **USD 15,000** |

  The exclusive-use track additionally requires audit-friendly standard accounting, in-house
  development or a maintenance agreement with the developer, and strictly own-use.
  **[VERIFIED DIRECTIVE TEXT]**
- **No application fees are stated anywhere in the directive** (verified absence — guarantees
  are the only monetary requirement in the text). **[VERIFIED DIRECTIVE TEXT]**
- **Process:** a Technical Team certifies test results by two-thirds vote; an Accreditation
  Board approves; the certificate is signed jointly by the Board chairperson and the State
  Minister of the E-Data Division (Art. 18). Licenses renew **every two years** (Art. 12).
  Suppliers owe a six-month exit notice, an approved exit strategy, and data-migration support
  (Art. 17). **[VERIFIED DIRECTIVE TEXT]**
- **Ecosystem reality check:** even the local platform marketing itself for this mandate
  (HayeFintax EIMS) advertises "MoR certification **in progress**" — i.e., as of Aug 2026 the
  accreditation pipeline appears young; no accredited-vendor list could be found published.
  **[SECONDARY SOURCE / COULD NOT VERIFY]**

## 1.5 Offline / device / fiscal-printer requirements

- **No fiscal printers.** The directive is software-defined; it replaces the electronic-fiscal-
  device paradigm rather than extending it. (Verified absence of any fiscal-device requirement
  in the text; the legacy EFD regime under older law continues until the schedule migrates a
  taxpayer.) **[VERIFIED DIRECTIVE TEXT]** for the directive itself; interplay with legacy EFD
  obligations **[UNCONFIRMED CLAIM]** — ask counsel.
- **Offline capability is MANDATORY only for the 26 sectors in Annex 2** — all retail,
  passenger transport, postal, accommodation, restaurants/beverage, hospitals/medical/dental,
  hair/beauty/spa, veterinary, amusement parks. **Manufacturing and wholesale are NOT on the
  list.** The Authority may amend the list (Art. 19(4)). **[VERIFIED DIRECTIVE TEXT]**
  *(The prior report treated "offline resilience mandatory for 26 sectors" as JENIFY-friendly —
  true, but note Mesob's sector is not one of them; offline support remains a JENIFY advantage,
  not a legal obligation for Mesob.)*
- **Offline mechanics:** offline-capable systems must queue and then register all offline
  transactions **within 72 hours of connection restoration**, delivering e-invoices to buyers
  (Art. 23). Interim fallbacks: the Authority's own **Cloud Sales Registration System**, or
  manual QR-coded invoices (reprints marked "DUPLICATE"), with a 2-hour provider-confirmation
  rule before switching to fallback. **[VERIFIED DIRECTIVE TEXT]**

## 1.6 Penalties

- The directive sets **no birr amounts**. Violations (failure to register invoices, tampering,
  discrepancies between registered and issued invoices, unauthorized transfer of systems) carry
  administrative penalties and, as applicable, criminal liability **under Tax Administration
  Proclamation 983/2016** (Art. 27); suppliers face civil/criminal liability and forfeiture of
  the performance guarantee for system-caused violations (Art. 28). **[VERIFIED DIRECTIVE TEXT]**
- Context: a draft amendment to the Tax Administration Proclamation reportedly doubles the
  fine for failure to issue receipts from ETB 50,000 to **ETB 100,000** per violation.
  **[UNCONFIRMED CLAIM]** — [Ethio Negari, May 2026](https://ethionegari.com/2026/05/19/ethiopia-to-double-penalties-for-traders-without-receipts/)
- Legacy EFD tampering fines (up to ETB 200,000 + imprisonment) exist under prior law.
  **[SECONDARY SOURCE]**

## 1.7 What this means for MESOB and for JENIFY — obligations and timing

**Mesob (VAT-registered salt manufacturer, Tigray, keeps books of account):**
- Is **squarely in scope** of Art. 19(1) — but **owes nothing yet**, because no implementation
  schedule has been published and the directive's entry into force is itself unconfirmed
  (§1.0). **[VERIFIED DIRECTIVE TEXT + COULD NOT VERIFY]**
- When the schedule reaches Mesob, its invoices become invalid unless issued through an
  **accredited** system connected to the Ministry platform, and Mesob must obtain Taxpayer
  Portal credentials (System Number / API Key / Client Secret) and an INSA digital-signature
  certificate. **[VERIFIED DIRECTIVE TEXT]**
- Mesob's sector is **not** in Annex 2, so offline capability is not legally required for it —
  though the 72-hour offline replay rule is exactly what JENIFY's local-first design already
  anticipates. **[VERIFIED DIRECTIVE TEXT]**
- Whether Tigray's regional revenue administration follows the federal schedule identically is
  **[COULD NOT VERIFY]** — regional revenue bureaus sit on the accreditation structures, but
  regional rollout mechanics are unstated.

**JENIFY (the software):**
- Once Mesob is scheduled in, JENIFY **cannot lawfully remain Mesob's invoicing software
  without Ministry accreditation** — under one of two realistic tracks:
  1. **Supplier / SaaS track** (USD 30k/50k guarantee, 4/6 degreed staff, Ethiopian business
     license, INSA certs, conformity testing) — positions JENIFY to serve *any* Ethiopian tenant;
  2. **Exclusive-use track** (USD 15k guarantee) — Mesob licenses its own JENIFY deployment as
     software for its exclusive use; cheaper, but must be repeated per tenant and requires a
     maintenance agreement with the developer. **[VERIFIED DIRECTIVE TEXT]**
- Both tracks presuppose an **Ethiopian-registered legal entity** and real money (guarantee) —
  a Founder-level corporate decision, not an engineering task. **[VERIFIED DIRECTIVE TEXT]**
- The API/integration specification and the Offline Resiliency Specification are **not public**;
  building against them today would violate the Founder's "no unverified specifics" rule and
  is also practically impossible. **[COULD NOT VERIFY]**

**The single most urgent fact:** Ethiopia has chosen a **hard pre-clearance model with mandatory
government accreditation of invoicing software** — but with **no published dates**. The correct
posture is exactly the Founder's: build the boundary (Part 2), watch for two triggers — (a) the
directive appearing on the MoR website (entry into force), (b) publication of the Art. 29(1)
implementation schedule — and only then commission the legal/accreditation project.

## 1.8 Questions ready to send to an Ethiopian accountant / the Ministry of Revenues

> 1. Has the Electronic Invoicing System Administration Directive No. 1142/2018 E.C.
>    (1142/2026) been registered with the Ministry of Justice and published on the Ministry of
>    Revenues website, per its Article 31? On what date? Please share the official published copy.
> 2. Has the Ministry issued the implementation schedule referred to in Article 29(1)? If yes,
>    where is it published, and when does it reach a VAT-registered manufacturing company of our
>    profile (salt manufacturer, Tigray region, federal or regional tax administration)?
> 3. Until our company is scheduled in, which invoicing rules govern us — Directive 149/2011 E.C.
>    (minus its repealed Articles 8 and 23) and the existing EFD regime? Are our current
>    printed/EFD invoices fully valid in the interim?
> 4. Where do software developers obtain the technical integration specification, sandbox/test
>    access to the Electronic Invoice Registration System, and the "Offline Resiliency
>    Specification" referenced in Article 4? Is the Inspection and Accreditation Board accepting
>    applications now, and what is the realistic end-to-end accreditation lead time?
> 5. For a multi-tenant business platform deployed locally at each customer: does each
>    deployment qualify for the "exclusive use" track (Article 14(5), USD 15,000 guarantee), or
>    must the vendor be accredited as a Supplier/SaaS provider (Articles 14(2)/(3))? Can a
>    foreign-owned but Ethiopian-registered company apply?
> 6. Are there any application, testing, or annual fees beyond the performance guarantees? Can
>    the USD-denominated guarantee be posted in ETB by a domestic company, given NBE FX rules?
> 7. Please provide the authoritative field list for invoices: Article 20 of VAT Regulation
>    No. 570/2017 E.C. plus the directive's Annex 1 sample invoice (our copy's Annex 1 is not
>    legible). Does it add QR/IRN placement, buyer TIN, or bilingual requirements?
> 8. What is the exact procedure, cost, validity period, and Tigray-accessible office for the
>    INSA digital-signature certificate required of taxpayers (Article 19(5))? Which "authorized
>    bodies" other than INSA may issue it?
> 9. Salt manufacturing is not in Annex 2 (mandatory offline sectors). Confirm that offline
>    capability is optional for us, and how the 72-hour offline registration window and manual
>    QR-invoice fallback work in practice during regional connectivity shutdowns.
> 10. Is the Authority's Cloud Sales Registration System live and open for use today? Could we
>     adopt it voluntarily before our vendor is accredited, and later migrate?
> 11. What penalties currently attach to e-invoicing violations under Proclamation 983/2016, and
>     what is the status of the reported draft amendment doubling the no-receipt fine to
>     ETB 100,000?
> 12. Is there a published register of accredited sales registration systems/suppliers we can
>     check before buying anything?

---

# PART 2 — COMPLIANCE GATEWAY ARCHITECTURE (design only, mission §33)

**Goal:** one extensible boundary through which ANY country's e-invoicing / tax integration can
later plug in — Ethiopia 1142, Kenya eTIMS, Rwanda EBM, Uganda EFRIS, Ghana CIS, Egypt ETA —
without country logic in core, without giving any government a window into the OS, and without
implementing a single unverified specification today.

```
BUSINESS DATA (full OS: ledger, parties, costing, production…)
      │  (allowlist projection — nothing else crosses)
      ▼
COMPLIANCE GATEWAY  (platform capability boundary, country-agnostic)
      │  canonical fiscal document → country adapter mapping
      ▼
MINIMUM LEGALLY REQUIRED DATA  (per-country dataset, explicit field allowlist)
      │  store-and-forward queue, signing, transport
      ▼
AUDITED SUBMISSION  (append-only submission ledger + government response artifacts)
```

## 2.1 Where it sits in the existing template layer stack

The platform already resolves configuration through ordered layers
(`core → capability → sector → subsector → country → company`,
`packages/shared/src/templates.ts`, `LAYER_KINDS`) with per-key provenance. The gateway slots in
without new concepts:

- **Core** contributes the gateway capability itself: the canonical fiscal-document model, the
  adapter contract, the submission ledger, the queue. A future `compliance` capability id in the
  catalog (design-only for now; depends on `invoicing`) — added only when implementation is
  approved, so the catalog contract stays unpolluted today.
- **Country layer** (`kind: 'country'`, rank 4 — e.g. a future `country.ethiopia` template)
  *declares* the adapter and its configuration under the capability's config namespace:
  adapter id, regime model, mandatory-field map, offline window, credential kinds required,
  document-type coverage. This is exactly how country packs were framed in the prior report:
  **configuration + adapters, never `if (country === 'ET')` in core.**
- **Company layer** (rank 5) carries tenant-specific state: enrollment status, credential
  references, the tenant's chosen compliance mode (e.g. "not yet scheduled — gateway dormant").
- All of it rides the existing **append-only versioned settings** model, so regulatory
  parameter changes (a new schedule wave, a changed field list) are new versions with
  provenance, never edits — the same discipline Kenya's yearly payroll churn demands.

## 2.2 Adapter interface concept (per country pack — concept, not code)

Each country pack ships one **compliance adapter** honoring a small platform contract:

- **Descriptor** — declares the regime so core UI/behavior can adapt generically:
  - model: `pre-clearance` (Ethiopia/Rwanda/Egypt) | `real-time-report` (Uganda) |
    `post-audit / periodic` (South Africa today) | `none`;
  - timing: blocking-before-issue | async-within-N-hours | batch;
  - artifacts returned: registration number(s), QR payload, verification URL;
  - fallback modes legally available (offline queue, authority cloud system, manual+QR);
  - credential kinds required (API key / client secret / signature certificate / device id) —
    *kinds only; values live in tenant-scoped secure config, never in the pack*.
- **Mapping** — a declarative projection from the platform's canonical fiscal document
  (invoice, receipt, credit/debit note, cancellation) to the country's minimum dataset.
  The mapping is an **allowlist**: any field not named simply does not exist at the boundary.
- **Lifecycle verbs** — `validate` (local pre-check), `submit`, `cancel/void`,
  `creditNote/debitNote`, `healthCheck`, `replay` (offline catch-up). Verbs a regime lacks are
  declared unsupported; core renders accordingly.
- **Response handling** — writes government artifacts (IRN/RRN/QR/UUID) back onto the document
  as **compliance annotations** rendered on the printed/PDF document via the existing document
  template layer; annotations are part of the immutable posted document.
- Adapters are **versioned artifacts** owned by the country pack, testable against a recorded
  transport (see 2.6), and swappable without touching core.

## 2.3 Data minimization — the government never gets the OS

Non-negotiable design rules, aligned with "Founder data is sacred":

1. **Outbound only.** The gateway makes outbound submissions; there is no inbound query surface
   through which an authority (or a compromised authority platform) can enumerate tenant data.
   Anything the regime requires the business to *show* later is answered by exporting from the
   submission ledger, deliberately, by an authorized user.
2. **Allowlist projection.** The Minimum Legally Required Dataset is constructed per document
   from the adapter's declared mapping. Costing, margins, supplier prices, employee data, other
   tenants — categorically outside the projection; there is no code path that could include them.
3. **Provable payloads.** Every outbound payload is persisted verbatim (with hash + timestamp)
   before transmission. What was sent is always answerable, exactly, forever.
4. **Credential isolation.** Government credentials are tenant-scoped secrets (per-tenant
   System Number / API key / signature cert in Ethiopia's case), encrypted at rest, never in
   config packs, never in logs, never shared across tenants.
5. **Signing as a boundary service.** Where a regime requires digital signatures (Ethiopia:
   INSA certificate; Egypt: HSM/USB token), signing happens inside the gateway boundary via a
   pluggable signer, so certificate material never touches business-logic code.

## 2.4 Audited submission trail

A **submission ledger**, mirroring the stock-ledger philosophy (CLAUDE.md principle 5):

- Append-only rows: document ref → payload hash → attempt # → transport result → authority
  response (artifact or rejection) → state transition
  (`draft → queued → submitted → cleared | rejected → cancelled/corrected`).
- Never edited. Retries, corrections, cancellations are **new entries** linked to prior ones —
  the genealogy pattern the platform already uses for lots/traceability.
- Reconciliation view: every posted fiscal document either has a cleared submission, a queued
  one inside its legal window, or a flagged exception. Exceptions are a work queue for a human,
  never silently dropped.
- The trail is itself evidence for accreditation audits (Ethiopia Art. 27 discrepancy
  liability): we can show, per invoice, what was sent, when, and what the authority answered.

## 2.5 Offline / store-and-forward

Designed for the reality the prior report documented (power cuts, shutdown risk) and now
legally echoed by Ethiopia's own 72-hour replay rule:

- **Queue-first:** every submission enters a durable per-tenant FIFO queue with monotonic
  sequence numbers; the transport drains it when connectivity exists. Online, the queue is just
  a fast pipe; offline, it is the buffer. One mechanism, no special cases — and it composes
  with jenify-offline-infra's existing offline-queue direction rather than duplicating it.
- **Provisional issuance state:** where a regime permits issuing during outage (with duplicate
  marking / manual QR rules), documents carry an explicit `pending-registration` compliance
  state, visibly distinct on screen and print, resolved on replay. Where a regime forbids
  issuing before clearance, the adapter descriptor says so and core blocks issuance instead —
  same machinery, different declared policy.
- **Window enforcement:** the adapter config declares the legal replay window (Ethiopia: 72h —
  *once verified*); the gateway warns as expiry approaches and escalates on breach. The window
  is country-pack config, never a core constant.
- **Deterministic replay:** idempotent submissions keyed by document + sequence, so a replay
  after a crash can never double-register a sale.

## 2.6 Certification-readiness without unverified specifics

What we build now vs. what waits for verified specs:

- **Now (platform, country-agnostic):** canonical fiscal document; adapter contract; submission
  ledger; queue; secure credential store; signer plug-point; compliance annotations on printed
  documents; a **recorded/mock transport** so the whole pipeline is testable end-to-end with a
  fictional "Testland" adapter in the test suite.
- **Now (evidence posture):** the accreditation checklists we have seen (Ethiopia Art. 4;
  Rwanda CIS; Kenya OSCU/VSCU) all ask for the same demonstrables — real-time transmit,
  artifact rendering, offline replay, access control, audit logging. Each maps to an existing
  platform capability (auth/RBAC, audit, documents) plus the gateway above. We maintain a
  per-country **conformance checklist as pack data**, so "what would certification require"
  is a report, not a research project.
- **Later, gated on Founder approval + verified specs:** the real Ethiopian adapter (mapping,
  transport, signing) written against the Ministry's official API documents obtained through
  the §1.8 channel; sandbox testing; the accreditation application itself (a legal/corporate
  project, per §1.7). Until then the Ethiopia country layer declares the adapter as
  **`status: 'pending-verification'`** — visible in config, impossible to enable.

**What this design refuses to do:** implement any endpoint, field list, QR format, or offline
window from this brief's secondary sources; claim compliance anywhere in UI or docs; give any
adapter read access beyond its declared projection; or let a government integration become a
tenant-data exfiltration path.

---

## Sources

**Primary / near-primary**
- Directive full text (bilingual PDF, 57 pp., unofficial copy): [Eagle Advocates hosted PDF](https://eagleadvocates.com/wp-content/uploads/2026/06/1142_የኤሌክትሮኒክ_ደረሰኝ_ሥርዓት_አስተዳደር_መመሪያ_ቁጥር_1142_2018.pdf) — retained in session scratchpad (`directive_1142_2018_amharic.pdf`)
- [INSA — Electronic Invoice Management System launch](https://www.insa.gov.et/blog/INSA-Launches-Electronic-Invoice-Management-System) (official, Oct 2024)
- `mor.gov.et` — **unreachable** (TLS certificate failure, HTTPS and HTTP, 2026-08-22)

**Secondary (professional)**
- [Kiya & Associates — legal analysis of Directive 1142/2026](https://kiyalaw.com/insights/ethiopia-e-invoicing-directive-1142-2026/) (2 Jul 2026)
- [PKF Ethiopia (Feysel & Associates) — directive overview](https://www.feyselandassociates.com/insights/articles-and-updates/ethiopia-introduces-electronic-invoicing-directive-no-11422026/) (28 Jun 2026)
- [Eagle Advocates — directive guide](https://eagleadvocates.com/ethiopia-electronic-invoicing-system-directive-1142/) (17 Jun 2026)
- [Haymanot & Advocates — VAT Proclamation 1341/2024 + Regulation 570/2025 overview](https://www.haymanotbelay.com/ethiopias-new-vat-framework-overview-of-proclamation-no-1341-2024-and-regulation-no-570-2025/)
- [ethiodata.et — VAT Regulation 570/2025 text](https://ethiodata.et/ethiopia-value-added-tax-regulation-no-570-2025/)

**Secondary (press / market)**
- [The Reporter — accreditation board established](https://www.thereporterethiopia.com/51673/) (403 to automated access; search excerpts only)
- [The Reporter — Oct 2023 pilot article previously miscited as 2026 go-live](https://www.thereporterethiopia.com/36959/)
- [Ethio Negari — draft penalty doubling](https://ethionegari.com/2026/05/19/ethiopia-to-double-penalties-for-traders-without-receipts/) (unconfirmed)
- [HayeFintax EIMS](https://einvoice.hayefintax.com/) ("MoR certification in progress" — vendor claim)
- [e-invoice.app Ethiopia tracker](https://www.e-invoice.app/country/ET) (403 to automated access; search listing labels rollout "planned for 2027" — unconfirmed aggregator estimate)
