import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '../guard-source';
import { REVIEW_REASONS, reviewReason, reviewReasonText } from './review-reasons';

/**
 * EVERY CODE THE DOOR CAN WRITE HAS AN ARABIC SENTENCE — FOUND BY READING THE DOOR, NOT BY TRUSTING A LIST.
 *
 * The old screen kept its own map and it had gone short: NO_STORE and CUSTOMER_BLOCKED printed as English codes on the
 * row somebody had to act on. So the codes are collected from where they are WRITTEN — every `review('…')` and `ignore('…')` in the
 * door, every refusal the labeled reader can return, every reason the order creator can give back — and each must be in the map.
 */

const door = stripComments(repoFile('src/lib/telegram/inbound.ts'));
const reader = stripComments(repoFile('src/lib/telegram/labeled-order.ts'));
const creator = stripComments(repoFile('src/lib/telegram/order-creation.ts'));

// `review('…')` sends a message to a person; `ignore('…')` sets it aside. Both write a code a person may read — and a code
// that carries a detail is written as a template, `review(`PRICE_MISMATCH:${…}`)`: the code before the colon is the one.
const reviewed = [...door.matchAll(/(?:review|ignore)\((?:'([A-Z_]+)'\)|`([A-Z_]+):)/g)].map((m) => m[1] ?? m[2]);
const refusals = (() => {
  const union = reader.slice(reader.indexOf('export type LabeledRefusal'));
  return [...union.slice(0, union.indexOf(';')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
})();
const created = (() => {
  const result = creator.slice(creator.indexOf('export type CreateTelegramOrderResult'));
  return [...result.slice(0, result.indexOf('};')).matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
})();
// ALREADY_LINKED is never shown: the door turns it into PROCESSED, by the order the other press made.
const written = [...new Set([...reviewed, ...refusals, ...created.filter((c) => c !== 'ALREADY_LINKED')])];

describe('the codes the door writes', () => {
  it('are found at all — a sweep over nothing proves nothing', () => {
    expect(reviewed.length).toBeGreaterThanOrEqual(8);
    expect(refusals.length).toBeGreaterThanOrEqual(25);
    expect(reviewed).toEqual(expect.arrayContaining(['OFFER_NOT_FOUND', 'OFFER_AMBIGUOUS', 'QUANTITY_NOT_OFFER', 'PRICE_MISMATCH']));
    expect(refusals).toContain('MISSING_PHONE');
    expect(created).toContain('NO_SYSTEM_ACTOR');
    expect(written).toEqual(
      expect.arrayContaining(['NO_STORE', 'CUSTOMER_BLOCKED', 'DUPLICATE_ORDER', 'PRODUCT_GUESSED', 'NOT_IN_FORMAT', 'MISSING_PHONE'])
    );
  });

  it.each(written)('%s has a sentence in Arabic', (code) => {
    const reason = (REVIEW_REASONS as Record<string, { text: string }>)[code];
    expect(reason, `${code} بلا جملة عربية`).toBeDefined();
    expect(reason.text).toMatch(/[؀-ۿ]/);
    expect(reason.text, `${code}: حرف لاتيني`).not.toMatch(/[A-Za-z]/);
  });

  it('and the map keeps nothing the door no longer writes, but the two the screen itself needs', () => {
    const extra = Object.keys(REVIEW_REASONS).filter((k) => !written.includes(k));
    expect(extra.sort()).toEqual(['NOT_FOUND', 'PROCESSING_ERROR']);
  });
});

describe('what a person reads', () => {
  it('names the field: «ناقص: …» for a label that is absent or empty, «مكرر: …» for one that stands twice', () => {
    expect(reviewReasonText('MISSING_PHONE')).toBe('ناقص: رقم الهاتف');
    expect(reviewReasonText('MISSING_QUANTITY')).toBe('ناقص: الكمية');
    expect(reviewReasonText('REPEATED_ADDRESS')).toBe('مكرر: عنوان العميل');
    for (const code of refusals.filter((c) => c.startsWith('MISSING_') && c !== 'MISSING_PRICE')) {
      expect(reviewReasonText(code), code).toMatch(/^ناقص: /);
    }
    for (const code of refusals.filter((c) => c.startsWith('REPEATED_'))) {
      expect(reviewReasonText(code), code).toMatch(/^مكرر: /);
    }
  });

  it('says the message is not in the format, in his words', () => {
    expect(reviewReasonText('NOT_IN_FORMAT')).toBe('الرسالة مش بصيغة الطلب');
    expect(reviewReasonText('DUPLICATE_ORDER')).toBe('نفس الزبون والمنتج والوقت صار طلب');
  });

  it('says the phone as the seller wrote it, and the price the offer really costs', () => {
    expect(reviewReasonText('INVALID_PHONE:12')).toBe('رقم الهاتف مش صالح: 12');
    expect(reviewReasonText('INVALID_PHONE')).toBe('رقم الهاتف مش صالح');
    expect(reviewReasonText('PRICE_MISMATCH:25.00')).toBe('السعر المكتوب مش سعر العرض (25.00)');
    expect(reviewReasonText('OFFER_NOT_FOUND')).toBe('ما لقيت عرض بهالاسم عند المنتج');
    expect(reviewReasonText('OFFER_AMBIGUOUS')).toBe('أكتر من عرض بنفس الاسم');
    expect(reviewReasonText('QUANTITY_NOT_OFFER')).toBe('الكمية ما بتطابق قطع العرض');
    // A detail on a code that takes none changes nothing, and a code nobody wrote is still said in Arabic.
    expect(reviewReasonText('NO_STORE:x')).toBe('المجموعة مش مربوطة بمتجر');
    expect(reviewReasonText('SOMETHING_NEW:x')).toBe('سبب ما منعرفه');
  });

  it('marks the cell the field lives in', () => {
    expect(reviewReason('INVALID_PHONE')?.field).toBe('phone');
    expect(reviewReason('INVALID_PHONE:12')?.field).toBe('phone');
    expect(reviewReason('OFFER_NOT_FOUND')?.field).toBe('offer');
    expect(reviewReason('PRICE_MISMATCH:25.00')?.field).toBe('priceQuantity');
    expect(reviewReason('MISSING_QUANTITY')?.field).toBe('priceQuantity');
    expect(reviewReason('PRODUCT_NOT_FOUND')?.field).toBe('product');
    expect(reviewReason('NO_STORE')?.field).toBeUndefined();
  });

  it('never prints a code, even one no door wrote', () => {
    expect(reviewReasonText('SOMETHING_NEW')).toBe('سبب ما منعرفه');
    expect(reviewReason('SOMETHING_NEW')?.retry).toBe(true);
    expect(reviewReasonText(null)).toBe('');
  });

  it('offers «إعادة المعالجة» only where it can change the answer', () => {
    // The catalogue, the store, the blacklist, the store's currency and a failure may change; the text never does.
    for (const code of ['PRODUCT_NOT_FOUND', 'AMBIGUOUS_PRODUCT', 'PRODUCT_GUESSED', 'NO_STORE', 'CUSTOMER_BLOCKED', 'CURRENCY_MISMATCH', 'CREATION_FAILED', 'OFFER_NOT_FOUND', 'OFFER_AMBIGUOUS', 'PRICE_MISMATCH', 'QUANTITY_NOT_OFFER']) {
      expect(reviewReason(code)?.retry, code).toBe(true);
    }
    for (const code of ['MISSING_PHONE', 'REPEATED_PRICE', 'STRAY_LINE', 'BAD_DATE', 'INVALID_PHONE', 'INVALID_QUANTITY', 'MISSING_PRICE', 'DUPLICATE_ORDER', 'NOT_IN_FORMAT']) {
      expect(reviewReason(code)?.retry, code).toBe(false);
    }
  });
});
