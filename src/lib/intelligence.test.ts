import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Business analysis over operational data.
 *
 * The tests that matter here are the ones about restraint: a finding with
 * too few orders behind it is noise, and an insight nobody can check is a
 * guess with confidence.
 */

const { db } = vi.hoisted(() => ({
  db: { orderItem: { findMany: vi.fn() }, order: { findMany: vi.fn() } },
}));
vi.mock('./db', () => ({ db }));

import {
  MIN_SAMPLE,
  RETURN_ALARM,
  returningProducts,
  returningRegions,
  riskyCustomers,
  runDetectors,
  thinMarginRegions,
  type Detector,
} from './intelligence';

const scope = { companyId: 'c1', storeId: 's1', minorUnit: 2, currency: 'USD' };

/** n order items for one product, `returned` of them sent back. */
const items = (productId: string, name: string, total: number, returned: number, fee = 3) =>
  Array.from({ length: total }, (_, i) => ({
    productId,
    productName: name,
    order: {
      shippingStatus: i < returned ? 'RETURNED' : 'DELIVERED',
      totalAmount: 20,
      deliveryFee: fee,
    },
  }));

beforeEach(() => vi.clearAllMocks());

describe('products losing money to returns', () => {
  it('calls out a product returning above the alarm rate', async () => {
    db.orderItem.findMany.mockResolvedValue(items('p1', 'ماء الكمأ', 20, 5)); // 25%
    const [finding] = await returningProducts(db as never, scope);

    expect(finding.severity).toBe('ALARM');
    expect(finding.title).toContain('25%');
    expect(finding.evidence).toContain('5 مرتجعاً من 20');
  });

  it('counts the delivery fees a return burned', async () => {
    db.orderItem.findMany.mockResolvedValue(items('p1', 'ماء الكمأ', 20, 5, 3));
    const [finding] = await returningProducts(db as never, scope);
    expect(finding.evidence).toContain('15'); // 5 returns × 3
  });

  it('stays silent on too few orders — one return out of two is not a rate', async () => {
    db.orderItem.findMany.mockResolvedValue(items('p1', 'منتج نادر', 2, 1)); // 50%, n=2
    expect(await returningProducts(db as never, scope)).toEqual([]);
  });

  it('says nothing about a product returning normally', async () => {
    db.orderItem.findMany.mockResolvedValue(items('p1', 'منتج سليم', 40, 2)); // 5%
    expect(await returningProducts(db as never, scope)).toEqual([]);
  });

  it('puts the worst first', async () => {
    db.orderItem.findMany.mockResolvedValue([
      ...items('p1', 'أقل', 20, 5), // 25%
      ...items('p2', 'أسوأ', 20, 10), // 50%
    ]);
    const findings = await returningProducts(db as never, scope);
    expect(findings[0].title).toContain('أسوأ');
  });
});

describe('regions that return', () => {
  const regionOrders = (regionId: string, name: string, total: number, returned: number) =>
    Array.from({ length: total }, (_, i) => ({
      regionId,
      shippingStatus: i < returned ? 'RETURNED' : 'DELIVERED',
      region: { name },
    }));

  it('only flags a region clearly worse than the store average', async () => {
    db.order.findMany.mockResolvedValue([
      ...regionOrders('r1', 'حلب', 20, 8), // 40%
      ...regionOrders('r2', 'دمشق', 60, 3), // 5%
    ]);
    const findings = await returningRegions(db as never, scope);

    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('حلب');
    expect(findings[0].action).toContain('شركة الشحن');
  });

  it('says nothing when every region returns at the same rate', async () => {
    db.order.findMany.mockResolvedValue([
      ...regionOrders('r1', 'حلب', 20, 5),
      ...regionOrders('r2', 'دمشق', 20, 5),
    ]);
    expect(await returningRegions(db as never, scope)).toEqual([]);
  });
});

describe('customers to stop shipping to', () => {
  const customerOrders = (customerId: string, name: string, total: number, returned: number) =>
    Array.from({ length: total }, (_, i) => ({
      customerId,
      shippingStatus: i < returned ? 'RETURNED' : 'DELIVERED',
      deliveryFee: 3,
      customer: { fullName: name, phone: '0790123456' },
    }));

  it('flags somebody who refused three times, even on few orders', async () => {
    db.order.findMany.mockResolvedValue(customerOrders('cu1', 'أحمد', 4, 3));
    const [finding] = await riskyCustomers(db as never, scope);

    expect(finding.severity).toBe('ALARM');
    expect(finding.action).toContain('القائمة السوداء');
    expect(finding.subject).toMatchObject({ kind: 'customer' });
  });

  it('does not flag two refusals — a person can be unlucky twice', async () => {
    db.order.findMany.mockResolvedValue(customerOrders('cu1', 'أحمد', 10, 2));
    expect(await riskyCustomers(db as never, scope)).toEqual([]);
  });
});

describe('orders the delivery fee eats', () => {
  it('flags a region where a third of the value goes to delivery, often', async () => {
    db.order.findMany.mockResolvedValue(
      Array.from({ length: 12 }, () => ({
        regionId: 'r1',
        totalAmount: 9,
        deliveryFee: 4, // 44% of the order
        region: { name: 'القنيطرة' },
      }))
    );
    const [finding] = await thinMarginRegions(db as never, scope);

    expect(finding.title).toContain('القنيطرة');
    expect(finding.action).toMatch(/الحد الأدنى|حد الطلب|تفاوض/);
  });

  it('says nothing where the fee is a small part of the order', async () => {
    db.order.findMany.mockResolvedValue(
      Array.from({ length: 20 }, () => ({ regionId: 'r1', totalAmount: 60, deliveryFee: 3, region: { name: 'دمشق' } }))
    );
    expect(await thinMarginRegions(db as never, scope)).toEqual([]);
  });
});

describe('the thresholds are deliberate', () => {
  it('requires a real sample and a real rate', () => {
    expect(MIN_SAMPLE).toBeGreaterThanOrEqual(8);
    expect(RETURN_ALARM).toBeGreaterThan(0.1);
  });
});

/**
 * ONE BROKEN DETECTOR DOES NOT TAKE THE SCREEN DOWN.
 *
 * The eleven used to share a single Promise.all, so one query that threw
 * emptied the whole page. A detector that throws is now left out, named, and
 * the others answer.
 */
describe('a detector that throws', () => {
  const finding = (key: string, severity: 'ALARM' | 'WATCH' | 'GOOD') => ({
    key, family: 'queue' as const, title: key, evidence: 'e', action: 'a', severity,
  });
  const ok = (name: string, severity: 'ALARM' | 'WATCH' | 'GOOD'): Detector => ({
    name, run: async () => [finding(name, severity)],
  });
  const broken: Detector = { name: 'staleStatements', run: async () => { throw new Error('Unknown argument'); } };

  it('is skipped and named, and the rest still answer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runDetectors(db as never, scope, [ok('a', 'WATCH'), broken, ok('b', 'ALARM')]);
    expect(out.skipped).toEqual(['staleStatements']);
    expect(out.findings.map((f) => f.key)).toEqual(['b', 'a']); // alarms first
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('leaves skipped empty when every detector ran', async () => {
    const out = await runDetectors(db as never, scope, [ok('a', 'GOOD')]);
    expect(out.skipped).toEqual([]);
    expect(out.findings).toHaveLength(1);
  });

  it('answers, rather than throws, when every detector is broken', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await runDetectors(db as never, scope, [broken, { ...broken, name: 'x' }]);
    expect(out.findings).toEqual([]);
    expect(out.skipped).toEqual(['staleStatements', 'x']);
    spy.mockRestore();
  });
});
