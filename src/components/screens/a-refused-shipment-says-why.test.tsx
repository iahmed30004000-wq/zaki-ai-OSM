// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «إنشاء شحنة» — A REFUSAL NAMES ITS REASON, AND THE ROW NEVER SAYS «جاهز» FOR WHAT THE DOOR REFUSES.
 *
 * The door answered 409 «لا يوجد طلب صالح للشحن ضمن الاختيار» with the reason of each order in `exceptions`, and the
 * screen showed the generic sentence only. Now the panel «طلبات لم تُشحن» gets the order number and why, and the
 * list is read again; and a row the server marks unreserved shows the door's sentence, with what to do, instead of
 * «جاهز».
 */

const { apiJson, toastFailed, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  toastFailed: vi.fn(),
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/shipments/new', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: toastFailed, done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

const SHIPPER = { id: 'u2', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship'] };

const base = {
  merchantRef: null,
  customer: { id: 'c1', fullName: 'سامر خليل', phone: '0790000000', city: 'دمشق' },
  previousOrders: 0, region: { id: 'r1', name: 'دمشق' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'SYP', feeSource: 'region' },
  shipHoldUntil: null, standDownBlocked: null, shipHoldReason: null,
};
const ready = { ...base, id: '1', orderNumber: 'SY-2026-0002', blocks: [], selectable: true, hardBlocked: false };
const SAID = 'لا يمكن التجهيز: 1 سطر غير محجوز بالكامل';
const HINT = 'المخزون وصل بعد التأكيد: أجِّل الطلب ثم أرجِعه ليُعاد الحجز';
const unreserved = {
  ...base, id: '2', orderNumber: 'SY-2026-0001',
  blocks: [{ code: 'UNRESERVED_LINES', message: SAID, hard: true, hint: HINT }],
  selectable: false, hardBlocked: true,
};

/** An error as `apiJson` throws it: the sentence as the message, the whole body beside it. */
const refusal = (message: string, data: unknown) => Object.assign(new Error(message), { status: 409, data });

beforeEach(() => {
  vi.clearAllMocks();
  user.current = SHIPPER;
});
afterEach(cleanup);

function serve(orders: unknown[], post?: () => unknown) {
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const out = post?.();
      if (out instanceof Error) throw out;
      return out;
    }
    if (url.includes('/api/ops/shipments')) return { orders, heldCount: 0 };
    return { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'دمشق' }] };
  });
}

/** Whether the table row of this order has the green «جاهز» in it. */
const saysReady = (orderNumber: string) => {
  const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(orderNumber));
  return !!tr && [...tr.querySelectorAll('span')].some((n) => n.textContent === 'جاهز');
};

const press = async () => {
  fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
  fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
  await act(async () => {
    fireEvent.click(screen.getAllByText(/إنشاء شحنة \(/)[0]);
  });
};

describe('a row the door would refuse', () => {
  it('shows the door\'s sentence and what to do, not «جاهز», and has no checkbox', async () => {
    serve([unreserved, ready]);
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
    expect(screen.getAllByText(new RegExp(SAID)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp('أجِّل الطلب ثم أرجِعه')).length).toBeGreaterThan(0);
    // the other row is still «جاهز» — only one of the two says it
    expect(saysReady('SY-2026-0001')).toBe(false);
    expect(saysReady('SY-2026-0002')).toBe(true);
    // header box + the ready row's box; the refused row has none
    expect(document.querySelectorAll('tbody input[type="checkbox"]')).toHaveLength(1);
  });

  it('a ready order is unchanged: «جاهز», selectable', async () => {
    serve([ready]);
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
    expect(saysReady('SY-2026-0002')).toBe(true);
    expect(screen.queryByText(new RegExp(SAID))).toBeNull();
  });
});

describe('a refused press', () => {
  it('puts each order\'s reason in «طلبات لم تُشحن» and reads the list again', async () => {
    serve([ready], () =>
      refusal('لا يوجد طلب صالح للشحن ضمن الاختيار', {
        error: 'لا يوجد طلب صالح للشحن ضمن الاختيار',
        code: 'ALL_BLOCKED',
        exceptions: [{ orderId: '1', orderNumber: 'SY-2026-0002', reasons: [SAID] }],
      })
    );
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
    const listReads = () => apiJson.mock.calls.filter((c) => String(c[0]).startsWith('/api/ops/shipments?')).length;
    const before = listReads();
    await press();

    expect(await screen.findByText(/طلبات لم تُشحن \(1\)/, undefined, WAIT)).toBeTruthy();
    expect(screen.getByText('SY-2026-0002', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText(new RegExp(`— ${SAID}`))).toBeTruthy();
    // not the generic sentence alone
    expect(toastFailed).not.toHaveBeenCalledWith('لا يوجد طلب صالح للشحن ضمن الاختيار');
    await waitFor(() => expect(listReads()).toBeGreaterThan(before), WAIT);
  });

  it('NEGATIVE: a failure with no reasons is still the plain message', async () => {
    serve([ready], () => refusal('انتهت المهلة', { error: 'انتهت المهلة' }));
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
    await press();
    await waitFor(() => expect(toastFailed).toHaveBeenCalledWith('انتهت المهلة'));
    expect(screen.queryByText(/طلبات لم تُشحن/)).toBeNull();
  });

  it('NEGATIVE: an error that is not from the API (no body) is the plain message too', async () => {
    serve([ready], () => new Error('انقطع الاتصال'));
    render(<ShipmentsNewScreen />);
    await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
    await press();
    await waitFor(() => expect(toastFailed).toHaveBeenCalledWith('انقطع الاتصال'));
  });
});
