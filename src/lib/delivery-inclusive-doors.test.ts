import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHETHER AN ORDER'S PRICE ALREADY CONTAINS DELIVERY — ONE RULE, EVERY DOOR.
 *
 * It is the store's pricing policy, set on the store's row in «البلدان
 * والمتاجر», for every order no offer speaks for; an offer that does speak
 * says yes or no for its own bundle (1/11, the owner: «بدي اترك مجال … أحدد
 * إذا شامل ولا لأ بظبط»). Only direct orders applied it, so a store
 * advertising delivery-inclusive prices had its landing-page, storefront and
 * Telegram orders collected as price + fee.
 */

const { db } = vi.hoisted(() => ({ db: { store: { findFirst: vi.fn() } } }));
vi.mock('./db', () => ({ db }));

import { priceIncludesDeliveryFor } from './delivery-fees';

beforeEach(() => vi.clearAllMocks());

describe('the rule', () => {
  it('follows the store', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    expect(await priceIncludesDeliveryFor('s1')).toBe(true);
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
    expect(await priceIncludesDeliveryFor('s1')).toBe(false);
    expect(db.store.findFirst.mock.calls[0][0].where).toEqual({ id: 's1' });
  });

  it('an offer may include delivery in a store that does not', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
    expect(await priceIncludesDeliveryFor('s1', true)).toBe(true);
    expect(db.store.findFirst).not.toHaveBeenCalled();
  });

  it('an offer that says NO is obeyed even in a store that includes delivery — the owner’s room for an exception (old → new, 1/11)', async () => {
    // It used to be «an offer never takes it away from a store that includes it». An unticked box on an offer was then silently
    // overridden the day the store's policy was turned on; the owner asked to be able to say «no» exactly, at the offer too.
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    expect(await priceIncludesDeliveryFor('s1', false)).toBe(false);
    expect(db.store.findFirst, 'the store is not even asked when an offer has spoken').not.toHaveBeenCalled();
  });

  it('and SILENCE still follows the store: no offer is not a «no»', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    expect(await priceIncludesDeliveryFor('s1', null)).toBe(true);
    expect(await priceIncludesDeliveryFor('s1', undefined)).toBe(true);
    expect(await priceIncludesDeliveryFor('s1')).toBe(true);
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
    expect(await priceIncludesDeliveryFor('s1', undefined)).toBe(false);
  });

  it('an unknown store is not delivery-inclusive', async () => {
    db.store.findFirst.mockResolvedValue(null);
    expect(await priceIncludesDeliveryFor('gone')).toBe(false);
  });
});

describe('every door asks it', () => {
  // Each door builds its own order row; each must ask the rule and write
  // the answer. A door that stops doing either is back to price + fee.
  const DOORS = [
    'src/app/api/orders/route.ts', // direct
    'src/lib/public-order.ts', // landing page and storefront
    'src/lib/telegram/order-creation.ts', // Telegram
  ];

  it.each(DOORS)('%s', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).toMatch(/priceIncludesDeliveryFor\(/);
    expect(src).toMatch(/^\s*priceIncludesDelivery,?\s*$/m);
  });

  // And every door that asks the rule asks it with what THE OFFERS say, read by the one reader — never a rule of its own, which is how
  // "an offer can only switch it on" got repeated five times and had to be undone in five places (1/11).
  const ASKERS = [...DOORS, 'src/lib/v1/order-intake.ts', 'src/app/api/orders/ai-intake/route.ts'];

  it.each(ASKERS)('%s hands the rule the offers’ answer, from the one reader', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    const at = src.search(/await priceIncludesDeliveryFor\(/);
    expect(at, 'the door no longer asks the rule').toBeGreaterThan(-1);
    expect(src.slice(at, at + 600), 'the offers’ answer is not what the rule is asked').toContain('offersSayDeliveryIncluded(');
    expect(src, 'a door-local «any offer includes» is the old rule coming back').not.toMatch(/anyLineIncludesDelivery|\.some\(\(l\) => l\.offer\?\.deliveryIncluded === true\)/);
  });
});
