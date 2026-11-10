import { computeCod } from '../money';
import { basketDiscount, type ResolvedLine } from '../public-order';
import type { AliasRow } from './aliases';

/**
 * TWO TELEGRAM MESSAGES, ONE ORDER — THE YOUCAN UPSELL.
 *
 * The owner, 10/11: «YouCan upsell orders arrive as TWO Telegram messages with the SAME رقم الطلب. In BOTH messages السعر = the
 * full order total.» The first is the base order (a real offer of a real product); the second names the upsell («كورس طنين:
 * عبوتين إضافيات 🎁», an UPSELL alias, `aliases.ts`) and adds its units for its price. Until now the base waited with
 * «السعر المكتوب مش سعر العرض» and the upsell with «المنتج مش موجود».
 *
 * THE RULE (his words: «Total = السعر in the message (never sum the two)» and «a base line whose price is above the offer price is
 * valid only when an upsell message with the same number exists and offer price + upsell price = السعر»):
 *
 *   · the two readings agree on the phone (the door pairs only those) and on the written «السعر»;
 *   · the upsell line is `extraUnits × count` units for `linePrice × count`, `count` = the upsell message's «الكمية» (1..20);
 *   · the ONE calculator (`computeCod`) over [the base line the offer priced, the upsell line] — the base offer's own reduction
 *     only (`basketDiscount`; the upsell line has no offer and no gift) — must come to EXACTLY the written «السعر». That figure is
 *     the order's total; the two written prices are never added.
 *
 * PURE. The door (`inbound.ts`) finds the two messages and prices the base line; this decides whether they are one order.
 */

/** How long the first message of a pair waits for the second, live. */
export const UPSELL_HOLD_MS = 10 * 60 * 1000;
/** How far apart two held messages may be for the dry-run («دمج الأب سيل — تجربة») to pair them after the fact. */
export const UPSELL_RETRO_MS = 60 * 60 * 1000;
/** The most «الكمية» an upsell message may say. */
export const UPSELL_COUNT_MAX = 20;

/**
 * Why two messages that share a number are not one order. Each has its Arabic sentence in `review-reasons.ts`
 * (`review-reasons.test.ts` reads this list).
 */
export type PairRefusal =
  | 'WAITING_FOR_UPSELL'
  | 'WAITING_FOR_BASE'
  | 'UPSELL_WITHOUT_BASE'
  | 'UPSELL_BASE_REFUSED'
  | 'UPSELL_PRICE_MISMATCH'
  | 'UPSELL_PAIR_MISMATCH'
  | 'UPSELL_PAIR_AMBIGUOUS'
  | 'UPSELL_PRODUCT_UNAVAILABLE'
  | 'UPSELL_QUANTITY_INVALID'
  | 'ALIAS_PRODUCT_UNAVAILABLE';

/** The moment a message stops waiting for its partner. */
export function holdUntil(createdAt: Date): Date {
  return new Date(createdAt.getTime() + UPSELL_HOLD_MS);
}

/** The until-time a held message carries in its reason (`WAITING_FOR_…:<ISO>`), or null when the reason is not a hold. */
export function heldUntil(reviewReason: string | null | undefined): Date | null {
  const m = /^WAITING_FOR_(?:UPSELL|BASE):(.+)$/.exec(reviewReason ?? '');
  if (!m) return null;
  const at = new Date(m[1]);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The upsell's line, as a line of the order: no offer, no gift, the price spread over its units (unrounded, like an offer's). */
export function upsellLine(
  alias: Pick<AliasRow, 'extraUnits' | 'linePrice'>,
  count: number,
  product: ResolvedLine['product']
): ResolvedLine | null {
  const per = alias.extraUnits ?? 0;
  const price = alias.linePrice ?? 0;
  if (!Number.isInteger(count) || count < 1 || count > UPSELL_COUNT_MAX) return null;
  if (!Number.isInteger(per) || per < 1 || !(price > 0)) return null;
  const units = per * count;
  const amount = price * count;
  return { product, offer: null, quantity: units, freeQuantity: 0, unitPrice: amount / units, offerDiscount: 0 };
}

/** The money of one order made of several lines — the one calculator, the offers' own reductions once each. */
export function priceLines(lines: readonly ResolvedLine[], minorUnit: number) {
  return computeCod({
    lines: lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, freeQuantity: l.freeQuantity })),
    discount: basketDiscount([...lines]),
    minorUnit,
  });
}

export interface PairInput {
  base: { written: number; phoneKey: string; line: ResolvedLine };
  upsell: { written: number; phoneKey: string; count: number; alias: Pick<AliasRow, 'extraUnits' | 'linePrice'>; product: ResolvedLine['product'] };
  minorUnit: number;
}

export type PairVerdict =
  | { ok: true; lines: [ResolvedLine, ResolvedLine]; total: number; units: number }
  | { ok: false; reason: string };

/** The verdict on two messages the door has already paired by source, number and phone. */
export function judgePair({ base, upsell, minorUnit }: PairInput): PairVerdict {
  if (base.phoneKey !== upsell.phoneKey) return { ok: false, reason: 'UPSELL_PAIR_MISMATCH' };
  if (base.written !== upsell.written) return { ok: false, reason: 'UPSELL_PAIR_MISMATCH' };
  const extra = upsellLine(upsell.alias, upsell.count, upsell.product);
  if (!extra) return { ok: false, reason: 'UPSELL_QUANTITY_INVALID' };
  const money = priceLines([base.line, extra], minorUnit);
  if (money.cod !== base.written) return { ok: false, reason: `UPSELL_PRICE_MISMATCH:${money.cod.toFixed(minorUnit)}` };
  return {
    ok: true,
    lines: [base.line, extra],
    total: money.cod,
    units: base.line.quantity + base.line.freeQuantity + extra.quantity,
  };
}
