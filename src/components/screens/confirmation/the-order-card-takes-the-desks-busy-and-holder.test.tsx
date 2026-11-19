// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * R8d review (18/11) — WHAT THE SCREEN HANDS THE CARD REALLY REACHES IT (a render, not a substring pin).
 *
 *   1. While a press on a card is in the air (the screen's `busyId`), the SIX presses that took `busy` before are shut on THAT card —
 *      «لا يرد», «مغلق أو خارج التغطية», «تأكيد الطلب», «تأجيل», «ألغِ», «إدخال إشكال» — and the next card is not.
 *   2. A colleague's desk (read through «شاشة موظفة») hands the history NO holder; her own desk hands her own id.
 */

const { apiJson, history } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  history: [] as { orderId: string; holderId: string | null }[],
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: {},
    currentUser: {
      id: 'u1',
      name: 'سارة',
      role: 'CONFIRMATION_AGENT',
      permissions: ['confirmation.work', 'confirmation.pull', 'orders.contact_log', 'confirmation.raise_issue'],
      status: 'ACTIVE',
    },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({
  CustomerHistoryButton: (p: { orderId: string; holderId: string | null }) => {
    history.push({ orderId: p.orderId, holderId: p.holderId });
    return null;
  },
  CustomerHistoryOffer: () => null,
}));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => null }));

import { ConfirmationMineScreen } from '../ConfirmationMineScreen';

const row = (id: string, number: string) => ({
  id,
  orderNumber: number,
  merchantRef: null,
  confirmationStatus: 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 1,
  totalAmount: 45,
  currency: 'SYP',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'MANUAL',
  regionId: 'r1',
  region: { name: 'دمشق' },
  moderatorId: 'm1',
  moderator: { id: 'm1', name: 'مدخلة' },
  createdBy: null,
  channel: null,
  customer: { id: `c-${id}`, fullName: 'نور', phone: '0952554562', rawPhone: '0952554562', city: 'دمشق', address: 'شارع' },
  items: [],
  _count: { contactAttempts: 1, notes: 0 },
  risk: null,
});

let viewing: unknown = undefined;

beforeEach(() => {
  vi.clearAllMocks();
  history.length = 0;
  viewing = undefined;
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.startsWith('/api/confirmation/mine')) {
      return {
        leadDays: 2,
        waitingLater: 0,
        noAnswerLimit: 3,
        dialCode: '963',
        serverNow: '2026-11-18T09:00:00.000Z',
        work: [row('o-1', 'SY-26-1001'), row('o-2', 'SY-26-1002')],
        noAnswer: [],
        closedToday: [],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
        ...(viewing ? { viewing } : {}),
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 0, owned: { total: 2, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: false, refusal: null, autoReleased: 0, orders: null };
    }
    // The confirmation stays in the air: the screen's busy flag holds for as long as the test looks.
    if (url.endsWith('/confirmation') && init?.method === 'POST') return new Promise(() => undefined);
    return { ok: true };
  });
});
afterEach(cleanup);

const SIX = [/^لا يرد/, /^مغلق أو خارج التغطية$/, /^تأكيد الطلب$/, /^تأجيل/, /^ألغِ$/, /^إدخال إشكال$/];

describe('the screen’s busy flag reaches the card it is about, and only that one', () => {
  it('a confirmation in the air shuts the six presses of its card; the next card stays open', async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByText('SY-26-1002');
    const first = document.getElementById('desk-order-o-1')!;
    const second = document.getElementById('desk-order-o-2')!;
    for (const name of SIX) expect((within(first).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(within(first).getByRole('button', { name: /^تأكيد الطلب$/ }));
    await waitFor(() => expect((within(first).getByRole('button', { name: /^ألغِ$/ }) as HTMLButtonElement).disabled).toBe(true));
    for (const name of SIX) expect((within(first).getByRole('button', { name }) as HTMLButtonElement).disabled, String(name)).toBe(true);
    // «افتح وعدّل» never took `busy`: it stays open.
    expect((within(first).getByRole('button', { name: /^افتح وعدّل$/ }) as HTMLButtonElement).disabled).toBe(false);
    for (const name of SIX) expect((within(second).getByRole('button', { name }) as HTMLButtonElement).disabled, String(name)).toBe(false);
  });
});

describe('the history’s holder is hers on her own desk, and nobody’s on a colleague’s', () => {
  it('her own desk: her id', async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByText('SY-26-1001');
    expect(history.filter((h) => h.orderId === 'o-1').at(-1)?.holderId).toBe('u1');
  });

  it('a colleague’s desk: null', async () => {
    viewing = { id: 'u2', name: 'هدى', readOnly: true };
    render(<ConfirmationMineScreen />);
    await screen.findByText('SY-26-1001');
    await screen.findAllByText(/للقراءة فقط — هذا الطلب بيد هدى/);
    expect(history.filter((h) => h.orderId === 'o-1').at(-1)?.holderId).toBeNull();
    expect(screen.queryByRole('button', { name: /^تأكيد الطلب$/ })).toBeNull();
  });
});
