// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A BUTTON THAT REFUSES IS WORSE THAN A BUTTON THAT IS NOT THERE.
 *
 * «الطلبات» drew «تصدير CSV», «استيراد طلبات», «إدخال بالذكاء الاصطناعي»
 * and «إدخال طلب سريع» for anybody who could open the screen. Only the
 * server refused — so a confirmation agent pressed a button that was drawn
 * for her and got «Forbidden: missing required permission». A control that
 * is visible and then refuses reads as a broken system, not as a boundary.
 *
 * Printing was already gated by `ops.labels` and stays that way; the other
 * four now ask what their own doors ask.
 *
 * Read off the rendered screen, both ways, because a guard that checks for
 * the NAME of a permission in a file is satisfied by `{false && canExport
 * && …}` — this repository has been caught by that shape before.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiFetch, currentUser, nav } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  currentUser: { value: null as unknown },
  nav: { params: new URLSearchParams() },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => nav.params,
  usePathname: () => '/orders',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  apiJson: vi.fn(async () => ({})),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: { orders: 'الطلبات', export: 'تصدير CSV', quickCreateOrder: 'إدخال طلب سريع' },
    currentUser: currentUser.value,
  }),
}));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock('@/hooks/useProducts', () => ({ useProducts: () => ({ products: [] }) }));
vi.mock('@/components/ui/Confirm', () => ({ useTell: () => vi.fn(), useConfirm: () => vi.fn() }));
vi.mock('@/components/labels/LabelSize', () => ({
  useLabelSize: () => 'thermal',
  LabelSizePicker: () => null,
}));
vi.mock('@/components/labels/openWaybills', () => ({
  openWaybills: vi.fn(),
  describeRefused: () => '',
  WaybillError: class extends Error {},
}));
// The heavy children are not what is under test, and each one drags in its
// own context. They render as nothing; the buttons that OPEN them are the
// subject — and, since 22/10, a marker where one is open, because the box (Ctrl+K) opens them too.
vi.mock('@/components/orders/CreateOrderModal', () => ({
  CreateOrderModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="form-order" /> : null),
}));
vi.mock('@/components/orders/AiOrderModal', () => ({
  AiOrderModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="form-ai-order" /> : null),
}));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/ImportOrdersDialog', () => ({ ImportOrdersDialog: () => <div data-testid="form-import-orders" /> }));
vi.mock('@/components/scan/ScanButton', () => ({ ScanButton: () => null }));
vi.mock('@/components/ui/ProductPicker', () => ({ ProductPicker: () => null }));
vi.mock('@/components/ui/SavedViews', () => ({ SavedViews: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null }));

import { OrdersScreen } from './OrdersScreen';

/** A signed-in person holding exactly these permission keys. */
function signedInWith(...permissions: string[]) {
  currentUser.value = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions, status: 'ACTIVE' };
}

/** The address bar and the router's view of it agree, the way they do when Next follows `history.replaceState`. */
function visit(search: string) {
  window.history.replaceState(null, '', `/orders${search}`);
  nav.params = new URLSearchParams(search);
}

/*
 * The keys each button's own door asks for. «استيراد طلبات» asks for TWO since RV98: GET and POST /api/orders/import, and
 * every row it sends through POST /api/orders, want orders.create besides the import grant. It was drawn for
 * orders.import alone, and a custom account holding only that opened a dialog that refused every row.
 */
const BUTTONS: Record<string, readonly string[]> = {
  'تصدير CSV': ['reports.export'],
  'استيراد طلبات': ['orders.import', 'orders.create'],
  'إدخال بالذكاء الاصطناعي': ['orders.create'],
  'إدخال طلب سريع': ['orders.create'],
};
const holds = (granted: readonly string[], keys: readonly string[]) => keys.every((k) => granted.includes(k));

beforeEach(() => {
  vi.clearAllMocks();
  visit('');
  apiFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ orders: [], pagination: { page: 1, pages: 1, total: 0 } }),
  });
});

afterEach(cleanup);

describe('the buttons on «الطلبات»', () => {
  it('are each absent without the permission its own door asks for', () => {
    // Holding orders.view and nothing else: she can read the list, and
    // that is all this screen offers her.
    signedInWith('orders.view');
    render(<OrdersScreen />);

    for (const label of Object.keys(BUTTONS)) {
      expect(screen.queryByText(label), `${label} معروض بلا صلاحية`).toBeNull();
    }
  });

  it('and «استيراد طلبات» is absent for each of its two keys alone — the dialog would refuse every row', () => {
    for (const only of ['orders.import', 'orders.create']) {
      cleanup();
      signedInWith('orders.view', only);
      render(<OrdersScreen />);
      expect(screen.queryByText('استيراد طلبات'), `ظهر مع ${only} وحده`).toBeNull();
    }
  });

  it('and each appears when, and only when, ALL the permissions its own door asks for are held', () => {
    for (const [label, permissions] of Object.entries(BUTTONS)) {
      cleanup();
      signedInWith('orders.view', ...permissions);
      render(<OrdersScreen />);

      expect(screen.queryByText(label), `${label} مخفيّ مع إنّه معه ${permissions.join(' + ')}`).not.toBeNull();

      // And nothing else came with it that those keys do not open.
      for (const [other, otherPermissions] of Object.entries(BUTTONS)) {
        if (holds(permissions, otherPermissions)) continue;
        expect(screen.queryByText(other), `${other} ظهر مع ${permissions.join(' + ')}`).toBeNull();
      }
    }
  });

  it('and the owner sees all of them', () => {
    signedInWith('orders.view', 'reports.export', 'orders.create', 'orders.import');
    render(<OrdersScreen />);

    for (const label of Object.keys(BUTTONS)) {
      expect(screen.queryByText(label), `${label} مخفيّ عن المالك`).not.toBeNull();
    }
  });

  it('and a SUPER_ADMIN is never locked out of his own screen', () => {
    // `userCan` lets SUPER_ADMIN past every check, by design. If that ever
    // stopped being true the owner would lose his own buttons on deploy.
    currentUser.value = { id: 'u0', name: 'المالك', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' };
    render(<OrdersScreen />);

    for (const label of Object.keys(BUTTONS)) {
      expect(screen.queryByText(label), `${label} مخفيّ عن SUPER_ADMIN`).not.toBeNull();
    }
  });
});

/**
 * «+ أنشئ» IN CTRL+K OPENS THE SAME THREE FORMS — FOR WHOEVER THE THREE BUTTONS ARE DRAWN FOR (22/10).
 *
 * The box goes to `/orders?new=order`, `?new=ai-order` or `?new=import-orders`. The screen opens the form its button opens and takes
 * the word out of the address. It must not be a way around the buttons above: an address typed by hand for a form this account has
 * no button for opens nothing — read off the rendered screen, both ways, for the same reason the tests above are.
 */
describe('the box (Ctrl+K) opens the forms the buttons open', () => {
  const FORMS = {
    order: { testid: 'form-order', permission: ['orders.create'] },
    'ai-order': { testid: 'form-ai-order', permission: ['orders.create'] },
    'import-orders': { testid: 'form-import-orders', permission: ['orders.import', 'orders.create'] },
  } as const;
  const openNow = () => Object.values(FORMS).filter((f) => screen.queryByTestId(f.testid)).map((f) => f.testid);

  it('— each word opens its own form, and only that one, for someone who has its button', () => {
    for (const [word, form] of Object.entries(FORMS)) {
      cleanup();
      signedInWith('orders.view', ...form.permission);
      visit(`?new=${word}`);
      render(<OrdersScreen />);
      expect(openNow(), word).toEqual([form.testid]);
    }
  });

  it('— and takes the word out of the address, so a refresh does not open it again', () => {
    signedInWith('orders.view', 'orders.create');
    visit('?state=POSTPONED&new=order');
    render(<OrdersScreen />);
    const rest = new URLSearchParams(window.location.search);
    expect(rest.has('new')).toBe(false);
    expect(rest.get('state')).toBe('POSTPONED');
  });

  it('— and opens nothing for someone who has no button for it, though the address says so', () => {
    signedInWith('orders.view');
    for (const word of Object.keys(FORMS)) {
      cleanup();
      visit(`?new=${word}`);
      render(<OrdersScreen />);
      expect(openNow(), `${word}: انفتح نموذجٌ بلا زرّ`).toEqual([]);
      expect(window.location.search, `${word}: الكلمة بقيت بالعنوان`).toBe('');
    }
  });

  it('— the import is behind both its keys: «orders.create» alone does not open it, and «orders.import» alone opens nothing', () => {
    signedInWith('orders.view', 'orders.create');
    visit('?new=import-orders');
    render(<OrdersScreen />);
    expect(openNow()).toEqual([]);
    cleanup();
    signedInWith('orders.view', 'orders.import');
    visit('?new=import-orders');
    render(<OrdersScreen />);
    expect(openNow()).toEqual([]);
    cleanup();
    signedInWith('orders.view', 'orders.import');
    visit('?new=order');
    render(<OrdersScreen />);
    expect(openNow()).toEqual([]);
  });

  it('— and an address with no word opens nothing', () => {
    signedInWith('orders.view', 'orders.create', 'orders.import');
    render(<OrdersScreen />);
    expect(openNow()).toEqual([]);
  });
});
