// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «المخازن» UNDER EACH COUNTRY (warehouse plan, W0b) — what the card owes, state by state.
 *
 *   • empty: says what a warehouse is, and that no unit moves until «توزيع الرصيد على المخازن»;
 *   • a list: names, «موقوف», the keepers (only when the door sent them);
 *   • add / rename / stop / start: the body each sends, and the door's refusal shown under the row it belongs to;
 *   • the keepers picker: the server's candidates as real check boxes, a keeper who lost the country flagged, the whole
 *     list sent on save, a refusal kept on screen;
 *   • somebody without «geo.manage» — even holding the warehouse keys — gets the list and NOT ONE control;
 *   • a phone: no width wider than 375px, no multi-column grid.
 *
 * Nothing behind the sign-in can be opened in a browser here (every account has a second factor only the owner holds),
 * so this is a render of the real card against a fake door. The rendered geo screen holding the card is the last block.
 */

const { api, refresh, who } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  who: { permissions: ['geo.view', 'geo.manage'] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/settings/geo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'CUSTOM', permissions: who.permissions } }),
}));
vi.mock('@/components/settings/StorefrontSettings', () => ({ StorefrontSettings: () => null }));
vi.mock('@/components/settings/StoreIdentityCard', () => ({ StoreIdentityCard: () => null }));

import { WarehousesCard } from './WarehousesCard';
import { GeoSettingsScreen } from '@/components/screens/GeoSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';

type W = { id: string; name: string; isActive: boolean; keepers?: { id: string; name: string }[] };
let warehouses: W[];
let keepersAnswer: { keepers: { id: string; name: string; reachesCountry: boolean }[]; candidates: { id: string; name: string }[] };
/** A refusal the next write gets, in the door's own words. */
let refusal: string | null;
let sent: { url: string; method: string; body?: Record<string, unknown> }[];

const MAIN: W = { id: 'w1', name: 'المستودع الرئيسي', isActive: true, keepers: [{ id: 'k1', name: 'أمينة' }] };
const SPARE: W = { id: 'w2', name: 'الفرع', isActive: false, keepers: [] };

beforeEach(() => {
  vi.clearAllMocks();
  who.permissions = ['geo.view', 'geo.manage'];
  warehouses = [MAIN, SPARE];
  keepersAnswer = {
    keepers: [{ id: 'k1', name: 'أمينة', reachesCountry: true }],
    candidates: [
      { id: 'k1', name: 'أمينة' },
      { id: 'k2', name: 'سامر' },
    ],
  };
  refusal = null;
  sent = [];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (refusal) throw new Error(refusal);
      return { ok: true };
    }
    if (url === '/api/geo/warehouses?countryId=c1') {
      // The door leaves the keepers out for anybody without geo.manage.
      const manages = who.permissions.includes('geo.manage');
      return { warehouses: warehouses.map(({ keepers, ...w }) => (manages ? { ...w, keepers } : w)) };
    }
    if (url === '/api/geo/warehouses/w1/keepers') return keepersAnswer;
    if (url === '/api/geo/countries') return { countries: [geoCountry()] };
    if (url === '/api/geo/stores/usage') return { stores: { s1: { blockers: [] } } };
    if (url === '/api/geo/countries/c1/regions') return { regions: [], usage: {} };
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(cleanup);

const draw = async (mayManage = true) => {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <WarehousesCard countryId="c1" countryName="سوريا" mayManage={mayManage} />
      </ConfirmProvider>
    </ToastProvider>
  );
  await waitFor(() => expect(api).toHaveBeenCalledWith('/api/geo/warehouses?countryId=c1'));
};
const writes = () => sent.filter((s) => s.method !== 'GET');
/** The row whose name line starts with this name (a stopped one reads «… · موقوف»). */
const rowOf = (name: string) =>
  Array.from(document.querySelectorAll('li')).find((li) => li.querySelector('p')?.textContent?.startsWith(name)) as HTMLElement;

describe('empty — what a warehouse is, before the first one', () => {
  it('says it, names «توزيع الرصيد على المخازن», and offers the add form to a manager', async () => {
    warehouses = [];
    await draw();
    const said = await screen.findByText(/ما في مخازن بـسوريا/);
    expect(said.textContent).toContain('بضاعة أي متجر بهالبلد');
    expect(said.textContent).toContain('ما بيحرّك ولا قطعة');
    expect(said.textContent).toContain('«توزيع الرصيد على المخازن»');
    expect(screen.getByLabelText('مخزن جديد بـسوريا')).toBeTruthy();
  });

  it('a viewer sees the same sentence and no form', async () => {
    warehouses = [];
    who.permissions = ['geo.view'];
    await draw(false);
    await screen.findByText(/ما في مخازن بـسوريا/);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a failed read says so in words, and draws no list on a guess', async () => {
    api.mockImplementationOnce(async () => {
      throw new Error('تعذّر الاتصال');
    });
    await draw();
    expect((await screen.findByRole('alert')).textContent).toBe('تعذّر الاتصال');
    expect(screen.queryByText(/ما في مخازن/)).toBeNull();
  });
});

describe('a list', () => {
  it('names each warehouse, marks the stopped one, and lists the keepers', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    expect(within(rowOf('المستودع الرئيسي')).getByText('الأمناء: أمينة')).toBeTruthy();
    expect(within(rowOf('الفرع')).getByText('بلا أمين')).toBeTruthy();
    expect(within(rowOf('الفرع')).getByText(/موقوف/)).toBeTruthy();
    expect(within(rowOf('المستودع الرئيسي')).queryByText(/موقوف/)).toBeNull();
    const switches = screen.getAllByRole('switch', { name: 'المخزن شغّال' }) as HTMLInputElement[];
    expect(switches.map((s) => s.checked)).toEqual([true, false]);
  });

  it('NEGATIVE: without «geo.manage» — even holding the warehouse keys — the list and NOT ONE control', async () => {
    who.permissions = ['geo.view', 'inventory.view', 'inventory.adjust', 'ops.prepare'];
    await draw(false);
    await screen.findByText('المستودع الرئيسي');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText(/الأمناء/)).toBeNull();
  });
});

describe('add', () => {
  it('sends the country and the trimmed name, then reads the list again', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    const box = screen.getByLabelText('مخزن جديد بـسوريا');
    const add = screen.getByRole('button', { name: /إضافة/ }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(box, { target: { value: '  الشمال ' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(writes()).toEqual([{ url: '/api/geo/warehouses', method: 'POST', body: { countryId: 'c1', name: 'الشمال' } }]));
    await waitFor(() => expect(api.mock.calls.filter((c) => c[0] === '/api/geo/warehouses?countryId=c1')).toHaveLength(2));
  });

  it('NEGATIVE: a name of one letter sends nothing', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.change(screen.getByLabelText('مخزن جديد بـسوريا'), { target: { value: 'ا' } });
    fireEvent.submit(screen.getByLabelText('مخزن جديد بـسوريا').closest('form')!);
    expect(writes()).toEqual([]);
  });

  it('NEGATIVE: the door’s refusal stays under the field, and the name stays typed', async () => {
    refusal = 'في مخزن بنفس الاسم بهالبلد. اختار اسم تاني.';
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.change(screen.getByLabelText('مخزن جديد بـسوريا'), { target: { value: 'الفرع' } });
    fireEvent.click(screen.getByRole('button', { name: /إضافة/ }));
    expect(await screen.findByText(refusal)).toBeTruthy();
    expect((screen.getByLabelText('مخزن جديد بـسوريا') as HTMLInputElement).value).toBe('الفرع');
  });
});

describe('rename, stop, start', () => {
  it('rename asks for the name, starting from the old one, and sends only the name', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'تغيير الاسم' }));
    const dialog = await screen.findByRole('dialog');
    const box = within(dialog).getByRole('textbox') as HTMLInputElement;
    expect(box.value).toBe('المستودع الرئيسي');
    fireEvent.change(box, { target: { value: 'المستودع الكبير' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'احفظ الاسم' }));
    await waitFor(() => expect(writes()).toEqual([{ url: '/api/geo/warehouses/w1', method: 'PATCH', body: { name: 'المستودع الكبير' } }]));
  });

  it('NEGATIVE: rename with Cancel, or with the same name, sends nothing', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'تغيير الاسم' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /إلغاء/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The kit's Button holds itself while its promise is out; wait for it to let go.
    await waitFor(() => expect(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'تغيير الاسم' }).getAttribute('aria-busy')).not.toBe('true'));
    await new Promise((r) => setTimeout(r, 20));
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'تغيير الاسم' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'احفظ الاسم' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(writes()).toEqual([]);
  });

  it('the switch sends the value asked for: stop the running one, start the stopped one', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('switch'));
    await waitFor(() => expect(writes()).toHaveLength(1));
    fireEvent.click(within(rowOf('الفرع')).getByRole('switch'));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes().map((w) => [w.url, w.body])).toEqual([
      ['/api/geo/warehouses/w1', { isActive: false }],
      ['/api/geo/warehouses/w2', { isActive: true }],
    ]);
  });

  it('NEGATIVE: a stop refused while it holds goods — the door’s sentence under THAT row, and the switch stays on', async () => {
    refusal = 'ما بينوقف هالمخزن: فيه بضاعة (3 دفعة). فرّغه أول، وبعدين وقّفه.';
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('switch'));
    const said = await within(rowOf('المستودع الرئيسي')).findByRole('alert');
    expect(said.textContent).toBe(refusal);
    expect(within(rowOf('الفرع')).queryByRole('alert')).toBeNull();
    expect((within(rowOf('المستودع الرئيسي')).getByRole('switch') as HTMLInputElement).checked).toBe(true);
  });
});

describe('the keepers picker', () => {
  const open = async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'الأمناء' }));
    await screen.findByLabelText('سامر');
  };

  it('offers the server’s candidates as real check boxes, the current keepers ticked', async () => {
    await open();
    expect((screen.getByLabelText('أمينة') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('سامر') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('أمينة') as HTMLInputElement).type).toBe('checkbox');
    expect(screen.getByText(/الأمين بيشوف بس المخازن اللي هو أمينها/)).toBeTruthy();
  });

  it('sends the whole list on save, and closes', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('سامر'));
    fireEvent.click(screen.getByLabelText('أمينة'));
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الأمناء' }));
    await waitFor(() => expect(writes()).toEqual([{ url: '/api/geo/warehouses/w1/keepers', method: 'PUT', body: { userIds: ['k2'] } }]));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'احفظ الأمناء' })).toBeNull());
  });

  it('adding one keeps the keepers already ticked — the list sent is the WHOLE list', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('سامر'));
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الأمناء' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect((writes()[0].body!.userIds as string[]).slice().sort()).toEqual(['k1', 'k2']);
  });

  it('a keeper who lost the country stays ticked, with a note — the owner decides', async () => {
    keepersAnswer = { keepers: [{ id: 'k9', name: 'رنا', reachesCountry: false }], candidates: [{ id: 'k2', name: 'سامر' }] };
    await open();
    expect((screen.getByLabelText('رنا') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('ما عاد بيوصل لبلد هالمخزن')).toBeTruthy();
  });

  it('nobody reaches the country: says where to fix it', async () => {
    keepersAnswer = { keepers: [], candidates: [] };
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'الأمناء' }));
    expect(await screen.findByText(/ما في حدا بيوصل لهالبلد/)).toBeTruthy();
  });

  it('NEGATIVE: the door’s refusal stays in the picker, which stays open', async () => {
    refusal = 'ما بيوصلوا لبلد هالمخزن: سامر. أعطيهم البلد من صفحة الموظف أول.';
    await open();
    fireEvent.click(screen.getByLabelText('سامر'));
    fireEvent.click(screen.getByRole('button', { name: 'احفظ الأمناء' }));
    expect(await screen.findByText(refusal)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'احفظ الأمناء' })).toBeTruthy();
  });

  it('Cancel sends nothing', async () => {
    await open();
    fireEvent.click(screen.getByLabelText('سامر'));
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(writes()).toEqual([]);
    expect(screen.queryByLabelText('سامر')).toBeNull();
  });

  it('every button that is not a submit says type="button"', async () => {
    await open();
    const untyped = screen.getAllByRole('button').filter((b) => b.getAttribute('type') !== 'button' && b.getAttribute('type') !== 'submit');
    expect(untyped.map((b) => b.textContent)).toEqual([]);
  });
});

describe('a phone, 375px wide', () => {
  const widths = () =>
    Array.from(document.querySelectorAll('[class]')).flatMap((el) =>
      String(el.getAttribute('class'))
        .split(/\s+/)
        .map((c) => /^(?:min-)?w-\[(\d+)px\]$/.exec(c))
        .filter(Boolean)
        .map((m) => Number(m![1]))
    );
  const multiColumn = () =>
    Array.from(document.querySelectorAll('[class]')).filter((el) =>
      String(el.getAttribute('class')).split(/\s+/).some((c) => /^grid-cols-([2-9])$/.test(c))
    );

  it('nothing is wider than the phone and nothing is in columns, with the picker open', async () => {
    await draw();
    await screen.findByText('المستودع الرئيسي');
    fireEvent.click(within(rowOf('المستودع الرئيسي')).getByRole('button', { name: 'الأمناء' }));
    await screen.findByLabelText('سامر');
    expect(widths().filter((w) => w > 375)).toEqual([]);
    expect(multiColumn()).toEqual([]);
    // The rows wrap: the name keeps a floor so the buttons go to the next line, not over it.
    const name = screen.getByText('المستودع الرئيسي').parentElement!;
    expect(name.className.split(/\s+/)).toContain(['min', 'w', '[150px]'].join('-'));
    expect(name.parentElement!.className.split(/\s+/)).toContain('flex-wrap');
  });
});

function geoCountry() {
  return {
    id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
    weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
    stores: [{ id: 's1', name: 'متجر', slug: 's1', status: 'ACTIVE', type: 'MULTI_PRODUCT', _count: { orders: 0 } }],
    _count: { regions: 0, orders: 0 },
  };
}

describe('on the geo screen', () => {
  it('each country carries its «المخازن», open without a click, asking for THAT country', async () => {
    render(
      <ToastProvider>
        <ConfirmProvider>
          <GeoSettingsScreen />
        </ConfirmProvider>
      </ToastProvider>
    );
    await screen.findByText('المستودع الرئيسي');
    expect(screen.getByText('المخازن')).toBeTruthy();
    expect(api).toHaveBeenCalledWith('/api/geo/warehouses?countryId=c1');
  });

  it('NEGATIVE: the screen hands the controls only to «geo.manage»', async () => {
    who.permissions = ['geo.view', 'inventory.adjust'];
    render(
      <ToastProvider>
        <ConfirmProvider>
          <GeoSettingsScreen />
        </ConfirmProvider>
      </ToastProvider>
    );
    await screen.findByText('المستودع الرئيسي');
    expect(screen.queryByRole('button', { name: 'الأمناء' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'المخزن شغّال' })).toBeNull();
  });
});
