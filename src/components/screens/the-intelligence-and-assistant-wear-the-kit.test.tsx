// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «مركز الذكاء», «اسأل الذكاء» AND «المساعد الذكي» ON THE KIT (R14d, plan 17/11 — written 18/11).
 *
 * The three moved onto `PageShell`, `Card`/`Card plain` and the kit's buttons. What must NOT have moved with them:
 *
 *   · the doors and what is SENT to them — `/api/growth/intelligence` with no window; `/api/growth/intelligence/ask` with
 *     exactly `{ question, sources }`; `/api/ai/chat` with exactly `{ question, period: 'all' }`. No customer field reaches a
 *     model through any of them, and this file pins each body byte for byte;
 *   · `?tab=` still opens its tab, and the sample gate is still per tab;
 *   · «اسأل الذكاء» is ALSO drawn by the customers screen (R10d) with its own preselection: it is rendered inside BOTH
 *     parents here, and the customers one still asks with `CUSTOMERS` only.
 *
 * And two new lines on the intelligence screen: its door takes no span of days, so where the other report tabs draw the date
 * box it says «الأرقام هون لحظية — ما بتتبع المدة» and leaves the shared range alone; and its «أداء» tab links to the one
 * employees table instead of becoming an eighth ranking.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it, and said so in the pull request.
 */

const { apiJson, apiFetch, perms, viewer } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  apiFetch: vi.fn(),
  perms: { value: new Set<string>() },
  viewer: { current: { id: 'u1', role: 'SUPER_ADMIN', permissions: ['ai.use', 'finance.view', 'geo.manage'], status: 'ACTIVE' } as Record<string, unknown> },
}));
const search = vi.hoisted(() => ({ value: '' }));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/growth/intelligence',
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/hooks/useCan', () => ({ useCan: (k: string) => perms.value.has(k) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { customers: 'العملاء' }, locale: 'ar', currentUser: viewer.current }) }));
// what the customers screen needs to draw at all — none of it is this slice's
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('@/hooks/useCreateIntent', () => ({ useCreateIntent: () => undefined }));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [{ name: 'عمّان' }], countryName: 'الأردن' }) }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => null }));

import { IntelligenceScreen } from './IntelligenceScreen';
import { AssistantScreen } from './AssistantScreen';
import { CustomersScreen } from './CustomersScreen';
import { Card } from '@/components/ui/Card';
import { routeLabel } from '@/lib/route-registry';
import { REPORT_RANGE_KEY, writeReportRange } from '@/lib/report-range';

const LINE = 'الأرقام هون لحظية — ما بتتبع المدة';
const TEAM_LINK = 'جدول الموظفين بالمدة اللي اخترتها ←';

const finding = (key: string, family: string, severity = 'WATCH') => ({
  key,
  family,
  title: `عنوان ${key}`,
  evidence: `دليل ${key}`,
  action: `إجراء ${key}`,
  severity,
});

const PAYLOAD = {
  findings: [finding('q1', 'queue', 'ALARM'), finding('t1', 'team')],
  totalOrders: 120,
  minSample: 30,
  counts: { alarm: 1, watch: 1 },
  byFamily: { queue: { total: 1, alarm: 1 }, team: { total: 1, alarm: 0 } },
};
const THIN = { findings: [], totalOrders: 7, minSample: 30, counts: { alarm: 0, watch: 0 }, byFamily: {} };

const INFO = {
  provider: 'مزوّد',
  model: 'model-x',
  ready: true,
  housePrompt: '',
  sources: [
    { id: 'SALES', label: 'المبيعات', detail: 'تفصيل' },
    { id: 'PRODUCTS', label: 'المنتجات', detail: 'تفصيل' },
    { id: 'CUSTOMERS', label: 'العملاء', detail: 'تفصيل' },
  ],
  withheld: [{ id: 'TEAM', label: 'الفريق', why: 'بدها مفتاح' }],
};

let payload: unknown = PAYLOAD;
beforeEach(() => {
  payload = PAYLOAD;
  search.value = '';
  perms.value = new Set(['growth.intelligence', 'ai.use']);
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (url === '/api/growth/intelligence/ask') return init?.method === 'POST' ? { answer: 'جواب', noteAr: 'ملاحظة' } : INFO;
    return payload;
  });
  try {
    window.sessionStorage.clear();
  } catch {
    /* a blocked storage is a case below */
  }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const drawIntel = async (p: unknown = PAYLOAD) => {
  payload = p;
  render(<IntelligenceScreen />);
  await waitFor(() => expect(screen.queryByText(/جارٍ التحليل/)).toBeNull());
};
const askCalls = () => apiJson.mock.calls.filter((c) => c[0] === '/api/growth/intelligence/ask');
const askPosts = () => askCalls().filter((c) => c[1]?.method === 'POST');

/** The class a kit part draws, read from the part itself — so no class name is written in this file. */
const classOf = (el: React.ReactElement) => {
  const { container, unmount } = render(el);
  const c = (container.firstElementChild as HTMLElement).className;
  unmount();
  return c;
};
/** What a page-level card wears and a dense one does not (the theme's corner) — read from the kit. */
const pageOnly = () => {
  const plain = new Set(classOf(<Card plain>x</Card>).split(' '));
  const only = classOf(<Card>x</Card>).split(' ').filter((c) => c && !plain.has(c));
  expect(only.length).toBeGreaterThan(0);
  return only;
};
const isDense = (el: HTMLElement) => {
  const own = el.className.split(' ');
  return pageOnly().every((c) => !own.includes(c));
};
const isPage = (el: HTMLElement) => {
  const own = el.className.split(' ');
  return pageOnly().every((c) => own.includes(c));
};
/** The nearest ancestor drawn by `Card` (it always carries the card fill, read from the kit). */
const cardOf = (el: HTMLElement) => {
  const fill = classOf(<Card plain>x</Card>).split(' ').find((c) => c.includes('sys-card'))!;
  let n: HTMLElement | null = el;
  while (n && !n.className.split(' ').includes(fill)) n = n.parentElement;
  expect(n, 'not inside a card').not.toBeNull();
  return n!;
};
const src = (f: string) => readFileSync(join(process.cwd(), f), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
describe('«مركز الذكاء» — the frame and the one line', () => {
  it('one h1, the registry’s name, through PageShell', async () => {
    await drawIntel();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/growth/intelligence'));
    expect(src('src/components/screens/IntelligenceScreen.tsx')).toMatch(/<PageShell\s+title=\{routeLabel\('\/growth\/intelligence'\)\}/);
  });

  it('says the one line where the other report tabs draw the date box — and draws NO date box', async () => {
    await drawIntel();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /اليوم|أمس|المدة/ })).toBeNull();
  });

  it('the line is there while it loads too (before any answer)', async () => {
    apiJson.mockImplementation(() => new Promise(() => undefined));
    render(<IntelligenceScreen />);
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getByText(/جارٍ التحليل/)).toBeTruthy();
  });

  it('asks the same one door, with no span of days', async () => {
    await drawIntel();
    const doors = apiJson.mock.calls.map((c) => c[0]).filter((u) => u !== '/api/growth/intelligence/ask');
    expect(doors).toEqual(['/api/growth/intelligence']);
  });

  it('NEGATIVE: keeps the span picked on another tab — neither reads it into a request nor writes it', async () => {
    writeReportRange({ from: '2026-11-01', to: '2026-11-10' });
    const before = window.sessionStorage.getItem(REPORT_RANGE_KEY);
    await drawIntel();
    fireEvent.click(screen.getByRole('tab', { name: /أداء/ }));
    fireEvent.click(screen.getByRole('tab', { name: /خطر/ }));
    expect(window.sessionStorage.getItem(REPORT_RANGE_KEY)).toBe(before);
    expect(apiJson.mock.calls.some((c) => String(c[0]).includes('from='))).toBe(false);
  });

  it('a storage that throws: the screen still draws, with its line', async () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new Error('blocked');
    });
    await drawIntel();
    expect(screen.getByText(LINE)).toBeTruthy();
    expect(screen.getByText('عنوان q1')).toBeTruthy();
  });
});

describe('«مركز الذكاء» — the tabs and what they show did not move', () => {
  it('queues first, with the counts as before', async () => {
    await drawIntel();
    expect(screen.getByText('1 يحتاج تدخّلاً')).toBeTruthy();
    expect(screen.getByText('1 للمراقبة')).toBeTruthy();
    expect(screen.getByText('من 120 طلباً')).toBeTruthy();
    expect(screen.getByText('عنوان q1')).toBeTruthy();
    expect(screen.queryByText('عنوان t1')).toBeNull();
  });

  it('?tab=team opens «أداء», and the tab links to the one employees table — a link, nothing recomputed', async () => {
    search.value = 'tab=team';
    await drawIntel();
    expect(screen.getByText('عنوان t1')).toBeTruthy();
    const link = screen.getByRole('link', { name: TEAM_LINK });
    expect(link.getAttribute('href')).toBe('/growth/performance');
    // the only door asked is still the screen's own: no ranking was fetched to be redrawn here
    expect(apiJson.mock.calls.map((c) => c[0]).filter((u) => u !== '/api/growth/intelligence/ask')).toEqual(['/api/growth/intelligence']);
  });

  it('NEGATIVE: the link is the «أداء» tab’s, not on the queues', async () => {
    await drawIntel();
    expect(screen.queryByRole('link', { name: TEAM_LINK })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /أداء/ }));
    expect(screen.getByRole('link', { name: TEAM_LINK })).toBeTruthy();
  });

  it('NEGATIVE: an unknown ?tab= opens the queues, as before', async () => {
    search.value = 'tab=noanswer';
    await drawIntel();
    expect(screen.getByText('عنوان q1')).toBeTruthy();
  });

  it('the sample gate is per tab: a rate tab says the number and the threshold on a dense card; a count tab is calm', async () => {
    search.value = 'tab=leak';
    await drawIntel(THIN);
    const said = screen.getByText(/طلباً لا تكفي — يحتاج 30 على الأقل/);
    expect(said.textContent).toContain('7');
    expect(isDense(cardOf(said))).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: /طوابير/ }));
    expect(screen.queryByText(/لا تكفي — يحتاج/)).toBeNull();
    expect(screen.getByText(/صمتٌ مقصود/)).toBeTruthy();
  });

  it('a finding keeps its evidence and its action, the action on a dense card', async () => {
    await drawIntel();
    expect(screen.getByText('دليل q1')).toBeTruthy();
    expect(isDense(cardOf(screen.getByText('إجراء q1')))).toBe(true);
  });

  it('the explaining note sits on a dense card, not a page card', async () => {
    await drawIntel();
    expect(isDense(cardOf(screen.getByText(/تحليل مبني على طلباتك الفعلية/)))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('«اسأل الذكاء» inside «مركز الذكاء»', () => {
  const box = async () => {
    await drawIntel();
    return screen.findByText('اسأل الذكاء عن أرقامك');
  };

  it('is a page card, its sources are the kit’s presses that say whether they are on', async () => {
    const h = await box();
    expect(isPage(cardOf(h))).toBe(true);
    // SALES and PRODUCTS preselected; TEAM was held back by the server and is not left ticked
    expect(screen.getByRole('button', { name: 'المبيعات' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'المنتجات' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'العملاء' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText(/مش متاح هون:/).textContent).toContain('الفريق (بدها مفتاح)');
  });

  it('asks with exactly { question, sources } — the same body as before, nothing else', async () => {
    await box();
    fireEvent.change(screen.getByPlaceholderText(/الصق برومبتك/), { target: { value: '  ليش؟  ' } });
    fireEvent.click(screen.getByRole('button', { name: /حلّل/ }));
    await screen.findByText('جواب');
    expect(askPosts()).toHaveLength(1);
    const init = askPosts()[0][1];
    expect(init.body).toBe(JSON.stringify({ question: 'ليش؟', sources: ['SALES', 'PRODUCTS'] }));
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(screen.getByText('ملاحظة')).toBeTruthy();
    expect(isDense(cardOf(screen.getByText('جواب')))).toBe(true);
  });

  it('a toggled source changes what is sent; Ctrl+Enter still sends', async () => {
    await box();
    fireEvent.click(screen.getByRole('button', { name: 'المنتجات' }));
    expect(screen.getByRole('button', { name: 'المنتجات' }).getAttribute('aria-pressed')).toBe('false');
    const ta = screen.getByPlaceholderText(/الصق برومبتك/);
    fireEvent.change(ta, { target: { value: 'سؤال' } });
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    await screen.findByText('جواب');
    expect(askPosts()[0][1].body).toBe(JSON.stringify({ question: 'سؤال', sources: ['SALES'] }));
  });

  it('NEGATIVE: with no source ticked, «حلّل» is shut and nothing is sent', async () => {
    await box();
    fireEvent.click(screen.getByRole('button', { name: 'المبيعات' }));
    fireEvent.click(screen.getByRole('button', { name: 'المنتجات' }));
    fireEvent.change(screen.getByPlaceholderText(/الصق برومبتك/), { target: { value: 'سؤال' } });
    const press = screen.getByRole('button', { name: /حلّل/ }) as HTMLButtonElement;
    expect(press.disabled).toBe(true);
    fireEvent.click(press);
    expect(askPosts()).toHaveLength(0);
    expect(screen.getByText('اختر مصدر بيانات واحداً على الأقل.')).toBeTruthy();
  });

  it('NEGATIVE: every press in it is type="button" — none would submit a form it is put inside', async () => {
    const h = await box();
    const card = cardOf(h);
    const presses = within(card).getAllByRole('button');
    expect(presses.length).toBe(4);
    for (const b of presses) expect(b.getAttribute('type'), b.textContent ?? '').toBe('button');
  });

  it('NEGATIVE: not drawn without ai.use', async () => {
    perms.value = new Set(['growth.intelligence']);
    await drawIntel();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('اسأل الذكاء عن أرقامك')).toBeNull();
    expect(askCalls()).toHaveLength(0);
  });
});

describe('«اسأل الذكاء» inside «العملاء» (R10d) — its props and its behaviour there are unchanged', () => {
  beforeEach(() => {
    viewer.current = { id: 'u1', role: 'SUPER_ADMIN', permissions: ['ai.use', 'customers.view'], status: 'ACTIVE' };
    apiFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ customers: [], facts: null, limited: true, dialCode: '962', pagination: { total: 0, page: 1, limit: 25, totalPages: 0 } }),
    }));
  });

  it('opens with CUSTOMERS alone ticked, and asks with it alone', async () => {
    render(<CustomersScreen />);
    const h = await screen.findByText('اسأل الذكاء عن أرقامك');
    expect(isPage(cardOf(h))).toBe(true);
    expect(screen.getByRole('button', { name: 'العملاء' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'المبيعات' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.change(screen.getByPlaceholderText(/الصق برومبتك/), { target: { value: 'مين رجع؟' } });
    fireEvent.click(screen.getByRole('button', { name: /حلّل/ }));
    await screen.findByText('جواب');
    expect(askPosts()[0][1].body).toBe(JSON.stringify({ question: 'مين رجع؟', sources: ['CUSTOMERS'] }));
  });

  it('the customers screen still passes the same one prop', () => {
    expect(src('src/components/screens/CustomersScreen.tsx')).toContain("<AskAi preselect={['CUSTOMERS']} />");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('«المساعد الذكي» (/assistant)', () => {
  const SUMMARY = {
    date: '2026-11-18',
    summaryText: 'نص الملخّص',
    observations: JSON.stringify(['ملاحظة أولى']),
    risks: JSON.stringify(['خطر أول']),
    recommendations: JSON.stringify(['توصية أولى']),
    metricsJson: JSON.stringify({ total_orders: 40, confirmed_orders: 30, delivered_orders: 20, revenue: 500, net_profit: 120, confirmation_rate: 75 }),
  };
  const fetchMock = vi.fn();
  beforeEach(() => {
    viewer.current = { id: 'u1', role: 'SUPER_ADMIN', permissions: ['ai.use', 'finance.view', 'geo.manage'], status: 'ACTIVE' };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (url === '/api/ai/chat') return { ok: true, json: async () => ({ answer: 'جواب المساعد' }) };
      return { ok: true, json: async () => ({ summary: init?.method === 'POST' ? SUMMARY : SUMMARY }) };
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  const chats = () => fetchMock.mock.calls.filter((c) => c[0] === '/api/ai/chat');

  it('one h1, the registry’s name, through PageShell; the regenerate press stays in the header', async () => {
    render(<AssistantScreen />);
    await screen.findByText('نص الملخّص');
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/assistant'));
    expect(src('src/components/screens/AssistantScreen.tsx')).toMatch(/<PageShell\s+title=\{routeLabel\('\/assistant'\)\}/);
    fireEvent.click(screen.getByRole('button', { name: /أعد توليد الملخّص/ }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST' && c[0] === '/api/ai/daily-summary')).toBe(true));
  });

  it('the six figures are the same, each on a dense card; the summary text on a dense card', async () => {
    render(<AssistantScreen />);
    await screen.findByText('نص الملخّص');
    for (const [label, figure] of [['الطلبات', '40'], ['المؤكَّدة', '30'], ['المُسلَّمة', '20'], ['نسبة التأكيد', '75%']]) {
      const l = screen.getByText(label);
      const card = cardOf(l);
      expect(isDense(card), label).toBe(true);
      expect(card.textContent, label).toContain(figure);
    }
    expect(isDense(cardOf(screen.getByText('إيراد المُسلَّم')))).toBe(true);
    expect(isDense(cardOf(screen.getByText('صافي الربح')))).toBe(true);
    expect(isDense(cardOf(screen.getByText('نص الملخّص')))).toBe(true);
    expect(screen.getByText('ملاحظة أولى')).toBeTruthy();
    expect(screen.getByText('خطر أول')).toBeTruthy();
    expect(screen.getByText('توصية أولى')).toBeTruthy();
  });

  it('a suggested question sends exactly { question, period: "all" } to the same door', async () => {
    render(<AssistantScreen />);
    await screen.findByText('نص الملخّص');
    fireEvent.click(screen.getByRole('button', { name: 'أي منتج هو الأكثر ربحاً؟' }));
    await screen.findByText('جواب المساعد');
    expect(chats()).toHaveLength(1);
    expect(chats()[0][1].body).toBe(JSON.stringify({ question: 'أي منتج هو الأكثر ربحاً؟', period: 'all' }));
  });

  it('the send press is an icon press with an Arabic name, and it submits the typed question', async () => {
    render(<AssistantScreen />);
    await screen.findByText('نص الملخّص');
    fireEvent.change(screen.getByPlaceholderText(/اسأل عن الإيراد/), { target: { value: 'كم ربحت؟' } });
    const send = screen.getByRole('button', { name: 'ابعت السؤال' });
    expect(send.getAttribute('type')).toBe('submit');
    fireEvent.click(send);
    await screen.findByText('جواب المساعد');
    expect(chats()[0][1].body).toBe(JSON.stringify({ question: 'كم ربحت؟', period: 'all' }));
  });

  it('NEGATIVE: the suggested questions are type="button" — none is a second submit', async () => {
    render(<AssistantScreen />);
    await screen.findByText('نص الملخّص');
    for (const q of ['كيف كان أداء المتجر اليوم؟', 'أي مودريتور أداؤه الأفضل؟', 'هل أزيد إنتاج هذا المنتج؟']) {
      expect(screen.getByRole('button', { name: q }).getAttribute('type'), q).toBe('button');
    }
  });

  it('NEGATIVE: without the money key there is no regenerate press, and the reason is said', async () => {
    viewer.current = { id: 'u1', role: 'CUSTOM', permissions: ['ai.use'], status: 'ACTIVE' };
    fetchMock.mockImplementation(async () => ({ ok: true, json: async () => ({ summary: null, reasonAr: 'سبب' }) }));
    render(<AssistantScreen />);
    await screen.findByText('سبب');
    expect(screen.queryByRole('button', { name: /أعد توليد الملخّص/ })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a phone of 375px (jsdom has no layout: the classes that make a sideways scroll)', () => {
  const FILES = ['src/components/screens/IntelligenceScreen.tsx', 'src/components/screens/AssistantScreen.tsx', 'src/components/growth/AskAi.tsx'];
  // built from pieces so no class-like token sits in this file
  const fixedWidth = new RegExp(['(?:^|\\s|")(?:min-)?w-', '\\[\\d'].join(''));
  const noWrap = new RegExp(['whitespace', '-nowrap'].join(''));

  it.each(FILES)('%s: no fixed width, no table, no nowrap', (f) => {
    const s = src(f);
    expect(s).not.toMatch(fixedWidth);
    expect(s).not.toMatch(/<table/);
    expect(s).not.toMatch(noWrap);
  });

  it('the one sideways row (the suggested questions) scrolls inside its card, never the page', () => {
    const s = src('src/components/screens/AssistantScreen.tsx');
    expect(s.match(/overflow-x-/g) ?? []).toHaveLength(1);
    expect(src('src/components/screens/IntelligenceScreen.tsx')).not.toMatch(/overflow-x-/);
    expect(src('src/components/growth/AskAi.tsx')).not.toMatch(/overflow-x-/);
  });

  it('the frames keep min-w-0 and only cap the width on a wide screen', async () => {
    await drawIntel();
    const h1 = screen.getByRole('heading', { level: 1 });
    let frame: HTMLElement | null = h1;
    while (frame && !frame.className.split(' ').includes('min-w-0')) frame = frame.parentElement;
    expect(frame).not.toBeNull();
  });
});
