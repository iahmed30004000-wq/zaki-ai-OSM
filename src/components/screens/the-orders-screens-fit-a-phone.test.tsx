// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * M8 OF THE PHONE AUDIT — THE ORDERS SCREENS, AT 375px.
 *
 *   ORD-01 / 27 / 22 / 26   «الطلبات»: the first order started 750–850px down (search wrapped to three lines, six
 *           filters one to a line, the saved views); «إدخال طلب سريع» slid down every time «متقدم» opened.
 *   ORD-05 / 16 / 07         «طلباتي»: a card footer of up to eleven things in one wrapping row; four tabs that
 *           each printed a sentence and wrapped into four rows; the pull panel's caps and rule above the first order.
 *   ORD-21                   «العملاء»: five fact cards before the first customer; a history list that scrolls
 *           inside a dialog that scrolls; a two-column form of 140px fields.
 *
 * AND ONE RULE: A DESK IS WHAT IT WAS. Every phone layout is chosen by \`useIsPhone\`, so each screen is rendered
 * twice here — the phone's new layout, and the desk's old one spelled out. jsdom measures nothing; the heights,
 * the wrapping and the stacking were measured in a real browser at 375px (see the pull request).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, apiFetch, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
}));

vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: { orders: 'الطلبات', export: 'تصدير CSV', quickCreateOrder: 'إدخال طلب سريع', customers: 'العملاء' },
    currentUser: user.current,
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
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useAsk: () => vi.fn(async () => null), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [], countryName: '', currency: null }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/hooks/useCreateIntent', () => ({ useCreateIntent: () => undefined }));
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({ openWaybills: vi.fn(), describeRefused: () => '', BLOCKED_WAYBILLS: 'x', WaybillError: class extends Error {} }));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/orders/MigrateOrdersDialog', () => ({ MigrateOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => <i data-filter="product" /> }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => <i data-filter="saved-views" /> }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/screens/ConfirmationPostponedScreen', () => ({ ConfirmationPostponedScreen: () => <div /> }));
vi.mock('@/components/growth/AskAi', () => ({ AskAi: () => null }));

import { OrdersScreen } from './OrdersScreen';
import { ConfirmationMineScreen } from './ConfirmationMineScreen';
import { CustomersScreen } from './CustomersScreen';
import { PullPanel } from '@/components/confirmation/PullPanel';

const tokens = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
});
afterEach(cleanup);

/* ═══════════════════════ «الطلبات» — ORD-01 · 22 · 26 · 27 ═══════════════════════ */

describe('«الطلبات» — the search, the filters and the header', () => {
  const ORDER = {
    id: 'o1',
    orderNumber: 'ORD-26-7001',
    state: 'CONFIRMED',
    customer: { id: 'c1', fullName: 'نور', rawPhone: '0791234567', phone: '0791234567', city: 'عمّان' },
    region: { name: 'إربد' },
    productNameSnapshot: 'منتج',
    quantity: 1,
    source: 'Sheet import',
    moderator: { name: 'سارة' },
    createdAt: '2026-10-20T09:00:00.000Z',
    totalAmount: 40,
    confirmationStatus: 'NEW',
  };
  const FILTER_NAMES = ['فلتر الحالة', 'فلتر الجهة', 'فلتر المحافظة', 'فلتر شركة الشحن'];

  beforeEach(() => {
    user.current = { id: 'u1', name: 'سارة', role: 'SUPER_ADMIN', permissions: ['orders.view', 'orders.create', 'orders.export'], status: 'ACTIVE' };
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/orders?')
          ? { orders: [ORDER], pagination: { page: 1, limit: 25, total: 90, totalPages: 4 }, currency: { code: 'JOD', minorUnit: 3 }, dialCode: '962' }
          : { orders: [], providers: [], sources: [], pagination: { page: 1, pages: 1, total: 0 } },
    }));
  });
  const draw = async () => {
    render(<OrdersScreen />);
    await screen.findByLabelText('تحديد الطلب ORD-26-7001');
  };

  it('A DESK: the late toggle sits in the search row, the six filters are drawn open, the old header — no fold', async () => {
    await draw();
    expect(document.querySelectorAll('details[data-advanced-group]').length, 'متقدم فقط').toBe(1);
    expect(screen.queryByText('فلاتر')).toBeNull();
    const late = screen.getByRole('button', { name: /متأخرة 10 أيام\+ من الشحن/ });
    const searchRow = screen.getByLabelText('ابحث في الطلبات').closest('div')!.parentElement!;
    expect(searchRow.contains(late)).toBe(true);
    for (const name of FILTER_NAMES) expect(screen.getByLabelText(name).closest('details'), name).toBeNull();
    const grid = screen.getByLabelText('فلتر الحالة').closest('div.grid')!;
    expect(grid.getAttribute('class')).toBe('grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 p-3');
    // the header: its description, its row of actions with the old spacing, the main button AFTER the fold
    expect(screen.getByText('كل الطلبات بحالتها ومَن يحملها — الحالة والفلتر يقرآن نفس الشيء')).toBeTruthy();
    const quick = screen.getByRole('button', { name: 'إدخال طلب سريع' });
    expect(quick.parentElement!.getAttribute('class')).toBe('flex items-center space-x-2 rtl:space-x-reverse flex-wrap gap-y-2');
    const fold = document.querySelector('details[data-advanced-group]')!;
    expect(fold.compareDocumentPosition(quick) & Node.DOCUMENT_POSITION_FOLLOWING, '«متقدم» قبل الزر الرئيسي').toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'إدخال طلب سريع' })).toHaveLength(1);
  });

  it('A PHONE: the search row is the search and nothing else; the filters, the late toggle and the saved views are ONE fold', async () => {
    phone.value = true;
    await draw();
    const fold = [...document.querySelectorAll('details[data-advanced-group]')].find((d) => d.querySelector('summary')!.textContent!.includes('فلاتر')) as HTMLDetailsElement;
    expect(fold, 'ما في طيّة فلاتر').toBeTruthy();
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('الحالة');
    for (const name of FILTER_NAMES) expect(fold.contains(screen.getByLabelText(name)), name).toBe(true);
    expect(fold.contains(document.querySelector('[data-filter="product"]'))).toBe(true);
    expect(fold.contains(document.querySelector('[data-filter="saved-views"]'))).toBe(true);
    const late = screen.getByRole('button', { name: /متأخرة \+10 أيام/ });
    expect(fold.contains(late)).toBe(true);
    // the search stays out of it
    expect(fold.contains(screen.getByLabelText('ابحث في الطلبات'))).toBe(false);
    expect(fold.contains(screen.getByRole('button', { name: 'بحث' }))).toBe(false);
    // ONE copy of each filter and of the late toggle
    for (const name of FILTER_NAMES) expect(screen.getAllByLabelText(name), name).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /متأخرة/ })).toHaveLength(1);
    // inside the fold the filters are two to a line
    expect(tokens(screen.getByLabelText('فلتر الحالة').closest('div.grid'))).toContain('grid-cols-2');
  });

  it('A PHONE: the fold says how many filters are doing something, and the reset is inside it', async () => {
    phone.value = true;
    await draw();
    fireEvent.change(screen.getByLabelText('فلتر الحالة'), { target: { value: 'CONFIRMED' } });
    const summary = await screen.findByText(/^فلاتر \(1\)$/);
    const fold = summary.closest('details')!;
    const reset = screen.getByRole('button', { name: /إعادة تعيين \(1\)/ });
    expect(fold.contains(reset)).toBe(true);
    fireEvent.click(reset);
    await waitFor(() => expect(screen.queryByText(/^فلاتر \(1\)$/)).toBeNull());
    expect((screen.getByLabelText('فلتر الحالة') as HTMLSelectElement).value).toBe('all');
  });

  it('A PHONE: the main button is FIRST in the header, so opening «متقدم» cannot push it down; the description is one short line', async () => {
    phone.value = true;
    await draw();
    const quick = screen.getByRole('button', { name: 'إدخال طلب سريع' });
    const row = quick.parentElement!;
    expect(row.firstElementChild).toBe(quick);
    expect(row.getAttribute('class')).toBe('flex flex-wrap items-center gap-2');
    expect(screen.getByText('كل الطلبات بحالتها ومَن يحملها')).toBeTruthy();
    expect(screen.queryByText(/الحالة والفلتر يقرآن نفس الشيء/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'إدخال طلب سريع' })).toHaveLength(1);
  });

  it('«إظهار كل النتائج» has the hit area of a finger (tap-safe) and still shows everything', async () => {
    await draw();
    const showAll = screen.getByRole('button', { name: /إظهار كل النتائج/ });
    expect(tokens(showAll)).toContain('tap-safe');
    fireEvent.click(showAll);
    await waitFor(() => expect(screen.getByRole('button', { name: 'العودة للعرض بالصفحات' })).toBeTruthy());
    expect(tokens(screen.getByRole('button', { name: 'العودة للعرض بالصفحات' }))).toContain('tap-safe');
  });
});

/* ═══════════════════════ «طلباتي» — ORD-05 · 16 · 07 ═══════════════════════ */

describe('«طلباتي» — the tabs, the pull panel and the card', () => {
  const ROW = {
    id: 'o-1',
    orderNumber: 'ORD-26-1001',
    merchantRef: null,
    confirmationStatus: 'NEW',
    state: 'NEW',
    previousOrders: 0,
    version: 1,
    totalAmount: 30,
    currency: 'JOD',
    claimedAt: null,
    firstActionAt: null,
    postponedUntil: null,
    postponePreferredTime: null,
    postponeCount: 0,
    noAnswerCount: 1,
    source: 'Manual',
    moderatorId: 'm1',
    moderator: { id: 'm1', name: 'سارة' },
    createdBy: null,
    channel: null,
    customer: { id: 'c1', fullName: 'نور', phone: '0791234567', rawPhone: '0791234567', city: 'عمّان', address: 'شارع' },
    items: [],
    _count: { contactAttempts: 1, notes: 0 },
    risk: null,
  };
  const desk = (row = ROW) => ({
    leadDays: 2,
    waitingLater: 2,
    noAnswerLimit: 3,
    serverNow: '2026-10-24T08:00:00.000Z',
    work: [row],
    noAnswer: [],
    closedToday: [],
    confirmed: { day: '', q: '', page: 1, pageSize: 25, total: 0, pages: 1, rows: [] },
  });
  const POOL = { waiting: 5, owned: { total: 3, withoutAttempt: 2 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null };

  beforeEach(() => {
    user.current = {
      id: 'u1',
      name: 'سارة',
      role: 'CONFIRMATION_AGENT',
      permissions: ['confirmation.work', 'confirmation.pull', 'orders.contact_log', 'confirmation.raise_issue', 'ai.assist'],
      status: 'ACTIVE',
    };
    apiJson.mockImplementation(async (url: string) => {
      if (url.startsWith('/api/confirmation/mine')) return desk();
      if (url === '/api/confirmation/queue') return POOL;
      throw new Error(`unexpected ${url}`);
    });
  });
  const draw = async () => {
    render(<ConfirmationMineScreen />);
    await screen.findByText('ORD-26-1001');
  };
  const footer = () => screen.getByRole('button', { name: 'تأكيد الطلب' }).closest('footer') as HTMLElement;
  const names = (root: Element) => [...root.querySelectorAll('button')].map((b) => b.textContent!.replace(/\s+/g, ' ').trim());

  it('A DESK: one wrapping row, the buttons in the order the work happens in, no fold', async () => {
    await draw();
    const f = footer();
    expect(f.getAttribute('class')).toBe('flex flex-wrap items-center gap-2 pt-1 border-t border-[var(--sys-border)]');
    expect(f.querySelectorAll('details')).toHaveLength(0);
    // children are the buttons themselves, in the old order (the contact strip between «مغلق» and «تأكيد»)
    expect(names(f)).toEqual(['افتح وعدّل', 'لا يرد 1/3', 'مغلق أو خارج التغطية', 'تأكيد الطلب', 'تأجيل', 'ألغِ', 'إدخال إشكال', 'مساعدة']);
    for (const b of f.querySelectorAll('button')) {
      expect(tokens(b), b.textContent!).not.toContain('w-full');
      expect(tokens(b)).not.toContain('justify-center');
    }
  });

  it('A PHONE: reaching the customer, then what the call decided, then the rest behind «المزيد»', async () => {
    phone.value = true;
    await draw();
    const f = footer();
    expect(f.getAttribute('class')).toBe('space-y-3 pt-1 border-t border-[var(--sys-border)]');
    const confirm = screen.getByRole('button', { name: 'تأكيد الطلب' });
    expect(tokens(confirm)).toEqual(expect.arrayContaining(['w-full', 'justify-center', 'min-h-11']));
    // «تأجيل» and «ألغِ» side by side under it
    const pair = screen.getByRole('button', { name: /^تأجيل/ }).parentElement!;
    expect(tokens(pair)).toContain('grid-cols-2');
    expect(within(pair).getByRole('button', { name: 'ألغِ' })).toBeTruthy();
    // the two call results side by side, with the contact strip above them and the remaining attempts under
    const results = screen.getByRole('button', { name: /^لا يرد/ }).parentElement!;
    expect(tokens(results)).toContain('grid-cols-2');
    expect(within(results).getByRole('button', { name: 'مغلق أو خارج التغطية' })).toBeTruthy();
    expect(screen.getByText(/متبقٍ 2 محاولات قبل الإغلاق التلقائي/)).toBeTruthy();
    expect(f.querySelector('[data-contact]')).toBeTruthy();
    // the three that are not outcomes of the call are in ONE closed fold that names them
    const fold = f.querySelector('details') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('المزيد');
    expect(fold.querySelector('summary')!.textContent).toContain('افتح وعدّل · إدخال إشكال · مساعدة');
    expect(names(fold.lastElementChild!)).toEqual(['افتح وعدّل', 'إدخال إشكال', 'مساعدة']);
    // order on the page: reach → decide → more
    const pos = (el: Element) => [...f.querySelectorAll('*')].indexOf(el);
    expect(pos(f.querySelector('[data-contact]')!)).toBeLessThan(pos(confirm));
    expect(pos(confirm)).toBeLessThan(pos(fold));
  });

  it('the same eight buttons exist ONCE each on a phone and on a desk — only where they sit changes', async () => {
    const all: string[][] = [];
    for (const isPhone of [false, true]) {
      cleanup();
      phone.value = isPhone;
      await draw();
      all.push(names(footer()).filter((n) => n !== 'المزيد').sort());
    }
    expect(all[1].filter((n) => !n.startsWith('المزيد'))).toEqual(all[0]);
  });

  it('A DESK keeps the four tabs wrapping, each with its sentence; A PHONE keeps them on one scrolling strip with ONE sentence', async () => {
    await draw();
    let strip = screen.getByRole('tablist', { name: 'طلباتي' });
    expect(strip.getAttribute('class')).toBe('flex flex-wrap items-center gap-2 border-b border-[var(--sys-border)]');
    expect(within(strip).getByText('ما حدا اتّصل فيهم بعد')).toBeTruthy();
    expect(within(strip).getAllByRole('tab')).toHaveLength(4);
    cleanup();

    phone.value = true;
    await draw();
    strip = screen.getByRole('tablist', { name: 'طلباتي' });
    expect(tokens(strip)).toContain('overflow-x-auto');
    expect(tokens(strip)).not.toContain('flex-wrap');
    for (const tab of within(strip).getAllByRole('tab')) {
      expect(tokens(tab), tab.textContent!).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    }
    // the tab's sentence is its title, and the open tab's sentence is printed once, OUTSIDE the strip
    expect(within(strip).queryByText('ما حدا اتّصل فيهم بعد')).toBeNull();
    expect(screen.getAllByText('ما حدا اتّصل فيهم بعد')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: /للشغل/ }).getAttribute('title')).toBe('ما حدا اتّصل فيهم بعد');
    // switching tab changes the sentence — it is the OPEN tab's
    fireEvent.click(screen.getByRole('tab', { name: /لا يرد/ }));
    expect(await screen.findByText(/محاولة أو محاولتين — التالية تُغلق/)).toBeTruthy();
    expect(screen.queryByText('ما حدا اتّصل فيهم بعد')).toBeNull();
  });

  it('A PHONE: the section sentence is dropped and the search box takes the line; A DESK keeps both', async () => {
    await draw();
    expect(screen.getByText(/و2 مؤجّلة ليوم لاحق/)).toBeTruthy();
    expect(tokens(screen.getByPlaceholderText('رقم الهاتف أو الطلب أو الاسم'))).toContain('w-56');
    cleanup();
    phone.value = true;
    await draw();
    expect(screen.queryByText(/و2 مؤجّلة ليوم لاحق/)).toBeNull();
    expect(tokens(screen.getByPlaceholderText('رقم الهاتف أو الطلب أو الاسم'))).toContain('w-full');
  });

  it('the customer line of the card: A DESK keeps the typed « · »; A PHONE puts each fact in a box of its own', async () => {
    await draw();
    const line = screen.getByText(/نور/, { selector: 'div.text-sm' });
    expect(line.textContent).toContain('نور · 0791234567 · عمّان');
    expect(line.querySelector('span.flex')).toBeNull();
    cleanup();
    phone.value = true;
    await draw();
    const boxes = screen.getByText('0791234567').parentElement!;
    expect(tokens(boxes)).toEqual(expect.arrayContaining(['flex', 'flex-wrap']));
    expect([...boxes.children].map((c) => [c.textContent, c.getAttribute('dir')])).toEqual([
      ['نور', 'auto'],
      ['0791234567', 'ltr'],
      ['عمّان', 'auto'],
    ]);
  });

  it('the pull panel: A DESK shows the two caps and the rule; A PHONE folds them behind one line that says the two figures', async () => {
    await draw();
    await screen.findByText('طلب جاهز للسحب الآن');
    expect(screen.getByText('لديك بلا محاولة اتصال')).toBeTruthy();
    expect(screen.getByText(/الأولوية للطلبات المؤجلة المستحقة/)).toBeTruthy();
    const deskPull = screen.getByRole('button', { name: 'اسحب الطلب التالي' });
    expect(tokens(deskPull)).toEqual(expect.arrayContaining(['min-h-11', 'md:min-h-0']));
    expect(deskPull.closest('section')!.querySelector('details')).toBeNull();
    cleanup();

    phone.value = true;
    await draw();
    const section = (await screen.findByText('طلب جاهز للسحب الآن')).closest('section')!;
    const fold = section.querySelector('details') as HTMLDetailsElement;
    expect(fold.open).toBe(false);
    expect(fold.querySelector('summary')!.textContent).toContain('التفاصيل');
    expect(fold.querySelector('summary')!.textContent).toContain('بلا محاولة 2/3');
    expect(fold.querySelector('summary')!.textContent).toContain('بيدك 3/10');
    expect(fold.contains(screen.getByText('لديك بلا محاولة اتصال'))).toBe(true);
    expect(fold.contains(screen.getByText(/الأولوية للطلبات المؤجلة المستحقة/))).toBe(true);
    // the button is outside it
    expect(fold.contains(screen.getByRole('button', { name: 'اسحب الطلب التالي' }))).toBe(false);
  });

  it('NEGATIVE: a desk that does not pull (a supervisor) gets no caps, no rule and no fold — on a phone either', async () => {
    const supervisor = { ...POOL, canPull: false, refusal: { code: 'NOT_YOUR_DESK', message: 'هذا الحساب يشرف ولا يسحب' } };
    apiJson.mockImplementation(async (url: string) => (url.startsWith('/api/confirmation/mine') ? desk() : supervisor));
    phone.value = true;
    await draw();
    const section = (await screen.findByText('طلب جاهز للسحب الآن')).closest('section')!;
    expect(section.querySelector('details')).toBeNull();
    expect(screen.queryByText('لديك بلا محاولة اتصال')).toBeNull();
  });
});

describe('PullPanel, drawn alone', () => {
  const queue = {
    data: { waiting: 4, owned: { total: 1, withoutAttempt: 0 }, caps: { withoutAttempt: 3, total: 10 }, leadDays: 2, canPull: true, refusal: null, autoReleased: 0, orders: null },
    error: null,
    pulling: false,
    reload: vi.fn(async () => undefined),
    pull: vi.fn(async () => true),
  } as never;

  it('the full card (the supervisor’s page) is the same on a phone — it is not a slim bar', () => {
    phone.value = true;
    render(<PullPanel queue={queue} onPulled={() => undefined} />);
    expect(document.querySelectorAll('details')).toHaveLength(0);
    expect(screen.getByText('لديك بلا محاولة اتصال')).toBeTruthy();
  });
});

/* ═══════════════════════ «العملاء» — ORD-21 ═══════════════════════ */

describe('«العملاء»', () => {
  const CUSTOMER = {
    id: 'c1',
    fullName: 'نور الحسن',
    phone: '0791234567',
    rawPhone: '0791234567',
    city: 'عمّان',
    country: 'الأردن',
    address: 'شارع',
    totalOrders: 2,
    deliveredOrders: 2,
    cancelledOrders: 0,
    lastOrderDate: null,
    totalPurchaseValue: 80,
    orders: [{ id: 'oo1', orderNumber: 'ORD-26-1', totalAmount: 40, status: 'DELIVERED', product: { name: 'كريم تفتيح البشرة الطبيعي بخلاصة الألوفيرا والعسل' } }],
  };
  beforeEach(() => {
    user.current = { id: 'u1', name: 'سارة', role: 'SUPER_ADMIN', permissions: ['customers.view', 'customers.create'], status: 'ACTIVE' };
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/customers')
          ? {
              customers: [CUSTOMER],
              pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
              facts: {
                total: 178, ordered: 167, repeat: 1, received: 111, refused: 1, dormant: 9,
                byGrade: { loyal: 0, good: 0, watch: 0, risky: 0, new: 0 },
                cities: [{ city: 'عمّان', count: 90 }],
                deliveryRate: 62,
              },
              limited: false,
              dialCode: '962',
            }
          : {},
    }));
  });
  const draw = async () => {
    render(<CustomersScreen />);
    await screen.findAllByText('نور الحسن');
  };

  it('A DESK: the five facts in a grid, as ever', async () => {
    await draw();
    const grid = screen.getByText('نسبة الاستلام').closest('div')!.parentElement!;
    expect(grid.getAttribute('class')).toBe('grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5');
    expect(tokens(screen.getByText('نسبة الاستلام').closest('div'))).not.toContain('shrink-0');
  });

  it('A PHONE: the five facts are one strip that scrolls sideways, each card keeping its width', async () => {
    phone.value = true;
    await draw();
    const grid = screen.getByText('نسبة الاستلام').closest('div')!.parentElement!;
    expect(grid.getAttribute('class')).toBe('flex gap-2 overflow-x-auto pb-1');
    for (const label of ['عميل', 'طلبوا', 'كرّروا الطلب', 'رفضوا طرداً', 'نسبة الاستلام']) {
      expect(tokens(screen.getByText(label).closest('div')), label).toEqual(expect.arrayContaining(['shrink-0', 'w-36']));
    }
  });
});

describe('«العملاء» — the customer’s file and the new-customer form', () => {
  const CUSTOMER = {
    id: 'c1',
    fullName: 'نور الحسن',
    phone: '0791234567',
    rawPhone: '0791234567',
    city: 'عمّان',
    country: 'الأردن',
    address: 'شارع',
    totalOrders: 1,
    deliveredOrders: 1,
    cancelledOrders: 0,
    lastOrderDate: null,
    totalPurchaseValue: 40,
    orders: [{ id: 'oo1', orderNumber: 'ORD-26-1', totalAmount: 40, status: 'DELIVERED', product: { name: 'كريم تفتيح' } }],
  };
  beforeEach(() => {
    user.current = { id: 'u1', name: 'سارة', role: 'SUPER_ADMIN', permissions: ['customers.view', 'customers.create'], status: 'ACTIVE' };
    apiFetch.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).startsWith('/api/customers')
          ? {
              customers: [CUSTOMER],
              pagination: { page: 1, limit: 25, total: 1, totalPages: 1 },
              facts: { total: 1, ordered: 1, repeat: 0, received: 1, refused: 0, dormant: 0, byGrade: { loyal: 0, good: 0, watch: 0, risky: 0, new: 0 }, cities: [], deliveryRate: 100 },
              limited: false,
              dialCode: '962',
            }
          : {},
    }));
  });
  const openFile = async () => {
    render(<CustomersScreen />);
    fireEvent.click((await screen.findAllByText('نور الحسن'))[0]);
    return (await screen.findByText(/^سجل الطلبات/)).nextElementSibling as HTMLElement;
  };

  it('A DESK: the history keeps its 15rem window; a row is one line', async () => {
    const list = await openFile();
    expect(list.getAttribute('class')).toBe('divide-y divide-[var(--sys-border)] max-h-60 overflow-y-auto');
    expect(list.firstElementChild!.getAttribute('class')).toBe('py-2.5 flex items-center justify-between text-xs');
  });

  it('A PHONE: the history runs down the dialog’s own scroll, and a row wraps so the product name keeps its room', async () => {
    phone.value = true;
    const list = await openFile();
    expect(list.getAttribute('class')).toBe('divide-y divide-[var(--sys-border)]');
    expect(tokens(list.firstElementChild)).toContain('flex-wrap');
    expect(tokens(list.firstElementChild!.firstElementChild)).toContain('min-w-0');
    // nothing is dropped: the number, the product, the money and the status are all still in the row
    expect(within(list).getByText('ORD-26-1')).toBeTruthy();
    expect(within(list).getByText('كريم تفتيح')).toBeTruthy();
  });

  it('the add-customer form: A DESK is two columns; A PHONE is one column of full-width fields', async () => {
    for (const isPhone of [false, true]) {
      cleanup();
      phone.value = isPhone;
      render(<CustomersScreen />);
      fireEvent.click(await screen.findByRole('button', { name: /إضافة عميل/ }));
      const phoneBox = await screen.findByPlaceholderText('مثال: 0936654998');
      const grid = phoneBox.closest('div.grid')!;
      expect(grid.getAttribute('class'), isPhone ? 'phone' : 'desk').toBe(isPhone ? 'grid grid-cols-1 gap-3' : 'grid grid-cols-2 gap-3');
    }
  });
});
