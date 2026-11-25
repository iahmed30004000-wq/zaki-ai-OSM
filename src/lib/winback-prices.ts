import { updateCompanySettings } from './company-settings';
import { db } from './db';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE WIN-BACK PRICE OF A PRODUCT — what a cancelled order is offered again at, set by the owner per product.
 *
 * Where it lives: `Company.settings.winbackPrices`, one entry per product id — `{ one, three, currency }`. No column and no migration,
 * the same home as the win-back rule beside it (`winback-rule.ts`), written under the same row lock. Nothing is guessed: a product with
 * no entry is NOT offered by the bulk run, and no product is priced by its name — the owner types each figure on the screen (the local
 * seed carries the demo figures).
 *
 * WHAT THE FIGURE IS. The order's TOTAL, delivery included — nothing is added on top of it. Two tiers, picked by the pieces the cancelled
 * order carried (its paid units AND its free ones, the pieces that reach the customer): three or more is the three-piece price, one or two
 * is the one-piece price. An order of two different products has no single price and is not offered.
 *
 * The figure is computed by the SERVER from this setting and nothing else; a price in a request body is never read. It is the only
 * discount exempt from the rule's ceiling (`maxDiscountShare`): the owner set it himself, per product — a person's typed discount
 * still stops at the ceiling, as before.
 *
 * This file is pure except the two last functions (the read and the save).
 * ═══════════════════════════════════════════════════════════════════════
 */

export interface WinbackPrice {
  /** The total for an order of one or two pieces. */
  one: number;
  /** The total for an order of three pieces or more. */
  three: number;
  /** The currency both figures are in. An order in another currency is not offered at them. */
  currency: string;
}

export type WinbackPrices = Readonly<Record<string, WinbackPrice>>;

/** The pieces from which the three-piece price applies. */
export const THREE_PIECES = 3;
/**
 * PENDING THE OWNER'S RULING (F12 review, 25/11): until he says what an order of four pieces or more is offered at, only orders of one
 * to three pieces in total (paid + free) are offered at all — the rest are skipped by name (`TOO_MANY_PIECES`). The tiers are unchanged.
 */
export const MAX_PIECES_OFFERED = 3;
export const PRICE_MAX = 1_000_000;

const CURRENCY = /^[A-Z]{3}$/;
const isPrice = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= PRICE_MAX;

/** A stored document, as this build understands it: an entry that is not whole is dropped, never half-read. */
export function parseWinbackPrices(raw: unknown): WinbackPrices {
  const out: Record<string, WinbackPrice> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [productId, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    if (isPrice(e.one) && isPrice(e.three) && typeof e.currency === 'string' && CURRENCY.test(e.currency)) {
      out[productId] = { one: e.one, three: e.three, currency: e.currency };
    }
  }
  return out;
}

export type PriceInput =
  | { ok: true; productId: string; price: WinbackPrice | null }
  | { ok: false; code: string; errorAr: string };

/**
 * WHAT THE EDITOR SENDS: one product at a time — `{ productId, one, three, currency }` to set it, `{ productId, remove: true }` to take
 * the product out of the bulk run. Refused rather than clamped, in Arabic, like the rule's editor.
 */
export function validateWinbackPrice(input: unknown): PriceInput {
  const refuse = (code: string, errorAr: string): PriceInput => ({ ok: false, code, errorAr });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refuse('BAD_BODY', 'الطلب غير صالح');
  const o = input as Record<string, unknown>;
  const known = new Set(['productId', 'one', 'three', 'currency', 'remove']);
  const stray = Object.keys(o).find((k) => !known.has(k));
  if (stray) return refuse('UNKNOWN_FIELD', `حقل مش معروف: ${stray}`);
  if (typeof o.productId !== 'string' || o.productId.length === 0 || o.productId.length > 64) return refuse('PRODUCT', 'حدّد المنتج');
  if (o.remove === true) return { ok: true, productId: o.productId, price: null };
  if (!isPrice(o.one)) return refuse('ONE', `سعر القطعة الوحدة: رقم أكبر من 0 لحد ${PRICE_MAX}`);
  if (!isPrice(o.three)) return refuse('THREE', `سعر الثلاث قطع: رقم أكبر من 0 لحد ${PRICE_MAX}`);
  if (typeof o.currency !== 'string' || !CURRENCY.test(o.currency)) return refuse('CURRENCY', 'العملة: ثلاث أحرف متل USD');
  return { ok: true, productId: o.productId, price: { one: o.one, three: o.three, currency: o.currency } };
}

export type PriceVerdict =
  | { ok: true; price: number; tier: 'one' | 'three'; productId: string; pieces: number }
  | { ok: false; code: 'MIXED_PRODUCTS' | 'NO_WINBACK_PRICE' | 'CURRENCY_MISMATCH' | 'NO_LINES' | 'TOO_MANY_PIECES' };

/**
 * THE PRICE OF ONE CANCELLED ORDER — or why it has none. `lines` are its goods as the creator copies them (its own lines, or its single
 * product columns when it has none).
 */
export function winbackPriceFor(
  lines: ReadonlyArray<{ productId: string; quantity: number; freeQuantity?: number | null }>,
  prices: WinbackPrices,
  currency: string
): PriceVerdict {
  if (lines.length === 0) return { ok: false, code: 'NO_LINES' };
  const products = new Set(lines.map((l) => l.productId));
  if (products.size !== 1) return { ok: false, code: 'MIXED_PRODUCTS' };
  const productId = lines[0].productId;
  const entry = Object.prototype.hasOwnProperty.call(prices, productId) ? prices[productId] : undefined;
  if (!entry) return { ok: false, code: 'NO_WINBACK_PRICE' };
  if (entry.currency !== currency) return { ok: false, code: 'CURRENCY_MISMATCH' };
  const pieces = lines.reduce((s, l) => s + Math.max(0, l.quantity) + Math.max(0, l.freeQuantity ?? 0), 0);
  if (pieces > MAX_PIECES_OFFERED) return { ok: false, code: 'TOO_MANY_PIECES' };
  const tier = pieces >= THREE_PIECES ? 'three' : 'one';
  return { ok: true, price: entry[tier], tier, productId, pieces };
}

/** The company's prices. A missing key or a broken document is «no product is priced» — never a throw on the screen. */
export async function readWinbackPrices(companyId: string): Promise<WinbackPrices> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  try {
    return parseWinbackPrices((company?.settings ? JSON.parse(company.settings) : {}).winbackPrices);
  } catch {
    return {};
  }
}

/** One product's entry set or removed — only this key, under the settings row lock. */
export async function saveWinbackPrice(companyId: string, productId: string, price: WinbackPrice | null): Promise<WinbackPrices> {
  const next = await updateCompanySettings<Record<string, WinbackPrice>>(companyId, 'winbackPrices', (current) => {
    const all: Record<string, WinbackPrice> = { ...parseWinbackPrices(current) };
    if (price) all[productId] = { ...price };
    else delete all[productId];
    return all;
  });
  return parseWinbackPrices(next);
}
