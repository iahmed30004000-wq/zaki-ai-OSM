import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripComments } from './guard-source';

/**
 * WHETHER AN ORDER'S PRICE ALREADY CONTAINS DELIVERY — ONE RULE, EVERY DOOR.
 *
 * It is the store's pricing policy, set on the store's row in «البلدان
 * والمتاجر»; an offer may turn it on for its own bundle. Only direct orders
 * applied it, so a store advertising delivery-inclusive prices had its
 * landing-page, storefront and Telegram orders collected as price + fee.
 *
 * ONE EXCEPTION, AT ONE DOOR (1/11, the owner: «شغّله ليشمل تلجرام والشيتات
 * وصفحات البيع … بس بدي اترك مجال لاضافة الطلب يدويا او من اللاندنج انو اقدر
 * احدد اذا شامل ولا لأ بظبط»): on the sales page an offer may say NO as well as
 * yes. Everywhere else an offer still only turns delivery on, because a
 * Telegram order is always bound to an offer and an offer always answers yes
 * or no — if its «no» got through there, the store's switch would have nothing
 * left to decide for Telegram.
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

  it('an offer never takes it away from a store that includes it — unless the door says an offer may say no', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    expect(await priceIncludesDeliveryFor('s1', false)).toBe(true);
    expect(await priceIncludesDeliveryFor('s1', null)).toBe(true);
    expect(await priceIncludesDeliveryFor('s1', false, {})).toBe(true);
    expect(await priceIncludesDeliveryFor('s1', false, { offerMaySayNo: false })).toBe(true);
  });

  it('…and where the door says so, an offer’s NO is obeyed in a store that includes delivery — the store is not even asked', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    expect(await priceIncludesDeliveryFor('s1', false, { offerMaySayNo: true })).toBe(false);
    expect(db.store.findFirst).not.toHaveBeenCalled();
  });

  it('…and silence still follows the store even there: no offer is not a «no»', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: true });
    expect(await priceIncludesDeliveryFor('s1', undefined, { offerMaySayNo: true })).toBe(true);
    expect(await priceIncludesDeliveryFor('s1', null, { offerMaySayNo: true })).toBe(true);
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
    expect(await priceIncludesDeliveryFor('s1', undefined, { offerMaySayNo: true })).toBe(false);
  });

  it('and a YES still wins with the option on', async () => {
    db.store.findFirst.mockResolvedValue({ priceIncludesDelivery: false });
    expect(await priceIncludesDeliveryFor('s1', true, { offerMaySayNo: true })).toBe(true);
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
});

describe('and only the sales page hears an offer’s «no»', () => {
  const read = (file: string) => stripComments(readFileSync(join(process.cwd(), file), 'utf8'));
  const call = (src: string) => {
    const at = src.search(/await priceIncludesDeliveryFor\(/);
    expect(at, 'the door no longer asks the rule').toBeGreaterThan(-1);
    return src.slice(at, at + 600);
  };

  it('src/lib/public-order.ts reads every line’s offer through the one reader, and says an offer may say no', () => {
    const c = call(read('src/lib/public-order.ts'));
    expect(c).toContain('offersSayDeliveryIncluded(lines.map((l) => l.offer?.deliveryIncluded))');
    expect(c).toContain('{ offerMaySayNo: true }');
  });

  it.each([
    'src/app/api/orders/route.ts', // direct (the form’s box speaks first; without it the offer can only turn it on)
    'src/app/api/orders/ai-intake/route.ts', // the paste-in dialog
    'src/lib/telegram/order-creation.ts', // Telegram
    'src/lib/v1/order-intake.ts', // other systems
  ])('NEGATIVE: %s does NOT — an offer there still only turns delivery on, so the store’s switch covers it', (file) => {
    const src = read(file);
    expect(src, 'the option spread to a door the owner did not mean').not.toMatch(/offerMaySayNo/);
    expect(src).not.toMatch(/offersSayDeliveryIncluded/);
    expect(call(src)).toMatch(/deliveryIncluded/); // it does hand the rule the offer’s flag, as before
  });
});
