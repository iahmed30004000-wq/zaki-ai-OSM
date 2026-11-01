// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «اطبع البوالص» — IN THE BANNER THAT SAYS THE SHIPMENT WAS MADE.
 *
 * «تم إنشاء الدفعة X بـ N طلب» ended there and a link took the person to the batches
 * screen to find the print button. The button is the banner's now: the same call the batches
 * screen makes (the batch by id, on this device's paper), in the click that opens the sheet.
 * Printing changes no state — it is the safe half of the handover; «سُلّمت الآن» (which does)
 * stays on the batches screen, by the owner's choice.
 */

const { apiJson, openWaybills, tell, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  openWaybills: vi.fn(),
  tell: vi.fn(),
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/shipments/new', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => vi.fn(async () => true),
  useAsk: () => vi.fn(async () => null),
  useTell: () => tell,
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({ DelayShipmentDialog: () => null }));
vi.mock('@/components/labels/openWaybills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/labels/openWaybills')>()),
  openWaybills: (...a: unknown[]) => openWaybills(...a),
}));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';
import { BLOCKED_WAYBILLS, WaybillError } from '@/components/labels/openWaybills';

/**
 * This screen is drawn, shipped and printed in one test, and the full suite runs hundreds of files in
 * parallel: Testing Library's one-second default is enough alone and not under that load (the blocked
 * pop-up claim failed once in a full run and passed three times alone). The claims are unchanged;
 * only how long each waits for the screen to catch up.
 */
const WAIT = { timeout: 8000 };

const PRINTER = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship', 'ops.labels'] };
const SHIPPER = { id: 'u2', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.ship'] };

const row = {
  id: '1', orderNumber: 'ORD-1', merchantRef: 'ORD-1',
  customer: { id: 'c1', fullName: 'سامر خليل', phone: '0790000000', city: 'عمّان' },
  previousOrders: 0, region: { id: 'r1', name: 'عمّان' },
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 0, deliveryFee: 0, cod: 20, currency: 'JOD', feeSource: 'region' },
  blocks: [], selectable: true, hardBlocked: false, shipHoldUntil: null, standDownBlocked: null, shipHoldReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  user.current = PRINTER;
  openWaybills.mockResolvedValue({ count: 1, refused: [], opened: true });
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { batch: { id: 'b-1', batchNumber: 'B-26-0001' }, shipped: 1, exceptions: [] };
    if (url.includes('/api/ops/shipments')) return { orders: [row], heldCount: 0 };
    return { providers: [{ id: 'p1', name: 'شركة الشحن أ' }], regions: [{ id: 'r1', name: 'عمّان' }] };
  });
});
afterEach(cleanup);

// the whole test, not just a wait inside it, gets the same room
vi.setConfig({ testTimeout: 15000 });

/** Ship the one order, ending on the banner. */
async function ship() {
  render(<ShipmentsNewScreen />);
  await waitFor(() => expect(screen.queryAllByText(/سامر خليل/).length).toBeGreaterThan(0), WAIT);
  fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
  fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
  await act(async () => {
    fireEvent.click(screen.getAllByText(/إنشاء شحنة \(/)[0]);
  });
  await screen.findByText(/تم إنشاء الدفعة B-26-0001/, undefined, WAIT);
}

describe('the banner', () => {
  it('prints the batch that was just made — by its id, inside the click', async () => {
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اطبع البوالص' }));
    });
    expect(openWaybills).toHaveBeenCalledTimes(1);
    const [req, mode] = openWaybills.mock.calls[0];
    expect(req.batchId).toBe('b-1');
    expect(req.width).toBeGreaterThan(0);
    expect(mode).toBe('print');
    expect(screen.queryByText(BLOCKED_WAYBILLS)).toBeNull();
  });

  it('prints and nothing else — no handover is written from here', async () => {
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اطبع البوالص' }));
    });
    const writes = apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(writes).toHaveLength(1); // the shipment itself, and nothing after it
    expect(screen.queryByRole('button', { name: /سُلّمت/ })).toBeNull();
  });

  it('a blocked pop-up is said, not celebrated', async () => {
    openWaybills.mockResolvedValue({ count: 1, refused: [], opened: false });
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اطبع البوالص' }));
    });
    expect(await screen.findByText(BLOCKED_WAYBILLS, undefined, WAIT)).toBeTruthy();
  });

  it('what the door refused to print is named', async () => {
    openWaybills.mockResolvedValue({ count: 1, refused: [{ orderNumber: 'ORD-9', reason: 'بلا شركة شحن' }], opened: true });
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اطبع البوالص' }));
    });
    expect(tell).toHaveBeenCalledTimes(1);
    expect(tell.mock.calls[0][0].body).toContain('ORD-9 (بلا شركة شحن)');
  });

  it('a failure to prepare them is an error line, and the button is usable again', async () => {
    openWaybills.mockRejectedValue(new WaybillError('تعذر تجهيز البوالص'));
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اطبع البوالص' }));
    });
    expect(await screen.findByText('تعذر تجهيز البوالص', undefined, WAIT)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'اطبع البوالص' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('NEGATIVE: somebody who may ship but not print gets the way to the batches, not a button its door refuses', async () => {
    user.current = SHIPPER;
    await ship();
    expect(screen.queryByRole('button', { name: 'اطبع البوالص' })).toBeNull();
    expect(screen.getByRole('link', { name: 'اطبع البوالص' }).getAttribute('href')).toBe('/ops/batches');
    expect(openWaybills).not.toHaveBeenCalled();
  });

  it('a manual courier is offered no «رحّل» — there is no server to send to', async () => {
    await ship();
    expect(screen.queryByRole('button', { name: /رحّل إلى الشركة/ })).toBeNull();
  });
});

/**
 * «رحّل» BEFORE «اطبع», FOR A COURIER WITH A SERVER.
 *
 * Printed before dispatch, the waybill's barcode row carries our reference
 * (the courier's code falls back to it): a label Basha cannot scan, so the
 * warehouse printed Basha's own — which has no QR of ours.
 */
describe('a courier sent to by API', () => {
  const summary = {
    sent: 1, skipped: 1, failed: 0,
    outcomes: [
      { orderId: '1', orderNumber: 'ORD-1', ok: true, trackingCode: 'BSH1' },
      { orderId: '2', orderNumber: 'ORD-2', ok: false, skipped: 'NO_COURIER_CITY', regionName: 'السويداء' },
    ],
  };

  /** Which orders of the batch are left (the screen asks before it sends): the two the answer below is about. */
  const plan = { pending: summary.outcomes.map((o) => ({ id: o.orderId, orderNumber: o.orderNumber })), sent: [] };

  beforeEach(() => {
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/dispatch') && !init?.method) return plan;
      if (init?.method === 'POST' && url.endsWith('/dispatch')) return summary;
      if (init?.method === 'POST') return { batch: { id: 'b-1', batchNumber: 'B-26-0001' }, shipped: 1, exceptions: [], courierApi: true };
      if (url.includes('/api/ops/shipments')) return { orders: [row], heldCount: 0 };
      return { providers: [{ id: 'p1', name: 'الباشا' }], regions: [{ id: 'r1', name: 'عمّان' }] };
    });
  });

  it('offers «رحّل» first and says why — and no print, because the door would refuse an order with no barcode of theirs', async () => {
    await ship();
    expect(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' })).toBeTruthy();
    expect(screen.getByText(/طلب بلا باركود الشركة لا يُطبع/)).toBeTruthy();
    // The print used to be offered "without their barcode"; the waybill must carry it beside our QR.
    expect(screen.queryByRole('button', { name: /اطبع/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'اطبع بلا باركود الشركة' })).toBeNull();
  });

  it('sends the batch just made through the batches door, then shows each order and offers the plain print', async () => {
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    // it asks which orders are left, then sends them (the two of this batch fit one piece)
    const asked = apiJson.mock.calls.find((c) => String(c[0]).endsWith('/dispatch') && !(c[1] as RequestInit | undefined)?.method);
    expect(asked?.[0]).toBe('/api/ops/shipments/b-1/dispatch');
    const sent = apiJson.mock.calls.find((c) => String(c[0]).endsWith('/dispatch') && (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(sent?.[0]).toBe('/api/ops/shipments/b-1/dispatch');
    expect(JSON.parse((sent?.[1] as RequestInit).body as string)).toEqual({ orderIds: ['1', '2'] });
    expect(await screen.findByText(/رُحّل 1/, undefined, WAIT)).toBeTruthy();
    // the same sentence the batches screen gives for a governorate with no id
    expect(screen.getByText(/السويداء: لا رمز لها عند الشركة بعد/)).toBeTruthy();
    // one went, so the print is the plain one; one did not, so the retry stays
    expect(screen.getByRole('button', { name: 'اطبع البوالص' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'أعد ترحيل الباقي (1)' })).toBeTruthy();
  });

  it('when every order went, «رحّل» is gone', async () => {
    const allSent = { sent: 1, skipped: 0, failed: 0, outcomes: [{ orderId: '1', orderNumber: 'ORD-1', ok: true, trackingCode: 'BSH1' }] };
    const base = apiJson.getMockImplementation()!;
    apiJson.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && url.endsWith('/dispatch') ? allSent : base(url, init),
    );
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    await screen.findByText(/رُحّل 1/, undefined, WAIT);
    expect(screen.queryByRole('button', { name: /رحّل/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'اطبع البوالص' })).toBeTruthy();
  });

  it('when nothing went, there is still nothing to print, and the retry stays', async () => {
    const noneSent = { sent: 0, skipped: 0, failed: 1, outcomes: [{ orderId: '1', orderNumber: 'ORD-1', ok: false, error: 'رقم الهاتف غير صالح' }] };
    const base = apiJson.getMockImplementation()!;
    apiJson.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && url.endsWith('/dispatch') ? noneSent : base(url, init),
    );
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    await screen.findByText(/رُحّل 0/, undefined, WAIT);
    expect(screen.getByText(/رقم الهاتف غير صالح/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /اطبع/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'أعد ترحيل الباقي (1)' })).toBeTruthy();
  });

  it('the answer is the shared grouped box: one line per reason with its count, the order numbers closed behind a button', async () => {
    const refused = Array.from({ length: 3 }, (_, i) => ({
      orderId: `r${i}`, orderNumber: `ORD-R${i}`, ok: false, error: 'الباشا رفض: رقم تعريف الشركة غير صحيح (400)',
    }));
    const answer = { sent: 0, skipped: 0, failed: 3, outcomes: refused };
    const base = apiJson.getMockImplementation()!;
    apiJson.mockImplementation(async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && url.endsWith('/dispatch') ? answer : base(url, init),
    );
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    expect(await screen.findByText('3 طلب — الباشا رفض: رقم تعريف الشركة غير صحيح (400)', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByText('ORD-R0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'اعرض الطلبات (3)' }));
    expect(screen.getByText('ORD-R0')).toBeTruthy();
  });

  it('an answer still on its way for the first batch does not land on a second one made meanwhile', async () => {
    let answer: (v: unknown) => void = () => undefined;
    let made = 0;
    apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/dispatch') && !init?.method) return plan;
      if (init?.method === 'POST' && url.endsWith('/dispatch')) return new Promise((r) => { answer = r; });
      if (init?.method === 'POST') {
        made += 1;
        return { batch: { id: `b-${made}`, batchNumber: `B-26-000${made}` }, shipped: 1, exceptions: [], courierApi: true };
      }
      if (url.includes('/api/ops/shipments')) return { orders: [row], heldCount: 0 };
      return { providers: [{ id: 'p1', name: 'الباشا' }], regions: [{ id: 'r1', name: 'عمّان' }] };
    });
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    // a second batch, while the first one's answer is still out
    await waitFor(() => expect(document.querySelector('thead input[type="checkbox"]')).toBeTruthy(), WAIT);
    fireEvent.click(document.querySelector('thead input[type="checkbox"]') as HTMLInputElement);
    await act(async () => {
      fireEvent.click(screen.getAllByText(/إنشاء شحنة \(/)[0]);
    });
    await screen.findByText(/تم إنشاء الدفعة B-26-0002/, undefined, WAIT);
    await act(async () => {
      answer(summary);
    });
    expect(screen.queryByText(/رُحّل 1/)).toBeNull();
    const send = screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it('NEGATIVE: «رحّل» opens no print and writes no handover', async () => {
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    await screen.findByText(/رُحّل 1/, undefined, WAIT);
    expect(openWaybills).not.toHaveBeenCalled();
    const writes = apiJson.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(writes.map((c) => c[0])).toEqual(['/api/ops/shipments', '/api/ops/shipments/b-1/dispatch']);
  });
});
