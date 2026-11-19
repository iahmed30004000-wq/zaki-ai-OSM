// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «إثبات المكالمات» ON THE DESK CARD AND THE PHONE FOOTER (Confirmation Center v2, step A).
 *
 * With the company switch ON the server says, per held card, what her «لا يرد» / «مغلق أو خارج التغطية» wait for
 * (`callProof`: NO_OPENED · WAIT until a server-clock instant · READY). The card only SHOWS it: a real disabled button AND the
 * reason in visible words (a phone has no tooltip), the seconds ticked against the server's clock. A «اتصال» press makes no
 * reload, so it starts the wait itself; the next reload brings the server's number. The three refusals of the doors are kept
 * or said as the contract says. With the switch OFF nothing of this exists: today's DOM, today's bodies.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, phone, clock } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: false },
  clock: { now: 1_800_000_000_000 },
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
import { CALL_PROOF_WORDS, CLIENT_MARGIN_MS, MIN_CALL_MS } from '@/lib/call-proof-words';
import { CONTACT_FIRST_MESSAGE } from '@/lib/confirmation-queue';
import { CONTACT_LINES_KEY } from '@/lib/contact-line';

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

/** What the next desk answers carry: the switch and the card's proof. */
let desk: { callProofOn?: boolean; proofSeconds?: number; row?: Record<string, unknown> } = {};
let sent: { url: string; method: string; body: unknown; raw?: string }[] = [];
let mineReads = 0;
/** The next POST to the contact log is refused with this (for the result named). */
let refuse: { result: string; error: Error; times: number } | null = null;
/** The press's own line cannot leave (no connection): it is kept in this tab, waiting. */
let dropOpened = false;

const refusal = (code: string, errorAr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(errorAr), { status: 409, data: { error: 'refused', errorAr, code, ...extra } });

const posts = (result: string) =>
  sent.filter((s) => s.url.endsWith('/contact-attempts') && s.method === 'POST' && (s.body as { result?: string })?.result === result);
const logReads = () => apiJson.mock.calls.filter(([u, i]) => String(u).endsWith('/contact-attempts') && !(i as { method?: string } | undefined)?.method).length;

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  clock.now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => true });
  desk = {};
  sent = [];
  mineReads = 0;
  refuse = null;
  dropOpened = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (url.startsWith('/api/confirmation/mine')) {
      mineReads += 1;
      return {
        leadDays: 2,
        waitingLater: 0,
        noAnswerLimit: 3,
        dialCode: '963',
        serverNow: new Date(clock.now).toISOString(),
        work: [{ ...ROW, ...desk.row }],
        noAnswer: [],
        closedToday: [],
        confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
        ...(desk.callProofOn ? { callProofOn: true } : {}),
        ...(desk.proofSeconds ? { proofSeconds: desk.proofSeconds } : {}),
      };
    }
    if (url === '/api/confirmation/queue') {
      return { waiting: 5, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };
    }
    if (url === '/api/settings/messages') return { templates: [] };
    if (url.endsWith('/contact-attempts') && method === 'GET') return { attempts: [] };
    sent.push({ url, method, body, raw: init?.body });
    if (url.endsWith('/contact-attempts') && method === 'POST') {
      if (dropOpened && body?.result === 'OPENED') throw new TypeError('Failed to fetch');
      if (refuse && refuse.times > 0 && body?.result === refuse.result) {
        refuse.times -= 1;
        throw refuse.error;
      }
      return { autoClosed: false, noAnswerCount: 1 };
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
const noAnswer = () => screen.getByRole('button', { name: /^لا يرد/ }) as HTMLButtonElement;
const unreachable = () => screen.getByRole('button', { name: 'مغلق أو خارج التغطية' }) as HTMLButtonElement;
/** Let the one-second ticker (real timers) fire once, with the mocked clock moved on by `ms`. */
const tick = async (ms: number) => {
  clock.now += ms;
  await act(async () => {
    await new Promise((r) => setTimeout(r, 1_200));
  });
};
const WAIT_MS = MIN_CALL_MS.NO_ANSWER + CLIENT_MARGIN_MS;

describe('WITH THE SWITCH OFF: the desk is as it was', () => {
  it('no new text, no locked button, and the press sends the line it always sent', async () => {
    desk = { row: { callProof: { state: 'NO_OPENED', unlocksAtMs: null } } }; // a stray key without the switch is never read
    await draw();
    expect(noAnswer().disabled).toBe(false);
    expect(unreachable().disabled).toBe(false);
    expect(noAnswer().getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
    ring();
    await waitFor(() => expect(posts('OPENED')).toHaveLength(1));
    expect(posts('OPENED')[0].raw).toBe('{"contactMethod":"PHONE","result":"OPENED"}');
    await act(async () => {});
    // no wait begins, no ticker draws anything
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(/استنّى/)).toBeNull();
    expect(mineReads).toBe(1);
  });

  it('a card nobody has rung still says «أو اكبس لا يرد» — the old sentence, in the hint and on the locked buttons', async () => {
    desk = { row: { _count: { contactAttempts: 0, notes: 0 } } };
    await draw();
    expect(screen.getByText(/سجّل المحاولة بـ«لا يرد» أو «مغلق أو خارج التغطية» إذا ما ردّ/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'تأكيد الطلب' }) as HTMLButtonElement).title).toBe(CONTACT_FIRST_MESSAGE);
    expect(screen.queryByText(CALL_PROOF_WORDS.contactFirstV2)).toBeNull();
  });

  it('a refusal code that only the proof sends is still said with the server’s own words', async () => {
    refuse = { result: 'NO_ANSWER', times: 1, error: refusal('CALL_NOT_STARTED', 'ما في اتصال مسجّل على هالطلب. اضغط «اتصال» أول، وبعد ما تكلّم الزبون سجّل النتيجة.') };
    await draw();
    fireEvent.click(noAnswer());
    expect(await screen.findByText(CALL_PROOF_WORDS.refusedNotStarted)).toBeTruthy();
  });
});

describe('WITH THE SWITCH ON: «لا يرد» and «مغلق أو خارج التغطية» say why they are shut', () => {
  it('NO_OPENED: both are disabled AND the reason is written on the card; the other buttons stay free', async () => {
    desk = { callProofOn: true, row: { callProof: { state: 'NO_OPENED', unlocksAtMs: null } } };
    await draw();
    for (const b of [noAnswer(), unreachable()]) {
      expect(b.disabled).toBe(true);
      expect(b.getAttribute('aria-disabled')).toBe('true');
      expect(b.title).toBe(CALL_PROOF_WORDS.noOpened);
    }
    // visible text, not only the tooltip
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened).tagName).toBe('P');
    for (const name of ['تأكيد الطلب', 'ألغِ', 'افتح وعدّل']) {
      expect((screen.getByRole('button', { name: new RegExp(`^${name}`) }) as HTMLButtonElement).disabled, name).toBe(false);
    }
    // nothing was sent by looking at it
    expect(sent).toEqual([]);
  });

  it('WAIT: counts down against the SERVER clock and opens by itself, with no reload', async () => {
    desk = { callProofOn: true, row: { callProof: { state: 'WAIT', unlocksAtMs: 1_800_000_000_000 + 10_000 } } };
    await draw();
    expect(noAnswer().disabled).toBe(true);
    expect(unreachable().disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(10))).toBeTruthy();
    await tick(4_000);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(6))).toBeTruthy();
    expect(noAnswer().disabled).toBe(true);
    await tick(7_000);
    expect(screen.queryByText(/استنّى/)).toBeNull();
    expect(noAnswer().disabled).toBe(false);
    expect(unreachable().disabled).toBe(false);
    expect(mineReads).toBe(1);
  });

  it('a phone clock that is minutes wrong changes nothing: the seconds come from the server’s instant', async () => {
    // the server says now is 10 s before the unlock; the phone’s own clock is an hour fast
    const serverNow = 1_800_000_000_000;
    clock.now = serverNow + 3_600_000;
    apiJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/confirmation/mine')) {
        return {
          leadDays: 2, waitingLater: 0, noAnswerLimit: 3, serverNow: new Date(serverNow).toISOString(), callProofOn: true,
          work: [{ ...ROW, callProof: { state: 'WAIT', unlocksAtMs: serverNow + 10_000 } }], noAnswer: [], closedToday: [],
          confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
        };
      }
      if (url === '/api/confirmation/queue') return { waiting: 0, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: false, refusal: null, autoReleased: 0, orders: null };
      return { templates: [] };
    });
    await draw();
    expect(screen.getByText(CALL_PROOF_WORDS.wait(10))).toBeTruthy();
  });

  it('READY: enabled, no text, and the press sends the body it always sent', async () => {
    desk = { callProofOn: true, row: { callProof: { state: 'READY', unlocksAtMs: null } } };
    await draw();
    expect(noAnswer().disabled).toBe(false);
    expect(unreachable().disabled).toBe(false);
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
    expect(screen.queryByText(/استنّى/)).toBeNull();
    fireEvent.click(noAnswer());
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    expect(posts('NO_ANSWER')[0].raw).toBe('{"contactMethod":"PHONE","result":"NO_ANSWER"}');
    fireEvent.click(unreachable());
    await waitFor(() => expect(posts('UNREACHABLE')).toHaveLength(1));
    expect(posts('UNREACHABLE')[0].raw).toBe('{"contactMethod":"PHONE","result":"UNREACHABLE"}');
  });

  it('the «اتصال» press starts the wait at once, without a reload — and the next reload brings the server’s number', async () => {
    desk = { callProofOn: true, row: { callProof: { state: 'NO_OPENED', unlocksAtMs: null } } };
    await draw();
    expect(screen.getByText(CALL_PROOF_WORDS.noOpened)).toBeTruthy();
    ring();
    await waitFor(() => expect(posts('OPENED')).toHaveLength(1));
    expect(screen.queryByText(CALL_PROOF_WORDS.noOpened)).toBeNull();
    expect(screen.getByText(CALL_PROOF_WORDS.wait(WAIT_MS / 1000))).toBeTruthy();
    expect(noAnswer().disabled).toBe(true);
    expect(unreachable().disabled).toBe(true);
    expect(mineReads, 'a press reloads nothing').toBe(1);

    await tick(WAIT_MS - 6_000);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(6))).toBeTruthy();
    await tick(7_000);
    expect(noAnswer().disabled).toBe(false);
    expect(screen.queryByText(/استنّى/)).toBeNull();

    // a second press is a new dial: the thirty seconds start again; and a reload hands the card back to the server
    ring();
    await waitFor(() => expect(posts('OPENED')).toHaveLength(2));
    expect(noAnswer().disabled).toBe(true);
    desk = { callProofOn: true, row: { callProof: { state: 'READY', unlocksAtMs: null } } };
    // any answer of the desk is followed by a reload — here the card’s own «تأكيد الطلب»
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الطلب' }));
    await waitFor(() => expect(mineReads).toBe(2));
    await waitFor(() => expect(noAnswer().disabled).toBe(false));
  });

  // Request Q3b (19/11): the seconds are the rule in force's, and they reach the desk from the server's answer — the desk imports no rule.
  it('an edited rule: the server says 45 seconds, and the press waits 45 + the clocks\' margin — not the default thirty', async () => {
    desk = { callProofOn: true, proofSeconds: 45, row: { callProof: { state: 'NO_OPENED', unlocksAtMs: null } } };
    await draw();
    ring();
    await waitFor(() => expect(posts('OPENED')).toHaveLength(1));
    expect(screen.getByText(CALL_PROOF_WORDS.wait(45 + CLIENT_MARGIN_MS / 1000))).toBeTruthy();
    await tick(WAIT_MS + 1_000);
    expect(noAnswer().disabled, 'still shut after the default thirty').toBe(true);
    await tick(15_000);
    expect(noAnswer().disabled).toBe(false);
  });

  it('«CALL_TOO_SOON» on the card’s own press: the red line says it and the card waits again for exactly what the server said', async () => {
    desk = { callProofOn: true, row: { callProof: { state: 'READY', unlocksAtMs: null } } };
    refuse = { result: 'NO_ANSWER', times: 1, error: refusal('CALL_TOO_SOON', CALL_PROOF_WORDS.refusedTooSoon(12), { waitSeconds: 12, unlocksAt: new Date(clock.now + 12_000).toISOString() }) };
    await draw();
    fireEvent.click(noAnswer());
    expect(await screen.findByText(CALL_PROOF_WORDS.refusedTooSoon(12))).toBeTruthy();
    await waitFor(() => expect(noAnswer().disabled).toBe(true));
    expect(unreachable().disabled).toBe(true);
    expect(screen.getByText(CALL_PROOF_WORDS.wait(12))).toBeTruthy();
    await tick(13_000);
    expect(noAnswer().disabled).toBe(false);
    expect(posts('NO_ANSWER'), 'one try, nothing written').toHaveLength(1);
  });

  it('an order nobody has rung says the NEW sentence — «اضغط اتصال» — and never «أو اكبس لا يرد»', async () => {
    desk = { callProofOn: true, row: { _count: { contactAttempts: 0, notes: 0 }, callProof: { state: 'NO_OPENED', unlocksAtMs: null } } };
    await draw();
    expect(screen.getByText(CALL_PROOF_WORDS.contactFirstV2)).toBeTruthy();
    expect(screen.queryByText(/سجّل المحاولة بـ«لا يرد»/)).toBeNull();
    expect(document.body.textContent).not.toContain('أو اكبس');
    for (const name of ['تأكيد الطلب', /^تأجيل/, /^افتح وعدّل/]) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).title).toBe(CALL_PROOF_WORDS.contactFirstV2);
    }
  });

  it('a colleague’s desk (no proof from the server) is never locked by it', async () => {
    desk = { callProofOn: false, row: {} };
    await draw();
    expect(noAnswer().disabled).toBe(false);
  });
});

describe('THE PHONE: the same card footer, and the outbox keeps what the doors refuse', () => {
  beforeEach(() => {
    phone.value = true;
  });

  it('the footer says the reason in words under the two call results', async () => {
    desk = { callProofOn: true, row: { callProof: { state: 'NO_OPENED', unlocksAtMs: null } } };
    await draw();
    expect(noAnswer().disabled).toBe(true);
    expect(unreachable().disabled).toBe(true);
    const hint = screen.getByText(CALL_PROOF_WORDS.noOpened);
    expect(hint.tagName).toBe('P');
    expect(hint.closest('footer')).toBeTruthy();
  });

  it('the source: the sheet is told whether the proof is on, and refusals are kept or said as the contract says', () => {
    const src = readFileSync(join(__dirname, 'ConfirmationMineScreen.tsx'), 'utf8');
    expect(src).toContain('proofOn={proofOn}');
    expect(src).toContain("code === 'CALL_TOO_SOON'");
    expect(src).toContain('openedWaiting(item.orderId)');
    // bundle: the new logic imports only the two tiny modules
    expect(src).toContain("from '@/lib/call-proof-words'");
    expect(src).not.toMatch(/from '@\/lib\/call-proof'/);
    expect(src).not.toMatch(/from '@\/lib\/call-proof-(switch|guard)'/);
  });
});

/** The sheet's outcomes travel in the outbox; «ما رد» is tapped after the half minute, so this is about the refusals only. */
describe('THE OUTBOX: «too soon» and «no press yet» are retried; the rest are final', () => {
  beforeEach(() => {
    phone.value = true;
    desk = { callProofOn: true, row: { callProof: { state: 'READY', unlocksAtMs: null } } };
  });
  const tapNoAnswer = async () => {
    ring();
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'شو صار؟' })).toBeTruthy());
    // back from the call long enough for any lock on the sheet to be open
    clock.now += 40_000;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_200));
    });
    fireEvent.click(within(screen.getByRole('dialog', { name: 'شو صار؟' })).getByRole('button', { name: 'ما رد' }));
  };
  /** Past the five seconds' undo, and one tick of the sender's second. */
  const letItGo = async (ms = 6_000) => {
    clock.now += ms;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1_200));
    });
  };

  it('CALL_TOO_SOON: the answer stays queued, is sent again after fifteen seconds WITHOUT asking the log, and lands', async () => {
    refuse = { result: 'NO_ANSWER', times: 1, error: refusal('CALL_TOO_SOON', CALL_PROOF_WORDS.refusedTooSoon(4), { waitSeconds: 4 }) };
    await draw();
    await tapNoAnswer();
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    const reads = logReads();
    await letItGo(16_000);
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(2));
    expect(logReads(), 'nothing was written, so the log is not asked').toBe(reads);
    expect(posts('NO_ANSWER')[1].raw).toBe('{"contactMethod":"PHONE","result":"NO_ANSWER"}');
  });

  it('CALL_NOT_STARTED while the press is still queued: the press is sent now and the answer is tried again, not dropped', async () => {
    dropOpened = true;
    refuse = { result: 'NO_ANSWER', times: 1, error: refusal('CALL_NOT_STARTED', CALL_PROOF_WORDS.refusedNotStarted) };
    await draw();
    await tapNoAnswer();
    expect(window.sessionStorage.getItem(CONTACT_LINES_KEY), 'the press is kept, waiting').toContain('OPENED');
    dropOpened = false;
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    // the refusal forced the press out …
    await waitFor(() => expect(posts('OPENED').length).toBeGreaterThanOrEqual(2));
    expect(window.sessionStorage.getItem(CONTACT_LINES_KEY)).toBeNull();
    // … and the answer is still queued: it goes again
    await letItGo(16_000);
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(2));
    expect(screen.queryAllByText(CALL_PROOF_WORDS.refusedNotStarted)).toEqual([]);
  });

  it('CALL_NOT_STARTED with no press waiting is final: the server’s words are shown and nothing is sent again', async () => {
    refuse = { result: 'NO_ANSWER', times: 5, error: refusal('CALL_NOT_STARTED', CALL_PROOF_WORDS.refusedNotStarted) };
    await draw();
    await tapNoAnswer();
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    expect((await screen.findAllByText(CALL_PROOF_WORDS.refusedNotStarted)).length).toBeGreaterThan(0);
    await letItGo(20_000);
    expect(posts('NO_ANSWER')).toHaveLength(1);
  });

  it('CALL_NOT_LOGGED is final too, in the server’s words', async () => {
    refuse = { result: 'NO_ANSWER', times: 5, error: refusal('CALL_NOT_LOGGED', CALL_PROOF_WORDS.notLogged) };
    await draw();
    await tapNoAnswer();
    await letItGo();
    await waitFor(() => expect(posts('NO_ANSWER')).toHaveLength(1));
    expect((await screen.findAllByText(CALL_PROOF_WORDS.notLogged)).length).toBeGreaterThan(0);
    await letItGo(20_000);
    expect(posts('NO_ANSWER')).toHaveLength(1);
  });
});
