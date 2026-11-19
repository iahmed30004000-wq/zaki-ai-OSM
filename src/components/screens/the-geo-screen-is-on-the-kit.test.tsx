// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «البلدان والمتاجر» ON THE KIT (R15b, 18/11) — WHAT THE NEW PARTS MUST STILL DO
 *
 * The census beside this file proves nothing was lost. This one proves the parts that changed hands still say and send
 * the same thing: the frame's name is the menu's, the two country marks are switches that send the value asked for (not
 * its opposite) and stay as stored when the server refuses, the weekend days say which are on and send the right list,
 * every button inside a form that is not the save says `type="button"` (the kit's Button sets no default, and a «cancel»
 * that submits creates a country), and at 375px nothing has a width wider than the phone and every form is one column.
 * Nothing behind the sign-in can be opened in a browser here (every account has a second factor only the owner holds),
 * so this is a render of the real screen against a fake door.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, refresh, who, door } = vi.hoisted(() => ({
  api: vi.fn(),
  refresh: vi.fn(),
  who: { permissions: ['geo.view', 'geo.manage'] as string[] },
  door: { refusal: null as string | null },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
// 19/11 (W0b): the screen gained «المخازن» under each country — its own card, with its own door and its own test
// (`geo/WarehousesCard.test.tsx`). Drawn as nothing here, so what THIS file counts and presses stays what it was.
vi.mock('@/components/geo/WarehousesCard', () => ({ WarehousesCard: () => null }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => '/settings/geo',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', role: 'COMPANY_ADMIN', permissions: who.permissions } }),
}));

import { GeoSettingsScreen } from './GeoSettingsScreen';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { routeLabel } from '@/lib/route-registry';

const country = () => ({
  id: 'c1', code: 'SY', name: 'سوريا', currencyCode: 'USD', minorUnit: 2, workHoursStart: '09:00', workHoursEnd: '17:00',
  weekendDays: [5], timezone: 'Asia/Damascus', orderPrefix: 'ORD', allowNegativeStock: false, isActive: true,
  stores: [
    {
      id: 's1', name: 'متجر فاضي', slug: 'empty', status: 'ACTIVE', type: 'MULTI_PRODUCT', priceIncludesDelivery: false,
      isTest: false, storefrontEnabled: true, logo: '/x/logo.png', favicon: null, _count: { orders: 0 },
    },
    {
      id: 's2', name: 'متجر موقوف', slug: 'paused', status: 'PAUSED', type: 'MULTI_PRODUCT', priceIncludesDelivery: true,
      isTest: false, storefrontEnabled: false, logo: null, _count: { orders: 2 },
    },
  ],
  _count: { regions: 1, orders: 0 },
});

let sent: { url: string; method: string; body?: Record<string, unknown> }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  door.refusal = null;
  who.permissions = ['geo.view', 'geo.manage'];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (door.refusal) throw new Error(door.refusal);
      return { success: true };
    }
    if (url === '/api/geo/countries') return { countries: [country()] };
    if (url === '/api/geo/stores/usage') return { stores: { s1: { blockers: [] }, s2: { blockers: [{ text: 'الطلبات (2)' }] } } };
    if (url === '/api/geo/countries/c1/regions') return { regions: [{ id: 'r1', name: 'دمشق' }], usage: { r1: [] } };
    if (url === '/api/context') return { stores: [], selection: null };
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(cleanup);

const draw = async () => {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <GeoSettingsScreen />
      </ConfirmProvider>
    </ToastProvider>
  );
  await screen.findByText('متجر فاضي');
  await screen.findByText(/لا يُحذف —/);
};
const openCountry = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'الإعدادات' }));
  await screen.findByText('دمشق');
};

describe('the frame', () => {
  it('the one h1 is the menu’s name for /settings/geo, read from the registry', async () => {
    await draw();
    const h1s = document.querySelectorAll('h1');
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toContain(routeLabel('/settings/geo'));
    expect(routeLabel('/settings/geo')).toBe('البلدان والمتاجر');
  });

  it('the width cap the screen had (the medium one) is kept, so a wide desk does not stretch the rows', async () => {
    await draw();
    const frame = document.querySelector('h1')!.closest('div.min-w-0')!;
    let el: Element | null = frame;
    let capped = false;
    while (el) {
      if (el.classList.contains(['max', 'w', '4xl'].join('-'))) capped = true;
      el = el.parentElement;
    }
    expect(capped).toBe(true);
  });

  it('«بلد جديد» sits in the header and opens the form', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /بلد جديد/ }));
    expect(document.querySelectorAll('form').length).toBe(1);
  });
});

describe('the country’s two marks are switches that send what was asked', () => {
  it('«البلد مفعّل» is a switch, on for an active country; pressing it sends isActive: false and nothing else', async () => {
    await draw();
    await openCountry();
    const sw = screen.getByRole('switch', { name: 'البلد مفعّل' }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ url: '/api/geo/countries/c1', method: 'PATCH', body: { isActive: false } });
  });

  it('negative stock is a switch, off; pressing it sends allowNegativeStock: true', async () => {
    await draw();
    await openCountry();
    const sw = screen.getByRole('switch', { name: /السماح بالمخزون السالب/ }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].body).toEqual({ allowNegativeStock: true });
  });

  it('NEGATIVE: a refusal is said in words, and the switch stays as stored', async () => {
    door.refusal = 'رفض السيرفر هذا التغيير';
    await draw();
    await openCountry();
    const sw = screen.getByRole('switch', { name: 'البلد مفعّل' }) as HTMLInputElement;
    fireEvent.click(sw);
    expect(await screen.findByText('رفض السيرفر هذا التغيير')).toBeTruthy();
    expect((screen.getByRole('switch', { name: 'البلد مفعّل' }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('the weekend days', () => {
  it('say which are on (aria-pressed) and send the list with one day taken out or added', async () => {
    await draw();
    await openCountry();
    const friday = screen.getByRole('button', { name: 'الجمعة' });
    const saturday = screen.getByRole('button', { name: 'السبت' });
    expect(friday.getAttribute('aria-pressed')).toBe('true');
    expect(saturday.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(saturday);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].body).toEqual({ weekendDays: [5, 6] });
  });

  it('NEGATIVE: pressing a day that is on takes it out — it does not add it twice', async () => {
    await draw();
    await openCountry();
    fireEvent.click(screen.getByRole('button', { name: 'الجمعة' }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].body).toEqual({ weekendDays: [] });
  });
});

describe('the store row', () => {
  it('pausing an active store sends PAUSED; the paused one says «تفعيل» and sends ACTIVE', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'إيقاف مؤقت' }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ url: '/api/geo/stores/s1', method: 'PATCH', body: { status: 'PAUSED' } });
    fireEvent.click(screen.getByRole('button', { name: 'تفعيل' }));
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]).toEqual({ url: '/api/geo/stores/s2', method: 'PATCH', body: { status: 'ACTIVE' } });
  });

  it('the price box sends the value asked for, and is described by its sentence', async () => {
    await draw();
    const boxes = screen.getAllByRole('checkbox', { name: /السعر المُعلن يشمل التوصيل/ }) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true]);
    expect(new Set(boxes.map((b) => b.id)).size).toBe(2);
    for (const b of boxes) expect(document.getElementById(b.getAttribute('aria-describedby')!)!.textContent).toContain('بيغيّر ربحك');
    fireEvent.click(boxes[1]);
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toEqual({ url: '/api/geo/stores/s2', method: 'PATCH', body: { priceIncludesDelivery: false } });
  });

  it('the identity panel button says whether it is open', async () => {
    await draw();
    const [first] = screen.getAllByRole('button', { name: 'الهوية والواجهة' });
    expect(first.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(first);
    await screen.findByText('هوية المتجر');
    expect(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0].getAttribute('aria-expanded')).toBe('true');
  });

  it('the logo has a remove control with a name; the favicon, which is empty, has none', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0]);
    await screen.findByText('هوية المتجر');
    const remove = screen.getByRole('button', { name: 'إزالة الشعار' });
    expect(remove.getAttribute('type')).toBe('button');
    expect(screen.queryByRole('button', { name: 'إزالة الأيقونة' })).toBeNull();
  });

  it('the cross on a city is a named button and asks before it deletes', async () => {
    await draw();
    await openCountry();
    fireEvent.click(screen.getByRole('button', { name: 'حذف المحافظة دمشق' }));
    expect(within(screen.getByRole('dialog')).getByText('حذف المحافظة «دمشق»؟')).toBeTruthy();
    expect(sent.length).toBe(0);
  });
});

describe('inside a form only the save submits', () => {
  const formButtons = () =>
    Array.from(document.querySelectorAll('form')).map((f) =>
      Array.from(f.querySelectorAll('button')).map((b) => ({ name: (b.textContent ?? '').trim(), type: b.getAttribute('type') }))
    );

  it('the new-country form: «حفظ» submits, «إلغاء» is type=button', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /بلد جديد/ }));
    expect(formButtons()).toEqual([[{ name: 'حفظ', type: 'submit' }, { name: 'إلغاء', type: 'button' }]]);
  });

  it('the new-store form: the same', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /متجر في سوريا/ }));
    expect(formButtons()).toEqual([[{ name: 'حفظ', type: 'submit' }, { name: 'إلغاء', type: 'button' }]]);
  });

  it('NEGATIVE: «إلغاء» on the new-store form closes it and sends nothing', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /متجر في سوريا/ }));
    fireEvent.click(within(document.querySelector('form')!).getByRole('button', { name: 'إلغاء' }));
    expect(document.querySelectorAll('form').length).toBe(0);
    expect(sent.length).toBe(0);
  });

  it('the cities form: «إضافة» is its one submit', async () => {
    await draw();
    await openCountry();
    expect(formButtons()).toEqual([[{ name: 'إضافة', type: 'submit' }]]);
  });

  it('and every other button on the screen says its type, so none can submit anything by accident', async () => {
    await draw();
    await openCountry();
    fireEvent.click(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0]);
    await screen.findByText('هوية المتجر');
    const untyped = Array.from(document.querySelectorAll('button')).filter((b) => !b.getAttribute('type'));
    expect(untyped.map((b) => b.textContent)).toEqual([]);
  });
});

describe('a phone, 375px wide', () => {
  /** Every arbitrary width on the page, in pixels — none may be wider than the phone. */
  const widths = () =>
    Array.from(document.querySelectorAll('[class]')).flatMap((el) =>
      String(el.getAttribute('class'))
        .split(/\s+/)
        .map((c) => /^(?:min-)?w-\[(\d+)px\]$/.exec(c))
        .filter(Boolean)
        .map((m) => Number(m![1]))
    );
  /** A grid with more than one column on a phone: a column count that is not behind a desk breakpoint. */
  const phoneColumns = () =>
    Array.from(document.querySelectorAll('[class]')).filter((el) =>
      String(el.getAttribute('class')).split(/\s+/).some((c) => /^grid-cols-([2-9])$/.test(c))
    );

  it('nothing is wider than the phone, and every form is one column, with every panel open', async () => {
    await draw();
    await openCountry();
    fireEvent.click(screen.getAllByRole('button', { name: 'الهوية والواجهة' })[0]);
    await screen.findByText('هوية المتجر');
    expect(widths().filter((w) => w > 375)).toEqual([]);
    expect(phoneColumns()).toEqual([]);
    cleanup();
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /متجر في سوريا/ }));
    expect(widths().filter((w) => w > 375)).toEqual([]);
    expect(phoneColumns()).toEqual([]);
    cleanup();
    await draw();
    fireEvent.click(screen.getByRole('button', { name: /بلد جديد/ }));
    expect(widths().filter((w) => w > 375)).toEqual([]);
    expect(phoneColumns()).toEqual([]);
  });

  it('the store’s name keeps its floor on the row that wraps, under the phone’s width', async () => {
    await draw();
    const name = screen.getByText('متجر فاضي');
    expect(name.parentElement!.className.split(/\s+/)).toContain(['min', 'w', '[150px]'].join('-'));
  });
});
