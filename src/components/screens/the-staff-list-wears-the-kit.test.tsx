// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «الموظفين» ON THE KIT (R16a, plan 17/11 — written 18/11).
 *
 * The list and the «موظف جديد» form moved onto `PageShell`, `Button`/`IconButton`, `Card plain` and `Checkbox`.
 * What must NOT have moved with them:
 *   - every press is drawn for exactly the keys it was (`users.create`, `users.edit`, the owner's «عاين كـ»);
 *   - every press sends the same request: the list query, the four status bodies, the create body, byte for byte;
 *   - the password box opens empty and its value is never printed;
 *   - each tick has its own id, so a label toggles its own box and no other.
 * Every claim has a negative twin, so a wrong key, a wrong body or a shared id turns it red.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`,
 * no fixed pixel width, the list through `Rows` with its phone cards), and the pull request says so.
 */

const { app, preview, profile } = vi.hoisted(() => ({
  app: { value: {} as Record<string, unknown> },
  preview: { drawn: 0 },
  profile: { value: { mayManage: true } as { mayManage?: boolean; manageRefusal?: string } },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin/users',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => app.value }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock('@/components/shell/PreviewAs', () => ({
  PreviewPicker: () => {
    preview.drawn++;
    return <div data-testid="preview-picker" />;
  },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: vi.fn(async () => profile.value) }));

import { UsersScreen } from './UsersScreen';
import { CreateUserModal } from './users/CreateUserModal';
import { routeLabel } from '@/lib/route-registry';

const WAIT = { timeout: 8000 };
vi.setConfig({ testTimeout: 15000 });

const PAGE = { total: 2, page: 1, limit: 25, totalPages: 1 };
const PERSON = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  name: 'موظفة التجربة',
  email: 'one@example.test',
  role: 'CONFIRMATION_AGENT',
  status: 'ACTIVE',
  createdAt: '2026-10-01T00:00:00.000Z',
  lastLoginAt: null,
  totpEnabledAt: null,
  assignedBy: null,
  ...over,
});

let sent: { url: string; method: string; body: string | undefined }[] = [];
let users: unknown[] = [];
const COUNTRIES = [
  { id: 'c1', name: 'البلد الأول', code: 'AA', stores: [{ id: 's1', name: 'متجر أ', status: 'ACTIVE' }, { id: 's2', name: 'متجر ب', status: 'ACTIVE' }] },
  { id: 'c2', name: 'البلد التاني', code: 'BB', stores: [{ id: 's3', name: 'متجر ج', status: 'ACTIVE' }] },
];
const ROLES = [
  { id: 'r-owner', name: 'SUPER_ADMIN' },
  { id: 'r-agent', name: 'CONFIRMATION_AGENT' },
];

beforeEach(() => {
  sent = [];
  users = [PERSON()];
  preview.drawn = 0;
  profile.value = { mayManage: true };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      sent.push({ url: String(url), method, body: init?.body });
      const u = String(url);
      if (method !== 'GET') return { ok: true, json: async () => ({ user: { id: 'new-1', name: 'جديد' } }) } as any;
      if (u.startsWith('/api/users/grades')) return { ok: false, json: async () => ({}) } as any;
      if (u.startsWith('/api/users')) return { ok: true, json: async () => ({ users, pagination: PAGE }) } as any;
      if (u === '/api/roles') return { ok: true, json: async () => ({ roles: ROLES }) } as any;
      if (u === '/api/geo/countries') return { ok: true, json: async () => ({ countries: COUNTRIES }) } as any;
      return { ok: true, json: async () => ({}) } as any;
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const signedIn = (role: string, ...permissions: string[]) => {
  app.value = { currentUser: { id: 'me', role, permissions }, t: { cancel: 'إلغاء' }, locale: 'ar' };
};
/** The desk table — `Rows` also draws the same row as a phone card, so a desk question is asked inside the table. */
const table = async () => (await screen.findByRole('table', { hidden: true }, WAIT)) as HTMLElement;
const listQueries = () => sent.filter((s) => s.method === 'GET' && /^\/api\/users\?/.test(s.url)).map((s) => s.url);
const patches = () => sent.filter((s) => s.method === 'PATCH');

describe('the frame', () => {
  it('draws ONE heading, the menu’s name, and the filters directly under it, inside the frame', async () => {
    signedIn('COMPANY_ADMIN', 'users.view');
    const { container } = render(<UsersScreen />);
    await table();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain(routeLabel('/admin/users'));
    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toContain('min-w-0');
    expect(root.className, 'الإطار صار بعرض محدود').not.toMatch(/max-w-/);
    // the filter row is the frame's second block: the header, then the filters — before the list
    const search = screen.getByPlaceholderText('بحث بالاسم أو البريد الإلكتروني...');
    const filterBlock = root.children[1] as HTMLElement;
    expect(filterBlock.contains(search), 'البحث مش بخانة الفلاتر تبع الإطار').toBe(true);
    expect(filterBlock.contains(screen.getByRole('table', { hidden: true }))).toBe(false);
  });

  it('a phone gets no fixed pixel width anywhere, and the list is drawn through Rows (a table AND its phone cards)', async () => {
    signedIn('COMPANY_ADMIN', 'users.view', 'users.edit');
    const { container } = render(<UsersScreen />);
    await table();
    // built from pieces: Tailwind reads tests too, and a whole class-like token here would grow the sheet
    const pixelWidth = new RegExp('(^|\\s)(min-)?w' + '-\\[\\d+px\\]');
    const fixed = Array.from(container.querySelectorAll<HTMLElement>('[class]')).filter((el) =>
      pixelWidth.test(el.getAttribute('class') ?? '')
    );
    expect(fixed, 'عرض ثابت بالبكسل').toEqual([]);
    expect(container.querySelector('ul li'), 'ما في بطاقات الهاتف').not.toBeNull();
  });

  it('the surfaces are the kit’s plain card (no page ornament), and no 12px body text is left', async () => {
    signedIn('SUPER_ADMIN');
    users = [PERSON({ status: 'PENDING' })];
    const { container } = render(<UsersScreen />);
    const desk = await table();
    const search = screen.getByPlaceholderText('بحث بالاسم أو البريد الإلكتروني...');
    const filterCard = search.closest('div.grid') as HTMLElement;
    expect(filterCard.className).toContain('bg-[var(--sys-card)]');
    expect(filterCard.className, 'صف الفلاتر لابس زخرفة الصفحة').not.toContain('zk-card');
    fireEvent.click(within(desk).getByRole('button', { name: /إدارة/, hidden: true }));
    const status = await screen.findByText('حالة الحساب', { selector: 'h4' }, WAIT);
    const box = status.parentElement as HTMLElement;
    expect(box.className).toContain('bg-[var(--sys-card)]');
    expect(box.className).not.toContain('zk-card');
    const small = 'text' + '-xs';
    const own = [status, screen.getByText(/ينهي جميع الجلسات النشطة فوراً/)];
    for (const el of own) expect(el.className.split(/\s+/)).not.toContain(small);
    expect(container).toBeTruthy();
  });
});

describe('each press is drawn for exactly the keys it was', () => {
  it('users.view only: the list, its refresh and «صفحة الموظف» — no «موظف جديد», no «إدارة», no «عاين كـ»', async () => {
    signedIn('COMPANY_ADMIN', 'users.view');
    render(<UsersScreen />);
    const desk = await table();
    expect(screen.getByRole('button', { name: 'تحديث القائمة', hidden: true })).toBeTruthy();
    expect(within(desk).getByRole('button', { name: /صفحة الموظف/, hidden: true })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /موظف جديد/, hidden: true })).toBeNull();
    expect(within(desk).queryByRole('button', { name: /إدارة/, hidden: true })).toBeNull();
    expect(preview.drawn).toBe(0);
  });

  it('users.create draws «موظف جديد»; users.edit draws «إدارة» on each row — and neither draws the other', async () => {
    signedIn('COMPANY_ADMIN', 'users.view', 'users.create');
    render(<UsersScreen />);
    let desk = await table();
    expect(screen.getByRole('button', { name: /موظف جديد/, hidden: true })).toBeTruthy();
    expect(within(desk).queryByRole('button', { name: /إدارة/, hidden: true })).toBeNull();
    cleanup();

    signedIn('COMPANY_ADMIN', 'users.view', 'users.edit');
    users = [PERSON(), PERSON({ id: 'u2', name: 'التانية', email: 'two@example.test' })];
    render(<UsersScreen />);
    desk = await table();
    expect(within(desk).getAllByRole('button', { name: /إدارة/, hidden: true })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /موظف جديد/, hidden: true })).toBeNull();
  });

  it('«عاين كـ» is the owner’s alone, and not while he is already previewing', async () => {
    signedIn('SUPER_ADMIN');
    render(<UsersScreen />);
    await table();
    expect(screen.getByTestId('preview-picker')).toBeTruthy();
    cleanup();
    app.value = { currentUser: { id: 'me', role: 'SUPER_ADMIN', permissions: [], preview: { userId: 'x' } } };
    preview.drawn = 0;
    render(<UsersScreen />);
    await table();
    expect(screen.queryByTestId('preview-picker')).toBeNull();
  });

  it('the status presses appear only for an account the server says this viewer may act on — and say why otherwise', async () => {
    signedIn('COMPANY_ADMIN', 'users.view', 'users.edit');
    profile.value = { mayManage: false, manageRefusal: 'هذا الحساب فوقك' };
    render(<UsersScreen />);
    fireEvent.click(within(await table()).getByRole('button', { name: /إدارة/, hidden: true }));
    expect(await screen.findByText('هذا الحساب فوقك', undefined, WAIT)).toBeTruthy();
    expect(screen.queryByText('حالة الحساب', { selector: 'h4' })).toBeNull();
    expect(screen.queryByRole('button', { name: /إنهاء كل الجلسات/, hidden: true })).toBeNull();
    // the one road to the role is still drawn, to the employee's own page
    expect(screen.getByRole('link', { name: /تغيير الدور والصلاحيات والوصول/, hidden: true }).getAttribute('href')).toBe('/admin/users/u1');
  });
});

describe('each press sends what it sent', () => {
  it('the list query: same address, same order of fields, page 1 on a filter change', async () => {
    signedIn('COMPANY_ADMIN', 'users.view');
    render(<UsersScreen />);
    await table();
    expect(listQueries()[0]).toBe('/api/users?page=1&q=&role=all&status=all&from=&to=');
    fireEvent.change(screen.getByPlaceholderText('بحث بالاسم أو البريد الإلكتروني...'), { target: { value: 'سارة' } });
    await waitFor(() => expect(listQueries().some((u) => u.includes('q=%D8%B3'))).toBe(true), WAIT);
    expect(listQueries().at(-1)).toBe(`/api/users?page=1&q=${encodeURIComponent('سارة')}&role=all&status=all&from=&to=`);
  });

  it('the refresh asks the list again for the page on screen', async () => {
    signedIn('COMPANY_ADMIN', 'users.view');
    render(<UsersScreen />);
    await table();
    const before = listQueries().length;
    fireEvent.click(screen.getByRole('button', { name: 'تحديث القائمة', hidden: true }));
    await waitFor(() => expect(listQueries().length).toBe(before + 1), WAIT);
    expect(listQueries().at(-1)).toBe('/api/users?page=1&q=&role=all&status=all&from=&to=');
  });

  it.each([
    ['PENDING', /اعتماد الحساب/, false, '{"action":"changeStatus","status":"ACTIVE"}'],
    ['SUSPENDED', /تنشيط الحساب/, false, '{"action":"changeStatus","status":"ACTIVE"}'],
    ['ACTIVE', /إيقاف مؤقت/, true, '{"action":"changeStatus","status":"SUSPENDED"}'],
    ['ACTIVE', /^تعطيل$/, true, '{"action":"changeStatus","status":"DISABLED"}'],
    ['ACTIVE', /إنهاء كل الجلسات/, false, '{"action":"forceLogout"}'],
  ])('a %s account, %s (asks «تأكيد» first: %s) → PATCH /api/users/u1 with exactly %s', async (status, name, confirms, body) => {
    signedIn('COMPANY_ADMIN', 'users.view', 'users.edit');
    users = [PERSON({ status })];
    render(<UsersScreen />);
    fireEvent.click(within(await table()).getByRole('button', { name: /إدارة/, hidden: true }));
    await screen.findByText('حالة الحساب', { selector: 'h4' }, WAIT);
    fireEvent.click(screen.getByRole('button', { name, hidden: true }));
    if (confirms) {
      // nothing leaves before «تأكيد»
      expect(patches()).toEqual([]);
      fireEvent.click(await screen.findByRole('button', { name: 'تأكيد', hidden: true }, WAIT));
    }
    await waitFor(() => expect(patches()).toHaveLength(1), WAIT);
    expect(patches()[0]).toEqual({ url: '/api/users/u1', method: 'PATCH', body });
  });

  it('the status presses are drawn per state: no «اعتماد» for an active account, no «إيقاف» for a suspended one', async () => {
    signedIn('COMPANY_ADMIN', 'users.view', 'users.edit');
    users = [PERSON({ status: 'SUSPENDED' })];
    render(<UsersScreen />);
    fireEvent.click(within(await table()).getByRole('button', { name: /إدارة/, hidden: true }));
    await screen.findByText('حالة الحساب', { selector: 'h4' }, WAIT);
    expect(screen.queryByRole('button', { name: /إيقاف مؤقت/, hidden: true })).toBeNull();
    expect(screen.queryByRole('button', { name: /اعتماد الحساب/, hidden: true })).toBeNull();
    expect(screen.getByRole('button', { name: /تنشيط الحساب/, hidden: true })).toBeTruthy();
  });
});

describe('«موظف جديد»', () => {
  const open = async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    const view = render(<CreateUserModal isOpen onClose={onClose} onCreated={onCreated} />);
    await screen.findByLabelText(/البلد الأول/, undefined, WAIT);
    return { view, onCreated, onClose };
  };
  const password = () => document.querySelector('input[type="password"]') as HTMLInputElement;
  const SECRET = 'Zx9-' + 'probe-' + 'Kq7!';

  it('the password box opens empty, and after a close and a reopen it is empty again', async () => {
    const { view } = await open();
    expect(password().value).toBe('');
    fireEvent.change(password(), { target: { value: SECRET } });
    expect(password().value).toBe(SECRET);
    view.rerender(<CreateUserModal isOpen={false} onClose={vi.fn()} onCreated={vi.fn()} />);
    view.rerender(<CreateUserModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitFor(() => expect(password().value).toBe(''), WAIT);
  });

  it('the password is never printed: not in the text, not in an attribute, not in the «ناقص» line', async () => {
    await open();
    fireEvent.change(password(), { target: { value: SECRET } });
    expect(document.body.textContent).not.toContain(SECRET);
    const attrs = Array.from(document.body.querySelectorAll('*')).flatMap((el) =>
      Array.from(el.attributes).filter((a) => a.name !== 'value').map((a) => a.value)
    );
    expect(attrs.some((v) => v.includes(SECRET))).toBe(false);
    // a password that still breaks a rule is the one the «ناقص» line talks about — it names the rule, never the value
    const weak = 'probe' + 'weak';
    fireEvent.change(password(), { target: { value: weak } });
    expect(screen.getByText(/ناقص:/).textContent).toContain('كلمة المرور');
    expect(document.body.textContent).not.toContain(weak);
  });

  it('every tick has its own id, and a label toggles its own box and no other', async () => {
    await open();
    const c1 = screen.getByLabelText(/البلد الأول/) as HTMLInputElement;
    const c2 = screen.getByLabelText(/البلد التاني/) as HTMLInputElement;
    expect(c1.id).not.toBe(c2.id);
    fireEvent.click(screen.getByText('البلد التاني'));
    expect(c2.checked).toBe(true);
    expect(c1.checked).toBe(false);
    fireEvent.click(screen.getByText('البلد الأول'));
    const a = (await screen.findByLabelText('متجر أ', undefined, WAIT)) as HTMLInputElement;
    const b = screen.getByLabelText('متجر ب') as HTMLInputElement;
    const ids = Array.from(document.querySelectorAll('input[type="checkbox"]')).map((el) => el.id);
    expect(new Set(ids).size, 'معرّف مكرّر').toBe(ids.length);
    fireEvent.click(screen.getByText('متجر ب'));
    expect(b.checked).toBe(true);
    expect(a.checked).toBe(false);
  });

  it('the create body is byte for byte what it was — and dropping a country drops its stores from it', async () => {
    const { onCreated, onClose } = await open();
    fireEvent.change(screen.getByLabelText('الاسم'), { target: { value: '  موظف جديد  ' } });
    fireEvent.change(screen.getByLabelText('البريد الإلكتروني'), { target: { value: ' new@example.test ' } });
    fireEvent.change(password(), { target: { value: SECRET } });
    fireEvent.change(screen.getByLabelText('الدور'), { target: { value: 'r-agent' } });
    fireEvent.click(screen.getByText('البلد الأول'));
    fireEvent.click(screen.getByText('البلد التاني'));
    fireEvent.click(await screen.findByText('متجر ب', undefined, WAIT));
    fireEvent.click(screen.getByText('متجر ج'));
    // dropping the second country takes «متجر ج» with it
    fireEvent.click(screen.getByLabelText(/البلد التاني/));
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء الحساب' }));
    await waitFor(() => expect(sent.filter((s) => s.method === 'POST')).toHaveLength(1), WAIT);
    const post = sent.find((s) => s.method === 'POST')!;
    expect(post.url).toBe('/api/users');
    expect(post.body).toBe(
      JSON.stringify({
        name: 'موظف جديد',
        email: 'new@example.test',
        password: SECRET,
        phone: undefined,
        roleId: 'r-agent',
        role: 'CONFIRMATION_AGENT',
        countryIds: ['c1'],
        storeIds: ['s2'],
      })
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'new-1', name: 'جديد' }), WAIT);
    expect(onClose).toHaveBeenCalled();
  });

  it('the owner’s role is never offered, and «إنشاء الحساب» stays shut until the form is whole', async () => {
    await open();
    const role = screen.getByLabelText('الدور') as HTMLSelectElement;
    expect(Array.from(role.options).map((o) => o.value)).toEqual(['', 'r-agent']);
    expect((screen.getByRole('button', { name: 'إنشاء الحساب' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/ناقص:/)).toBeTruthy();
    // «إلغاء» closes and sends nothing
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(sent.filter((s) => s.method === 'POST')).toEqual([]);
  });
});
