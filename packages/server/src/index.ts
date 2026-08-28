import { buildApp } from './app.js';
import { createDb } from './db/index.js';
import { registerTranslationKeys } from './services/translations.js';
import { PLATFORM_KEYS } from './i18n-keys.js';
import {
  createHeadquarterControlPlane,
  resolveHeadquarterEnv,
  resolveHeadquarterSite,
} from './hq-host.js';

import { defaultDbPath } from './db/index.js';

const port = Number(process.env.FACTORYOS_PORT ?? 3001);
console.log(`FactoryOS database: ${defaultDbPath()}`);
const db = createDb();
registerTranslationKeys(db, PLATFORM_KEYS.map((k) => ({ key: k.key, en: k.en, module: k.module })));

// Headquarter control plane (issue #200): OFF unless FACTORYOS_HQ_CONTROL is
// set. An ordinary tenant deployment — the Mesob pilot — never enters either
// branch and is byte-for-byte unchanged.
const hqConfig = resolveHeadquarterEnv(process.env);
const headquarter = hqConfig ? createHeadquarterControlPlane(hqConfig) : undefined;
if (hqConfig) {
  console.log(`Headquarter control plane: ENABLED (HQ database: ${hqConfig.dbPath})`);
  for (const notice of hqConfig.notices) console.log(`  [hq] ${notice}`);
} else {
  console.log('Headquarter control plane: off (set FACTORYOS_HQ_CONTROL=1 to serve it)');
}
const { site: headquarterSite, notices: siteNotices } = resolveHeadquarterSite(process.env);
for (const notice of siteNotices) console.log(`  [hq] ${notice}`);
if (headquarterSite) console.log(`Headquarter site: serving ${headquarterSite.root} at /hq/`);

const app = buildApp({
  db,
  ...(headquarter ? { headquarter } : {}),
  ...(headquarterSite ? { headquarterSite } : {}),
});

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => {
    console.log(`FactoryOS server running at http://127.0.0.1:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
