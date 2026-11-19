// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «التطبيقات المثبتة» ON THE KIT (R15i, plan 17/11 — written 18/11).
 *
 * The screen moved onto `PageShell` (its name read from the menu), `Card`, and its three log filters became one `Segmented` over
 * the same `filter`. The keys panel under it moved onto `Card`, `Checkbox`, and the four kit looks.
 * What must NOT have moved with them:
 *   - the log asks the same address for each filter (`?status=FAILED`, `?status=PENDING`, none for «الكل») and only when it changes;
 *   - a system key is drawn ONCE, right after it is made, and never comes back from a load — the list shows the prefix only;
 *   - the new-key body is `{ name, system, scopes }`, the scopes exactly what is ticked, a scope this person may not put on a key
 *     cannot be ticked, and «أنشئ المفتاح» stays shut with nothing ticked or when the door says a key may not be made;
 *   - the empty sentences, the link to the app store, and «سجل الإرسال» unchanged.
 * Every claim has a negative twin. «أوقفه» asking first is `a-system-key-is-stopped-only-after-asking.test.tsx`, unedited.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`, the apps grid
 * one column on a phone, no fixed pixel width, the payload scrolling inside its own box), and the pull request says so.
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: ['apps.view'], status: 'ACTIVE' } }),
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => false) }));

import { InstalledAppsScreen } from './InstalledAppsScreen';
import { SystemTokensPanel } from '@/components/apps/SystemTokensPanel';
import { routeLabel } from '@/lib/route-registry';

vi.setConfig({ testTimeout: 15000 });

const src = (file: string) => stripComments(readFileSync(join(process.cwd(), file), 'utf8'));
const SCREEN = 'src/components/screens/InstalledAppsScreen.tsx';
const PANEL = 'src/components/apps/SystemTokensPanel.tsx';

/* ───────────────────────────── the screen ───────────────────────────── */

const DELIVERY = {
  id: 'd1',
  appCode: 'replies',
  event: 'order.created',
  url: 'https://example.test/hook',
  status: 'FAILED' as const,
  attempts: 3,
  responseCode: 500,
  error: 'رفض الخادم',
  nextAttemptAt: null,
  deliveredAt: null,
  createdAt: '2026-11-18T10:00:00.000Z',
  payload: '{"event":"order.created","n":1}',
};

let shelf: { builtIn: unknown[]; external: unknown[] };
let deliveries: unknown[];
let asked: string[];

const answerScreen = () =>
  apiJson.mockImplementation(async (url: string) => {
    asked.push(url);
    if (url === '/api/apps') return shelf;
    if (url.startsWith('/api/apps/deliveries')) return { deliveries, totals: { ok: 4, failed: 3, pending: 2 } };
    throw new Error(`unexpected request ${url}`);
  });

beforeEach(() => {
  asked = [];
  shelf = {
    builtIn: [
      { code: 'wa', name: 'واتساب', summary: 'رسائل الزبائن', settingsPath: '/settings/links', installed: true, enabled: true, configured: false },
      { code: 'off', name: 'غير مثبت', summary: '', settingsPath: '/x', installed: false, enabled: false, configured: false },
    ],
    external: [{ id: 'e1', code: 'replies', name: 'نظام الردود', webhookUrl: 'https://example.test/hook', events: ['order.created'], installed: true, enabled: false }],
  };
  deliveries = [DELIVERY];
  answerScreen();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const readyScreen = async () => {
  const view = render(<InstalledAppsScreen />);
  await screen.findByText('سجل الإرسال');
  return view;
};
const deliveryAsks = () => asked.filter((u) => u.startsWith('/api/apps/deliveries'));

describe('the installed-apps screen on the kit', () => {
  it('— one header, its name read from the menu, inside the frame', async () => {
    await readyScreen();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(routeLabel('/apps/installed')).toBe('التطبيقات المثبتة');
    expect(h1[0].textContent).toContain('التطبيقات المثبتة');
  });

  it('— the source draws the frame and the kit; the one raw button left is the log row that opens itself', () => {
    const s = src(SCREEN);
    expect(s).toMatch(/<PageShell title=\{routeLabel\('\/apps\/installed'\)\}/);
    expect(s).not.toMatch(/<PageHeader\b/);
    expect(s.match(/<button[\s>]/g) ?? []).toHaveLength(1);
    expect(s).toMatch(/<Segmented\b/);
    expect(s).not.toMatch(/variant="(outline|ghost|success)"/);
    expect(s).not.toMatch(/<form[\s>]/);
  });

  it('— installed apps only, each on a card, with its words; the one not installed is not drawn', async () => {
    await readyScreen();
    expect(screen.getByText('واتساب')).toBeTruthy();
    expect(screen.getByText('نظام الردود')).toBeTruthy();
    expect(screen.queryByText('غير مثبت')).toBeNull();
    expect(screen.getByText('مفعَّل')).toBeTruthy();
    expect(screen.getByText('موقوف')).toBeTruthy();
    expect(screen.getByText('غير مهيَّأ')).toBeTruthy();
    expect(screen.getByText('الإعدادات ←').getAttribute('href')).toBe('/settings/links');
  });

  it('— the three filters are one radio group named by «سجل الإرسال», «الكل» chosen, the counts in the same words', async () => {
    await readyScreen();
    const group = screen.getByRole('radiogroup', { name: 'سجل الإرسال' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['الكل', 'فشل 3', 'بالانتظار 2']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
  });

  it('— each filter asks its own address, once, and «الكل» asks with no status', async () => {
    await readyScreen();
    expect(deliveryAsks()).toEqual(['/api/apps/deliveries']);
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'فشل 3' }));
    });
    await waitFor(() => expect(deliveryAsks()).toEqual(['/api/apps/deliveries', '/api/apps/deliveries?status=FAILED']));
    expect(screen.getByRole('radio', { name: 'فشل 3' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'بالانتظار 2' }));
    });
    await waitFor(() => expect(deliveryAsks().at(-1)).toBe('/api/apps/deliveries?status=PENDING'));
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'الكل' }));
    });
    await waitFor(() => expect(deliveryAsks().at(-1)).toBe('/api/apps/deliveries'));
  });

  it('NEGATIVE: pressing the filter that is already chosen asks nothing again', async () => {
    await readyScreen();
    const before = deliveryAsks().length;
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'الكل' }));
    });
    expect(deliveryAsks()).toHaveLength(before);
  });

  it('— a log row opens its payload readable, and a second press closes it', async () => {
    await readyScreen();
    expect(screen.queryByText(/"n": 1/)).toBeNull();
    const row = screen.getByText('order.created', { selector: 'button span' }).closest('button')!;
    await act(async () => {
      fireEvent.click(row);
    });
    expect(screen.getByText(/"n": 1/)).toBeTruthy();
    expect(screen.getByText('3 محاولات')).toBeTruthy();
    expect(screen.getByText('HTTP 500')).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
    });
    expect(screen.queryByText(/"n": 1/)).toBeNull();
  });

  it('— the two empty sentences and the link to the store are unchanged', async () => {
    shelf = { builtIn: [], external: [] };
    deliveries = [];
    await readyScreen();
    expect(screen.getByText(/لا تطبيقات مثبتة\./)).toBeTruthy();
    expect(screen.getByText('افتح متجر التطبيقات').getAttribute('href')).toBe('/apps/store');
    expect(screen.getByText('لا إرساليات بعد — تظهر هنا عند أول حدث بعد تثبيت تطبيق يستمع إليه.')).toBeTruthy();
  });

  it('NEGATIVE: the keys panel is not drawn for a holder of the shelf key alone', async () => {
    await readyScreen();
    expect(screen.queryByText('توكنات الأنظمة')).toBeNull();
  });

  it('— a phone: the frame may shrink, the apps grid is one column first, no fixed pixel width, the payload scrolls in its box', async () => {
    const view = await readyScreen();
    await act(async () => {
      fireEvent.click(screen.getByText('order.created', { selector: 'button span' }).closest('button')!);
    });
    const root = view.container.firstElementChild as HTMLElement;
    expect(root.className.split(' ')).toContain('min-w-0');
    const grid = screen.getByText('واتساب').closest('[class*="grid"]') as HTMLElement;
    expect(grid.className.split(' ')).toContain(['grid', 'cols', '1'].join('-'));
    const fixed = new RegExp(['(^|\\s)(min-)?w-\\[', '\\d{3,}', 'px\\]'].join(''));
    for (const el of view.container.querySelectorAll('*')) expect(String(el.getAttribute('class') ?? '')).not.toMatch(fixed);
    const pre = view.container.querySelector('pre') as HTMLElement;
    expect(pre.className.split(' ')).toContain(['overflow', 'x', 'auto'].join('-'));
  });
});

/* ───────────────────────────── the keys panel ───────────────────────────── */

const ISSUED = ['zk', 'test', 'shown', 'once', 'abc123'].join('_');

const PANEL_SHELF = () => ({
  scopeCatalog: [
    { key: 'orders:read', ar: 'قراءة الطلبات' },
    { key: 'orders:write', ar: 'إنشاء الطلبات' },
    { key: 'customers:read', ar: 'قراءة الزبائن', mintable: false, needsAr: 'عرض الزبائن' },
  ],
  mayMint: true,
  repliesScopes: ['orders:read', 'orders:write', 'customers:read'],
  systems: [
    { key: 'replies', ar: 'نظام الردود', scopes: ['orders:read', 'orders:write'], rateLimitPerMin: 60 },
    { key: 'mediabuyer', ar: 'الميديا باير', scopes: ['orders:read'], rateLimitPerMin: 30 },
  ],
  defaultDays: 90,
  tokens: [
    {
      id: 't1',
      name: 'مفتاح قديم',
      system: 'replies',
      prefix: 'zk_ab12',
      scopes: ['orders:read'],
      rateLimitPerMin: 60,
      expiresAt: null,
      lastUsedAt: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      state: 'ACTIVE',
      // a door that ever leaked the value would be drawn nowhere: the row reads the prefix only
      secret: ISSUED,
    },
  ],
});

let panelShelf: ReturnType<typeof PANEL_SHELF>;
let posted: { body: Record<string, unknown> }[];

const answerPanel = () =>
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (url !== '/api/settings/system-tokens') throw new Error(`unexpected request ${url}`);
    if ((init?.method ?? 'GET') === 'POST') {
      posted.push({ body: JSON.parse(init!.body!) });
      return { secret: ISSUED, notice: 'انسخه الآن — لن يُعرض مرة ثانية.' };
    }
    return panelShelf;
  });

const readyPanel = async () => {
  posted = [];
  panelShelf = PANEL_SHELF();
  answerPanel();
  const view = render(<SystemTokensPanel />);
  await screen.findByText('مفتاح قديم');
  return view;
};
const openForm = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /مفتاح جديد/ }));
  });
const createKey = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'أنشئ المفتاح' }));
  });
const box = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe('the system keys panel on the kit', () => {
  it('— the source: Card and Checkbox, the four kit looks, no raw tick box and no raw button', () => {
    const s = src(PANEL);
    expect(s).toMatch(/<Checkbox\b/);
    expect(s).not.toMatch(/type="checkbox"/);
    expect(s).not.toMatch(/<button[\s>]/);
    expect(s).not.toMatch(/variant="(outline|ghost|success)"/);
    expect(s).not.toMatch(/<form[\s>]/);
  });

  it('SECRET: after a load no key is drawn — the row shows its prefix only, and no field holds the key', async () => {
    const view = await readyPanel();
    expect(view.container.textContent).not.toContain(ISSUED);
    expect(screen.getByText('zk_ab12…')).toBeTruthy();
    expect(view.container.querySelector('code')).toBeNull();
    await openForm();
    for (const input of view.container.querySelectorAll('input')) expect((input as HTMLInputElement).value).not.toContain(ISSUED);
    expect((screen.getByLabelText('اسم المفتاح') as HTMLInputElement).value).toBe('نظام الردود');
  });

  it('SECRET: a made key is drawn once, «أخفِه» takes it away, and the load after it does not bring it back', async () => {
    const view = await readyPanel();
    await openForm();
    await createKey();
    await waitFor(() => expect(view.container.querySelector('code')?.textContent).toBe(ISSUED));
    expect(screen.getByText(/انسخه الآن/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أخفِه' }));
    });
    expect(view.container.textContent).not.toContain(ISSUED);
    expect(view.container.querySelector('code')).toBeNull();
  });

  it('— the scope boxes: the replies default ticked, each its own id, the one this person may not put on a key shut and clear', async () => {
    await readyPanel();
    await openForm();
    expect(box('قراءة الطلبات').checked).toBe(true);
    expect(box('إنشاء الطلبات').checked).toBe(true);
    expect(box('قراءة الزبائن').checked).toBe(false);
    expect(box('قراءة الزبائن').disabled).toBe(true);
    expect(box('قراءة الطلبات').id).toBe('scope-orders:read');
    expect(box('إنشاء الطلبات').id).toBe('scope-orders:write');
    expect(screen.getByText(/مش متاح لك:/).textContent).toContain('قراءة الزبائن (يحتاج «عرض الزبائن»)');
  });

  it('— «أنشئ المفتاح» sends { name, system, scopes } with exactly the ticked scopes, once', async () => {
    await readyPanel();
    await openForm();
    await act(async () => {
      fireEvent.click(box('إنشاء الطلبات'));
    });
    expect(box('إنشاء الطلبات').checked).toBe(false);
    await createKey();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ name: 'نظام الردود', system: 'replies', scopes: ['orders:read'] });
  });

  it('NEGATIVE: a scope in the replies defaults that this person may not put on a key is neither ticked nor sent', async () => {
    // (Not pressed: jsdom delivers a click to a shut box, which no browser does. `disabled` is what keeps the press out.)
    await readyPanel();
    await openForm();
    expect(box('قراءة الزبائن').disabled).toBe(true);
    expect(box('قراءة الزبائن').checked).toBe(false);
    await createKey();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body.scopes).toEqual(['orders:read', 'orders:write']);
  });

  it('— picking another system resets the name and the scopes to its own', async () => {
    await readyPanel();
    await openForm();
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /الميديا باير/ }));
    });
    expect((screen.getByLabelText('اسم المفتاح') as HTMLInputElement).value).toBe('الميديا باير');
    expect(box('إنشاء الطلبات').checked).toBe(false);
    await createKey();
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].body).toEqual({ name: 'الميديا باير', system: 'mediabuyer', scopes: ['orders:read'] });
  });

  it('NEGATIVE: with nothing ticked «أنشئ المفتاح» is shut and a press sends nothing', async () => {
    await readyPanel();
    await openForm();
    await act(async () => {
      fireEvent.click(box('قراءة الطلبات'));
      fireEvent.click(box('إنشاء الطلبات'));
    });
    const make = screen.getByRole('button', { name: 'أنشئ المفتاح' }) as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    await createKey();
    expect(posted).toEqual([]);
  });

  it('NEGATIVE: when the door says no key may be made here, «أنشئ المفتاح» is shut and says why', async () => {
    posted = [];
    panelShelf = { ...PANEL_SHELF(), mayMint: false };
    answerPanel();
    render(<SystemTokensPanel />);
    await screen.findByText('مفتاح قديم');
    await openForm();
    expect((screen.getByRole('button', { name: 'أنشئ المفتاح' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/فإصداره بدّه دخول كل الدول والمتاجر/)).toBeTruthy();
    await createKey();
    expect(posted).toEqual([]);
  });

  it('— the empty sentence is unchanged', async () => {
    posted = [];
    panelShelf = { ...PANEL_SHELF(), tokens: [] };
    answerPanel();
    render(<SystemTokensPanel />);
    expect(await screen.findByText('لا مفاتيح بعد — أنشئ واحداً والصقه في إعدادات النظام الخارجي.')).toBeTruthy();
  });
});
