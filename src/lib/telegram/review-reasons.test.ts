import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '../guard-source';
import { REVIEW_REASONS, reviewReason, reviewReasonText } from './review-reasons';

/**
 * EVERY CODE THE DOOR CAN WRITE HAS AN ARABIC SENTENCE — FOUND BY READING THE DOOR, NOT BY TRUSTING A LIST.
 *
 * The old screen kept its own map and it had gone short: NO_STORE and CUSTOMER_BLOCKED printed as English codes on the
 * row somebody had to act on. So the codes are collected from where they are WRITTEN — every `review('…')` in the door,
 * every refusal the line reader can return, every reason the order creator can give back — and each must be in the map.
 */

const door = stripComments(repoFile('src/lib/telegram/inbound.ts'));
const parser = stripComments(repoFile('src/lib/telegram/parser.ts'));
const creator = stripComments(repoFile('src/lib/telegram/order-creation.ts'));

const reviewed = [...door.matchAll(/review\('([A-Z_]+)'\)/g)].map((m) => m[1]);
const refusals = (() => {
  const union = parser.slice(parser.indexOf('export type LineRoleRefusal'));
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
    expect(reviewed.length).toBeGreaterThanOrEqual(15);
    expect(refusals).toContain('OFFER_UNREADABLE');
    expect(created).toContain('NO_SYSTEM_ACTOR');
    expect(written).toEqual(expect.arrayContaining(['NO_STORE', 'CUSTOMER_BLOCKED', 'DUPLICATE_REF', 'PRODUCT_GUESSED']));
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
  it('names the line for his format, and only for his format', () => {
    expect(reviewReasonText('INVALID_PHONE', { lines: true })).toBe('السطر 4: رقم الهاتف مش صالح');
    expect(reviewReasonText('INVALID_PHONE')).toBe('رقم الهاتف مش صالح');
    expect(reviewReasonText('NO_STORE', { lines: true })).toBe('المجموعة مش مربوطة بمتجر');
  });

  it('says how many lines a message had when that is the reason', () => {
    expect(reviewReasonText('LINE_COUNT', { lines: true, lineCount: 6 })).toBe(
      'عدد أسطر الرسالة 6، والمطلوب 7: مرجع، تاريخ، عميل، هاتف، محافظة، منتج، عرض'
    );
  });

  it('never prints a code, even one no door wrote', () => {
    expect(reviewReasonText('SOMETHING_NEW')).toBe('سبب ما منعرفه');
    expect(reviewReason('SOMETHING_NEW')?.retry).toBe(true);
    expect(reviewReasonText(null)).toBe('');
  });

  it('offers «إعادة المعالجة» only where it can change the answer', () => {
    // The catalogue, the store, the blacklist, the store's currency and a failure may change; the text never does.
    for (const code of ['PRODUCT_NOT_FOUND', 'AMBIGUOUS_PRODUCT', 'PRODUCT_GUESSED', 'NO_STORE', 'CUSTOMER_BLOCKED', 'CURRENCY_MISMATCH', 'CREATION_FAILED']) {
      expect(reviewReason(code)?.retry, code).toBe(true);
    }
    for (const code of ['LINE_COUNT', 'BAD_DATE', 'MISSING_CUSTOMER_NAME', 'INVALID_PHONE', 'OFFER_UNREADABLE', 'MISSING_PRICE', 'DUPLICATE_REF']) {
      expect(reviewReason(code)?.retry, code).toBe(false);
    }
  });
});
