// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import type { DispatchOutcome, DispatchSummary } from '@/lib/couriers/dispatch';

/**
 * «إنشاء شحنة» ON THE KIT (R11b, 18/11) — the look moved, nothing the warehouse does did.
 *
 * Three claims, each against the rendered screen (no browser behind the login: jsdom only):
 *
 *   1. THE CENSUS. The same number of presses, tick boxes, fields, columns, links and dialogs as before the move, on a
 *      desk and on a phone, on both tabs. The figures were counted on `osm/main` before the first edit.
 *   2. THE WIRING. Every press reaches the handler it reached before, with the same arguments: the POST bodies, the
 *      urls and the dialogs are read off the mocks, row by row of a table.
 *   3. THE PHONE. At 375px no element carries a fixed width wider than the screen, and the row's two presses wrap
 *      inside the card.
 *
 * And the two leaf parts the slice owns: `DispatchResult` (shared with «دفعات الشحن») and the postpone dialog, whose
 * POST body must be byte-identical — its date box stays the hand-written one for that reason.
 */

const { apiJson, apiFetch, confirmFn, user, phone, dispatchFn, waybills } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  confirmFn: vi.fn(async (_o: unknown) => true),
  user: { current: null as unknown },
  phone: { value: false },
  dispatchFn: vi.fn(),
  waybills: vi.fn(async (_a: unknown, _b: unknown) => ({ count: 1, refused: [], opened: true })),
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/shipments/new',
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }),
}));
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 3 }) }));
vi.mock('@/components/ui/Confirm', () => ({
  useConfirm: () => confirmFn,
  useAsk: () => vi.fn(async () => null),
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: () => undefined }));
vi.mock('@/components/labels/LabelSize', () => ({
  useLabelSize: () => ({ dims: { width: 100, height: 150 } }),
  LabelSizePicker: () => null,
}));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: (a: unknown, b: unknown) => waybills(a, b),
  describeRefused: () => '',
  BLOCKED_WAYBILLS: 'x',
  WaybillError: class extends Error {},
}));
vi.mock('@/components/ops/dispatchInChunks', () => ({
  dispatchInChunks: (...a: unknown[]) => dispatchFn(...a),
  DispatchInterrupted: class extends Error {},
}));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  RejectDialog: ({ open, orderNumber }: { open: boolean; orderNumber: string }) =>
    open ? <div data-dialog="reject">{orderNumber}</div> : null,
}));
vi.mock('@/components/ops/DelayShipmentDialog', () => ({
  DelayShipmentDialog: ({ orderNumber }: { orderNumber: string }) => <div data-dialog="delay">{orderNumber}</div>,
}));

import { ShipmentsNewScreen } from './ShipmentsNewScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 20000 });

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  customer: { id: `c${id}`, fullName: `زبون ${id}`, phone: '0790000000', city: 'عمّان' },
  previousOrders: 0,
  region: { id: 'r1', name: 'عمّان' },
  address: 'شارع الجامعة',
  items: [{ productName: 'منتج', quantity: 1, freeQuantity: 0 }],
  cod: { subtotal: 20, discount: 2, deliveryFee: 3, cod: 21, currency: 'JOD', feeSource: 'region' },
  blocks: [],
  selectable: true,
  hardBlocked: false,
  shipHoldUntil: null,
  standDownBlocked: null,
  shipHoldReason: null,
  ...over,
});
const READY = [
  row('A'),
  row('B', { blocks: [{ code: 'ADDR', message: 'العنوان غير مكتمل', hard: false, hint: 'كمّله' }] }),
  row('C', { blocks: [{ code: 'NOFEE', message: 'لا أجرة لهذه المحافظة', hard: true }], hardBlocked: true, selectable: false }),
];
const HELD = [row('H', { shipHoldUntil: '2026-12-01T09:00:00.000Z', shipHoldReason: 'الزبون مسافر' })];

let courierApi = false;
beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  courierApi = false;
  user.current = {
    id: 'u1',
    status: 'ACTIVE',
    role: 'SUPER_ADMIN',
    permissions: ['ops.ship', 'ops.labels', 'customers.view'],
  };
  apiJson.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/ops/shipments') {
      return { batch: { id: 'b-1', batchNumber: 'B-26-0001' }, shipped: 1, exceptions: [{ orderNumber: 'ORD-Z', reasons: ['سبب'] }], courierApi };
    }
    if (init?.method === 'POST') return {};
    if (url.startsWith('/api/ops/shipments?')) return { orders: url.includes('held=only') ? HELD : READY, heldCount: 1 };
    return { providers: [{ id: 'p1', name: 'شركة أ' }], regions: [{ id: 'r1', name: 'عمّان' }] };
  });
  apiFetch.mockImplementation(async () => ({ ok: false, status: 409, json: async () => ({ errorAr: 'لا شيء' }) }));
  dispatchFn.mockImplementation(async (): Promise<DispatchSummary> => ({
    sent: 1, skipped: 0, failed: 0, outcomes: [{ orderId: 'A', orderNumber: 'ORD-A', ok: true }],
  }));
});
afterEach(cleanup);

const draw = async () => {
  render(<ShipmentsNewScreen />);
  await waitFor(() => expect(document.querySelector('tbody tr')).not.toBeNull(), WAIT);
  await waitFor(() => expect(document.querySelectorAll('option').length).toBeGreaterThan(3), WAIT);
};
const pickCourier = () => fireEvent.change(screen.getByLabelText(/شركة الشحن/), { target: { value: 'p1' } });
/** The table row's selection box of one order (the desk table; the cards repeat it). */
const tick = (id: string) => {
  const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes(`ORD-${id}`))!;
  fireEvent.click(within(tr as HTMLElement).getByLabelText('اختر السجل'));
};
const posts = (url: string) =>
  apiJson.mock.calls.filter(([u, init]) => u === url && (init as RequestInit | undefined)?.method === 'POST');

/** What a person can press, tick, type into, read in a column or open — counted on the rendered page. */
const census = () => ({
  presses: document.querySelectorAll('button').length,
  boxes: document.querySelectorAll('input[type="checkbox"]').length,
  fields: document.querySelectorAll('select, input:not([type="checkbox"])').length,
  columns: document.querySelectorAll('thead th').length,
  links: document.querySelectorAll('a').length,
  dialogs: document.querySelectorAll('[data-dialog]').length,
});

describe('«إنشاء شحنة» on the kit — the census is unchanged', () => {
  // Counted on osm/main (ca251b2d) before the first edit, with the same fixtures.
  it.each([
    ['desk · ready', false, 'ready', { presses: 22, boxes: 8, fields: 5, columns: 9, links: 7, dialogs: 0 }],
    ['phone · ready', true, 'ready', { presses: 21, boxes: 8, fields: 5, columns: 9, links: 7, dialogs: 0 }],
    ['desk · held', false, 'held', { presses: 8, boxes: 4, fields: 5, columns: 9, links: 2, dialogs: 0 }],
    ['phone · held', true, 'held', { presses: 7, boxes: 4, fields: 5, columns: 9, links: 2, dialogs: 0 }],
  ] as const)('%s', async (_name, onPhone, tab, expected) => {
    phone.value = onPhone;
    await draw();
    if (tab === 'held') {
      fireEvent.click(screen.getByRole('button', { name: /مؤجَّلة الشحن/ }));
      await waitFor(() => expect(document.body.textContent).toContain('ORD-H'), WAIT);
    }
    expect(census()).toEqual(expected);
  });
});

describe('«إنشاء شحنة» on the kit — every press reaches the same handler with the same arguments', () => {
  it('desk «إنشاء شحنة»: asks first, then posts the courier, the ticked ids and the acknowledged ones', async () => {
    await draw();
    pickCourier();
    tick('A');
    tick('B');
    fireEvent.click(within(document.querySelector('tbody')!).getAllByLabelText('أقرّ بالتنبيه وأتابع')[0]);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'إنشاء شحنة (2)' }));
    });
    await screen.findByText(/تم إنشاء الدفعة B-26-0001/, undefined, WAIT);
    expect(confirmFn).toHaveBeenCalledTimes(1);
    expect(posts('/api/ops/shipments')).toHaveLength(1);
    expect(JSON.parse(posts('/api/ops/shipments')[0][1].body)).toEqual({
      deliveryProviderId: 'p1',
      orderIds: ['A', 'B'],
      acknowledgedOrderIds: ['B'],
    });
    // The refusals panel is drawn from the answer.
    expect(screen.getByText('طلبات لم تُشحن (1)')).toBeTruthy();
  });

  it('a soft warning un-acknowledged is not sent as acknowledged; the box ticks and unticks its own row only', async () => {
    await draw();
    pickCourier();
    tick('B');
    const box = within(document.querySelector('tbody')!).getAllByLabelText('أقرّ بالتنبيه وأتابع')[0] as HTMLInputElement;
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'إنشاء شحنة (1)' }));
    });
    expect(JSON.parse(posts('/api/ops/shipments')[0][1].body).acknowledgedOrderIds).toEqual([]);
  });

  it('a hard-blocked order has no acknowledgement box and no selection box', async () => {
    await draw();
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('ORD-C'))!;
    expect(tr.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('the acknowledgement boxes carry ids no other element carries, and each label ticks its own box', async () => {
    await draw();
    const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const boxes = screen.getAllByLabelText('أقرّ بالتنبيه وأتابع') as HTMLInputElement[];
    expect(boxes.length).toBe(2); // the table cell and the card, both drawn
    fireEvent.click(boxes[1].closest('label')!);
    // One state, two drawings: both say ticked, and it was the card's own label that ticked it.
    await waitFor(() => expect(boxes.every((b) => b.checked)).toBe(true));
  });

  it('phone bar «إنشاء شحنة»: the same POST as the desk button', async () => {
    phone.value = true;
    await draw();
    pickCourier();
    tick('A');
    const bar = document.querySelector('[role="toolbar"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(bar).getByRole('button', { name: 'إنشاء شحنة (1)' }));
    });
    expect(JSON.parse(posts('/api/ops/shipments')[0][1].body)).toEqual({
      deliveryProviderId: 'p1',
      orderIds: ['A'],
      acknowledgedOrderIds: [],
    });
  });

  it('«مؤجَّلة الشحن» reads the held list; «جاهزة للشحن» reads the ready one again', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /مؤجَّلة الشحن/ }));
    await waitFor(() => expect(apiJson.mock.calls.some(([u]) => String(u).includes('held=only'))).toBe(true), WAIT);
    const before = apiJson.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'جاهزة للشحن' }));
    await waitFor(() => expect(apiJson.mock.calls.length).toBeGreaterThan(before), WAIT);
    expect(String(apiJson.mock.calls.at(-1)![0])).not.toContain('held=only');
  });

  it('the held tab carries the store-wide count with its sentence', async () => {
    await draw();
    const count = within(screen.getByRole('button', { name: /مؤجَّلة الشحن/ })).getByText('1');
    expect(count.getAttribute('title')).toBe('كل المؤجَّل بالمتجر — مش حسب البحث');
  });

  it('«CSV الجاهزة للشحن»: the export door with the filters, nothing ticked', async () => {
    await draw();
    pickCourier();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'CSV الجاهزة للشحن' }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/ops/shipments/export?courier=p1');
  });

  it('«CSV المحدَّدة»: the ticked ids in a body', async () => {
    await draw();
    pickCourier();
    tick('A');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /CSV المحدَّدة \(1\)/ }));
    });
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/ops/shipments/export');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ courier: 'p1', ids: ['A'] });
  });

  it('«أجّل» opens the postpone dialog on its own order', async () => {
    await draw();
    const tr = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('ORD-B'))!;
    fireEvent.click(within(tr as HTMLElement).getByRole('button', { name: /أجّل/ }));
    expect(document.querySelector('[data-dialog="delay"]')!.textContent).toBe('ORD-B');
  });

  it('«ألغِ» opens the reason dialog on its own order, and is shut where the server said so', async () => {
    READY[0] = row('A', { standDownBlocked: { code: 'TAKEN', message: 'الطرد مع الشركة' } });
    try {
      await draw();
      const trA = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('ORD-A'))! as HTMLElement;
      const shut = within(trA).getByRole('button', { name: /ألغِ/ }) as HTMLButtonElement;
      expect(shut.disabled).toBe(true);
      expect(shut.title).toBe('الطرد مع الشركة');
      const trB = [...document.querySelectorAll('tbody tr')].find((r) => r.textContent?.includes('ORD-B'))! as HTMLElement;
      fireEvent.click(within(trB).getByRole('button', { name: /ألغِ/ }));
      expect(document.querySelector('[data-dialog="reject"]')!.textContent).toBe('ORD-B');
    } finally {
      READY[0] = row('A');
    }
  });

  it('«أرجِعه» on the held tab posts the release of its own order', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /مؤجَّلة الشحن/ }));
    await waitFor(() => expect(document.querySelector('tbody')!.textContent).toContain('ORD-H'), WAIT);
    const tr = document.querySelector('tbody tr') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(tr).getByRole('button', { name: /أرجِعه/ }));
    });
    expect(JSON.parse(posts('/api/ops/shipments/hold')[0][1].body)).toEqual({ orderId: 'H', release: true });
  });

  const ship = async () => {
    await draw();
    pickCourier();
    tick('A');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'إنشاء شحنة (1)' }));
    });
    await screen.findByText(/تم إنشاء الدفعة B-26-0001/, undefined, WAIT);
  };

  it('desk banner «رحّل إلى الشركة واجلب الباركود»: the batch just made goes to the chunked send', async () => {
    courierApi = true;
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'رحّل إلى الشركة واجلب الباركود' }));
    });
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    expect(dispatchFn.mock.calls[0][0]).toBe('b-1');
    await screen.findByText('رُحّل 1', undefined, WAIT);
  });

  it('desk banner «اطبع البوالص»: the batch just made, on this device’s paper', async () => {
    await ship();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'اطبع البوالص' }));
    });
    expect(waybills).toHaveBeenCalledWith({ batchId: 'b-1', width: 100, height: 150 }, 'print');
  });

  it('PHONE at 375px: no fixed width past the screen, and the row presses sit in a grid that wraps', async () => {
    phone.value = true;
    await draw();
    const wide = [...document.querySelectorAll('[class]')]
      .flatMap((e) => (e.getAttribute('class') ?? '').split(/\s+/))
      .filter((c) => {
        const m = /^(?:min-)?w-\[(\d+)px\]$/.exec(c);
        return (m && Number(m[1]) > 375) || c === 'w-screen' || c === 'min-w-max';
      });
    expect(wide).toEqual([]);
    const li = document.querySelector('li') as HTMLElement;
    const postpone = within(li).getByRole('button', { name: /أجّل/ });
    expect(postpone.parentElement!.className).toContain('grid-cols-2');
  });
});

/* ═══════════════════════ the two leaf parts the slice owns ═══════════════════════ */

describe('DispatchResult on the kit', () => {
  it('the toggle opens and shuts its list; «تحقّقتُ» hands its own order to the screen', async () => {
    const { DispatchResult } = await import('@/components/ops/DispatchResult');
    const outcomes: DispatchOutcome[] = [
      { orderId: 'o1', orderNumber: 'ORD-1', ok: false, error: 'رفض' },
      { orderId: 'o2', orderNumber: 'ORD-2', ok: false, skipped: 'SEND_IN_FLIGHT' },
    ];
    const clear = vi.fn();
    render(<DispatchResult summary={{ sent: 0, skipped: 1, failed: 1, outcomes }} savedNote="x" onClearSend={clear} />);
    const toggles = screen.getAllByRole('button', { name: /اعرض الطلبات/ });
    expect(toggles).toHaveLength(2);
    fireEvent.click(toggles[0]);
    expect(toggles[0].getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'تحقّقتُ مع الشركة — لا طرد عندهم (ORD-2)' }));
    expect(clear).toHaveBeenCalledWith({ orderId: 'o2', orderNumber: 'ORD-2' });
    // presses: two toggles + one way out — the count it had.
    expect(document.querySelectorAll('button')).toHaveLength(3);
  });
});

describe('DelayShipmentDialog — the POST body is byte-identical', () => {
  it('«غداً» then «أجِّل»: the date at 09:00 local, the reason trimmed or absent', async () => {
    vi.doUnmock('@/components/ops/DelayShipmentDialog');
    vi.resetModules();
    const { DelayShipmentDialog } = await import('@/components/ops/DelayShipmentDialog');
    const choose = vi.fn();
    render(<DelayShipmentDialog orderNumber="ORD-1" busy={false} onClose={() => undefined} onChoose={choose} />);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    fireEvent.click(screen.getByRole('button', { name: 'غداً' }));
    fireEvent.click(screen.getByRole('button', { name: /أجِّل شحنَه إلى هذا الموعد/ }));
    expect(choose).toHaveBeenCalledWith({
      kind: 'POSTPONE',
      until: new Date(`${tomorrow}T09:00:00`).toISOString(),
      reason: undefined,
    });
    fireEvent.change(screen.getByPlaceholderText(/مثال/), { target: { value: '  مسافر  ' } });
    fireEvent.click(screen.getByRole('button', { name: /أجِّل شحنَه إلى هذا الموعد/ }));
    expect(choose.mock.calls[1][0].reason).toBe('مسافر');
    // Six presses (four quick days, the postpone, the dialog's close) and two fields, as before.
    expect(document.querySelectorAll('input')).toHaveLength(2);
    expect((document.querySelector('input[type="date"]') as HTMLInputElement).min).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
