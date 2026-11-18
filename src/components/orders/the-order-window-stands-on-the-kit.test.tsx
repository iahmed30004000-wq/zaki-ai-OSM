// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CARD_CLASS } from '@/lib/theme-shape';
import { countsOf } from '../../../scripts/ui-debt';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER WINDOW ON THE KIT (R10b, 18/11).
 *
 * The one window every screen opens an order in — «الطلبات», «طلباتي», the preparation, the tracking — drew its sections
 * as hand-made boxes and its presses as hand-made buttons. It now draws them with the kit: each section a nested
 * `Card plain` (inside a dialog, so none of the theme's page decor lands on dense rows), each press a `Button` /
 * `IconButton`, the «شامل التوصيل» box the kit's `Checkbox`.
 *
 * A LOOK, AND NOTHING ELSE. So what this file holds is what must NOT have moved:
 *   • the same presses, in the same order, on an order in each of five states — and the same counts of buttons,
 *     fields and sections (the table of the PR);
 *   • every press that writes sends the same request, to the same door, with the same body — confirm, the three call
 *     results, a shipping step, the money box (a dry run first, then the write) — and an order that is finished
 *     offers no press that writes at all;
 *   • the money summary prints the same figures;
 *   • on a 375px phone the sections stack and nothing in the window is wider than the screen.
 * Before it merged, the same presses were run against the window as it was on main and compared one for one (232
 * presses, ten scenarios, every text, figure and request body equal) — the PR says how.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, apiJson, patch, phone } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  patch: vi.fn(async () => ({ ok: true })),
  phone: { value: false },
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a), apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
const CTX = {
  locale: 'ar',
  isRtl: true,
  t: new Proxy({}, { get: (_t, k) => String(k) }),
  currentUser: { id: 'u1', name: 'المالك', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' },
};
vi.mock('@/context/AppContext', () => ({ useApp: () => CTX, useAppOptional: () => CTX }));
vi.mock('@/hooks/useOrderOwnership', () => ({
  useOrderOwnership: () => ({ acquireLock: async () => true, releaseLock: async () => {}, inEditMode: false, message: null }),
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => patch }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [{ id: 'r1', name: 'عمّان' }], countryName: 'الأردن', currency: null }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [{ id: 'p1', name: 'كريم', basePrice: 40, offers: [] }], loading: false }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: () => {}, done: () => {}, warn: () => {} }) }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => async () => null, useConfirm: () => async () => true, useTell: () => () => {} }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span /> }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryModal: () => <i data-history /> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => <i data-change-request /> }));
vi.mock('@/components/orders/OrderPieces', () => ({ OrderPieces: () => null }));
vi.mock('@/components/orders/RatingLinkButton', () => ({ RatingLinkButton: () => <i data-rating /> }));

import { OrderDetailModal } from './OrderDetailModal';

const BASE = {
  id: 'o1', orderNumber: 'ORD-9', version: 3, createdAt: '2026-11-01T08:00:00.000Z', source: 'Landing Page',
  landingPage: { name: 'صفحة' }, offer: { name: 'عرض 2' }, settlementStatus: 'PENDING',
  claimedById: 'u1', claimedBy: { id: 'u1', name: 'سارة' }, claimedAt: '2026-11-01T09:00:00.000Z', lockedById: null,
  customer: { id: 'c1', fullName: 'زبون تجريبي', phone: '0790000000', rawPhone: '0790000000', altPhone: null, totalOrders: 3, city: 'عمّان', address: 'شارع' },
  regionId: 'r1', region: { id: 'r1', name: 'عمّان' }, deliveryAddress: 'شارع 1',
  items: [{ id: 'l1', productId: 'p1', productName: 'كريم', quantity: 2, unitPrice: 40, lineTotal: 80, freeQuantity: 1 }],
  addOns: [{ productName: 'صابون', quantity: 1, total: 5 }],
  quantity: 2, freeQuantity: 1, sellingPrice: 80, discountAmount: 4, deliveryFee: 3, shippingCost: 3, totalAmount: 84,
  priceIncludesDelivery: false, estimatedCostOfGoods: 20, commission: 2, productNameSnapshot: 'كريم', channelId: null,
  moderator: { name: 'مدخل' }, _count: { contactAttempts: 1, deliveryAttempts: 0 }, customerNotes: 'اتصل مساءً',
};
const SHIPPER = { deliveryProvider: { id: 'd1', name: 'شركة', kind: 'COMPANY' }, trackingNumber: 'TRK1' };
const ORDERS = {
  NEW: { ...BASE, status: 'NEW', confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', state: 'NEW' },
  CONFIRMED: { ...BASE, status: 'CONFIRMED', confirmationStatus: 'CONFIRMED', shippingStatus: 'READY_FOR_SHIPPING', state: 'CONFIRMED' },
  SHIPPED: { ...BASE, ...SHIPPER, status: 'SHIPPED', confirmationStatus: 'CONFIRMED', shippingStatus: 'OUT_FOR_DELIVERY', state: 'SHIPPED', labelPrintedAt: '2026-11-02T09:00:00.000Z' },
  DELIVERED: { ...BASE, ...SHIPPER, status: 'DELIVERED', confirmationStatus: 'CONFIRMED', shippingStatus: 'DELIVERED', state: 'DELIVERED', settlementStatus: 'COLLECTED' },
  CANCELLED: { ...BASE, status: 'CANCELLED', confirmationStatus: 'CANCELLED', shippingStatus: 'CANCELLED', state: 'CANCELLED' },
};
type State = keyof typeof ORDERS;
const COD = { subtotal: 80, discount: 4, deliveryFee: 3, cod: 79, includesDelivery: false };

let order: (typeof ORDERS)[State] = ORDERS.NEW;
beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  apiFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (/^\/api\/orders\/o1(\?|$)/.test(url) && (!init?.method || init.method === 'GET')) {
      return { ok: true, status: 200, json: async () => ({ order, currency: { code: 'JOD', minorUnit: 3 }, cod: COD }) };
    }
    return { ok: true, status: 200, json: async () => ({ attempts: [], summary: { total: 1 } }) };
  });
  apiJson.mockImplementation(async (url: string) =>
    url.includes('shape-risk') ? Promise.reject(new Error('—')) : url.includes('/timeline') ? { events: [] } : url.includes('/notes') ? { notes: [] } : { channels: [], suspect: false }
  );
});
afterEach(cleanup);

const flush = async () => {
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
async function draw(state: State) {
  order = ORDERS[state];
  render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
  await screen.findAllByText(/ORD-9/);
  await flush();
}
const norm = (s: string | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const presses = () => [...document.body.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? norm(b.textContent));
/** The writes since the last clear, through either client: [door, method, body]. */
const writes = () =>
  [...apiFetch.mock.calls, ...apiJson.mock.calls]
    .filter(([, init]) => init?.method && init.method !== 'GET')
    .map(([url, init]) => [url, init.method, JSON.parse(init.body)]);
const press = async (name: string) => {
  fireEvent.click(screen.getByRole('button', { name }));
  await flush();
};

/* ───────────────────── 1. the same presses and the same counts ───────────────────── */

const COMMON_HEAD = ['إغلاق', 'استلمه أنا', 'طلبات سابقة (2)', 'تعديل', 'تعديل'];
const PRESSES: Record<State, string[]> = {
  NEW: [...COMMON_HEAD, 'أضف الملاحظة (Enter)', 'العميل أجاب', 'لا يرد', 'تأجيل', 'متابعة', 'تأكيد الطلب', 'العميل رفض', 'رقم خاطئ', 'تعديل'],
  CONFIRMED: [...COMMON_HEAD, 'بدء التغليف', 'رقم التتبع', 'أضف الملاحظة (Enter)', 'تعديل · إلغاء · تأجيل', 'تعديل'],
  SHIPPED: [...COMMON_HEAD, 'تم التسليم', 'فشل التوصيل', 'تسجيل محاولة', 'أضف الملاحظة (Enter)', 'تعديل · إلغاء · تأجيل', 'تعديل'],
  DELIVERED: [...COMMON_HEAD, 'أضف الملاحظة (Enter)', 'تعديل · إلغاء · تأجيل', 'تعديل'],
  CANCELLED: [...COMMON_HEAD, 'أضف الملاحظة (Enter)', 'تعديل'],
};
/** Fields and sections, as main drew them before the kit (the «شامل التوصيل» box is a field while the parcel is here). */
const COUNTS: Record<State, { fields: number; sections: number }> = {
  NEW: { fields: 2, sections: 9 },
  CONFIRMED: { fields: 2, sections: 10 },
  SHIPPED: { fields: 1, sections: 10 },
  DELIVERED: { fields: 1, sections: 10 },
  CANCELLED: { fields: 1, sections: 9 },
};

describe('the same window, in five states', () => {
  for (const state of Object.keys(ORDERS) as State[]) {
    it(`${state}: the same presses in the same order, the same fields and sections, no form a kit button could submit`, async () => {
      await draw(state);
      expect(presses()).toEqual(PRESSES[state]);
      expect(document.body.querySelectorAll('input, select, textarea')).toHaveLength(COUNTS[state].fields);
      expect(document.body.querySelectorAll('h4')).toHaveLength(COUNTS[state].sections);
      // The kit's Button sets no `type`: inside a <form> it would submit. The window has none.
      expect(document.body.querySelectorAll('form')).toHaveLength(0);
    });
  }
});

/* ───────────────────── 2. every press that writes sends what it sent ───────────────────── */

describe('a press reaches the same door with the same body', () => {
  it('NEW: the three call results, each the same two requests', async () => {
    for (const [name, result] of [['العميل أجاب', 'ANSWERED'], ['لا يرد', 'NO_ANSWER'], ['رقم خاطئ', 'WRONG_NUMBER']] as const) {
      cleanup();
      await draw('NEW');
      apiFetch.mockClear();
      apiJson.mockClear();
      await press(name);
      expect(writes(), name).toEqual([
        ['/api/orders/o1/contact-attempts', 'POST', { contactMethod: 'PHONE', result }],
        ['/api/orders/o1/confirmation', 'POST', { action: 'contact_result', result, expectedVersion: 3 }],
      ]);
    }
  });

  it('NEW: «تأكيد الطلب» opens the form and writes nothing; its «تأكيد» sends the confirmation', async () => {
    await draw('NEW');
    apiFetch.mockClear();
      apiJson.mockClear();
    await press('تأكيد الطلب');
    expect(writes()).toEqual([]);
    await press('تأكيد');
    expect(writes()).toEqual([
      ['/api/orders/o1/contact-attempts', 'POST', { contactMethod: 'PHONE', result: 'CONFIRMED', note: '' }],
      ['/api/orders/o1/confirmation', 'POST', { action: 'confirm', result: 'CONFIRMED', note: '', expectedVersion: 3 }],
    ]);
  });

  it('NEW: the forms open and write nothing until their own save', async () => {
    for (const name of ['تأجيل', 'متابعة', 'العميل رفض', 'استلمه أنا', 'طلبات سابقة (2)']) {
      cleanup();
      await draw('NEW');
      apiFetch.mockClear();
      apiJson.mockClear();
      await press(name);
      expect(writes(), name).toEqual([]);
      expect(patch, name).not.toHaveBeenCalled();
    }
  });

  it('the customer, the lines and the channel save through the same patch, with the same body', async () => {
    await draw('NEW');
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' })[0]);
    await flush();
    await press('حفظ بيانات العميل');
    expect(patch).toHaveBeenCalledWith('o1', {
      expectedVersion: 3, customerName: 'زبون تجريبي', customerPhone: '0790000000', customerAltPhone: null, customerAddress: 'شارع', regionId: 'r1',
    });
    cleanup();
    patch.mockClear();
    await draw('CANCELLED');
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' }).at(-1)!);
    await flush();
    await press('حفظ القناة');
    expect(patch.mock.calls[0].slice(0, 2)).toEqual(['o1', { expectedVersion: 3, channelId: null }]);
  });

  it('CONFIRMED: a shipping step is the same transition; «شامل التوصيل» asks the door dry first, then writes', async () => {
    await draw('CONFIRMED');
    apiFetch.mockClear();
      apiJson.mockClear();
    await press('بدء التغليف');
    expect(writes()).toEqual([['/api/orders/o1/shipping', 'POST', { action: 'transition', to: 'PACKING', expectedVersion: 3 }]]);

    cleanup();
    await draw('CONFIRMED');
    apiFetch.mockClear();
      apiJson.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: 'شامل التوصيل' }));
    await flush();
    expect(writes()).toEqual([
      ['/api/orders/o1/delivery-included', 'POST', { included: true, expectedVersion: 3, dryRun: true }],
      ['/api/orders/o1/delivery-included', 'POST', { included: true, expectedVersion: 3 }],
    ]);
  });

  it('SHIPPED: «تم التسليم» is the same transition; «فشل التوصيل» only opens its form', async () => {
    await draw('SHIPPED');
    apiFetch.mockClear();
      apiJson.mockClear();
    await press('تم التسليم');
    expect(writes()).toEqual([['/api/orders/o1/shipping', 'POST', { action: 'transition', to: 'DELIVERED', expectedVersion: 3 }]]);
    cleanup();
    await draw('SHIPPED');
    apiFetch.mockClear();
      apiJson.mockClear();
    await press('فشل التوصيل');
    expect(writes()).toEqual([]);
  });

  it('DELIVERED and CANCELLED: no press in the window writes anything, and the money box is gone', async () => {
    for (const state of ['DELIVERED', 'CANCELLED'] as const) {
      for (const [i, name] of PRESSES[state].entries()) {
        cleanup();
        await draw(state);
        expect(screen.queryByRole('checkbox'), state).toBeNull();
        apiFetch.mockClear();
      apiJson.mockClear();
        const b = document.body.querySelectorAll('button')[i] as HTMLButtonElement;
        if (!b.disabled) fireEvent.click(b);
        await flush();
        expect(writes(), `${state} · ${name}`).toEqual([]);
      }
    }
  });

  it('the note press is shut while the note is too short, and the window still draws its send', async () => {
    await draw('NEW');
    const send = screen.getByRole('button', { name: 'أضف الملاحظة (Enter)' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});

/* ───────────────────── 3. the money summary ───────────────────── */

describe('the money summary prints the figures it printed', () => {
  it('goods, discount, delivery, at the door, and our costs', async () => {
    await draw('CONFIRMED');
    const text = norm(document.body.textContent);
    for (const figure of ['قيمة البضاعة:80.000 JOD', 'الخصم:− 4.000 JOD', 'أجرة التوصيل:3.000 JOD', 'المحصَّل عند الباب:79.000 JOD', 'تكلفة البضاعة:20.000 JOD', 'العمولة:2.000 JOD']) {
      expect(text, figure).toContain(figure);
    }
    expect(text).toContain('صابون ×1 (5.000 JOD)');
  });
});

/* ───────────────────── 4. the look: nested cards, a phone ───────────────────── */

describe('the sections are the kit card, without the theme decor', () => {
  it('every section heading sits in a plain card (no page-level decor inside a dialog)', async () => {
    await draw('SHIPPED');
    const headings = [...document.body.querySelectorAll('h4')];
    expect(headings.length).toBeGreaterThan(5);
    for (const h of headings) {
      const card = h.closest('.rounded-lg.border');
      expect(card, norm(h.textContent)).not.toBeNull();
      expect(card!.classList.contains(CARD_CLASS), norm(h.textContent)).toBe(false);
    }
  });
});

describe('a 375px phone', () => {
  it('the columns stack and no class asks for more width than the screen', async () => {
    phone.value = true;
    await draw('NEW');
    const grid = [...document.body.querySelectorAll('.grid')].find((g) => g.className.includes('lg:grid-cols-3'))!;
    const unprefixed = grid.className.split(/\s+/).filter((c) => /^grid-cols-\d+$/.test(c));
    expect(unprefixed).toEqual(['grid-cols-1']);
    const wide: string[] = [];
    for (const el of document.body.querySelectorAll('[class]')) {
      for (const c of el.getAttribute('class')!.split(/\s+/)) {
        const px = c.match(/^(?:min-)?w-\[(\d+)px\]$/);
        if ((px && Number(px[1]) > 375) || c === 'w-screen') wide.push(c);
      }
    }
    expect(wide).toEqual([]);
  });
});

/* ───────────────────── 5. the zone carries no hand-drawn press or surface ───────────────────── */

const ZONE = ['OrderDetailModal', 'OrderLinesCard', 'ShippingSection', 'CustomerCard', 'OrderStages', 'OrderResponsibility', 'OrderNotes',
  'ConfirmationActions', 'DeliveryIncludedBox', 'ShapeRiskPanel', 'DuplicateSuspectNotice', 'IntakeNotice'];

describe('the twelve files of the window', () => {
  it('draw no raw button, raw box or hand-made surface — the kit does', () => {
    for (const file of ZONE) {
      const counts = countsOf(readFileSync(join(process.cwd(), 'src/components/orders', `${file}.tsx`), 'utf8'));
      expect([counts.rawButtons, counts.rawCheckboxes, counts.rawSurfaces], file).toEqual([0, 0, 0]);
    }
  });

  it('the counter would see one if it came back (negative)', () => {
    const back = countsOf('<div className="bg-[var(--sys-card)] border border-[var(--sys-border)] rounded-lg p-4"><button onClick={go}>x</button></div>');
    expect([back.rawButtons, back.rawSurfaces]).toEqual([1, 1]);
  });
});
