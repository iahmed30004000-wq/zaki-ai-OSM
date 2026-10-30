// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { arDateTime } from '@/lib/format';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER SHEET ON A PHONE — ORD-06 · ORD-10 (M8 of the phone audit).
 *
 * ORD-06. The sheet's three columns stack into one on a phone, in the DESK's order: responsibility, state,
 * customer, lines, shipping, stages, notes, the change request, the risk, the call outcome — and only then the
 * money. An agent who opened an order to confirm it scrolled past eight cards to reach «تسجيل نتيجة الاتصال», and
 * the amount to read aloud on the call («المحصَّل عند الباب») was near the very bottom.
 *
 * ORD-10. The header joined up to seven facts with « • » in one string; at 295px that is four to six lines of
 * mixed Arabic and Latin that flip direction mid-line.
 *
 * WHAT THIS HOLDS
 *   • a phone draws the call right after the customer, and says the figure to read aloud before it; the lines, the
 *     shipping, the stages and the notes come after;
 *   • the call block is ONE copy in either place — the same components, drawn once;
 *   • a phone's header keeps the date and the channel and lists the rest, one box each, in «جهة الطلب»;
 *   • A DESK IS WHAT IT WAS: the old order of the cards, no extra figure, and the header string character for
 *     character the one the old template built.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, apiJson, phone } = vi.hoisted(() => ({ apiFetch: vi.fn(), apiJson: vi.fn(), phone: { value: false } }));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: { units: 'قطعة' },
    currentUser: {
      id: 'u1',
      name: 'سارة',
      role: 'CONFIRMATION_AGENT',
      permissions: ['orders.view', 'confirmation.work', 'orders.confirm', 'insights.view'],
      status: 'ACTIVE',
    },
  }),
}));
vi.mock('@/hooks/useOrderOwnership', () => ({
  useOrderOwnership: () => ({ claim: vi.fn(), release: vi.fn(), busy: false, error: null, acquireLock: vi.fn() }),
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => ({ patch: vi.fn(), saving: false }) }));
/* Each card is somebody else's subject: a marker is enough to say WHERE it was drawn. */
vi.mock('@/components/orders/OrderResponsibility', () => ({ OrderResponsibility: () => <i data-card="responsibility" /> }));
vi.mock('@/components/orders/CustomerCard', () => ({ CustomerCard: () => <i data-card="customer" /> }));
vi.mock('@/components/orders/OrderLinesCard', () => ({ OrderLinesCard: () => <i data-card="lines" /> }));
vi.mock('@/components/orders/ConfirmationActions', () => ({ ConfirmationActions: () => <i data-card="call" /> }));
vi.mock('@/components/orders/ShapeRiskPanel', () => ({ ShapeRiskPanel: () => <i data-card="shape-risk" /> }));
vi.mock('@/components/orders/DuplicateSuspectNotice', () => ({ DuplicateSuspectNotice: () => <i data-card="duplicate" /> }));
vi.mock('@/components/orders/ShippingSection', () => ({ ShippingSection: () => <i data-card="shipping" /> }));
vi.mock('@/components/orders/OrderStages', () => ({ OrderStages: () => <i data-card="stages" /> }));
vi.mock('@/components/orders/OrderNotes', () => ({ OrderNotes: () => <i data-card="notes" /> }));
vi.mock('@/components/orders/OrderStateBadge', () => ({ OrderStateBadge: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryModal: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null }));
vi.mock('@/components/orders/raiseChangeRequest', () => ({ raiseChangeRequest: vi.fn() }));
vi.mock('@/components/ui/ProductThumb', () => ({ ProductThumb: () => <span /> }));

import { OrderDetailModal } from './OrderDetailModal';

const CREATED = '2026-10-15T06:00:00.000Z';
const ORDER = {
  id: 'o1',
  orderNumber: 'ORD-5',
  createdAt: CREATED,
  source: 'Landing Page',
  landingPage: { name: 'صفحة الكريم' },
  offer: { name: 'اشترِ 3 واحصل على 1' },
  status: 'NEW',
  confirmationStatus: 'NEW',
  state: 'NEW',
  customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  items: [],
  addOns: [],
  quantity: 3,
  totalAmount: 84,
  sellingPrice: 84,
  productNameSnapshot: 'كريم',
};

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ order: ORDER, currency: 'JOD', cod: { subtotal: 84, discount: 0, deliveryFee: 0, cod: 84, includesDelivery: false } }),
  }));
  apiJson.mockResolvedValue({ events: [], channels: [] });
});
afterEach(cleanup);

const draw = async () => {
  render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-card="customer"]')).not.toBeNull());
};
/** The marked cards, top to bottom. */
const cards = () => [...document.querySelectorAll('[data-card]')].map((el) => el.getAttribute('data-card'));
const subtitle = () => screen.getByText(/^أُنشئ في/).textContent;

describe('where the call outcome sits', () => {
  it('A DESK: it ends the left column, after the notes — where it always was', async () => {
    await draw();
    expect(cards()).toEqual(['responsibility', 'customer', 'lines', 'shipping', 'stages', 'notes', 'duplicate', 'shape-risk', 'call']);
  });

  it('A PHONE: it comes straight after the customer, and the lines, shipping, stages and notes follow', async () => {
    phone.value = true;
    await draw();
    expect(cards()).toEqual(['responsibility', 'customer', 'duplicate', 'shape-risk', 'call', 'lines', 'shipping', 'stages', 'notes']);
  });

  it('either way the call block is drawn ONCE — a second copy is a second set of buttons', async () => {
    for (const isPhone of [false, true]) {
      cleanup();
      phone.value = isPhone;
      await draw();
      for (const card of ['call', 'shape-risk', 'duplicate', 'customer', 'lines']) {
        expect(document.querySelectorAll(`[data-card="${card}"]`), `${card} (${isPhone ? 'phone' : 'desk'})`).toHaveLength(1);
      }
    }
  });
});

describe('the figure to read aloud', () => {
  it('A PHONE says «المحصَّل عند الباب» before the call, with the one figure the summary below already prints', async () => {
    phone.value = true;
    await draw();
    const line = screen.getByText('المحصَّل عند الباب');
    expect(line.parentElement?.textContent).toContain('84');
    // the line sits ABOVE the call block
    const call = document.querySelector('[data-card="call"]')!;
    expect(line.compareDocumentPosition(call) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and the summary further down is still there, with its colon, as before.
    expect(screen.getByText('المحصَّل عند الباب:')).toBeTruthy();
  });

  it('A DESK has no such line: only the summary', async () => {
    await draw();
    expect(screen.queryByText('المحصَّل عند الباب')).toBeNull();
    expect(screen.getByText('المحصَّل عند الباب:')).toBeTruthy();
  });
});

describe('the header', () => {
  it('A DESK: the one string the old template built, joined with « • », character for character', async () => {
    await draw();
    expect(subtitle()).toBe(
      `أُنشئ في ${arDateTime(CREATED)} • قناة الطلب: Landing Page • صفحة الهبوط: صفحة الكريم • العرض: اشترِ 3 واحصل على 1`
    );
  });

  it('A DESK, a Telegram order: the message and the thread stay in the header', async () => {
    apiFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({
        order: { ...ORDER, source: 'Telegram → قناة', landingPage: null, offer: null, telegramMessages: [{ messageId: 77, threadId: 5, threadName: 'الموضوع' }] },
        currency: 'JOD',
        cod: null,
      }),
    }));
    await draw();
    expect(subtitle()).toBe(`أُنشئ في ${arDateTime(CREATED)} • قناة الطلب: Telegram • المصدر: قناة • تيليجرام: رسالة #77 • موضوع: الموضوع`);
  });

  it('A PHONE: the date and the channel in the header; the rest one box each in «جهة الطلب»', async () => {
    phone.value = true;
    await draw();
    expect(subtitle()).toBe(`أُنشئ في ${arDateTime(CREATED)} • قناة الطلب: Landing Page`);
    for (const fact of ['صفحة الهبوط: صفحة الكريم', 'العرض: اشترِ 3 واحصل على 1']) {
      const box = screen.getByText(fact);
      expect(box.tagName).toBe('P');
      expect(box.getAttribute('dir'), fact).toBe('auto');
    }
    // nothing is lost: the channel is not repeated in the card (it is in the header), and no fact is said twice.
    expect(screen.queryAllByText('قناة الطلب: Landing Page')).toHaveLength(0);
    expect(screen.queryAllByText(/صفحة الهبوط/)).toHaveLength(1);
  });

  it('A PHONE, an order with a source after the arrow: «المصدر» is a box of its own', async () => {
    phone.value = true;
    apiFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ order: { ...ORDER, source: 'Sheet import → Facebook', landingPage: null, offer: null }, currency: 'JOD', cod: null }),
    }));
    await draw();
    expect(subtitle()).toBe(`أُنشئ في ${arDateTime(CREATED)} • قناة الطلب: Sheet import`);
    expect(screen.getByText('المصدر: Facebook').getAttribute('dir')).toBe('auto');
  });

  it('A DESK has no origin boxes in the card — the header says it all', async () => {
    await draw();
    expect(screen.queryByText('صفحة الهبوط: صفحة الكريم')).toBeNull();
  });
});
