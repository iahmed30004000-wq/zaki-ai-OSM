// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CARD_CLASS } from '@/lib/theme-shape';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * ONE EMPLOYEE'S PAGE ON THE KIT (18/11, R16b1 — `/admin/users/[id]`).
 *
 * The page moved onto the kit's frame, buttons, tick boxes and nested cards. What it may NOT do on the way:
 *
 *   · draw a press for a different key — every button, and every card's «may edit» handed to the cards it holds, is
 *     asked for each key set the screen's own `userCan(` lines read (users.view · users.edit · users.security ·
 *     roles.edit · payroll.view · payroll.pay · users.shift · team.monitor · geo.manage), and for the server's «no»;
 *   · send a different request — every press sends the same URL, method and body, written out below as they were
 *     recorded on osm/main (323e5423) BEFORE the first edit: this file ran green on that copy and runs green on this one;
 *   · show a secret — the new-password field opens empty, and what is typed in it is printed nowhere else;
 *   · grow wider than a phone — the frame carries no width of its own, the effective table goes through `Rows`.
 *
 * Class names are built from pieces: Tailwind reads tests too, and a whole class token here would be a rule the sheet
 * does not need.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { app, net, nav } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  net: {
    calls: [] as Array<{ url: string; method: string; body: unknown }>,
    profile: {} as Record<string, unknown>,
  },
  nav: { push: [] as string[] },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (p: string) => nav.push.push(p), replace: vi.fn(), back: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/admin/users/u2',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'u2' }),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({ useApp: () => app.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({
  useToast: () => ({ show: vi.fn(), push: vi.fn(), done: vi.fn(), failed: vi.fn(), success: vi.fn(), error: vi.fn() }),
}));
// The cards this page holds are other slices' files: here they only say whether they were drawn and what they were handed.
vi.mock('@/components/performance/ScoreCard', () => ({ ScoreCard: () => <div data-mock="score" /> }));
vi.mock('@/components/screens/users/UserShift', () => ({
  UserShift: (p: { canEdit: boolean }) => <div data-mock="shift" data-edit={String(p.canEdit)} />,
}));
vi.mock('@/components/screens/users/UserSalary', () => ({
  UserSalary: (p: { canEdit: boolean; canPay: boolean }) => <div data-mock="salary" data-edit={String(p.canEdit)} data-pay={String(p.canPay)} />,
}));
vi.mock('@/components/screens/users/UserAccessSections', () => ({
  UserGeoAccessSection: (p: { canEdit: boolean }) => <div data-mock="geo" data-edit={String(p.canEdit)} />,
  UserPhoneField: (p: { canEdit: boolean }) => <div data-mock="phone" data-edit={String(p.canEdit)} />,
}));
vi.mock('@/components/screens/users/UserCommissionCurrency', () => ({
  UserCommissionCurrency: (p: { canEdit: boolean }) => <div data-mock="currency" data-edit={String(p.canEdit)} />,
}));

import { UserDetailScreen } from './UserDetailScreen';

const STAFF = (over: Record<string, unknown> = {}) => ({
  id: 'u2', name: 'موظّفة تأكيد', email: 'staff@example.test', role: 'CONFIRMATION_AGENT', status: 'ACTIVE', phone: null,
  createdAt: '2026-09-01T08:00:00.000Z', lastLoginAt: null, totpEnabledAt: null,
  workload: { assigned: 3, claimed: 2, created: 1 },
  ...over,
});

const ROLES = {
  roles: [
    { id: 'r1', name: 'CONFIRMATION_AGENT', isSystem: true, permissionsCount: 12 },
    { id: 'r2', name: 'مسؤول المخزن', isSystem: false, permissionsCount: 5 },
  ],
};

const PERMS = {
  user: { id: 'u2', name: 'موظّفة تأكيد', email: 'staff@example.test' },
  role: { id: 'r1', name: 'موظف تأكيد' },
  permissionsVersion: 7,
  roleGrants: { 'orders.view': { scope: 'ALL_COMPANY' } },
  overrides: [{ permission: 'customers.view_basic', effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null }],
  effective: { fullAccess: false, grants: { 'orders.view': { scope: 'ALL_COMPANY' }, 'customers.view_basic': { scope: 'ALL_COMPANY' } } },
  denied: [],
};

const answer = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function signedIn(permissions: string[], role = 'ADMIN', id = 'u0') {
  app.value = { locale: 'ar', isRtl: true, t: {}, currentUser: { id, name: 'المدير', role, permissions, status: 'ACTIVE' } };
}

beforeEach(() => {
  net.calls = [];
  nav.push = [];
  net.profile = STAFF();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      net.calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.endsWith('/profile')) return answer(net.profile);
      if (url === '/api/roles') return answer(ROLES);
      if (url === '/api/users/u2/permissions' && method === 'GET') return answer(PERMS);
      if (url === '/api/categories') return answer({ categories: [{ id: 'c1', name: 'عطور' }, { id: 'c2', name: 'ساعات' }] });
      if (url.startsWith('/api/products')) return answer({ products: [{ id: 'p1', name: 'عطر ليلي', sku: 'SKU-1' }, { id: 'p2', name: 'ساعة', sku: 'SKU-2' }] });
      if (url === '/api/users/u2/enrol-code') return answer({ code: '7Q4KX2', hours: 24 });
      if (url === '/api/users/u2/two-factor') return answer({ message: 'انمسح التسجيل' });
      if (url === '/api/users/u2' && method === 'PATCH') {
        const b = JSON.parse(String(init?.body));
        return answer(b.action === 'resetPassword' ? { temporaryPassword: 'Gen3rated-Once-9' } : { user: { role: 'مسؤول المخزن' } });
      }
      return answer({});
    }),
  );
  // The copy button writes to the clipboard; jsdom has none.
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every press on the page, by its accessible name — what a person can do here. */
const presses = () =>
  screen
    .queryAllByRole('button', { hidden: true })
    .map((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim())
    .filter(Boolean)
    .sort();

const mock = (name: string) => document.querySelector(`[data-mock="${name}"]`) as HTMLElement | null;
const writes = () => net.calls.filter((c) => c.method !== 'GET');

async function open(permissions: string[], opts: { role?: string; viewerId?: string; profile?: Record<string, unknown> } = {}) {
  signedIn(permissions, opts.role, opts.viewerId);
  if (opts.profile) net.profile = STAFF(opts.profile);
  render(<UserDetailScreen />);
  await screen.findByRole('heading', { level: 1, name: 'موظّفة تأكيد' });
  // the exceptions card asks for the person's permissions when it may be read
  if (permissions.includes('users.view') || opts.role === 'SUPER_ADMIN') await screen.findByText(/^• \d+ استثناء$/);
}

// ───────────────────────────── 1. each press for the keys it was drawn for ─────────────────────────────

describe('each press is drawn for exactly the keys it was (read from the screen’s own userCan lines)', () => {
  it('users.view alone: the way back and nothing that changes the account; every card read-only', async () => {
    await open(['users.view']);
    expect(presses()).toEqual(['عودة للموظفين']);
    expect(mock('phone')?.dataset.edit).toBe('false');
    expect(mock('currency')?.dataset.edit).toBe('false');
    expect(mock('shift')?.dataset.edit).toBe('false');
    expect(mock('salary'), 'الراتب بلا payroll.view').toBeNull();
    expect(mock('score'), 'الأداء بلا team.monitor').toBeNull();
    expect(mock('geo'), 'الوصول بلا geo.manage').toBeNull();
  });

  it('users.edit: «حفظ الدور» and the phone — not the password (that is users.security too), not the exceptions (roles.edit)', async () => {
    await open(['users.view', 'users.edit']);
    expect(presses()).toEqual(['حفظ الدور', 'عودة للموظفين']);
    expect(mock('phone')?.dataset.edit).toBe('true');
    expect(mock('currency')?.dataset.edit, 'عملة العمولة بدها payroll.pay كمان').toBe('false');
    expect(mock('shift')?.dataset.edit, 'الوردية بدها users.shift كمان').toBe('false');
    expect(screen.queryByLabelText('كلمة سرّ جديدة')).toBeNull();
  });

  it('users.security + users.edit: the password card (both presses) and the activation code for an account not yet enrolled', async () => {
    await open(['users.view', 'users.edit', 'users.security']);
    expect(presses()).toEqual(['أصدر رمز تفعيل', 'حفظ الدور', 'عودة للموظفين', 'غيّر كلمة السرّ', 'ولّد واحدة']);
  });

  it('NEGATIVE: users.security without users.edit: the activation code, but no password card', async () => {
    await open(['users.view', 'users.security']);
    expect(presses()).toEqual(['أصدر رمز تفعيل', 'عودة للموظفين']);
  });

  it('users.security on an enrolled account: the reset (folded under «متقدم»), not the activation code', async () => {
    await open(['users.view', 'users.security'], { profile: { totpEnabledAt: '2026-10-01T08:00:00.000Z' } });
    expect(presses()).toEqual(['أعِد ضبط التحقّق بخطوتين', 'عودة للموظفين']);
    expect(screen.getByRole('button', { name: 'أعِد ضبط التحقّق بخطوتين', hidden: true }).closest('details')).not.toBeNull();
  });

  it('NEGATIVE: the owner on his own page gets no password card and no second-code press (NOT_YOURSELF)', async () => {
    await open([], { role: 'SUPER_ADMIN', viewerId: 'u2' });
    expect(presses()).not.toContain('غيّر كلمة السرّ');
    expect(presses()).not.toContain('أصدر رمز تفعيل');
  });

  it('roles.edit: «إضافة استثناء» and «إزالة» — not «حفظ الدور»', async () => {
    await open(['users.view', 'roles.edit']);
    expect(presses()).toEqual(['إزالة', 'إضافة استثناء', 'عودة للموظفين']);
  });

  it('payroll.view shows the salary read-only; payroll.pay lets it be set and paid; the commission currency wants payroll.pay AND users.edit', async () => {
    await open(['users.view', 'payroll.view']);
    expect(mock('salary')?.dataset.edit).toBe('false');
    expect(mock('salary')?.dataset.pay).toBe('false');
    cleanup();
    await open(['users.view', 'payroll.view', 'payroll.pay']);
    expect(mock('salary')?.dataset.edit).toBe('true');
    expect(mock('salary')?.dataset.pay).toBe('true');
    expect(mock('currency')?.dataset.edit).toBe('false');
    cleanup();
    await open(['users.view', 'users.edit', 'payroll.pay']);
    expect(mock('currency')?.dataset.edit).toBe('true');
  });

  it('users.edit + users.shift edit the shift; team.monitor draws the score; geo.manage the access section', async () => {
    await open(['users.view', 'users.edit', 'users.shift', 'team.monitor', 'geo.manage']);
    expect(mock('shift')?.dataset.edit).toBe('true');
    expect(mock('score')).not.toBeNull();
    expect(mock('geo')?.dataset.edit).toBe('true');
  });

  it('NEGATIVE: the server says «not this one» — no role save, no exception press, the access read-only, and the reason written', async () => {
    await open(['users.view', 'users.edit', 'roles.edit', 'geo.manage'], {
      profile: { mayManage: false, manageRefusal: 'هذا الحساب أعلى من دورك' },
    });
    expect(presses()).toEqual(['عودة للموظفين']);
    expect(mock('geo')?.dataset.edit).toBe('false');
    expect(screen.getByText('هذا الحساب أعلى من دورك')).toBeTruthy();
  });
});

// ───────────────────────────── 2. every press sends what it sent on osm/main ─────────────────────────────

describe('every press sends the same URL, method and body as on osm/main', () => {
  it('loading asks the same three doors, in the same order', async () => {
    await open(['users.view']);
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/users/u2/profile',
      'GET /api/roles',
      'GET /api/users/u2/permissions',
    ]);
  });

  it('«حفظ الدور» — by the role row’s id', async () => {
    await open(['users.view', 'users.edit']);
    fireEvent.change(screen.getByLabelText('تغيير الدور'), { target: { value: 'r2' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الدور' }));
    await screen.findByText('تم تحديث الدور بنجاح');
    expect(writes()).toEqual([{ url: '/api/users/u2', method: 'PATCH', body: { action: 'assignRole', roleId: 'r2' } }]);
  });

  it('«غيّر كلمة السرّ» sends the typed one; «ولّد واحدة» sends none', async () => {
    await open(['users.view', 'users.edit', 'users.security']);
    fireEvent.change(screen.getByLabelText('كلمة سرّ جديدة'), { target: { value: 'Typed-Pass-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'غيّر كلمة السرّ' }));
    await screen.findByText('انسخها هلأ — ما رح تنعرض مرّة تانية');
    expect(writes()).toEqual([
      { url: '/api/users/u2', method: 'PATCH', body: { action: 'resetPassword', newPassword: 'Typed-Pass-2026' } },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'انسخ' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Gen3rated-Once-9');
    expect(await screen.findByRole('button', { name: 'اننسخت' })).toBeTruthy();

    cleanup();
    net.calls = [];
    await open(['users.view', 'users.edit', 'users.security']);
    fireEvent.click(screen.getByRole('button', { name: 'ولّد واحدة' }));
    await screen.findByText('انسخها هلأ — ما رح تنعرض مرّة تانية');
    expect(writes()).toEqual([{ url: '/api/users/u2', method: 'PATCH', body: { action: 'resetPassword' } }]);
  });

  it('«أصدر رمز تفعيل» and «أعِد ضبط التحقّق بخطوتين» — bodiless, to their own doors', async () => {
    await open(['users.view', 'users.security']);
    fireEvent.click(screen.getByRole('button', { name: 'أصدر رمز تفعيل' }));
    await screen.findByText(/7Q4KX2/);
    expect(writes()).toEqual([{ url: '/api/users/u2/enrol-code', method: 'POST', body: null }]);

    cleanup();
    net.calls = [];
    await open(['users.view', 'users.security'], { profile: { totpEnabledAt: '2026-10-01T08:00:00.000Z' } });
    fireEvent.click(screen.getByRole('button', { name: 'أعِد ضبط التحقّق بخطوتين', hidden: true }));
    await waitFor(() => expect(writes()).toEqual([{ url: '/api/users/u2/two-factor', method: 'DELETE', body: null }]));
  });

  it('«إزالة» an exception — DELETE on its key', async () => {
    await open(['users.view', 'roles.edit']);
    fireEvent.click(screen.getByRole('button', { name: 'إزالة' }));
    await waitFor(() => expect(writes()).toEqual([{ url: '/api/users/u2/permissions/customers.view_basic', method: 'DELETE', body: null }]));
  });

  it('a grant narrowed to a category: the tick box, the scope and the list sent whole, over the version read', async () => {
    await open([], { role: 'SUPER_ADMIN' });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة استثناء' }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('products.view'))!);
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: 'CATEGORY' } });
    fireEvent.click(await screen.findByLabelText('ساعات'));
    fireEvent.click(screen.getByLabelText('عطور'));
    fireEvent.click(screen.getByLabelText('ساعات')); // and off again: only «عطور» is sent
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/users/u2/permissions',
      method: 'PUT',
      body: {
        overrides: [
          { permission: 'customers.view_basic', effect: 'ALLOW', scope: 'ALL_COMPANY' },
          { permission: 'products.view', effect: 'ALLOW', scope: 'CATEGORY', scopeIds: ['c1'] },
        ],
        version: 7,
      },
    });
  });

  it('a grant narrowed to products: picked from the search, one taken off its chip, the rest sent', async () => {
    await open([], { role: 'SUPER_ADMIN' });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة استثناء' }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('products.view'))!);
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: 'SPECIFIC' } });
    const first = await screen.findByRole('button', { name: /عطر ليلي/ }, { timeout: 2000 });
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: /ساعة/ }));
    expect((screen.getByRole('button', { name: /عطر ليلي/ }) as HTMLButtonElement).disabled, 'a picked product cannot be picked twice').toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'أزل من النطاق' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({
      overrides: [
        { permission: 'customers.view_basic', effect: 'ALLOW', scope: 'ALL_COMPANY' },
        { permission: 'products.view', effect: 'ALLOW', scope: 'SPECIFIC', scopeIds: ['p1'] },
      ],
      version: 7,
    });
  });

  it('NEGATIVE: unticking «تخصيص نطاق الوصول» puts the scope back to the whole company before the save', async () => {
    await open([], { role: 'SUPER_ADMIN' });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة استثناء' }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('products.view'))!);
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: 'CATEGORY' } });
    fireEvent.click(await screen.findByLabelText('عطور'));
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({
      overrides: [
        { permission: 'customers.view_basic', effect: 'ALLOW', scope: 'ALL_COMPANY' },
        { permission: 'products.view', effect: 'ALLOW', scope: 'ALL_COMPANY' },
      ],
      version: 7,
    });
  });
});

// ───────────────────────────── 3. the secret ─────────────────────────────

describe('the new password is a secret', () => {
  it('opens empty, and what is typed is printed nowhere but its own box', async () => {
    await open(['users.view', 'users.edit', 'users.security']);
    const box = screen.getByLabelText('كلمة سرّ جديدة') as HTMLInputElement;
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'weak' } });
    expect(document.body.textContent).not.toContain('weak');
    // Its own `value` is where it belongs; any other attribute — its own title included — is an echo.
    const attrs = [...document.querySelectorAll('*')].flatMap((el) =>
      [...el.attributes].filter((a) => !(el === box && a.name === 'value')).map((a) => a.value),
    );
    expect(attrs.filter((v) => v.includes('weak'))).toEqual([]);
    expect((screen.getByRole('button', { name: 'غيّر كلمة السرّ' }) as HTMLButtonElement).disabled, 'a weak one is not sent').toBe(true);
  });

  it('after the change the typed one is gone from the page', async () => {
    await open(['users.view', 'users.edit', 'users.security']);
    fireEvent.change(screen.getByLabelText('كلمة سرّ جديدة'), { target: { value: 'Typed-Pass-2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'غيّر كلمة السرّ' }));
    await screen.findByText('انسخها هلأ — ما رح تنعرض مرّة تانية');
    expect(document.body.innerHTML).not.toContain('Typed-Pass-2026');
  });
});

// ───────────────────────────── 4. the kit, and a phone ─────────────────────────────

describe('the kit, and a phone', () => {
  it('one h1 — the person’s name, as before — and the email under it', async () => {
    await open(['users.view']);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['موظّفة تأكيد']);
    expect(screen.getByText('staff@example.test')).toBeTruthy();
  });

  it('the way back goes to the staff list', async () => {
    await open(['users.view']);
    fireEvent.click(screen.getByRole('button', { name: 'عودة للموظفين' }));
    expect(nav.push).toEqual(['/admin/users']);
  });

  it('no fixed width wider than a phone, and the effective table goes through Rows', async () => {
    await open(['users.view']);
    const fixed = new RegExp(['(^|\\s)(min-)?w-\\[\\d+', 'px\\]'].join(''));
    const wide = [...document.querySelectorAll('[class]')].filter((el) => fixed.test(el.getAttribute('class') ?? ''));
    expect(wide).toEqual([]);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
    // The frame caps nothing: a phone is its full width.
    const frame = screen.getByRole('heading', { level: 1 }).closest('header')!.parentElement!;
    expect(frame.className).not.toMatch(new RegExp('max' + '-w-'));
  });

  it('the tick boxes of the exception dialog carry their own ids, and each label ticks only its own box', async () => {
    await open([], { role: 'SUPER_ADMIN' });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة استثناء' }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('products.view'))!);
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: 'CATEGORY' } });
    await screen.findByLabelText('عطور');
    const boxes = [...document.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const ids = boxes.map((b) => b.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    fireEvent.click(screen.getByText('عطور'));
    expect(boxes.filter((b) => b.checked).map((b) => b.id)).toEqual([(screen.getByLabelText('تخصيص نطاق الوصول') as HTMLInputElement).id, (screen.getByLabelText('عطور') as HTMLInputElement).id]);
  });

  it('the dialog’s nested boxes are plain cards: no page decoration inside a dialog', async () => {
    await open([], { role: 'SUPER_ADMIN' });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة استثناء' }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('products.view'))!);
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: 'CATEGORY' } });
    const box = (await screen.findByLabelText('عطور')).closest('[class*="rounded-lg"][class*="border"]') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.classList.contains(CARD_CLASS)).toBe(false);
  });

  it('the chip’s remove press has an Arabic name of its own', async () => {
    await open([], { role: 'SUPER_ADMIN' });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة استثناء' }));
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.includes('products.view'))!);
    fireEvent.click(screen.getByLabelText('تخصيص نطاق الوصول'));
    fireEvent.change(screen.getByLabelText('النطاق'), { target: { value: 'SPECIFIC' } });
    fireEvent.click(await screen.findByRole('button', { name: /عطر ليلي/ }, { timeout: 2000 }));
    const remove = screen.getByRole('button', { name: 'أزل من النطاق' });
    expect(within(remove).queryByText(/[a-z]/i)).toBeNull();
  });
});
