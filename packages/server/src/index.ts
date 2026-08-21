import { buildApp } from './app.js';
import { createDb } from './db/index.js';
import { registerTranslationKeys } from './services/translations.js';
import { PLATFORM_KEYS } from './i18n-keys.js';

import { defaultDbPath } from './db/index.js';

const port = Number(process.env.FACTORYOS_PORT ?? 3001);
console.log(`FactoryOS database: ${defaultDbPath()}`);
const db = createDb();
registerTranslationKeys(db, PLATFORM_KEYS.map((k) => ({ key: k.key, en: k.en, module: k.module })));
const app = buildApp({ db });

app
  .listen({ port, host: '127.0.0.1' })
  .then(() => {
    console.log(`FactoryOS server running at http://127.0.0.1:${port}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
