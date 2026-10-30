// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * THE CONFIRMATION DESK GIVES THE CONTACT STRIP THE COUNTRY'S CALLING CODE.
 *
 * Order SY-2026-0002, phone 0952554562, on the «لا يرد» list: the screen drew the strip without a code, so WhatsApp
 * opened +95 (Myanmar). The desk's response now carries `dialCode`, and the screen passes it to every strip it draws.
 */

const { apiJson, seen } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  seen: { props: [] as { phone?: string | null; countryCode?: string | null; orderId?: string | null; context?: Record<string, unknown> }[] },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', t: {}, currentUser: { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'orders.contact_log'], status: 'ACTIVE' } }),
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
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/orders/ContactButtons', () => ({
  ContactButtons: (p: { phone?: string | null; countryCode?: string | null; orderId?: string | null; context?: Record<string, unknown> }) => {
    seen.props.push(p);
    return <i data-contact />;
  },
}));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const order = (id: string, noAnswerCount: number) => ({
  id,
  orderNumber: `SY-${id}`,
  merchantRef: null,
  confirmationStatus: noAnswerCount > 0 ? 'NO_ANSWER' : 'NEW',
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
  noAnswerCount,
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع بغداد',
  region: { name: 'دمشق' },
  internalNotes: null,
  customerNotes: null,
  customer: { id: `c-${id}`, fullName: 'أبو محمد', phone: '952554562', rawPhone: '0952554562', city: 'المزة', address: 'عنوان', totalOrders: 1 },
  items: [{ id: 'l1', productName: 'كريم مرطب', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: 1, notes: 0 },
});

const desk = (dialCode?: string | null) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-30T08:00:00.000Z',
  ...(dialCode === undefined ? {} : { dialCode }),
  work: [order('W1', 0)],
  noAnswer: [order('0002', 1)],
  closedToday: [],
  confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
});

const draw = async (dialCode?: string | null) => {
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return desk(dialCode);
    throw new Error(`unexpected ${url}`);
  });
  render(<ConfirmationMineScreen />);
  await screen.findByText('SY-W1');
};

beforeEach(() => {
  vi.clearAllMocks();
  seen.props = [];
});
afterEach(cleanup);

describe('the desk passes the calling code it was sent', () => {
  it('Syria: «لا يرد» order SY-0002, phone 0952554562 → the strip gets 963', async () => {
    await draw('963');
    fireEvent.click(screen.getByRole('tab', { name: /^لا يرد/ }));
    await screen.findByText('SY-0002');
    const strip = seen.props.find((p) => p.orderId === '0002');
    expect(strip, 'ما انرسم شريط الاتصال للطلب').toBeTruthy();
    expect(strip!.phone).toBe('0952554562');
    expect(strip!.countryCode).toBe('963');
  });

  it('Jordan: the same screen hands over 962', async () => {
    await draw('962');
    expect(seen.props.length).toBeGreaterThan(0);
    for (const p of seen.props) expect(p.countryCode).toBe('962');
  });

  it('the message that rides with the link is unchanged: number, name, amount, governorate', async () => {
    await draw('963');
    const strip = seen.props[0];
    expect(strip).toBeTruthy();
    expect(strip!.context).toMatchObject({ orderNumber: 'SY-W1', customerName: 'أبو محمد', amount: 45, region: 'المزة' });
  });

  it('a desk with no code (an old response) passes nothing, so the strip shuts WhatsApp instead of guessing', async () => {
    await draw();
    expect(seen.props.length).toBeGreaterThan(0);
    for (const p of seen.props) expect(p.countryCode ?? null).toBeNull();
  });
});
