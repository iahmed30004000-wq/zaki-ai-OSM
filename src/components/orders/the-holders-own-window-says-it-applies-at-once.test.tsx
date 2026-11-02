// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE SCREENS SAY WHAT WILL HAPPEN, AND THEN WHAT DID (the owner, 2/11).
 *
 * «بدي التعديل التأجيل أو الالغاء … أضيفهم كصلاحية انو يقدرو يعدلو ع الطلب لغاية مرحلة الشحنة.»
 *
 * The agent who HOLDS a confirmed order and holds `orders.edit_confirmed` changes it herself until it enters a batch, and the screen
 * must say so instead of «بيروح كطلب لمن يبتّ فيه»: before the press (the reason dialog, the request dialog) and after it («تم تطبيق
 * التعديل»). REAL components: the two cards of the order window, the request dialog, and the REAL raisers; the network and the
 * reason dialog are fakes. Three states for each, and the cases between them:
 *
 *   APPLIES NOW — hers, confirmed, in no batch, the key held: the dialog promises it, the server applies it, the card says «تم»;
 *   PENDING     — a colleague’s, on a trolley, with the courier, no key: the dialog says what it always said, one POST goes out, the
 *                 card says who decides — and never «تم»;
 *   UNCHANGED   — a supervisor’s own request decided on the spot: carried out, the card refreshes, and says nothing new.
 *
 * And the truth wins over the promise: when the screen promised and the server declined (a figure without the price key), the
 * sentence after the press is the pending one.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, ask, viewer } = vi.hoisted(() => ({
  apiJson: vi.fn<(url: string, init?: { method?: string; body?: string }) => Promise<unknown>>(),
  apiFetch: vi.fn(),
  ask: vi.fn(),
  viewer: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (u: string, i?: { method?: string; body?: string }) => apiJson(u, i), apiFetch }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', isRtl: true, currentUser: viewer.current }),
  useAppOptional: () => ({ locale: 'ar', isRtl: true, currentUser: viewer.current }),
}));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => ask, useConfirm: () => vi.fn(), useTell: () => vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', loading: false }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [], loading: false }) }));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => vi.fn() }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span data-testid="thumb" /> }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <span /> }));

import { CustomerCard } from './CustomerCard';
import { OrderLinesCard } from './OrderLinesCard';
import { ChangeRequestDialog } from '@/components/screens/confirmation/ActionDialogs';

const LIVE_AGENT = [
  'ai.assist', 'confirmation.work', 'orders.change_price', 'orders.claim', 'orders.confirm', 'orders.contact_log', 'orders.edit',
  'orders.note', 'orders.release', 'orders.request_change', 'orders.view',
];
const user = (permissions: string[], over: Record<string, unknown> = {}) => ({
  id: 'salma', name: 'سلمى', email: 's@x', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', companyId: 'c1', permissions, ...over,
});
const WITH_KEY = [...LIVE_AGENT, 'orders.edit_confirmed'];

/** What `GET /api/orders/[id]` carries that the window question needs. Salma holds it, it is in no batch, nothing is printed. */
const where = (over: Record<string, unknown> = {}) => ({
  claimedById: 'salma', shippingBatchId: null, shippingBatch: null, shippingStatus: 'NOT_READY', shippedAt: null, labelPrintedAt: null, ...over,
});

const THE_REASON = 'الزبون غيّر العنوان بالتلفون';
const TODAYS_ASK = { title: 'طلب تعديل', confirmLabel: 'ارفع الطلب', body: 'الطلب مؤكَّد، فالتعديل بيروح كطلب لمن يبتّ فيه' };
const HOLDERS_ASK = { title: 'تعديل الطلب', confirmLabel: 'طبّق التعديل', body: 'بينطبق فوراً' };

/** The server’s two answers to the POST, and the PATCH’s. */
function serve(raise: { readyToApply: boolean; viaEditWindow?: boolean }) {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.endsWith('/change-requests')) return { request: { id: 'cr1' }, orderStatus: 'CONFIRMED', ...raise };
    if (init?.method === 'PATCH') return {};
    return { products: [] };
  });
}
const posts = () => apiJson.mock.calls.filter(([u, i]) => u.endsWith('/change-requests') && i?.method === 'POST');
const patches = () => apiJson.mock.calls.filter(([, i]) => i?.method === 'PATCH');

beforeEach(() => {
  vi.clearAllMocks();
  viewer.current = user(WITH_KEY);
  ask.mockResolvedValue(THE_REASON);
  apiFetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  serve({ readyToApply: true, viaEditWindow: true });
});
afterEach(cleanup);

// ───────────────────────────────────────── the customer card ─────────────────────────────────────────

const customerOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1', version: 5, orderNumber: 'SY-5', confirmationStatus: 'CONFIRMED', totalAmount: 80, regionId: 'r1',
  region: { id: 'r1', name: 'عمّان' }, deliveryAddress: null,
  customer: { id: 'cu1', fullName: 'سامر', phone: '0791111111', rawPhone: '0791111111', altPhone: null, address: 'شارع قديم', city: 'عمّان', totalOrders: 1 },
  ...where(),
  ...over,
});

async function changeTheStreet(over: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  render(<CustomerCard order={customerOrder(over)} canEdit onAcquireLock={() => {}} onSaved={onSaved} onOpenHistory={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: 'تعديل' }));
  const street = screen.getByLabelText('عنوان التوصيل') as HTMLInputElement;
  fireEvent.change(street, { target: { value: 'شارع جديد' } });
  await userEvent.click(screen.getByRole('button', { name: /حفظ بيانات العميل/ }));
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  return onSaved;
}

describe('Ⅰ · the customer card — APPLIES NOW: hers, confirmed, in no batch, the key held', () => {
  it('promises it BEFORE the press, in the holder’s words — not «يروح كطلب لمن يبتّ فيه»', async () => {
    await changeTheStreet();

    const asked = ask.mock.calls[0][0];
    expect(asked.title).toBe(HOLDERS_ASK.title);
    expect(asked.confirmLabel).toBe(HOLDERS_ASK.confirmLabel);
    expect(asked.body).toContain(HOLDERS_ASK.body);
    expect(asked.body).not.toContain('لمن يبتّ فيه');
  });

  it('applies it, and SAYS SO after the press: one POST, one PATCH with the request’s id, the card refreshed, «تم تطبيق التعديل»', async () => {
    const onSaved = await changeTheStreet();

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1]!.body!)).toMatchObject({ intent: 'EDIT', reason: THE_REASON, changes: { customerAddress: { to: 'شارع جديد' } } });
    expect(patches()).toHaveLength(1);
    expect(JSON.parse(patches()[0][1]!.body!)).toEqual({ changeRequestId: 'cr1', expectedVersion: 5 });
    const said = await screen.findByRole('status');
    expect(said.textContent).toBe('تم تطبيق التعديل على الطلب.');
    expect(document.body.textContent).not.toContain('بانتظار');
  });
});

describe('Ⅱ · the customer card — PENDING: every neighbour says what it always said, and never «تم»', () => {
  it.each([
    ['a colleague’s order', { claimedById: 'someone-else' }, WITH_KEY],
    ['an order nobody holds', { claimedById: null }, WITH_KEY],
    ['hers, but on a trolley by the column', { shippingBatchId: 'b1', shippingStatus: 'READY_FOR_PICKUP' }, WITH_KEY],
    ['hers, but on a trolley by the relation', { shippingBatch: { status: 'READY' }, shippingStatus: 'READY_FOR_PICKUP' }, WITH_KEY],
    ['hers, with the courier (shipped by hand)', { shippingStatus: 'SHIPPED', shippedAt: '2026-11-01T08:00:00.000Z' }, WITH_KEY],
    ['hers, a printed waybill (an edit is stopped by the seal)', { labelPrintedAt: '2026-11-01T08:00:00.000Z', shippingStatus: 'READY_FOR_PICKUP' }, WITH_KEY],
    ['hers, but without the key', {}, LIVE_AGENT],
  ])('%s ⇒ the dialog is today’s, one POST goes out, the card says who decides', async (_name, over, keys) => {
    viewer.current = user(keys);
    serve({ readyToApply: false });

    const onSaved = await changeTheStreet(over);

    const asked = ask.mock.calls[0][0];
    expect(asked.title).toBe(TODAYS_ASK.title);
    expect(asked.confirmLabel).toBe(TODAYS_ASK.confirmLabel);
    expect(asked.body).toContain(TODAYS_ASK.body);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(patches(), 'طُبِّق شيء بلا قرار').toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    await waitFor(() => expect(document.body.textContent).toContain('رُفع طلبك وبانتظار قرار'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.body.textContent).not.toContain('تم تطبيق');
  });

  it('a read that carries none of the window’s facts (an older screen) says what it always said', async () => {
    serve({ readyToApply: false });
    const onSaved = vi.fn();
    const { claimedById: _a, shippingBatchId: _b, shippingBatch: _c, shippingStatus: _d, shippedAt: _e, labelPrintedAt: _f, ...bare } = customerOrder();
    void [_a, _b, _c, _d, _e, _f];
    render(<CustomerCard order={bare} canEdit onAcquireLock={() => {}} onSaved={onSaved} onOpenHistory={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('عنوان التوصيل'), { target: { value: 'شارع جديد' } });
    await userEvent.click(screen.getByRole('button', { name: /حفظ بيانات العميل/ }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));

    expect(ask.mock.calls[0][0].title).toBe(TODAYS_ASK.title);
  });
});

describe('Ⅲ · the customer card — the truth wins over the promise, and everybody else is UNCHANGED', () => {
  it('the screen promised «فوراً» and the server declined: the sentence after the press is the pending one, nothing is called applied', async () => {
    serve({ readyToApply: false });

    const onSaved = await changeTheStreet();

    expect(ask.mock.calls[0][0].title).toBe(HOLDERS_ASK.title);
    await waitFor(() => expect(document.body.textContent).toContain('رُفع طلبك وبانتظار قرار'));
    expect(patches()).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a request decided on the spot by SOMEBODY ELSE’S authority (a supervisor) is carried out and refreshes the card — with no new sentence', async () => {
    viewer.current = user([...LIVE_AGENT, 'control.change_requests'], { id: 'sup', role: 'CONFIRMATION_SUPERVISOR' });
    serve({ readyToApply: true });

    const onSaved = await changeTheStreet({ claimedById: 'someone-else' });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(1);
    expect(screen.queryByRole('status'), 'جملة جديدة لمن ليس صاحب النافذة').toBeNull();
    expect(ask.mock.calls[0][0].title).toBe(TODAYS_ASK.title);
  });

  it('an order that is not confirmed yet raises nothing, whoever holds the key — the holder’s window is a CONFIRMED order’s', async () => {
    const onSaved = vi.fn();
    render(<CustomerCard order={customerOrder({ confirmationStatus: 'IN_PROGRESS' })} canEdit onAcquireLock={() => {}} onSaved={onSaved} onOpenHistory={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'تعديل' }));
    fireEvent.change(screen.getByLabelText('عنوان التوصيل'), { target: { value: 'شارع جديد' } });
    await userEvent.click(screen.getByRole('button', { name: /حفظ بيانات العميل/ }));

    // The direct path (a stubbed `useOrderPatch`) asks no reason and raises no request.
    await new Promise((r) => setTimeout(r, 0));
    expect(ask).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(0);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ───────────────────────────────────────── the lines card ─────────────────────────────────────────

const LINE = {
  id: 'i1', productId: 'p1', productName: 'كريم', quantity: 3, freeQuantity: 0,
  unitPrice: '12' as unknown as number, discountShare: '0' as unknown as number, lineTotal: '36' as unknown as number, beforeDiscount: 36,
};

const linesOrder = (over: Record<string, unknown> = {}) => ({
  id: 'o1', version: 7, confirmationStatus: 'CONFIRMED', totalAmount: 38.5, quantity: 3, sellingPrice: 36, discountAmount: 0,
  deliveryFee: 2.5, priceIncludesDelivery: false, internalNotes: null, customerNotes: null, items: [LINE],
  product: { name: 'كريم', image: null }, productNameSnapshot: 'كريم', productImageSnapshot: null, offer: null,
  deliveryProvider: { id: 'dp1', name: 'شركة' }, ...where(), ...over,
});

async function typeANote(over: Record<string, unknown> = {}) {
  const onSaved = vi.fn();
  render(<OrderLinesCard order={linesOrder(over)} currency={{ code: 'JOD', minorUnit: 3 }} canEdit onAcquireLock={() => {}} onSaved={onSaved} />);
  await userEvent.click(screen.getByRole('button', { name: /تعديل/ }));
  await waitFor(() => expect(screen.getAllByPlaceholderText('سعر السطر').length).toBeGreaterThan(0));
  await userEvent.type(screen.getByPlaceholderText(/ما طلبه العميل/), 'التوصيل بعد العصر');
  return onSaved;
}
const pressSave = () => userEvent.click(screen.getByRole('button', { name: /حفظ بيانات الطلب/ }));

describe('Ⅳ · the lines card — the same three states', () => {
  it('APPLIES NOW: a note on her own order promises it, applies it, and says «تم تطبيق التعديل»', async () => {
    const onSaved = await typeANote();
    await pressSave();

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0]).toMatchObject({ title: HOLDERS_ASK.title, confirmLabel: HOLDERS_ASK.confirmLabel });
    expect(ask.mock.calls[0][0].body).toContain(HOLDERS_ASK.body);
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(1);
    expect((await screen.findByRole('status')).textContent).toBe('تم تطبيق التعديل على الطلب.');
  });

  it('PENDING: on a colleague’s order the dialog is today’s and the card says what it said — «بانتظار الموافقة»', async () => {
    serve({ readyToApply: false });
    const onSaved = await typeANote({ claimedById: 'someone-else' });
    await pressSave();

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0]).toMatchObject({ title: TODAYS_ASK.title, confirmLabel: TODAYS_ASK.confirmLabel });
    expect(ask.mock.calls[0][0].body).toContain(TODAYS_ASK.body);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(patches()).toHaveLength(0);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('PENDING: on a trolley, the same', async () => {
    serve({ readyToApply: false });
    await typeANote({ shippingBatchId: 'b1', shippingStatus: 'READY_FOR_PICKUP' });
    await pressSave();

    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0].title).toBe(TODAYS_ASK.title);
  });

  it('THE FIGURE NEEDS THE PRICE KEY: a discount without `orders.change_price` is promised as a request, and with it as «فوراً»', async () => {
    const discount = async () => {
      render(<OrderLinesCard order={linesOrder()} currency={{ code: 'JOD', minorUnit: 3 }} canEdit onAcquireLock={() => {}} onSaved={() => {}} />);
      await userEvent.click(screen.getByRole('button', { name: /تعديل/ }));
      await waitFor(() => expect(screen.getAllByPlaceholderText('سعر السطر').length).toBeGreaterThan(0));
      const box = screen.getByLabelText('الخصم على الطلب');
      await userEvent.clear(box);
      await userEvent.type(box, '2');
      await pressSave();
      await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    };

    viewer.current = user(WITH_KEY.filter((k) => k !== 'orders.change_price'));
    await discount();
    expect(ask.mock.calls[0][0].title).toBe(TODAYS_ASK.title);
    expect(document.body.textContent).toContain('الخصم بعد التأكيد طلب تعديل');

    cleanup();
    vi.clearAllMocks();
    ask.mockResolvedValue(THE_REASON);
    serve({ readyToApply: true, viaEditWindow: true });
    viewer.current = user(WITH_KEY);
    await discount();
    expect(ask.mock.calls[0][0].title).toBe(HOLDERS_ASK.title);
  });
});

// ───────────────────────────────────────── the request dialog ─────────────────────────────────────────

const ALL_NOW = { EDIT: true, CANCEL: true, POSTPONE: true };
const TODAYS_DIALOG = { title: 'طلب على طلب مؤكد', submit: 'إرسال الطلب', paragraph: 'الطلب المؤكد للقراءة فقط' };
const HOLDERS_DIALOG = { title: 'تعديل طلب مؤكد', submit: 'طبّق الآن', paragraph: 'بينطبق فوراً' };

function dialog(props: Partial<React.ComponentProps<typeof ChangeRequestDialog>> = {}) {
  return render(<ChangeRequestDialog open orderNumber="SY-5" onClose={() => {}} onSubmit={() => {}} {...props} />);
}
const field = (value: string) => fireEvent.change(screen.getByLabelText('الحقل المطلوب تعديله'), { target: { value } });
const intent = (name: string) => userEvent.click(screen.getByRole('button', { name }));

describe('Ⅴ · the request dialog — what it promises, per ask', () => {
  it('UNCHANGED by default: no window given ⇒ the title, the paragraph and the button it always had', () => {
    dialog();
    expect(screen.getByText(TODAYS_DIALOG.title)).toBeTruthy();
    expect(screen.getByRole('button', { name: TODAYS_DIALOG.submit })).toBeTruthy();
    expect(document.body.textContent).toContain(TODAYS_DIALOG.paragraph);
    expect(document.body.textContent).not.toContain(HOLDERS_DIALOG.paragraph);
  });

  it('APPLIES NOW: the window is open ⇒ the holder’s title, paragraph and button, for each of the three asks', async () => {
    dialog({ appliesNow: ALL_NOW, mayChangePrice: true });
    for (const name of ['تعديل', 'إلغاء', 'تأجيل']) {
      await intent(name);
      expect(screen.getByText(HOLDERS_DIALOG.title), name).toBeTruthy();
      expect(screen.getByRole('button', { name: HOLDERS_DIALOG.submit }), name).toBeTruthy();
      expect(document.body.textContent, name).toContain(HOLDERS_DIALOG.paragraph);
      expect(document.body.textContent, name).not.toContain(TODAYS_DIALOG.paragraph);
    }
  });

  it('PER ASK: a printed waybill stops an EDIT but not a cancel — the dialog follows the intent she picks', async () => {
    dialog({ appliesNow: { EDIT: false, CANCEL: true, POSTPONE: true }, mayChangePrice: true });
    expect(document.body.textContent).toContain(TODAYS_DIALOG.paragraph);
    await intent('إلغاء');
    expect(document.body.textContent).toContain(HOLDERS_DIALOG.paragraph);
    await intent('تعديل');
    expect(document.body.textContent).toContain(TODAYS_DIALOG.paragraph);
  });

  it('THE FIGURE NEEDS THE PRICE KEY: a quantity is promised «فوراً» only to somebody who holds `orders.change_price`', async () => {
    const { unmount } = dialog({ appliesNow: ALL_NOW, mayChangePrice: false });
    field('quantity');
    expect(document.body.textContent).toContain(TODAYS_DIALOG.paragraph);
    expect(screen.getByRole('button', { name: TODAYS_DIALOG.submit })).toBeTruthy();
    // …while a field that is no figure still is
    field('customerAddress');
    expect(document.body.textContent).toContain(HOLDERS_DIALOG.paragraph);
    unmount();

    dialog({ appliesNow: ALL_NOW, mayChangePrice: true });
    field('quantity');
    expect(document.body.textContent).toContain(HOLDERS_DIALOG.paragraph);
  });

  it('a screen that gives the window and forgets the price key does not over-promise a figure', () => {
    dialog({ appliesNow: ALL_NOW });
    field('sellingPrice');
    expect(document.body.textContent).toContain(TODAYS_DIALOG.paragraph);
  });

  it('the dialog still SENDS what it always sent — the window changes the words, not the value', async () => {
    const onSubmit = vi.fn();
    dialog({ appliesNow: ALL_NOW, mayChangePrice: true, onSubmit });
    field('customerAddress');
    fireEvent.change(screen.getByLabelText('القيمة الجديدة'), { target: { value: 'شارع جديد' } });
    fireEvent.change(screen.getByLabelText('سبب التعديل'), { target: { value: THE_REASON } });
    await userEvent.click(screen.getByRole('button', { name: HOLDERS_DIALOG.submit }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ intent: 'EDIT', field: 'customerAddress', to: 'شارع جديد', reason: THE_REASON });
  });
});
