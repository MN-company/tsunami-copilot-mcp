/** Normalized comparison fields, shipping rules and local dietary preferences for Tsunami. */

// Italy (verified live on /content/1-spedizione-consegna and in the cart): free from 29,00 €, otherwise 7,00 €.
export const SHIPPING_IT = { freeFrom: 29, cost: 7, source: 'https://www.tsunaminutrition.it/content/1-spedizione-consegna' };
const r2 = n => Math.round(n * 100) / 100;

/** Net weight in grams from a product name: "750 g", "1,5 kg", "3 x 30 g", "2kg". Capsules/tablets → undefined. */
export function netWeightFromName(name) {
  const s = String(name ?? '');
  const multi = s.match(/(\d+)\s*[xX×]\s*(\d+(?:[.,]\d+)?)\s*(kg|g)\b/);
  if (multi) return Number(multi[1]) * Number(multi[2].replace(',', '.')) * (/kg/i.test(multi[3]) ? 1000 : 1);
  const all = [...s.matchAll(/(\d+(?:[.,]\d+)?)\s*(kg|g)\b/gi)];
  if (!all.length) return undefined;
  const m = all.at(-1);
  return Number(m[1].replace(',', '.')) * (/kg/i.test(m[2]) ? 1000 : 1);
}

/** Price per kg and per gram of protein when the inputs are known; never estimated. */
export function compareFields({ price, netWeightG, proteinPer100g }) {
  const out = {};
  if (netWeightG) out.netWeightG = netWeightG;
  if (price && netWeightG) out.pricePerKg = r2(price / netWeightG * 1000);
  if (proteinPer100g !== undefined) out.proteinPer100g = proteinPer100g;
  if (price && netWeightG && proteinPer100g) {
    out.proteinPerPackG = Math.round(netWeightG * proteinPer100g / 100);
    out.pricePerGramProtein = Math.round(price / out.proteinPerPackG * 10000) / 10000;
  }
  return out;
}

/** Shipping for the current cart: the site's own figure when present, plus the distance from free shipping. */
export function shippingInfo(cart) {
  const goods = r2((cart?.subtotal ?? 0) + (cart?.discounts && cart.discounts < 0 ? cart.discounts : 0));
  const empty = !cart?.items?.length;
  const ruleCost = empty ? 0 : goods >= SHIPPING_IT.freeFrom ? 0 : SHIPPING_IT.cost;
  const siteCost = typeof cart?.shipping === 'number' ? cart.shipping : undefined;
  return { country: 'IT', freeShippingFrom: SHIPPING_IT.freeFrom, standardCost: SHIPPING_IT.cost,
    shippingCost: siteCost ?? ruleCost, costSource: siteCost !== undefined ? 'carrello del sito' : 'regola pubblicata',
    missingForFreeShipping: empty ? SHIPPING_IT.freeFrom : r2(Math.max(0, SHIPPING_IT.freeFrom - goods)),
    note: 'Regola per spedizioni in Italia; il costo definitivo dipende dall\'indirizzo scelto al checkout.' };
}

/** Shipping effect of adding `delta` euro to the cart. */
export function shippingAfter(cart, delta) {
  const goods = (cart?.subtotal ?? 0) + delta;
  const cost = goods <= 0 ? 0 : goods >= SHIPPING_IT.freeFrom ? 0 : SHIPPING_IT.cost;
  return { estimatedShipping: cost, missingForFreeShipping: r2(Math.max(0, SHIPPING_IT.freeFrom - goods)) };
}

// ---------------------------------------------------------------- preferences

export const DIETS = {
  'senza glutine': [/senza glutine/i, /gluten[\s-]?free/i],
  vegano: [/vegan/i],
  'senza lattosio': [/senza lattosio/i, /lactose[\s-]?free/i, /delattosat/i],
  'senza zuccheri aggiunti': [/senza zuccheri aggiunti/i, /zero zuccheri/i, /no sugar/i]
};
export const emptyPreferences = () => ({ diets: [], avoidIngredients: [], preferredFlavours: [] });

/**
 * Flags a product against local preferences. Only reports what the SITE DECLARES (features, name,
 * description, ingredient text): absence of a declaration is "non dichiarato", never "sicuro".
 */
export function evaluatePreferences(prefs, product) {
  if (!prefs || (!prefs.diets.length && !prefs.avoidIngredients.length && !prefs.preferredFlavours.length)) return undefined;
  const declared = [product.name, product.summary, product.description, ...(product.features ?? []).map(f => `${f.name} ${f.value}`)].join(' \n ');
  const diets = Object.fromEntries(prefs.diets.map(d => [d, (DIETS[d] ?? [new RegExp(d, 'i')]).some(re => re.test(declared)) ? 'dichiarato dal sito' : 'non dichiarato']));
  const ingredientsText = product.ingredients ?? '';
  const avoid = prefs.avoidIngredients.map(a => ({ ingredient: a,
    status: !ingredientsText ? 'ingredienti non disponibili' : new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(ingredientsText) ? 'PRESENTE negli ingredienti' : 'non trovato nel testo ingredienti' }));
  const flavours = (product.flavours ?? []).filter(f => prefs.preferredFlavours.some(p => f.toLowerCase().includes(p.toLowerCase())));
  return { diets, avoid, preferredFlavoursAvailable: flavours,
    note: 'Indicazioni basate su ciò che il sito dichiara: non è una garanzia. Verifica sempre l\'etichetta, soprattutto per allergie.' };
}
