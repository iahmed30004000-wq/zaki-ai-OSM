// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شو صار؟» — THE CALL SHEET OF «طلباتي» ON A PHONE.
 *
 * The owner's plan for the confirmation agents, who work from their phones: «اسحب التالي» → «اتصل» → back → one tap →
 * «التالي». The sheet opens on the press of «اتصل», is still there after the dialler (and after a reload), offers the
 * likeliest answer first by how long she was away, and sends each answer through the door the card's own button uses,
 * with the card's own body, five seconds later — a delay «تراجع» cancels, and a lost connection survives.
 *
 * The real `ContactButtons` is drawn: the press of its «اتصال» is what opens the sheet.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, phone, clock, pulls } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: true },
  clock: { now: 1_800_000_000_000 },
  pulls: { count: 0 },
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
      permissions: ['confirmation.work', 'confirmation.pull', 'orders.contact_log'],
      status: 'ACTIVE',
    },
  }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
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
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({
  ChangeRequestDialog: () => null,
  IssueDialog: () => null,
  PostponeDialog: () => <div role="dialog" aria-label="تأجيل الطلب" />,
  RejectDialog: () => <div role="dialog" aria-label="رفض الطلب" />,
}));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <div /> }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';
import { OUTBOX_KEY, PENDING_KEY } from '@/lib/call-outcome';

const ROW = {
  id: 'o-1',
  orderNumber: 'SY-26-1001',
  merchantRef: null,
  confirmationStatus: 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 4,
  totalAmount: 45,
  currency: 'SYP',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'LANDING_PAGE',
  regionId: 'r1',
  region: { name: 'دمشق' },
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  customer: { id: 'c1', fullName: 'نور', phone: '0952554562', rawPhone: '0952554562', city: 'دمشق', address: 'شارع' },
  items: [],
  _count: { contactAttempts: 1, notes: 0 },
  risk: null,
};

let online = true;
/** What the doors were sent: [url, method, body]. */
let sent: { url: string; method: string; body: unknown; raw?: string }[] = [];
/** The next POST to the contact log fails as a dropped line does (no status). */
let dropNextAttempt = false;
/** A slow line: the POST for this result stays open until `held.release()`. */
let held: { result: string; release?: () => void } | null = null;
/** What the log answers a GET with — for the resend that asks first. */
let logged: { result: string; employeeId: string; createdAt: string }[] = [];

const posts = (result: string) =>
  sent.filter((s) => s.url.endsWith('/contact-attempts') && s.method === 'POST' && (s.body as { result?: string })?.result === result);

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  online = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  sent = [];
  dropNextAttempt = false;
  logged = [];
  held = null;
  pulls.count = 0;
  window.localStorage.clear();
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (url.startsWith('/api/confirmation/mine')) {
      return {
        leadDays: 2,
        waitingLater: 0,
        noAnswerLimit: 3,
        dialCode: '963',
        serverNow: new Date(clock.now).toISOString(),
        work: [ROW],
        noAnswer: [],
        closedToday: [],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 5, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };
    }
    if (url === '/api/settings/messages') return { templates: [] };
    if (url.endsWith('/contact-attempts') && method === 'GET') return { attempts: logged };
    sent.push({ url, method, body, raw: init?.body });
    if (url.endsWith('/contact-attempts') && method === 'POST' && dropNextAttempt && body?.result !== 'OPENED') {
      dropNextAttempt = false;
      throw new TypeError('Failed to fetch');
    }
    if (url.endsWith('/contact-attempts') && method === 'POST' && held && body?.result === held.result) {
      const h = held;
      await new Promise<void>((r) => (h.release = r));
    }
    if (url.endsWith('/contact-attempts')) return { autoClosed: false, noAnswerCount: 1 };
    if (url === '/api/confirmation/pull') {
      pulls.count += 1;
      return { ok: true };
    }
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const draw = async () => {
  render(<ConfirmationMineScreen />);
  await screen.findByText('SY-26-1001');
};
const ring = () => fireEvent.click(screen.getByTitle('اتصال'));
const sheet = () => screen.getByRole('dialog', { name: 'شو صار؟' });
const sheetButtons = () => within(sheet()).getAllByRole('button').filter((b) => b.getAttribute('aria-label') !== 'سكّر');
const words = () => sheetButtons().map((b) => b.textContent!.trim());
const comeBack = (afterMs: number) => {
  clock.now += afterMs;
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
};
/** Past the five seconds, and one tick of the sender's second. */
const letItGo = async () => {
  clock.now += 6_000;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1_200));
  });
};

describe('«اتصل» opens «شو صار؟» at once', () => {
  it('the sheet is there on the press — before the browser says anything — with every answer, thumb-high', async () => {
    await draw();
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
    ring();
    expect(sheet()).toBeTruthy();
    expect(words()).toEqual(['رد', 'ما رد', 'مشغول', 'مسكّر', 'رقم غلط', 'اتصل لاحقاً', 'ما اتصلت']);
    for (const b of within(sheet()).getAllByRole('button')) expect(b.style.minHeight, b.textContent!).toBe('48px');
    // the dialler's own press is still logged by the strip, as on every screen — `OPENED`, not an outcome
    await waitFor(() => expect(posts('OPENED')).toHaveLength(1));
  });

  it('A DESK: the same press opens nothing — the desk is as it was', async () => {
    phone.value = false;
    await draw();
    ring();
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });
});

describe('back from the dialler: the time away orders the answers', () => {
  it('under 6 seconds: «ما اتصلت» first', async () => {
    await draw();
    ring();
    comeBack(3_000);
    expect(words()[0]).toBe('ما اتصلت');
    expect(within(sheet()).getByText(/غبتِ/).textContent).toContain('0:03');
  });

  it('6 to 45 seconds: «ما رد · مشغول · مسكّر» first', async () => {
    await draw();
    ring();
    comeBack(20_000);
    expect(words().slice(0, 3)).toEqual(['ما رد', 'مشغول', 'مسكّر']);
    expect(within(sheet()).getByText(/غبتِ/).textContent).toContain('0:20');
  });

  it('over 45 seconds: «رد» first', async () => {
    await draw();
    ring();
    comeBack(62_000);
    expect(words()[0]).toBe('رد');
    expect(within(sheet()).getByText(/غبتِ/).textContent).toContain('1:02');
  });

  it('the first word from the browser wins: a later focus does not move the clock', async () => {
    await draw();
    ring();
    comeBack(20_000);
    clock.now += 60_000;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(within(sheet()).getByText(/غبتِ/).textContent).toContain('0:20');
  });
});

describe('a reload on a cheap phone finds the sheet waiting', () => {
  it('the open call is kept, and a reload is a return', async () => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: 'o-1', startedAt: clock.now - 20_000, userId: 'u1' }));
    await draw();
    expect(await screen.findByRole('dialog', { name: 'شو صار؟' })).toBeTruthy();
    expect(words().slice(0, 3)).toEqual(['ما رد', 'مشغول', 'مسكّر']);
  });

  it('but not another person’s call, nor an order no longer on her desk', async () => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: 'o-1', startedAt: clock.now - 20_000, userId: 'u2' }));
    await draw();
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
    cleanup();
    window.localStorage.setItem(PENDING_KEY, JSON.stringify({ orderId: 'o-gone', startedAt: clock.now - 20_000, userId: 'u1' }));
    await draw();
    await waitFor(() => expect(window.localStorage.getItem(PENDING_KEY)).toBeNull());
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
  });
});

describe('one tap, the door the card uses, the body the card sends', () => {
  it('«ما رد» sends byte for byte what the card’s «لا يرد» sends', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /^لا يرد/ }));
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    const old = posts('NO_ANSWER')[0];
    sent = [];

    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    expect(posts('NO_ANSWER'), 'sent before the five seconds').toHaveLength(0);
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    expect(posts('NO_ANSWER')[0]).toEqual(old);
    expect(posts('NO_ANSWER')[0].raw).toBe('{"contactMethod":"PHONE","result":"NO_ANSWER"}');
  });

  it('«مسكّر» sends byte for byte what the card’s «مغلق أو خارج التغطية» sends', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'مغلق أو خارج التغطية' }));
    await waitFor(() => expect(posts('UNREACHABLE')).toHaveLength(1));
    const old = posts('UNREACHABLE')[0];
    sent = [];

    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'مسكّر' }));
    await letItGo();
    await waitFor(() => expect(posts('UNREACHABLE')).toHaveLength(1));
    expect(posts('UNREACHABLE')[0]).toEqual(old);
    expect(posts('UNREACHABLE')[0].raw).toBe('{"contactMethod":"PHONE","result":"UNREACHABLE"}');
  });

  it('«اتصل لاحقاً» goes through the postponement door, as «تأجيل» does', async () => {
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'اتصل لاحقاً' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: '+1 س' }));
    await letItGo();
    await waitFor(() => expect(sent.filter((s) => s.url === '/api/orders/o-1/confirmation')).toHaveLength(1));
    const [post] = sent.filter((s) => s.url === '/api/orders/o-1/confirmation');
    expect(post.method).toBe('POST');
    expect(post.body).toMatchObject({ action: 'schedule_follow_up', followUpReason: 'CUSTOMER_REQUESTED_CALLBACK', expectedVersion: 4 });
    expect(Object.keys(post.body as object).sort()).toEqual(['action', 'expectedVersion', 'followUpReason', 'nextFollowUpAt', 'preferredTime']);
    // and nothing in the contact log but the dialler's own line
    expect(sent.filter((s) => s.url.endsWith('/contact-attempts') && (s.body as { result: string }).result !== 'OPENED')).toEqual([]);
  });

  it('«رد» writes nothing and opens the card’s own three — the confirmation goes to the card’s own door', async () => {
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'رد' }));
    expect(within(sheet()).getByRole('button', { name: 'تأجيل' })).toBeTruthy();
    expect(within(sheet()).getByRole('button', { name: 'ألغِ' })).toBeTruthy();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'تأكيد الطلب' }));
    await waitFor(() => expect(sent.filter((s) => s.url === '/api/orders/o-1/confirmation')).toHaveLength(1));
    expect(sent.find((s) => s.url === '/api/orders/o-1/confirmation')!.body).toEqual({ action: 'confirm', expectedVersion: 4 });
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
  });
});

describe('«تراجع», «ما اتصلت», and a line that drops', () => {
  it('«تراجع» inside the five seconds: nothing is ever sent', async () => {
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    fireEvent.click(within(sheet()).getByRole('button', { name: 'تراجع' }));
    await letItGo();
    expect(posts('NO_ANSWER')).toHaveLength(0);
    // back to the answers, for the same call
    expect(words()).toContain('ما رد');
  });

  it('«ما اتصلت» closes the sheet and writes nothing new', async () => {
    await draw();
    ring();
    comeBack(2_000);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما اتصلت' }));
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
    await letItGo();
    expect(sent.filter((s) => s.url.endsWith('/contact-attempts') && (s.body as { result: string }).result !== 'OPENED')).toEqual([]);
    expect(sent.filter((s) => s.url.endsWith('/confirmation'))).toEqual([]);
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it('offline: kept in the phone, said on the sheet, and sent ONCE when the connection is back', async () => {
    await draw();
    ring();
    online = false;
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    await letItGo();
    expect(posts('NO_ANSWER')).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem(OUTBOX_KEY)!)).toHaveLength(1);
    expect(within(sheet()).getByText(/ما في إنترنت/)).toBeTruthy();

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 1_200));
    });
    expect(posts('NO_ANSWER')).toHaveLength(1);
    expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });

  it('a send whose answer was lost asks the log first, and writes nothing twice', async () => {
    await draw();
    ring();
    dropNextAttempt = true;
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    // it did reach the server: the log has her line, written after the call started
    logged = [{ result: 'NO_ANSWER', employeeId: 'u1', createdAt: new Date(clock.now - 3_000).toISOString() }];
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await new Promise((r) => setTimeout(r, 1_200));
    });
    expect(posts('NO_ANSWER')).toHaveLength(1);
    expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull();
  });
});

describe('after a call nobody answered: WhatsApp, then «التالي»', () => {
  it('«ابعت واتساب» is the strip’s own WhatsApp button, alone; «التالي» sends what she said, then pulls', async () => {
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'مشغول' }));
    expect(within(sheet()).getByText('ابعت واتساب')).toBeTruthy();
    expect(within(sheet()).getByRole('button', { name: /واتساب/ })).toBeTruthy();
    expect(within(sheet()).queryByTitle('اتصال')).toBeNull();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'التالي' }));
    await waitFor(() => expect(pulls.count).toBe(1));
    // sent without waiting out the five seconds, and before the pull
    expect(posts('BUSY')).toHaveLength(1);
    const order = sent.map((s) => s.url);
    expect(order.indexOf('/api/orders/o-1/contact-attempts', order.indexOf('/api/orders/o-1/contact-attempts') + 1)).toBeLessThan(order.indexOf('/api/confirmation/pull'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull());
  });
});

describe('375 pixels wide', () => {
  it('the sheet is pinned inside the screen and no button is wider than its cell', async () => {
    // jsdom lays nothing out: what is held is what makes a sideways scroll — a fixed width, or a box pinned past an edge.
    window.innerWidth = 375;
    await draw();
    ring();
    const tokens = (sheet().getAttribute('class') ?? '').split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(['fixed', 'inset-x-2', 'bottom-2', 'overflow-y-auto']));
    for (const el of [sheet(), ...sheet().querySelectorAll('*')]) {
      const cls = (el.getAttribute('class') ?? '').split(/\s+/);
      expect(cls.filter((c) => /^(min-)?w-(\d{2,}|\[)/.test(c)), el.outerHTML.slice(0, 80)).toEqual([]);
      expect((el as HTMLElement).style.width, el.outerHTML.slice(0, 80)).toBe('');
    }
    for (const b of sheetButtons()) expect((b.getAttribute('class') ?? '').split(/\s+/)).toContain('w-full');
  });
});

describe('THE BLOCKER: once the send has left, «تراجع» is not offered — one call, one line', () => {
  it('a slow line: «ما رد» is on its way, «تراجع» is gone, and no second answer can follow it', async () => {
    held = { result: 'NO_ANSWER' };
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    expect(within(sheet()).getByRole('button', { name: 'تراجع' })).toBeTruthy();
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    // the POST is still open
    await waitFor(() => expect(within(sheet()).getByText(/عم ينبعت «ما رد»/)).toBeTruthy());
    expect(within(sheet()).queryByRole('button', { name: 'تراجع' })).toBeNull();
    expect(within(sheet()).queryByRole('button', { name: 'مشغول' })).toBeNull();
    await act(async () => {
      held!.release!();
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(within(sheet()).getByText('انبعت.')).toBeTruthy());
    expect(posts('NO_ANSWER')).toHaveLength(1);
    expect(posts('BUSY')).toHaveLength(0);
  });

  it('waiting for the line: «بيستنى الخط», and no «تراجع»', async () => {
    await draw();
    ring();
    dropNextAttempt = true;
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    await letItGo();
    await waitFor(() => expect(within(sheet()).getByText(/«ما رد» بيستنى الخط/)).toBeTruthy());
    expect(within(sheet()).queryByRole('button', { name: 'تراجع' })).toBeNull();
  });

  it('a reload in the middle of the send: no sheet asking the same call again, and the log is asked before any resend', async () => {
    held = { result: 'NO_ANSWER' };
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ما رد' }));
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    // the tab is killed with the POST open — and the server did write it
    cleanup();
    held = null;
    logged = [{ result: 'NO_ANSWER', employeeId: 'u1', createdAt: new Date(clock.now - 2_000).toISOString() }];
    expect(JSON.parse(window.localStorage.getItem(OUTBOX_KEY)!)[0].inFlight).toBe(true);
    await draw();
    // jsdom has no `navigator.locks`: the dead tab's lease runs out (a real tab's lock is let go the moment it dies).
    clock.now += 41_000;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_300));
    });
    await waitFor(() => expect(window.localStorage.getItem(OUTBOX_KEY)).toBeNull());
    expect(posts('NO_ANSWER')).toHaveLength(1);
    expect(screen.queryByRole('dialog', { name: 'شو صار؟' })).toBeNull();
  });
});

describe('«رقم غلط» → «ألغِ»: the line goes before the cancellation is asked', () => {
  it('inside the five seconds: the line is sent first, then the cancel dialog opens', async () => {
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'رقم غلط' }));
    expect(posts('WRONG_NUMBER')).toHaveLength(0);
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ألغِ' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'رفض الطلب' })).toBeTruthy());
    expect(posts('WRONG_NUMBER')).toHaveLength(1);
  });

  it('with no line: the cancel dialog waits, and the sheet says why', async () => {
    await draw();
    ring();
    fireEvent.click(within(sheet()).getByRole('button', { name: 'رقم غلط' }));
    online = false;
    fireEvent.click(within(sheet()).getByRole('button', { name: 'ألغِ' }));
    await waitFor(() => expect(within(sheet()).getByText(/«رقم غلط» لسا ما انبعت/)).toBeTruthy());
    expect(screen.queryByRole('dialog', { name: 'رفض الطلب' })).toBeNull();
    expect(posts('WRONG_NUMBER')).toHaveLength(0);
  });
});
