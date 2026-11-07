import fs from 'node:fs/promises';
import path from 'node:path';
import { CART_URL, PRODUCT_AJAX_URL, SEARCH_URL, SITE } from './config.mjs';
import { extractPrestashopGlobal, parseDataProduct, parseOrderHistory, parseVariantGroups, stripHtml,
  parseNutrition, parseReviews, parseCategories, parseVouchers, parsePaymentMethods, parseAddresses, parseOrderDetail,
  parseWishlists, parseWishlistProducts, parseLoyalty, variantFromAddUrl } from './parse.mjs';
import { compareFields, netWeightFromName, shippingInfo } from './compare.mjs';

const WISHLIST = `${SITE}/module/advansedwishlist/`;

export class TsunamiError extends Error {
  constructor(message, code = 'TSUNAMI_ERROR', details) { super(message); this.code = code; this.details = details; }
}

const norm = s => String(s ?? '').toLocaleLowerCase('it').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

/** Minimal cookie jar for one host, persisted to a 0600 file. Values are never logged or returned by tools. */
export class CookieJar {
  constructor(file) { this.file = file; this.cookies = new Map(); }
  async load() {
    if (!this.file) return this;
    try { for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(this.file, 'utf8')).cookies ?? {})) this.cookies.set(k, v); } catch { /* fresh jar */ }
    return this;
  }
  async save() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify({ savedAt: new Date().toISOString(), cookies: Object.fromEntries(this.cookies) }), { mode: 0o600 });
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(res) {
    let changed = false;
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('='); if (eq < 1) continue;
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      const expired = attrs.some(a => /^\s*max-age=0/i.test(a) || (/^\s*expires=/i.test(a) && Date.parse(a.split('=')[1]) < Date.now()));
      if (expired || value === '' || value === 'deleted') changed = this.cookies.delete(name) || changed;
      else if (this.cookies.get(name) !== value) { this.cookies.set(name, value); changed = true; }
    }
    return changed;
  }
  hasSession() { return [...this.cookies.keys()].some(k => k.startsWith('PrestaShop-')); }
  replaceAll(entries) { this.cookies = new Map(entries); }
}

export function productIdFromRef({ productId, url }) {
  if (productId) return Number(productId);
  const m = String(url ?? '').match(/\/(\d+)(?:-\d+)?-[^/]+\.html/);
  if (!m) throw new TsunamiError('Serve productId o un URL prodotto di tsunaminutrition.it', 'INVALID_ARGUMENT');
  return Number(m[1]);
}

export const mapListProduct = p => ({ productId: Number(p.id_product),
  defaultVariantId: Number(p.id_product_attribute) || variantFromAddUrl(p.add_to_cart_url) || undefined, name: p.name,
  brand: p.manufacturer_name, category: p.category_name, reference: p.reference, url: p.url ?? p.link,
  price: p.price_amount, regularPrice: p.has_discount ? Math.round(p.regular_price_amount * 100) / 100 : undefined,
  // The site's own discount label can be wrong (e.g. "-181%"): recompute it from the two prices.
  discountPercent: p.has_discount && p.regular_price_amount > p.price_amount ? Math.round((1 - p.price_amount / p.regular_price_amount) * 100) : undefined,
  summary: stripHtml(p.description_short).slice(0, 300),
  // No direct add-to-cart link: a flavour/size must be chosen (or the product is not orderable as is).
  needsOptionChoice: !p.add_to_cart_url,
  ...compareFields({ price: p.price_amount, netWeightG: netWeightFromName(p.name) }) });

const SORT = { price_asc: 'product.price.asc', price_desc: 'product.price.desc', name: 'product.name.asc' };
const listing = j => ({ total: Number(j.pagination?.total_items ?? 0), page: j.pagination?.current_page, totalPages: j.pagination?.pages_count,
  products: (j.products ?? []).map(mapListProduct) });

/**
 * Local filters on a result page (the site exposes no faceted search: rendered_facets is empty).
 * Diet filters match only what the site DECLARES in name/summary.
 */
export function filterProducts(products, { minPrice, maxPrice, onlyDiscounted, diet } = {}) {
  const dietRe = { 'senza glutine': /senza glutine|gluten[\s-]?free/i, vegano: /vegan/i, 'senza lattosio': /senza lattosio|lactose[\s-]?free|delattosat/i };
  return products.filter(p => (minPrice === undefined || p.price >= minPrice) && (maxPrice === undefined || p.price <= maxPrice)
    && (!onlyDiscounted || p.regularPrice)
    && (!diet || (dietRe[diet] ?? new RegExp(diet, 'i')).test(`${p.name} ${p.summary}`)));
}

export function mapCart(ps) {
  const c = ps?.cart;
  if (!c) return null;
  return {
    loggedIn: Boolean(ps.customer?.is_logged),
    totalQuantity: c.products_count,
    items: (c.products ?? []).map(p => ({ itemKey: `${p.id_product}-${p.id_product_attribute}`, productId: Number(p.id_product),
      variantId: Number(p.id_product_attribute), name: p.name, options: p.attributes ?? {}, quantity: Number(p.quantity),
      unitPrice: typeof p.price_wt === 'number' ? Math.round(p.price_wt * 100) / 100 : Math.round(p.total_wt / Math.max(1, Number(p.quantity)) * 100) / 100,
      rowTotal: p.total_wt, inStock: p.availability !== 'unavailable', url: p.url })),
    vouchers: (c.vouchers?.added ?? []).map(v => ({ id: Number(v.id_cart_rule), name: v.name, reduction: v.reduction_formatted })),
    subtotal: c.subtotals?.products?.amount, shipping: c.subtotals?.shipping?.amount, discounts: c.subtotals?.discounts?.amount ?? 0,
    total: c.totals?.total?.amount, currency: 'EUR',
    minimalPurchase: c.minimalPurchaseRequired ? stripHtml(c.minimalPurchaseRequired) : undefined
  };
}

export class TsunamiClient {
  #last = 0; #queue = Promise.resolve(); #token = null;
  constructor({ jar = new CookieJar(), minIntervalMs = 1000, fetchImpl = fetch } = {}) { this.jar = jar; this.minIntervalMs = minIntervalMs; this.fetch = fetchImpl; }

  /** Serialized, rate-limited request carrying the session cookies. Never retried automatically. */
  request(url, { method = 'GET', form, ajax = false } = {}) {
    const run = async () => {
      const wait = this.#last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.#last = Date.now();
      const headers = { 'User-Agent': 'Mozilla/5.0 (compatible; tsunami-copilot-mcp/0.1; personal shopping assistant)', 'Accept-Language': 'it-IT,it;q=0.9',
        Accept: ajax ? 'application/json, text/javascript, */*; q=0.01' : 'text/html,application/xhtml+xml', Cookie: this.jar.header() };
      if (ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
      let body;
      if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8'; headers.Origin = SITE; body = new URLSearchParams(form).toString(); }
      let res;
      try { res = await this.fetch(url, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(25000) }); }
      catch { throw new TsunamiError('Tsunami Nutrition non raggiungibile', 'NETWORK_ERROR'); }
      if (this.jar.absorb(res)) await this.jar.save();
      if (res.status === 429 || res.status === 503) throw new TsunamiError('Il sito sta limitando le richieste, riprova tra poco', 'RATE_LIMITED');
      if (res.status >= 400) throw new TsunamiError(`HTTP ${res.status} da Tsunami`, res.status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR');
      const text = await res.text();
      if (!ajax) return text;
      try { return JSON.parse(text); } catch { throw new TsunamiError('Risposta non JSON da Tsunami', 'BAD_RESPONSE'); }
    };
    const p = this.#queue.then(run, run);
    this.#queue = p.catch(() => {});
    return p;
  }

  // ---- catalog
  async search(query, { page = 1, pageSize = 12, order } = {}) {
    const u = new URL(SEARCH_URL);
    u.search = new URLSearchParams({ controller: 'search', s: query, page: String(page), resultsPerPage: String(pageSize), ajax: '1',
      ...(order ? { order: SORT[order] } : {}) }).toString();
    return listing(await this.request(u.href, { ajax: true }));
  }

  /** Discounted products (PrestaShop prices-drop; the friendly URL answers 404 to guests, index.php does not). */
  async offers({ page = 1, pageSize = 24, order } = {}) {
    const q = new URLSearchParams({ controller: 'prices-drop', ajax: '1', page: String(page), resultsPerPage: String(pageSize), ...(order ? { order: SORT[order] } : {}) });
    return listing(await this.request(`${SITE}/index.php?${q}`, { ajax: true }));
  }

  #categories;
  async categories() {
    if (!this.#categories) this.#categories = parseCategories(await this.request(`${SITE}/`));
    if (!this.#categories.length) { this.#categories = undefined; throw new TsunamiError('Menu categorie non leggibile', 'PARSER_UNVERIFIED'); }
    return this.#categories;
  }

  async categoryProducts(categoryId, { page = 1, pageSize = 24, order } = {}) {
    const q = new URLSearchParams({ id_category: String(Number(categoryId)), controller: 'category', ajax: '1', page: String(page), resultsPerPage: String(pageSize),
      ...(order ? { order: SORT[order] } : {}) });
    const j = await this.request(`${SITE}/index.php?${q}`, { ajax: true });
    return { category: String(j.label ?? '').replace(/^Categoria:\s*/, ''), ...listing(j) };
  }

  /** Product page HTML (nutrition tab, ingredients, JSON-LD reviews). */
  async productPage(ref) {
    let url = ref.url;
    if (!url) url = (await this.rawProduct(productIdFromRef(ref))).url;
    return this.request(String(url).replace(/#.*$/, ''));
  }

  async nutrition(ref) {
    const { data, url } = await this.rawProduct(productIdFromRef(ref));
    const n = parseNutrition(await this.request(String(url).replace(/#.*$/, '')));
    const netWeightG = netWeightFromName(n?.netWeight) ?? netWeightFromName(data.name);
    return { productId: Number(data.id_product), name: data.name, price: data.price_amount,
      ...(n ? { nutrition: n } : { nutrition: null, note: 'Il sito non pubblica una tabella nutrizionale leggibile per questo prodotto.' }),
      ...compareFields({ price: data.price_amount, netWeightG, proteinPer100g: n?.proteinPer100g }),
      ...(n?.tableFlavour ? { tableNote: `Valori e ingredienti si riferiscono al gusto "${n.tableFlavour}" secondo il sito.` } : {}) };
  }

  async reviews(ref) {
    const html = await this.productPage(ref);
    return { ...parseReviews(html), source: 'dati strutturati (JSON-LD) della pagina prodotto: solo le recensioni che il sito incorpora' };
  }

  /** Product refresh endpoint: returns the selected combination as JSON plus the variant groups. */
  async rawProduct(productId, groupSelection = {}) {
    const form = { ajax: '1', action: 'refresh', quantity_wanted: '1' };
    for (const [g, v] of Object.entries(groupSelection)) form[`group[${g}]`] = String(v);
    const j = await this.request(`${PRODUCT_AJAX_URL}&id_product=${Number(productId)}`, { method: 'POST', form, ajax: true });
    const data = parseDataProduct(j.product_details);
    if (!data) throw new TsunamiError('Prodotto non trovato', 'NOT_FOUND');
    return { data, groups: parseVariantGroups(j.product_variants), url: j.product_url, variantId: Number(j.id_product_attribute) || 0 };
  }

  async productDetails(ref) {
    const { data, groups, url } = await this.rawProduct(productIdFromRef(ref));
    return { productId: Number(data.id_product), name: data.name, brand: data.manufacturer_name, reference: data.reference, url,
      price: data.price_amount, regularPrice: data.has_discount ? Math.round(data.regular_price_amount * 100) / 100 : undefined,
      options: groups.map(g => ({ name: g.name, values: g.values.map(v => v.label) })),
      defaultVariant: { variantId: Number(data.id_product_attribute), options: Object.fromEntries(Object.values(data.attributes ?? {}).map(a => [a.group, a.name])),
        inStock: data.availability !== 'unavailable', quantityAvailable: data.quantity },
      features: (data.features ?? []).map(f => ({ name: f.name, value: f.value })),
      summary: stripHtml(data.description_short).slice(0, 600),
      description: stripHtml(data.description).slice(0, 3000) };
  }

  /** Resolves option labels ({Gusto:'Pistacchio'}) to a verified combination, with its live price and stock. */
  async resolveVariant(ref, wanted = {}) {
    const productId = productIdFromRef(ref);
    const first = await this.rawProduct(productId);
    if (!first.groups.length) return describe(first.data);
    const sel = {}, label = {}, missing = [];
    for (const g of first.groups) {
      const entry = Object.entries(wanted).find(([k]) => norm(k) === norm(g.name) || (['flavour', 'flavor', 'taste'].includes(norm(k)) && norm(g.name) === 'gusto')
        || (['size', 'formato', 'peso'].includes(norm(k)) && /formato|peso|confezione|taglia/.test(norm(g.name))));
      if (!entry) { missing.push({ option: g.name, values: g.values.map(v => v.label) }); continue; }
      const v = g.values.find(v => norm(v.label) === norm(entry[1])) ?? g.values.filter(v => norm(v.label).includes(norm(entry[1]))).at(0);
      if (!v) throw new TsunamiError(`"${entry[1]}" non è un valore valido per ${g.name}`, 'INVALID_OPTION', { option: g.name, values: g.values.map(v => v.label) });
      sel[g.id] = v.id; label[g.name] = v.label;
    }
    if (missing.length) throw new TsunamiError('Scegli tutte le opzioni del prodotto', 'OPTIONS_REQUIRED', { missing });
    const r = await this.rawProduct(productId, sel);
    // PrestaShop silently falls back to another combination when one does not exist: verify it.
    const got = Object.fromEntries(Object.values(r.data.attributes ?? {}).map(a => [a.id_attribute_group, a.id_attribute]));
    if (Object.entries(sel).some(([g, v]) => String(got[g]) !== String(v))) throw new TsunamiError('Combinazione non disponibile', 'VARIANT_NOT_FOUND', { label });
    return describe(r.data, label);
  }

  // ---- session and cart
  /** Loads the (uncached) cart page: bootstraps the session cookie and returns the embedded cart. */
  async session() {
    const ps = extractPrestashopGlobal(await this.request(`${CART_URL}?action=show`));
    if (!ps?.cart) throw new TsunamiError('Impossibile leggere il carrello', 'BAD_RESPONSE');
    this.#token = ps.static_token;
    const cart = mapCart(ps);
    cart.shippingInfo = shippingInfo(cart);
    return { cart, loggedIn: Boolean(ps.customer?.is_logged) };
  }
  async readCart() { return (await this.session()).cart; }

  /** Account page: throws AUTH_REQUIRED unless the customer is logged in. */
  async #accountPage(path) {
    const html = await this.request(`${SITE}/${path}`);
    if (!extractPrestashopGlobal(html)?.customer?.is_logged) throw new TsunamiError('Non sei collegato a Tsunami: esegui `npm run login`', 'AUTH_REQUIRED');
    return html;
  }

  async orderDetail(orderId) {
    let html;
    try { html = await this.#accountPage(`index.php?controller=order-detail&id_order=${Number(orderId)}`); }
    catch (e) { if (e.code === 'NOT_FOUND') throw new TsunamiError('Ordine non trovato in questo account (usa tsunami_orders per gli id)', 'ORDER_NOT_FOUND'); throw e; }
    const r = parseOrderDetail(html);
    if (r.unreadable) throw new TsunamiError('Dettaglio ordine in un formato non riconosciuto (parser non ancora verificato su un ordine reale): consultalo sul sito', 'PARSER_UNVERIFIED',
      { url: `${SITE}/index.php?controller=order-detail&id_order=${Number(orderId)}` });
    return { orderId: Number(orderId), ...r, note: 'Lettura dettaglio ordine in beta: verifica sul sito.' };
  }

  async addresses() {
    const r = parseAddresses(await this.#accountPage('indirizzi'));
    if (!r) throw new TsunamiError('Pagina indirizzi non leggibile', 'PARSER_UNVERIFIED');
    if (r.unreadable) throw new TsunamiError('Indirizzi in un formato non riconosciuto: consultali sul sito', 'PARSER_UNVERIFIED');
    return { count: r.addresses.length, addresses: r.addresses };
  }

  async vouchers() {
    const r = parseVouchers(await this.#accountPage('buoni-sconto'));
    if (!r) throw new TsunamiError('Pagina codici sconto non leggibile', 'PARSER_UNVERIFIED');
    return { count: r.length, vouchers: r };
  }

  async loyalty() {
    const r = parseLoyalty(await this.#accountPage('module/loyaltypointsrsi/default?process=summary'));
    if (!r) throw new TsunamiError('Pagina Tsunami Points non leggibile', 'PARSER_UNVERIFIED');
    if (!r.verified) return { ...r, note: 'Hai movimenti punti ma il formato non è ancora verificato: consulta https://www.tsunaminutrition.it/module/loyaltypointsrsi/default?process=summary' };
    return { ...r, program: 'Tsunami Points' };
  }

  async paymentMethods() {
    const names = parsePaymentMethods(await this.request(`${SITE}/content/3-condizioni-vendita`));
    return { methods: names, source: 'Condizioni di vendita, sezione 6 (Modalità di pagamento)',
      note: 'Elenco dichiarato dal sito; quali sono attivi per il tuo ordine si vede solo al checkout, che questo MCP non esegue.' };
  }

  // ---- wishlist (module advansedwishlist, verified live)
  async wishlists() {
    const html = await this.#accountPage('module/advansedwishlist/mywishlist');
    this.#token = extractPrestashopGlobal(html)?.static_token ?? this.#token;
    const lists = parseWishlists(html);
    for (const l of lists) l.products = parseWishlistProducts(await this.request(`${WISHLIST}default?id_wishlist=${l.wishlistId}&refresh=false`));
    return lists;
  }
  async #wishlistAction(action, productId, variantId, wishlistId) {
    if (!this.#token) await this.wishlists();
    const q = new URLSearchParams({ action, id_product: String(productId), quantity: '1', id_product_attribute: String(variantId), id_wishlist: String(wishlistId ?? 0), token: this.#token });
    return this.request(`${WISHLIST}ajax?${q}`, { ajax: true });
  }
  /** wishlistId 0 lets the module use (or create) the default list "Preferiti". */
  wishlistAdd(productId, variantId, wishlistId = 0) { return this.#wishlistAction('add', productId, variantId, wishlistId); }
  wishlistRemove(productId, variantId, wishlistId) { return this.#wishlistAction('delete', productId, variantId, wishlistId); }

  async orders() {
    const html = await this.request(`${SITE}/cronologia-ordini`);
    const ps = extractPrestashopGlobal(html);
    if (!ps?.customer?.is_logged) throw new TsunamiError('Non sei collegato a Tsunami: esegui `npm run login`', 'AUTH_REQUIRED');
    const r = parseOrderHistory(html);
    if (r.unreadable) throw new TsunamiError('Ci sono ordini ma la pagina ha un formato non riconosciuto: consultali su https://www.tsunaminutrition.it/cronologia-ordini', 'PARSER_UNVERIFIED');
    return { total: r.orders.length, orders: r.orders, ...(r.orders.length ? { note: 'Lettura ordini in beta: verifica i dati sul sito.' } : {}) };
  }

  async #cartPost(form) {
    if (!this.#token || !this.jar.hasSession()) await this.session();
    const j = await this.request(CART_URL, { method: 'POST', ajax: true, form: { token: this.#token, action: 'update', ajax: '1', ...form } });
    const errors = [].concat(j.errors ?? []).filter(Boolean);
    if (j.hasError || errors.length) throw new TsunamiError(errors.join('; ') || 'Operazione rifiutata dal sito', 'CART_REJECTED');
    return j;
  }
  add(productId, variantId, quantity) { return this.#cartPost({ add: '1', id_product: String(productId), id_product_attribute: String(variantId), id_customization: '0', qty: String(quantity) }); }
  changeQuantity(productId, variantId, delta) {
    return this.#cartPost({ update: '1', id_product: String(productId), id_product_attribute: String(variantId), op: delta > 0 ? 'up' : 'down', qty: String(Math.abs(delta)) });
  }
  remove(productId, variantId) { return this.#cartPost({ delete: '1', id_product: String(productId), id_product_attribute: String(variantId) }); }
  addVoucher(code) { return this.#cartPost({ addDiscount: '1', discount_name: code }); }
  removeVoucher(id) { return this.#cartPost({ deleteDiscount: String(id) }); }
}

function describe(d, label) {
  return { productId: Number(d.id_product), variantId: Number(d.id_product_attribute) || 0, name: d.name,
    options: label ?? Object.fromEntries(Object.values(d.attributes ?? {}).map(a => [a.group, a.name])),
    unitPrice: d.price_amount, inStock: d.availability !== 'unavailable' && (d.quantity > 0 || d.allow_oosp),
    quantityAvailable: d.quantity, minimalQuantity: Number(d.minimal_quantity || 1) };
}
