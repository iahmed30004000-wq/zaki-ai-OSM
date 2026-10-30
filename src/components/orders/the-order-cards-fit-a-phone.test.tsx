// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * M8 / M9 OF THE PHONE AUDIT — THE CARDS INSIDE AN ORDER, AT 375px.
 *
 *   ORD-11  «تسجيل نتيجة الاتصال» — seven outlined buttons of one weight wrapped into four rows, and the
 *           outcome most calls end in («تأكيد الطلب») was fifth, looking like «رقم خاطئ».
 *   ORD-12  the chip group in its header had no wrap and gave the whole sheet a sideways scroll.
 *   ORD-13  «معلومات العميل» — a title and two buttons in one row that cannot wrap.
 *   ORD-24  the shipping grid cut a tracking number, a batch number and a courier's name with an ellipsis,
 *           and drew six boxes for an order that had shipped nothing.
 *   ORD-02  the product line editor: 36px-wide steppers and delete buttons, 40px boxes.
 *
 * AND THE RULE THAT HOLDS THEM ALL: A DESK IS WHAT IT WAS. Every phone layout is selected by \`useIsPhone\`
 * (which is false where there is no \`matchMedia\`, as in a test and on a server), so this file holds the same
 * screens in both modes — the phone's new layout, and the desk's old one, spelled out.
 *
 * jsdom has no layout; the 44px, the wrapping and the rows were measured in a real browser at 375px (see the pull
 * request). What is held here is the SHAPE that makes the browser do the right thing.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, phone } = vi.hoisted(() => ({ apiFetch: vi.fn(), phone: { value: false } }));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: vi.fn(async () => ({ notes: [] })),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => vi.fn() }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => vi.fn(), useTell: () => vi.fn() }));
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span /> }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <span /> }));

import { ConfirmationActions } from './ConfirmationActions';
import { CustomerCard } from './CustomerCard';
import { OrderLinesCard } from './OrderLinesCard';
import { ShippingSection } from './ShippingSection';
import { OrderNotes } from './OrderNotes';
import { ProductLinesEditor, newLine, type DraftLine } from './ProductLinesEditor';

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ attempts: [], summary: null }) }));
});
afterEach(cleanup);

const tokens = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

/* ═══════════════════════ ConfirmationActions — ORD-11 · ORD-12 ═══════════════════════ */

describe('«تسجيل نتيجة الاتصال» — the seven quick buttons', () => {
  const ORDER = { id: 'o-1', orderNumber: 'ORD-1', confirmationStatus: 'NEW', version: 1 };
  const SEVEN = ['العميل أجاب', 'لا يرد', 'تأجيل', 'متابعة', 'تأكيد الطلب', 'العميل رفض', 'رقم خاطئ'];
  const draw = () => render(<ConfirmationActions order={ORDER} ar isRtl onRefreshOrder={() => {}} />);
  /** The quick buttons, in the order the page draws them. */
  const quick = () => SEVEN.map((name) => screen.getByRole('button', { name }));
  const domOrder = () =>
    quick()
      .map((b, i) => ({ name: SEVEN[i], at: b }))
      .sort((a, b) => (a.at.compareDocumentPosition(b.at) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((x) => x.name);

  it('A DESK IS WHAT IT WAS: one wrapping row, in the old order, no heading, no stretching', () => {
    draw();
    expect(domOrder()).toEqual(['العميل أجاب', 'لا يرد', 'تأجيل', 'متابعة', 'تأكيد الطلب', 'العميل رفض', 'رقم خاطئ']);
    const row = screen.getByRole('button', { name: 'تأكيد الطلب' }).parentElement!;
    expect(row.getAttribute('class')).toBe('flex flex-wrap gap-2 mb-4');
    expect(quick().every((b) => b.parentElement === row), 'الأزرار السبعة أبناء الصف مباشرة').toBe(true);
    expect(screen.queryByText('نتيجة الاتصال')).toBeNull();
    for (const b of quick()) {
      expect(tokens(b), b.textContent!).not.toContain('grow');
      expect(tokens(b), b.textContent!).not.toContain('w-full');
    }
    // ORD-12 — the header's chip group is the one it was, with no wrap.
    expect(screen.getByText('تسجيل نتيجة الاتصال').nextElementSibling?.getAttribute('class')).toBe('flex items-center gap-2');
  });

  it('A PHONE: the confirmation first and alone, then the call results under a heading, then the three that decide', () => {
    phone.value = true;
    draw();
    const confirm = screen.getByRole('button', { name: 'تأكيد الطلب' });
    expect(confirm.parentElement!.firstElementChild, '«تأكيد الطلب» أول شيء').toBe(confirm);
    expect(tokens(confirm)).toContain('w-full');

    const heading = screen.getByText('نتيجة الاتصال');
    const results = heading.nextElementSibling as HTMLElement;
    expect(within(results).getAllByRole('button').map((b) => b.textContent)).toEqual(['العميل أجاب', 'لا يرد', 'رقم خاطئ']);
    const decide = results.parentElement!.nextElementSibling as HTMLElement;
    expect(within(decide).getAllByRole('button').map((b) => b.textContent)).toEqual(['تأجيل', 'متابعة', 'العميل رفض']);
    // They share a row: each takes what is left of its line instead of leaving a ragged edge.
    for (const b of [...within(results).getAllByRole('button'), ...within(decide).getAllByRole('button')]) {
      expect(tokens(b), b.textContent!).toContain('grow');
      expect(tokens(b), b.textContent!).toContain('min-h-11');
    }
    // ORD-12 — the chip group in the header wraps instead of widening the sheet.
    expect(tokens(screen.getByText('تسجيل نتيجة الاتصال').nextElementSibling)).toContain('flex-wrap');
  });

  it('the same seven buttons in both, ONE copy of each, and a press does what it did', async () => {
    for (const isPhone of [false, true]) {
      cleanup();
      apiFetch.mockClear();
      phone.value = isPhone;
      draw();
      await waitFor(() => expect(apiFetch).toHaveBeenCalled());
      for (const name of SEVEN) expect(screen.getAllByRole('button', { name }), `${name} (${isPhone ? 'phone' : 'desk'})`).toHaveLength(1);
      apiFetch.mockClear();
      fireEvent.click(screen.getByRole('button', { name: 'لا يرد' }));
      await waitFor(() => expect(apiFetch.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(true));
      const post = apiFetch.mock.calls.find((c) => c[1]?.method === 'POST')!;
      expect(post[0]).toBe('/api/orders/o-1/contact-attempts');
      expect(JSON.parse(post[1].body).result).toBe('NO_ANSWER');
    }
  });

  it('«تأكيد الطلب» opens the same form on a phone', async () => {
    phone.value = true;
    draw();
    const confirm = screen.getByRole('button', { name: 'تأكيد الطلب' }) as HTMLButtonElement;
    // The buttons wait for the contact history to load before they take a press.
    await waitFor(() => expect(confirm.disabled).toBe(false));
    fireEvent.click(confirm);
    expect(await screen.findByText(/ملاحظة تأكيد/)).toBeTruthy();
  });
});

/* ═══════════════════════ CustomerCard — ORD-13 ═══════════════════════ */

describe('«معلومات العميل» — the title and its two buttons', () => {
  const ORDER = {
    id: 'o-1',
    orderNumber: 'ORD-1',
    version: 1,
    confirmationStatus: 'NEW',
    regionId: 'r1',
    region: { name: 'عمّان' },
    deliveryAddress: 'شارع الجامعة',
    customer: { id: 'c1', fullName: 'نور', phone: '0791234567', rawPhone: '0791234567', altPhone: '', address: 'x', city: 'عمّان', totalOrders: 3 },
  };
  const draw = () =>
    render(<CustomerCard order={ORDER} canEdit={false} dialCode="962" onAcquireLock={async () => undefined} onSaved={async () => {}} onOpenHistory={() => {}} />);
  const row = () => screen.getByText('معلومات العميل').closest('h4')!.parentElement!;

  it('A DESK keeps the one row it had', () => {
    draw();
    expect(row().getAttribute('class')).toBe('flex items-center justify-between gap-2');
  });

  it('A PHONE lets the title and the two buttons wrap onto a second line', () => {
    phone.value = true;
    draw();
    expect(tokens(row())).toContain('flex-wrap');
    // …and both buttons are still there, once each.
    expect(screen.getAllByRole('button', { name: /طلبات سابقة/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'تعديل' })).toHaveLength(1);
  });
});

/* ═══════════════════════ OrderLinesCard — ORD-13 · ORD-24 ═══════════════════════ */

describe('«بيانات الطلب» — the lines card', () => {
  const ORDER = {
    id: 'o-1',
    version: 1,
    confirmationStatus: 'NEW',
    offer: { name: 'اشترِ 3' },
    discountAmount: 0,
    customerNotes: '',
    items: [{ id: 'l1', productId: 'p1', productName: 'كريم تفتيح البشرة الطبيعي بخلاصة الألوفيرا والعسل', quantity: 2, freeQuantity: 0, unitPrice: 12, lineTotal: 24 }],
    product: { name: 'x' },
    totalAmount: 24,
  };
  const draw = () =>
    render(<OrderLinesCard order={ORDER as never} currency={{ code: 'JOD', minorUnit: 2 } as never} canEdit={false} onAcquireLock={async () => undefined} onSaved={async () => {}} />);

  it('A DESK cuts a long name with an ellipsis and keeps its header row, as it did', () => {
    draw();
    const name = screen.getByText(/كريم تفتيح/);
    expect(tokens(name)).toContain('truncate');
    expect(tokens(name)).not.toContain('line-clamp-2');
    expect(screen.getByText('بيانات الطلب').closest('h4')!.parentElement!.getAttribute('class')).toBe('flex items-center justify-between gap-2');
  });

  it('A PHONE shows two lines of the name and lets the header wrap', () => {
    phone.value = true;
    draw();
    const name = screen.getByText(/كريم تفتيح/);
    expect(tokens(name)).toContain('line-clamp-2');
    expect(tokens(name)).not.toContain('truncate');
    expect(tokens(screen.getByText('بيانات الطلب').closest('h4')!.parentElement)).toContain('flex-wrap');
  });
});

/* ═══════════════════════ ShippingSection — ORD-24 ═══════════════════════ */

describe('«الشحن والتوصيل» — the grid of facts', () => {
  const SHIPPED = {
    id: 'o-1',
    version: 1,
    confirmationStatus: 'CONFIRMED',
    state: 'SHIPPED',
    status: 'SHIPPED',
    deliveryProvider: { id: 'd1', name: 'شركة الشحن السريع للتوصيل', kind: 'COMPANY' },
    trackingNumber: 'TRK-9000-1234567890',
    shippingBatch: null,
    shippedAt: '2026-10-20T10:00:00.000Z',
    outForDeliveryAt: null,
    deliveredAt: null,
    deliveryFee: 2,
  };
  const draw = () =>
    render(
      <ShippingSection order={SHIPPED as never} ar isRtl canEdit={false} canChangeFee={false} canCopyRatingLink={false} onRefreshOrder={async () => {}} />
    );

  it('A DESK keeps every box, one line each, and cuts what does not fit', () => {
    draw();
    const tracking = screen.getByText('TRK-9000-1234567890');
    expect(tokens(tracking)).toContain('truncate');
    expect(screen.getAllByText('—').length, 'ست خانات ما بتختفي على الديسكتوب').toBeGreaterThanOrEqual(2);
  });

  it('A PHONE wraps a number at any character and a name at a space, and draws no box of dashes', () => {
    phone.value = true;
    draw();
    const tracking = screen.getByText('TRK-9000-1234567890');
    expect(tokens(tracking)).toContain('break-all');
    expect(tokens(tracking)).not.toContain('truncate');
    expect(tokens(screen.getByText('شركة الشحن السريع للتوصيل'))).toContain('break-words');
    expect(screen.queryAllByText('—'), 'خانة بلا معلومة ما بتنرسم').toHaveLength(0);
  });
});

/* ═══════════════════════ OrderNotes — ORD-26 ═══════════════════════ */

describe('the note box on the order sheet', () => {
  it('its send button is 44px wide on a phone (it was 36) and 36 from md — and still sends', async () => {
    render(<OrderNotes orderId="o-1" canWrite />);
    const send = await screen.findByRole('button', { name: /أضف الملاحظة/ });
    expect(tokens(send)).toEqual(expect.arrayContaining(['h-11', 'md:h-9', 'w-9', 'min-w-11', 'md:min-w-0']));
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/اكتب ملاحظة/), { target: { value: 'اتصلوا قبل الوصول' } });
    expect((send as HTMLButtonElement).disabled).toBe(false);
  });
});

/* ═══════════════════════ ProductLinesEditor — ORD-02 ═══════════════════════ */

describe('the product line editor (new order and the order sheet share it)', () => {
  const PRODUCT = { id: 'p1', name: 'كريم', basePrice: 25, offers: [] };
  function Harness() {
    const [lines, setLines] = useState<DraftLine[]>([
      { ...newLine(), productId: 'p1', price: '25' },
      { ...newLine(), productId: 'p1', price: '50', quantity: 2 },
    ]);
    return <ProductLinesEditor lines={lines} products={[PRODUCT]} currency={{ code: 'JOD', minorUnit: 2 }} onChange={setLines} />;
  }

  it('every control is 44px on a phone and its old size from md — the steppers and the delete button too', () => {
    render(<Harness />);
    const controls = [
      ...screen.getAllByRole('button', { name: 'أنقص الكمية' }),
      ...screen.getAllByRole('button', { name: 'زد الكمية' }),
      ...screen.getAllByRole('button', { name: 'احذف هذا المنتج من الطلب' }),
    ];
    expect(controls).toHaveLength(6);
    for (const b of controls) {
      const t = tokens(b);
      // 44px each way on a phone (the width was 36px), and the 36px of old from `md`.
      expect(t, b.getAttribute('aria-label')!).toEqual(expect.arrayContaining(['h-11', 'md:h-9', 'w-9', 'min-w-11', 'md:min-w-0']));
    }
    for (const box of screen.getAllByPlaceholderText('سعر السطر')) {
      expect(tokens(box)).toEqual(expect.arrayContaining(['h-11', 'md:h-10']));
    }
    // The quantity box shares the editor's field class.
    for (const q of screen.getAllByDisplayValue(/^[12]$/)) expect(tokens(q)).toContain('h-11');
  });

  it('the line figure goes to the end of its line when the row wraps; the price box keeps the floor it had', () => {
    render(<Harness />);
    const price = screen.getAllByPlaceholderText('سعر السطر')[0];
    const label = price.closest('label')!;
    expect(tokens(label)).toEqual(expect.arrayContaining(['flex-1', 'min-w-[150px]']));
    const figure = label.nextElementSibling!;
    expect(tokens(figure)).toEqual(expect.arrayContaining(['w-24', 'ms-auto']));
  });

  it('and it edits exactly as before: + raises the quantity, typing sets the price', () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole('button', { name: 'زد الكمية' })[0]);
    expect((screen.getAllByDisplayValue('2')[0] as HTMLInputElement).value).toBe('2');
    const box = screen.getAllByPlaceholderText('سعر السطر')[1] as HTMLInputElement;
    fireEvent.change(box, { target: { value: '47' } });
    expect(box.value).toBe('47');
  });
});
