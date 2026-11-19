// @vitest-environment jsdom
import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

/**
 * «الحملات» (R14b, 18/11): THE SCREEN ON THE KIT, AND THE ONE SPAN OF DAYS OF THE REPORT TABS.
 *
 *   • Every period button sends EXACTLY the query string it sent on osm/main (`period=<key>`), a picked range still wins
 *     (`startDate=&endDate=`), and a period button still clears it. The server's keys (`campaign-window.ts`) are not touched.
 *   • The range is read at mount — the address, then the one stored key, else the screen's own `period=today` — and
 *     written on every change. Nothing is asked before it is read, so the screen never asks twice.
 *   • A storage the browser refuses is «today» and no crash.
 *   • The shape: the kit's frame (the registry's name), kit buttons with a type, named icon buttons, nothing wider than a phone.
 *
 * The real `useLiveRefresh` runs here (the other screen tests mock it), so «asked once» is the hook's own behaviour.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    currentUser: { id: 'u1', name: 'م', role: 'MODERATOR', status: 'ACTIVE', permissions: ['campaigns.view', 'campaigns.manage'] },
  }),
}));

import { CampaignsScreen } from './CampaignsScreen';
import { presetRange } from '@/components/ui/DateRange';
import { REPORT_RANGE_KEY, writeReportRange } from '@/lib/report-range';

const campaign = {
  id: 'c-1', name: 'حملة الصيف', platform: 'META', code: 'ABC123', status: 'ACTIVE',
  spendSource: 'MANUAL', adAccount: null, externalId: null, lastSyncAt: null,
  startDate: '2026-10-01T00:00:00.000Z', endDate: null, notes: null,
  landingPage: null, product: null, productId: null,
  link: 'https://shop.example/?c=ABC123', ranInWindow: true,
  funnel: { brought: 4, confirmed: 3, rejected: 0, delivered: 2, returned: 0, confirmationRate: 75, deliveryRate: 50 },
  money: { spend: 100, revenue: 250, net: 150, roas: 2.5, costPerDelivered: 50, costPerOrder: 25 },
};
const totals = { spend: 100, revenue: 250, net: 150, roas: 2.5, costPerDelivered: 50, costPerOrder: 25, brought: 4, delivered: 2 };

const asked: string[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url.startsWith('/api/growth/campaigns?')) {
    asked.push(url);
    return { ok: true, json: async () => ({ campaigns: [campaign], totals, currency: 'USD', adAccounts: [], definitions: {}, insights: null }) };
  }
  if (url === '/api/landing-pages') return { ok: true, json: async () => ({ pages: [] }) };
  throw new Error(`unexpected fetch ${url}`);
});

beforeEach(() => {
  asked.length = 0;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/growth/campaigns');
  vi.stubGlobal('fetch', fetchMock);
  apiJson.mockImplementation(async (url: string) => (url.startsWith('/api/products') ? { products: [] } : { success: true }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount() {
  render(<CampaignsScreen />);
  await screen.findByText('حملة الصيف');
  await act(async () => {});
}
const strip = () => within(screen.getByRole('group', { name: 'المدة' }));
const last = () => asked.at(-1);

/* The query each period button sent on osm/main — `period=${p.key}`, the keys of `campaign-window.ts`. */
const TABLE: [string, string][] = [
  ['اليوم', '/api/growth/campaigns?period=today'],
  ['أمس', '/api/growth/campaigns?period=yesterday'],
  ['7 أيام', '/api/growth/campaigns?period=7d'],
  ['30 يوماً', '/api/growth/campaigns?period=30d'],
  ['هذا الشهر', '/api/growth/campaigns?period=month'],
  ['الشهر الماضي', '/api/growth/campaigns?period=last_month'],
  ['كل الوقت', '/api/growth/campaigns?period=all'],
];

describe('each choice asks the very query osm/main asked', () => {
  it('opens on period=today when nothing is stored — and asks exactly once', async () => {
    await mount();
    expect(asked).toEqual(['/api/growth/campaigns?period=today']);
  });

  it.each(TABLE)('«%s» → %s', async (label, query) => {
    await mount();
    // From another period first, so «اليوم» is a real change too.
    await act(async () => { fireEvent.click(strip().getByRole('button', { name: label === 'كل الوقت' ? 'أمس' : 'كل الوقت' })); });
    await act(async () => { fireEvent.click(strip().getByRole('button', { name: label })); });
    await waitFor(() => expect(last()).toBe(query));
    expect(strip().getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a picked range wins (startDate/endDate), is written to the one key, and a period button clears both', async () => {
    await mount();
    const y = presetRange('yesterday')!;
    // The date box: open it and take its own «أمس» — a picked range, not the strip's period.
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /من — إلى/ })); });
    const pop = screen.getByRole('button', { name: /من — إلى/ }).parentElement!;
    await act(async () => { fireEvent.click(within(pop).getAllByRole('button', { name: 'أمس' }).at(-1)!); });
    await waitFor(() => expect(last()).toBe(`/api/growth/campaigns?startDate=${y.from}&endDate=${y.to}`));
    expect(JSON.parse(sessionStorage.getItem(REPORT_RANGE_KEY)!)).toEqual(y);
    // While a range is picked no period reads as chosen.
    for (const [label] of TABLE) expect(strip().getByRole('button', { name: label }).getAttribute('aria-pressed')).toBe('false');

    await act(async () => { fireEvent.click(strip().getByRole('button', { name: '7 أيام' })); });
    await waitFor(() => expect(last()).toBe('/api/growth/campaigns?period=7d'));
    expect(sessionStorage.getItem(REPORT_RANGE_KEY)).toBeNull();
  });

  it('the window line itself is byte-for-byte the one on osm/main', () => {
    const src = readFileSync(path.join(process.cwd(), 'src', 'components', 'screens', 'CampaignsScreen.tsx'), 'utf8');
    expect(src).toContain(
      'const windowQuery = range.from && range.to ? `startDate=${range.from}&endDate=${range.to}` : `period=${period}`;'
    );
    expect(src).toContain(`const [period, setPeriod] = useState<string>('today');`);
  });
});

describe('the shared range', () => {
  it('a range another report tab stored opens here — asked once, with its days', async () => {
    writeReportRange({ from: '2026-11-01', to: '2026-11-10' });
    await mount();
    expect(asked).toEqual(['/api/growth/campaigns?startDate=2026-11-01&endDate=2026-11-10']);
  });

  it('the address wins over the stored key, and a change keeps the address in step', async () => {
    writeReportRange({ from: '2026-11-01', to: '2026-11-10' });
    window.history.replaceState(null, '', '/growth/campaigns?from=2026-10-01&to=2026-10-31');
    await mount();
    expect(asked).toEqual(['/api/growth/campaigns?startDate=2026-10-01&endDate=2026-10-31']);
    await act(async () => { fireEvent.click(strip().getByRole('button', { name: 'أمس' })); });
    await waitFor(() => expect(last()).toBe('/api/growth/campaigns?period=yesterday'));
    // NEGATIVE: the address no longer carries the span the person left, so a reload does not bring it back.
    expect(window.location.search).toBe('');
  });

  it('NEGATIVE: a storage that throws is «today» and no crash', async () => {
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!;
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: () => { throw new Error('blocked'); } });
    try {
      await mount();
      expect(asked).toEqual(['/api/growth/campaigns?period=today']);
      await act(async () => { fireEvent.click(strip().getByRole('button', { name: '30 يوماً' })); });
      await waitFor(() => expect(last()).toBe('/api/growth/campaigns?period=30d'));
    } finally {
      Object.defineProperty(window, 'sessionStorage', real);
    }
  });

  it('NEGATIVE: a broken stored value is ignored — the screen opens on its own today', async () => {
    sessionStorage.setItem(REPORT_RANGE_KEY, '{"from":"2026-11-10","to":"2026-11-01"}');
    await mount();
    expect(asked).toEqual(['/api/growth/campaigns?period=today']);
  });
});

describe('the shape', () => {
  it('the kit frame draws the registry’s name as the one heading', async () => {
    await mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('الحملات');
  });

  it('the strip and the row buttons are kit buttons with a type — none can submit a form', async () => {
    await mount();
    for (const [label] of TABLE) expect(strip().getByRole('button', { name: label }).getAttribute('type')).toBe('button');
    for (const name of ['تعديل', 'حذف']) {
      const b = screen.getByRole('button', { name });
      expect(b.getAttribute('type')).toBe('button');
      expect(b.getAttribute('title')).toBe(name); // IconButton: the name is said and shown
    }
    expect(screen.getByText('رابط الإعلان').closest('button')!.getAttribute('type')).toBe('button');
  });

  it('the editor closes from a named icon button', async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /حملة جديدة/ })[0]); });
    const close = screen.getByRole('button', { name: 'إغلاق' });
    // 19/11 (R19b): the editor is the kit's `Modal` now, so «إغلاق» is the Modal's own button. It sets no `type`, and that
    // is safe because the editor holds no form: its save button is in the footer and runs a handler, never a submit. The old
    // line asserted the type of a hand-made close; the guard that matters is «this button cannot submit anything».
    expect(close.closest('form'), 'الإغلاق ما لازم يكون جوّا نموذج').toBeNull();
    await act(async () => { fireEvent.click(close); });
    expect(screen.queryByRole('button', { name: 'إغلاق' })).toBeNull();
  });

  it('the figures are the same numbers, now in the kit tiles', async () => {
    await mount();
    for (const label of ['أُنفق', 'عاد', 'الفرق', 'العائد على الإنفاق', 'طلبات · وصلت']) {
      expect(screen.getAllByText(label).length, label).toBeGreaterThan(0);
    }
    expect(screen.getByText('100 USD')).toBeTruthy();
    expect(screen.getByText('250 USD')).toBeTruthy();
    expect(screen.getByText('150 USD')).toBeTruthy();
    expect(screen.getAllByText('2.5×').length).toBe(2); // the shop's tile and the row's cell
    expect(screen.getByText('4 · 2')).toBeTruthy();
    expect(screen.getByText('قبل كلفة البضاعة والتوصيل')).toBeTruthy();
  });

  it('on a phone (375px): no element asks for a fixed width wider than the screen', async () => {
    await mount();
    const fixed = new RegExp('(?:^|\\s)(?:min-)?' + 'w' + '-\\[(\\d+(?:\\.\\d+)?)(px|rem)\\]');
    const tooWide: string[] = [];
    for (const el of document.body.querySelectorAll<HTMLElement>('[class]')) {
      const m = fixed.exec(el.getAttribute('class') ?? '');
      if (!m) continue;
      const px = m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
      if (px > 375) tooWide.push(el.getAttribute('class')!);
    }
    expect(tooWide).toEqual([]);
    // The two rows of buttons wrap instead of pushing the page sideways.
    expect(screen.getByRole('group', { name: 'المدة' }).getAttribute('class')).toMatch(/(?:^|\s)flex-wrap(?:\s|$)/);
  });
});
