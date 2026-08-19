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
  (t) => [uniqueIndex('translations_key_lang').on(t.tenantId, t.keyId, t.language)],
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
  (t) => [uniqueIndex('qc_attempt').on(t.batchId, t.attemptNumber)],
);

// ============================ Commercial ===================================

export const salesInvoices = sqliteTable(
  'sales_invoices',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    docNumber: text('doc_number').notNull(),
    date: text('date').notNull(),
    customerId: text('customer_id').notNull(),
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
