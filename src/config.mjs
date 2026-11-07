import os from 'node:os';
import path from 'node:path';

export const SITE = 'https://www.tsunaminutrition.it';
export const CART_URL = `${SITE}/carrello`;
export const SEARCH_URL = `${SITE}/ricerca`;
export const PRODUCT_AJAX_URL = `${SITE}/index.php?controller=product`;

export function getConfig(env = process.env) {
  const dataDir = env.TSUNAMI_DATA_DIR || path.join(os.homedir(), '.tsunami-copilot');
  return {
    dataDir,
    dbPath: env.TSUNAMI_DB_PATH || path.join(dataDir, 'agent.sqlite'),
    cookiePath: path.join(dataDir, 'session-cookies.json'),
    profilePath: env.TSUNAMI_PROFILE_DIR || path.join(dataDir, 'browser-profile'),
    channel: env.BROWSER_CHANNEL || '',
    browserExecutable: env.BROWSER_EXECUTABLE || '',
    port: Number(env.PORT || 3790),
    bindHost: env.BIND_HOST || '127.0.0.1',
    allowCartWrites: env.ALLOW_CART_WRITES !== 'false',
    minIntervalMs: Number(env.TSUNAMI_MIN_INTERVAL_MS || 1000),
    planTtlMs: 15 * 60 * 1000
  };
}
