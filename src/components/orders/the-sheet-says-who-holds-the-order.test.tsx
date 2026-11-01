// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ORDER SHEET, DRAWN — WHAT AN AGENT READS ON AN ORDER SHE MAY NOT WORK (BACKLOG RV568)
 *
 * The helper (`pullFirstNotice`) is held by `src/lib/the-sheet-tells-the-truth-about-an-order-she-may-not-work.test.ts`; this draws the
 * real `OrderDetailModal` and reads the screen, because a sentence the helper gets right and the sheet never prints helps nobody.
 *
 *  · a colleague holds the order ⇒ «الطلب مع <الاسم>», no instruction to pull, and the call panel is NOT drawn;
 *  · nobody holds it and she may pull ⇒ today's sentence, word for word, and no call panel;
 *  · nobody holds it and she may not pull ⇒ «الطلب مو إلك», no instruction to pull, and no call panel;
 *  · the order is hers ⇒ no sentence, the call panel is drawn;
 *  · a manager (`orders.unlock`) on a colleague's order ⇒ no sentence, the call panel is drawn.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, apiJson, who, order } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  apiJson: vi.fn(),
  who: { user: null as unknown },
  order: { value: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: (...a: unknown[]) => apiJson(...a),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', t: { units: 'قطعة' }, currentUser: who.user }),
}));
vi.mock('@/hooks/useOrderOwnership', () => ({
  useOrderOwnership: () => ({ claim: vi.fn(), release: vi.fn(), busy: false, error: null, acquireLock: vi.fn() }),
}));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => ({ patch: vi.fn(), saving: false }) }));
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

const AGENT = {
  id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', status: 'ACTIVE',
  // CONFIRMATION_AGENT, live, 1/11 — the keys that matter here (she holds supervise and reassign; they excuse nobody).
  permissions: ['orders.view', 'orders.confirm', 'orders.contact_log', 'confirmation.work', 'confirmation.pull', 'confirmation.supervise', 'confirmation.reassign', 'insights.view'],
};
const AGENT_WITHOUT_PULL = { ...AGENT, permissions: AGENT.permissions.filter((k) => k !== 'confirmation.pull') };
const MANAGER = { id: 'm1', name: 'المدير', role: 'MANAGER', status: 'ACTIVE', permissions: ['orders.view', 'orders.confirm', 'orders.unlock', 'orders.assign', 'confirmation.work', 'insights.view'] };

const BASE = {
  id: 'o1', orderNumber: 'ORD-2026-1896', createdAt: '2026-11-01T06:00:00.000Z', source: 'Landing Page', status: 'NEW',
  confirmationStatus: 'IN_PROGRESS', state: 'CLAIMED', customer: { id: 'cu1', fullName: 'زبون', phone: '079', city: 'عمّان' },
  items: [], addOns: [], quantity: 1, totalAmount: 25, sellingPrice: 25, productNameSnapshot: 'كريم',
};
const heldBy = (id: string, name: string) => ({ ...BASE, claimedById: id, claimer: { id, name } });
const unheld = { ...BASE, confirmationStatus: 'NEW', state: 'NEW', claimedById: null, claimer: null };

/** The sentence the sheet said to everyone before RV568. */
const TODAYS_SENTENCE = 'اسحب الطلب أولاً — لا يمكن العمل على طلب ليس بين يديك. اسحبه من «اسحب التالي» أو افتحه من «طلباتي»، وبعدها اتصل وأكّد.';

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => ({ order: order.value, currency: 'JOD', cod: { subtotal: 25, discount: 0, deliveryFee: 0, cod: 25, includesDelivery: false } }),
  }));
  apiJson.mockResolvedValue({ events: [], channels: [] });
});
afterEach(cleanup);

async function draw(user: unknown, o: unknown) {
  who.user = user;
  order.value = o;
  render(<OrderDetailModal orderId="o1" isOpen onClose={() => {}} onRefresh={() => {}} />);
  await waitFor(() => expect(document.querySelector('[data-card="customer"]')).not.toBeNull());
}
const callPanel = () => document.querySelector('[data-card="call"]');
const noticeText = () => screen.queryByText('الطلب مو بين يديك')?.parentElement?.textContent ?? null;

describe('a colleague holds the order', () => {
  it('says WHO — «الطلب مع ليلى» — gives no instruction to pull, and draws no call panel', async () => {
    await draw(AGENT, heldBy('u2', 'ليلى'));
    const text = noticeText();
    expect(text, 'the sheet printed no sentence').not.toBeNull();
    expect(text).toContain('الطلب مع ليلى');
    expect(text, 'تعليمة سحب لطلب مع زميلتها').not.toMatch(/اسحب/);
    expect(text).not.toContain('طلباتي');
    expect(callPanel(), 'the call panel is drawn beside a sentence that says it is not hers').toBeNull();
  });

  it('and so for an agent who holds no pull at all', async () => {
    await draw(AGENT_WITHOUT_PULL, heldBy('u2', 'ليلى'));
    expect(noticeText()).toContain('الطلب مع ليلى');
    expect(callPanel()).toBeNull();
  });
});

describe('nobody holds the order', () => {
  it('and she may pull ⇒ today’s sentence, word for word, and no call panel', async () => {
    await draw(AGENT, unheld);
    expect(noticeText()).toContain(TODAYS_SENTENCE);
    expect(callPanel()).toBeNull();
  });

  it('and she may NOT pull ⇒ «الطلب مو إلك», no instruction to pull, and no call panel', async () => {
    await draw(AGENT_WITHOUT_PULL, unheld);
    const text = noticeText();
    expect(text).toContain('الطلب مو إلك');
    expect(text, 'تعليمة سحب لمن لا تملك السحب').not.toMatch(/اسحب|طلباتي/);
    expect(callPanel()).toBeNull();
  });
});

describe('nothing is owed', () => {
  it('the order is HERS ⇒ no sentence, and the call panel is drawn', async () => {
    await draw(AGENT, heldBy('u1', 'سارة'));
    expect(noticeText()).toBeNull();
    expect(callPanel()).not.toBeNull();
  });

  it('a manager (orders.unlock + orders.assign) on a colleague’s order ⇒ no sentence, and the call panel is drawn', async () => {
    await draw(MANAGER, heldBy('u2', 'ليلى'));
    expect(noticeText()).toBeNull();
    expect(callPanel()).not.toBeNull();
  });

  it('the order is already confirmed ⇒ there is nothing to pull it for: no sentence', async () => {
    await draw(AGENT, { ...heldBy('u2', 'ليلى'), confirmationStatus: 'CONFIRMED', state: 'CONFIRMED' });
    expect(noticeText()).toBeNull();
  });
});
