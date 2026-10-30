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
import { REJECT_NEEDS_CALL_LINE, REJECT_NEEDS_CALL_LINE_NO_KEY, REJECT_PICK_A_REASON } from './confirmation/ActionDialogs';

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
  // (أ) CHANGED 30/10 (the owner: «٥ تمام») — was: «ألغِ» is shut with no attempt. Now «ألغِ» opens its dialog, which
  // shuts only the reasons that need a word with the customer (see the describe below); «تأكيد» and «تأجيل» stay shut,
  // and the line under the card still says what unlocks them.
  it('(أ) an order nobody has tried to reach: «تأكيد» and «تأجيل» are shut and a line says what unlocks them — no hover needed; «ألغِ» is open', async () => {
    await draw(0);
    expect((screen.getByRole('button', { name: /^ألغِ$/ }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: /تأكيد الطلب/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /^تأجيل/ }) as HTMLButtonElement).disabled).toBe(true);
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

describe('«ألغِ» with no attempt: the dialog opens and shuts only the reasons that need a call (30/10)', () => {
  const NEEDS_CALL = ['PRICE_TOO_HIGH', 'CUSTOMER_CHANGED_MIND', 'CUSTOMER_DOES_NOT_WANT_PRODUCT', 'FOUND_CHEAPER_ELSEWHERE', 'FAKE_ORDER', 'OTHER'];
  const NO_CALL = ['DUPLICATE_ORDER', 'WRONG_NUMBER', 'OUT_OF_SERVICE_AREA'];
  const openDialog = () => fireEvent.click(screen.getByRole('button', { name: /^ألغِ$/ }));
  const option = (value: string) => {
    const el = Array.from(document.querySelectorAll('option')).find((o) => o.value === value);
    if (!el) throw new Error(`no option ${value}`);
    return el as HTMLOptionElement;
  };

  it('(ح) pressing it opens the dialog — the button is not shut', async () => {
    await draw(0);
    openDialog();
    expect(await screen.findByRole('button', { name: 'ألغِ الطلب' })).toBeTruthy();
  });

  it('(ط) the reasons that need a call are grey, the three that do not are open', async () => {
    await draw(0);
    openDialog();
    await screen.findByRole('button', { name: 'ألغِ الطلب' });
    for (const v of NEEDS_CALL) expect(option(v).disabled, v).toBe(true);
    for (const v of NO_CALL) expect(option(v).disabled, v).toBe(false);
    // and the system's own reasons are not offered at all
    expect(document.querySelector('option[value="MODERATOR_DATA_ERROR"]')).toBeNull();
  });

  it('(ي) the reason for the grey is a visible line, in Arabic, with no English in it', async () => {
    await draw(0);
    openDialog();
    const line = (await screen.findByText(REJECT_NEEDS_CALL_LINE)).textContent ?? '';
    expect(line).toBe('يحتاج اتصالاً بالزبون أولاً — سجّل محاولة أو اختر سبباً لا يحتاج اتصالاً');
    expect(line).not.toMatch(/[A-Za-z]/);
  });

  it('(ك) no reason is picked for her: the select starts on «اختر السبب» and «ألغِ الطلب» is shut until she chooses', async () => {
    await draw(0);
    openDialog();
    const send = (await screen.findByRole('button', { name: 'ألغِ الطلب' })) as HTMLButtonElement;
    const select = document.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.options[select.selectedIndex].textContent).toBe(REJECT_PICK_A_REASON);
    expect(send.disabled).toBe(true);
    // a press on the shut button sends nothing
    fireEvent.click(send);
    expect(apiJson.mock.calls.filter((c) => String(c[0]).includes('/confirmation') && !String(c[0]).includes('mine'))).toEqual([]);
    fireEvent.change(select, { target: { value: 'DUPLICATE_ORDER' } });
    expect(send.disabled).toBe(false);
  });

  it('(ل) the select is a finger-sized control (44 points on a phone)', async () => {
    await draw(0);
    openDialog();
    await screen.findByRole('button', { name: 'ألغِ الطلب' });
    expect((document.querySelector('select') as HTMLSelectElement).className).toMatch(/\bh-11\b/);
  });

  it('(م) choosing an open reason and pressing «ألغِ الطلب» sends the reject, with no attempt recorded first', async () => {
    await draw(0);
    apiJson.mockImplementation(async (url: string) => (url.startsWith('/api/confirmation/mine') ? desk(0) : { success: true }));
    openDialog();
    const send = await screen.findByRole('button', { name: 'ألغِ الطلب' });
    fireEvent.change(document.querySelector('select') as HTMLSelectElement, { target: { value: 'WRONG_NUMBER' } });
    fireEvent.click(send);
    await waitFor(() => {
      const posts = apiJson.mock.calls.filter((c) => !String(c[0]).startsWith('/api/confirmation/mine'));
      expect(posts.map((c) => String(c[0]))).toEqual(['/api/orders/W1/confirmation']);
      expect(JSON.parse((posts[0][1] as { body: string }).body)).toMatchObject({ action: 'reject', rejectionReason: 'WRONG_NUMBER' });
    });
  });

  it('(ع) without the key that records a call, the line points at a colleague and not at a button she does not have', async () => {
    await draw(0, ['confirmation.work']);
    openDialog();
    const line = (await screen.findByText(REJECT_NEEDS_CALL_LINE_NO_KEY)).textContent ?? '';
    expect(line).toMatch(/زميل مخوَّل/);
    expect(line).not.toMatch(/[A-Za-z]/);
    expect(screen.queryByText(REJECT_NEEDS_CALL_LINE)).toBeNull();
  });

  it('(ن) NEGATIVE: with an attempt on the order every reason is open, no line is drawn, and it starts on the old default', async () => {
    await draw(1);
    openDialog();
    await screen.findByRole('button', { name: 'ألغِ الطلب' });
    for (const v of [...NEEDS_CALL, ...NO_CALL]) expect(option(v).disabled, v).toBe(false);
    expect(screen.queryByText(REJECT_NEEDS_CALL_LINE)).toBeNull();
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('CUSTOMER_CHANGED_MIND');
    expect((screen.getByRole('button', { name: 'ألغِ الطلب' }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector('option[value=""]')).toBeNull();
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
