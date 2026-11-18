// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «دفعات الشحن» ON THE KIT (R11c, plan 17/11) — the look moved, the work did not.
 *
 *   (a) the same number of presses, boxes, fields, links and windows before and after, on a desk and on a phone, with the
 *       parcels of a batch closed and open, and in the two windows the card opens (the barcode paste, the parcel edit);
 *   (b) every press reaches the same handler with the same arguments: the same address, the same method, the same body;
 *   (g) at 375px nothing on the screen is wider than the screen, and the presses wrap.
 *
 * The numbers in COUNTS were read on `osm/main` (323e5423) BEFORE the first edit of R11c, by this same file.
 */

const { apiJson, apiFetch, held, phone, asked, dispatchInChunks, openWaybills, patch, toast } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  held: new Set<string>(),
  phone: { value: false },
  asked: { answers: [] as (string | null)[] },
  dispatchInChunks: vi.fn(),
  openWaybills: vi.fn(),
  patch: vi.fn(),
  toast: { failed: vi.fn(), done: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/ops/batches',
}));
vi.mock('@/components/ui/Confirm', () => ({
  useAsk: () => async () => asked.answers.shift() ?? null,
  useConfirm: () => async () => true,
  useTell: () => vi.fn(),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => held.has(k) }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [{ id: 'r1', name: 'دمشق' }], countryName: 'سوريا' }) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: null }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => { void load(); }, [load]);
  },
}));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => ({ dims: { width: 100, height: 150 } }), LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  BLOCKED_WAYBILLS: 'x',
  describeRefused: () => '',
  openWaybills: (...a: unknown[]) => openWaybills(...a),
  WaybillError: class extends Error {},
}));
vi.mock('@/components/ops/dispatchInChunks', () => ({
  dispatchInChunks: (...a: unknown[]) => dispatchInChunks(...a),
  DispatchInterrupted: class extends Error {},
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => patch }));
vi.mock('@/components/scan/ScanButton', () => ({
  ScanSheet: ({ title }: { title: string }) => <div data-scan="">{title}</div>,
}));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { ShippingBatchesScreen } from './ShippingBatchesScreen';
import { CARD_CLASS } from '@/lib/theme-shape';

const WAIT = { timeout: 8000 };
const ALL_KEYS = ['ops.batches', 'customers.view', 'orders.change_status', 'ops.ship'];

/** Three batches: an open one at a connected courier, one handed over with parcels at «مشحون», and an empty open trolley. */
const BATCHES = [
  {
    id: 'b1', batchNumber: 'BATCH-2026-0001', status: 'READY',
    provider: { id: 'dp1', name: 'الشركة أ', code: 'A', kind: 'COMPANY', apiEnabled: true },
    creator: { id: 'u1', name: 'موظفة' }, createdAt: '2026-11-01T10:00:00.000Z', shippedAt: null, notes: 'ملاحظة',
    _count: { orders: 2 }, courierCityGap: null, shippedCount: 0,
  },
  {
    id: 'b2', batchNumber: 'BATCH-2026-0002', status: 'SHIPPED',
    provider: { id: 'dp2', name: 'مندوب', code: 'M', kind: 'AGENT', apiEnabled: false },
    creator: null, createdAt: '2026-11-01T10:00:00.000Z', shippedAt: '2026-11-02T10:00:00.000Z', notes: null,
    _count: { orders: 3 }, courierCityGap: null, shippedCount: 3,
  },
  {
    id: 'b3', batchNumber: 'BATCH-2026-0003', status: 'READY',
    provider: { id: 'dp2', name: 'مندوب', code: 'M', kind: 'AGENT', apiEnabled: false },
    creator: null, createdAt: '2026-11-01T10:00:00.000Z', shippedAt: null, notes: null,
    _count: { orders: 0 }, courierCityGap: null, shippedCount: 0,
  },
];

const parcel = (id: string, number: string) => ({
  id, orderNumber: number, trackingNumber: null, version: 4, regionId: 'r1', region: { id: 'r1', name: 'دمشق' },
  customer: { fullName: 'زبون', phone: '0900000000', altPhone: null, address: 'شارع', city: 'دمشق' },
  items: [{ productId: 'p1', productName: 'منتج', quantity: 2, freeQuantity: 0, unitPrice: 10 }],
  totalAmount: 20,
});

const serve = () =>
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.endsWith('/tracking')) {
      const sent = JSON.parse(init?.body ?? '{}') as { dryRun: boolean };
      return { dryRun: sent.dryRun, counts: { written: 1, unchanged: 0, refused: 0 }, lines: [{ line: 1, ref: 'ORD-1', outcome: 'written' }] };
    }
    if (url.endsWith('/out-for-delivery')) return { total: 3, moved: 3, skipped: 0, failed: 0, failedOrders: [], failures: [] };
    if (init?.method) return {};
    if (url.startsWith('/api/shipping-batches/')) {
      return { batch: { orders: [parcel('o1', 'ORD-2026-0001'), parcel('o2', 'ORD-2026-0002')] }, canEditInBatch: true, currency: null };
    }
    return { batches: BATCHES, pagination: { total: BATCHES.length } };
  });

const draw = async () => {
  render(<ShippingBatchesScreen />);
  await screen.findByText('BATCH-2026-0001', undefined, WAIT);
};
const card = (n: string) => screen.getByText(n).closest('li') as HTMLElement;
const press = (root: HTMLElement, name: string | RegExp) => within(root).getByRole('button', { name }) as HTMLButtonElement;
const openParcels = async () => {
  fireEvent.click(press(card('BATCH-2026-0001'), /طرود الدفعة/));
  await screen.findByText('ORD-2026-0001', undefined, WAIT);
};

/** What a person can press, tick, type in, follow and open — the census the DoD's table (a) is made of. */
const census = () => {
  const all = (sel: string) => Array.from(document.body.querySelectorAll(sel));
  return {
    presses: all('button').length,
    boxes: all('input[type="checkbox"]').length,
    fields: all('input:not([type="checkbox"]), select, textarea').length,
    links: all('a[href]').length,
    windows: all('[role="dialog"]').length,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  held.clear();
  ALL_KEYS.forEach((k) => held.add(k));
  phone.value = false;
  asked.answers = [];
  serve();
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}), blob: async () => new Blob() });
  openWaybills.mockResolvedValue({ opened: true, refused: [], count: 2 });
  dispatchInChunks.mockResolvedValue({ sent: 2, skipped: 0, failed: 0, outcomes: [] });
  patch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});
afterEach(cleanup);

/* ═══════════ (a) the same number of everything ═══════════ */

const COUNTS: Record<string, ReturnType<typeof census>> = {
  'desk · closed': { presses: 26, boxes: 0, fields: 0, links: 1, windows: 0 },
  'desk · parcels open': { presses: 36, boxes: 0, fields: 1, links: 1, windows: 0 },
  'desk · paste window': { presses: 40, boxes: 1, fields: 2, links: 1, windows: 1 },
  'desk · edit window': { presses: 41, boxes: 0, fields: 7, links: 1, windows: 1 },
  'phone · closed': { presses: 26, boxes: 0, fields: 0, links: 1, windows: 0 },
  'phone · parcels open': { presses: 36, boxes: 0, fields: 1, links: 1, windows: 0 },
};

describe('(a) the census, before = after', () => {
  it.each([false, true])('phone=%s: closed, then the parcels open', async (isPhone) => {
    phone.value = isPhone;
    const where = isPhone ? 'phone' : 'desk';
    await draw();
    expect(census(), `${where} · closed`).toEqual(COUNTS[`${where} · closed`]);
    await openParcels();
    expect(census(), `${where} · parcels open`).toEqual(COUNTS[`${where} · parcels open`]);
  });

  it('desk: the barcode paste window', async () => {
    await draw();
    await openParcels();
    fireEvent.click(press(card('BATCH-2026-0001'), 'لصق الباركودات'));
    await screen.findByRole('dialog', undefined, WAIT);
    expect(census()).toEqual(COUNTS['desk · paste window']);
  });

  it('desk: the parcel edit window', async () => {
    await draw();
    await openParcels();
    fireEvent.click(within(card('BATCH-2026-0001')).getAllByRole('button', { name: /عدّل/ })[0]);
    await screen.findByRole('dialog', undefined, WAIT);
    expect(census()).toEqual(COUNTS['desk · edit window']);
  });
});

/* ═══════════ (b) every press, the same handler, the same arguments ═══════════ */

const callsTo = (fn: ReturnType<typeof vi.fn>, url: string) => fn.mock.calls.filter((c) => c[0] === url);

describe('(b) every press of a batch card', () => {
  it.each([false, true])('phone=%s · print, PDF, CSV: the batch by id, this paper, the mode', async (isPhone) => {
    phone.value = isPhone;
    await draw();
    const c = card('BATCH-2026-0001');
    fireEvent.click(press(c, /طباعة بوالص الدفعة/));
    await waitFor(() => expect(openWaybills).toHaveBeenCalledWith({ batchId: 'b1', width: 100, height: 150 }, 'print'));
    fireEvent.click(press(c, 'PDF'));
    await waitFor(() => expect(openWaybills).toHaveBeenCalledWith({ batchId: 'b1', width: 100, height: 150 }, 'pdf'));
    fireEvent.click(press(c, 'CSV'));
    await waitFor(() => expect(openWaybills).toHaveBeenCalledWith({ batchId: 'b1', width: 100, height: 150 }, 'csv'));
    expect(openWaybills).toHaveBeenCalledTimes(3);
  });

  it('«تحقّق من الطرود» reads the batch and opens the scanner on it', async () => {
    await draw();
    fireEvent.click(press(card('BATCH-2026-0001'), /تحقّق من الطرود/));
    expect((await screen.findByText('تحقّق من طرود BATCH-2026-0001', undefined, WAIT)).hasAttribute('data-scan')).toBe(true);
    expect(apiJson).toHaveBeenCalledWith('/api/shipping-batches/b1');
  });

  it('«إكسل» fetches this batch’s file', async () => {
    await draw();
    fireEvent.click(press(card('BATCH-2026-0002'), 'إكسل'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/shipping-batches/b2/export'));
  });

  it('«رحّل إلى الشركة» sends this batch in chunks', async () => {
    await draw();
    fireEvent.click(press(card('BATCH-2026-0001'), 'رحّل إلى الشركة واجلب الباركود'));
    await waitFor(() => expect(dispatchInChunks).toHaveBeenCalledTimes(1));
    expect(dispatchInChunks.mock.calls[0][0]).toBe('b1');
    expect(typeof dispatchInChunks.mock.calls[0][1]).toBe('function');
  });

  it.each([false, true])('phone=%s · «إغلاق الشحنة» sends one PATCH of status SHIPPED for this batch', async (isPhone) => {
    phone.value = isPhone;
    await draw();
    fireEvent.click(press(card('BATCH-2026-0001'), /إغلاق الشحنة — سُلّمت للشركة/));
    await waitFor(() => expect(callsTo(apiJson, '/api/shipping-batches/b1').filter((c) => c[1])).toHaveLength(1));
    const [, init] = callsTo(apiJson, '/api/shipping-batches/b1').find((c) => c[1])!;
    expect(init).toEqual({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'SHIPPED' }) });
  });

  it('«خرج للتوصيل لكل الدفعة» posts the batch out, once', async () => {
    await draw();
    fireEvent.click(press(card('BATCH-2026-0002'), 'خرج للتوصيل لكل الدفعة (3)'));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith('/api/shipping-batches/b2/out-for-delivery', { method: 'POST', timeoutMs: 60_000 })
    );
    expect(callsTo(apiJson, '/api/shipping-batches/b2/out-for-delivery')).toHaveLength(1);
  });

  it('«احذف الدفعة» deletes the empty one, and only it', async () => {
    await draw();
    fireEvent.click(press(card('BATCH-2026-0003'), 'احذف الدفعة'));
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/shipping-batches/b3', { method: 'DELETE' }));
    expect(apiJson.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'DELETE')).toHaveLength(1);
  });

  it('the state strip filters the list, and «الكل» brings it back', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'سُلّمت (1)' }));
    await waitFor(() => expect(screen.queryByText('BATCH-2026-0001')).toBeNull());
    expect(screen.getByText('BATCH-2026-0002')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'قيد التجميع (2)' }));
    await screen.findByText('BATCH-2026-0003', undefined, WAIT);
    expect(screen.queryByText('BATCH-2026-0002')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'الكل (3)' }));
    await screen.findByText('BATCH-2026-0002', undefined, WAIT);
  });

  it('the parcels press opens this batch’s list and the second press closes it', async () => {
    await draw();
    await openParcels();
    expect(apiJson).toHaveBeenCalledWith('/api/shipping-batches/b1');
    fireEvent.click(press(card('BATCH-2026-0001'), 'أخفِ الطرود'));
    await waitFor(() => expect(screen.queryByText('ORD-2026-0001')).toBeNull());
  });

  it.each([
    ['ألغِ', 'سبب', '/api/ops/shipments/stand-down', { orderId: 'o2', outcome: 'CANCEL', reason: 'OTHER', note: 'سبب' }],
    ['أعِده للمتابعة', '3', '/api/ops/shipments/stand-down', { orderId: 'o2', outcome: 'POSTPONE' }],
    ['أجّل الشحن', '3', '/api/ops/shipments/hold', { orderId: 'o2' }],
  ] as const)('«%s» on the SECOND parcel takes that parcel off, by its own door', async (name, typed, url, body) => {
    await draw();
    await openParcels();
    asked.answers = [typed];
    const second = screen.getByText('ORD-2026-0002').closest('li') as HTMLElement;
    fireEvent.click(press(second, name));
    await waitFor(() => expect(callsTo(apiFetch, url)).toHaveLength(1));
    const sent = JSON.parse((callsTo(apiFetch, url)[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(sent).toMatchObject(body);
    if (name !== 'ألغِ') expect(typeof sent.until).toBe('string');
  });
});

describe('(b) the barcode paste window', () => {
  const openPaste = async () => {
    await draw();
    fireEvent.click(press(card('BATCH-2026-0002'), 'لصق الباركودات'));
    return (await screen.findByRole('dialog', undefined, WAIT)) as HTMLElement;
  };

  it('«تحقّق» sends the text as a dry run; «اكتب» the same text for real; the box adds overwrite', async () => {
    const dlg = await openPaste();
    fireEvent.change(within(dlg).getByLabelText('الباركودات'), { target: { value: 'ORD-1, 123' } });
    expect(press(dlg, 'اكتب').disabled).toBe(true);
    fireEvent.click(press(dlg, 'تحقّق'));
    await waitFor(() => expect(callsTo(apiJson, '/api/shipping-batches/b2/tracking')).toHaveLength(1));
    expect(JSON.parse((callsTo(apiJson, '/api/shipping-batches/b2/tracking')[0][1] as { body: string }).body)).toEqual({ text: 'ORD-1, 123', dryRun: true });
    fireEvent.click(await within(dlg).findByRole('button', { name: 'اكتب (1)' }, WAIT));
    await waitFor(() => expect(callsTo(apiJson, '/api/shipping-batches/b2/tracking')).toHaveLength(2));
    expect(JSON.parse((callsTo(apiJson, '/api/shipping-batches/b2/tracking')[1][1] as { body: string }).body)).toEqual({ text: 'ORD-1, 123', dryRun: false });
  });

  it('a click on the box’s words ticks it, and the next check carries overwrite: true', async () => {
    const dlg = await openPaste();
    fireEvent.change(within(dlg).getByLabelText('الباركودات'), { target: { value: 'ORD-1, 123' } });
    const box = within(dlg).getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(within(dlg).getByText('استبدل الباركود القديم إذا الطلب عليه باركود تاني'));
    expect(box.checked).toBe(true);
    fireEvent.click(press(dlg, 'تحقّق'));
    await waitFor(() => expect(callsTo(apiJson, '/api/shipping-batches/b2/tracking')).toHaveLength(1));
    expect(JSON.parse((callsTo(apiJson, '/api/shipping-batches/b2/tracking')[0][1] as { body: string }).body)).toEqual({
      text: 'ORD-1, 123', dryRun: true, overwrite: true,
    });
  });

  it('«إغلاق» closes it and sends nothing', async () => {
    const dlg = await openPaste();
    fireEvent.click(within(dlg).getAllByRole('button', { name: 'إغلاق' }).find((b) => b.textContent?.trim() === 'إغلاق')!);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo(apiJson, '/api/shipping-batches/b2/tracking')).toHaveLength(0);
  });

  it('its three presses say type="button" (the kit sets none), and the box has its own id per batch', async () => {
    const dlg = await openPaste();
    for (const name of ['تحقّق', 'اكتب']) expect(press(dlg, name).getAttribute('type'), name).toBe('button');
    const close = within(dlg).getAllByRole('button', { name: 'إغلاق' }).find((b) => b.textContent?.trim() === 'إغلاق')!;
    expect(close.getAttribute('type')).toBe('button');
    expect(within(dlg).getByRole('checkbox').id).toBe('batch-paste-overwrite-b2');
  });

  it('NEGATIVE: an empty paste cannot be checked', async () => {
    const dlg = await openPaste();
    expect(press(dlg, 'تحقّق').disabled).toBe(true);
  });
});

describe('(b) the parcel edit window', () => {
  const openEdit = async () => {
    await draw();
    await openParcels();
    const second = screen.getByText('ORD-2026-0002').closest('li') as HTMLElement;
    fireEvent.click(press(second, /عدّل/));
    return (await screen.findByRole('dialog', undefined, WAIT)) as HTMLElement;
  };

  it('«زد» then «أنقص» then «زد» leaves one more piece, and «احفظ» sends that line at its own price, for that order and version', async () => {
    const dlg = await openEdit();
    fireEvent.click(press(dlg, 'زد الكمية'));
    fireEvent.click(press(dlg, 'زد الكمية'));
    fireEvent.click(press(dlg, 'أنقص الكمية'));
    fireEvent.click(press(dlg, 'احفظ التعديل'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith('o2', { expectedVersion: 4, items: [{ productId: 'p1', quantity: 3, unitPrice: 10 }] });
  });

  it('NEGATIVE: «أنقص» never goes under one piece', async () => {
    const dlg = await openEdit();
    fireEvent.click(press(dlg, 'أنقص الكمية'));
    fireEvent.click(press(dlg, 'أنقص الكمية'));
    fireEvent.click(press(dlg, 'أنقص الكمية'));
    fireEvent.click(press(dlg, 'احفظ التعديل'));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toEqual({ expectedVersion: 4, items: [{ productId: 'p1', quantity: 1, unitPrice: 10 }] });
  });

  it('«إلغاء» closes it and sends nothing; nothing changed + «احفظ» sends nothing either', async () => {
    let dlg = await openEdit();
    fireEvent.click(press(dlg, 'إلغاء'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(press(screen.getByText('ORD-2026-0002').closest('li') as HTMLElement, /عدّل/));
    dlg = (await screen.findByRole('dialog', undefined, WAIT)) as HTMLElement;
    fireEvent.click(press(dlg, 'احفظ التعديل'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(patch).not.toHaveBeenCalled();
  });

  it('its four presses say type="button" (the kit sets none)', async () => {
    const dlg = await openEdit();
    for (const name of ['احفظ التعديل', 'إلغاء', 'زد الكمية', 'أنقص الكمية']) expect(press(dlg, name).getAttribute('type'), name).toBe('button');
  });

  it('a renamed customer goes as customerName, and nothing else', async () => {
    const dlg = await openEdit();
    fireEvent.change(within(dlg).getByLabelText('اسم العميل'), { target: { value: 'اسم جديد' } });
    fireEvent.click(press(dlg, 'احفظ التعديل'));
    await waitFor(() => expect(patch).toHaveBeenCalledWith('o2', { expectedVersion: 4, customerName: 'اسم جديد' }));
  });
});

/* ═══════════ (g) a phone ═══════════ */

describe('(g) at 375px', () => {
  /** A fixed width written in pixels or rem on a class, larger than the screen. Built from pieces: no class-like word here. */
  const tooWide = (cls: string) => {
    const m = cls.match(new RegExp(['(?:^|\\s)(?:min-)?w-\\[(\\d+)px\\]'].join('')));
    return m ? Number(m[1]) > 375 : false;
  };

  it('nothing drawn is wider than the screen, with the parcels open', async () => {
    phone.value = true;
    await draw();
    await openParcels();
    const wide = Array.from(document.body.querySelectorAll('*')).filter((el) => tooWide(el.getAttribute('class') ?? ''));
    expect(wide).toEqual([]);
  });

  it('the presses that move a batch on are full width; print and check share a two-column grid; the three ways off a parcel are three columns', async () => {
    phone.value = true;
    await draw();
    await openParcels();
    const c = card('BATCH-2026-0001');
    const send = press(c, 'رحّل إلى الشركة واجلب الباركود');
    expect(send.className.split(' ')).toContain('w-full');
    expect(press(c, /طباعة بوالص الدفعة/).parentElement!.className.split(' ')).toContain(['grid', 'cols', '2'].join('-'));
    const second = screen.getByText('ORD-2026-0002').closest('li') as HTMLElement;
    expect(press(second, 'ألغِ').parentElement!.className.split(' ')).toContain(['grid', 'cols', '3'].join('-'));
  });

  it('a desk lays the card’s presses in one row that wraps', async () => {
    await draw();
    const row = press(card('BATCH-2026-0001'), /طباعة بوالص الدفعة/).parentElement!;
    expect(row.className.split(' ')).toContain('flex-wrap');
  });
});

/* ═══════════ the frame and the surfaces ═══════════ */

describe('the frame and the surfaces', () => {
  it('one h1, the registry’s name; the state strip sits in the frame’s filter row, above the list', async () => {
    await draw();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1.map((h) => h.textContent)).toEqual(['دفعات الشحن']);
    const strip = screen.getByRole('button', { name: 'الكل (3)' }).parentElement!;
    expect(strip.compareDocumentPosition(screen.getByText('BATCH-2026-0001'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('the list of batches is ONE page-level card; the empty trolley’s sentence is a plain card inside it', async () => {
    await draw();
    const list = card('BATCH-2026-0001').closest('ul')!;
    expect(list.parentElement!.classList.contains(CARD_CLASS)).toBe(true);
    expect(document.querySelectorAll('.' + CARD_CLASS)).toHaveLength(1);
    const said = within(card('BATCH-2026-0003')).getByRole('status');
    const inner = said.firstElementChild as HTMLElement;
    expect(inner.classList.contains(CARD_CLASS)).toBe(false);
    expect(inner.className).toContain('--sys-card');
  });
});
