// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE EIGHT BUSIEST SCREENS KEEP THEIR MAIN ACTION AND FOLD THE REST.
 *
 * Phase 4 of «سلاسة مطلقة» («التنظيف»), measured by the UI inventory: on
 * Orders, Products, Users, a user's page, Campaigns, Permissions, Production
 * and Wallets, the button that does the screen's job stays in plain sight and
 * the second-line controls move under one «متقدم» row (AdvancedGroup). The
 * component's own promises — closed by default, aria-expanded, folded not
 * removed, not remembered, no new CSS — are held in
 * src/components/ui/advanced-folds-closed-and-says-so.test.tsx. This file
 * holds the screens to it, one parametrized case per screen, each rendering
 * the REAL screen:
 *
 *   - the main action is drawn and sits in no «متقدم» row;
 *   - every moved control is still in the page, inside ONE «متقدم» row that
 *     starts closed, so it is not drawn;
 *   - one tap on that row draws them all and the row says it is expanded.
 *
 * The mocks are the union of each screen's existing test mocks (Orders from
 * orders-buttons-follow-their-doors, Products from
 * the-products-list-says-its-numbers, Campaigns from
 * a-campaign-can-be-filed-under-a-manual-account, Permissions from
 * a-role-that-cannot-finish-its-work, Production from
 * production-boxes-can-say-nothing, Wallets from
 * the-opening-balance-has-no-default) plus useMayOpen, as the team notes ask
 * of any test that renders a screen. Users and the user's page had no render
 * test before; their mocks stub the sections that fetch on their own.
 *
 * Every request the screen makes is answered from a small table per case; a
 * request the table does not name is left waiting forever — the screen stays
 * in its loading state for that part, the way it would on a slow line — so
 * no fixture has to imitate an endpoint this file does not read.
 *
 * MUTATION SERIES (run by hand when this file was written; each made its case
 * go red and was reverted):
 *   S1 «إدخال طلب سريع» moved inside the Orders «متقدم»     → الطلبات red
 *   S2 the wallet's «احذف» moved back out of «متقدم»        → المحافظ red
 *   (S3, the Users refresh inside «متقدم», is gone: a fold of one icon button
 *   was a click for nothing, and the button is drawn on the screen now.)
 */

const { app, nav, net, push } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  nav: { pathname: '/', params: {} as Record<string, string> },
  net: { answer: (() => undefined) as (url: string) => unknown },
  push: vi.fn(),
}));

/** A request this case's table names is answered; any other is left waiting. */
function reply(url: string): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  const body = net.answer(String(url));
  if (body === undefined) return new Promise(() => undefined);
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => nav.params,
}));
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => app.value }));
vi.mock('@/context/StoreCurrency', () => ({ useStoreCurrency: () => ({ code: 'JOD', minorUnit: 3 }) }));
vi.mock('@/lib/api-client', () => ({
  apiFetch: (url: string) => reply(url),
  apiJson: (url: string) => reply(url).then((r) => r.json()),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  // Loads once on mount and again when the key changes — never on an interval, never per render.
  useLiveRefresh: (load: () => unknown, opts?: { key?: unknown }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ show: vi.fn(), push: vi.fn(), done: vi.fn(), failed: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));
// Orders
vi.mock('@/components/labels/LabelSize', () => ({ useLabelSize: () => 'thermal', LabelSizePicker: () => null }));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(),
  describeRefused: () => '',
  WaybillError: class extends Error {},
}));
vi.mock('@/components/orders/CreateOrderModal', () => ({ CreateOrderModal: () => null }));
vi.mock('@/components/orders/AiOrderModal', () => ({ AiOrderModal: () => null }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => null }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));
// Products · Production
vi.mock('@/components/products/CategoryPicker', () => ({ CategoryPicker: () => null }));
vi.mock('@/components/production/BatchCostDialog', () => ({ BatchCostDialog: () => null }));
// Users · a user's page — the sections that fetch on their own
vi.mock('@/components/screens/users/CreateUserModal', () => ({ CreateUserModal: () => null }));
vi.mock('@/components/performance/ScoreCard', () => ({ ScoreCard: () => null }));
vi.mock('@/components/screens/users/UserShift', () => ({ UserShift: () => null }));
vi.mock('@/components/screens/users/UserSalary', () => ({ UserSalary: () => null }));
vi.mock('@/components/screens/users/UserAccessSections', () => ({ UserGeoAccessSection: () => null, UserPhoneField: () => null }));
vi.mock('@/components/screens/users/UserCommissionCurrency', () => ({ UserCommissionCurrency: () => null }));

import { OrdersScreen } from './OrdersScreen';
import { ProductsScreen } from './ProductsScreen';
import { UsersScreen } from './UsersScreen';
import { UserDetailScreen } from './UserDetailScreen';
import { CampaignsScreen } from './CampaignsScreen';
import { PermissionsScreen } from './PermissionsScreen';
import { ManufacturingScreen } from './ManufacturingScreen';
import { WalletsScreen } from './finance/WalletsScreen';

/**
 * What a browser DRAWS: inside a closed <details> only its <summary>. jsdom
 * keeps both in the tree and lays out neither, so the HTML rendering rule is
 * applied here by hand — the same helper as the component's own test.
 */
function drawn(el: Element): boolean {
  for (let box = el.closest('details'); box; box = box.parentElement?.closest('details') ?? null) {
    const summary = box.querySelector(':scope > summary');
    if (!box.open && !summary?.contains(el)) return false;
  }
  return !el.closest('[hidden]');
}

/** Answer exactly these paths (a query string after them is allowed); leave the rest waiting. */
function answering(table: Record<string, unknown>) {
  net.answer = (url) => {
    for (const [path, body] of Object.entries(table)) {
      if (url === path || url.startsWith(`${path}?`)) return body;
    }
    return undefined;
  };
}

function signedIn(role: string, ...permissions: string[]) {
  app.value = {
    locale: 'ar',
    t: {
      orders: 'الطلبات',
      export: 'تصدير CSV',
      quickCreateOrder: 'إدخال طلب سريع',
      products: 'المنتجات',
      loading: 'جارٍ التحميل…',
      cancel: 'إلغاء',
    },
    currentUser: { id: 'u0', name: 'المالك', role, permissions, status: 'ACTIVE' },
  };
}

const STAFF = {
  id: 'u2',
  name: 'موظّفة تأكيد',
  email: 'staff@example.test',
  role: 'CONFIRMATION_AGENT',
  status: 'ACTIVE',
  phone: null,
  createdAt: '2026-09-01T08:00:00.000Z',
  lastLoginAt: null,
  totpEnabledAt: '2026-10-01T08:00:00.000Z',
  workload: { assigned: 0, claimed: 0, created: 0 },
};
const ROLE = {
  id: 'r1',
  name: 'موظّف تأكيد',
  usersCount: 2,
  isSystem: false,
  permissions: [{ permission: 'orders.view', scope: 'ALL_COMPANY', scopeIds: [] }],
};
const CONNECTED_ACCOUNT = { id: 'acc-c', platform: 'META', accountId: 'act_1', accountName: 'ميتا المربوط', status: 'CONNECTED' };
const WALLET = {
  id: 'w1',
  name: 'صندوق المكتب',
  currencyCode: 'JOD',
  isActive: true,
  opening: 0,
  in: 0,
  out: 0,
  balance: 0,
  movements: 0,
  country: null,
  openingCount: null,
};

interface Case {
  screen: string;
  /** Who is signed in, what the network answers, and the render. */
  mount: () => void;
  /** Steps a person takes to reach the controls (Permissions: open the role). */
  reach?: (user: ReturnType<typeof userEvent.setup>) => Promise<void>;
  /** The control that does the screen's job — must stay drawn. */
  primary: string;
  /** The controls that moved under «متقدم» — in the page, folded. */
  folded: string[];
}

const CASES: Case[] = [
  {
    screen: 'الطلبات',
    mount: () => {
      nav.pathname = '/orders';
      signedIn('CONFIRMATION_AGENT', 'orders.view', 'reports.export', 'orders.import', 'orders.create');
      answering({ '/api/orders': { orders: [], pagination: { page: 1, pages: 1, total: 0 } } });
      render(<OrdersScreen />);
    },
    primary: 'إدخال طلب سريع',
    folded: ['تصدير CSV', 'استيراد طلبات', 'إدخال بالذكاء الاصطناعي'],
  },
  {
    screen: 'المنتجات',
    mount: () => {
      nav.pathname = '/products';
      signedIn('SUPER_ADMIN');
      answering({});
      render(<ProductsScreen />);
    },
    primary: 'إضافة منتج',
    folded: ['تشغيلات الإنتاج'],
  },
  {
    screen: 'صفحة الموظف',
    mount: () => {
      nav.pathname = '/admin/users/u2';
      nav.params = { id: 'u2' };
      signedIn('SUPER_ADMIN');
      answering({ '/api/users/u2/profile': STAFF, '/api/roles': { roles: [] } });
      render(<UserDetailScreen />);
    },
    primary: 'حفظ الدور',
    folded: ['أعِد ضبط التحقّق بخطوتين'],
  },
  {
    screen: 'الحملات',
    mount: () => {
      nav.pathname = '/growth/campaigns';
      signedIn('SUPER_ADMIN');
      answering({
        '/api/growth/campaigns': {
          campaigns: [],
          totals: { spend: 0, revenue: 0, net: 0, roas: null, costPerDelivered: null, costPerOrder: null, brought: 0, delivered: 0 },
          currency: 'USD',
          adAccounts: [CONNECTED_ACCOUNT],
          definitions: {},
        },
      });
      render(<CampaignsScreen />);
    },
    primary: 'حملة جديدة',
    folded: ['اسحب الحملات', 'اسحب الإنفاق'],
  },
  {
    screen: 'الصلاحيات',
    mount: () => {
      nav.pathname = '/admin/permissions';
      signedIn('SUPER_ADMIN');
      answering({ '/api/roles': { roles: [ROLE] }, '/api/roles/r1/default': { available: true } });
      render(<PermissionsScreen />);
    },
    reach: async (user) => {
      await user.click(await screen.findByText('تعديل'));
    },
    primary: 'حفظ التغييرات',
    folded: ['إرجاع للافتراضي'],
  },
  {
    screen: 'تشغيلات الإنتاج',
    mount: () => {
      nav.pathname = '/manufacturing';
      signedIn('SUPER_ADMIN');
      answering({ '/api/production': { batches: [], currency: 'JOD' }, '/api/products': { products: [] } });
      render(<ManufacturingScreen />);
    },
    primary: 'تشغيلة جديدة',
    folded: ['المنتجات', 'استلام بضاعة جاهزة'],
  },
  {
    screen: 'المحافظ',
    mount: () => {
      nav.pathname = '/finance/wallets';
      signedIn('SUPER_ADMIN');
      answering({ '/api/finance/wallets': { wallets: [WALLET] } });
      render(<WalletsScreen />);
    },
    primary: 'حركة جديدة',
    folded: ['عدّل الاسم', 'أوقف المحفظة', 'احذف'],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  nav.params = {};
  net.answer = () => undefined;
  // Some screens ask through the shared client (mocked above), some still call fetch itself: both read the same table.
  vi.stubGlobal('fetch', vi.fn((url: string) => reply(url)));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(CASES)('«$screen» keeps its main action in sight and folds the rest under «متقدم»', (c) => {
  it(`«${c.primary}» stays drawn; ${c.folded.map((f) => `«${f}»`).join(' · ')} wait folded in one closed «متقدم», and one tap draws them`, async () => {
    const user = userEvent.setup();
    c.mount();
    await c.reach?.(user);

    // The main action: drawn, and no copy of it is folded (an empty state may draw a second one — fine).
    const primaries = await screen.findAllByRole('button', { name: c.primary, hidden: true });
    expect(primaries.some(drawn), `«${c.primary}» مش ظاهر على «${c.screen}»`).toBe(true);
    for (const b of primaries) {
      expect(b.closest('[data-advanced-group]'), `«${c.primary}» انطوى تحت «متقدم» على «${c.screen}»`).toBeNull();
    }

    // The moved controls: still in the page, all inside ONE «متقدم», which starts closed.
    const moved = await Promise.all(c.folded.map((name) => screen.findByRole('button', { name, hidden: true })));
    const groups = new Set(moved.map((b) => b.closest('details[data-advanced-group]')));
    expect(groups.has(null), `زرّ من «${c.folded.join(' · ')}» برّا «متقدم» على «${c.screen}»`).toBe(false);
    expect(groups.size, `الأزرار المنقولة موزّعة على أكثر من «متقدم» على «${c.screen}»`).toBe(1);
    const group = [...groups][0] as HTMLDetailsElement;
    const summary = group.querySelector(':scope > summary') as HTMLElement;

    expect(group.open, `«متقدم» مفتوح لحاله على «${c.screen}»`).toBe(false);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(drawn(summary), `سطر «متقدم» نفسه مش ظاهر على «${c.screen}»`).toBe(true);
    for (const b of moved) expect(drawn(b), `«${b.textContent || b.getAttribute('aria-label')}» ظاهر قبل الفتح على «${c.screen}»`).toBe(false);

    // One tap: everything folded is drawn, the row says it is open, the main action is still there.
    await user.click(summary);
    await waitFor(() => expect(summary.getAttribute('aria-expanded'), `«متقدم» انفتح وما قال على «${c.screen}»`).toBe('true'));
    for (const b of moved) expect(drawn(b), `«${b.textContent || b.getAttribute('aria-label')}» ما بان بعد الفتح على «${c.screen}»`).toBe(true);
    expect(primaries.some(drawn)).toBe(true);
  });
});

describe('what a fold promises is what is inside it, for THIS person', () => {
  it('«الطلبات»: without the export, import and AI-entry grants there is nothing to fold, so there is no «متقدم» at all', async () => {
    nav.pathname = '/orders';
    signedIn('CONFIRMATION_AGENT', 'orders.view');
    answering({ '/api/orders': { orders: [], pagination: { page: 1, pages: 1, total: 0 } } });
    render(<OrdersScreen />);
    await screen.findByText('الطلبات');
    expect(document.querySelector('[data-advanced-group]'), 'طيٌّ فاضي').toBeNull();
    // and the list does not carry a refresh button of its own: it refreshes itself
    expect(screen.queryByRole('button', { name: 'تحديث', hidden: true })).toBeNull();
  });

  it('«الطلبات»: with only the export grant, «متقدم» names the export and nothing it does not hold', async () => {
    nav.pathname = '/orders';
    signedIn('CONFIRMATION_AGENT', 'orders.view', 'reports.export');
    answering({ '/api/orders': { orders: [], pagination: { page: 1, pages: 1, total: 0 } } });
    render(<OrdersScreen />);
    const summary = (await screen.findByText('متقدم')).closest('summary') as HTMLElement;
    expect(summary.textContent).toContain('تصدير');
    for (const gone of ['استيراد', 'إدخال بالذكاء', 'تحديث']) {
      expect(summary.textContent, `«متقدم» يعد بـ«${gone}» لمن لا يملكه`).not.toContain(gone);
    }
  });

  it('«الطلبات»: with every grant, the row lists all four', async () => {
    nav.pathname = '/orders';
    signedIn('CONFIRMATION_AGENT', 'orders.view', 'reports.export', 'orders.import', 'orders.create');
    answering({ '/api/orders': { orders: [], pagination: { page: 1, pages: 1, total: 0 } } });
    render(<OrdersScreen />);
    const summary = (await screen.findByText('متقدم')).closest('summary') as HTMLElement;
    for (const name of ['تصدير', 'استيراد', 'إدخال بالذكاء']) expect(summary.textContent).toContain(name);
  });

  it('«الموظفون»: the list does not refresh itself, so its refresh is DRAWN — not folded under a «متقدم» of one button', async () => {
    nav.pathname = '/admin/users';
    signedIn('COMPANY_ADMIN', 'users.view', 'users.create');
    answering({ '/api/users': { users: [], pagination: { total: 0, page: 1, limit: 25, totalPages: 1 } } });
    render(<UsersScreen />);
    const refresh = await screen.findByRole('button', { name: 'تحديث القائمة', hidden: true });
    expect(refresh.closest('[data-advanced-group]'), 'التحديث انطوى تحت «متقدم»').toBeNull();
    expect(drawn(refresh)).toBe(true);
    expect(document.querySelector('[data-advanced-group]'), '«متقدم» بزر واحد').toBeNull();
  });

  it('«المحافظ»: a STOPPED wallet shows «أعِد تشغيلها» outside the fold — it is the only way to unlock «حركة جديدة»', async () => {
    nav.pathname = '/finance/wallets';
    signedIn('SUPER_ADMIN');
    answering({ '/api/finance/wallets': { wallets: [{ ...WALLET, isActive: false }] } });
    render(<WalletsScreen />);
    const back = await screen.findByRole('button', { name: /أعِد تشغيلها/, hidden: true });
    expect(back.closest('[data-advanced-group]'), '«أعِد تشغيلها» مطوية تحت «متقدم»').toBeNull();
    expect(drawn(back)).toBe(true);
    // the record button is the thing it unlocks, and it is disabled until then — both of them: the wallet's own and the one at the top
    const record = screen.getAllByRole('button', { name: 'حركة جديدة' }) as HTMLButtonElement[];
    expect(record).toHaveLength(2);
    expect(record.every((b) => b.disabled)).toBe(true);
    // and the fold no longer offers a «stop» for a wallet that is already stopped
    expect(screen.queryByRole('button', { name: 'أوقف المحفظة', hidden: true })).toBeNull();
  });

  it('«المحافظ»: an ACTIVE wallet has no «أعِد تشغيلها» at all — the negative case', async () => {
    nav.pathname = '/finance/wallets';
    signedIn('SUPER_ADMIN');
    answering({ '/api/finance/wallets': { wallets: [WALLET] } });
    render(<WalletsScreen />);
    await screen.findByRole('button', { name: 'أوقف المحفظة', hidden: true });
    expect(screen.queryByRole('button', { name: /أعِد تشغيلها/, hidden: true })).toBeNull();
  });
});
