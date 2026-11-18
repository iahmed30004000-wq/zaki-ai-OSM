// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الصلاحيات» ON THE KIT SENDS, BYTE FOR BYTE, WHAT IT SENT (R16c, 18/11)
 *
 * The matrix is where a wrong tick grants or removes a door. Moving its boxes onto the kit (`Checkbox` with an id
 * built from the role and the key) and the screen into `PageShell` must not change ONE request. So the screen as it
 * stood on main — a frozen copy beside this file, `PermissionsScreen.as-on-main.test.tsx` — and the live screen are
 * driven through the SAME scripted presses against the same fake door, and every request each one makes (method, URL
 * and the body exactly as the string that would leave the browser) must be the same list. Twelve scripts: one key, a
 * whole section, a scope change, categories, chosen products, undo, the defaults, a new role, a duplicate, a delete with
 * and without a replacement, a refused save, and the protected roles (the owner's role and a base role without the
 * key that edits base roles) with a retired key in the stored list.
 *
 * And because each script also counts what is on the screen (buttons, tick boxes, lists, text fields) just before
 * the last press, a control that went missing — or a second one that appeared — fails here too.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  user: { current: { id: 'u0', role: 'SUPER_ADMIN', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
  roles: [] as Record<string, unknown>[],
  defaults: null as null | Array<{ permission: string; scope: string }>,
  categories: [] as Array<{ id: string; name: string }>,
  products: [] as Array<{ id: string; name: string; nameEn?: string }>,
  write: { status: 200, body: { success: true } as Record<string, unknown> },
  calls: [] as string[],
}));

vi.mock('next/navigation', () => ({ usePathname: () => '/admin/permissions', useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn(), useAsk: () => vi.fn() }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ locale: 'ar', isRtl: true, t: {}, currentUser: h.user.current }),
}));
// R7's panel talks through apiJson; here it is told the person may not set a role's base, so it draws nothing in
// either copy and the matrix's own requests are the whole log. Its presses are proven in the kit test beside this one.
vi.mock('@/lib/api-client', () => ({
  apiJson: vi.fn(async (url: string) => (url === '/api/nav/arrangement' ? { maySetRoleBase: false } : { roles: [] })),
  apiFetch: vi.fn(),
}));

import { PermissionsScreen as Live } from './PermissionsScreen';
import { PermissionsScreen as OnMain } from './PermissionsScreen.as-on-main.test';

const V = '2026-11-18T10:00:00.000Z';
const role = (over: Record<string, unknown>) => ({
  id: 'r1', companyId: 'co1', name: 'دور تجربة', isSystem: false, createdAt: V, updatedAt: V, usersCount: 0, permissionsCount: 0,
  permissions: [] as Array<{ permission: string; scope: string; scopeIds?: unknown }>,
  ...over,
});
const holding = (...keys: string[]) => keys.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: [] }));

function door() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      // The body exactly as the string that leaves the browser: key order and all.
      h.calls.push(`${method} ${url} ${init?.body ?? ''}`);
      const ok = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body });
      if (method !== 'GET') return ok(h.write.body, h.write.status);
      if (url.includes('/default')) return ok(h.defaults ? { available: true, permissions: h.defaults } : { available: false });
      if (url.startsWith('/api/categories')) return ok({ categories: h.categories });
      if (url.startsWith('/api/products')) return ok({ products: h.products });
      return ok({ roles: h.roles });
    })
  );
}

beforeEach(() => {
  h.user.current = { id: 'u0', role: 'SUPER_ADMIN', permissions: [], status: 'ACTIVE' };
  h.roles = [role({})];
  h.defaults = null;
  h.categories = [];
  h.products = [];
  h.write = { status: 200, body: { success: true } };
  h.calls = [];
  door();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
type Script = (user: User) => Promise<void>;

/** What is on the screen, by kind: the count a lost or a doubled control changes. */
function census() {
  const n = (r: string) => screen.queryAllByRole(r).length;
  return { buttons: n('button'), checkboxes: n('checkbox'), lists: n('combobox'), fields: n('textbox') };
}

const box = (name: RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
/** The one button carrying these words (the matrix's sections, a row's actions, the dialogs' presses). */
async function press(user: User, words: string | RegExp, nth = 0) {
  const re = typeof words === 'string' ? new RegExp(`^\\s*${words}\\s*$`) : words;
  await waitFor(() => expect(screen.getAllByRole('button', { name: re }).length).toBeGreaterThan(nth));
  await user.click(screen.getAllByRole('button', { name: re })[nth]);
}
async function openRole(user: User, name = 'دور تجربة') {
  await screen.findByText(name);
  await press(user, 'تعديل');
  await screen.findByText('حفظ التغييرات');
}
const section = (user: User, heading: string) => press(user, new RegExp(`^${heading}`));
/** The scope lists of the open matrix, in the order of their rows. */
const scopes = () => within(screen.getByRole('dialog')).getAllByRole('combobox') as HTMLSelectElement[];
const save = (user: User) => press(user, 'حفظ التغييرات');
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/**
 * Draw `Screen`, run the script, and return every request and the census taken before the last press.
 * The script ends by calling `last()` with the final press, so the census is taken at the same moment in both runs.
 */
async function run(Screen: React.ComponentType, script: (user: User, last: (p: () => Promise<void>) => Promise<void>) => Promise<void>) {
  h.calls = [];
  const user = userEvent.setup();
  render(<Screen />);
  let seen: ReturnType<typeof census> | null = null;
  await script(user, async (p) => {
    seen = census();
    await p();
  });
  await settle();
  const calls = [...h.calls];
  cleanup();
  return { calls, seen };
}

async function same(script: Parameters<typeof run>[1], expectWrite: RegExp) {
  const before = await run(OnMain, script);
  const after = await run(Live, script);
  // Not a vacuous comparison: the script reached the door with the request it was written for.
  expect(before.calls.some((c) => expectWrite.test(c)), `ما وصل الطلب ${expectWrite} بنسخة main:\n${before.calls.join('\n')}`).toBe(true);
  expect(after.calls).toEqual(before.calls);
  expect(after.seen).not.toBeNull();
  expect(after.seen).toEqual(before.seen);
  return after.calls;
}

describe('the live matrix sends exactly what the matrix on main sent', () => {
  it('1 · one key: an action ticks its screen key with it, and the save carries both over the version read', async () => {
    const sent = await same(async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      await user.click(box(/orders\.edit\b/));
      await last(() => save(user));
    }, /^PATCH \/api\/roles\/r1 /);
    expect(sent.find((c) => c.startsWith('PATCH'))).toContain('"version":"2026-11-18T10:00:00.000Z"');
  });

  it('2 · a whole section: every box of «الطلبات» ticked one by one, cascades and all', async () => {
    await same(async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      const dialog = screen.getByRole('dialog');
      const count = within(dialog).getAllByRole('checkbox').length;
      for (let i = 0; i < count; i++) {
        const b = within(dialog).getAllByRole('checkbox')[i] as HTMLInputElement;
        if (!b.checked) await user.click(b);
      }
      await last(() => save(user));
    }, /^PATCH \/api\/roles\/r1 /);
  });

  it('3 · a scope change: the view narrowed to «المسندة إليه», the action to «طلباتي المنشأة»', async () => {
    h.roles = [role({ permissions: holding('orders.view') })];
    await same(async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      await user.selectOptions(scopes()[0], 'ASSIGNED');
      await user.click(box(/orders\.edit\b/));
      await user.selectOptions(scopes()[1], 'OWN');
      await last(() => save(user));
    }, /"scope":"OWN"/);
  });

  it('4 · categories: the products key narrowed to two categories, one taken off again', async () => {
    h.categories = [{ id: 'c1', name: 'عطور' }, { id: 'c2', name: 'ساعات' }, { id: 'c3', name: 'حقائب' }];
    await same(async (user, last) => {
      await openRole(user);
      await section(user, 'المنتجات');
      await user.click(box(/products\.view/));
      await user.selectOptions(scopes()[0], 'CATEGORY');
      await user.click(await screen.findByRole('checkbox', { name: 'ساعات' }));
      await user.click(screen.getByRole('checkbox', { name: 'عطور' }));
      await user.click(screen.getByRole('checkbox', { name: 'حقائب' }));
      await user.click(screen.getByRole('checkbox', { name: 'ساعات' }));
      await last(() => save(user));
    }, /"scopeIds":\["c1","c3"\]/);
  });

  it('5 · chosen products: a search, two picks, «تحميل المزيد», a third pick, one chip taken off', async () => {
    h.products = Array.from({ length: 12 }, (_, i) => ({ id: `p${i + 1}`, name: `منتج ${i + 1}` }));
    await same(async (user, last) => {
      await openRole(user);
      await section(user, 'المنتجات');
      await user.click(box(/products\.view/));
      await user.selectOptions(scopes()[0], 'SPECIFIC');
      await user.type(screen.getByPlaceholderText('ابحث عن منتج بالاسم…'), 'منتج');
      await press(user, 'منتج 2');
      await press(user, 'منتج 5');
      // A second press on a picked product adds nothing.
      await press(user, 'منتج 2');
      await press(user, 'تحميل المزيد');
      await press(user, 'منتج 11');
      await press(user, 'أزل من النطاق', 0);
      await last(() => save(user));
    }, /"scopeIds":\["p5","p11"\]/);
  });

  it('6 · undo: the screen key taken off takes its action with it, and put back alone', async () => {
    h.roles = [role({ permissions: holding('orders.view', 'orders.edit') })];
    await same(async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      await user.click(box(/orders\.view/));
      await user.click(box(/orders\.view/));
      await last(() => save(user));
    }, /"permissions":\[\{"permission":"orders\.view"/);
  });

  it('7 · the defaults: loaded into the draft with the view their action needs, then saved', async () => {
    h.defaults = [{ permission: 'orders.edit', scope: 'OWN' }, { permission: 'analytics.view', scope: 'ALL_COMPANY' }];
    await same(async (user, last) => {
      await openRole(user);
      await press(user, /^\s*إرجاع للافتراضي\s*$/);
      await screen.findByText(/تم تحميل الصلاحيات الافتراضية/);
      await last(() => save(user));
    }, /orders\.view/);
  });

  it('8 · a new role: its name, a key from the search box, created with POST', async () => {
    await same(async (user, last) => {
      await screen.findByText('دور تجربة');
      await press(user, 'دور جديد');
      await user.type(screen.getByPlaceholderText('مثال: موظف تأكيد الطلبات'), 'دور جديد للتجربة');
      await user.type(screen.getByPlaceholderText('بحث في الصلاحيات…'), 'customers');
      await section(user, 'العملاء');
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('checkbox')[0]);
      await last(() => press(user, 'إنشاء الدور'));
    }, /^POST \/api\/roles \{"name":"دور جديد للتجربة"/);
  });

  it('9 · a duplicate: the window opens with the copy\'s name and POSTs to the role\'s duplicate door', async () => {
    await same(async (user, last) => {
      await screen.findByText('دور تجربة');
      await press(user, 'نسخ');
      await screen.findByDisplayValue('دور تجربة (نسخة)');
      await last(() => press(user, 'نسخ', 1));
    }, /^POST \/api\/roles\/r1\/duplicate $/);
  });

  it('10 · a delete: refused until a replacement is picked, then DELETE with it in the address', async () => {
    h.roles = [role({ usersCount: 3 }), role({ id: 'r2', name: 'دور بديل' })];
    await same(async (user, last) => {
      await screen.findByText('دور تجربة');
      await press(user, 'حذف');
      await press(user, 'حذف نهائي');
      await screen.findByText('اختر دورًا بديلًا أولًا');
      await user.selectOptions(within(screen.getByRole('dialog')).getByRole('combobox'), 'r2');
      await last(() => press(user, 'حذف نهائي'));
    }, /^DELETE \/api\/roles\/r1\?replacementRoleId=r2 $/);
  });

  it('11 · a refused save (409): the roles are read again, and the window stays open', async () => {
    h.write = { status: 409, body: { error: 'تغيّر الدور من شاشة ثانية' } };
    await same(async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      await user.click(box(/orders\.view/));
      await last(async () => {
        await save(user);
        await screen.findByText('تغيّر الدور من شاشة ثانية');
      });
    }, /^PATCH \/api\/roles\/r1 /);
  });

  it('12 · the protected roles: the owner\'s role and a base role draw no «تعديل», and a retired key never leaves', async () => {
    h.user.current = { id: 'u1', role: 'CUSTOM', permissions: ['roles.view', 'roles.edit', 'roles.create', 'roles.delete'], status: 'ACTIVE' };
    h.roles = [
      role({ id: 's1', companyId: null, name: 'SUPER_ADMIN', isSystem: true }),
      role({ id: 't1', companyId: null, name: 'MANAGER', isSystem: true }),
      role({ permissions: [...holding('orders.view'), { permission: 'analytics.view', scope: 'ALL_COMPANY' }] }),
    ];
    const sent = await same(async (user, last) => {
      await screen.findByText('MANAGER');
      expect(screen.getAllByRole('button', { name: /^\s*تعديل\s*$/ })).toHaveLength(1);
      await openRole(user);
      await last(() => save(user));
    }, /^PATCH \/api\/roles\/r1 /);
    expect(sent.find((c) => c.startsWith('PATCH'))).not.toContain('analytics.view');
  });
});

describe('NEGATIVE: the comparison is not blind', () => {
  it('a different press in one run is caught — the same script with one box more does not match', async () => {
    const one = await run(Live, async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      await user.click(box(/orders\.view/));
      await last(() => save(user));
    });
    const two = await run(Live, async (user, last) => {
      await openRole(user);
      await section(user, 'الطلبات');
      await user.click(box(/orders\.view/));
      await user.click(box(/orders\.edit\b/));
      await last(() => save(user));
    });
    expect(two.calls).not.toEqual(one.calls);
  });

  it('and the copy really is the screen as it was: its boxes are bare inputs with no id, the live ones are not', async () => {
    const user = userEvent.setup();
    render(<OnMain />);
    await openRole(user);
    await section(user, 'الطلبات');
    expect(box(/orders\.view/).id).toBe('');
    cleanup();
    render(<Live />);
    await openRole(user);
    await section(user, 'الطلبات');
    expect(box(/orders\.view/).id).not.toBe('');
    fireEvent.click(document.body);
  });
});
