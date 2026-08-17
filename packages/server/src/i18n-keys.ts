/**
 * Platform English base strings. These are developer-owned; tenants override
 * any of them (including English) through the Languages & Translations screen.
 * Key set grows as screens are added; registration is idempotent.
 */
export const PLATFORM_KEYS: Array<{ key: string; en: string; module?: string }> = [
  // shell
  { key: 'shell.system', en: 'Management System', module: 'shell' },
  { key: 'shell.language', en: 'Language', module: 'shell' },
  { key: 'shell.signout', en: 'Sign out', module: 'shell' },
  { key: 'shell.save_draft', en: 'Save draft', module: 'shell' },
  { key: 'shell.approve', en: 'Approve', module: 'shell' },
  { key: 'shell.cancel', en: 'Cancel', module: 'shell' },
  { key: 'shell.export', en: 'Export', module: 'shell' },
  { key: 'shell.print', en: 'Print', module: 'shell' },
  { key: 'shell.search', en: 'Search', module: 'shell' },
  { key: 'shell.notes', en: 'Notes', module: 'shell' },
  { key: 'shell.status', en: 'Status', module: 'shell' },
  { key: 'shell.date', en: 'Date', module: 'shell' },
  { key: 'shell.actions', en: 'Actions', module: 'shell' },

  // navigation
  { key: 'nav.dashboard', en: 'Dashboard', module: 'nav' },
  { key: 'nav.receiving', en: 'Receiving', module: 'nav' },
  { key: 'nav.inventory', en: 'Inventory', module: 'nav' },
  { key: 'nav.production', en: 'Production', module: 'nav' },
  { key: 'nav.customers', en: 'Customers', module: 'nav' },
  { key: 'nav.sales', en: 'Sales', module: 'nav' },
  { key: 'nav.credit', en: 'Credit', module: 'nav' },
  { key: 'nav.payments', en: 'Payments', module: 'nav' },
  { key: 'nav.deliveries', en: 'Deliveries', module: 'nav' },
  { key: 'nav.sacks', en: 'Empty Sacks', module: 'nav' },
  { key: 'nav.reports', en: 'Reports', module: 'nav' },
  { key: 'nav.users', en: 'Users & Roles', module: 'nav' },
  { key: 'nav.settings', en: 'Settings', module: 'nav' },
  { key: 'nav.audit', en: 'Audit Log', module: 'nav' },

  // statuses
  { key: 'status.draft', en: 'Draft', module: 'status' },
  { key: 'status.posted', en: 'Posted', module: 'status' },
  { key: 'status.reversed', en: 'Reversed', module: 'status' },
  { key: 'status.cancelled', en: 'Cancelled', module: 'status' },
  { key: 'status.available', en: 'Available', module: 'status' },
  { key: 'status.reserved', en: 'Reserved', module: 'status' },
  { key: 'status.in_process', en: 'In Process', module: 'status' },
  { key: 'status.completed', en: 'Completed', module: 'status' },
  { key: 'status.in_progress', en: 'In Progress', module: 'status' },
  { key: 'status.passed', en: 'Passed', module: 'status' },
  { key: 'status.failed', en: 'Failed', module: 'status' },
  { key: 'status.retest_required', en: 'Retest Required', module: 'status' },
  { key: 'status.pending', en: 'Pending', module: 'status' },
  { key: 'status.confirmed', en: 'Confirmed', module: 'status' },
  { key: 'status.dispatched', en: 'Dispatched', module: 'status' },
  { key: 'status.delivered', en: 'Delivered', module: 'status' },
  { key: 'status.loading', en: 'Loading', module: 'status' },
  { key: 'status.paid', en: 'Paid', module: 'status' },
  { key: 'status.partial', en: 'Partially Paid', module: 'status' },
  { key: 'status.overdue', en: 'Overdue', module: 'status' },
  { key: 'status.active', en: 'Active', module: 'status' },
  { key: 'status.inactive', en: 'Inactive', module: 'status' },

  // production stages (generic defaults; tenants relabel)
  { key: 'stage.washing', en: 'Washing', module: 'production' },
  { key: 'stage.iodization', en: 'Iodization & Quality Test', module: 'production' },
  { key: 'stage.packaging', en: 'Packaging', module: 'production' },
  { key: 'production.attr.iodine_added_kg', en: 'Iodine quantity added (kg)', module: 'production' },
];
