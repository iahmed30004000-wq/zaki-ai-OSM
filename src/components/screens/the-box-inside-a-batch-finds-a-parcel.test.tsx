// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «صندوق بحث داخل الباتش عن طلب» — THE SCREEN (the owner, 3/11).
 *
 * Inside a batch's list of parcels there is a box. What is typed goes to the batch's own door as `?q=` (the server asks
 * the orders list's search of this batch alone), and the list shows what came back, with «N من M». An empty box is the
 * whole batch again. A batch already handed over opens its list too — to be searched — and offers none of the ways off
 * an open trolley. These render the real screen against a fake server.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, can } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn(), can: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => false, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => can(k) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]);
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'x', describeRefused: () => '', openWaybills: vi.fn(), WaybillError: class extends Error {},
}));
vi.mock('@/components/scan/ScanButton', () => ({ ScanSheet: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 20000 });

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: false },
  creator: null, createdAt: '2026-10-28T08:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 3 }, courierCityGap: null, ...over,
});
const parcel = (n: number, name: string) => ({
  id: `o${n}`, orderNumber: `SY-2026-000${n}`, trackingNumber: `TRK${n}`, customer: { fullName: name }, items: [],
});
const ALL = [parcel(1, 'أبو محمد'), parcel(2, 'سارة'), parcel(3, 'ليلى')];

/** The fake server: the list of batches, and one batch's read — narrowed by `q` the way the door narrows it. */
const serve = (theBatch = batch()) =>
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/shipping-batches/b1')) {
      const q = new URL(url, 'http://x').searchParams.get('q');
      if (!q) return { batch: { orders: ALL }, canEditInBatch: false, currency: null };
      const hits = ALL.filter((o) => o.orderNumber.includes(q) || o.customer.fullName.includes(q) || o.trackingNumber.includes(q));
      return { batch: { orders: hits }, canEditInBatch: false, currency: null, search: { q, total: ALL.length } };
    }
    return { batches: [theBatch], pagination: { total: 1 } };
  });

const batchReads = () => apiJson.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/shipping-batches/b1'));
const box = () => screen.getByLabelText('ابحث داخل الدفعة') as HTMLInputElement;

const open = async (label: RegExp = /طرود الدفعة/) => {
  render(<ShippingBatchesScreen />);
  fireEvent.click(await screen.findByRole('button', { name: label }, WAIT));
  await screen.findByText('SY-2026-0001', undefined, WAIT);
};

beforeEach(() => {
  vi.clearAllMocks();
  can.mockImplementation((k: string) => ['ops.batches', 'customers.view'].includes(k));
});
afterEach(cleanup);

describe('the box inside the batch', () => {
  it('typing narrows the list to what the door answered, and says how many of how many', async () => {
    serve();
    await open();
    fireEvent.change(box(), { target: { value: 'سارة' } });

    await waitFor(() => expect(screen.queryByText('SY-2026-0001')).toBeNull(), WAIT);
    expect(screen.getByText('SY-2026-0002')).toBeTruthy();
    expect(screen.queryByText('SY-2026-0003')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('1 من 3 بيطابقوا «سارة»');
    expect(batchReads().at(-1)).toBe(`/api/shipping-batches/b1?q=${encodeURIComponent('سارة')}`);
  });

  it('a barcode finds its parcel through the same door', async () => {
    serve();
    await open();
    fireEvent.change(box(), { target: { value: 'TRK3' } });
    await waitFor(() => expect(screen.queryByText('SY-2026-0001')).toBeNull(), WAIT);
    expect(screen.getByText('SY-2026-0003')).toBeTruthy();
  });

  it('clearing the box shows the whole batch again, read without a search', async () => {
    serve();
    await open();
    fireEvent.change(box(), { target: { value: 'سارة' } });
    await waitFor(() => expect(screen.queryByText('SY-2026-0001')).toBeNull(), WAIT);

    fireEvent.change(box(), { target: { value: '' } });
    await screen.findByText('SY-2026-0001', undefined, WAIT);
    expect(screen.getByText('SY-2026-0003')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(batchReads().at(-1)).toBe('/api/shipping-batches/b1');
  });

  it('nothing matches: it says so, and draws no empty list', async () => {
    serve();
    await open();
    fireEvent.change(box(), { target: { value: 'مافي' } });
    expect((await screen.findByRole('status', undefined, WAIT)).textContent).toBe('ما في طلب بهالدفعة بيطابق «مافي»');
    expect(screen.queryByText('SY-2026-0002')).toBeNull();
  });

  it('opening the list is one read; typing waits a quarter-second and asks once for the whole word', async () => {
    serve();
    await open();
    expect(batchReads()).toHaveLength(1);
    fireEvent.change(box(), { target: { value: 'س' } });
    fireEvent.change(box(), { target: { value: 'سا' } });
    fireEvent.change(box(), { target: { value: 'سارة' } });
    await waitFor(() => expect(screen.queryByText('SY-2026-0001')).toBeNull(), WAIT);
    expect(batchReads()).toHaveLength(2);
  });

  it('the box names the phone only for whoever the row shows a phone to', async () => {
    serve();
    await open();
    expect(box().placeholder).toContain('رقم التلفون');
    cleanup();

    can.mockImplementation((k: string) => k === 'ops.batches');
    serve();
    await open();
    expect(box().placeholder).not.toContain('التلفون');
  });
});

describe('a batch already handed over', () => {
  it('opens its list to be searched, and offers none of the ways off an open trolley', async () => {
    serve(batch({ status: 'SHIPPED', shippedAt: '2026-10-29T08:00:00.000Z' }));
    await open(/طرود الدفعة — ابحث عن طلب/);
    expect(box()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ألغِ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'أجّل الشحن' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'أعِده للمتابعة' })).toBeNull();
  });

  it('an open trolley keeps its three ways off, beside the box', async () => {
    serve();
    await open(/طرود الدفعة وتفاصيلها/);
    expect(screen.getAllByRole('button', { name: 'ألغِ' })).toHaveLength(3);
  });
});
