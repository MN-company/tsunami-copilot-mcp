import crypto from 'node:crypto';
import { TsunamiError } from './client.mjs';
import { shippingAfter } from './compare.mjs';

export const cartFingerprint = cart => crypto.createHash('sha256')
  .update(JSON.stringify([(cart?.items ?? []).map(i => [i.itemKey, i.quantity]).sort(), (cart?.vouchers ?? []).map(v => v.id).sort()]))
  .digest('hex').slice(0, 16);

const WORDS = ['WHEY', 'CREA', 'WAVE', 'SURF', 'GYM', 'OATS', 'BCAA'];
const newPhrase = () => `${WORDS[crypto.randomInt(WORDS.length)]}-${crypto.randomInt(1000, 9999)}`;
const round = n => Math.round(n * 100) / 100;

/** Expected quantity per itemKey after the plan, used to verify the site really applied it. */
function expectedQuantities(cart, ops) {
  const q = new Map(cart.items.map(i => [i.itemKey, i.quantity]));
  for (const o of ops) {
    const k = `${o.productId}-${o.variantId}`;
    if (o.op === 'add') q.set(k, (q.get(k) ?? 0) + o.quantity);
    else if (o.op === 'update') q.set(k, o.to);
    else if (o.op === 'remove') q.delete(k);
  }
  return q;
}

/**
 * Two-phase cart changes for Tsunami. prepare() is read-only; commit() runs the plan ONCE if the
 * cart is unchanged, then re-reads the cart to verify: PrestaShop can answer "success" without
 * applying a change, so the read-back, not the response, decides the outcome.
 */
export class CartPlanner {
  constructor({ client, store, ttlMs = 15 * 60 * 1000, writesEnabled = true }) { Object.assign(this, { client, store, ttlMs, writesEnabled }); }

  async prepare(operations) {
    if (!operations?.length) throw new TsunamiError('Nessuna operazione', 'INVALID_ARGUMENT');
    const { cart, loggedIn } = await this.client.session();
    const ops = [], lines = [], warnings = [];
    let delta = 0;
    const addLine = async (ref, options, quantity, origin) => {
      const v = await this.client.resolveVariant(ref, options ?? {});
      if (!v.inStock) throw new TsunamiError(`${v.name} ${Object.values(v.options).join(' ')} non è disponibile`, 'OUT_OF_STOCK');
      if (quantity < v.minimalQuantity) throw new TsunamiError(`Quantità minima ${v.minimalQuantity}`, 'INVALID_QUANTITY');
      if (v.quantityAvailable > 0 && quantity > v.quantityAvailable) warnings.push(`${v.name}: disponibili solo ${v.quantityAvailable} pezzi.`);
      this.store.recordPrice(`${v.productId}-${v.variantId}`, v.unitPrice);
      ops.push({ op: 'add', productId: v.productId, variantId: v.variantId, quantity });
      lines.push({ action: 'aggiungi', name: v.name, options: v.options, quantity, unitPrice: v.unitPrice, estimatedTotal: round(v.unitPrice * quantity), ...(origin ? { origin } : {}) });
      delta += v.unitPrice * quantity;
    };
    for (const op of operations) {
      if (op.op === 'add') {
        await addLine({ productId: op.productId, url: op.url }, op.options, op.quantity);
      } else if (op.op === 'reorder') {
        // Explicit expansion of a past order into add lines, each with a live stock and price check.
        const order = await this.client.orderDetail(op.orderId);
        for (const l of order.lines) {
          if (!l.productId || !l.quantity) throw new TsunamiError('Riga ordine non leggibile: riordino non preparato', 'PARSER_UNVERIFIED');
          await addLine({ productId: l.productId }, l.options, l.quantity, `ordine ${op.orderId}`);
          if (l.unitPrice !== undefined && Math.abs(l.unitPrice - lines.at(-1).unitPrice) >= 0.01) warnings.push(`${l.name}: prezzo cambiato da ${l.unitPrice} € a ${lines.at(-1).unitPrice} €.`);
        }
      } else if (op.op === 'update' || op.op === 'remove') {
        const item = cart.items.find(i => i.itemKey === op.itemKey);
        if (!item) throw new TsunamiError('Articolo non presente nel carrello: rileggi il carrello', 'ITEM_NOT_IN_CART');
        const to = op.op === 'remove' ? 0 : op.quantity;
        if (to === item.quantity) throw new TsunamiError('La quantità è già quella richiesta', 'NO_CHANGE');
        ops.push(to === 0 ? { op: 'remove', productId: item.productId, variantId: item.variantId }
          : { op: 'update', productId: item.productId, variantId: item.variantId, from: item.quantity, to });
        lines.push({ action: to === 0 ? 'rimuovi' : 'modifica quantità', name: item.name, options: item.options, from: item.quantity, to });
        delta += (to - item.quantity) * (item.unitPrice ?? 0);
      } else if (op.op === 'voucher_apply') {
        ops.push({ op: 'voucher_apply', code: op.code });
        lines.push({ action: 'applica codice sconto', code: op.code, note: 'validità e sconto si vedono solo dopo l\'applicazione' });
      } else if (op.op === 'voucher_remove') {
        const v = cart.vouchers.find(x => x.id === op.voucherId);
        if (!v) throw new TsunamiError('Codice sconto non presente nel carrello', 'INVALID_ARGUMENT');
        ops.push({ op: 'voucher_remove', voucherId: v.id }); lines.push({ action: 'rimuovi codice sconto', name: v.name });
      } else throw new TsunamiError(`Operazione sconosciuta: ${op.op}`, 'INVALID_ARGUMENT');
    }
    const plan = { id: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, phrase: newPhrase(), cartFingerprint: cartFingerprint(cart), ops,
      summary: { cartMode: loggedIn ? 'customer' : 'guest', lines, currentSubtotal: cart.subtotal, estimatedDelta: round(delta),
        estimatedNewSubtotal: round((cart.subtotal ?? 0) + delta), shipping: shippingAfter(cart, delta), warnings } };
    if (plan.summary.shipping.estimatedShipping > 0) warnings.push(`Spedizione stimata ${plan.summary.shipping.estimatedShipping} €: mancano ${plan.summary.shipping.missingForFreeShipping} € alla spedizione gratuita (da 29 €).`);
    this.store.savePlan(plan);
    this.store.audit('cart_prepare', { planId: plan.id, ops: ops.length });
    return { planId: plan.id, confirmationPhrase: plan.phrase, expiresAt: new Date(plan.expiresAt).toISOString(), ...plan.summary, writesEnabled: this.writesEnabled,
      instructions: 'Mostra questo riepilogo all\'utente. Esegui tsunami_commit_cart_change solo dopo un suo esplicito OK in un messaggio successivo.' };
  }

  async commit(planId, phrase) {
    if (!this.writesEnabled) throw new TsunamiError('Scritture sul carrello disattivate (ALLOW_CART_WRITES=false)', 'WRITES_DISABLED');
    const plan = this.store.getPlan(planId);
    if (!plan) throw new TsunamiError('Piano non trovato', 'PLAN_NOT_FOUND');
    if (plan.status !== 'prepared') throw new TsunamiError(`Piano già usato (stato: ${plan.status}). Non ripetere: leggi il carrello.`, 'PLAN_ALREADY_USED', { status: plan.status });
    if (Date.now() > plan.expiresAt) { this.store.finishPlan(planId, 'expired'); throw new TsunamiError('Piano scaduto: preparane uno nuovo', 'PLAN_EXPIRED'); }
    if (phrase !== plan.phrase) throw new TsunamiError('Frase di conferma errata', 'CONFIRMATION_MISMATCH');
    const before = await this.client.readCart();
    if (cartFingerprint(before) !== plan.cartFingerprint) { this.store.finishPlan(planId, 'stale'); throw new TsunamiError('Il carrello è cambiato dopo la preparazione: preparane uno nuovo', 'CART_CHANGED'); }
    if (!this.store.claimPlan(planId)) throw new TsunamiError('Piano già in esecuzione', 'PLAN_ALREADY_USED');
    let done = 0;
    try {
      for (const o of plan.ops) {
        if (o.op === 'add') await this.client.add(o.productId, o.variantId, o.quantity);
        else if (o.op === 'update') await this.client.changeQuantity(o.productId, o.variantId, o.to - o.from);
        else if (o.op === 'remove') await this.client.remove(o.productId, o.variantId);
        else if (o.op === 'voucher_apply') await this.client.addVoucher(o.code);
        else if (o.op === 'voucher_remove') await this.client.removeVoucher(o.voucherId);
        done++;
      }
    } catch (e) {
      const result = { completed: done, total: plan.ops.length, failedAt: plan.ops[done]?.op, error: e.code, message: e.message };
      // The site explicitly refused the first step: nothing was applied, the outcome is certain.
      const rejected = e.code === 'CART_REJECTED' && done === 0;
      this.store.finishPlan(planId, rejected ? 'rejected' : done ? 'partial' : 'failed_or_unknown', result);
      this.store.audit('cart_commit_error', { planId, ...result });
      if (rejected) throw new TsunamiError(`Il sito ha rifiutato l'operazione: ${e.message.replace(/\.$/, '')}. Nessuna modifica applicata.`, 'CART_REJECTED', result);
      throw new TsunamiError(`${e.message.replace(/\.$/, '')}. Esito incerto: NON ripetere, rileggi il carrello con tsunami_get_cart.`, 'COMMIT_UNCERTAIN', result);
    }
    const after = await this.client.readCart();
    const expected = expectedQuantities(before, plan.ops);
    const mismatches = [...new Set([...expected.keys(), ...after.items.map(i => i.itemKey)])]
      .map(k => ({ itemKey: k, expected: expected.get(k) ?? 0, actual: after.items.find(i => i.itemKey === k)?.quantity ?? 0 }))
      .filter(m => m.expected !== m.actual);
    const status = mismatches.length ? 'unverified' : 'committed';
    this.store.finishPlan(planId, status, { operations: done, mismatches });
    this.store.audit('cart_commit', { planId, operations: done, mismatches: mismatches.length });
    return { status, operations: done, ...(mismatches.length ? { mismatches, warning: 'Il sito non ha applicato tutto come previsto. NON ripetere: mostra il carrello all\'utente.' } : {}),
      cart: after, checkout: 'Il pagamento si fa sul sito: https://www.tsunaminutrition.it/carrello?action=show' };
  }

  status(planId) {
    const p = this.store.getPlan(planId);
    if (!p) throw new TsunamiError('Piano non trovato', 'PLAN_NOT_FOUND');
    return { planId, status: p.status, summary: p.summary, result: p.result };
  }
}

const wishlistFingerprint = lists => crypto.createHash('sha256')
  .update(JSON.stringify(lists.map(l => [l.wishlistId, l.products.map(p => p.itemKey).sort()]))).digest('hex').slice(0, 16);

/**
 * Two-phase wishlist changes (module advansedwishlist). Same contract as the cart: prepare is
 * read-only, commit runs once and verifies by reading the lists back.
 */
export class WishlistPlanner {
  constructor({ client, store, ttlMs = 15 * 60 * 1000, writesEnabled = true }) { Object.assign(this, { client, store, ttlMs, writesEnabled }); }

  async prepare(operations) {
    if (!operations?.length) throw new TsunamiError('Nessuna operazione', 'INVALID_ARGUMENT');
    const lists = await this.client.wishlists();
    const ops = [], lines = [];
    for (const op of operations) {
      if (op.op === 'add') {
        const v = await this.client.resolveVariant({ productId: op.productId, url: op.url }, op.options ?? {});
        const target = op.wishlistId ? lists.find(l => l.wishlistId === op.wishlistId) : lists[0];
        if (op.wishlistId && !target) throw new TsunamiError('Lista preferiti non trovata', 'INVALID_ARGUMENT');
        if (target?.products.some(p => p.itemKey === `${v.productId}-${v.variantId}`)) throw new TsunamiError('Prodotto già nei preferiti', 'NO_CHANGE');
        ops.push({ op: 'add', productId: v.productId, variantId: v.variantId, wishlistId: target?.wishlistId ?? 0 });
        lines.push({ action: 'aggiungi ai preferiti', name: v.name, options: v.options, list: target?.name ?? 'Preferiti (verrà creata)' });
      } else if (op.op === 'remove') {
        const l = lists.find(x => x.products.some(p => p.itemKey === op.itemKey) && (!op.wishlistId || x.wishlistId === op.wishlistId));
        if (!l) throw new TsunamiError('Prodotto non presente nei preferiti', 'ITEM_NOT_IN_WISHLIST');
        const p = l.products.find(x => x.itemKey === op.itemKey);
        ops.push({ op: 'remove', productId: p.productId, variantId: p.variantId, wishlistId: l.wishlistId });
        lines.push({ action: 'rimuovi dai preferiti', name: p.name, variant: p.variant, list: l.name });
      } else throw new TsunamiError(`Operazione sconosciuta: ${op.op}`, 'INVALID_ARGUMENT');
    }
    const plan = { id: crypto.randomUUID(), createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs, phrase: newPhrase(), cartFingerprint: `wl:${wishlistFingerprint(lists)}`, ops,
      summary: { kind: 'wishlist', lines } };
    this.store.savePlan(plan);
    this.store.audit('wishlist_prepare', { planId: plan.id, ops: ops.length });
    return { planId: plan.id, confirmationPhrase: plan.phrase, expiresAt: new Date(plan.expiresAt).toISOString(), ...plan.summary,
      instructions: 'Mostra il riepilogo all\'utente ed esegui tsunami_commit_wishlist_change solo dopo un suo OK esplicito.' };
  }

  async commit(planId, phrase) {
    if (!this.writesEnabled) throw new TsunamiError('Scritture disattivate (ALLOW_CART_WRITES=false)', 'WRITES_DISABLED');
    const plan = this.store.getPlan(planId);
    if (!plan || plan.summary.kind !== 'wishlist') throw new TsunamiError('Piano preferiti non trovato', 'PLAN_NOT_FOUND');
    if (plan.status !== 'prepared') throw new TsunamiError(`Piano già usato (stato: ${plan.status}). Non ripetere.`, 'PLAN_ALREADY_USED', { status: plan.status });
    if (Date.now() > plan.expiresAt) { this.store.finishPlan(planId, 'expired'); throw new TsunamiError('Piano scaduto: preparane uno nuovo', 'PLAN_EXPIRED'); }
    if (phrase !== plan.phrase) throw new TsunamiError('Frase di conferma errata', 'CONFIRMATION_MISMATCH');
    const before = await this.client.wishlists();
    if (`wl:${wishlistFingerprint(before)}` !== plan.cartFingerprint) { this.store.finishPlan(planId, 'stale'); throw new TsunamiError('I preferiti sono cambiati: preparane uno nuovo', 'WISHLIST_CHANGED'); }
    if (!this.store.claimPlan(planId)) throw new TsunamiError('Piano già in esecuzione', 'PLAN_ALREADY_USED');
    let done = 0;
    try {
      for (const o of plan.ops) {
        if (o.op === 'add') await this.client.wishlistAdd(o.productId, o.variantId, o.wishlistId);
        else await this.client.wishlistRemove(o.productId, o.variantId, o.wishlistId);
        done++;
      }
    } catch (e) {
      this.store.finishPlan(planId, done ? 'partial' : 'failed_or_unknown', { completed: done, error: e.code });
      throw new TsunamiError(`${e.message.replace(/\.$/, '')}. Esito incerto: NON ripetere, rileggi con tsunami_wishlist.`, 'COMMIT_UNCERTAIN', { completed: done });
    }
    const after = await this.client.wishlists();
    const has = k => after.some(l => l.products.some(p => p.itemKey === k));
    const mismatches = plan.ops.filter(o => (o.op === 'add') !== has(`${o.productId}-${o.variantId}`)).map(o => ({ op: o.op, itemKey: `${o.productId}-${o.variantId}` }));
    const status = mismatches.length ? 'unverified' : 'committed';
    this.store.finishPlan(planId, status, { operations: done, mismatches });
    return { status, operations: done, ...(mismatches.length ? { mismatches } : {}), wishlists: after };
  }
}
