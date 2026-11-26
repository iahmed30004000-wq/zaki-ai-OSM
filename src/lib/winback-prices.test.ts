import { describe, expect, it } from 'vitest';
import { isPieces, parseWinbackPrices, priceOf, validateWinbackPrice, winbackPriceFor, winbackUnitCost } from './winback-prices';

/** The owner's win-back price per product (F12): the tier, the refusals, and nothing guessed. */

const PRICES = parseWinbackPrices({
  scar: { one: 12, three: 20, currency: 'USD' },
  truffle: { one: 10, three: 20, currency: 'USD' },
});
const line = (productId: string, quantity: number, freeQuantity = 0) => ({ productId, quantity, freeQuantity });

describe('the price of one cancelled order — the owner’s two options (25/11, «1 modified»)', () => {
  it('EVERY old quantity is offered at the 3-piece option and the triple price — 1, 2, 3 and 6 pieces alike', () => {
    for (const q of [1, 2, 3, 6]) {
      expect(winbackPriceFor([line('scar', q)], PRICES, 'USD'), String(q)).toMatchObject({ ok: true, pieces: 3, price: 20, oldPieces: q });
    }
    expect(winbackPriceFor([line('truffle', 1)], PRICES, 'USD')).toMatchObject({ ok: true, pieces: 3, price: 20 });
  });

  it('the old quantity (paid + free) is information only', () => {
    expect(winbackPriceFor([line('truffle', 2, 1)], PRICES, 'USD')).toMatchObject({ ok: true, oldPieces: 3, pieces: 3, price: 20 });
  });

  it('the two options read the setting: 1 piece = the single price, 3 = the triple', () => {
    expect(priceOf(PRICES.scar, 1)).toBe(12);
    expect(priceOf(PRICES.scar, 3)).toBe(20);
    expect(priceOf(PRICES.truffle, 1)).toBe(10);
    expect(isPieces(1) && isPieces(3)).toBe(true);
    for (const n of [0, 2, 4, '3', null]) expect(isPieces(n), String(n)).toBe(false);
  });

  it('two lines of the same product are one product', () => {
    expect(winbackPriceFor([line('scar', 1), line('scar', 2)], PRICES, 'USD')).toMatchObject({ ok: true, price: 20, oldPieces: 3 });
  });

  it('two different products are not offered', () => {
    expect(winbackPriceFor([line('scar', 1), line('truffle', 1)], PRICES, 'USD')).toEqual({ ok: false, code: 'MIXED_PRODUCTS' });
  });

  it('a product with no win-back price is not offered', () => {
    expect(winbackPriceFor([line('soap', 1)], PRICES, 'USD')).toEqual({ ok: false, code: 'NO_WINBACK_PRICE' });
    expect(winbackPriceFor([line('toString', 1)], PRICES, 'USD')).toEqual({ ok: false, code: 'NO_WINBACK_PRICE' });
  });

  it('an order in another currency is not offered at a USD price', () => {
    expect(winbackPriceFor([line('scar', 1)], PRICES, 'SYP')).toEqual({ ok: false, code: 'CURRENCY_MISMATCH' });
  });

  it('an order with no goods is not offered', () => {
    expect(winbackPriceFor([], PRICES, 'USD')).toEqual({ ok: false, code: 'NO_LINES' });
  });
});

describe('a stored document is read whole or not at all', () => {
  it('drops a half entry, a zero, a negative, a bad currency', () => {
    const p = parseWinbackPrices({
      a: { one: 12, three: 20, currency: 'USD' },
      b: { one: 12, currency: 'USD' },
      c: { one: 0, three: 20, currency: 'USD' },
      d: { one: -1, three: 20, currency: 'USD' },
      e: { one: 12, three: 20, currency: 'usd' },
    });
    expect(Object.keys(p)).toEqual(['a']);
    expect(parseWinbackPrices(null)).toEqual({});
    expect(parseWinbackPrices([1, 2])).toEqual({});
  });
});

describe('what the editor sends is judged, in Arabic', () => {
  it('accepts a whole entry and a removal', () => {
    expect(validateWinbackPrice({ productId: 'p', one: 12, three: 20, currency: 'USD' })).toEqual({ ok: true, productId: 'p', price: { one: 12, three: 20, currency: 'USD' } });
    expect(validateWinbackPrice({ productId: 'p', remove: true })).toEqual({ ok: true, productId: 'p', price: null });
  });

  it('refuses a stray field, a zero, a string, a bad currency — each with its code', () => {
    expect(validateWinbackPrice({ productId: 'p', one: 12, three: 20, currency: 'USD', price: 1 })).toMatchObject({ ok: false, code: 'UNKNOWN_FIELD' });
    expect(validateWinbackPrice({ productId: 'p', one: 0, three: 20, currency: 'USD' })).toMatchObject({ ok: false, code: 'ONE' });
    expect(validateWinbackPrice({ productId: 'p', one: 12, three: '20', currency: 'USD' })).toMatchObject({ ok: false, code: 'THREE' });
    expect(validateWinbackPrice({ productId: 'p', one: 12, three: 20, currency: 'US' })).toMatchObject({ ok: false, code: 'CURRENCY' });
    expect(validateWinbackPrice({ one: 12, three: 20, currency: 'USD' })).toMatchObject({ ok: false, code: 'PRODUCT' });
    expect(validateWinbackPrice(null)).toMatchObject({ ok: false, code: 'BAD_BODY' });
    const r = validateWinbackPrice({ productId: 'p', one: -3, three: 20, currency: 'USD' });
    expect(r.ok === false && /[؀-ۿ]/.test(r.errorAr)).toBe(true);
  });
});

describe('the cost of one piece of the new order — for ITS pieces, never the old quantity copied (the coordinator, 25/11)', () => {
  it('the owner’s fixed figure when there is one', () => {
    expect(winbackUnitCost(4, 100, 6)).toEqual({ unit: 4, source: 'FIXED' });
    expect(winbackUnitCost(0, 100, 6)).toEqual({ unit: 0, source: 'FIXED' });
  });
  it('otherwise the old order’s cost over ITS pieces: a 2-piece order that cost 10 is 5 a piece; a 6-piece order that cost 48 is 8', () => {
    expect(winbackUnitCost(undefined, 10, 2)).toEqual({ unit: 5, source: 'OLD_ORDER' });
    expect(winbackUnitCost(undefined, 48, 6)).toEqual({ unit: 8, source: 'OLD_ORDER' });
    expect(winbackUnitCost(undefined, 48, 0)).toEqual({ unit: 0, source: 'OLD_ORDER' });
  });
});
