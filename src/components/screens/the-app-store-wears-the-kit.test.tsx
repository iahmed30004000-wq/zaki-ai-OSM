// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «متجر التطبيقات» ON THE KIT (R15h, plan 17/11 — written 19/11).
 *
 * The screen moved onto `PageShell`, `Button`/`IconButton`, `Card` and `Checkbox`, and its old look names became the kit's four.
 * What must NOT have moved with it:
 *   - every press sends the same request it sent: install, enable/disable, uninstall, and the registration body, byte for byte;
 *   - a built-in app the user may not manage keeps every press closed and says why;
 *   - a press that is in the air closes that app's presses (the screen's own busy flag), so a second press sends nothing;
 *   - the registration form is submitted only by «سجّل»: «إلغاء» and every other kit button inside it is `type="button"`;
 *   - the signing secret is shown once, and the copy press copies exactly it — or, when the browser refuses, hands it over by hand.
 * Every claim has a negative twin.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`, no fixed
 * width, the cards and the form one column on a phone), and the pull request says so.
 */

const { apiJson, copyText, tell } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  copyText: vi.fn(),
  tell: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/lib/clipboard', () => ({ copyText: (...a: unknown[]) => copyText(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/apps/store',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useLiveRefresh', async () => {
  const R = await import('react');
  return {
    useLiveRefresh: (load: () => unknown) => {
      R.useEffect(() => {
        void load();
      }, [load]);
    },
  };
});
vi.mock('@/components/ui/Confirm', () => ({ useTell: () => tell, useConfirm: () => vi.fn(async () => false) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn(), done: vi.fn() }) }));

import { AppStoreScreen } from './AppStoreScreen';
import { routeLabel } from '@/lib/route-registry';

vi.setConfig({ testTimeout: 15000 });

const builtIn = (over: Record<string, unknown>) => ({
  kind: 'BUILTIN',
  summary: 'ملخّص',
  description: 'وصف',
  categoryLabel: 'شحن',
  settingsPath: '/settings/couriers',
  canManage: true,
  installed: false,
  enabled: false,
  configured: false,
  ...over,
});
const FRESH = builtIn({ code: 'FRESH', name: 'تكامل جديد' });
const LIVE = builtIn({ code: 'LIVE', name: 'تكامل شغّال', installed: true, enabled: true, configured: true, settingsPath: '/settings/links' });
const LOCKED = builtIn({ code: 'LOCKED', name: 'تكامل مقفول', canManage: false });

const external = (over: Record<string, unknown>) => ({
  kind: 'EXTERNAL',
  description: null,
  developerName: 'مطوّر',
  webhookUrl: 'https://example.com/hook',
  events: ['order.created'],
  status: 'ACTIVE',
  installed: false,
  enabled: false,
  ...over,
});
const OFF_APP = external({ id: 'x1', code: 'OFF_APP', name: 'تطبيق موقوف', installed: true, enabled: false });
const NEW_APP = external({ id: 'x2', code: 'NEW_APP', name: 'تطبيق غير مثبّت' });

const EVENTS = [
  { code: 'order.created', label: 'طلب جديد' },
  { code: 'order.delivered', label: 'تسليم' },
];

let sent: { url: string; method: string; body: string | undefined }[] = [];
let shelf: { builtIn: unknown[]; external: unknown[]; availableEvents: unknown[] };
let hold: Promise<unknown> | null = null;

beforeEach(() => {
  sent = [];
  hold = null;
  shelf = { builtIn: [FRESH, LIVE, LOCKED], external: [OFF_APP, NEW_APP], availableEvents: EVENTS };
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/apps' && method === 'GET') return shelf;
    sent.push({ url, method, body: init?.body });
    if (hold) await hold;
    if (url === '/api/apps' && method === 'POST') return { secret: 'whsec_test_only_value' };
    return { success: true };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ready = async () => {
  const view = render(<AppStoreScreen />);
  await screen.findByText('تكامل جديد');
  return view;
};
const writes = () => sent.filter((s) => s.method !== 'GET');
const tileOf = (name: string) => {
  // The tile is the nearest ancestor that holds the app's own presses.
  let el: HTMLElement | null = screen.getByText(name);
  while (el && !within(el).queryAllByRole('button').length) el = el.parentElement;
  return el as HTMLElement;
};
const installBody = (appCode: string, action: string) => ({
  url: '/api/apps/installs',
  method: 'POST',
  body: JSON.stringify({ appCode, action }),
});
const SRC = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/AppStoreScreen.tsx'), 'utf8'));

describe('the app store on the kit', () => {
  it('— one header, its name read from the menu, inside the frame', async () => {
    await ready();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toContain(routeLabel('/apps/store'));
    expect(routeLabel('/apps/store')).toBe('متجر التطبيقات');
  });

  it('— the source draws the frame and the kit, no raw button or tick box, no old look name, no small-print size', () => {
    const src = SRC();
    expect(src).toMatch(/<PageShell\s+title=\{routeLabel\('\/apps\/store'\)\}/);
    expect(src).not.toMatch(/<button[\s>]/);
    expect(src).not.toMatch(/<input[\s>]/);
    expect(src).not.toMatch(/variant="(outline|ghost|success)"/);
    expect(src).not.toContain(['text', 'xs'].join('-'));
    expect(src).toMatch(/<IconButton[\s\S]*?label="انسخ السرّ"/);
    expect(src).toMatch(/<Checkbox[\s\S]*?id=\{`app-event-\$\{ev\.code\}`\}/);
  });

  it('— «تثبيت» on a built-in sends exactly { appCode, action: install } once', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(within(tileOf('تكامل جديد')).getByRole('button', { name: 'تثبيت' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual(installBody('FRESH', 'install'));
  });

  it('— an installed, working built-in: «إيقاف» sends disable, «إزالة» sends uninstall, «الإعدادات» leads to its screen', async () => {
    await ready();
    const tile = tileOf('تكامل شغّال');
    expect(within(tile).getByText('مهيَّأ ويعمل')).toBeTruthy();
    expect(within(tile).getByRole('link').getAttribute('href')).toBe('/settings/links');
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: 'إيقاف' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    await act(async () => {
      fireEvent.click(within(tileOf('تكامل شغّال')).getByRole('button', { name: 'إزالة' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()).toEqual([installBody('LIVE', 'disable'), installBody('LIVE', 'uninstall')]);
  });

  it('NEGATIVE: a built-in the user may not manage keeps «تثبيت» closed, says why, and a press sends nothing', async () => {
    await ready();
    const tile = tileOf('تكامل مقفول');
    const install = within(tile).getByRole('button', { name: 'تثبيت' }) as HTMLButtonElement;
    expect(install.disabled).toBe(true);
    expect(within(tile).getByText('تحتاج صلاحية لتثبيته')).toBeTruthy();
    await act(async () => {
      fireEvent.click(install);
    });
    expect(writes()).toEqual([]);
    // and a manageable one carries no such sentence
    expect(within(tileOf('تكامل جديد')).queryByText('تحتاج صلاحية لتثبيته')).toBeNull();
  });

  it('NEGATIVE: an installed built-in the user may not manage keeps «إيقاف» and «إزالة» closed', async () => {
    shelf = { ...shelf, builtIn: [FRESH, { ...LIVE, canManage: false }] };
    await ready();
    const tile = tileOf('تكامل شغّال');
    expect((within(tile).getByRole('button', { name: 'إيقاف' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(tile).getByRole('button', { name: 'إزالة' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: 'إزالة' }));
    });
    expect(writes()).toEqual([]);
  });

  it('NEGATIVE: while a press is in the air, that app’s presses are closed and a second press sends nothing', async () => {
    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    await ready();
    await act(async () => {
      fireEvent.click(within(tileOf('تكامل شغّال')).getByRole('button', { name: 'إيقاف' }));
    });
    const tile = tileOf('تكامل شغّال');
    await waitFor(() => expect((within(tile).getByRole('button', { name: 'إزالة' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(tile).getByRole('button', { name: 'إيقاف' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(within(tile).getByRole('button', { name: 'إزالة' }));
      fireEvent.click(within(tile).getByRole('button', { name: 'إيقاف' }));
    });
    expect(writes()).toHaveLength(1);
    // another app is not held by it
    expect((within(tileOf('تكامل جديد')).getByRole('button', { name: 'تثبيت' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      release();
    });
  });

  it('— a registered app: «تفعيل» sends enable for one that is off, «تثبيت» sends install for one not installed', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(within(tileOf('تطبيق موقوف')).getByRole('button', { name: 'تفعيل' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    await act(async () => {
      fireEvent.click(within(tileOf('تطبيق غير مثبّت')).getByRole('button', { name: 'تثبيت' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()).toEqual([installBody('OFF_APP', 'enable'), installBody('NEW_APP', 'install')]);
  });

  it('— no registered app: the empty sentence stays, word for word, on a card', async () => {
    shelf = { ...shelf, external: [] };
    await ready();
    const empty = screen.getByText(/لا تطبيقات مسجَّلة بعد/);
    expect(empty.textContent).toContain('طلب جديد، تأكيد، شحن، تسليم، إرجاع.');
    expect(empty.parentElement?.className).toContain('bg-[var(--sys-card)]');
  });
});

describe('registering an app on the kit', () => {
  const open = async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /سجّل تطبيقاً/ }));
    await screen.findByLabelText('اسم التطبيق *');
  };
  const fill = () => {
    fireEvent.change(screen.getByLabelText('اسم التطبيق *'), { target: { value: 'تطبيقي' } });
    fireEvent.change(screen.getByLabelText('الرمز *'), { target: { value: 'my_app' } });
    fireEvent.change(screen.getByLabelText('المطوّر'), { target: { value: 'أنا' } });
    fireEvent.change(screen.getByLabelText('عنوان الويبهوك *'), { target: { value: 'https://example.com/hooks/zaki' } });
  };

  it('— each event is a labelled tick box, the first one ticked as before', async () => {
    await open();
    const first = screen.getByRole('checkbox', { name: /طلب جديد/ }) as HTMLInputElement;
    const second = screen.getByRole('checkbox', { name: /تسليم/ }) as HTMLInputElement;
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(false);
    expect(first.id).not.toBe(second.id);
  });

  it('— «سجّل» sends the same body it always sent: the fields, the code upper-cased, and the ticked events', async () => {
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /تسليم/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'سجّل' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/apps',
      method: 'POST',
      body: JSON.stringify({
        name: 'تطبيقي',
        code: 'MY_APP',
        developerName: 'أنا',
        webhookUrl: 'https://example.com/hooks/zaki',
        description: '',
        events: ['order.created', 'order.delivered'],
      }),
    });
  });

  it('NEGATIVE: unticking every event closes «سجّل», and a press sends nothing', async () => {
    await open();
    fill();
    fireEvent.click(screen.getByRole('checkbox', { name: /طلب جديد/ }));
    const submit = screen.getByRole('button', { name: 'سجّل' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(writes()).toEqual([]);
  });

  it('NEGATIVE: «إلغاء» closes the form and submits nothing — every kit button inside the form except «سجّل» is type="button"', async () => {
    await open();
    fill();
    const form = screen.getByLabelText('اسم التطبيق *').closest('form') as HTMLFormElement;
    const buttons = within(form).getAllByRole('button');
    for (const b of buttons) {
      if (b.textContent?.includes('سجّل')) expect(b.getAttribute('type')).toBe('submit');
      else expect(b.getAttribute('type')).toBe('button');
    }
    await act(async () => {
      fireEvent.click(within(form).getByRole('button', { name: /إلغاء/ }));
    });
    expect(writes()).toEqual([]);
    expect(screen.queryByLabelText('اسم التطبيق *')).toBeNull();
  });

  it('— the secret is shown once after «سجّل», and «انسخ السرّ» copies exactly it', async () => {
    copyText.mockResolvedValue(true);
    await open();
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'سجّل' }));
    });
    await screen.findByText('whsec_test_only_value');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'انسخ السرّ' }));
    });
    expect(copyText).toHaveBeenCalledWith('whsec_test_only_value');
    expect(tell).not.toHaveBeenCalled();
  });

  it('NEGATIVE: when the browser refuses the copy, the secret is handed over by hand, not lost', async () => {
    copyText.mockResolvedValue(false);
    await open();
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'سجّل' }));
    });
    await screen.findByText('whsec_test_only_value');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'انسخ السرّ' }));
    });
    await waitFor(() => expect(tell).toHaveBeenCalledTimes(1));
    expect(tell.mock.calls[0][0]).toMatchObject({ title: 'انسخ السرّ يدوياً', value: 'whsec_test_only_value' });
  });
});

describe('the app store on a 375px phone (jsdom: the classes that make it, not a measurement)', () => {
  it('— the frame may shrink, nothing is wider than a phone, the tiles and the form are one column on a phone', async () => {
    const { container } = await ready();
    expect((container.firstElementChild as HTMLElement).className.split(/\s+/)).toContain('min-w-0');
    const src = SRC();
    expect(src).not.toMatch(/\b(min-)?w-\[\d+px\]/);
    // every grid starts at one column and widens only from the small breakpoint up
    const grids = src.match(/className="grid [^"]*"/g) ?? [];
    expect(grids.length).toBeGreaterThanOrEqual(3);
    for (const g of grids) expect(g).toContain(['grid', 'cols', '1'].join('-'));
  });
});
