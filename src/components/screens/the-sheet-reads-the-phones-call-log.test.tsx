// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «مساعد الاتصال» ON THE «شو صار؟» SHEET.
 *
 * With her phone paired, the row carries `callHelperLink` and «اتصال» opens it — the same anchor, the same OPENED line.
 * Back on the page, the sheet asks what the phone's call log said about THIS call: found, it shows one line («رد — 2:13»,
 * «ما رد — رنّ 25 ث») and puts the matching answer first, over the time-away order. Nothing is recorded from it: she
 * still taps. No reading → the sheet is exactly today's. No link → the reading door is never asked.
 *
 * The real `ContactButtons` and the real `CallOutcomeSheet` are drawn, on the harness of the-call-sheet-waits-on-a-phone.
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

const LINK = 'intent://call?order=o-1&phone=963952554562&exp=1800043200&sig=' + 'ab'.repeat(32) + '#Intent;scheme=zakicall;package=io.zakiai.callhelper;S.browser_fallback_url=tel%3A%2B963952554562;end';
const ROW = {
  id: 'o-1',
  callHelperLink: LINK as string | undefined,
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
/** What the phone's call log said, as the reading door answers it — null: nothing yet. */
let reading: { startedAt: number; answered: boolean; talkSeconds: number; ringSeconds: number } | null = null;
let withLink = true;
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
  reading = null;
  withLink = true;
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
        work: [withLink ? ROW : { ...ROW, callHelperLink: undefined }],
        noAnswer: [],
        closedToday: [],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 5, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };
    }
    if (url === '/api/settings/messages') return { templates: [] };
    if (url === '/api/call-helper/device') return { paired: true, deviceName: 'Samsung SM-A515F', pairedAt: new Date(clock.now).toISOString() };
    if (url.startsWith('/api/call-helper/reading')) {
      sent.push({ url, method, body });
      return { reading };
    }
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


const readingAsks = () => sent.filter((s) => s.url.startsWith('/api/call-helper/reading'));

describe('«اتصال» with a paired phone', () => {
  it('opens the signed link in place of tel:, and the press still writes the same OPENED line', async () => {
    await draw();
    const call = screen.getByTitle('اتصال');
    expect(call.getAttribute('href')).toBe(LINK);
    ring();
    expect(sheet()).toBeTruthy();
    await waitFor(() => expect(posts('OPENED')).toHaveLength(1));
  });

  it('without a link it is today’s tel:, and the reading door is never asked', async () => {
    withLink = false;
    await draw();
    expect(screen.getByTitle('اتصال').getAttribute('href')).toBe('tel:0952554562');
    ring();
    comeBack(8_000);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(readingAsks()).toHaveLength(0);
    expect(words()[0]).toBe('ما رد');
  });
});

describe('back from the call, the sheet reads the phone’s call log', () => {
  it('answered: «رد» first and the line «رد — 2:13», over the time-away order', async () => {
    await draw();
    ring();
    reading = { startedAt: clock.now + 400, answered: true, talkSeconds: 133, ringSeconds: 5 };
    // Eight seconds away would put «ما رد» first by the clock alone.
    comeBack(8_000);
    expect(await within(sheet()).findByText('رد — 2:13')).toBeTruthy();
    expect(words()[0]).toBe('رد');
    expect(readingAsks()[0].url).toBe('/api/call-helper/reading?orderId=o-1');
    // Nothing was recorded from it: the only line in the log is the press.
    expect(sent.filter((s) => s.url.endsWith('/contact-attempts') && s.method === 'POST').map((s) => (s.body as { result: string }).result)).toEqual(['OPENED']);
  });

  it('not answered: «ما رد» first and the line «ما رد — رنّ 25 ث», even after a long time away', async () => {
    await draw();
    ring();
    reading = { startedAt: clock.now + 400, answered: false, talkSeconds: 0, ringSeconds: 25 };
    // A minute away would put «رد» first by the clock alone.
    comeBack(60_000);
    expect(await within(sheet()).findByText('ما رد — رنّ 25 ث')).toBeTruthy();
    expect(words()[0]).toBe('ما رد');
  });

  it('a reading of an earlier call to the same customer is not this call’s', async () => {
    await draw();
    ring();
    reading = { startedAt: clock.now - 10 * 60_000, answered: true, talkSeconds: 90, ringSeconds: 4 };
    comeBack(8_000);
    await waitFor(() => expect(readingAsks().length).toBeGreaterThan(0));
    expect(within(sheet()).queryByText(/سجل التلفون/)).toBeNull();
    expect(words()[0]).toBe('ما رد');
  });

  it('no reading: the sheet is exactly today’s', async () => {
    await draw();
    ring();
    comeBack(8_000);
    await waitFor(() => expect(readingAsks().length).toBeGreaterThan(0));
    expect(within(sheet()).queryByText(/سجل التلفون/)).toBeNull();
    expect(words()).toEqual(['ما رد', 'مشغول', 'مسكّر', 'رد', 'رقم غلط', 'اتصل لاحقاً', 'ما اتصلت']);
  });
});
