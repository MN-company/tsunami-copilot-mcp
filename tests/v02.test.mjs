import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/store.mjs';
import { CartPlanner, WishlistPlanner } from '../src/planner.mjs';
import { parseNutrition, parseReviews, parseCategories, parseVouchers, parsePaymentMethods, parseAddresses, parseOrderDetail,
  parseWishlists, parseWishlistProducts, parseLoyalty, gramsOf, variantFromAddUrl } from '../src/parse.mjs';
import { compareFields, netWeightFromName, shippingInfo, shippingAfter, evaluatePreferences, emptyPreferences } from '../src/compare.mjs';
import { filterProducts, mapListProduct } from '../src/client.mjs';

// Markup shapes copied from the live site (values shortened).
const NUTRI = '<div class="tab-pane fade in" id="nutritionalfacts"><div class="cms-content"><div class="nutritionFacts"><div class="nutritionTable">'
  + '<div class="row noborder right big info"><span class="col col_1">750g</span><span class="col col_3" style="width: 30%;">Choco King</span></div>'
  + '<div class="row bar2 serving_info"><span class="col col_1 no_col2 no_col3 servingpercontainer">Dosi per confezione: <span class="value1">25</span></span><span class="col col_1 no_col2 no_col3 servingsizeqty">Dose: <span class="value1"></span> (<span class="value2">30 g</span>)</span></div>'
  + '<div class="row bar1 bold"><span class="col col_1">Componente</span><span class="col col_2">Quantità</span><span class="col col_3">% VNR</span></div>'
  + '<div class="rows row indent bar1"><span class="col col_1 no_col2 no_col3">INFORMAZIONI NUTRIZIONALI</span><span class="col col_2"></span><span class="col col_3"></span></div>'
  + '<div class="rows row"><span class="col col_1 no_col3">Energia</span><span class="col col_2">449 Kj 107Kcal</span><span class="col col_3"></span></div>'
  + '<div class="rows row"><span class="col col_1 no_col3">Proteine</span><span class="col col_2">20 g</span><span class="col col_3"></span></div>'
  + '<div class="rows row indent bar1"><span class="col col_1 no_col3">PROFILO AMINOACIDICO</span><span class="col col_2">per 100 g</span><span class="col col_3"></span></div>'
  + '<div class="rows row"><span class="col col_1 no_col3">Leucina</span><span class="col col_2">10,37 g</span><span class="col col_3"></span></div>'
  + '</div><div class="other"><strong>Ingredienti:</strong> <span>proteine del siero del latte, sucralosio. Ricordiamo che i valori nutrizionali e gli ingredienti sono relativi al gusto <b>Choco King</b></span></div>'
  + '<div class="moreinfo"><strong>Istruzioni:</strong> <span>Sciogliere 30 g in acqua.</span></div></div></div></div>';

test('nutrition table: serving basis, protein per 100 g, sections, ingredients', () => {
  const n = parseNutrition(NUTRI);
  assert.equal(n.basis, 'per_serving'); assert.equal(n.netWeight, '750g'); assert.equal(n.tableFlavour, 'Choco King');
  assert.equal(n.servingsPerPack, 25); assert.equal(n.servingG, 30); assert.equal(n.proteinPerServingG, 20); assert.equal(n.proteinPer100g, 66.7);
  assert.equal(n.nutrients.find(x => x.name === 'Leucina').section, 'profilo aminoacidico (per 100 g)');
  assert.equal(n.ingredients, 'proteine del siero del latte, sucralosio.'); assert.equal(n.instructions, 'Sciogliere 30 g in acqua.');
  assert.equal(parseNutrition('<div>niente</div>'), null);
});

test('compare fields, weights and shipping', () => {
  assert.equal(netWeightFromName('Whey Gym Tok Line 750 g'), 750); assert.equal(netWeightFromName('Whey 2 kg'), 2000);
  assert.equal(netWeightFromName('Bustine 3 x 30 g'), 90); assert.equal(netWeightFromName('Capsule 60 cps'), undefined);
  assert.equal(gramsOf('1,5 kg'), 1500);
  assert.deepEqual(compareFields({ price: 34.9, netWeightG: 750, proteinPer100g: 66.7 }),
    { netWeightG: 750, pricePerKg: 46.53, proteinPer100g: 66.7, proteinPerPackG: 500, pricePerGramProtein: 0.0698 });
  assert.deepEqual(compareFields({ price: 10 }), {});
  assert.deepEqual(shippingAfter({ subtotal: 0 }, 1.6), { estimatedShipping: 7, missingForFreeShipping: 27.4 });
  assert.equal(shippingAfter({ subtotal: 20 }, 9).estimatedShipping, 0);
  const s = shippingInfo({ items: [{}], subtotal: 1.6, shipping: 7 });
  assert.equal(s.shippingCost, 7); assert.equal(s.missingForFreeShipping, 27.4);
});

test('list mapping recomputes discount and flags option choice; local filters', () => {
  const p = mapListProduct({ id_product: '6366', name: 'Bar 45 g', price_amount: 1.09, regular_price_amount: 2.9, has_discount: true, discount_percentage: '-181%', add_to_cart_url: null });
  assert.equal(p.discountPercent, 62); assert.equal(p.needsOptionChoice, true); assert.equal(p.pricePerKg, 24.22);
  assert.equal(variantFromAddUrl('https://x.it/carrello?add=1&id_product=1&id_product_attribute=55'), 55);
  const list = [{ name: 'A SENZA GLUTINE', summary: '', price: 10, regularPrice: 12 }, { name: 'B', summary: 'vegan', price: 40 }];
  assert.equal(filterProducts(list, { diet: 'senza glutine' }).length, 1);
  assert.equal(filterProducts(list, { maxPrice: 20, onlyDiscounted: true }).length, 1);
});

test('reviews, categories, vouchers, payment methods, loyalty', () => {
  const rv = parseReviews('<script type="application/ld+json">{"@type":"Product","aggregateRating":{"ratingValue":4.13,"reviewCount":9},"review":[{"author":{"name":"V"},"datePublished":"2026-10-22","reviewRating":{"ratingValue":5},"reviewBody":"ottimo"}]}</script>');
  assert.deepEqual(rv, { rating: 4.13, reviewCount: 9, reviews: [{ author: 'V', date: '2026-10-22', rating: 5, text: 'ottimo' }] });
  assert.deepEqual(parseCategories('<a href="https://www.tsunaminutrition.it/121-creatina" class="x"><span>Creatina</span></a>'), [{ categoryId: 121, slug: 'creatina', name: 'Creatina' }]);
  const v = parseVouchers('<section class="page-content--discount"><table><tr><th>Codice</th></tr><tr><th>Automatico al carrello</th><td>Extra 5%</td><td>999999</td><td>5.00%</td><td>199,90 €</td><td>No</td><td>02/01/2029</td></tr><tr><th>WELCOME10</th><td>Benvenuto</td><td>1</td><td>10%</td><td>0,00 €</td><td>Si</td><td>31/12/2026</td></tr></table>');
  assert.deepEqual(v.map(x => [x.code, x.appliedAutomatically, x.value, x.cumulative]), [[null, true, '5.00%', false], ['WELCOME10', false, '10%', true]]);
  assert.deepEqual(parsePaymentMethods('<p>6. MODALITA DI PAGAMENTO</p><p><strong>6.1 Carta di Credito</strong></p><p><strong>6.2 PayPal</strong></p><p> 7. Altro</p><p><strong>7.1 X</strong></p>'), ['Carta di Credito', 'PayPal']);
  assert.deepEqual(parseLoyalty('<section class="page-content--module-loyaltypointsrsi-default"><p class="warning">Ancora nessun Tsunami Point.</p>'), { points: 0, history: [], verified: true });
});

test('addresses, wishlists and order detail', () => {
  assert.deepEqual(parseAddresses('<section class="page-content--addresses"><div class="row"></div><div class="addresses-footer">'), { addresses: [], unreadable: false });
  const a = parseAddresses('<section class="page-content--addresses"><article id="address-7" class="address" data-id-address="7"><h4>Casa</h4><address>Via Roma 1<br>Milano</address></article><div class="addresses-footer">');
  assert.deepEqual(a.addresses, [{ addressId: 7, alias: 'Casa', text: 'Via Roma 1 Milano' }]);
  const wl = parseWishlists('<article class="wishlists__item wishlist" id="wishlist_22889"><a class="wishlist__link h5" data-wishlist-id="22889" href="#"> Preferiti </a><span class="wishlist_tb_count"> 1 </span></article>');
  assert.deepEqual(wl, [{ wishlistId: 22889, name: 'Preferiti', count: 1 }]);
  const wp = parseWishlistProducts('<tr id="wlp_7003_10877"><a class="h5 mb-2" href="#">Whey</a><span class="wishlist_product_detail"><a>Pistacchio</a></span><td class="col-md-1 wishlist-product-price d-none"> 31,73 € </td><input id="quantity_7003_10877" value=" 1 "></tr>');
  assert.deepEqual(wp, [{ productId: 7003, variantId: 10877, itemKey: '7003-10877', name: 'Whey', variant: 'Pistacchio', quantity: 1, priceExclVat: 31.73 }]);
  const od = parseOrderDetail('<table id="order-products"><tr><td><strong><a href="https://www.tsunaminutrition.it/whey/7003-10877-whey.html">Whey - Gusto : Pistacchio</a></strong></td><td>2</td><td>34,90 €</td><td>69,80 €</td></tr></table><table id="order-history"><tr><td>01/11/2026</td><td>Spedito</td></tr></table>');
  assert.deepEqual(od.lines, [{ productId: 7003, variantId: 10877, name: 'Whey', options: { Gusto: 'Pistacchio' }, quantity: 2, unitPrice: 34.9, total: 69.8 }]);
  assert.equal(od.status, 'Spedito'); assert.equal(od.unreadable, false);
  assert.equal(parseOrderDetail('<div>layout sconosciuto</div>').unreadable, true);
});

test('preferences only report what the site declares', () => {
  assert.equal(evaluatePreferences(emptyPreferences(), { name: 'x' }), undefined);
  const e = evaluatePreferences({ diets: ['senza glutine', 'vegano'], avoidIngredients: ['sucralosio'], preferredFlavours: ['pistacchio'] },
    { name: 'Whey', features: [{ name: 'Esigenze Alimentari', value: 'Senza Glutine' }], ingredients: 'siero, sucralosio', flavours: ['Pistacchio', 'Cacao'] });
  assert.deepEqual(e.diets, { 'senza glutine': 'dichiarato dal sito', vegano: 'non dichiarato' });
  assert.equal(e.avoid[0].status, 'PRESENTE negli ingredienti'); assert.deepEqual(e.preferredFlavoursAvailable, ['Pistacchio']);
  assert.ok(!/sicur/i.test(JSON.stringify(e).replace(/non è una garanzia/, '')));
});

test('reorder expands order lines with live checks; shipping warning in summary', async () => {
  const store = new AgentStore(':memory:');
  const cart = { items: [], vouchers: [], subtotal: 0 };
  const client = { session: async () => ({ cart, loggedIn: true }),
    orderDetail: async () => ({ lines: [{ productId: 7003, name: 'Whey', options: { Gusto: 'Pistacchio' }, quantity: 2, unitPrice: 30 }] }),
    resolveVariant: async () => ({ productId: 7003, variantId: 10877, name: 'Whey', options: { Gusto: 'Pistacchio' }, unitPrice: 34.9, inStock: true, quantityAvailable: 9, minimalQuantity: 1 }) };
  const p = await new CartPlanner({ client, store }).prepare([{ op: 'reorder', orderId: 5 }]);
  assert.equal(p.lines[0].origin, 'ordine 5'); assert.equal(p.lines[0].quantity, 2);
  assert.ok(p.warnings.some(w => /prezzo cambiato/.test(w)));
  assert.equal(p.shipping.estimatedShipping, 0);
});

test('wishlist plan: prepare read-only, commit once, verified', async () => {
  const store = new AgentStore(':memory:');
  let lists = [];
  const calls = [];
  const client = { wishlists: async () => lists,
    resolveVariant: async () => ({ productId: 7003, variantId: 10877, name: 'Whey', options: { Gusto: 'Pistacchio' } }),
    wishlistAdd: async (p, v, w) => { calls.push(['add', p, v, w]); lists = [{ wishlistId: 1, name: 'Preferiti', products: [{ itemKey: `${p}-${v}`, productId: p, variantId: v }] }]; } };
  const wp = new WishlistPlanner({ client, store });
  const plan = await wp.prepare([{ op: 'add', productId: 7003 }]);
  assert.equal(calls.length, 0); assert.equal(plan.lines[0].list, 'Preferiti (verrà creata)');
  assert.equal((await wp.commit(plan.planId, plan.confirmationPhrase)).status, 'committed');
  await assert.rejects(wp.commit(plan.planId, plan.confirmationPhrase), e => e.code === 'PLAN_ALREADY_USED');
  assert.deepEqual(calls, [['add', 7003, 10877, 0]]);
});
