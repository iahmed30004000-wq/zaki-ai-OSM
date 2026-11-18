// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «شركات الشحن وأجورها» ON THE KIT (R15c, plan 17/11 — written 18/11).
 *
 * The courier list, its fee panel and its account panel moved onto `PageShell`, `Button`/`IconButton`, `Card`, `Switch`
 * and `Segmented`. What must NOT have moved with them:
 *   - every press sends the same request with the same body (create, on/off, edit, place, delete, a fee, the bulk fill);
 *   - the delete still asks first, and a «no» sends nothing;
 *   - the on/off switch sends the OPPOSITE of what is stored, and is locked while the screen is busy;
 *   - the two panels of a courier are one variable: the chip opens the fees, «الحساب والتكامل» opens the account,
 *     an agent has no choice at all and keeps the door to his custody;
 *   - a kit button inside a form that must not submit says so (`type="button"`);
 *   - the courier's secrets (login, password) open EMPTY after load and are never printed back;
 *   - the account's presses are still drawn only for `settings.manage`.
 * Every claim has a negative twin, so a wrong body, a lost `disabled` or a pre-filled secret turns it red.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`, no
 * fixed pixel width, the lists through `Rows` with their phone cards, the add form one column below `md`).
 */

const { app, confirmMock } = vi.hoisted(() => ({
  app: { permissions: ['settings.view', 'settings.manage'] as string[] },
  confirmMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings/couriers',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u0', role: 'COMPANY_ADMIN', permissions: app.permissions, status: 'ACTIVE' }, locale: 'ar', t: {} }),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmMock }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <span data-testid="contact" /> }));

import { CouriersScreen } from './CouriersScreen';
import { CourierCredentials } from '@/components/settings/CourierCredentials';
import { routeLabel } from '@/lib/route-registry';

vi.setConfig({ testTimeout: 15000 });

type Sent = { url: string; method: string; body: string | undefined };
let sent: Sent[] = [];
let pending: (() => void) | null = null;

const COMPANY = {
  id: 'c1', name: 'شركة التجربة', code: 'TST', kind: 'COMPANY', phone: null, email: null, isActive: true,
  storeId: 's1', adapterCode: 'MANUAL', pricedRegions: 0,
};
const STOPPED = { ...COMPANY, id: 'c2', name: 'شركة موقوفة', code: 'OFF', isActive: false, pricedRegions: 2 };
const AGENT = { ...COMPANY, id: 'a1', name: 'مندوب التجربة', code: 'AG', kind: 'AGENT', adapterCode: null, pricedRegions: 3 };
const LOOSE = { ...COMPANY, id: 'l1', name: 'شركة بلا متجر', code: 'LS', storeId: null };

const REGIONS = [{ id: 'r1', name: 'المحافظة الأولى' }, { id: 'r2', name: 'المحافظة التانية' }, { id: 'r3', name: 'المحافظة التالتة' }];
const CREDENTIALS = {
  providerId: 'c1', name: 'شركة التجربة', adapterCode: 'LOGESTECHS', apiEnabled: true, encryptionAvailable: true,
  hasCredentials: true, readable: true, savedAt: '2026-10-01T00:00:00.000Z', savedBy: 'مستخدم التجربة',
  emailHint: 'h***@example.test', accountCompanyId: 7, senderName: 'المرسل', originCityId: 5,
};
/** What a stored secret would look like if it ever leaked back: none of these may appear anywhere on the screen. */
const STORED_SECRETS = ['full-login@example.test', 'stored-password-value'];

let providers: unknown[] = [];
let fees: unknown[] = [];

beforeEach(() => {
  sent = [];
  pending = null;
  providers = [COMPANY, STOPPED, AGENT];
  fees = [];
  app.permissions = ['settings.view', 'settings.manage'];
  confirmMock.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const u = String(url);
      sent.push({ url: u, method, body: init?.body });
      const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
      if (method !== 'GET') {
        if (pending === null && u.startsWith('/api/delivery-providers/c1') && method === 'PATCH' && init?.body?.includes('isActive')) {
          // Holds the on/off request open until the test lets it go, to see the screen locked meanwhile.
          await new Promise<void>((resolve) => { pending = resolve; });
        }
        return ok({ success: true, message: method === 'DELETE' ? 'عُطِّلت' : undefined });
      }
      if (u === '/api/delivery-providers') return ok({ providers, totalRegions: 3, dialCode: '+000' });
      if (u === '/api/settings/delivery-fees') return ok({ regions: REGIONS, fees });
      if (u.startsWith('/api/settings/delivery-fees/places')) return ok({ places: null });
      if (u.endsWith('/credentials')) return ok(CREDENTIALS);
      return ok({});
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const table = async () => (await screen.findByRole('table', { hidden: true })) as HTMLElement;
const rowOf = async (name: string) => (await within(await table()).findByText(name)).closest('tr') as HTMLElement;
/** A press on something that has to be found first: found OUTSIDE act, pressed inside it. */
const tap = async (el: Element | Promise<Element>) => {
  const found = await el;
  await act(async () => { fireEvent.click(found); });
};
const writes = () => sent.filter((s) => s.method !== 'GET');
const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
const FILES = [
  'src/components/screens/CouriersScreen.tsx',
  'src/components/settings/CourierFees.tsx',
  'src/components/settings/CourierCredentials.tsx',
];

describe('the frame', () => {
  it('draws ONE heading, the menu’s name, with the sentence and the add button in the header, narrow and shrinkable', async () => {
    const { container } = render(<CouriersScreen />);
    await table();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toContain(routeLabel('/settings/couriers'));
    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toEqual(expect.arrayContaining(['min-w-0', 'max-w-3xl']));
    const header = container.querySelector('header') as HTMLElement;
    expect(within(header).getByText('افتح شركةً لتسعير محافظاتها وضبط حسابها.')).toBeTruthy();
    expect(within(header).getByRole('button', { name: /شركة شحن أو مندوب/ })).toBeTruthy();
  });

  it('the list goes through `Rows` (a desk table AND phone cards), and no file carries a fixed pixel width', async () => {
    const { container } = render(<CouriersScreen />);
    await table();
    expect(container.querySelector('ul')).not.toBeNull();
    // Built from pieces so the stylesheet's scanner does not read a class out of this line.
    const fixedWidth = new RegExp(['w', '-', '\\[', '\\d+px', '\\]'].join(''));
    for (const f of FILES) expect(source(f), f).not.toMatch(fixedWidth);
  });

  it('NEGATIVE: none of the three files draws a raw button any more', () => {
    for (const f of FILES) expect(source(f), f).not.toMatch(/<button[\s>]/);
  });
});

describe('adding a courier', () => {
  it('the form is one column on a phone, and the body is the same as before', async () => {
    render(<CouriersScreen />);
    await table();
    fireEvent.click(screen.getAllByRole('button', { name: /شركة شحن أو مندوب/ })[0]);
    const form = document.querySelector('form') as HTMLFormElement;
    // One column below `md`: no bare `grid-cols-N` class, only the `md:` one.
    const bareColumns = new RegExp(['^grid', 'cols', '\\d'].join('-'));
    expect(form.className.split(/\s+/).filter((c) => bareColumns.test(c))).toEqual([]);
    const boxes = within(form).getAllByRole('textbox');
    fireEvent.change(boxes[0], { target: { value: ' شركة جديدة ' } });
    fireEvent.change(boxes[1], { target: { value: 'new' } });
    await act(async () => { fireEvent.submit(form); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/delivery-providers',
      method: 'POST',
      body: JSON.stringify({ name: 'شركة جديدة', code: 'NEW', kind: 'COMPANY', adapterCode: 'MANUAL' }),
    });
  });

  it('NEGATIVE: «إلغاء» inside the form is `type="button"` — pressing it closes the form and sends nothing', async () => {
    render(<CouriersScreen />);
    await table();
    fireEvent.click(screen.getAllByRole('button', { name: /شركة شحن أو مندوب/ })[0]);
    const form = document.querySelector('form') as HTMLFormElement;
    const cancel = within(form).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    expect(within(form).getByRole('button', { name: 'حفظ' }).getAttribute('type')).toBe('submit');
    await act(async () => { fireEvent.click(cancel); });
    expect(document.querySelector('form')).toBeNull();
    expect(writes()).toEqual([]);
  });
});

describe('on / off', () => {
  it('a running courier’s switch is on and sends `isActive: false`; a stopped one’s is off and sends `isActive: true`', async () => {
    render(<CouriersScreen />);
    const on = within(await rowOf('شركة التجربة')).getByRole('switch') as HTMLInputElement;
    const off = within(await rowOf('شركة موقوفة')).getByRole('switch') as HTMLInputElement;
    expect(on.checked).toBe(true);
    expect(off.checked).toBe(false);
    expect(within(await rowOf('شركة التجربة')).getByText('نشطة')).toBeTruthy();
    expect(within(await rowOf('شركة موقوفة')).getByText('موقوفة')).toBeTruthy();

    await act(async () => { fireEvent.click(off); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/delivery-providers/c2', method: 'PATCH', body: JSON.stringify({ isActive: true }) });
  });

  it('NEGATIVE: while the request is out the screen is busy — the other switches and the delete are locked', async () => {
    render(<CouriersScreen />);
    const on = within(await rowOf('شركة التجربة')).getByRole('switch') as HTMLInputElement;
    await act(async () => { fireEvent.click(on); });
    await waitFor(() => expect(pending).not.toBeNull());
    expect(writes()[0].body).toBe(JSON.stringify({ isActive: false }));
    const other = within(await rowOf('شركة موقوفة')).getByRole('switch') as HTMLInputElement;
    expect(other.disabled).toBe(true);
    expect((within(await rowOf('شركة موقوفة')).getByRole('button', { name: 'احذف' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending?.(); });
    await waitFor(() => expect(other.disabled).toBe(false));
  });
});

describe('a courier’s row', () => {
  it('edit → the same PATCH body, and «احفظ» is locked while the name is empty', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('شركة التجربة');
    fireEvent.click(within(row).getByRole('button', { name: 'عدّل' }));
    const boxes = within(row).getAllByRole('textbox');
    fireEvent.change(boxes[0], { target: { value: '  ' } });
    const save = within(row).getByRole('button', { name: 'احفظ' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(boxes[0], { target: { value: ' اسم جديد ' } });
    fireEvent.change(boxes[1], { target: { value: ' 0999 ' } });
    expect(save.disabled).toBe(false);
    await act(async () => { fireEvent.click(save); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/delivery-providers/c1', method: 'PATCH', body: JSON.stringify({ name: 'اسم جديد', phone: '0999' }) });
  });

  it('«ألغِ» leaves the edit and sends nothing', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('شركة التجربة');
    fireEvent.click(within(row).getByRole('button', { name: 'عدّل' }));
    fireEvent.click(within(row).getByRole('button', { name: 'ألغِ' }));
    expect(within(row).queryAllByRole('textbox')).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('NEGATIVE: delete asks first — a «no» sends nothing, a «yes» sends the one DELETE', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('شركة التجربة');
    confirmMock.mockResolvedValueOnce(false);
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'احذف' })); });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0].tone).toBe('danger');
    expect(writes()).toEqual([]);
    confirmMock.mockResolvedValueOnce(true);
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'احذف' })); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/delivery-providers/c1', method: 'DELETE', body: undefined });
  });

  it('a courier with no store is named, and «أسنِدها لهذا المتجر» sends the same body', async () => {
    providers = [COMPANY, LOOSE];
    render(<CouriersScreen />);
    await table();
    const press = screen.getByRole('button', { name: 'أسنِدها لهذا المتجر' });
    await act(async () => { fireEvent.click(press); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/delivery-providers/l1', method: 'PATCH', body: JSON.stringify({ assignToCurrentStore: true }) });
  });
});

describe('the courier’s panel — one variable, two choices', () => {
  it('the coverage chip says the fact and opens the FEES; the pair switches to the account and back', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('شركة التجربة');
    const chip = within(row).getByRole('button', { name: /بلا أجور — لا تشحن/ });
    await act(async () => { fireEvent.click(chip); });
    const pair = await screen.findByRole('radiogroup');
    const [fees, account] = within(pair).getAllByRole('radio');
    expect(fees.textContent).toContain('الأجور');
    // The unpriced count rides on the fees choice: 3 regions, none priced.
    expect(fees.textContent).toContain('3');
    expect(fees.getAttribute('aria-checked')).toBe('true');
    expect((await screen.findAllByText('المحافظة الأولى', { selector: 'span' })).length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(account); });
    expect(account.getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(sent.some((s) => s.url === '/api/delivery-providers/c1/credentials')).toBe(true));
  });

  it('«الحساب والتكامل» on the row opens the ACCOUNT straight away', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('شركة التجربة');
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'الحساب والتكامل' })); });
    const pair = await screen.findByRole('radiogroup');
    expect(within(pair).getAllByRole('radio')[1].getAttribute('aria-checked')).toBe('true');
    await waitFor(() => expect(sent.some((s) => s.url === '/api/delivery-providers/c1/credentials')).toBe(true));
  });

  it('a partly priced courier reads «N من M محافظة»', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('شركة موقوفة');
    expect(within(row).getByRole('button', { name: /2 من 3 محافظة/ })).toBeTruthy();
  });

  it('NEGATIVE: an agent has no account press and no pair — only his fees, and the door to his custody stays', async () => {
    render(<CouriersScreen />);
    const row = await rowOf('مندوب التجربة');
    expect(within(row).queryByRole('button', { name: 'الحساب والتكامل' })).toBeNull();
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: /3 من 3 محافظة/ })); });
    expect(await screen.findByText('افتح عهدة المندوبين')).toBeTruthy();
    expect(screen.getByText('افتح عهدة المندوبين').closest('a')?.getAttribute('href')).toBe('/finance/agents');
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(sent.some((s) => s.url.endsWith('/credentials'))).toBe(false);
  });
});

describe('the fee panel', () => {
  it('«إضافة» on an unpriced region sends the same PUT, empty boxes absent', async () => {
    render(<CouriersScreen />);
    await tap(rowOf('شركة التجربة').then((row) => within(row).getByRole('button', { name: /بلا أجور/ })));
    const box = (await screen.findAllByLabelText('أجرة المحافظة الأولى'))[0];
    fireEvent.change(box, { target: { value: '5' } });
    const add = (await screen.findAllByRole('button', { name: /إضافة/ }))[0];
    expect(add.getAttribute('type')).toBe('button');
    await act(async () => { fireEvent.click(add); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/settings/delivery-fees',
      method: 'PUT',
      body: JSON.stringify({ deliveryProviderId: 'c1', regionId: 'r1', fee: 5 }),
    });
  });

  it('NEGATIVE: the bulk dialog’s «إلغاء» is `type="button"` and sends nothing; its submit fills each empty region once', async () => {
    render(<CouriersScreen />);
    await tap(rowOf('شركة التجربة').then((row) => within(row).getByRole('button', { name: /بلا أجور/ })));
    await tap(screen.findByRole('button', { name: /عبّئ الفارغة/ }));
    const dialogForm = (await screen.findByText('تُكتب على المحافظات', { exact: false })).closest('form') as HTMLFormElement;
    const cancel = within(dialogForm).getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    fireEvent.change(within(dialogForm).getAllByRole('spinbutton')[0], { target: { value: '4' } });
    const submit = within(dialogForm).getByRole('button', { name: /عبّئ 3/ });
    expect(submit.getAttribute('type')).toBe('submit');
    await act(async () => { fireEvent.submit(dialogForm); });
    await waitFor(() => expect(writes()).toHaveLength(3));
    expect(writes().map((w) => JSON.parse(w.body!).regionId)).toEqual(['r1', 'r2', 'r3']);
    expect(JSON.parse(writes()[0].body!)).toEqual({ deliveryProviderId: 'c1', regionId: 'r1', fee: 4 });
  });

  it('changing an existing fee still asks for a reason before it sends', async () => {
    fees = [{ id: 'f1', deliveryProviderId: 'c1', regionId: 'r1', fee: 5, lateThresholdDays: 3, returnFee: 1, courierCityId: null, isActive: true }];
    render(<CouriersScreen />);
    await tap(rowOf('شركة التجربة').then((row) => within(row).getByRole('button', { name: /بلا أجور/ })));
    const box = (await screen.findAllByLabelText('أجرة المحافظة الأولى'))[0];
    fireEvent.change(box, { target: { value: '6' } });
    await tap(screen.findAllByRole('button', { name: /تحديث/ }).then((all) => all[0]));
    expect(writes()).toEqual([]);
    const reasonForm = (await screen.findByText('السبب (إلزامي)')).closest('form') as HTMLFormElement;
    expect(within(reasonForm).getByRole('button', { name: 'إلغاء' }).getAttribute('type')).toBe('button');
    fireEvent.change(within(reasonForm).getByRole('textbox'), { target: { value: 'اتفاق جديد' } });
    await act(async () => { fireEvent.submit(reasonForm); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse(writes()[0].body!)).toMatchObject({ regionId: 'r1', fee: 6, reason: 'اتفاق جديد' });
  });
});

describe('the account panel — the secrets keep their behaviour (decision 5)', () => {
  it('the login and the password open EMPTY after load, and nothing stored is printed back', async () => {
    const { container } = render(<CourierCredentials providerId="c1" />);
    await tap(screen.findByRole('button', { name: /تغيير الحساب/ }));
    const login = screen.getByLabelText(/البريد \/ اسم المستخدم/) as HTMLInputElement;
    const password = screen.getByLabelText(/كلمة المرور/, { selector: 'input' }) as HTMLInputElement;
    expect(login.value).toBe('');
    expect(password.value).toBe('');
    expect(password.type).toBe('password');
    for (const input of Array.from(document.querySelectorAll('input'))) expect((input as HTMLInputElement).value, input.name).toBe('');
    const all = (container.textContent ?? '') + (document.body.textContent ?? '');
    for (const secret of STORED_SECRETS) expect(all).not.toContain(secret);
    // Only the hint the server chose to send.
    expect(all).toContain(CREDENTIALS.emailHint);
  });

  it('NEGATIVE: typed, then closed with «إلغاء», then opened again — the boxes are empty again', async () => {
    render(<CourierCredentials providerId="c1" />);
    await tap(screen.findByRole('button', { name: /تغيير الحساب/ }));
    fireEvent.change(screen.getByLabelText(/كلمة المرور/, { selector: 'input' }), { target: { value: 'typed-secret' } });
    const cancel = screen.getByRole('button', { name: 'إلغاء' });
    expect(cancel.getAttribute('type')).toBe('button');
    await act(async () => { fireEvent.click(cancel); });
    expect(writes()).toEqual([]);
    await tap(screen.findByRole('button', { name: /تغيير الحساب/ }));
    expect((screen.getByLabelText(/كلمة المرور/, { selector: 'input' }) as HTMLInputElement).value).toBe('');
  });

  it('NEGATIVE: without `settings.manage` no press of the account is drawn', async () => {
    app.permissions = ['settings.view'];
    render(<CourierCredentials providerId="c1" />);
    await screen.findByText(/محفوظ ومشفَّر/);
    expect(screen.queryByRole('button', { name: /تغيير الحساب/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /اختبر الاتصال/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'حذف الحساب' })).toBeNull();
  });

  it('«اختبر الاتصال» sends the same POST and is not a submit', async () => {
    render(<CourierCredentials providerId="c1" />);
    const test = await screen.findByRole('button', { name: /اختبر الاتصال/ });
    expect(test.getAttribute('type')).toBe('button');
    await act(async () => { fireEvent.click(test); });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: '/api/delivery-providers/c1/credentials/test', method: 'POST' });
  });
});
