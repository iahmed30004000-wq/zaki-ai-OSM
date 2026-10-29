// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ROLES SCREEN TICKS WHAT AN ACTION NEEDS — AND SAYS SO.
 *
 * «تعديل الطلبات» ticked without «عرض الطلبات» is a box that is on and does
 * nothing. So ticking an action ticks its screen key, unticking the screen
 * key unticks its actions, and a line under the row that was clicked says
 * which — because the other key can sit in a closed section, and nothing may
 * change behind the person's back.
 *
 * What the screen must NOT do: touch what the person did not touch. A role
 * that already holds an action without its screen key (five shipped
 * templates do) is shown as it is, with a line saying what it lacks, and
 * saved as it is.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/permissions', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    locale: 'ar',
    t: {},
    currentUser: { id: 'u0', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' },
  }),
}));

import { PermissionsScreen } from './PermissionsScreen';

const VERSION = '2026-10-28T10:00:00.000Z';
const net = vi.hoisted(() => ({
  role: null as null | Record<string, unknown>,
  defaults: null as null | Array<{ permission: string; scope: string }>,
  patch: { status: 200, body: {} as Record<string, unknown> },
  duplicate: { status: 201, body: {} as Record<string, unknown> },
  calls: [] as Array<{ url: string; method: string; body: any }>,
}));

function roleHolding(...keys: string[]) {
  net.role = {
    id: 'r1',
    name: 'دور تجربة',
    usersCount: 2,
    isSystem: false,
    createdAt: VERSION,
    updatedAt: VERSION,
    permissions: keys.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: [] })),
  };
}

beforeEach(() => {
  net.defaults = null;
  net.patch = { status: 200, body: { success: true } };
  net.duplicate = { status: 201, body: { success: true } };
  net.calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      net.calls.push({ url: String(url), method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (String(url).endsWith('/duplicate')) return { ok: net.duplicate.status < 300, status: net.duplicate.status, json: async () => net.duplicate.body };
      if (String(url).includes('/default')) {
        return { ok: true, status: 200, json: async () => (net.defaults ? { available: true, permissions: net.defaults } : { available: false }) };
      }
      if (method === 'PATCH') return { ok: net.patch.status < 300, status: net.patch.status, json: async () => net.patch.body };
      if (String(url).startsWith('/api/categories')) return { ok: true, status: 200, json: async () => ({ categories: [] }) };
      return { ok: true, status: 200, json: async () => ({ roles: [net.role] }) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openTheRole() {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.queryByText('دور تجربة')).not.toBeNull());
  await user.click(await screen.findByText('تعديل'));
  await waitFor(() => expect(screen.queryByText('حفظ التغييرات')).not.toBeNull());
  return user;
}

/** Open one section of the matrix by its heading. */
async function openSection(user: ReturnType<typeof userEvent.setup>, heading: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${heading}`) }));
}

const box = (key: RegExp) => screen.getByRole('checkbox', { name: key }) as HTMLInputElement;
const ORDERS_EDIT = /orders\.edit/;
const ORDERS_VIEW = /orders\.view/;
const sentList = () => net.calls.find((c) => c.method === 'PATCH')!.body;

describe('ticking an action', () => {
  it('ticks the screen key it needs, and says so under the row that was clicked', async () => {
    roleHolding();
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');

    expect(box(ORDERS_VIEW).checked).toBe(false);
    await user.click(box(ORDERS_EDIT));

    expect(box(ORDERS_EDIT).checked).toBe(true);
    expect(box(ORDERS_VIEW).checked, 'ما انحطّ مفتاح الشاشة').toBe(true);
    const note = screen.getByRole('status');
    expect(note.textContent).toContain('انضافت معها «عرض الطلبات»');
    expect(note.textContent).toContain('كل الشركة');
    // The line sits under the row that was clicked, not somewhere else on the screen.
    expect(note.parentElement?.contains(box(ORDERS_EDIT))).toBe(true);
  });

  it('and the save carries both keys, over the version the screen read', async () => {
    roleHolding();
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');
    await user.click(box(ORDERS_EDIT));
    await user.click(screen.getByText('حفظ التغييرات'));

    await waitFor(() => expect(net.calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = sentList();
    expect(body.permissions.map((p: { permission: string }) => p.permission).sort()).toEqual(['orders.edit', 'orders.view']);
    expect(body.version, 'ما أرسل النسخة اللي قرأها').toBe(VERSION);
  });

  it('NEGATIVE: ticking a screen key, or an action that stands alone, ticks nothing else', async () => {
    roleHolding();
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');

    await user.click(box(ORDERS_VIEW));
    expect(box(ORDERS_VIEW).checked).toBe(true);
    expect(box(ORDERS_EDIT).checked).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();

    await user.click(box(/orders\.create/));
    expect(box(/orders\.create/).checked).toBe(true);
    expect(box(/orders\.import/).checked).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a standalone action says why it needs nothing, and a screen key says what it opens', async () => {
    roleHolding();
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');
    expect(screen.getByText('إنشاء الطلب له نموذجه الخاص — ما بيحتاج «عرض الطلبات».')).toBeTruthy();
    expect(screen.getByText('بتفتح: الطلبات')).toBeTruthy();
  });
});

describe('unticking a screen key', () => {
  it('unticks the actions that need it, and names them', async () => {
    roleHolding('orders.view', 'orders.edit', 'orders.navigate', 'orders.confirm', 'orders.claim');
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');

    await user.click(box(ORDERS_VIEW));

    for (const k of [ORDERS_VIEW, ORDERS_EDIT, /orders\.navigate/, /orders\.confirm/, /orders\.claim/]) {
      expect(box(k).checked, String(k)).toBe(false);
    }
    const note = screen.getByRole('status').textContent ?? '';
    expect(note).toContain('انشالت معها');
    expect(note).toContain('و1 غيرها');
    expect(note).toContain('ما بتشتغل بدون «عرض الطلبات»');
  });

  it('NEGATIVE: unticking an action takes nothing else off, and a key of another area stays', async () => {
    roleHolding('orders.view', 'orders.edit', 'products.view');
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');

    await user.click(box(ORDERS_EDIT));
    expect(box(ORDERS_EDIT).checked).toBe(false);
    expect(box(ORDERS_VIEW).checked).toBe(true);
    expect(screen.queryByRole('status')).toBeNull();

    await user.click(box(ORDERS_VIEW));
    await openSection(user, 'المنتجات');
    expect(box(/products\.view/).checked, 'مفتاح منطقة ثانية انشال').toBe(true);
  });
});

describe('a role that already holds an action without its screen key', () => {
  it('is shown as it is — never fixed on opening — with a line saying what it lacks', async () => {
    roleHolding('customers.view');
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'العملاء');

    expect(box(/customers\.view(?!_)/).checked).toBe(true);
    expect(box(/customers\.view_basic/).checked, 'اتفتح وانصلح لحاله').toBe(false);
    expect(screen.getByText('بتحتاج «عرض بيانات العميل الأساسية» — مش مفعّلة.')).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is saved as it is: the old pair goes back unchanged', async () => {
    roleHolding('customers.view');
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await user.click(screen.getByText('حفظ التغييرات'));
    await waitFor(() => expect(net.calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(sentList().permissions.map((p: { permission: string }) => p.permission)).toEqual(['customers.view']);
  });
});

describe('a refusal from the door', () => {
  it('a stale role (409) is shown in the door’s own words, and the list is read again so the next try carries the new version', async () => {
    roleHolding('orders.view');
    net.patch = { status: 409, body: { error: 'تغيّرت الصلاحيات من وقت ما فتحت الشاشة — حدّث الصفحة وأعد تعديلك', code: 'STALE_VERSION' } };
    render(<PermissionsScreen />);
    const user = await openTheRole();
    const before = net.calls.filter((c) => c.url === '/api/roles' && c.method === 'GET').length;
    await user.click(screen.getByText('حفظ التغييرات'));
    await waitFor(() => expect(screen.queryByText(/حدّث الصفحة/)).not.toBeNull());
    expect(net.calls.filter((c) => c.url === '/api/roles' && c.method === 'GET').length).toBeGreaterThan(before);
  });

  it('a refused copy is shown INSIDE the copy window, which stays open — it used to vanish with the window', async () => {
    roleHolding('orders.view');
    net.duplicate = { status: 400, body: { error: 'لازم «عرض الطلبات» مع «تعديل الطلبات»', code: 'ORPHAN_ACTION' } };
    render(<PermissionsScreen />);
    const user = userEvent.setup();
    await waitFor(() => expect(screen.queryByText('دور تجربة')).not.toBeNull());
    await user.click(await screen.findByText('نسخ'));
    const title = await screen.findByText('نسخ الدور');
    const dialog = title.closest('[role="dialog"]') ?? title.parentElement!.parentElement!;
    await user.click(within(dialog as HTMLElement).getAllByText('نسخ').pop()!);

    await waitFor(() => expect(screen.queryByText('لازم «عرض الطلبات» مع «تعديل الطلبات»')).not.toBeNull());
    expect(screen.queryByText('نسخ الدور'), 'النافذة انسكرت').not.toBeNull();
  });
});

describe('«إرجاع للافتراضي»', () => {
  it('adds the screen key a shipped action comes back without, and says which', async () => {
    roleHolding('orders.view');
    net.defaults = [{ permission: 'orders.edit', scope: 'ALL_COMPANY' }];
    render(<PermissionsScreen />);
    const user = await openTheRole();
    await openSection(user, 'الطلبات');
    // The button is folded under «متقدم»; it is in the page all the same.
    fireEvent.click(await screen.findByText('إرجاع للافتراضي'));

    await waitFor(() => expect(screen.queryByText(/انضافت للافتراضي/)).not.toBeNull());
    expect(screen.getByText(/انضافت للافتراضي «عرض الطلبات»/)).toBeTruthy();
    expect(box(ORDERS_EDIT).checked).toBe(true);
    expect(box(ORDERS_VIEW).checked, 'رجع الافتراضي بلا مفتاح الشاشة').toBe(true);
  });

  it('NEGATIVE: a shipped matrix that is whole adds nothing', async () => {
    roleHolding('orders.view');
    net.defaults = [{ permission: 'orders.view', scope: 'ALL_COMPANY' }, { permission: 'orders.edit', scope: 'ALL_COMPANY' }];
    render(<PermissionsScreen />);
    const user = await openTheRole();
    fireEvent.click(await screen.findByText('إرجاع للافتراضي'));
    await waitFor(() => expect(screen.queryByText(/الصلاحيات الافتراضية للدور/)).not.toBeNull());
    expect(screen.queryByText(/انضافت للافتراضي/)).toBeNull();
    expect(user).toBeTruthy();
  });
});
