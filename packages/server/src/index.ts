import { buildApp } from './app.js';
import { createDb } from './db/index.js';
import { registerTranslationKeys } from './services/translations.js';
import { PLATFORM_KEYS } from './i18n-keys.js';
import { loadHeadquarterHost } from './services/headquarter-host.js';

import { defaultDbPath } from './db/index.js';

const port = Number(process.env.FACTORYOS_PORT ?? 3001);
console.log(`FactoryOS database: ${defaultDbPath()}`);
const db = createDb();
registerTranslationKeys(db, PLATFORM_KEYS.map((k) => ({ key: k.key, en: k.en, module: k.module })));

// HQ control plane: OFF unless the environment switches it on deliberately.
// An ordinary tenant deployment (the Mesob pilot included) sets none of the
// FACTORYOS_HQ_* variables and is byte-for-byte unaffected.
const hq = loadHeadquarterHost(process.env);
const app = buildApp({
  db,
  ...(hq ? { headquarter: hq.plane } : {}),
  ...(hq?.siteRoot ? { headquarterSite: { root: hq.siteRoot } } : {}),
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
