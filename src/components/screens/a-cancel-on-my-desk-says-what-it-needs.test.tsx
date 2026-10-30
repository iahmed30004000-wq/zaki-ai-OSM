// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «ألغِ» ON «طلباتي» (30/10).
 *
 * The cancel is the `reject` action, and it is locked until the order carries a contact attempt (C1, unchanged). Two
 * things the screen owed the agent:
 *
 *   · the reason for a locked button is a LINE on the card, readable on a phone — not only the tooltip a finger never
 *     triggers — and it says how to unlock;
 *   · a refusal from the door (`CONTACT_FIRST`, `INVALID_TRANSITION`) is shown as an Arabic sentence that says what to
 *     do next, not as a bare line or a generic toast.
 *
 * (The server's table now lets «ألغِ» through from «لا يرد» / «يحتاج متابعة» / «مؤجل» — see
 * `api/orders/[id]/confirmation/a-waiting-order-can-be-cancelled.test.ts`.)
 */

const { apiJson, user } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
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
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';
import { CONTACT_FIRST_MESSAGE } from '@/lib/confirmation-queue';

const order = (attempts: number) => ({
  id: 'W1',
  orderNumber: 'ORD-W1',
  merchantRef: null,
  confirmationStatus: attempts > 0 ? 'NO_ANSWER' : 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: attempts,
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء',
  region: { name: 'دمشق' },
  customerNotes: null,
  customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'المزة', address: 'عنوان' },
  items: [{ id: 'l1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: attempts, notes: 0 },
});

const desk = (attempts: number) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-30T08:00:00.000Z',
  work: [order(attempts)],
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
});

const refusal = (message: string, code: string) => Object.assign(new Error(message), { status: 409, data: { errorAr: message, code } });

const draw = async (attempts: number, keys = ['confirmation.work', 'orders.contact_log']) => {
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: keys, status: 'ACTIVE' };
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url.startsWith('/api/confirmation/mine')) return desk(attempts);
    if (init?.method === 'POST') throw refusal('رفض', 'OTHER');
    throw new Error(`unexpected ${url}`);
  });
  render(<ConfirmationMineScreen />);
  await screen.findByText('ORD-W1');
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('the lock says why, on the card', () => {
  it('(أ) an order nobody has tried to reach: «ألغِ» is shut and a line under it says what unlocks it — no hover needed', async () => {
    await draw(0);
    const cancel = screen.getByRole('button', { name: /^ألغِ$/ }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    expect(screen.getByText(/اتصل بالزبون أول — بعدها بتفتح الأزرار/).textContent).toMatch(/«لا يرد» أو «مغلق أو خارج التغطية»/);
  });

  it('(ب) NEGATIVE: with an attempt on the order the button is open and no lock line is drawn', async () => {
    await draw(1);
    expect((screen.getByRole('button', { name: /^ألغِ$/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/اتصل بالزبون أول/)).toBeNull();
  });

  it('(ج) without the key that records a call, the line says so instead of pointing at buttons that are not there', async () => {
    await draw(0, ['confirmation.work']);
    const line = screen.getByText(/اتصل بالزبون أول — بعدها بتفتح الأزرار/).textContent ?? '';
    expect(line).toMatch(/صلاحية/);
    expect(line).not.toMatch(/«لا يرد» أو «مغلق/);
  });
});

describe('a refusal from the door is a sentence with a next step', () => {
  const cancelAndSubmit = async () => {
    fireEvent.click(screen.getByRole('button', { name: /^ألغِ$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'ألغِ الطلب' }));
  };

  it('(د) a clean cancel sends the reject action for this order, with the version she loaded', async () => {
    await draw(1);
    apiJson.mockImplementation(async (url: string) => (url.startsWith('/api/confirmation/mine') ? desk(1) : { success: true }));
    await cancelAndSubmit();
    await waitFor(() => {
      const call = apiJson.mock.calls.find((c) => String(c[0]) === '/api/orders/W1/confirmation');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as { body: string }).body)).toMatchObject({ action: 'reject', expectedVersion: 4 });
    });
  });

  it('(هـ) INVALID_TRANSITION: the server’s Arabic sentence, then what to do', async () => {
    await draw(1);
    apiJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/confirmation/mine')) return desk(1);
      throw refusal('لا يمكن الانتقال من «مؤكد» إلى «مرفوض» — هذا الإجراء غير مسموح على حالة الطلب الآن.', 'INVALID_TRANSITION');
    });
    await cancelAndSubmit();
    const text = (await screen.findByText(/لا يمكن الانتقال من «مؤكد» إلى «مرفوض»/)).textContent ?? '';
    expect(text).toMatch(/حدّث الشاشة وافتح الطلب/);
  });

  it('(و) CONTACT_FIRST: names the buttons that record the attempt', async () => {
    await draw(1);
    apiJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/confirmation/mine')) return desk(1);
      throw refusal(CONTACT_FIRST_MESSAGE, 'CONTACT_FIRST');
    });
    await cancelAndSubmit();
    const text = (await screen.findByText(/اتصل بالزبون أول — أو اكبس/)).textContent ?? '';
    expect(text).toMatch(/«لا يرد» أو «مغلق أو خارج التغطية»/);
  });

  it('(ز) NEGATIVE: any other refusal keeps the server’s own sentence, unchanged', async () => {
    await draw(1);
    apiJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/confirmation/mine')) return desk(1);
      throw refusal('عدّل هذا الطلبَ شخصٌ آخر قبلك — أعد تحميل الصفحة ثم احفظ', 'VERSION_CONFLICT');
    });
    await cancelAndSubmit();
    const text = (await screen.findByText(/عدّل هذا الطلبَ شخصٌ آخر قبلك/)).textContent ?? '';
    expect(text).not.toMatch(/حدّث الشاشة/);
  });
});
