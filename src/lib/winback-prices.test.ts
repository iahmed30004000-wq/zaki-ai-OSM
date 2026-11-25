import { describe, expect, it } from 'vitest';
import { parseWinbackPrices, validateWinbackPrice, winbackPriceFor } from './winback-prices';

/** The owner's win-back price per product (F12): the tier, the refusals, and nothing guessed. */

const PRICES = parseWinbackPrices({
  scar: { one: 12, three: 20, currency: 'USD' },
  truffle: { one: 10, three: 20, currency: 'USD' },
});
const line = (productId: string, quantity: number, freeQuantity = 0) => ({ productId, quantity, freeQuantity });

describe('the price of one cancelled order', () => {
  it('one or two pieces take the one-piece price; three or more the three-piece price', () => {
    expect(winbackPriceFor([line('scar', 1)], PRICES, 'USD')).toMatchObject({ ok: true, price: 12, tier: 'one' });
    expect(winbackPriceFor([line('scar', 2)], PRICES, 'USD')).toMatchObject({ ok: true, price: 12, tier: 'one' });
    expect(winbackPriceFor([line('scar', 3)], PRICES, 'USD')).toMatchObject({ ok: true, price: 20, tier: 'three' });
    expect(winbackPriceFor([line('scar', 5)], PRICES, 'USD')).toMatchObject({ ok: true, price: 20, tier: 'three' });
    expect(winbackPriceFor([line('truffle', 1)], PRICES, 'USD')).toMatchObject({ ok: true, price: 10 });
  });

  it('the free pieces are pieces: two plus one free is three', () => {
    expect(winbackPriceFor([line('truffle', 2, 1)], PRICES, 'USD')).toMatchObject({ ok: true, price: 20, tier: 'three', pieces: 3 });
  });

  it('two lines of the same product are one product', () => {
    expect(winbackPriceFor([line('scar', 1), line('scar', 2)], PRICES, 'USD')).toMatchObject({ ok: true, price: 20 });
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
