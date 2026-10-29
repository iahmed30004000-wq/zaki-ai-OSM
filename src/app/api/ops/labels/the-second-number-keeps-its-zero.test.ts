import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SECOND NUMBER ON OUR WAYBILL (RV167).
 *
 * The storefront stores a second number canonical — its trunk zero stripped — and keeps no as-typed copy. The courier
 * dispatch already writes it back in the store country's form; our own label and CSV printed it as stored, so the
 * second line read «988777666», a number nobody dials. They now go through the same `formatPhoneNumber`, by the country
 * of the store the label is printed for.
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: { order: { findMany: vi.fn(), updateMany: vi.fn() }, store: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
}));
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: vi.fn(), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));

import { GET as printGET } from '@/app/api/ops/labels/print/route';
import { signLabelBatch } from '@/lib/labels';
import { altPhoneForLabel } from '@/lib/waybill';

const A = '11111111-1111-4111-8111-111111111111';
const BATCH = '99999999-9999-4999-8999-999999999999';

const order = (altPhone: string | null) => ({
  id: A, orderNumber: 'ORD-1', merchantRef: 'ORD-1', trackingNumber: 'KSA100422577363', totalAmount: 60000, currency: 'SYP',
  confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_PICKUP', shippingBatchId: BATCH, deliveryProviderId: 'p1',
  regionId: 'r1', priceIncludesDelivery: false, labelPrintedAt: null, createdAt: new Date('2026-10-20'), customerNotes: null,
  customer: { fullName: 'محمد', phone: '990123456', rawPhone: '0990123456', altPhone, city: 'دمشق', address: 'دمشق - شارع' },
  region: { name: 'دمشق' }, deliveryProvider: { name: 'ناقل', code: 'NAQEL', adapterCode: null, apiEnabled: false, apiConfig: null, apiCredentials: null },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0, unitPrice: 60000, discountShare: 0 }], addOns: [],
});

const countryOf = (code: string | undefined) => ({ minorUnit: 0, currencyCode: 'SYP', ...(code ? { code } : {}) });

async function print(altPhone: string | null, code: string | undefined, format?: 'csv') {
  requireContext.mockResolvedValue({ user: { id: 'u1', role: 'WAREHOUSE' }, companyId: 'c1', storeId: 's1', country: countryOf(code) });
  db.order.findMany.mockResolvedValue([order(altPhone)]);
  const token = await signLabelBatch({ storeId: 's1', orderIds: [A], width: 100, height: 150 } as never);
  return (await printGET(new Request(`http://localhost/x?t=${token}${format ? `&format=${format}` : ''}`))).text();
}

const phonesLine = (html: string) => html.match(/<p class="phones"[^>]*>([^<]*)<\/p>/)?.[1] ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  db.store.findFirst.mockResolvedValue({ name: 'متجر', logo: null, supportPhone: null });
  db.order.updateMany.mockResolvedValue({ count: 0 });
});

describe('the second number on the sheet', () => {
  it('a Syrian store: «988777666» is printed with its zero', async () => {
    const line = phonesLine(await print('988777666', 'SY'));
    expect(line).toContain('0990123456');
    expect(line).toContain('0988777666');
    expect(line).not.toMatch(/(^|\D)988777666/);
  });

  it('NEGATIVE: a number already typed with its zero is not given a second one', async () => {
    const line = phonesLine(await print('0988777666', 'SY'));
    expect(line).toContain('0988777666');
    expect(line).not.toContain('00988777666');
  });

  it('NEGATIVE: an order with no second number prints one number, as before', async () => {
    const line = phonesLine(await print(null, 'SY'));
    expect(line.trim()).toBe('0990123456');
  });

  it('NEGATIVE: a store whose country is unknown leaves the number as it is stored — no other country’s shape', async () => {
    const line = phonesLine(await print('988777666', undefined));
    expect(line).toContain('988777666');
    expect(line).not.toContain('0988777666');
  });
});

describe('the second number in the CSV', () => {
  it('has its zero too', async () => {
    const csv = await print('988777666', 'SY', 'csv');
    expect(csv).toContain('"0988777666"');
  });
});

describe('altPhoneForLabel', () => {
  it('empty stays empty', () => {
    expect(altPhoneForLabel(null, 'SY')).toBe('');
    expect(altPhoneForLabel('', 'SY')).toBe('');
  });
});
