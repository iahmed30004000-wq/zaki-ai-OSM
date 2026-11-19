// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * R8c (18/11) — THE TABS AND THE LISTS OF «طلباتي», ON THE KIT, AND NOTHING THE AGENT DOES CHANGED.
 *
 *   1. `DeskTabs.tsx` and `DoneList.tsx` are PRESENTATION: no server call, no session, no permission. (The four big windows staying
 *      lazy is held for every file of this folder by `the-desk-head-is-presentation.test.tsx`.)
 *   2. The same four tabs, in the same order, the same default, the same counts — and the tab is still a tab: `role="tab"`,
 *      `aria-selected`, its count, its sentence on a desk, its name the label and not the sentence.
 *   3. «أكّدتها» asks the SAME address as before for every day, search and page — pinned byte for byte (the query is built in the
 *      screen, in the order day · q · page · agent).
 *   4. The kit's buttons inside the day's form name their type: «رجّعني لليوم» never submits a search.
 *   5. At a phone's width (jsdom — nothing behind the sign-in can be opened in a browser here): every button of the strip and of
 *      «أكّدتها» carries the kit's phone height, and no fixed width is wider than the screen.
 */

const { apiJson, user, phone, params } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
  params: { value: '' },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(params.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>, opts: { key?: string } = {}) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts.key]);
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <p>قائمة المؤجلة</p> }));

import { ConfirmationMineScreen } from '../ConfirmationMineScreen';
import { TabButton } from './DeskTabs';
import { DoneList } from './DoneList';
import { Button } from '@/components/ui/Button';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  confirmationStatus: 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 1,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع 4',
  region: { name: 'دمشق' },
  customerNotes: null,
  customer: { id: `c-${id}`, fullName: `زبون ${id}`, phone: '0790000001', rawPhone: '0790000001', city: 'المزة', address: 'عنوان' },
  items: [{ id: 'l1', productName: 'كريم', quantity: 1, freeQuantity: 0, lineTotal: 45 }],
  addOns: [],
  _count: { contactAttempts: 1, notes: 0 },
  ...over,
});

const desk = (over: Record<string, unknown> = {}) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-30T08:00:00.000Z',
  work: [row('W1'), row('W2')],
  noAnswer: [row('N1', { noAnswerCount: 1 })],
  closedToday: [],
  confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 60, pages: 3, rows: [row('C1', { confirmationStatus: 'CONFIRMED', state: 'CONFIRMED' })] },
  ...over,
});

let mine: ReturnType<typeof desk>;
const AGENT = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'orders.contact_log'], status: 'ACTIVE' };

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  params.value = '';
  mine = desk();
  user.current = AGENT;
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) {
      // the server answers the page it was asked for
      const asked = Number(new URLSearchParams(url.split('?')[1] ?? '').get('page') ?? '1');
      return { ...mine, confirmed: { ...mine.confirmed, page: Math.min(asked, mine.confirmed.pages) } };
    }
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const draw = async () => {
  render(<ConfirmationMineScreen />);
  await screen.findByText('ORD-W1');
};
const strip = () => screen.getByRole('tablist', { name: 'طلباتي' });
const deskUrls = () => apiJson.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith('/api/confirmation/mine'));
const lastUrl = () => deskUrls().at(-1);
const tokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

// ───────────────────────── 1. presentation ─────────────────────────

const FORBIDDEN = [/\bapiJson\b/, /\bapiFetch\b/, /\bfetch\(/, /\buseApp\b/, /\buserCan\b/, /\buseMayOpen\b/, /\beditsNow\b/, /EDIT_CONFIRMED_KEY/];

describe('DeskTabs and DoneList are presentation: no server, no session, no permission', () => {
  it.each(['DeskTabs.tsx', 'DoneList.tsx'])('%s names none of them', (name) => {
    const code = stripComments(repoFile(`src/components/screens/confirmation/${name}`));
    for (const re of FORBIDDEN) expect(code, `${name} ← ${re}`).not.toMatch(re);
  });

  it('NEGATIVE: the check catches each of them', () => {
    const bad = ["apiJson('/x')", "apiFetch('/x')", "fetch('/x')", 'useApp()', "userCan(u, 'k')", 'useMayOpen()', "editsNow(u, o, 'CANCEL')", 'EDIT_CONFIRMED_KEY'];
    bad.forEach((line, i) => expect(line).toMatch(FORBIDDEN[i]));
  });

  it('and the decisions stayed in the screen, word for word', () => {
    const code = stripComments(repoFile('src/components/screens/ConfirmationMineScreen.tsx'));
    expect(code).toContain("onOpenOrder={!readOnly && (holderId !== null || userCan(currentUser, 'orders.view')) ? (orderId) => setOpenOrderId(orderId) : undefined}");
    expect(code).toContain('editsItself={userCan(currentUser, EDIT_CONFIRMED_KEY)}');
    expect(code).toContain('rowActions={readOnly ? undefined : (order) => (');
    expect(code).toContain("{editsNow(currentUser, order, 'CANCEL') ? 'تعديل' : 'طلب تعديل'}");
    expect(code).toContain('{!readOnly && (');
  });
});

// ───────────────────────── 2. the same four tabs ─────────────────────────

describe('the strip: the same four tabs, the same order, the same default, the same counts', () => {
  it('«اتصلي هلّق» · «بانتظار» · «أكّدتها» · «المؤجلة», the first one open, each count the server’s', async () => {
    await draw();
    const tabs = within(strip()).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-label'))).toEqual(['اتصلي هلّق 2', 'بانتظار 1', 'أكّدتها 60', 'المؤجلة']);
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    // a desk: the sentence under each tab, and as its title
    expect(within(tabs[0]).getByText('اللي لازم ترني عليه هلّق')).toBeTruthy();
    expect(tabs[0].getAttribute('title')).toBe('اللي لازم ترني عليه هلّق');
    // the amber count of «بانتظار», the plain one of the others
    expect(within(tabs[1]).getByText('1').getAttribute('class')).toContain('--sys-warning');
    expect(within(tabs[0]).getByText('2').getAttribute('class')).not.toContain('--sys-warning');
  });

  it('the tab’s name is its label and its count — NOT its sentence (a kit button with no words would take the title)', async () => {
    await draw();
    const work = screen.getByRole('tab', { name: /^اتصلي هلّق/ });
    expect(work.getAttribute('aria-label')).toBe('اتصلي هلّق 2');
    expect(screen.queryByRole('tab', { name: 'اللي لازم ترني عليه هلّق' })).toBeNull();
  });

  it('a press moves the selection, and the open tab is the kit’s framed button', async () => {
    await draw();
    fireEvent.click(screen.getByRole('tab', { name: /^أكّدتها/ }));
    const done = screen.getByRole('tab', { name: /^أكّدتها/ });
    expect(done.getAttribute('aria-selected')).toBe('true');
    expect(tokens(done)).toContain('bg-[var(--sys-card)]');
    expect(tokens(screen.getByRole('tab', { name: /^اتصلي هلّق/ }))).toContain('bg-transparent');
  });

  it('`?tab=postponed` still opens on «المؤجلة», and its list is still the lazy window', async () => {
    params.value = 'tab=postponed';
    render(<ConfirmationMineScreen />);
    expect(await screen.findByText('قائمة المؤجلة')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^المؤجلة/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('TabButton alone: no count → no count box; a phone → no sentence, the title keeps it', () => {
    const onClick = vi.fn();
    render(
      <div role="tablist">
        <TabButton active={false} onClick={onClick} label="المؤجلة" note="جملة التبويب" phone />
      </div>
    );
    const t = screen.getByRole('tab', { name: 'المؤجلة' });
    expect(t.getAttribute('aria-selected')).toBe('false');
    expect(t.getAttribute('title')).toBe('جملة التبويب');
    expect(within(t).queryByText('جملة التبويب')).toBeNull();
    fireEvent.click(t);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── 3. «أكّدتها» asks the same address ─────────────────────────

describe('«أكّدتها» asks the SAME address for every day, search and page', () => {
  it('a day, then a search, then a page, then back — the exact URLs the desk always asked', async () => {
    await draw();
    expect(lastUrl()).toBe('/api/confirmation/mine');
    fireEvent.click(screen.getByRole('tab', { name: /^أكّدتها/ }));

    const day = screen.getByLabelText('اليوم') as HTMLInputElement;
    expect(day.type).toBe('date');
    expect(day.value).toBe('2026-10-30'); // the server's day until she picks one
    fireEvent.change(day, { target: { value: '2026-10-28' } });
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-28'));

    fireEvent.change(screen.getByLabelText('رقم الطلب أو الاسم أو الهاتف'), { target: { value: '  0790 ' } });
    // typing asks nothing
    expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-28');
    fireEvent.click(screen.getByRole('button', { name: /ابحث/ }));
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-28&q=0790'));

    fireEvent.click(screen.getByRole('button', { name: 'الأقدم' }));
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-28&q=0790&page=2'));
    fireEvent.click(screen.getByRole('button', { name: 'الأقدم' }));
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-28&q=0790&page=3'));
    fireEvent.click(screen.getByRole('button', { name: 'الأحدث' }));
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-28&q=0790&page=2'));

    // a new day goes back to page one
    fireEvent.change(screen.getByLabelText('اليوم'), { target: { value: '2026-10-27' } });
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine?day=2026-10-27&q=0790'));

    fireEvent.click(screen.getByRole('button', { name: /رجّعني لليوم/ }));
    await waitFor(() => expect(lastUrl()).toBe('/api/confirmation/mine'));
    expect((screen.getByLabelText('رقم الطلب أو الاسم أو الهاتف') as HTMLInputElement).value).toBe('');
  });

  it('the pager shuts at its ends and says where she is', async () => {
    await draw();
    fireEvent.click(screen.getByRole('tab', { name: /^أكّدتها/ }));
    expect((screen.getByRole('button', { name: 'الأحدث' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'الأقدم' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('1 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'الأقدم' }));
    await screen.findByText('2 / 3');
    fireEvent.click(screen.getByRole('button', { name: 'الأقدم' }));
    await screen.findByText('3 / 3');
    expect((screen.getByRole('button', { name: 'الأقدم' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'الأحدث' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('one page: no pager', async () => {
    mine = desk({ confirmed: { ...desk().confirmed, total: 1, pages: 1 } });
    await draw();
    fireEvent.click(screen.getByRole('tab', { name: /^أكّدتها/ }));
    expect(screen.queryByRole('button', { name: 'الأقدم' })).toBeNull();
  });
});

// ───────────────────────── 4. the form's buttons name their type ─────────────────────────

describe('inside the day’s form, the kit’s buttons name their type', () => {
  const page = { day: '2026-10-30', q: 'x', page: 1, pages: 1, total: 0, rows: [] };
  const handlers = () => ({
    onDay: vi.fn(),
    onTyped: vi.fn(),
    onSearch: vi.fn(),
    onReset: vi.fn(),
    onClearSearch: vi.fn(),
    onNewer: vi.fn(),
    onOlder: vi.fn(),
  });

  it('«ابحث» submits; «رجّعني لليوم» resets and never searches', () => {
    const h = handlers();
    render(<DoneList confirmed={page} day="2026-10-30" typed="" canReset historyHolderId={null} editsItself={false} {...h} />);
    const search = screen.getByRole('button', { name: /ابحث/ });
    const reset = screen.getByRole('button', { name: /رجّعني لليوم/ });
    expect(search.getAttribute('type')).toBe('submit');
    expect(reset.getAttribute('type')).toBe('button');
    fireEvent.click(reset);
    expect(h.onReset).toHaveBeenCalledTimes(1);
    expect(h.onSearch).not.toHaveBeenCalled();
    fireEvent.click(search);
    expect(h.onSearch).toHaveBeenCalledTimes(1);
    // the empty search's way out
    fireEvent.click(screen.getByRole('button', { name: 'امسح البحث' }));
    expect(h.onClearSearch).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: a kit button with no type inside a form DOES submit — which is why the type is named', () => {
    const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={submit}>
        <Button>بلا نوع</Button>
      </form>
    );
    fireEvent.click(screen.getByRole('button', { name: 'بلا نوع' }));
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('no «رجّعني لليوم» when nothing was asked; the number opens only when the screen hands the press', () => {
    const h = handlers();
    const rows = [row('C1')];
    render(<DoneList confirmed={{ ...page, q: '', total: 1, rows }} day="2026-10-30" typed="" canReset={false} historyHolderId={null} editsItself={false} {...h} />);
    expect(screen.queryByRole('button', { name: /رجّعني لليوم/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ORD-C1' })).toBeNull();
    cleanup();
    const onOpenOrder = vi.fn();
    render(<DoneList confirmed={{ ...page, q: '', total: 1, rows }} day="2026-10-30" typed="" canReset={false} historyHolderId={null} editsItself={false} onOpenOrder={onOpenOrder} {...h} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'ORD-C1' })[0]);
    expect(onOpenOrder).toHaveBeenCalledWith('C1');
  });
});

// ───────────────────────── 5. a phone's width ─────────────────────────

/** A fixed width in the class list, in px: `w-56` is 224, `w-[19rem]` 304, `min-w-[400px]` 400. */
function fixedWidthPx(token: string): number | null {
  const t = token.replace(/^[a-z]+:/, '');
  let m = /^(?:min-)?w-(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) * 4;
  m = /^(?:min-)?w-\[(\d+(?:\.\d+)?)(px|rem)\]$/.exec(t);
  if (m) return Number(m[1]) * (m[2] === 'rem' ? 16 : 1);
  return null;
}

describe('at a phone’s width (jsdom, 375 px)', () => {
  const VIEW = 375 - 2 * 16;

  it('NEGATIVE: the width reader catches a box wider than the screen', () => {
    // built from pieces: the stylesheet is scanned from tests too, and these widths must not be grown into it
    const w = 'w-';
    expect(fixedWidthPx(w + '96')).toBe(384);
    expect(fixedWidthPx('md:min-' + w + '[400px]')).toBe(400);
    expect(fixedWidthPx(w + '[25rem]')).toBe(400);
    expect(fixedWidthPx('w-full')).toBeNull();
  });

  it('every button of the strip and of «أكّدتها» is 44 px tall on a phone, and no fixed width passes the screen', async () => {
    phone.value = true;
    await draw();
    const tabs = within(strip()).getAllByRole('tab');
    for (const t of tabs) expect(tokens(t), t.textContent!).toContain('h-11');
    fireEvent.change(screen.getByPlaceholderText('رقم الهاتف أو الطلب أو الاسم'), { target: { value: '0' } });
    const clear = screen.getByRole('button', { name: 'امسح البحث' });
    expect(tokens(clear)).toContain('h-11');
    fireEvent.change(screen.getByPlaceholderText('رقم الهاتف أو الطلب أو الاسم'), { target: { value: '' } });

    fireEvent.click(screen.getByRole('tab', { name: /^أكّدتها/ }));
    const section = screen.getByLabelText('اليوم').closest('section')!;
    for (const b of within(section).getAllByRole('button')) {
      if (b.closest('table')) continue; // the desk's table is hidden on a phone; the cards carry the same presses
      const t = tokens(b);
      expect(t.includes('h-11') || t.includes('min-h-11'), `${b.textContent}: ${t.join(' ')}`).toBe(true);
    }
    for (const el of [strip(), section, ...strip().querySelectorAll('*'), ...section.querySelectorAll('*')]) {
      for (const tok of tokens(el)) {
        const px = fixedWidthPx(tok);
        if (px !== null) expect(px, `${tok} on ${el.tagName}`).toBeLessThanOrEqual(VIEW);
      }
    }
  });
});
