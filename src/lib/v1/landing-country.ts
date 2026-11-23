import { db } from '../db';
import { V1_CODE, V1Fault } from './door';
import type { SystemCaller, SystemTokenOptions } from './system-token';
import type { LandingCartInput, CartRefusal } from './landing-carts';
import type { RelayInput } from './landing-chat-inbox';

/**
 * ONE COUNTRY PER LANDING KEY (2026-11-21) — every country rule of the landing door, in one place.
 *
 * Zaki Pages runs per country, each country linked to this system with its own key. A key may now be bound to one country
 * of its company (`SystemToken.countryId`); a key that is not (every key made before) sees every country, exactly as before,
 * and NOTHING here reads the database for it — each helper returns at once when the caller has no country.
 *
 * ── WHAT A COUNTRY-BOUND KEY SEES ──
 *
 *   · products — only those of its country's stores; another country's product is answered EXACTLY as a product that does
 *     not exist (404 «No such product» on the one-product read, 409 «هذا العرض لم يعد متاحًا» on the quote and the order);
 *   · geo — only its own country's cities; another code is 404 «No such country», as an unknown code is;
 *   · an order, by number — only one of its country; another country's is 404 «No such order», as an unknown number is;
 *   · carts — written with its country; a body naming another country is the cart's own 400 sentence, another country's
 *     product is taken as an unknown product (kept by name, not linked), another country's cart is 404 «No such abandoned
 *     cart», and another country's order is not linked to a recovered cart;
 *   · chat — threads it opens carry its country; another country's thread is 404, another country's order or product is
 *     not linked; `/chat/updates` lists its own country's threads only.
 *
 * ── AND ONE STORE PER LANDING KEY (2026-11-23) ──
 *
 * Zaki Pages may run several independent stores in one country, each linked with its own key. A key may be bound to one
 * store (`SystemToken.storeId`); such a key always carries that store's country as well, so every rule above holds for
 * it, and each one also keeps it to its store: products of its store only, orders of its store only, carts whose product
 * is another store's are unknown, and chat threads it did not open itself are unknown. Its idempotency keys are its own.
 *
 * Every refusal is the door's existing answer for «there is no such thing», so a key learns nothing about another country.
 * The idempotency ledger is per company: a bound key's keys are kept apart (`idempotencySlot`), so a replay never hands one
 * country the answer given to another.
 */

/** What every landing route asks `requireSystemToken` with: this door keeps a bound key to its country. */
export const LANDING_DOOR: SystemTokenOptions = { countryAware: true };

/**
 * The part of the caller this file reads. `countryId` absent or null: every country, as before. `storeId` (2026-11-23,
 * Zaki Pages per store): the one store of that country the key sees — a store-bound key always carries its store's
 * country too (the key is made so, `settings/system-tokens`), so every country rule below holds for it, and each one
 * also keeps it to its store.
 */
export type LandingCaller = Pick<SystemCaller, 'companyId'> & { countryId?: string | null; storeId?: string | null };

/**
 * What a landing read is kept to: a country, a store of it, or nothing. The door's functions take it (or, as before, a
 * bare country id) so a route hands on `scopeOf(caller)` and every product query is narrowed in one place.
 */
export interface LandingScope { countryId: string | null; storeId?: string | null }
export type LandingScopeArg = LandingScope | string | null | undefined;

/** The scope of a caller — what a route hands to the door's functions. */
export const scopeOf = (caller: LandingCaller): LandingScope => ({ countryId: caller.countryId ?? null, storeId: caller.storeId ?? null });

const asScope = (s: LandingScopeArg): LandingScope => (typeof s === 'string' ? { countryId: s } : s ?? { countryId: null });

const bound = (caller: LandingCaller): string | null => caller.countryId ?? null;
const boundStore = (caller: LandingCaller): string | null => caller.storeId ?? null;

/** A product's `where`, kept to the key's country (and store) — `{}` for a key of every country. */
export function productsInCountry(scope: LandingScopeArg): { AND?: { store: { countryId?: string; id?: string } }[] } {
  const { countryId, storeId } = asScope(scope);
  if (!countryId && !storeId) return {};
  return { AND: [{ store: { ...(countryId ? { countryId } : {}), ...(storeId ? { id: storeId } : {}) } }] };
}

/**
 * The `Idempotency-Key` as the ledger stores it: a bound key's are its country's own (a store key's, its store's own),
 * a key of every country's unchanged.
 */
export function idempotencySlot(caller: LandingCaller, key: string): string {
  const c = bound(caller);
  const s = boundStore(caller);
  return s ? `${c ?? ''}:${s}:${key}` : c ? `${c}:${key}` : key;
}

/** The ISO code of the key's country; a country that is gone answers as nothing at all. */
async function codeOf(caller: LandingCaller & { countryId: string }): Promise<string> {
  const row = await db.country.findFirst({ where: { id: caller.countryId, companyId: caller.companyId }, select: { code: true } });
  if (!row) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such country');
  return row.code.toUpperCase();
}

/** The country an order belongs to: its own, else its store's — and its store. */
async function orderCountry(companyId: string, orderNumber: string): Promise<{ found: boolean; countryId: string | null; storeId: string | null }> {
  const o = await db.order.findFirst({
    where: { companyId, orderNumber },
    select: { countryId: true, storeId: true, store: { select: { countryId: true } } },
  });
  return { found: !!o, countryId: o ? (o.countryId ?? o.store?.countryId ?? null) : null, storeId: o?.storeId ?? null };
}

/** Is this order outside the key's country or store? */
const otherOrder = (caller: LandingCaller, o: { countryId: string | null; storeId: string | null }): boolean => {
  const c = bound(caller);
  const s = boundStore(caller);
  return (!!c && o.countryId !== c) || (!!s && o.storeId !== s);
};

/**
 * GEO: a bound key asks for its own country's cities only. Another code answers as a code this company does not have.
 */
export async function requireCountryCode(caller: LandingCaller, code: string): Promise<void> {
  const c = bound(caller);
  if (!c) return;
  if ((await codeOf({ ...caller, countryId: c })) !== code.toUpperCase()) {
    throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such country');
  }
}

/**
 * AN ORDER BY NUMBER: a bound key reaches only its own country's. Another country's answers as an unknown number; an
 * unknown number is left to the door's own answer, so nothing differs.
 */
export async function requireOrderInCountry(caller: LandingCaller, orderNumber: string): Promise<void> {
  if (!bound(caller) && !boundStore(caller)) return;
  const o = await orderCountry(caller.companyId, orderNumber);
  if (o.found && otherOrder(caller, o)) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such order');
}

/** The order number when it is the key's country's, else null — for a link that is written only when it fits. */
export async function orderNumberInCountry(caller: LandingCaller, orderNumber: string | null): Promise<string | null> {
  if ((!bound(caller) && !boundStore(caller)) || !orderNumber) return orderNumber;
  const o = await orderCountry(caller.companyId, orderNumber);
  return o.found && otherOrder(caller, o) ? null : orderNumber;
}

/**
 * The product id when it is the key's country's — and store's, for a store key — (or not this company's at all), else
 * null: another country's or store's is unknown.
 */
async function productIdInCountry(caller: LandingCaller & { countryId: string }, productId: string | null): Promise<string | null> {
  if (!productId) return productId;
  const p = await db.product.findFirst({
    where: { companyId: caller.companyId, id: productId },
    select: { storeId: true, store: { select: { countryId: true } } },
  });
  const s = boundStore(caller);
  return p && (p.store?.countryId !== caller.countryId || (!!s && p.storeId !== s)) ? null : productId;
}

/**
 * The cart Zaki pages names, own or folded in as an alias, its country code, and the store of its product (a cart has no
 * store of its own: a store key links only its own store's products, so a cart's product names the store it came from).
 */
async function cartCountry(companyId: string, externalId: string): Promise<{ found: boolean; country: string | null; storeId: string | null }> {
  const pick = { country: true, product: { select: { storeId: true } } } as const;
  const own = await db.abandonedCart.findUnique({
    where: { companyId_externalId: { companyId, externalId } },
    select: pick,
  });
  if (own) return { found: true, country: own.country, storeId: own.product?.storeId ?? null };
  const alias = await db.abandonedCartAlias.findUnique({
    where: { companyId_externalId: { companyId, externalId } },
    select: { cart: { select: pick } },
  });
  return alias ? { found: true, country: alias.cart.country, storeId: alias.cart.product?.storeId ?? null } : { found: false, country: null, storeId: null };
}

/** The cart's sentence when its body names another country than the key's. */
export const CART_OTHER_COUNTRY_AR = 'السلة لبلد غير بلد هذا المفتاح.';

/**
 * A CART FROM A BOUND KEY: written with the key's country. A body naming another country is refused with the cart's own
 * 400 sentence (Zaki pages must not send it again); another country's product is taken as an unknown one; another
 * country's cart, by `externalId`, is 404 «No such abandoned cart».
 */
export async function cartInCountry(caller: LandingCaller, input: LandingCartInput): Promise<{ ok: true; data: LandingCartInput } | CartRefusal> {
  const c = bound(caller);
  if (!c) return { ok: true, data: input };
  const scoped = { ...caller, countryId: c };
  const code = await codeOf(scoped);
  if (input.country && input.country.toUpperCase() !== code) {
    return { ok: false, status: 400, body: { error: CART_OTHER_COUNTRY_AR } };
  }
  await requireCartInCountry(caller, input.externalId, code);
  return { ok: true, data: { ...input, country: code, productId: await productIdInCountry(scoped, input.productId) } };
}

/** A cart named by `externalId`, for a bound key: only one of its country; another's answers as an unknown cart. */
export async function requireCartInCountry(caller: LandingCaller, externalId: string, knownCode?: string): Promise<void> {
  const c = bound(caller);
  if (!c) return;
  const cart = await cartCountry(caller.companyId, externalId);
  if (!cart.found) return;
  const code = knownCode ?? (await codeOf({ ...caller, countryId: c }));
  if ((cart.country ?? '').toUpperCase() !== code) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such abandoned cart');
  // A store key: a cart whose product is another store's answers as an unknown cart too.
  const s = boundStore(caller);
  if (s && cart.storeId && cart.storeId !== s) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such abandoned cart');
}

/**
 * A CHAT RELAY FROM A BOUND KEY: another country's thread is 404; another country's order or product is not linked (the
 * thread keeps the names the page sent). The thread it opens carries the key's country — `relayChatLines`' `countryId`.
 */
export async function relayInCountry(caller: LandingCaller, input: RelayInput): Promise<RelayInput> {
  const c = bound(caller);
  if (!c) return input;
  const thread = await db.landingChatThread.findUnique({
    where: { companyId_externalId: { companyId: caller.companyId, externalId: input.sessionId } },
    select: { countryId: true, storeId: true },
  });
  if (thread && thread.countryId !== c) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such chat thread');
  // A store key: only the threads it opened itself (a thread of the country's other keys is not its).
  const s = boundStore(caller);
  if (thread && s && thread.storeId !== s) throw new V1Fault(404, V1_CODE.NOT_FOUND, 'No such chat thread');
  return {
    ...input,
    orderNumber: await orderNumberInCountry(caller, input.orderNumber),
    productId: await productIdInCountry({ ...caller, countryId: c }, input.productId),
  };
}

/**
 * THE STORES A LANDING KEY SEES (2026-11-23): what Zaki Pages offers when the owner adds a country or a store there â€” the
 * company's real stores (never a test bench), kept to the key's country, and to its one store for a store-bound key.
 * Each with its country and that country's currency, so the page system shows the same money the orders will carry.
 */
export async function landingStores(caller: LandingCaller) {
  const c = bound(caller);
  const s = boundStore(caller);
  const rows = await db.store.findMany({
    where: { companyId: caller.companyId, isTest: false, ...(c ? { countryId: c } : {}), ...(s ? { id: s } : {}) },
    orderBy: [{ name: 'asc' }],
    select: { id: true, name: true, status: true, country: { select: { code: true, name: true, currencyCode: true, minorUnit: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    active: r.status === 'ACTIVE',
    country: r.country.code.toUpperCase(),
    countryName: r.country.name,
    currency: r.country.currencyCode,
    minorUnit: r.country.minorUnit,
  }));
}
