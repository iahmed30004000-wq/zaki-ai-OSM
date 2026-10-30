import { beforeEach, describe, expect, it, vi } from 'vitest';
import { distinctCustomers } from '@/lib/pii-alert';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE HARVEST ALARM COUNTS WHAT LEFT THE BUILDING, NOT WHAT WAS READ.
 *
 * `GET /api/shipping-batches/[id]` counted the batch's customers towards
 * the «someone is reading everything» alarm BEFORE it took the phone off
 * the response. A warehouse worker without the address-book key was shown
 * names and cities only — no contact details — and was still tallied for
 * every parcel, so a normal day on the trolley screen could raise the
 * alarm against a person who never saw a number.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { db, requireContext, can, noteCustomersHandedOut } = vi.hoisted(() => ({
  db: { shippingBatch: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  can: vi.fn(),
  noteCustomersHandedOut: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ can: (...a: unknown[]) => can(...a), requirePermission: vi.fn() }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/apps/events', () => ({ emitAppEvent: vi.fn() }));
vi.mock('@/lib/pii-alert', async (orig) => ({
  ...(await orig<typeof import('@/lib/pii-alert')>()),
  noteCustomersHandedOut: (...a: unknown[]) => noteCustomersHandedOut(...a),
}));

import { GET } from './[id]/route';

const order = (n: number, phone: string) => ({
  id: `o${n}`, orderNumber: `SY-2026-000${n}`, merchantRef: null, totalAmount: 10, trackingNumber: null, shippingStatus: 'PENDING',
  customer: { fullName: `زبون ${n}`, phone, city: 'عمّان' },
  region: { name: 'عمّان' },
});

const BATCH = {
  id: 'b1', companyId: 'c1', storeId: 's1', status: 'READY', batchNumber: 'BATCH-1',
  provider: null, creator: null,
  // The third parcel is the second one's customer again.
  orders: [order(1, '0790000001'), order(2, '0790000002'), order(3, '0790000002')],
};

const USER = { id: 'u1', name: 'عامل', email: 'w@example.com' };

/** Which keys the caller holds. */
const grant = (...keys: string[]) => can.mockImplementation((_u: unknown, k: string) => keys.includes(k));

const get = async () => {
  const res = await GET(new Request('http://localhost/api/shipping-batches/b1'), { params: Promise.resolve({ id: 'b1' }) });
  return { status: res.status, body: (await res.json()) as { batch: { orders: Array<{ customer: { phone?: string } }> } } };
};

/** The rows the alarm was handed, as the alarm will count them. */
const countedRows = () => (noteCustomersHandedOut.mock.calls[0][0] as { rows: Array<{ phone?: string | null }> }).rows;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: USER, companyId: 'c1', storeId: 's1' });
  db.shippingBatch.findFirst.mockResolvedValue(BATCH);
});

describe('the batch screen and the harvest alarm', () => {
  it('without the address-book key nobody is counted, because no phone left', async () => {
    grant('ops.batches');
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.batch.orders.every((o) => o.customer.phone === undefined)).toBe(true);
    expect(distinctCustomers(countedRows())).toBe(0);
    expect(countedRows()).toEqual([]);
  });

  it('with the key, each distinct customer is counted once — the repeat customer is one person', async () => {
    grant('ops.batches', 'customers.view');
    const { body } = await get();
    expect(body.batch.orders.map((o) => o.customer.phone)).toEqual(['0790000001', '0790000002', '0790000002']);
    expect(distinctCustomers(countedRows())).toBe(2);
  });

  it('what is counted is what was sent: the rows handed to the alarm carry no phone the response lacks', async () => {
    grant('ops.batches');
    const { body } = await get();
    const sent = body.batch.orders.map((o) => o.customer.phone).filter(Boolean);
    expect(countedRows().map((r) => r.phone).filter(Boolean)).toEqual(sent);
  });

  it('a caller without the batches key is refused and nothing is counted — the packing and tracking keys alone no longer open it', async () => {
    grant('ops.ship', 'ops.track');
    const { status } = await get();
    expect(status).toBe(403);
    expect(noteCustomersHandedOut).not.toHaveBeenCalled();
  });
});
