// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الصلاحيات» ON THE KIT (R16c, 18/11) — WHAT THE NEW PARTS MUST STILL DO
 *
 * The differential beside this file proves every request is the one main sent. This one proves what a request cannot
 * show: the frame's name is the menu's; every box has an id of its own, built from the role AND the key, so its
 * words tick it and no other box (a matrix repeats names, and a label pointing at a shared id ticks the wrong one);
 * each button is drawn for exactly the keys it was; R7's roles panel is still mounted once and still answers its
 * presses; and at a phone's 375px nothing is wider than the phone and the matrix scrolls inside its window.
 * Nothing behind the sign-in can be opened in a browser here (every account has a second factor only the owner holds),
 * so this is a render of the real screen against a fake door.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  user: { current: { id: 'u0', role: 'SUPER_ADMIN', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
  roles: [] as Record<string, unknown>[],
  maySetRoleBase: false,
  api: [] as Array<{ url: string; method: string; body?: string }>,
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/permissions', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn(), useAsk: () => vi.fn() }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', isRtl: true, t: {}, currentUser: h.user.current }) }));
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    h.api.push({ url, method: init?.method ?? 'GET', body: init?.body });
    if (url === '/api/nav/arrangement') return { maySetRoleBase: h.maySetRoleBase, roleBase: null };
    if (url === '/api/roles') return { roles: [{ id: 'r1', name: 'دور تجربة' }] };
    return {};
  }),
  apiFetch: vi.fn(),
}));

import { PermissionsScreen } from './PermissionsScreen';
import { routeLabel } from '@/lib/route-registry';
import { dependentsOf, requiredChain } from '@/lib/permission-catalog';

const V = '2026-11-18T10:00:00.000Z';
const role = (over: Record<string, unknown>) => ({
  id: 'r1', companyId: 'co1', name: 'دور تجربة', isSystem: false, createdAt: V, updatedAt: V, usersCount: 0, permissionsCount: 0,
  permissions: [] as unknown[], ...over,
});
const ROLES = () => [
  role({}),
  role({ id: 't1', companyId: null, name: 'MANAGER', isSystem: true }),
  role({ id: 's1', companyId: null, name: 'SUPER_ADMIN', isSystem: true }),
];

beforeEach(() => {
  h.user.current = { id: 'u0', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' };
  h.roles = ROLES();
  h.maySetRoleBase = false;
  h.api = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
      if (url.includes('/default')) return ok({ available: false });
      if (url.startsWith('/api/categories')) return ok({ categories: [{ id: 'c1', name: 'عطور' }, { id: 'c2', name: 'ساعات' }] });
      if (url.startsWith('/api/products')) return ok({ products: [{ id: 'p1', name: 'منتج طويل الاسم جداً للتجربة على شاشة الهاتف' }] });
      return ok({ roles: h.roles });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const named = (words: string) => new RegExp(`^\\s*${words}\\s*$`);
async function openRole(user: User, name = 'دور تجربة', nth = 0) {
  await screen.findByText(name);
  await user.click(screen.getAllByRole('button', { name: named('تعديل') })[nth]);
  await screen.findByText('حفظ التغييرات');
}
const section = async (user: User, heading: string) => user.click(await screen.findByRole('button', { name: new RegExp(`^${heading}`) }));
const boxesIn = (el: HTMLElement) => within(el).getAllByRole('checkbox') as HTMLInputElement[];
// Built from pieces: Tailwind reads tests too, and a whole arbitrary-width token written here would grow the stylesheet.
const ARBITRARY_WIDTH = new RegExp('(?:^|\\s)(?:min-)?w' + '-\\[(\\d+)px\\]', 'g');
/** The key a matrix box stands for, read from its own words (the mono key printed beside the Arabic). */
const keyOf = (b: HTMLInputElement) => b.labels?.[0]?.textContent?.match(/[a-z_]+\.[a-z_]+/)?.[0] ?? '';

describe('the frame', () => {
  it('is the menu\'s name for the screen, in the one page heading', async () => {
    render(<PermissionsScreen />);
    // The whole heading, not a part of it: «الأدوار والصلاحيات» (the hand-typed name it carried) also contains «الصلاحيات».
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(routeLabel('/admin/permissions'));
    expect(routeLabel('/admin/permissions')).toBe('الصلاحيات');
  });

  it('and R7\'s roles panel is mounted once inside it — and for its holder it still draws and answers', async () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/PermissionsScreen.tsx'), 'utf8');
    expect(src.match(/<RoleMenuPanel \/>/g)).toHaveLength(1);
    h.maySetRoleBase = true;
    render(<PermissionsScreen />);
    const picker = (await screen.findByLabelText('الدور')) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual(['اختر دور', 'دور تجربة']));
    // Picking a role and arranging its menu, phone bar and look is R7's own test
    // (the-menu-groups-and-the-phones-four-can-be-arranged), drawn from this same screen and run green with it.
    expect(screen.getByText('قائمة كل دور')).toBeTruthy();
  });

  it('NEGATIVE: for whoever the door refuses, the panel draws nothing', async () => {
    render(<PermissionsScreen />);
    await screen.findByText('دور تجربة');
    expect(screen.queryByText('قائمة كل دور')).toBeNull();
  });
});

describe('every box is its own', () => {
  it('ids are the role AND the key, unique on the page, and each label points at its own box', async () => {
    const user = userEvent.setup();
    render(<PermissionsScreen />);
    await openRole(user);
    await section(user, 'الطلبات');
    await section(user, 'المنتجات');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /products\.view/ }));
    await user.selectOptions(within(dialog).getAllByRole('combobox')[0], 'CATEGORY');
    await within(dialog).findByRole('checkbox', { name: 'عطور' });

    const all = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const ids = all.map((b) => b.id);
    expect(ids.every(Boolean), 'مربع بلا id').toBe(true);
    expect(new Set(ids).size, 'id مكرر').toBe(ids.length);
    for (const b of all) {
      expect(document.querySelectorAll(`label[for="${b.id}"]`).length, b.id).toBe(1);
      expect(b.labels?.[0]?.control, b.id).toBe(b);
    }
    const matrix = all.filter((b) => keyOf(b));
    expect(matrix.length).toBeGreaterThan(5);
    for (const b of matrix) expect(b.id).toBe(`perm-r1-${keyOf(b)}`);
    expect((within(dialog).getByRole('checkbox', { name: 'عطور' }) as HTMLInputElement).id).toBe('perm-r1-products.view-category-c1');
  });

  it('NEGATIVE: the same key in two roles is two ids — a new role\'s box is not the edited role\'s', async () => {
    const user = userEvent.setup();
    render(<PermissionsScreen />);
    await screen.findByText('دور تجربة');
    await user.click(screen.getByRole('button', { name: /دور جديد/ }));
    await section(user, 'الطلبات');
    expect((screen.getByRole('checkbox', { name: /orders\.view/ }) as HTMLInputElement).id).toBe('perm-new-orders.view');
  });

  it('clicking each label of «الطلبات» ticks its own box and only what the key needs or what needs it — never the opposite', async () => {
    const user = userEvent.setup();
    render(<PermissionsScreen />);
    await openRole(user);
    await section(user, 'الطلبات');
    const dialog = screen.getByRole('dialog');
    const keys = boxesIn(dialog).map(keyOf);
    for (const key of keys) {
      const now = () => new Map(boxesIn(dialog).map((b) => [keyOf(b), b.checked] as const));
      const before = now();
      const b = boxesIn(dialog).find((x) => keyOf(x) === key)!;
      await user.click(b.labels![0].querySelector('span')!);
      const after = now();
      const changed = [...after].filter(([k, v]) => before.get(k) !== v).map(([k]) => k);
      expect(after.get(key), `${key}: انعكس عكس المطلوب`).toBe(!before.get(key));
      const allowed = new Set([key, ...(before.get(key) ? dependentsOf(key) : requiredChain(key))]);
      for (const k of changed) expect(allowed.has(k), `${key} غيّر ${k}`).toBe(true);
    }
  });
});

describe('each button is drawn for exactly the keys it was', () => {
  const as = (...keys: string[]) => { h.user.current = { id: 'u1', role: 'CUSTOM', permissions: keys, status: 'ACTIVE' }; };
  const count = (words: string) => screen.queryAllByRole('button', { name: named(words) }).length;
  const cases: Array<{ keys: string[]; edit: number; create: number; copy: number; del: number; lockedSentence: boolean }> = [
    { keys: ['roles.view'], edit: 0, create: 0, copy: 0, del: 0, lockedSentence: false },
    { keys: ['roles.view', 'roles.edit'], edit: 1, create: 0, copy: 0, del: 0, lockedSentence: true },
    { keys: ['roles.view', 'roles.edit', 'roles.edit_system'], edit: 2, create: 0, copy: 0, del: 0, lockedSentence: false },
    { keys: ['roles.view', 'roles.create'], edit: 0, create: 1, copy: 2, del: 0, lockedSentence: false },
    { keys: ['roles.view', 'roles.delete'], edit: 0, create: 0, copy: 0, del: 1, lockedSentence: false },
  ];
  for (const c of cases) {
    it(`${c.keys.join(' + ')}`, async () => {
      as(...c.keys);
      render(<PermissionsScreen />);
      await screen.findByText('MANAGER');
      expect(count('تعديل')).toBe(c.edit);
      expect(count('دور جديد')).toBe(c.create);
      expect(count('نسخ')).toBe(c.copy);
      expect(count('حذف')).toBe(c.del);
      expect(!!screen.queryByText(/تعديل الأدوار الأساسية يحتاج صلاحية/)).toBe(c.lockedSentence);
      // The owner's role is read-only for everybody.
      expect(screen.getByText('قراءة فقط')).toBeTruthy();
    });
  }
});

describe('a phone at 375px', () => {
  it('nothing in the screen or the open matrix is wider than the phone, and the matrix scrolls inside its window', async () => {
    const user = userEvent.setup();
    render(<PermissionsScreen />);
    await openRole(user);
    await section(user, 'المنتجات');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /products\.view/ }));
    await user.selectOptions(within(dialog).getAllByRole('combobox')[0], 'SPECIFIC');
    await within(dialog).findByRole('button', { name: /منتج طويل الاسم/ }, { timeout: 3000 });

    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>('[class]'))) {
      const cls = el.getAttribute('class') ?? '';
      for (const m of cls.matchAll(ARBITRARY_WIDTH)) expect(Number(m[1]), cls).toBeLessThanOrEqual(375);
      for (const m of cls.matchAll(/(?:^|\s)(?:min-)?w-(\d+)(?:\s|$)/g)) expect(Number(m[1]) * 4, cls).toBeLessThanOrEqual(375);
    }
    const body = dialog.querySelector<HTMLElement>('[data-modal-body]')!;
    expect(body.className).toMatch(/overflow-y-auto/);
    expect(body.contains(within(dialog).getByRole('checkbox', { name: /products\.view/ }))).toBe(true);
    // The product list scrolls inside its own box too.
    const list = within(dialog).getByRole('button', { name: /منتج طويل الاسم/ }).parentElement!;
    expect(list.className).toMatch(/max-h-36/);
    expect(list.className).toMatch(/overflow-y-auto/);
  });
});
