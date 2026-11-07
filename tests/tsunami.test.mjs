import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../src/store.mjs';
import { CartPlanner } from '../src/planner.mjs';
import { extractPrestashopGlobal, parseVariantGroups, parseDataProduct, parseOrderHistory } from '../src/parse.mjs';
import { CookieJar, productIdFromRef } from '../src/client.mjs';

test('parsers read the PrestaShop global, variant groups and data-product', () => {
  const html = '<script>var prestashop = {"cart":{"products":[]},"static_token":"abc","x":"a}b"};</script>';
  assert.equal(extractPrestashopGlobal(html).static_token, 'abc');
  const groups = parseVariantGroups('<div class="product-variants-item mt-2"><p class="control-label h6">Gusto</p><select name="group[4]"><option value="112" title="Pistacchio" selected="selected">Pistacchio</option><option value="691" title="Yogurt &amp; Berries">Yogurt &amp; Berries</option></select></div>');
  assert.deepEqual(groups, [{ id: '4', name: 'Gusto', values: [{ id: '112', label: 'Pistacchio', selected: true }, { id: '691', label: 'Yogurt & Berries', selected: false }] }]);
  assert.equal(parseDataProduct('<div data-product="{&quot;id_product&quot;:7003}">').id_product, 7003);
});

test('product id is taken from URLs with or without combination', () => {
  assert.equal(productIdFromRef({ url: 'https://www.tsunaminutrition.it/proteine/7003-10873-whey-gym.html#/736-gusto' }), 7003);
  assert.equal(productIdFromRef({ url: 'https://www.tsunaminutrition.it/proteine/7003-whey-gym.html' }), 7003);
});

test('cookie jar keeps and deletes cookies from Set-Cookie', () => {
  const jar = new CookieJar();
  jar.absorb({ headers: { getSetCookie: () => ['PrestaShop-1=abc; path=/', 'x=1'] } });
  assert.ok(jar.hasSession());
  jar.absorb({ headers: { getSetCookie: () => ['PrestaShop-1=deleted; expires=Thu, 01 Jan 1970 00:00:00 GMT'] } });
  assert.ok(!jar.hasSession());
});

function setup({ applyAdd = true } = {}) {
  const store = new AgentStore(':memory:');
  let cart = { items: [], vouchers: [], subtotal: 0 };
  const calls = [];
  const client = {
    session: async () => ({ cart, loggedIn: false }),
    readCart: async () => cart,
    resolveVariant: async () => ({ productId: 7003, variantId: 10877, name: 'Whey', options: { Gusto: 'Pistacchio' }, unitPrice: 34.9, inStock: true, quantityAvailable: 50, minimalQuantity: 1 }),
    add: async (p, v, q) => { calls.push(['add', p, v, q]); if (applyAdd) cart = { ...cart, items: [{ itemKey: `${p}-${v}`, productId: p, variantId: v, quantity: q, unitPrice: 34.9 }] }; return {}; }
  };
  return { store, calls, planner: new CartPlanner({ client, store }), touch: () => { cart = { ...cart, items: [{ itemKey: '1-1', quantity: 1 }] }; } };
}

test('commit runs once and verifies by reading the cart back', async () => {
  const { planner, calls } = setup();
  const p = await planner.prepare([{ op: 'add', productId: 7003, quantity: 2, options: { Gusto: 'Pistacchio' } }]);
  assert.equal(calls.length, 0); assert.equal(p.estimatedDelta, 69.8);
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'committed'); assert.equal(calls.length, 1);
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), e => e.code === 'PLAN_ALREADY_USED');
});

test('a "success" response that changed nothing is reported as unverified', async () => {
  const { planner } = setup({ applyAdd: false });
  const p = await planner.prepare([{ op: 'add', productId: 7003, quantity: 1, options: { Gusto: 'Pistacchio' } }]);
  const r = await planner.commit(p.planId, p.confirmationPhrase);
  assert.equal(r.status, 'unverified'); assert.equal(r.mismatches[0].expected, 1); assert.equal(r.mismatches[0].actual, 0);
});

test('commit refuses a changed cart', async () => {
  const { planner, calls, touch } = setup();
  const p = await planner.prepare([{ op: 'add', productId: 7003, quantity: 1, options: { Gusto: 'Pistacchio' } }]);
  touch();
  await assert.rejects(planner.commit(p.planId, p.confirmationPhrase), e => e.code === 'CART_CHANGED');
  assert.equal(calls.length, 0);
});

test('order history: empty state, standard rows, unreadable layout', () => {
  assert.deepEqual(parseOrderHistory('<li>Non hai inviato alcun ordine.</li>'), { empty: true, orders: [], unreadable: false });
  const row = '<table><tr><th scope="row">ABCDEF</th><td>07/11/2026</td><td class="text-xs-right">1.234,50 €</td><td>Carta</td><td><span class="label">Spedito</span></td><td><a href="/dettagli-ordine?id_order=42">Dettagli</a></td></tr></table>';
  assert.deepEqual(parseOrderHistory(row).orders, [{ orderId: 42, reference: 'ABCDEF', date: '07/11/2026', total: 1234.5, payment: 'Carta', status: 'Spedito' }]);
  assert.equal(parseOrderHistory('<div class="order"><a href="?id_order=7">x</a></div>').unreadable, true);
});
