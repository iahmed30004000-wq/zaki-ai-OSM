// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «أرجِع «لا يرد» للطابور» ON A WATCHED DESK: ONE BUTTON, ASKED BEFORE IT IS SENT.
 *
 * The owner, 8/11: an agent held 479 «لا يرد» orders and the others had nothing to pull. On «شاشة موظفة» (read-only, a banner
 * «عم تشوف شاشة <name> — قراءة بس») a holder of `orders.unlock` gets ONE press under the banner. It is the only thing on that
 * desk that writes:
 *
 *  1. Drawn under the banner, on a colleague’s desk only, for a holder of the key, and only when the server sent the plan
 *     (`returnPile`) — the screen counts nothing. Not on his own desk; not for a watcher without the key; not without a plan.
 *  2. Pressed, it ASKS in the shared dialog first: how many it returns, from whose desk, what happens to them (the owner’s
 *     sentence), and — over 200 — how many remain. Declined, nothing is sent.
 *  3. Accepted, ONE request goes to the door with the agent’s id in the path; the answer’s sentence is the toast (a warning when
 *     nothing moved); the desk and the picker are read again.
 *  4. A refusal is said, in a toast, and the desk stays as it was. The button waits while the request is out.
 *  5. Everything else on the watched desk stays unpressable: before the press, every request the screen made is a read.
 *
 * Blockers: no money, no permission rule on the client (the door decides), no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user, toastApi, askFirst } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  toastApi: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
  askFirst: vi.fn<(options: unknown) => Promise<boolean>>(async () => true),
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useRegions', () => ({
  useRegions: () => ({ regions: [{ id: 'r-dam', name: 'دمشق' }], countryName: 'سوريا', currency: null, loading: false }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>, opts?: { key?: string }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toastApi }));
// Only the yes/no question is replaced: the order patch hook beside it (`useAsk`) still reads the real module.
vi.mock('@/components/ui/Confirm', async (orig) => ({ ...(await orig<typeof import('@/components/ui/Confirm')>()), useConfirm: () => askFirst }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-testid="contact-strip" /> }));
vi.mock('@/components/orders/CopyValue', () => ({ CopyValue: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <i data-testid="postponed-list" /> }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => <i data-testid="pull-panel" />, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const order = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: id,
  merchantRef: null,
  confirmationStatus: 'IN_PROGRESS',
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
  noAnswerCount: 0,
  source: 'MANUAL',
  moderatorId: 'mod-1',
  moderator: { id: 'mod-1', name: 'مودريتور' },
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء',
  regionId: null,
  region: null,
  customerNotes: null,
  customer: { id: 'c1', fullName: 'زبون', phone: '0790000001', rawPhone: '0790000001', city: 'دمشق', address: 'عنوان' },
  items: [{ id: 'l1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: 2, notes: 0 },
  ...over,
});

const desk = (rows: ReturnType<typeof order>[], extra: Record<string, unknown> = {}) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-11-08T08:00:00.000Z',
  // The default tab is «للشغل»; the cards on it are not what this file is about, only that the desk is drawn whole.
  work: rows,
  noAnswer: [],
  closedToday: [],
  confirmed: { day: '2026-11-08', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
  ...extra,
});

const OWNER = { id: 'owner', name: 'أحمد', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' };
/** A manager who watches desks, sees every order and may take any order back. */
const MANAGER = { id: 'manager', name: 'مدير', role: 'MANAGER', status: 'ACTIVE', permissions: ['team.monitor', 'orders.view', 'orders.unlock'] };
/** A watcher WITHOUT the key the return asks — reading is all he may do. */
const WATCHER = { id: 'lead', name: 'مشرف', role: 'MANAGER', status: 'ACTIVE', permissions: ['team.monitor', 'orders.view'] };
const PLAN_479 = { eligible: 479, limit: 200, thisPress: 200, remainingAfter: 279 };
const PLAN_12 = { eligible: 12, limit: 200, thisPress: 12, remainingAfter: 0 };
const PLAN_0 = { eligible: 0, limit: 200, thisPress: 0, remainingAfter: 0 };

const RETURN_URL = '/api/confirmation/desks/sara/return-no-answer';
let pressAnswer: unknown;
let pressFails: Error | null;

/** `plan` is what the desk door sends for her desk (absent = the viewer holds no key for it). */
function serve(plan: typeof PLAN_479 | null) {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === RETURN_URL) {
      if (pressFails) throw pressFails;
      return pressAnswer;
    }
    if (init?.method && init.method !== 'GET') throw new Error(`a write was sent: ${init.method} ${url}`);
    if (url === '/api/confirmation/desks') return { agents: [{ id: 'sara', name: 'سارة', holding: 2 }] };
    if (url.startsWith('/api/confirmation/mine') && url.includes('agent=sara')) {
      return desk([order('SARA-1'), order('SARA-2')], { viewing: { id: 'sara', name: 'سارة', readOnly: true }, ...(plan ? { returnPile: plan } : {}) });
    }
    // His OWN desk, even if a plan somehow rode on it: the screen draws the button on a colleague’s desk (`viewing`) and nowhere else.
    if (url.startsWith('/api/confirmation/mine')) return desk([order('MINE-1')], plan ? { returnPile: plan } : {});
    throw new Error(`unexpected ${url}`);
  });
  apiFetch.mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({}), clone() { return this; } }));
}

const BUTTON = 'أرجِع «لا يرد» للطابور';
const returnButton = () => screen.queryByRole('button', { name: BUTTON });
const pick = (value: string) => fireEvent.change(screen.getByLabelText('شاشة موظفة'), { target: { value } });
const writes = () => apiJson.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
const mineCalls = () => apiJson.mock.calls.filter(([u]) => String(u).startsWith('/api/confirmation/mine')).map(([u]) => String(u));

async function openSara(who: unknown, plan: typeof PLAN_479 | null) {
  user.current = who;
  serve(plan);
  render(<ConfirmationMineScreen />);
  await screen.findByText('MINE-1');
  await screen.findByLabelText('شاشة موظفة');
  pick('sara');
  await screen.findByText('SARA-1');
}

beforeEach(() => {
  vi.clearAllMocks();
  askFirst.mockImplementation(async () => true);
  pressAnswer = { returned: 200, skipped: 0, remaining: 279, limit: 200, agent: { id: 'sara', name: 'سارة' }, message: 'رجع 200 طلب «لا يرد» للطابور — باقي 279 — اضغط تاني' };
  pressFails = null;
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('where the button is drawn', () => {
  it('under the banner «عم تشوف شاشة سارة — قراءة بس», with the count beside it — the banner itself is unchanged', async () => {
    await openSara(OWNER, PLAN_479);
    const banner = screen.getByRole('status');
    expect(banner.textContent).toBe('عم تشوف شاشة سارة — قراءة بس');
    const button = screen.getByRole('button', { name: BUTTON });
    expect(button).toBeTruthy();
    // after the banner in the page
    expect(banner.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('479 طلب «لا يرد» يرجعوا — 200 بكل ضغطة')).toBeTruthy();
    expect(button.hasAttribute('disabled')).toBe(false);
  });

  it('a pile of up to 200 says one number', async () => {
    await openSara(OWNER, PLAN_12);
    expect(screen.getByText('12 طلب «لا يرد» يرجعوا')).toBeTruthy();
  });

  it('a manager who holds «تجاوز أقفال التحرير» (not the owner) gets it', async () => {
    await openSara(MANAGER, PLAN_12);
    expect(returnButton()).not.toBeNull();
  });

  it('an empty pile draws the button DISABLED and says why — the owner is not left wondering where it went', async () => {
    await openSara(OWNER, PLAN_0);
    const button = screen.getByRole('button', { name: BUTTON });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('ما في «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها')).toBeTruthy();
    fireEvent.click(button);
    expect(askFirst).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it('NEGATIVE: his own desk has no such button, whatever he holds', async () => {
    user.current = OWNER;
    serve(PLAN_479);
    render(<ConfirmationMineScreen />);
    await screen.findByText('MINE-1');
    expect(returnButton()).toBeNull();
  });

  it('NEGATIVE: a watcher without «تجاوز أقفال التحرير» sees the desk and no button — even if a plan somehow arrived', async () => {
    await openSara(WATCHER, PLAN_479);
    expect(screen.getByRole('status').textContent).toBe('عم تشوف شاشة سارة — قراءة بس');
    expect(returnButton()).toBeNull();
  });

  it('NEGATIVE: no plan from the server, no button — the screen counts nothing itself', async () => {
    await openSara(OWNER, null);
    expect(screen.getByText('SARA-1')).toBeTruthy();
    expect(returnButton()).toBeNull();
  });

  it('NEGATIVE: and coming back to his own desk takes it away again', async () => {
    await openSara(OWNER, PLAN_479);
    expect(returnButton()).not.toBeNull();
    pick('');
    await screen.findByText('MINE-1');
    expect(returnButton()).toBeNull();
  });
});

describe('pressing it', () => {
  it('ASKS first, in the shared dialog: how many, from whose desk, what happens to them, and — over 200 — how many remain', async () => {
    await openSara(OWNER, PLAN_479);
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(askFirst).toHaveBeenCalledTimes(1));
    const asked = askFirst.mock.calls[0][0] as { title: string; body: string; confirmLabel: string; tone?: string };
    expect(asked.title).toBe('إرجاع 200 طلب «لا يرد» للطابور');
    expect(asked.body).toContain('من شاشة سارة.');
    // the owner’s sentence, word for word
    expect(asked.body).toContain('بيرجعوا للطابور وبتنبّه الموظفة، وبتضل بإيدها اللي عليهم موعد أو اللي ردّ زبونهم.');
    expect(asked.body).toContain('هالضغطة بترجع 200 من 479، وبيضل 279 — اضغط تاني لباقيهم.');
    expect(asked.confirmLabel).toBe('أرجِعهم للطابور');
    // a return is not a deletion: the button is not drawn as a danger
    expect(asked.tone).toBeUndefined();
  });

  it('a small pile’s question names its number and has no «remaining» line', async () => {
    await openSara(OWNER, PLAN_12);
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(askFirst).toHaveBeenCalledTimes(1));
    const asked = askFirst.mock.calls[0][0] as { title: string; body: string };
    expect(asked.title).toBe('إرجاع 12 طلب «لا يرد» للطابور');
    expect(asked.body).not.toContain('اضغط تاني');
  });

  it('NEGATIVE: declined — nothing is sent, the desk is not read again', async () => {
    await openSara(OWNER, PLAN_479);
    askFirst.mockImplementation(async () => false);
    const reads = mineCalls().length;
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(askFirst).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(writes()).toEqual([]);
    expect(mineCalls().length).toBe(reads);
    expect(toastApi.done).not.toHaveBeenCalled();
  });

  it('accepted: ONE request to the door with HER id in the path; the sentence is the toast; the desk and the picker are read again', async () => {
    await openSara(OWNER, PLAN_479);
    const deskReads = mineCalls().length;
    const pickerReads = apiJson.mock.calls.filter(([u]) => u === '/api/confirmation/desks').length;
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(toastApi.done).toHaveBeenCalledTimes(1));
    expect(writes()).toHaveLength(1);
    expect(writes()[0][0]).toBe(RETURN_URL);
    expect(writes()[0][1]).toMatchObject({ method: 'POST' });
    expect(toastApi.done).toHaveBeenCalledWith('رجع 200 طلب «لا يرد» للطابور — باقي 279 — اضغط تاني');
    expect(toastApi.warn).not.toHaveBeenCalled();
    await waitFor(() => expect(mineCalls().length).toBe(deskReads + 1));
    expect(mineCalls().at(-1)).toContain('agent=sara');
    await waitFor(() => expect(apiJson.mock.calls.filter(([u]) => u === '/api/confirmation/desks').length).toBe(pickerReads + 1));
    // still on her desk, read-only
    expect(screen.getByRole('status').textContent).toBe('عم تشوف شاشة سارة — قراءة بس');
  });

  it('a press that moved nothing is a WARNING with the server’s sentence, not a success', async () => {
    await openSara(OWNER, PLAN_12);
    pressAnswer = { returned: 0, skipped: 0, remaining: 0, limit: 200, agent: { id: 'sara', name: 'سارة' }, message: 'ما في طلب «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها' };
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(toastApi.warn).toHaveBeenCalledTimes(1));
    expect(toastApi.warn).toHaveBeenCalledWith('ما في طلب «لا يرد» يرجع هلأ — اللي عليه موعد أو اللي ردّ زبونه بيضل عندها');
    expect(toastApi.done).not.toHaveBeenCalled();
  });

  it('NEGATIVE: the door refuses — the refusal is said, nothing else changes, and the button is pressable again', async () => {
    await openSara(OWNER, PLAN_479);
    pressFails = Object.assign(new Error('إرجاع طلبات موظفة للطابور لمن يملك «تجاوز أقفال التحرير».'), { status: 403 });
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(toastApi.failed).toHaveBeenCalledTimes(1));
    expect(toastApi.failed).toHaveBeenCalledWith('إرجاع طلبات موظفة للطابور لمن يملك «تجاوز أقفال التحرير».');
    expect(toastApi.done).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: BUTTON }).hasAttribute('disabled')).toBe(false));
    expect(screen.getByText('SARA-1')).toBeTruthy();
  });

  it('the button waits while the request is out — a second press cannot start a second request', async () => {
    await openSara(OWNER, PLAN_479);
    let release: (v: unknown) => void = () => undefined;
    const base = apiJson.getMockImplementation()!;
    apiJson.mockImplementation(async (url: string, init?: { method?: string }) =>
      url === RETURN_URL ? new Promise((resolve) => { release = resolve; }) : base(url, init)
    );
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const waiting = screen.getByRole('button', { name: BUTTON });
    expect(waiting.hasAttribute('disabled')).toBe(true);
    fireEvent.click(waiting);
    await Promise.resolve();
    expect(writes()).toHaveLength(1);
    release(pressAnswer);
    await waitFor(() => expect(toastApi.done).toHaveBeenCalledTimes(1));
  });
});

describe('and nothing else on the watched desk writes', () => {
  it('before the press, every request the screen made is a read — and none of HER buttons is drawn', async () => {
    await openSara(OWNER, PLAN_479);
    for (const [, init] of apiJson.mock.calls) expect((init as { method?: string } | undefined)?.method ?? 'GET').toBe('GET');
    expect(screen.queryByTestId('pull-panel')).toBeNull();
    expect(screen.queryByTestId('contact-strip')).toBeNull();
    for (const name of [/تأكيد الطلب/, /^تأجيل/, /^ألغِ$/, /^لا يرد/, /افتح وعدّل/, /إدخال إشكال/, /احفظ المحافظة/]) {
      expect(screen.queryByRole('button', { name }), String(name)).toBeNull();
    }
    expect(apiFetch.mock.calls.filter(([, init]) => (init as { method?: string } | undefined)?.method)).toEqual([]);
  });

  it('the text of the screen carries none of the glyphs the screens forbid (✓ ≠ and the Arabic question mark)', async () => {
    await openSara(OWNER, PLAN_479);
    fireEvent.click(screen.getByRole('button', { name: BUTTON }));
    await waitFor(() => expect(askFirst).toHaveBeenCalledTimes(1));
    const FORBIDDEN = new RegExp(`[${String.fromCharCode(0x2713, 0x2260, 0x061f)}]`);
    const asked = askFirst.mock.calls[0][0] as { title: string; body: string; confirmLabel: string };
    for (const text of [asked.title, asked.body, asked.confirmLabel, BUTTON, document.body.textContent ?? '']) expect(text).not.toMatch(FORBIDDEN);
  });
});
