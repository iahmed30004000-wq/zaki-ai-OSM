// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE OPEN TROLLEY SAYS WHAT IS IN EACH BOX, AND ONE PERSON MAY CORRECT IT (30/10).
 *
 * The owner: «أظهر اسم ورقم ومحافظة الزبون وطالبو منتج وكم قطعة وسعر … وتعدل قبل ما تغلق الباتش».
 *
 * Beside every parcel of an OPEN trolley: who, the phone (when the server sent one), the governorate, each product × its
 * quantity, and what is collected. «عدّل» is drawn only when the server says the caller holds `ops.edit_in_batch`
 * AND the trolley is open — everyone else sees the same row with the information and no button. These render the real
 * screen against a fake server.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, toastDone } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn(), toastDone: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => null,
  useConfirm: () => async () => false,
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: (...a: unknown[]) => toastDone(...a) }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
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
const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
  provider: { id: 'dp1', name: 'الباشا', code: 'BASHA', kind: 'COMPANY', apiEnabled: false },
  creator: { id: 'u1', name: 'سارة' }, createdAt: '2026-10-28T08:00:00.000Z', shippedAt: null, notes: null,
  _count: { orders: 1 }, courierCityGap: null, ...over,
});
const parcel = (over: Record<string, unknown> = {}) => ({
  id: 'o1', orderNumber: 'SY-2026-0001', trackingNumber: null, version: 7, currency: 'JOD', totalAmount: 39,
  regionId: 'r1', region: { id: 'r1', name: 'السويداء' },
  customer: { fullName: 'أبو محمد', phone: '0791234567', altPhone: null, address: 'شارع الجلاء', city: 'السويداء' },
  items: [{ productId: 'prod-aaaa-1', productName: 'كريم الشعر', quantity: 3, freeQuantity: 1, unitPrice: 36 }],
  ...over,
});

const serve = (detail: Record<string, unknown>) =>
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/geo/regions')) {
      return { country: { name: 'سوريا' }, regions: [{ id: 'r1', name: 'السويداء' }, { id: 'r2', name: 'دمشق' }] };
    }
    if (url.startsWith('/api/shipping-batches/')) {
      return { batch: { orders: [parcel()] }, canEditInBatch: false, currency: { code: 'JOD', minorUnit: 2 }, ...detail };
    }
    return { batches: [batch()], pagination: { total: 1 } };
  });

const open = async () => {
  render(<ShippingBatchesScreen />);
  fireEvent.click(await screen.findByRole('button', { name: /طرود الدفعة/ }, WAIT));
  await screen.findByText('SY-2026-0001', undefined, WAIT);
};

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }), clone() { return this; } });
});
afterEach(cleanup);

describe('each parcel of an open trolley says what is in the box', () => {
  it('the name, the phone, the governorate, each product × its quantity (and the gift), and what is collected', async () => {
    serve({});
    await open();

    expect(screen.getByText('أبو محمد')).toBeTruthy();
    expect(screen.getByText('0791234567')).toBeTruthy();
    expect(screen.getByText(/السويداء/)).toBeTruthy();
    expect(screen.getByText(/كريم الشعر × 3 \+ 1 هدية/)).toBeTruthy();
    expect(screen.getByText('39.00 JOD')).toBeTruthy();
  });

  it('NEGATIVE: a trolley read without the address-book key shows no phone — nothing is invented in its place', async () => {
    serve({ batch: { orders: [parcel({ customer: { fullName: 'أبو محمد', city: 'السويداء' } })] } });
    await open();

    expect(screen.getByText('أبو محمد')).toBeTruthy();
    expect(screen.queryByText('0791234567')).toBeNull();
    expect(screen.getByText(/كريم الشعر × 3/)).toBeTruthy();
  });

  it('a row from an older answer (no lines, no price) still draws, with the buttons it always had', async () => {
    serve({ batch: { orders: [{ id: 'o1', orderNumber: 'SY-2026-0001', trackingNumber: null, customer: { fullName: 'سارة' } }] } });
    await open();

    expect(screen.getByRole('button', { name: 'ألغِ' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /عدّل/ })).toBeNull();
  });
});

describe('«عدّل» is drawn for the key’s holder and nobody else', () => {
  it('NEGATIVE: without the key the row carries the information and no button', async () => {
    serve({ canEditInBatch: false });
    await open();

    expect(screen.getByText('أبو محمد')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /عدّل/ })).toBeNull();
  });

  it('with the key the button is on the row, beside the three ways off the trolley — which are untouched', async () => {
    serve({ canEditInBatch: true });
    await open();

    expect(screen.getByRole('button', { name: /عدّل/ })).toBeTruthy();
    const cancel = screen.getByRole('button', { name: 'ألغِ' });
    expect(cancel.parentElement!.querySelectorAll('button')).toHaveLength(3);
  });

  it('NEGATIVE: the key without the data to edit on (no version) draws no button', async () => {
    serve({ canEditInBatch: true, batch: { orders: [parcel({ version: undefined })] } });
    await open();

    expect(screen.queryByRole('button', { name: /عدّل/ })).toBeNull();
  });
});

describe('the form', () => {
  const press = async () => {
    serve({ canEditInBatch: true });
    await open();
    fireEvent.click(screen.getByRole('button', { name: /عدّل/ }));
    return screen.findByDisplayValue('أبو محمد', undefined, WAIT);
  };
  const sent = () => {
    const [url, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    return { url, init, body: JSON.parse(String(init.body)) as Record<string, any> };
  };

  it('opens on what the order has now, and offers the fields the key may change — and no price box', async () => {
    await press();

    expect(screen.getByDisplayValue('0791234567')).toBeTruthy();
    expect(screen.getByDisplayValue('شارع الجلاء')).toBeTruthy();
    expect(screen.getByDisplayValue('3')).toBeTruthy();
    expect(screen.queryByPlaceholderText('سعر السطر')).toBeNull();
    expect(screen.queryByText(/الخصم|أجرة التوصيل/)).toBeNull();
  });

  it('sends ONLY what changed, at the version it read, to the order’s own door', async () => {
    const name = await press();
    fireEvent.change(name, { target: { value: 'أبو محمد الأحمد' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const { url, init, body } = sent();
    expect(url).toBe('/api/orders/o1');
    expect(init.method).toBe('PATCH');
    expect(body).toEqual({ expectedVersion: 7, customerName: 'أبو محمد الأحمد' });
  });

  it('a quantity goes as a line with the figure the screen was given — it works nothing out', async () => {
    await press();
    fireEvent.click(screen.getByRole('button', { name: 'زد الكمية' }));
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(sent().body).toEqual({ expectedVersion: 7, items: [{ productId: 'prod-aaaa-1', quantity: 4, unitPrice: 36 }] });
  });

  it('the quantity never goes below one', async () => {
    await press();
    const box = screen.getByLabelText('كمية كريم الشعر') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '0' } });
    expect(box.value).toBe('1');
    fireEvent.change(box, { target: { value: '-4' } });
    expect(Number(box.value)).toBeGreaterThanOrEqual(1);
  });

  it('a new governorate is chosen from the country’s own list and sent by id', async () => {
    await press();
    const select = await waitFor(() => {
      const el = document.querySelector('select') as HTMLSelectElement;
      expect(within(el).getByText('دمشق')).toBeTruthy();
      return el;
    }, WAIT);
    fireEvent.change(select, { target: { value: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(sent().body).toEqual({ expectedVersion: 7, regionId: 'r2' });
  });

  it('saved: the form closes, the list is read again and the person is told it is on the order', async () => {
    const name = await press();
    fireEvent.change(name, { target: { value: 'أبو محمد الأحمد' } });
    const before = apiJson.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));

    await waitFor(() => expect(toastDone).toHaveBeenCalledTimes(1));
    expect(String(toastDone.mock.calls[0][0])).toContain('SY-2026-0001');
    await waitFor(() => expect(apiJson.mock.calls.length).toBeGreaterThan(before));
    expect(screen.queryByDisplayValue('أبو محمد الأحمد')).toBeNull();
  });

  it('nothing changed: it closes and writes nothing', async () => {
    await press();
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));

    await waitFor(() => expect(screen.queryByDisplayValue('أبو محمد')).toBeNull());
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('the shipment was closed between the read and the save: the door’s words stay on the form and the list is read again', async () => {
    apiFetch.mockResolvedValue({
      ok: false, status: 409, clone() { return this; },
      json: async () => ({ code: 'ORDER_SEALED', errorAr: 'الطلب سُلِّم لشركة الشحن ضمن دفعة مقفلة (BATCH-2026-0001). لتعديل اسم العميل ارفع طلب تعديل ليُبَتّ فيه.' }),
    });
    const name = await press();
    fireEvent.change(name, { target: { value: 'اسم آخر' } });
    const before = apiJson.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));

    expect(await screen.findByText(/ضمن دفعة مقفلة/, undefined, WAIT)).toBeTruthy();
    expect(toastDone).not.toHaveBeenCalled();
    await waitFor(() => expect(apiJson.mock.calls.length).toBeGreaterThan(before));
  });
});
