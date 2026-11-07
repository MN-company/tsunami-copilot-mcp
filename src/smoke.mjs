/** Read-only live check of the catalog side. Adds nothing to cart or wishlist. */
import { CookieJar, TsunamiClient } from './client.mjs';
const c = new TsunamiClient({ jar: new CookieJar() });
const s = await c.search('whey', { pageSize: 3 });
console.log('search:', s.total, s.products.map(p => `${p.productId} ${p.name} €${p.price}`).join(' | '));
const d = await c.productDetails({ productId: s.products[0].productId });
console.log('details:', d.name, JSON.stringify(d.options.map(o => `${o.name}:${o.values.length}`)));
const n = await c.nutrition({ productId: d.productId });
console.log('nutrition:', n.nutrition?.serving, 'protein/100g:', n.proteinPer100g, '€/g protein:', n.pricePerGramProtein);
const o = await c.offers({ pageSize: 3 });
console.log('offers:', o.total, o.products.map(p => `${p.name} -${p.discountPercent}%`).join(' | '));
console.log('categories:', (await c.categories()).length);
const cart = await c.readCart();
console.log('session: guest items:', cart.totalQuantity, 'free shipping from', cart.shippingInfo.freeShippingFrom);
