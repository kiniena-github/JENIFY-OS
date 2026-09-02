import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

// ---------------------------------------------------------------------------
// Conventions
//  - ids: UUIDv7 text
//  - timestamps: ISO-8601 text (UTC)
//  - stock quantities: integer milli base-units (kg * 1000 / pieces * 1000)
//  - money: integer cents
//  - every business table carries tenant_id; services must always filter by it
// ---------------------------------------------------------------------------

// ============================ Platform =====================================

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  locationNote: text('location_note'),
  currency: text('currency').notNull().default('ETB'),
  timezone: text('timezone').notNull().default('UTC'),
  brandColor: text('brand_color'),
  logoPath: text('logo_path'),
  // classification used ONLY for aggregated language/terminology intelligence
  // and future template routing — never for business logic branching
  sector: text('sector'),
  country: text('country'),
  region: text('region'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
});

export const tenantSettings = sqliteTable(
  'tenant_settings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    domain: text('domain').notNull(), // 'general' | 'numbering' | 'pricing' | 'alerts' | ...
    version: integer('version').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('tenant_settings_ver').on(t.tenantId, t.domain, t.version),
    index('tenant_settings_domain').on(t.tenantId, t.domain),
  ],
);

export const roles = sqliteTable(
  'roles',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    dashboardFocus: text('dashboard_focus'), // module id
    isOwnerRole: integer('is_owner_role', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('roles_code').on(t.tenantId, t.code)],
);

export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    roleId: text('role_id').notNull(),
    version: integer('version').notNull(),
    matrix: text('matrix', { mode: 'json' }).notNull(), // PermissionMatrix
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('role_permissions_ver').on(t.roleId, t.version)],
);

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    email: text('email'),
    phone: text('phone'),
    passwordHash: text('password_hash').notNull(),
    roleId: text('role_id').notNull(),
    language: text('language').notNull().default('en'),
    theme: text('theme').notNull().default('system'), // light | dark | system
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    lastLoginAt: text('last_login_at'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('users_username').on(t.tenantId, t.username)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    token: text('token').notNull().unique(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id'),
    module: text('module').notNull(),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    reference: text('reference'),
    summary: text('summary').notNull(),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    reason: text('reason'),
    result: text('result').notNull().default('success'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('audit_tenant_time').on(t.tenantId, t.createdAt),
    index('audit_entity').on(t.tenantId, t.entity, t.entityId),
  ],
);

export const translationKeys = sqliteTable('translation_keys', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  enText: text('en_text').notNull(),
  module: text('module'),
  createdAt: text('created_at').notNull(),
});

export const translations = sqliteTable(
  'translations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    keyId: text('key_id').notNull(),
    language: text('language').notNull(),
    text: text('text').notNull(),
    status: text('status').notNull().default('placeholder'), // placeholder | active
    updatedBy: text('updated_by'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('translations_key_lang').on(t.tenantId, t.keyId, t.language),
    // perf (migration 0007): getBundle filters by (tenant, language); the
    // cross-tenant language-intelligence aggregation filters by (language,
    // status) across all tenants — both were scanning the table
    index('translations_tenant_lang').on(t.tenantId, t.language),
    index('translations_lang_status').on(t.language, t.status),
  ],
);

export const tenantLanguages = sqliteTable(
  'tenant_languages',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(), // 'en' | 'am' | 'ti' | ...
    name: text('name').notNull(),
    nativeName: text('native_name'),
    direction: text('direction').notNull().default('ltr'), // ltr | rtl
    flagEmoji: text('flag_emoji'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('tenant_languages_code').on(t.tenantId, t.code)],
);

// ------------------- Template & capability platform ------------------------
// Published template layers are IMMUTABLE (append-only versions). A tenant
// binds to an ordered set of layers; its effective config is resolved
// deterministically (see @factoryos/shared resolveTemplate). Company overrides
// remain in tenant_settings — the highest-precedence layer at resolution time.

export const templateLayers = sqliteTable(
  'template_layers',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id').notNull(), // stable id, e.g. 'sector.manufacturing'
    kind: text('kind').notNull(), // core | capability | sector | subsector | country | company
    version: integer('version').notNull(),
    labelKey: text('label_key').notNull(),
    extendsId: text('extends_id'), // parent template id (null for roots)
    status: text('status').notNull().default('published'), // published | superseded
    // full TemplateLayer payload (activations + config) as authored
    definition: text('definition', { mode: 'json' }).notNull(),
    createdBy: text('created_by'),
    publishedAt: text('published_at').notNull(),
  },
  (t) => [
    uniqueIndex('template_layers_ver').on(t.templateId, t.version),
    index('template_layers_kind').on(t.kind, t.status),
  ],
);

// Which published layers (by templateId, pinned to a version) a tenant binds
// to, and in what order. Append-only history; the active binding is the newest.
export const tenantTemplateBindings = sqliteTable(
  'tenant_template_bindings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    version: integer('version').notNull(), // binding-set version (not layer version)
    // ordered [{ templateId, version }] lowest-precedence first
    layers: text('layers', { mode: 'json' }).notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('tenant_template_bindings_ver').on(t.tenantId, t.version)],
);

// ------------------- Work orders (shared capability) -----------------------
// ONE dispatched-job primitive serving automotive workshops, field service,
// utilities field crews, mining/hospitality/property maintenance. Lifecycle is
// append-only in spirit: status transitions are audited, parts consumed post
// real stock movements, and a completed job is corrected by a new job or an
// audited reopen — never by silently editing history.
export const workOrders = sqliteTable(
  'work_orders',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    /** sector-neutral job type slug, e.g. 'repair' | 'service' | 'inspection' */
    kind: text('kind').notNull().default('job'),
    title: text('title').notNull(),
    description: text('description'),
    /** who the job is for (customer) — optional for internal maintenance */
    customerId: text('customer_id'),
    /** what the job is on (vehicle, machine, room, meter) — free reference */
    assetRef: text('asset_ref'),
    assignedToUserId: text('assigned_to_user_id'),
    status: text('status').notNull().default('draft'), // draft|scheduled|in_progress|completed|cancelled
    priority: text('priority').notNull().default('normal'), // low|normal|high
    scheduledFor: text('scheduled_for'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    completionNote: text('completion_note'),
    cancelledReason: text('cancelled_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('work_orders_number').on(t.tenantId, t.docNumber),
    index('work_orders_assignee').on(t.tenantId, t.assignedToUserId, t.status),
    index('work_orders_status').on(t.tenantId, t.status, t.scheduledFor),
  ],
);

/** Parts/materials consumed by a job — each row posted a real stock movement. */
export const workOrderParts = sqliteTable(
  'work_order_parts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workOrderId: text('work_order_id').notNull(),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    lotId: text('lot_id'),
    qty: integer('qty').notNull(), // milli base-units issued
    issuedBy: text('issued_by'),
    issuedAt: text('issued_at').notNull(),
  },
  (t) => [index('work_order_parts_wo').on(t.workOrderId)],
);

// ------------------- Bookings (shared capability) ---------------------------
// ONE reserved-time-or-space primitive serving hotel rooms, restaurant tables,
// clinic appointments and class sessions. The load-bearing rule is the same in
// every sector: a resource cannot be double-booked for overlapping time.
export const bookableResources = sqliteTable(
  'bookable_resources',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** 'room' | 'table' | 'practitioner' | 'class' — sector wording via i18n */
    kind: text('kind').notNull().default('resource'),
    capacity: integer('capacity').notNull().default(1),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('bookable_resources_code').on(t.tenantId, t.code)],
);

export const bookings = sqliteTable(
  'bookings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    resourceId: text('resource_id').notNull(),
    customerId: text('customer_id'),
    /** ISO instants; [startAt, endAt) half-open so back-to-back never collides */
    startAt: text('start_at').notNull(),
    endAt: text('end_at').notNull(),
    partySize: integer('party_size').notNull().default(1),
    status: text('status').notNull().default('confirmed'), // confirmed|checked_in|completed|cancelled|no_show
    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('bookings_number').on(t.tenantId, t.docNumber),
    index('bookings_resource_time').on(t.tenantId, t.resourceId, t.startAt),
    index('bookings_status').on(t.tenantId, t.status, t.startAt),
  ],
);

// ------------------- Returns (sales credit notes + purchase returns) -------
// Immutable, append-only. A return NEVER edits the original invoice/receipt;
// it is a new posted document that posts its own compensating stock movement
// (sale_return: +stock; purchase_return: -stock) and adjusts the derived
// receivable/payable. Partial quantities are supported; over-return is blocked.

export const creditNotes = sqliteTable(
  'credit_notes',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    invoiceId: text('invoice_id').notNull(),
    customerId: text('customer_id').notNull(),
    date: text('date').notNull(),
    reason: text('reason'),
    totalCents: integer('total_cents').notNull().default(0),
    status: text('status').notNull().default('posted'), // posted | reversed
    reversalReason: text('reversal_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('credit_notes_number').on(t.tenantId, t.docNumber),
    index('credit_notes_invoice').on(t.tenantId, t.invoiceId),
    index('credit_notes_customer').on(t.tenantId, t.customerId, t.status),
  ],
);

export const creditNoteLines = sqliteTable(
  'credit_note_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    creditNoteId: text('credit_note_id').notNull(),
    invoiceLineId: text('invoice_line_id'),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    lotId: text('lot_id'),
    qty: integer('qty').notNull(), // milli base-units returned
    restock: integer('restock', { mode: 'boolean' }).notNull().default(true),
    amountCents: integer('amount_cents').notNull().default(0),
  },
  (t) => [index('credit_note_lines_note').on(t.creditNoteId)],
);

export const purchaseReturns = sqliteTable(
  'purchase_returns',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    receiptId: text('receipt_id').notNull(),
    supplierId: text('supplier_id').notNull(),
    date: text('date').notNull(),
    reason: text('reason'),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    lotId: text('lot_id'),
    qty: integer('qty').notNull(), // milli base-units returned to supplier
    amountCents: integer('amount_cents').notNull().default(0),
    status: text('status').notNull().default('posted'), // posted | reversed
    reversalReason: text('reversal_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('purchase_returns_number').on(t.tenantId, t.docNumber),
    index('purchase_returns_receipt').on(t.tenantId, t.receiptId),
  ],
);

// ------------------- Role Experience (presentation config) -----------------
// Versioned per role, like role_permissions. The spec is a PRESENTATION hint;
// RBAC remains authoritative and is enforced independently on every route. The
// resolver intersects this with the user's real permissions before serving it.
export const roleExperiences = sqliteTable(
  'role_experiences',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    roleId: text('role_id').notNull(),
    version: integer('version').notNull(),
    spec: text('spec', { mode: 'json' }).notNull(), // RoleExperienceSpec
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('role_experiences_ver').on(t.roleId, t.version)],
);

// ------------------- Approvals (shared Core capability) --------------------
export const approvalPolicies = sqliteTable(
  'approval_policies',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    subjectType: text('subject_type').notNull(),
    version: integer('version').notNull(),
    policy: text('policy', { mode: 'json' }).notNull(), // ApprovalPolicy
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('approval_policies_ver').on(t.tenantId, t.subjectType, t.version)],
);

export const approvalRequests = sqliteTable(
  'approval_requests',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: text('subject_id').notNull(), // the domain record awaiting approval
    magnitudeMinor: integer('magnitude_minor').notNull().default(0),
    status: text('status').notNull().default('pending'), // pending|approved|rejected|cancelled
    currentStep: integer('current_step').notNull().default(0),
    totalSteps: integer('total_steps').notNull().default(1),
    policyVersion: integer('policy_version'),
    requestedBy: text('requested_by'),
    createdAt: text('created_at').notNull(),
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    index('approval_requests_subject').on(t.tenantId, t.subjectType, t.subjectId),
    index('approval_requests_status').on(t.tenantId, t.status),
  ],
);

// Append-only ledger of every action taken on an approval request.
export const approvalActions = sqliteTable(
  'approval_actions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    requestId: text('request_id').notNull(),
    step: integer('step').notNull(),
    action: text('action').notNull(), // submit|approve|reject|cancel|comment|resubmit
    actorUserId: text('actor_user_id'),
    comment: text('comment'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('approval_actions_request').on(t.requestId)],
);

// ------------------- Offline sync (O2 — Receiving first) -------------------
// Server-authoritative operation log. A device captures an operation offline
// with a client-generated idempotency key; on reconnect it replays here. The
// server applies each op AT MOST ONCE and records the outcome, so a duplicate
// replay returns the original result instead of double-posting. NEVER a silent
// last-write-wins: a business rejection is recorded and surfaced, not merged.
export const syncOps = sqliteTable(
  'sync_ops',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    // client-generated UUIDv7 idempotency key — the uniqueness anchor
    opKey: text('op_key').notNull(),
    opType: text('op_type').notNull(), // e.g. 'receiving.post'
    payload: text('payload', { mode: 'json' }).notNull(),
    status: text('status').notNull(), // applied | rejected | conflict
    resultRef: text('result_ref'), // id/number of the created record when applied
    message: text('message'), // rejection/conflict explanation (surfaced to user)
    deviceId: text('device_id'),
    appliedBy: text('applied_by'),
    clientCreatedAt: text('client_created_at'),
    serverAppliedAt: text('server_applied_at').notNull(),
  },
  (t) => [uniqueIndex('sync_ops_key').on(t.tenantId, t.opKey)],
);

// ------------------- Language intelligence (platform-level) ----------------
// Official JENIFY language packs are global defaults layered UNDER tenant
// overrides: English base -> official global pack -> country variant ->
// sector variant -> tenant override -> user language choice. Packs are
// versioned append-only snapshots; approving or rolling back a translation
// always creates a NEW pack version — history is never rewritten.

export const languagePacks = sqliteTable(
  'language_packs',
  {
    id: text('id').primaryKey(),
    language: text('language').notNull(),
    scope: text('scope').notNull().default('global'), // global | country | sector
    scopeValue: text('scope_value').notNull().default(''), // '' for global; country/sector code otherwise
    version: integer('version').notNull(),
    status: text('status').notNull().default('official'), // official | superseded | retired
    notes: text('notes'),
    createdBy: text('created_by'), // approving user id (platform language authority)
    approvedAt: text('approved_at').notNull(),
  },
  (t) => [
    uniqueIndex('language_packs_ver').on(t.language, t.scope, t.scopeValue, t.version),
    index('language_packs_lang').on(t.language, t.status),
  ],
);

export const languagePackEntries = sqliteTable(
  'language_pack_entries',
  {
    id: text('id').primaryKey(),
    packId: text('pack_id').notNull(),
    keyId: text('key_id').notNull(),
    value: text('value').notNull(),
  },
  (t) => [uniqueIndex('language_pack_entries_key').on(t.packId, t.keyId)],
);

// Append-only review ledger: every human decision on a translation candidate
// (approve / reject / defer / sector_specific / regional_variant / rollback)
// with who, when, why, previous value, and the resulting pack version.
export const translationDecisions = sqliteTable(
  'translation_decisions',
  {
    id: text('id').primaryKey(),
    keyId: text('key_id').notNull(),
    language: text('language').notNull(),
    scope: text('scope').notNull().default('global'),
    scopeValue: text('scope_value').notNull().default(''),
    decision: text('decision').notNull(), // approve | reject | defer | sector_specific | regional_variant | rollback
    value: text('value'), // the candidate value the decision addressed
    previousValue: text('previous_value'), // official value before (null = none)
    reason: text('reason'),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at').notNull(),
    packVersion: integer('pack_version'), // set when the decision produced a pack version
  },
  (t) => [index('translation_decisions_key').on(t.keyId, t.language)],
);

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    fileName: text('file_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    storagePath: text('storage_path').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    uploadedBy: text('uploaded_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('attachments_entity').on(t.tenantId, t.entity, t.entityId)],
);

export const documentSequences = sqliteTable(
  'document_sequences',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    seqKey: text('seq_key').notNull(), // 'receiving' | 'transfer' | 'invoice' | 'lot.raw' | ...
    prefix: text('prefix').notNull(),
    padding: integer('padding').notNull().default(4),
    nextValue: integer('next_value').notNull().default(1),
  },
  (t) => [uniqueIndex('document_sequences_key').on(t.tenantId, t.seqKey)],
);

// ============================ Business core ================================

export const parties = sqliteTable(
  'parties',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    kind: text('kind').notNull(), // customer | supplier | both
    name: text('name').notNull(),
    partyType: text('party_type'), // tenant-configured category (retailer/wholesaler/...)
    phone: text('phone'),
    location: text('location'),
    taxInfo: text('tax_info'),
    creditLimitCents: integer('credit_limit_cents'),
    defaultPriceCategory: text('default_price_category'),
    notes: text('notes'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('parties_kind').on(t.tenantId, t.kind)],
);

export const uoms = sqliteTable(
  'uoms',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    family: text('family').notNull(), // 'mass' | 'count' | ...
    factorToBase: integer('factor_to_base_milli').notNull(), // milli: kg=1000, ton=1000000, quintal=100000, piece=1000
  },
  (t) => [uniqueIndex('uoms_code').on(t.tenantId, t.code)],
);

export const items = sqliteTable(
  'items',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(), // raw_material | finished_good | consumable | other
    trackingMode: text('tracking_mode').notNull().default('none'), // none | lot | serial(future)
    baseUomId: text('base_uom_id').notNull(),
    /** for packaged finished goods: net weight of one unit, in milli-kg (500g -> 500) */
    unitWeightMilliKg: integer('unit_weight_milli_kg'),
    sellable: integer('sellable', { mode: 'boolean' }).notNull().default(false),
    purchasable: integer('purchasable', { mode: 'boolean' }).notNull().default(false),
    attributes: text('attributes', { mode: 'json' }),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('items_code').on(t.tenantId, t.code)],
);

export const warehouses = sqliteTable(
  'warehouses',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    locationNote: text('location_note'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('warehouses_code').on(t.tenantId, t.code)],
);

export const lots = sqliteTable(
  'lots',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id').notNull(),
    lotNumber: text('lot_number').notNull(),
    status: text('status').notNull().default('available'),
    sourceKind: text('source_kind'), // 'goods_receipt' | 'production_batch' | ...
    sourceId: text('source_id'),
    attributes: text('attributes', { mode: 'json' }),
    receivedAt: text('received_at'),
    initialQty: integer('initial_qty').notNull().default(0),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('lots_number').on(t.tenantId, t.lotNumber),
    index('lots_item').on(t.tenantId, t.itemId),
  ],
);

/** Append-only inventory ledger. Rows are never updated or deleted. */
export const stockMovements = sqliteTable(
  'stock_movements',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id').notNull(),
    lotId: text('lot_id'),
    warehouseId: text('warehouse_id').notNull(),
    qty: integer('qty').notNull(), // signed, milli base-units
    movementType: text('movement_type').notNull(),
    documentKind: text('document_kind').notNull(),
    documentId: text('document_id').notNull(),
    documentNumber: text('document_number'),
    counterpartId: text('counterpart_id'), // transfer pair / reversal target
    note: text('note'),
    postedBy: text('posted_by'),
    postedAt: text('posted_at').notNull(),
  },
  (t) => [
    index('movements_item_wh').on(t.tenantId, t.itemId, t.warehouseId),
    index('movements_lot').on(t.tenantId, t.lotId),
    index('movements_doc').on(t.tenantId, t.documentKind, t.documentId),
    // perf (migration 0007): report/list filters by type over time were
    // full-scanning + temp-b-tree sorting the whole tenant table
    index('movements_type_time').on(t.tenantId, t.movementType, t.postedAt),
  ],
);

/** Transactionally-maintained cache of Σ movements; always recomputable. */
export const stockBalances = sqliteTable(
  'stock_balances',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id').notNull(),
    lotId: text('lot_id').notNull().default(''), // '' when item is not lot-tracked
    warehouseId: text('warehouse_id').notNull(),
    qtyOnHand: integer('qty_on_hand').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('balances_key').on(t.tenantId, t.itemId, t.lotId, t.warehouseId)],
);

export const reservations = sqliteTable(
  'reservations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    itemId: text('item_id').notNull(),
    lotId: text('lot_id'),
    warehouseId: text('warehouse_id').notNull(),
    qty: integer('qty').notNull(), // positive, milli base-units
    status: text('status').notNull().default('active'), // active | consumed | released
    documentKind: text('document_kind').notNull(),
    documentId: text('document_id').notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
    closedAt: text('closed_at'),
  },
  (t) => [
    index('reservations_item').on(t.tenantId, t.itemId, t.warehouseId, t.status),
    index('reservations_doc').on(t.tenantId, t.documentKind, t.documentId),
  ],
);

// ============================ Operational documents ========================

export const goodsReceipts = sqliteTable(
  'goods_receipts',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    supplierId: text('supplier_id').notNull(),
    source: text('source'), // origin note (Mesob: locked to Afdera by config)
    truckNumber: text('truck_number'),
    driverName: text('driver_name'),
    itemId: text('item_id').notNull(),
    grossQty: integer('gross_qty'), // milli base-units
    netQty: integer('net_qty').notNull(),
    entryUomId: text('entry_uom_id').notNull(),
    entryQty: integer('entry_qty').notNull(), // as typed, milli entry-units
    warehouseId: text('warehouse_id').notNull(),
    receivedByUserId: text('received_by_user_id'),
    remarks: text('remarks'),
    lifecycle: text('lifecycle').notNull().default('draft'),
    lotId: text('lot_id'),
    approvedBy: text('approved_by'),
    postedAt: text('posted_at'),
    reversalOfId: text('reversal_of_id'),
    reversalReason: text('reversal_reason'),
    brandingVersion: integer('branding_version'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('receipts_number').on(t.tenantId, t.docNumber)],
);

export const stockTransfers = sqliteTable(
  'stock_transfers',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    itemId: text('item_id').notNull(),
    lotId: text('lot_id'),
    qty: integer('qty').notNull(), // milli base-units
    entryUomId: text('entry_uom_id').notNull(),
    fromWarehouseId: text('from_warehouse_id').notNull(),
    toWarehouseId: text('to_warehouse_id').notNull(),
    requestedBy: text('requested_by'),
    approvedBy: text('approved_by'),
    reason: text('reason'),
    lifecycle: text('lifecycle').notNull().default('draft'),
    postedAt: text('posted_at'),
    reversalOfId: text('reversal_of_id'),
    reversalReason: text('reversal_reason'),
    brandingVersion: integer('branding_version'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [uniqueIndex('transfers_number').on(t.tenantId, t.docNumber)],
);

// ============================ Production ===================================

export const productionStages = sqliteTable(
  'production_stages',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    code: text('code').notNull(),
    nameKey: text('name_key').notNull(), // translation key
    sequence: integer('sequence').notNull(),
    inputSource: text('input_source').notNull(), // 'lot' | 'prior_batch'
    outputForm: text('output_form').notNull(), // 'bulk' | 'packaged_items'
    requiresQc: integer('requires_qc', { mode: 'boolean' }).notNull().default(false),
    /** physics of the stage: measured (loss derived) | conserved (out = in) | converted (units) */
    outputPolicy: text('output_policy').notNull().default('measured'),
    inputItemId: text('input_item_id'),
    priorStageId: text('prior_stage_id'),
    outputItemIds: text('output_item_ids', { mode: 'json' }),
    attributes: text('attributes', { mode: 'json' }), // StageAttributeDef[]
    docSeqKey: text('doc_seq_key').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [uniqueIndex('stages_code').on(t.tenantId, t.code)],
);

export const productionBatches = sqliteTable(
  'production_batches',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    stageId: text('stage_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    status: text('status').notNull().default('draft'), // draft | in_progress | completed | cancelled
    // input
    inputLotId: text('input_lot_id'),
    inputBatchId: text('input_batch_id'), // prior-stage batch
    inputWarehouseId: text('input_warehouse_id'),
    inputQty: integer('input_qty').notNull().default(0), // milli base-units
    // bulk output (washing/iodization)
    outputQty: integer('output_qty'), // milli base-units
    lossQty: integer('loss_qty'), // derived: input - output
    consumedOutputQty: integer('consumed_output_qty').notNull().default(0), // taken by next stage
    // packaged output (packaging stage)
    outputItemId: text('output_item_id'),
    unitsProduced: integer('units_produced'), // milli pieces
    unitsRejected: integer('units_rejected'), // milli pieces
    outputWarehouseId: text('output_warehouse_id'),
    outputLotId: text('output_lot_id'),
    // qc
    qcStatus: text('qc_status').notNull().default('pending'), // pending|passed|failed|retest_required
    qcApprovedBy: text('qc_approved_by'),
    qcApprovedAt: text('qc_approved_at'),
    // people / meta — operator performs, supervisor reviews (separate identities)
    operatorName: text('operator_name'),
    supervisorName: text('supervisor_name'),
    recordedBy: text('recorded_by'),
    approvedBy: text('approved_by'),
    attributes: text('attributes', { mode: 'json' }), // e.g. { iodine_added_kg: 0.42 }
    notes: text('notes'),
    completedAt: text('completed_at'),
    cancelledReason: text('cancelled_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('batches_number').on(t.tenantId, t.docNumber),
    index('batches_stage').on(t.tenantId, t.stageId, t.status),
    index('batches_input_batch').on(t.tenantId, t.inputBatchId),
    index('batches_input_lot').on(t.tenantId, t.inputLotId),
  ],
);

/** Immutable QC test attempts. Retest = new row linked via previousTestId. */
export const qualityTests = sqliteTable(
  'quality_tests',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    batchId: text('batch_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    targetLevel: text('target_level'),
    actualResult: text('actual_result').notNull(),
    status: text('status').notNull(), // passed | failed | retest_required
    operatorName: text('operator_name'),
    testedBy: text('tested_by'),
    approvedBy: text('approved_by'),
    approvedAt: text('approved_at'),
    date: text('date').notNull(),
    notes: text('notes'),
    previousTestId: text('previous_test_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('qc_attempt').on(t.batchId, t.attemptNumber),
    // perf (migration 0007): batch QC lookups were full-scanning quality_tests
    index('qc_tenant_batch').on(t.tenantId, t.batchId),
  ],
);

// ============================ Commercial ===================================

/**
 * Reusable customer orders (Order Capability, issue #4). An order is the
 * commercial intent BEFORE the invoice: draft → confirmed (stock reserved)
 * → partially_fulfilled/fulfilled as quantities are carried to invoices.
 * Sector experiences differ via `channel` + configuration, not via copies.
 */
export const salesOrders = sqliteTable(
  'sales_orders',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    customerId: text('customer_id').notNull(),
    status: text('status').notNull().default('draft'), // draft|confirmed|partially_fulfilled|fulfilled|cancelled
    /** sector adapter tag ('standard', 'pos', 'ecommerce', ...) — reporting/UX only, never a fork of the lifecycle */
    channel: text('channel').notNull().default('standard'),
    priceCategory: text('price_category').notNull(),
    customPriceApprovedBy: text('custom_price_approved_by'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    vatCents: integer('vat_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    fulfillment: text('fulfillment').notNull().default('delivery'), // delivery | pickup
    expectedDate: text('expected_date'),
    pricingVersion: integer('pricing_version'),
    vatSnapshot: text('vat_snapshot', { mode: 'json' }),
    notes: text('notes'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: text('confirmed_at'),
    cancelledReason: text('cancelled_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('orders_number').on(t.tenantId, t.docNumber),
    index('orders_customer').on(t.tenantId, t.customerId, t.status),
    index('orders_date').on(t.tenantId, t.date),
  ],
);

export const salesOrderLines = sqliteTable(
  'sales_order_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    orderId: text('order_id').notNull(),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    qty: integer('qty').notNull(), // milli base-units ordered
    entryUomId: text('entry_uom_id').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    priceSource: text('price_source'), // 'list' | 'custom'
    discountCents: integer('discount_cents').notNull().default(0),
    lineSubtotalCents: integer('line_subtotal_cents').notNull(),
    // partial fulfilment: milli base-units already carried to invoices; the
    // order is fulfilled only when every line's qtyInvoiced reaches its qty
    qtyInvoiced: integer('qty_invoiced').notNull().default(0),
  },
  (t) => [index('order_lines_order').on(t.tenantId, t.orderId)],
);

export const salesInvoices = sqliteTable(
  'sales_invoices',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    customerId: text('customer_id').notNull(),
    /** set when this invoice fulfils (part of) a sales order */
    orderId: text('order_id'),
    status: text('status').notNull().default('pending'), // pending|confirmed|dispatched|completed|cancelled
    paymentTerm: text('payment_term').notNull(), // paid | credit | partial
    priceCategory: text('price_category').notNull(),
    customPriceApprovedBy: text('custom_price_approved_by'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    vatCents: integer('vat_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    dueDate: text('due_date'),
    fulfillment: text('fulfillment').notNull().default('delivery'), // delivery | pickup
    salespersonId: text('salesperson_id'),
    pricingVersion: integer('pricing_version'),
    vatSnapshot: text('vat_snapshot', { mode: 'json' }),
    brandingVersion: integer('branding_version'), // presentation snapshot at issuance
    notes: text('notes'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: text('confirmed_at'),
    cancelledReason: text('cancelled_reason'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('invoices_number').on(t.tenantId, t.docNumber),
    index('invoices_customer').on(t.tenantId, t.customerId, t.status),
    index('invoices_order').on(t.tenantId, t.orderId),
    // perf (migration 0007): period reports/lists sort the tenant's invoices
    // by date — was a temp-b-tree sort of the whole table
    index('invoices_date').on(t.tenantId, t.date),
  ],
);

export const invoiceLines = sqliteTable(
  'invoice_lines',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    itemId: text('item_id').notNull(),
    lotId: text('lot_id'),
    warehouseId: text('warehouse_id').notNull(),
    qty: integer('qty').notNull(), // milli base-units
    entryUomId: text('entry_uom_id').notNull(),
    unitPriceCents: integer('unit_price_cents').notNull(),
    priceSource: text('price_source'), // 'list' | 'custom'
    discountCents: integer('discount_cents').notNull().default(0),
    lineSubtotalCents: integer('line_subtotal_cents').notNull(),
    reservationId: text('reservation_id'),
    // split delivery: milli base-units already dispatched for this line; the
    // invoice completes only when every line's qtyDelivered reaches its qty
    qtyDelivered: integer('qty_delivered').notNull().default(0),
  },
  (t) => [index('invoice_lines_invoice').on(t.tenantId, t.invoiceId)],
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    invoiceId: text('invoice_id').notNull(),
    customerId: text('customer_id').notNull(),
    status: text('status').notNull().default('pending'), // pending|loading|dispatched|delivered|cancelled
    deliveryType: text('delivery_type').notNull().default('delivery'), // delivery | pickup
    destination: text('destination'),
    truckNumber: text('truck_number'),
    driverName: text('driver_name'),
    driverPhone: text('driver_phone'),
    dispatchDate: text('dispatch_date'),
    expectedDate: text('expected_date'),
    actualDate: text('actual_date'),
    proofAttachmentId: text('proof_attachment_id'),
    receivedBy: text('received_by'),
    notes: text('notes'),
    cancelledReason: text('cancelled_reason'),
    recordedBy: text('recorded_by'),
    brandingVersion: integer('branding_version'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('deliveries_number').on(t.tenantId, t.docNumber),
    index('deliveries_invoice').on(t.tenantId, t.invoiceId),
  ],
);

export const payments = sqliteTable(
  'payments',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    customerId: text('customer_id').notNull(),
    amountCents: integer('amount_cents').notNull(), // ALWAYS in the tenant default currency
    method: text('method').notNull(),
    // simple multi-currency: original amount + snapshotted rate; accounting
    // stays single-currency (amountCents) so history is never corrupted
    currency: text('currency'), // null = tenant default
    fxRate: real('fx_rate'), // default-currency units per 1 unit of `currency`
    originalAmountCents: integer('original_amount_cents'),
    referenceNumber: text('reference_number'),
    receivedByUserId: text('received_by_user_id'),
    notes: text('notes'),
    status: text('status').notNull().default('draft'), // draft | posted | reversed
    postedAt: text('posted_at'),
    reversalReason: text('reversal_reason'),
    reversalOfId: text('reversal_of_id'),
    brandingVersion: integer('branding_version'),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('payments_number').on(t.tenantId, t.docNumber),
    index('payments_customer').on(t.tenantId, t.customerId, t.status),
    // perf (migration 0007): period cash-inflow reports sort payments by date
    index('payments_date').on(t.tenantId, t.date),
  ],
);

/**
 * Lightweight in/out transactions for side items tracked outside the main
 * commercial flow (e.g. reusable empty sacks collected and later sold).
 * Posting writes ordinary stock movements; this table holds the business
 * detail (buyer, price) that a bare movement cannot.
 */
export const simpleTransactions = sqliteTable(
  'simple_transactions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    itemId: text('item_id').notNull(),
    warehouseId: text('warehouse_id').notNull(),
    type: text('type').notNull(), // 'collect' | 'sell'
    qty: integer('qty').notNull(), // milli base-units, positive
    buyer: text('buyer'),
    unitPriceCents: integer('unit_price_cents'),
    date: text('date').notNull(),
    notes: text('notes'),
    lifecycle: text('lifecycle').notNull().default('posted'),
    reversalReason: text('reversal_reason'),
    recordedBy: text('recorded_by'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('simple_txn_number').on(t.tenantId, t.docNumber),
    index('simple_txn_item').on(t.tenantId, t.itemId),
  ],
);

/** One payment may be allocated across many invoices. */
export const paymentAllocations = sqliteTable(
  'payment_allocations',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    paymentId: text('payment_id').notNull(),
    invoiceId: text('invoice_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    status: text('status').notNull().default('active'), // active | reversed
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('allocations_payment').on(t.tenantId, t.paymentId),
    index('allocations_invoice').on(t.tenantId, t.invoiceId, t.status),
  ],
);

/**
 * Owner emergency recovery codes. Generated in a batch, shown once, stored
 * only as hashes. Using one forces an immediate password change, revokes the
 * used code, and writes a permanent security audit event. No plaintext code
 * or universal password ever exists in the database.
 */
export const recoveryCodes = sqliteTable(
  'recovery_codes',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id').notNull(),
    codeHash: text('code_hash').notNull(),
    createdBy: text('created_by'),
    createdAt: text('created_at').notNull(),
    usedAt: text('used_at'),
    revokedAt: text('revoked_at'),
  },
  (t) => [index('recovery_codes_user').on(t.tenantId, t.userId)],
);

/**
 * Single-use handoff tickets for the JENIFY HQ sign-in bridge
 * (Phase 2, Stage 2; Founder Gate A decided A-4 on 2026-09-02).
 *
 * A ticket is the ONLY thing that travels through the browser during the
 * handoff, and it is deliberately worth almost nothing on its own: opaque, one
 * minute long, single-use, bound to the audience and to the `state` of the
 * redirect that created it, and exchangeable only over a service-authenticated
 * back channel. The claims themselves — including the ORIGINAL sign-in instant
 * that step-up freshness depends on — never pass through the browser at all.
 *
 * Stored as a HASH for the same reason session tokens are: a leaked copy of
 * this table must not be a set of usable tickets. It is a random 32-byte value,
 * not a human secret, so SHA-256 is right and a slow KDF would only add a
 * denial-of-service surface.
 *
 * `origin_session_id` is what makes sign-out propagate: on logout the server
 * tells HQ to revoke every HQ session derived from that identity session.
 */
export const ssoHqTickets = sqliteTable(
  'sso_hq_tickets',
  {
    id: text('id').primaryKey(),
    ticketHash: text('ticket_hash').notNull().unique(),
    /** The host this ticket may be redeemed for. Checked on redeem. */
    audience: text('audience').notNull(),
    /** Exactly the redirect_uri that was allow-listed when it was minted. */
    redirectUri: text('redirect_uri').notNull(),
    /** Binds the ticket to the browser round trip that started it. */
    state: text('state').notNull(),
    realmId: text('realm_id').notNull(),
    accountId: text('account_id').notNull(),
    displayName: text('display_name').notNull(),
    /** ORIGINAL sign-in instant. Never the handoff instant. */
    sessionEstablishedAt: text('session_established_at').notNull(),
    /** Identity session this derives from, so logout can revoke downstream. */
    originSessionId: text('origin_session_id').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    consumedAt: text('consumed_at'),
  },
  (t) => [index('sso_hq_tickets_origin').on(t.originSessionId)],
);
