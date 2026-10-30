// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE RETURNS DESK AND THE PACKING LINE ON A PHONE — M7 of the phone audit
 * (OPS-RET-1..2 · OPS-PREP-1..2 · OPS-SH-4).
 *
 * «المرتجعات» · «التجهيز». Every claim is made on a phone AND on a desk: a phone is `useIsPhone` (each screen draws ONE
 * layout), and the desk is the same render with the hook answering `false` — which must be exactly what was there before.
 *
 * jsdom has no layout; the measures (44px, the wrapping, the footer under the keyboard) are in the pull request.
 */

const { apiJson, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: true },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => false }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void> | void) => {
    React.useEffect(() => {
      void load();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ChangeRequestReview', () => ({ ChangeRequestReview: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ RejectDialog: () => null }));

import { ReturnsScreen } from './ReturnsScreen';
import { PreparationScreen } from './PreparationScreen';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  user.current = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['orders.view', 'orders.cancel', 'ai.assist'] };
});
afterEach(cleanup);

const card = () => document.querySelector('li') as HTMLElement;

/* ═══════════════════════ المرتجعات ═══════════════════════ */

describe('«المرتجعات»', () => {
  const ROW = {
    id: 'o1',
    orderNumber: 'SY-2026-0148',
    merchantRef: null,
    trackingNumber: 'TRK-1',
    shippingStatus: 'PARTIALLY_DELIVERED',
    returnReason: null,
    expectedQty: 1,
    daysWaited: 2,
    customer: { fullName: 'سارة' },
    region: { name: 'دمشق' },
    deliveryProvider: { name: 'ناقل' },
    lines: [{ itemId: 'i1', productName: 'كريم تفتيح البشرة الطبيعي 50 مل', shipped: 3, delivered: 2, expectedBack: 1 }],
    completion: { halves: [], settledCount: 0, degree: 'NONE', complete: false, awaiting: [], label: '' },
    action: null,
  };
  const serve = () =>
    apiJson.mockResolvedValue({
      count: 1,
      orders: [ROW],
      pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
      facts: {
        views: { pending: 1, received: 0 },
        statuses: { RETURN_REQUESTED: 0, RETURNED: 0, FAILED_DELIVERY: 0, PARTIALLY_DELIVERED: 1 },
        couriers: [],
        ages: { fresh: 1, few: 0, week: 0, old: 0 },
      },
      applied: { view: 'pending', status: null, courier: null, age: null, q: null },
    });
  const draw = async () => {
    serve();
    render(<ReturnsScreen />);
    await waitFor(() => expect(document.querySelector('li')).not.toBeNull(), WAIT);
  };
  const openDialog = async () => {
    await draw();
    fireEvent.click(within(card()).getByRole('button', { name: 'استلام' }));
    return screen.getByRole('dialog');
  };

  it('PHONE: «استلام» is a button across the card — the one press this desk exists for', async () => {
    await draw();
    const b = within(card()).getByRole('button', { name: 'استلام' });
    expect(b.className).toContain('w-full');
    expect(b.className).not.toContain('hover:underline');
  });

  it('DESK: nothing changed — «استلام» is the bare word it was', async () => {
    phone.value = false;
    await draw();
    const b = within(card()).getByRole('button', { name: 'استلام' });
    expect(b.className).toContain('hover:underline');
    expect(b.className).not.toContain('w-full');
  });

  it('PHONE: the list is not drawn inside a second frame', async () => {
    await draw();
    expect(card().closest('ul')!.parentElement!.className).not.toContain('border');
  });

  it('DESK: the frame is still there', async () => {
    phone.value = false;
    await draw();
    expect(card().closest('ul')!.parentElement!.className).toContain('border');
  });

  it('PHONE: «تأكيد الاستلام» stays at the foot of the dialog, outside the part that scrolls — and still submits the form', async () => {
    const dialog = await openDialog();
    const form = dialog.querySelector('form') as HTMLFormElement;
    const confirmButton = within(dialog).getByRole('button', { name: 'تأكيد الاستلام' }) as HTMLButtonElement;
    expect(form.contains(confirmButton)).toBe(false);
    expect(dialog.querySelector('[data-modal-body]')!.contains(confirmButton)).toBe(false);
    expect(form.id).not.toBe('');
    expect(confirmButton.getAttribute('form')).toBe(form.id);
    expect(confirmButton.form).toBe(form);
    // the way out is beside it
    expect(within(dialog).getByRole('button', { name: 'إلغاء' }).parentElement).toBe(confirmButton.parentElement);
  });

  it('DESK: nothing changed — both buttons are the end of the form', async () => {
    phone.value = false;
    const dialog = await openDialog();
    const form = dialog.querySelector('form') as HTMLFormElement;
    const confirmButton = within(dialog).getByRole('button', { name: 'تأكيد الاستلام' }) as HTMLButtonElement;
    expect(form.contains(confirmButton)).toBe(true);
    expect(confirmButton.hasAttribute('form')).toBe(false);
    expect(form.contains(within(dialog).getByRole('button', { name: 'إلغاء' }))).toBe(true);
  });

  it('PHONE: the product has a line of its own, whole; the three numbers are a row under it', async () => {
    const dialog = await openDialog();
    const name = within(dialog).getByText('كريم تفتيح البشرة الطبيعي 50 مل');
    expect(name.className).not.toContain('truncate');
    expect(name.className).toContain('col-span-full');
    expect(name.parentElement!.className).toContain('grid-cols-3');
    expect(name.parentElement!.children).toHaveLength(4);
    // the head names the three numbers only — «المنتج» has no column to head any more
    const head = within(dialog).getByText('شُحن').parentElement as HTMLElement;
    expect(head.children).toHaveLength(3);
    expect(within(head).queryByText('المنتج')).toBeNull();
  });

  it('DESK: nothing changed — one row of four, the name cut with an ellipsis, «المنتج» heads it', async () => {
    phone.value = false;
    const dialog = await openDialog();
    const name = within(dialog).getByText('كريم تفتيح البشرة الطبيعي 50 مل');
    expect(name.className).toContain('truncate');
    expect(name.className).not.toContain('col-span-full');
    expect(name.parentElement!.className).toContain('grid-cols-[1fr_auto_auto_auto]');
    const head = within(dialog).getByText('شُحن').parentElement as HTMLElement;
    expect(head.children).toHaveLength(4);
    expect(within(head).getByText('المنتج')).toBeTruthy();
  });
});

/* ═══════════════════════ التجهيز ═══════════════════════ */

describe('«التجهيز»', () => {
  const LINE = {
    orderId: 'o1',
    orderNumber: 'ORD-1',
    customerName: 'سارة',
    regionName: 'عمّان',
    pendingChangeRequestId: 'cr1',
    quantity: 2,
    freeQuantity: 0,
    reservedQty: 2,
    shippingStatus: 'NOT_READY',
  };
  const NAME = 'كريم تفتيح البشرة الطبيعي 50 مل';
  const serve = (line = LINE) =>
    apiJson.mockResolvedValue({
      allowNegativeStock: false,
      totals: { products: 1, orders: 1, shortages: 0 },
      groups: [{ productId: 'p1', productName: NAME, orders: 1, required: 2, available: 5, shortage: 0, lines: [line] }],
    });
  const draw = async (line = LINE) => {
    serve(line);
    render(<PreparationScreen />);
    await waitFor(() => expect(document.querySelector('li')).not.toBeNull(), WAIT);
  };

  it('PHONE: the change request is the first thing on the card, full width, with a button that opens it', async () => {
    await draw();
    const first = card().firstElementChild as HTMLElement;
    expect(first.textContent).toContain('طلب تعديل بانتظار البتّ');
    expect(within(first).getByRole('button', { name: 'راجعه' })).toBeTruthy();
    // …and not again among the actions (one copy of the flag on the card)
    expect(within(card()).queryByRole('button', { name: 'طلب تعديل' })).toBeNull();
  });

  it('PHONE: the two actions are words, not icons a tooltip explains, in two equal halves', async () => {
    await draw();
    const open = within(card()).getByRole('button', { name: 'افتح الطلب' });
    const cancel = within(card()).getByRole('button', { name: 'ألغِ الطلب' });
    expect(open.textContent).toContain('افتح الطلب');
    expect(cancel.textContent).toContain('ألغِ الطلب');
    expect(open.parentElement).toBe(cancel.parentElement);
    expect(open.parentElement!.className).toContain('grid-cols-2');
  });

  it('PHONE: someone who may neither open nor cancel gets no row of actions', async () => {
    user.current = { id: 'u2', status: 'ACTIVE', role: 'WAREHOUSE', permissions: ['inventory.view'] };
    await draw({ ...LINE, pendingChangeRequestId: null as unknown as string });
    expect(within(card()).queryByRole('button')).toBeNull();
  });

  it('DESK: nothing changed — two icons with names and the change-request chip, among the actions; no notice', async () => {
    phone.value = false;
    await draw();
    const open = within(card()).getByRole('button', { name: 'افتح الطلب' });
    expect(open.textContent?.trim()).toBe('');
    expect(within(card()).getByRole('button', { name: 'ألغِ الطلب' }).textContent?.trim()).toBe('');
    expect(within(card()).getByRole('button', { name: 'طلب تعديل' })).toBeTruthy();
    expect(within(card()).queryByRole('button', { name: 'راجعه' })).toBeNull();
    expect(open.parentElement!.className).toContain('whitespace-nowrap');
  });

  it('PHONE: the three figures share one row of equal boxes and the stock rule has a line to itself', async () => {
    await draw();
    const row = screen.getByText('منتجات للتجهيز').parentElement!.parentElement as HTMLElement;
    expect(row.className).toContain('grid-cols-3');
    expect(screen.getByText(/المخزون السالب ممنوع/).className).toContain('col-span-full');
  });

  it('DESK: nothing changed — the old wrapping row', async () => {
    phone.value = false;
    await draw();
    const row = screen.getByText('منتجات للتجهيز').parentElement!.parentElement as HTMLElement;
    expect(row.className).toContain('flex-wrap');
    expect(screen.getByText(/المخزون السالب ممنوع/).className).not.toContain('col-span-full');
  });

  it('PHONE: the product name is whole in the group heading; DESK: one line with an ellipsis', async () => {
    await draw();
    expect(screen.getByText(NAME).className).not.toContain('truncate');
    cleanup();
    phone.value = false;
    await draw();
    expect(screen.getByText(NAME).className).toContain('truncate');
  });

  it('PHONE: the assistant box gives the sentence the whole width and the button its own line; DESK: side by side', async () => {
    await draw();
    const ask = screen.getByRole('button', { name: 'رتّب لي الجولة' });
    expect(ask.parentElement!.className).toContain('flex-col');
    cleanup();
    phone.value = false;
    await draw();
    expect(screen.getByRole('button', { name: 'رتّب لي الجولة' }).parentElement!.className).toContain('justify-between');
  });
});
