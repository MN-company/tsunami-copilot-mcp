/** LOCAL ONLY. Streamable HTTP MCP server for tsunaminutrition.it (PrestaShop front office). */
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { z } from 'zod/v4';
import { getConfig } from './config.mjs';
import { CookieJar, TsunamiClient, TsunamiError, filterProducts } from './client.mjs';
import { parseNutrition, parseReviews } from './parse.mjs';
import { compareFields, netWeightFromName, evaluatePreferences, emptyPreferences, DIETS, SHIPPING_IT } from './compare.mjs';
import { AgentStore } from './store.mjs';
import { CartPlanner, WishlistPlanner } from './planner.mjs';

export const VERSION = '0.2.0';
const config = getConfig();
const store = new AgentStore(config.dbPath);
const jar = await new CookieJar(config.cookiePath).load();
const client = new TsunamiClient({ jar, minIntervalMs: config.minIntervalMs });
const planner = new CartPlanner({ client, store, ttlMs: config.planTtlMs, writesEnabled: config.allowCartWrites });
const wishlistPlanner = new WishlistPlanner({ client, store, ttlMs: config.planTtlMs, writesEnabled: config.allowCartWrites });
const prefs = () => ({ ...emptyPreferences(), ...store.get('preferences', {}) });

const textResult = (data, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], isError });
function safeTool(fn) {
  return async params => {
    try { return textResult(await fn(params ?? {})); }
    catch (e) {
      if (e instanceof TsunamiError) return textResult({ error: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) }, true);
      console.error('Tsunami tool error (details suppressed)');
      return textResult({ error: 'INVALID_OPERATION', message: 'Operazione non valida. Nessuna modifica confermata.' }, true);
    }
  };
}
const read = { readOnlyHint: true, openWorldHint: true };
const localRead = { readOnlyHint: true, openWorldHint: false };
const write = { readOnlyHint: false, openWorldHint: true };
const localWrite = { readOnlyHint: false, openWorldHint: false };
const productRef = { productId: z.number().int().positive().optional(), url: z.string().url().max(400).optional() };
const order = z.enum(['price_asc', 'price_desc', 'name']).optional();
const filters = {
  minPrice: z.number().nonnegative().optional(), maxPrice: z.number().positive().optional(),
  onlyDiscounted: z.boolean().optional(),
  diet: z.enum(['senza glutine', 'vegano', 'senza lattosio']).optional().describe('Filtra su ciò che il sito dichiara nel nome/descrizione: non è una garanzia')
};
const planIds = { planId: z.string().uuid(), confirmationPhrase: z.string().min(1).max(30), userExplicitlyApproved: z.literal(true) };

const cartOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), ...productRef, quantity: z.number().int().min(1).max(20),
    options: z.record(z.string().max(40), z.string().max(80)).optional().describe('Varianti, es. {"Gusto":"Pistacchio"} (nomi da tsunami_product_details)') }),
  z.object({ op: z.literal('update'), itemKey: z.string().regex(/^\d+-\d+$/), quantity: z.number().int().min(0).max(20) }),
  z.object({ op: z.literal('remove'), itemKey: z.string().regex(/^\d+-\d+$/) }),
  z.object({ op: z.literal('voucher_apply'), code: z.string().min(2).max(60) }),
  z.object({ op: z.literal('voucher_remove'), voucherId: z.number().int().positive() }),
  z.object({ op: z.literal('reorder'), orderId: z.number().int().positive().describe('Riordina le righe di un ordine passato (beta)') })
]);
const wishlistOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), ...productRef, options: z.record(z.string().max(40), z.string().max(80)).optional(), wishlistId: z.number().int().positive().optional() }),
  z.object({ op: z.literal('remove'), itemKey: z.string().regex(/^\d+-\d+$/), wishlistId: z.number().int().positive().optional() })
]);

/** Adds preference flags to a list of products (only declared text: name and summary). */
const flagList = r => {
  const p = prefs();
  return { ...r, products: r.products.map(x => ({ ...x, ...(evaluatePreferences(p, x) ? { preferences: evaluatePreferences(p, x) } : {}) })) };
};
const listResult = (r, f, source) => {
  for (const p of r.products) store.recordPrice(`${p.productId}-${p.defaultVariantId ?? 0}`, p.price);
  const filtered = Object.values(f).some(v => v !== undefined);
  const out = flagList({ ...r, products: filterProducts(r.products, f) });
  return { ...out, ...(filtered ? { filteredOnPage: `${out.products.length} di ${r.products.length} risultati di questa pagina`, filterNote: 'Il sito non offre filtri lato server: i filtri valgono solo sulla pagina corrente.' } : {}), source };
};

function makeServer() {
  const server = new McpServer({ name: 'tsunami-copilot', version: VERSION });

  // ---- session and catalog
  server.registerTool('tsunami_session_status', { description: 'Stato del collegamento a Tsunami Nutrition (cliente o guest) e numero di articoli nel carrello. Nessun dato personale.', annotations: read },
    safeTool(async () => {
      const { loggedIn, cart } = await client.session();
      return { account: loggedIn ? 'verified' : 'guest', cartItems: cart.totalQuantity, cartWritesEnabled: config.allowCartWrites,
        ...(loggedIn ? {} : { hint: 'Per usare il tuo account esegui `npm run login` nella cartella tsunami-copilot-mcp.' }) };
    }));

  server.registerTool('tsunami_search', { description: 'Ricerca live nel catalogo Tsunami Nutrition con filtri locali (prezzo, solo in sconto, esigenza alimentare dichiarata). Include peso netto e prezzo al kg quando ricavabili dal nome.',
    inputSchema: { query: z.string().min(1).max(150), page: z.number().int().min(1).max(50).optional(), pageSize: z.number().int().min(1).max(36).optional(), order, ...filters }, annotations: read },
    safeTool(async ({ query, page, pageSize, order, ...f }) => listResult(await client.search(query, { page, pageSize, order }), f, 'live_tsunami_search')));

  server.registerTool('tsunami_offers', { description: 'Prodotti in offerta (prezzi ribassati) con prezzo di listino e sconto, con gli stessi filtri locali della ricerca.',
    inputSchema: { page: z.number().int().min(1).max(100).optional(), pageSize: z.number().int().min(1).max(36).optional(), order, ...filters }, annotations: read },
    safeTool(async ({ page, pageSize, order, ...f }) => listResult(await client.offers({ page, pageSize, order }), f, 'live_tsunami_prices_drop')));

  server.registerTool('tsunami_categories', { description: 'Elenco delle categorie del negozio (id, nome) dal menu del sito. Filtra per testo con "match".',
    inputSchema: { match: z.string().max(60).optional() }, annotations: read },
    safeTool(async ({ match }) => {
      const all = await client.categories();
      const list = match ? all.filter(c => `${c.name} ${c.slug}`.toLowerCase().includes(match.toLowerCase())) : all;
      return { count: list.length, categories: list };
    }));

  server.registerTool('tsunami_category_products', { description: 'Prodotti di una categoria (categoryId da tsunami_categories), con ordinamento e filtri locali.',
    inputSchema: { categoryId: z.number().int().positive(), page: z.number().int().min(1).max(100).optional(), pageSize: z.number().int().min(1).max(36).optional(), order, ...filters }, annotations: read },
    safeTool(async ({ categoryId, page, pageSize, order, ...f }) => listResult(await client.categoryProducts(categoryId, { page, pageSize, order }), f, 'live_tsunami_category')));

  server.registerTool('tsunami_product_details', { description: 'Dettagli di un prodotto: opzioni (es. Gusto), variante predefinita con disponibilità, caratteristiche (es. Senza Glutine), descrizione, valori nutrizionali sintetici, prezzo al kg e per grammo di proteina, voto medio, indicazioni sulle tue preferenze.',
    inputSchema: productRef, annotations: read },
    safeTool(async ref => {
      const d = await client.productDetails(ref);
      const html = await client.request(String(d.url).replace(/#.*$/, ''));
      const n = parseNutrition(html), rv = parseReviews(html);
      const flavours = d.options.find(o => /gusto/i.test(o.name))?.values ?? [];
      const evaluation = evaluatePreferences(prefs(), { ...d, ingredients: n?.ingredients, flavours });
      return { ...d,
        ...compareFields({ price: d.price, netWeightG: netWeightFromName(n?.netWeight) ?? netWeightFromName(d.name), proteinPer100g: n?.proteinPer100g }),
        nutritionSummary: n ? { serving: n.serving, servingsPerPack: n.servingsPerPack, proteinPerServingG: n.proteinPerServingG, proteinPer100g: n.proteinPer100g, tableFlavour: n.tableFlavour } : null,
        rating: rv.rating, reviewCount: rv.reviewCount, ...(evaluation ? { preferences: evaluation } : {}),
        note: 'Verifica allergeni e valori nutrizionali sull\'etichetta: non dichiarare mai un prodotto "sicuro".' };
    }));

  server.registerTool('tsunami_nutrition', { description: 'Tabella nutrizionale completa di un prodotto (dose, dosi per confezione, nutrienti, aminoacidi, ingredienti, istruzioni, avvertenze) con proteine per 100 g, prezzo al kg e prezzo per grammo di proteina. Se il sito non la pubblica lo dice.',
    inputSchema: productRef, annotations: read },
    safeTool(async ref => ({ ...(await client.nutrition(ref)), note: 'Dati come pubblicati dal sito, spesso riferiti a un solo gusto: per allergie verifica l\'etichetta.' })));

  server.registerTool('tsunami_reviews', { description: 'Voto medio e recensioni pubblicate nella pagina prodotto. Sola lettura.', inputSchema: productRef, annotations: read },
    safeTool(async ref => client.reviews(ref)));

  server.registerTool('tsunami_check_variant', { description: 'Prezzo e disponibilità live di una variante precisa, es. {"Gusto":"Pistacchio"}. Sola lettura.',
    inputSchema: { ...productRef, options: z.record(z.string().max(40), z.string().max(80)) }, annotations: read },
    safeTool(async ({ options, ...ref }) => {
      const v = await client.resolveVariant(ref, options);
      store.recordPrice(`${v.productId}-${v.variantId}`, v.unitPrice);
      return v;
    }));

  // ---- cart
  server.registerTool('tsunami_get_cart', { description: 'Legge il carrello (del cliente se collegato, altrimenti guest locale) con spedizione e quanto manca alla spedizione gratuita (da 29 € in Italia). itemKey serve per modificare o rimuovere righe; vouchers[].id per togliere un codice sconto.', annotations: read },
    safeTool(async () => client.readCart()));

  server.registerTool('tsunami_prepare_cart_change', { description: 'SOLA LETTURA. Prepara modifiche al carrello (add, update, remove, voucher_apply, voucher_remove, reorder da un ordine passato), verifica variante, disponibilità e spedizione e restituisce riepilogo e confirmationPhrase. Mostra il riepilogo e attendi l\'approvazione esplicita dell\'utente in un messaggio successivo.',
    inputSchema: { operations: z.array(cartOp).min(1).max(15) }, annotations: read },
    safeTool(async ({ operations }) => planner.prepare(operations)));

  server.registerTool('tsunami_commit_cart_change', { description: 'ESEGUE UNA SOLA VOLTA un piano preparato, solo dopo approvazione esplicita dell\'utente, poi rilegge il carrello per verificare. Fallisce se il carrello è cambiato. In caso di errore o stato "unverified" non ripetere. Non effettua ordini né pagamenti.',
    inputSchema: planIds, annotations: write },
    safeTool(async ({ planId, confirmationPhrase }) => planner.commit(planId, confirmationPhrase)));

  server.registerTool('tsunami_cart_plan_status', { description: 'Stato ed esito di un piano (carrello o preferiti), senza rieseguirlo.',
    inputSchema: { planId: z.string().uuid() }, annotations: localRead }, safeTool(async ({ planId }) => planner.status(planId)));

  // ---- wishlist
  server.registerTool('tsunami_wishlist', { description: 'Liste dei preferiti del cliente con i prodotti (richiede login). I prezzi di questa pagina del sito sono IVA esclusa.', annotations: read },
    safeTool(async () => { const lists = await client.wishlists(); return { count: lists.length, wishlists: lists }; }));

  server.registerTool('tsunami_prepare_wishlist_change', { description: 'SOLA LETTURA. Prepara aggiunte/rimozioni nei preferiti e restituisce riepilogo e confirmationPhrase. Se non esiste una lista, il sito crea "Preferiti". Attendi l\'OK esplicito dell\'utente.',
    inputSchema: { operations: z.array(wishlistOp).min(1).max(10) }, annotations: read },
    safeTool(async ({ operations }) => wishlistPlanner.prepare(operations)));

  server.registerTool('tsunami_commit_wishlist_change', { description: 'ESEGUE UNA SOLA VOLTA un piano preferiti approvato dall\'utente e verifica rileggendo le liste. Non ripetere in caso di errore.',
    inputSchema: planIds, annotations: write },
    safeTool(async ({ planId, confirmationPhrase }) => wishlistPlanner.commit(planId, confirmationPhrase)));

  // ---- account (read-only)
  server.registerTool('tsunami_orders', { description: 'Storico ordini del cliente (richiede login): riferimento, data, totale, pagamento, stato. Lettura in beta.', annotations: read },
    safeTool(async () => client.orders()));

  server.registerTool('tsunami_order_get', { description: 'Dettaglio di un ordine passato (righe, quantità, prezzi, stato). Beta: il formato non è ancora verificato su un ordine reale; se non lo riconosce risponde PARSER_UNVERIFIED.',
    inputSchema: { orderId: z.number().int().positive() }, annotations: read },
    safeTool(async ({ orderId }) => client.orderDetail(orderId)));

  server.registerTool('tsunami_vouchers', { description: 'Codici sconto disponibili per il cliente (codice o applicazione automatica, valore, minimo d\'ordine, scadenza).', annotations: read },
    safeTool(async () => client.vouchers()));

  server.registerTool('tsunami_loyalty_points', { description: 'Saldo Tsunami Points (programma fedeltà del sito).', annotations: read },
    safeTool(async () => client.loyalty()));

  server.registerTool('tsunami_addresses', { description: 'Indirizzi salvati nell\'account (sola lettura: l\'MCP non li modifica mai).', annotations: read },
    safeTool(async () => client.addresses()));

  server.registerTool('tsunami_payment_methods', { description: 'Metodi di pagamento offerti dal negozio (solo i nomi, dalle condizioni di vendita). Nessun dato di carte.', annotations: read },
    safeTool(async () => client.paymentMethods()));

  // ---- local preferences
  server.registerTool('tsunami_preferences_get', { description: 'Preferenze locali: esigenze alimentari, ingredienti da evitare, gusti preferiti. Usate per segnalare (non garantire) la compatibilità dei prodotti.', annotations: localRead },
    safeTool(async () => ({ preferences: prefs(), supportedDiets: Object.keys(DIETS) })));

  server.registerTool('tsunami_preferences_set', { description: 'Aggiunge preferenze locali (si sommano a quelle esistenti). Solo su richiesta esplicita dell\'utente.',
    inputSchema: { diets: z.array(z.enum(['senza glutine', 'vegano', 'senza lattosio', 'senza zuccheri aggiunti'])).max(4).optional(),
      avoidIngredients: z.array(z.string().min(2).max(40)).max(20).optional(), preferredFlavours: z.array(z.string().min(2).max(40)).max(20).optional(),
      userExplicitlyRequested: z.literal(true) }, annotations: localWrite },
    safeTool(async ({ diets = [], avoidIngredients = [], preferredFlavours = [] }) => {
      const p = prefs(), merge = (a, b) => [...new Set([...a, ...b.map(x => x.trim().toLowerCase())])];
      const next = { diets: merge(p.diets, diets), avoidIngredients: merge(p.avoidIngredients, avoidIngredients), preferredFlavours: merge(p.preferredFlavours, preferredFlavours) };
      store.set('preferences', next); store.audit('preferences_set', { counts: [next.diets.length, next.avoidIngredients.length, next.preferredFlavours.length] });
      return { preferences: next };
    }));

  server.registerTool('tsunami_preferences_remove', { description: 'Rimuove una preferenza locale (o tutte con all=true).',
    inputSchema: { kind: z.enum(['diets', 'avoidIngredients', 'preferredFlavours']).optional(), value: z.string().max(40).optional(), all: z.boolean().optional(), userExplicitlyRequested: z.literal(true) }, annotations: localWrite },
    safeTool(async ({ kind, value, all }) => {
      if (all) { store.set('preferences', null); return { preferences: emptyPreferences() }; }
      if (!kind || !value) throw new TsunamiError('Indica kind e value, oppure all=true', 'INVALID_ARGUMENT');
      const p = prefs(); p[kind] = p[kind].filter(x => x !== value.trim().toLowerCase());
      store.set('preferences', p); return { preferences: p };
    }));

  server.registerTool('tsunami_price_history', { description: 'Storico prezzi osservato da questo MCP per una variante (chiave "productId-variantId", come itemKey).',
    inputSchema: { key: z.string().regex(/^\d+-\d+$/) }, annotations: localRead },
    safeTool(async ({ key }) => {
      const h = store.priceHistory(key), p = h.map(x => x.price);
      return { key, observations: h.length, min: p.length ? Math.min(...p) : null, max: p.length ? Math.max(...p) : null, history: h.slice(-30) };
    }));

  server.registerTool('tsunami_release_info', { description: 'Versione del server, impostazioni attive e copertura delle funzioni.', annotations: localRead },
    safeTool(async () => ({ service: 'tsunami-copilot', version: VERSION, site: 'https://www.tsunaminutrition.it', cartWritesEnabled: config.allowCartWrites,
      checkout: 'solo sul sito, mai dall\'MCP', shipping: SHIPPING_IT,
      coverage: {
        verifiedLive: ['ricerca', 'offerte', 'categorie', 'dettagli e varianti', 'valori nutrizionali', 'recensioni (JSON-LD)', 'carrello e coupon', 'spedizione', 'preferiti', 'codici sconto', 'Tsunami Points (saldo vuoto)', 'indirizzi (nessuno salvato)', 'metodi di pagamento'],
        beta: ['storico ordini', 'dettaglio ordine', 'riordino', 'indirizzi compilati', 'movimenti punti'],
        notAvailable: ['filtri lato server (il sito non li espone: filtri locali sulla pagina)', 'checkout e pagamenti (esclusi di proposito)', 'modifica di account e indirizzi (esclusa)']
      } })));

  return server;
}

const app = createMcpExpressApp({ host: config.bindHost,
  ...(config.bindHost === '0.0.0.0' ? { allowedHosts: ['tsunami-mcp', 'localhost', '127.0.0.1'], allowedOrigins: ['tsunami-mcp', 'localhost', '127.0.0.1'] } : {}) });
app.use(express.json({ limit: '128kb' }));
app.get('/health', (_req, res) => res.json({ service: 'tsunami-copilot', ok: true, version: VERSION }));
app.post('/mcp', async (req, res) => {
  const server = makeServer(), transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
  catch { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error' }, id: null }); }
  finally {
    if (res.writableFinished) { await transport.close(); await server.close(); }
    else res.on('close', async () => { await transport.close(); await server.close(); });
  }
});
app.get('/mcp', (_req, res) => res.status(405).end());
app.delete('/mcp', (_req, res) => res.status(405).end());
const instance = app.listen(config.port, config.bindHost, () =>
  console.log(`Tsunami MCP v${VERSION} on http://${config.bindHost}:${config.port}/mcp — cart writes: ${config.allowCartWrites ? 'enabled' : 'disabled'}`));
function stop() { instance.close(); store.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
