/** Small, dependency-free parsers for the PrestaShop front office of tsunaminutrition.it. */

export const decodeEntities = s => String(s ?? '')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
export const stripHtml = h => decodeEntities(String(h ?? '').replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Extracts the `var prestashop = {...}` object every page embeds (cart, customer, static_token). */
export function extractPrestashopGlobal(html) {
  const i = html.indexOf('var prestashop = ');
  if (i < 0) return null;
  const s = html.slice(i + 17);
  let depth = 0, inStr = false, esc = false;
  for (let e = 0; e < s.length; e++) {
    const ch = s[e];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) { try { return JSON.parse(s.slice(0, e + 1)); } catch { return null; } }
  }
  return null;
}

/** Variant groups from the `product_variants` HTML: selects, radios and colour swatches named group[ID]. */
export function parseVariantGroups(html) {
  const groups = [];
  const blocks = String(html ?? '').split(/class="product-variants-item/).slice(1);
  for (const b of blocks) {
    const label = stripHtml((b.match(/class="control-label[^"]*"[^>]*>([\s\S]*?)<\/(?:p|span|label)>/) ?? [])[1]).replace(/:$/, '');
    const id = (b.match(/name="group\[(\d+)\]"/) ?? [])[1];
    if (!id) continue;
    const values = [];
    for (const m of b.matchAll(/<option value="(\d+)"([^>]*)>([\s\S]*?)<\/option>/g))
      values.push({ id: m[1], label: decodeEntities((m[2].match(/title="([^"]*)"/) ?? [])[1] ?? stripHtml(m[3])), selected: /selected/.test(m[2]) });
    for (const m of b.matchAll(/<input[^>]*name="group\[\d+\]"[^>]*>/g)) {
      const tag = m[0], value = (tag.match(/value="(\d+)"/) ?? [])[1];
      if (!value || values.some(v => v.id === value)) continue;
      const after = b.slice(b.indexOf(tag) + tag.length, b.indexOf(tag) + tag.length + 400);
      const title = (tag.match(/title="([^"]*)"/) ?? [])[1] ?? (after.match(/class="(?:radio-label|sr-only)"[^>]*>([^<]+)/) ?? [])[1];
      values.push({ id: value, label: decodeEntities(title ?? value).trim(), selected: /checked/.test(tag) });
    }
    groups.push({ id, name: label || `group ${id}`, values });
  }
  return groups;
}

/** The JSON stored in data-product="..." inside `product_details`. */
export function parseDataProduct(html) {
  const m = String(html ?? '').match(/data-product="([^"]+)"/);
  if (!m) return null;
  try { return JSON.parse(decodeEntities(m[1])); } catch { return null; }
}

/**
 * Order history page (/cronologia-ordini). Verified live only for the empty state; rows follow the
 * standard PrestaShop 1.7 layout (reference, date, total, payment, status, link with id_order).
 * When order links exist but no row can be read, the caller must say so instead of guessing.
 */
export function parseOrderHistory(html) {
  const content = String(html ?? '');
  const empty = /Non hai inviato alcun ordine|You have not placed any orders/i.test(content);
  const linkCount = (content.match(/id_order=\d+/g) ?? []).length;
  const orders = [], seen = new Set();
  for (const row of content.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const r = row[1], id = (r.match(/id_order=(\d+)/) ?? [])[1];
    if (!id || seen.has(id)) continue;
    const cells = [...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(m => stripHtml(m[1]));
    seen.add(id);
    orders.push({ orderId: Number(id), reference: cells[0] || undefined, date: cells[1] || undefined,
      total: parseEuro(cells[2]), payment: cells[3] || undefined, status: cells[4] || undefined });
  }
  return { empty, orders, unreadable: !empty && linkCount > 0 && orders.length === 0 };
}
export const parseEuro = s => { const m = String(s ?? '').match(/(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})/); return m ? Number(m[1].replace(/\./g, '') + '.' + m[2]) : undefined; };

// ---------------------------------------------------------------- v0.2 parsers

const num = s => { const m = String(s ?? '').replace(/\s/g, '').match(/-?\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(',', '.')) : undefined; };
/** "30 g" → 30, "1,5 kg" → 1500, anything else → undefined. */
export const gramsOf = s => {
  const m = String(s ?? '').match(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/i);
  if (!m) return undefined;
  const v = Number(m[1].replace(',', '.'));
  return /kg/i.test(m[2]) ? v * 1000 : v;
};
const isHeading = t => /^[A-ZÀ-Ü0-9\s()]+$/.test(t ?? '') && /[A-Z]{3}/.test(t ?? '');

/**
 * Nutrition table from the product page tab #nutritionalfacts (theme "nutritionFacts" div grid).
 * Column 2 is the amount per serving unless its header mentions 100 g. Verified live on whey products.
 */
export function parseNutrition(html) {
  const s = String(html ?? '');
  const start = s.indexOf('class="nutritionFacts"');
  if (start < 0) return null;
  const tail = s.slice(start, start + 60000);
  const stop = tail.search(/<\/div>\s*<\/div>\s*<div class="tab-pane|class="other"/);
  const block = stop > 0 ? tail.slice(0, stop) : tail;
  const rows = [];
  for (const m of block.matchAll(/<div class="(row[^"]*)">([\s\S]*?)<\/div>/g)) {
    const cells = {};
    for (const c of m[2].matchAll(/<span class="col (col_\d)[^"]*"[^>]*>([\s\S]*?)<\/span>(?=\s*<span class="col|\s*$)/g)) cells[c[1]] = stripHtml(c[2]);
    if (Object.keys(cells).length) rows.push({ cls: m[1], cells });
  }
  const info = rows.find(r => /\binfo\b/.test(r.cls));
  const header = rows.find(r => /\bbold\b/.test(r.cls));
  const per100Header = /100/.test(header?.cells.col_2 ?? '');
  const servings = num((block.match(/servingpercontainer[\s\S]*?class="value1">([^<]*)/) ?? [])[1]);
  const servingText = stripHtml((block.match(/servingsizeqty[^>]*>([\s\S]*?)<\/span><\/div>/) ?? [])[1]).replace(/^Dose:\s*/i, '');
  const nutrients = [];
  let section = 'informazioni nutrizionali';
  for (const r of rows) {
    if (!/^rows\b/.test(r.cls)) continue;
    const name = r.cells.col_1, amount = r.cells.col_2;
    if (isHeading(name)) { section = (name.toLowerCase() + (amount ? ` (${amount})` : '')).trim(); continue; }
    if (name) nutrients.push({ section, name, amount: amount || undefined });
  }
  const protein = nutrients.find(n => /^protein/i.test(n.name) && /informazioni/.test(n.section));
  const servingG = gramsOf(servingText);
  const proteinG = gramsOf(protein?.amount);
  const proteinPer100g = proteinG === undefined ? undefined : per100Header ? proteinG : servingG ? Math.round(proteinG / servingG * 1000) / 10 : undefined;
  const after = s.slice(start, start + 80000);
  const field = label => stripHtml((after.match(new RegExp(`<strong>${label}:<\\/strong>\\s*<span>([\\s\\S]*?)<\\/span>`)) ?? [])[1]) || undefined;
  const ingredients = field('Ingredienti');
  const flavour = (ingredients?.match(/relativi al gusto\s+(.+)$/i) ?? [])[1];
  return { basis: per100Header ? 'per_100g' : 'per_serving', netWeight: info?.cells.col_1, tableFlavour: info?.cells.col_3 || flavour || undefined,
    servingsPerPack: servings, serving: servingText || undefined, servingG,
    proteinPerServingG: per100Header ? undefined : proteinG, proteinPer100g, nutrients,
    ingredients: ingredients?.replace(/\s*Ricordiamo che[\s\S]*$/i, ''), instructions: field('Istruzioni'), warnings: field('Avvertenze') };
}

/** schema.org Product JSON-LD: aggregate rating and the reviews embedded in the page. */
export function parseReviews(html) {
  for (const m of String(html ?? '').matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let j; try { j = JSON.parse(m[1]); } catch { continue; }
    for (const node of [].concat(j['@graph'] ?? j)) {
      if (node?.['@type'] !== 'Product') continue;
      const a = node.aggregateRating;
      return { rating: a ? Number(a.ratingValue) : null, reviewCount: a ? Number(a.reviewCount ?? a.ratingCount) : 0,
        reviews: [].concat(node.review ?? []).map(r => ({ author: r.author?.name, date: r.datePublished,
          rating: Number(r.reviewRating?.ratingValue) || undefined, text: String(r.reviewBody ?? '').slice(0, 600) })) };
    }
  }
  return { rating: null, reviewCount: 0, reviews: [] };
}

/** Category menu links "/<id>-<slug>" with their visible names. */
export function parseCategories(html) {
  const out = new Map();
  for (const m of String(html ?? '').matchAll(/<a[^>]+href="https:\/\/www\.tsunaminutrition\.it\/(\d+)-([a-z0-9-]+)"[^>]*>([\s\S]{0,300}?)<\/a>/g)) {
    const name = stripHtml(m[3]);
    if (name && !out.has(m[1])) out.set(m[1], { categoryId: Number(m[1]), slug: m[2], name });
  }
  return [...out.values()];
}

/** /buoni-sconto table: code, description, quantity, value, minimum, cumulative, expiry. Verified live. */
export function parseVouchers(html) {
  const s = String(html ?? ''), i = s.indexOf('page-content--discount');
  if (i < 0) return null;
  const end = s.indexOf('</table>', i);
  const part = s.slice(i, end > 0 ? end : i + 30000);
  // Each row: <th> with the code (or "Automatico al carrello" when applied automatically), then 6 <td>.
  return [...part.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => ({
    head: stripHtml((r[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) ?? [])[1]),
    c: [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(x => stripHtml(x[1])) }))
    .filter(r => r.c.length >= 6).map(({ head, c }) => {
      const auto = /automatico/i.test(head);
      return { code: auto ? null : head, appliedAutomatically: auto, description: c[0], quantity: num(c[1]), value: c[2], minimumOrder: c[3], cumulative: /^s/i.test(c[4]), expires: c[5] };
    });
}

/** Payment methods named in section 6 of the terms of sale ("6.1 Carta di Credito" ...). Verified live. */
export function parsePaymentMethods(html) {
  const s = String(html ?? ''), a = s.search(/6\.\s*MODALIT/i);
  if (a < 0) return [];
  const sec = s.slice(a, a + 40000);
  const stop = sec.search(/>\s*7\.\s/);
  return [...(stop > 0 ? sec.slice(0, stop) : sec).matchAll(/<(strong|b|h\d)[^>]*>\s*6\.\d+\s+([^<]{2,60})<\/\1>/g)].map(m => m[2].trim());
}

/** /indirizzi: PrestaShop 1.7 address cards. Empty state verified live; filled cards follow the standard markup (unverified). */
export function parseAddresses(html) {
  const s = String(html ?? ''), i = s.indexOf('page-content--addresses');
  if (i < 0) return null;
  const f = s.indexOf('addresses-footer', i);
  const part = s.slice(i, f > 0 ? f : i + 30000);
  const ids = [...new Set([...part.matchAll(/(?:id="address-|data-id-address=")(\d+)/g)].map(m => m[1]))];
  const addresses = ids.map(id => {
    const card = part.slice(part.search(new RegExp(`(?:id="address-|data-id-address=")${id}\\b`))).slice(0, 3000);
    return { addressId: Number(id), alias: stripHtml((card.match(/<h4[^>]*>([\s\S]*?)<\/h4>/) ?? [])[1]) || undefined,
      text: stripHtml((card.match(/<address[^>]*>([\s\S]*?)<\/address>/) ?? [])[1]) || undefined };
  });
  return { addresses, unreadable: addresses.some(a => !a.text) };
}

/**
 * Order detail (dettagli-ordine?id_order=). UNVERIFIED on the live theme (the account has no orders):
 * reads the standard PrestaShop 1.7 blocks and flags unreadable instead of guessing.
 */
export function parseOrderDetail(html) {
  const s = String(html ?? '');
  const lines = [];
  const table = (s.match(/id="order-products"[\s\S]*?<\/table>/) ?? [''])[0];
  for (const r of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1]);
    if (cells.length < 3) continue;
    const link = cells[0].match(/href="[^"]*\/(\d+)(?:-(\d+))?-[^"/]*\.html/) ?? [];
    const full = stripHtml((cells[0].match(/<strong>([\s\S]*?)<\/strong>/) ?? [, cells[0]])[1]);
    const [name, ...attrs] = full.split(/\s+-\s+/);
    const options = Object.fromEntries(attrs.join(', ').split(/,\s*/).map(x => x.split(/\s*:\s*/)).filter(p => p.length === 2 && p[0] && p[1]));
    lines.push({ productId: link[1] ? Number(link[1]) : undefined, variantId: link[2] ? Number(link[2]) : undefined, name, options,
      quantity: num(stripHtml(cells[1])), unitPrice: parseEuro(stripHtml(cells[2])), total: parseEuro(stripHtml(cells.at(-1))) });
  }
  const history = (s.match(/id="order-history"[\s\S]*?<\/table>/) ?? [''])[0];
  const firstRow = [...history.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => stripHtml(c[1]))).find(c => c.length >= 2);
  return { status: firstRow?.[1], statusDate: firstRow?.[0], lines, unreadable: !lines.length || lines.some(l => !l.productId) };
}

/** Wishlist list page (module advansedwishlist): id, name, count. Verified live. */
export function parseWishlists(html) {
  return [...String(html ?? '').matchAll(/<article class="wishlists__item wishlist" id="wishlist_(\d+)">([\s\S]*?)<\/article>/g)].map(m => ({
    wishlistId: Number(m[1]), name: stripHtml((m[2].match(/class="wishlist__link[^"]*"[^>]*>([\s\S]*?)<\/a>/) ?? [])[1]),
    count: num(stripHtml((m[2].match(/class="wishlist_tb_count">([\s\S]*?)<\/span>/) ?? [])[1])) ?? 0 }));
}

/** Wishlist detail rows "wlp_<product>_<attribute>". Prices on that page are WITHOUT VAT. Verified live. */
export function parseWishlistProducts(html) {
  return [...String(html ?? '').matchAll(/<tr id="wlp_(\d+)_(\d+)">([\s\S]*?)<\/tr>/g)].map(m => ({
    productId: Number(m[1]), variantId: Number(m[2]), itemKey: `${m[1]}-${m[2]}`,
    name: stripHtml((m[3].match(/class="h5[^"]*"[^>]*>([\s\S]*?)<\/a>/) ?? [])[1]),
    variant: stripHtml((m[3].match(/class="wishlist_product_detail">([\s\S]*?)<\/span>/) ?? [])[1]) || undefined,
    quantity: num((m[3].match(/id="quantity_\d+_\d+" value="\s*(\d+)/) ?? [])[1]) ?? 1,
    priceExclVat: parseEuro(stripHtml((m[3].match(/wishlist-product-price[^>]*>([\s\S]*?)<\/td>/) ?? [])[1])) }));
}

/** Tsunami Points (module loyaltypointsrsi). Only the empty state is verified live. */
export function parseLoyalty(html) {
  const s = String(html ?? ''), i = s.indexOf('page-content--module-loyaltypointsrsi');
  if (i < 0) return null;
  const part = s.slice(i, i + 20000);
  if (/Ancora nessun Tsunami Point/i.test(part)) return { points: 0, history: [], verified: true };
  const rows = [...((part.match(/<table[\s\S]*?<\/table>/) ?? [''])[0]).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map(r => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => stripHtml(c[1]))).filter(c => c.length >= 3);
  return { points: undefined, history: rows, verified: false };
}

/** Variant id from an add-to-cart URL (prices-drop items may lack id_product_attribute). */
export const variantFromAddUrl = u => { try { return Number(new URL(u).searchParams.get('id_product_attribute')) || 0; } catch { return 0; } };
