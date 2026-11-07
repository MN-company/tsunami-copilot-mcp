/** Opens a real browser window on tsunaminutrition.it: the USER signs in there. We never see or ask for the password. */
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { getConfig, SITE } from './config.mjs';
import { CookieJar, TsunamiClient } from './client.mjs';
import { importBrowserCookies } from './auth.mjs';

const config = getConfig();
const jar = new CookieJar(config.cookiePath);
if (process.argv.includes('--logout')) { await fs.rm(config.cookiePath, { force: true }); console.log('Sessione locale rimossa.'); process.exit(0); }

const { chromium } = await import('playwright');
await fs.mkdir(config.profilePath, { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(config.profilePath, { headless: false, ...(config.channel === 'chrome' ? { channel: 'chrome' } : {}), ...(config.browserExecutable ? { executablePath: config.browserExecutable } : {}) });
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(`${SITE}/login?back=my-account`, { waitUntil: 'domcontentloaded' });
  console.log('Accedi al tuo account Tsunami Nutrition nella finestra del browser (se sei già dentro, non serve rifarlo).');
  const rl = createInterface({ input, output });
  try { await rl.question('Quando vedi "Il mio account", torna qui e premi INVIO: '); } finally { rl.close(); }
  const n = await importBrowserCookies(context, jar);
  const { loggedIn } = await new TsunamiClient({ jar }).session();
  if (loggedIn) console.log(`Account Tsunami verificato. Sessione salvata in locale (${n} cookie, mai mostrati).`);
  else { console.log('Il sito non riconosce l\'accesso: completa il login nel browser e riprova.'); process.exitCode = 1; }
} finally { await context.close(); }
