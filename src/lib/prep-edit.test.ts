import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));
vi.mock('@/lib/auth', () => ({ requireAuth: vi.fn() }));

import { attachGrants, can } from './authorization';
import { ALL_CATALOG_KEYS, PERMISSION_MODULES } from './permission-catalog';
import { PrepShortage, prepFeeUnchanged, prepFieldsOnly, prepGoodsRefusal, prepItems, prepQuantityChanges, prepShortAr, prepTouched, prepWindow } from './prep-edit';
import type { SessionUser } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PACKING TABLE'S PEN — the pure rules (30/10).
 *
 * The owner: «تعديل مباشر لموظفة التجهيز قبل ما تغلق الباتش … وبعد ما تغلق ما تقدر تعدل شي». These pin the four things the
 * door stands on: which requests are the key's, when the window is open, how a quantity's money is rebuilt, and that the
 * key is granted to nobody by itself. The door's own claims are in `app/api/orders/[id]/prep-edit-in-batch.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

describe('which requests belong to the key', () => {
  it('a name, a phone, a second phone, an address, a governorate and quantities — with the version and a reason riding along', () => {
    expect(prepFieldsOnly({ expectedVersion: 3, customerName: 'سارة' })).toBe(true);
    expect(prepFieldsOnly({ expectedVersion: 3, customerPhone: '0791234567', customerAltPhone: null, customerAddress: 'x', regionId: 'r', items: [] })).toBe(true);
    expect(prepFieldsOnly({ expectedVersion: 3, items: [{}], reason: 'اتصل الزبون' })).toBe(true);
  });

  it('NEGATIVE: one field outside the list and the request is not the packing table’s — a price, a discount, a fee, a status, a product, a note', () => {
    for (const extra of [
      { sellingPrice: 10 }, { discountAmount: 1 }, { shippingCost: 2 }, { quantity: 4 }, { productId: 'prod-bbbb-2' },
      { status: 'CANCELLED' }, { confirmationStatus: 'NEW' }, { internalNotes: 'x' }, { moderatorId: 'u2' }, { changeRequestId: 'c' }, { parcelInHand: true },
    ]) {
      expect(prepFieldsOnly({ expectedVersion: 3, customerName: 'سارة', ...extra }), JSON.stringify(extra)).toBe(false);
    }
  });

  it('NEGATIVE: a request that changes nothing (only the version) is nobody’s edit', () => {
    expect(prepFieldsOnly({ expectedVersion: 3 })).toBe(false);
    expect(prepFieldsOnly({ expectedVersion: 3, customerName: undefined })).toBe(false);
  });

  it('names what was touched, in the order of the list', () => {
    expect(prepTouched({ items: [], customerName: 'a', expectedVersion: 1 })).toEqual(['customerName', 'items']);
  });
});

describe('the window: confirmed, in a batch, and the batch still open', () => {
  const order = (over: Record<string, unknown> = {}) => ({
    confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippedAt: null, shippingBatchId: 'b1', ...over,
  });

  it('is open for a confirmed order on an open trolley', () => {
    expect(prepWindow(order(), { status: 'READY' })).toEqual({ open: true });
  });

  it('shuts the moment the batch is closed — SHIPPED and CLOSED both', () => {
    expect(prepWindow(order(), { status: 'SHIPPED' })).toEqual({ open: false, why: 'HANDED_OVER' });
    expect(prepWindow(order(), { status: 'CLOSED' })).toEqual({ open: false, why: 'HANDED_OVER' });
  });

  it('shuts when the parcel left on its own, whatever its batch says', () => {
    expect(prepWindow(order({ shippedAt: new Date() }), { status: 'READY' })).toEqual({ open: false, why: 'HANDED_OVER' });
    expect(prepWindow(order({ shippingStatus: 'SHIPPED' }), { status: 'READY' })).toEqual({ open: false, why: 'HANDED_OVER' });
  });

  it('is not open for an order that is not confirmed, or has no batch, or whose batch could not be read', () => {
    expect(prepWindow(order({ confirmationStatus: 'NEW' }), { status: 'READY' })).toEqual({ open: false, why: 'NOT_CONFIRMED' });
    expect(prepWindow(order({ shippingBatchId: null }), null)).toEqual({ open: false, why: 'NO_BATCH' });
    expect(prepWindow(order(), null)).toEqual({ open: false, why: 'NO_BATCH' });
  });

  it('NEGATIVE: a batch state nobody named is not assumed open', () => {
    expect(prepWindow(order(), { status: 'WHATEVER' }).open).toBe(false);
  });
});

describe('the lines: quantity only, the money rebuilt from the piece price the line already had', () => {
  const stored = [{ productId: 'prod-aaaa-1', quantity: 3, beforeDiscount: 36 }];

  it('3 at 12 each, raised to 5, is 60 — whatever price the browser sent', () => {
    for (const sent of [60, 1, 0, 9999]) {
      const out = prepItems(stored, [{ productId: 'prod-aaaa-1', quantity: 5, unitPrice: sent }], 2);
      expect(out, `browser sent ${sent}`).toEqual({ ok: true, items: [{ productId: 'prod-aaaa-1', quantity: 5, unitPrice: 60 }] });
    }
  });

  it('a line whose quantity did not move keeps its stored total exactly', () => {
    const out = prepItems(stored, [{ productId: 'prod-aaaa-1', quantity: 3, unitPrice: 1 }], 2);
    expect(out).toEqual({ ok: true, items: [{ productId: 'prod-aaaa-1', quantity: 3, unitPrice: 36 }] });
  });

  it('rounds to the currency’s minor unit, the way computeCod rounds a line', () => {
    const out = prepItems([{ productId: 'prod-aaaa-1', quantity: 3, beforeDiscount: 10 }], [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 0 }], 2);
    expect(out).toEqual({ ok: true, items: [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 13.33 }] });
    const dinar = prepItems([{ productId: 'prod-aaaa-1', quantity: 3, beforeDiscount: 10 }], [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 0 }], 3);
    expect(dinar).toEqual({ ok: true, items: [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 13.333 }] });
  });

  it('NEGATIVE: another product, an added line and a dropped line are all refused, in the same words', () => {
    const swapped = prepItems(stored, [{ productId: 'prod-bbbb-2', quantity: 3, unitPrice: 36 }], 2);
    const added = prepItems(stored, [{ productId: 'prod-aaaa-1', quantity: 3, unitPrice: 36 }, { productId: 'prod-bbbb-2', quantity: 1, unitPrice: 5 }], 2);
    const dropped = prepItems([...stored, { productId: 'prod-bbbb-2', quantity: 1, beforeDiscount: 5 }], [{ productId: 'prod-aaaa-1', quantity: 3, unitPrice: 36 }], 2);
    for (const out of [swapped, added, dropped]) {
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain('الكمية بس');
    }
  });

  it('a product on the order twice is matched in the order it was sent', () => {
    const two = [
      { productId: 'prod-aaaa-1', quantity: 1, beforeDiscount: 10 },
      { productId: 'prod-aaaa-1', quantity: 2, beforeDiscount: 24 },
    ];
    const out = prepItems(two, [{ productId: 'prod-aaaa-1', quantity: 1, unitPrice: 0 }, { productId: 'prod-aaaa-1', quantity: 4, unitPrice: 0 }], 2);
    expect(out).toEqual({ ok: true, items: [
      { productId: 'prod-aaaa-1', quantity: 1, unitPrice: 10 },
      { productId: 'prod-aaaa-1', quantity: 4, unitPrice: 48 },
    ] });
  });

  it('says only what moved, per product, with no customer data in it', () => {
    expect(prepQuantityChanges(stored, [{ productId: 'prod-aaaa-1', quantity: 5 }])).toEqual([{ productId: 'prod-aaaa-1', before: 3, after: 5 }]);
    expect(prepQuantityChanges(stored, [{ productId: 'prod-aaaa-1', quantity: 3 }])).toEqual([]);
  });

  it('the shortage sentence names the products, and the error carries them', () => {
    expect(prepShortAr(['كريم', 'عطر'])).toContain('كريم، عطر');
    expect(prepShortAr(['كريم'])).toContain('لم يُحفظ شيء');
    expect(new PrepShortage(['كريم']).names).toEqual(['كريم']);
  });

  it('once the company has been told to cancel the parcel, the sentence never says nothing was saved', () => {
    const said = prepShortAr(['كريم'], true);
    expect(said).toContain('أُلغي الطرد عند شركة الشحن');
    expect(said).toContain('لم يُحفظ التعديل');
    expect(said).not.toContain('لم يُحفظ شيء');
    expect(new PrepShortage(['كريم'], true).courierCancelled).toBe(true);
    expect(new PrepShortage(['كريم']).courierCancelled).toBe(false);
  });

  it('three for 25 there and back lands on 25 again — the figure is rebuilt from the stored line each time', () => {
    const to4 = prepItems([{ productId: 'prod-aaaa-1', quantity: 3, beforeDiscount: 25 }], [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 0 }], 2);
    expect(to4).toEqual({ ok: true, items: [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 33.33 }] });
    const back = prepItems([{ productId: 'prod-aaaa-1', quantity: 4, beforeDiscount: 33.33 }], [{ productId: 'prod-aaaa-1', quantity: 3, unitPrice: 0 }], 2);
    expect(back).toEqual({ ok: true, items: [{ productId: 'prod-aaaa-1', quantity: 3, unitPrice: 25 }] });
  });
});

describe('an ordinary order, and the fee a governorate carries', () => {
  const line = (over: Record<string, unknown> = {}) => ({ productId: 'prod-aaaa-1', freeQuantity: 0, discountShare: 0, ...over });

  it('an order with no discount, no gift, no add-on and no repeated product has nothing to refuse', () => {
    expect(prepGoodsRefusal({ discount: 0, lines: [line(), line({ productId: 'prod-bbbb-2' })], addOns: 0 })).toBeNull();
  });

  it('NEGATIVE: each of the five things refuses, in the same Arabic words', () => {
    const refusals = [
      prepGoodsRefusal({ discount: 1, lines: [line()], addOns: 0 }),
      prepGoodsRefusal({ discount: 0, lines: [line({ freeQuantity: 1 })], addOns: 0 }),
      prepGoodsRefusal({ discount: 0, lines: [line({ discountShare: 0.5 })], addOns: 0 }),
      prepGoodsRefusal({ discount: 0, lines: [line()], addOns: 1 }),
      prepGoodsRefusal({ discount: 0, lines: [line(), line()], addOns: 0 }),
    ];
    for (const r of refusals) expect(r).toContain('خصم أو هدية أو إضافة');
    expect(new Set(refusals).size).toBe(1);
  });

  it('a fee is the same fee to the minor unit, and nothing less', () => {
    expect(prepFeeUnchanged(3, 3, 2)).toBe(true);
    expect(prepFeeUnchanged(3, 3.001, 2)).toBe(true);
    expect(prepFeeUnchanged(3, 3.01, 2)).toBe(false);
    expect(prepFeeUnchanged(3, 3.001, 3)).toBe(false);
    expect(prepFeeUnchanged(0, 0, 3)).toBe(true);
    expect(prepFeeUnchanged(3, 0, 2)).toBe(false);
  });
});

describe('the key is granted to nobody by itself', () => {
  const person = (keys: string[]) => {
    const user = { id: 'u1', name: 'x', email: 'x@x', role: 'WAREHOUSE', status: 'ACTIVE', companyId: 'c1', permissions: keys } as unknown as SessionUser;
    return attachGrants(user, { fullAccess: false, grants: Object.fromEntries(keys.map((k) => [k, { scope: 'ALL_COMPANY' }])) } as never);
  };

  it('is in the catalog under ops, needs the batches screen, and opens no list of its own', () => {
    expect(ALL_CATALOG_KEYS.has('ops.edit_in_batch')).toBe(true);
    const item = PERMISSION_MODULES.find((m) => m.module === 'ops')!.items.find((i) => i.key === 'ops.edit_in_batch')!;
    expect(item.requires).toBe('ops.batches');
    expect(item.opens).toBeUndefined();
  });

  it('NEGATIVE: every other key in the packing family, and the order keys, leave it closed', () => {
    const family = ['ops.prepare', 'ops.ship', 'ops.labels', 'ops.track', 'ops.batches', 'ops.decide_changes', 'orders.view', 'orders.edit', 'orders.change_price', 'orders.change_fee'];
    expect(can(person(family), 'ops.edit_in_batch')).toBe(false);
    expect(can(person([...family, 'ops.edit_in_batch']), 'ops.edit_in_batch')).toBe(true);
  });

  it('NEGATIVE: no migration and no fallback list hands it out', () => {
    const dir = join(process.cwd(), 'prisma', 'migrations');
    for (const m of readdirSync(dir)) {
      const file = join(dir, m, 'migration.sql');
      let text = '';
      try { text = readFileSync(file, 'utf8'); } catch { continue; }
      expect(text, m).not.toContain('ops.edit_in_batch');
    }
    const core = readFileSync(join(process.cwd(), 'src', 'lib', 'permissions-core.ts'), 'utf8');
    expect(core).not.toContain('ops.edit_in_batch');
  });
});
