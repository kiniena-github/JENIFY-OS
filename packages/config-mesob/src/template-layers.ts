import type { PublishLayerInput } from '@factoryos/server/services';

/**
 * Standard JENIFY template layers, expressed as the platform would ship them.
 * Mesob is formalized as the composition:
 *   Core -> Manufacturing -> Process Manufacturing -> Salt -> Ethiopia -> (company overrides)
 *
 * A deliberately minimal DUMMY country pack ('country.testland') is included so
 * tests can prove Ethiopia is NOT hard-coded: the same Mesob stack with the
 * Ethiopia pack swapped for Testland must still resolve cleanly.
 *
 * These are DEFINITIONS ONLY (no tenant literals leak into core): they name
 * capability activations and namespaced config defaults. Actual Mesob items,
 * warehouses, stages, and translations continue to be provisioned by seed.ts —
 * the Salt layer only declares the CONFIG SHAPE, not the specific rows.
 */
export const JENIFY_CORE_LAYER: PublishLayerInput = {
  templateId: 'core',
  kind: 'core',
  labelKey: 'template.core',
  activations: {
    parties: 'required',
    inventory: 'required',
    reports: 'required',
    documents: 'required',
    approvals: 'optional',
    ai: 'optional',
    migration: 'optional',
  },
  config: {
    core: {
      qtyScale: 1000,
      moneyScale: 100,
      immutableLedger: true,
    },
  },
};

export const MANUFACTURING_SECTOR_LAYER: PublishLayerInput = {
  templateId: 'sector.manufacturing',
  kind: 'sector',
  labelKey: 'template.sector.manufacturing',
  extendsId: 'core',
  activations: {
    warehouses: 'required',
    production: 'required',
    procurement: 'recommended',
    quality: 'recommended',
    traceability: 'recommended',
  },
  config: {
    production: {
      // sector default; subsectors refine
      model: 'process_or_discrete',
    },
  },
};

export const PROCESS_SUBSECTOR_LAYER: PublishLayerInput = {
  templateId: 'subsector.process-manufacturing',
  kind: 'subsector',
  labelKey: 'template.subsector.process',
  extendsId: 'sector.manufacturing',
  activations: {
    quality: 'required', // process manufacturing gates on QC
    traceability: 'required',
  },
  config: {
    production: {
      model: 'process',
      stageOutputPolicies: ['measured', 'conserved', 'converted'],
      qcReleaseGate: true, // explicit approve-and-release
    },
  },
};

/** Salt sub-subsector: declares CONFIG SHAPE only; seed.ts supplies rows. */
export const SALT_SUBSECTOR_LAYER: PublishLayerInput = {
  templateId: 'subsector.salt',
  kind: 'subsector',
  labelKey: 'template.subsector.salt',
  extendsId: 'subsector.process-manufacturing',
  activations: {
    delivery: 'recommended',
    credit: 'recommended',
    payments: 'required',
    sales: 'required',
  },
  config: {
    production: {
      // salt physics: iodization stage is conserved (no invented loss)
      conservedStages: ['iodization'],
      iodineIsInventory: false,
    },
    inventory: {
      packagedOutputs: true,
    },
  },
};

export const ETHIOPIA_COUNTRY_LAYER: PublishLayerInput = {
  templateId: 'country.ethiopia',
  kind: 'country',
  labelKey: 'template.country.ethiopia',
  activations: {},
  config: {
    core: {
      defaultCurrency: 'ETB',
      defaultTimezone: 'Africa/Addis_Ababa',
      calendar: 'ethiopian', // display-only; stored dates stay ISO/UTC
      defaultLanguages: ['en', 'am', 'ti'],
      // e-invoicing is an EXTENSION POINT only — no compliance behavior is
      // implemented until Founder-verified (see ETHIOPIA_EINVOICING_VERIFICATION)
      eInvoicingAdapter: null,
    },
  },
};

/**
 * DUMMY country pack — proves the architecture is not Ethiopia-specific.
 * Different currency, timezone, calendar, and languages. Never used by a real
 * tenant; exists so tests can swap it into the Mesob stack and confirm a clean,
 * DIFFERENT resolution (no Ethiopia values leaking through core).
 */
export const TESTLAND_COUNTRY_LAYER: PublishLayerInput = {
  templateId: 'country.testland',
  kind: 'country',
  labelKey: 'template.country.testland',
  activations: {},
  config: {
    core: {
      defaultCurrency: 'TST',
      defaultTimezone: 'UTC',
      calendar: 'gregorian',
      defaultLanguages: ['en'],
      eInvoicingAdapter: null,
    },
  },
};

/** All standard layers in publish order (parents before children). */
export const STANDARD_TEMPLATE_LAYERS: PublishLayerInput[] = [
  JENIFY_CORE_LAYER,
  MANUFACTURING_SECTOR_LAYER,
  PROCESS_SUBSECTOR_LAYER,
  SALT_SUBSECTOR_LAYER,
  ETHIOPIA_COUNTRY_LAYER,
  TESTLAND_COUNTRY_LAYER,
];

/** The Mesob binding stack (lowest precedence first; company overrides appended by the engine). */
export const MESOB_TEMPLATE_STACK = [
  { templateId: 'core' },
  { templateId: 'sector.manufacturing' },
  { templateId: 'subsector.process-manufacturing' },
  { templateId: 'subsector.salt' },
  { templateId: 'country.ethiopia' },
];
