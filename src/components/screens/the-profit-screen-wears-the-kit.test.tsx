// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «الأرباح» ON THE KIT (R13g, 18/11) — the frame, the buttons and the 13px text changed; no figure, request or rule did.
 *
 *   · the frame is `PageShell`: one h1 with the registry name, the sentence under it, «سجّل مصروفاً» in its actions;
 *   · the span box (D2) and its sentence sit in the frame's toolbar row, the box itself unchanged (same label, same query);
 *   · the plain buttons («إلغاء المصروف», «تراجع», «عكس») are the framed `secondary`, the two that destroy stay `danger`,
 *     and every button inside a form that must not submit says `type="button"`;
 *   · «الشركاء» keeps its keys: no section without `finance.partners`, no «عكس» without the cash box's key too;
 *   · on a phone (375, jsdom) nothing carries a fixed width wider than the screen.
 */

const { phone, api } = vi.hoisted(() => ({ phone: { value: true }, api: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/profit',
  useSearchParams: () => new URLSearchParams(),
}));
let user: { role: string; permissions: string[] } = { role: 'SUPER_ADMIN', permissions: [] };
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'تراجع' }, locale: 'ar', isRtl: true, currentUser: user }),
}));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => unknown, opts?: { key?: string }) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, [opts?.key]);
  },
}));

import { FinanceProfitScreen } from './FinanceProfitScreen';
import { PartnersSection } from './finance/PartnersSection';
import { routeLabel } from '@/lib/route-registry';

const SUMMARY = { totalRevenue: 1000, totalCOGS: 400, shippingAndCommissions: 100, totalOperationalExpenses: 50, netProfit: 450, profitMargin: 45 };
const LIVE = { id: 'e1', title: 'إيجار المستودع', category: 'OFFICE', amount: 100, expenseDate: '2026-10-10T00:00:00Z', voidedAt: null, voidReason: null, notes: null };
const STATEMENT = {
  state: 'OK',
  sharesTotal: 100,
  lines: [{ id: 'pa', name: 'شريك أ', sharePercent: 100, isActive: true, entitlement: 450, draws: 100, balance: 350, broken: 0 }],
  totals: { entitlement: 450, draws: 100, broken: 0 },
  currency: 'JOD',
  minorUnit: 3,
  netProfit: 450,
  trust: { level: 'STATED', present: 1, population: 1, share: 100, ar: 'مسجَّلة' },
  uncounted: 0,
  draws: [
    { id: 'd1', walletId: 'w1', walletName: 'الصندوق', partnerId: 'pa', partnerName: 'شريك أ', amount: 100, currencyCode: 'JOD', valueInStoreCurrency: 100, note: 'سحب', createdAt: '2026-11-12T10:00:00.000Z', createdByName: 'مستخدم', reversed: false },
  ],
};

let sent: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  phone.value = true;
  user = { role: 'SUPER_ADMIN', permissions: [] };
  api.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method) {
      sent.push({ url, method: init.method, body: JSON.parse(String(init.body ?? 'null')) });
      return {};
    }
    if (url === '/api/finance/partners/statement') return STATEMENT;
    if (url === '/api/finance/wallets') return { wallets: [{ id: 'w1', name: 'الصندوق', currencyCode: 'JOD' }] };
    throw new Error('unexpected ' + url);
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: JSON.parse(String(init?.body ?? 'null')) });
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      if (String(url).startsWith('/api/finance/profitability')) return new Response(JSON.stringify({ products: [] }), { status: 200 });
      return new Response(JSON.stringify({ currency: 'JOD', summary: SUMMARY, expenses: [LIVE], spend: null }), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const drawScreen = async () => {
  render(<FinanceProfitScreen />);
  await screen.findAllByText('إيجار المستودع');
};
/** The ledger's table (the partners' two tables come first for a holder of their key). */
const ledgerTable = () => screen.getAllByRole('table').find((t) => t.textContent?.includes('إيجار المستودع'))!;
const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');
const SCREEN = 'src/components/screens/FinanceProfitScreen.tsx';
const SECTION = 'src/components/screens/finance/PartnersSection.tsx';

describe('«الأرباح» — the frame', () => {
  it('one h1, the registry name, and the sentence under it', async () => {
    await drawScreen();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain(routeLabel('/finance/profit'));
    expect(screen.getByText('الربح من الموصَّل فقط — ناقص كلفة البضاعة والشحن والعمولات والمصاريف')).toBeTruthy();
  });

  it('the source draws the frame with the registry name, never a typed title, and no bare header beside it', () => {
    const s = src(SCREEN);
    expect(s).toMatch(/<PageShell\s+title=\{routeLabel\('\/finance\/profit'\)\}/);
    expect(s).not.toMatch(/<PageHeader\b/);
  });

  it('the span box and its sentence sit in the toolbar row under the header — before the four figures', async () => {
    await drawScreen();
    const sentence = screen.getByText(/^الأرقام (للمدة المختارة|منذ البداية)/);
    const row = sentence.parentElement!;
    expect(row.className.split(' ')).toContain('flex-wrap');
    // The header is the row's previous sibling: the toolbar is the frame's, not a block of the content.
    expect(row.previousElementSibling!.querySelector('h1')).not.toBeNull();
    expect(row.nextElementSibling!.textContent).toContain('إيراد الموصَّل');
    // The box itself: a button inside the row, the same label for «no span».
    expect(row.querySelector('button')).not.toBeNull();
  });

  // MOVED 25/11 (A1): the box was `label="منذ البداية"`. With a first courier statement the profit is counted from that day, so
  // «since the beginning» would be false: the empty box now names the day (`من <التاريخ>`), and keeps «منذ البداية» for a store
  // with no statement. The box itself — same component, same value, same handler — is unchanged.
  it('the span box is the same DateRange on the same range; its empty label names where the profit starts', () => {
    expect(src(SCREEN)).toContain("<DateRange value={range} onChange={setRange} label={sinceDay ? `من ${sinceDate(sinceDay)}` : 'منذ البداية'} />");
  });

  it('«سجّل مصروفاً» is the one primary act of the header, and it opens the form', async () => {
    await drawScreen();
    const record = screen.getByRole('button', { name: 'سجّل مصروفاً' });
    expect(record.className).toContain('bg-[var(--sys-primary)]');
    fireEvent.click(record);
    expect(await screen.findByText('مصروف جديد')).toBeTruthy();
  });
});

describe('«الأرباح» — the buttons', () => {
  it('no Button on either file carries a legacy variant name', () => {
    for (const f of [SCREEN, SECTION]) {
      const buttons = src(f).match(/<Button\b[^>]*>/g) ?? [];
      expect(buttons.length, f).toBeGreaterThan(0);
      for (const b of buttons) expect(b, f).not.toMatch(/variant="(outline|ghost|success)"/);
    }
  });

  it('«إلغاء المصروف» on a row is framed, not red: it only opens the dialog', async () => {
    phone.value = false;
    await drawScreen();
    const b = within(ledgerTable()).getByRole('button', { name: 'إلغاء المصروف' });
    expect(b.className).toContain('border-[var(--sys-border)]');
    expect(b.className).not.toContain('bg-[var(--sys-destructive)]');
    expect(b.getAttribute('type')).toBe('button');
  });

  it('the cancel dialog: «تراجع» does not submit, «ألغِ المصروف» is red and sends only the id and the reason', async () => {
    phone.value = false;
    await drawScreen();
    fireEvent.click(within(ledgerTable()).getByRole('button', { name: 'إلغاء المصروف' }));
    const dialog = (await screen.findByText('إلغاء مصروف')).closest('[role="dialog"]') as HTMLElement;
    const back = within(dialog).getByRole('button', { name: 'تراجع' });
    expect(back.getAttribute('type')).toBe('button');
    const go = within(dialog).getByRole('button', { name: 'ألغِ المصروف' });
    expect(go.className).toContain('bg-[var(--sys-destructive)]');
    expect(go.getAttribute('type')).toBe('submit');
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: 'سُجّل مرتين' } });
    fireEvent.click(go);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: '/api/finance', method: 'PATCH', body: { expenseId: 'e1', reason: 'سُجّل مرتين' } });
  });

  it('NEGATIVE: «تراجع» on the expense form closes it and sends nothing', async () => {
    await drawScreen();
    fireEvent.click(screen.getByRole('button', { name: 'سجّل مصروفاً' }));
    const dialog = (await screen.findByText('مصروف جديد')).closest('[role="dialog"]') as HTMLElement;
    const back = within(dialog).getByRole('button', { name: 'تراجع' });
    expect(back.getAttribute('type')).toBe('button');
    fireEvent.click(back);
    await waitFor(() => expect(screen.queryByText('مصروف جديد')).toBeNull());
    expect(sent).toHaveLength(0);
  });

  it('NEGATIVE: without «تعديل المالية» no row offers «إلغاء المصروف»', async () => {
    user = { role: 'MODERATOR', permissions: ['finance.view'] };
    phone.value = false;
    await drawScreen();
    expect(screen.queryAllByRole('button', { name: 'إلغاء المصروف' })).toHaveLength(0);
  });
});

describe('«الشركاء» — on the kit, with its keys', () => {
  const drawSection = async () => {
    render(<PartnersSection />);
    await screen.findAllByText('شريك أ');
  };

  it('«عكس» is framed, the dialog\'s «تراجع» does not submit, «اعكس السحب» is red and waits for a reason of five letters', async () => {
    phone.value = false;
    user = { role: 'MODERATOR', permissions: ['finance.partners', 'finance.cashbox'] };
    await drawSection();
    const reverse = screen.getAllByRole('button', { name: 'عكس' })[0];
    expect(reverse.className).toContain('border-[var(--sys-border)]');
    expect(reverse.className).not.toContain('bg-[var(--sys-destructive)]');
    fireEvent.click(reverse);
    const dialog = (await screen.findByText('عكس سحب شريك')).closest('[role="dialog"]') as HTMLElement;
    expect(within(dialog).getByRole('button', { name: 'تراجع' }).getAttribute('type')).toBe('button');
    const go = within(dialog).getByRole('button', { name: 'اعكس السحب' }) as HTMLButtonElement;
    expect(go.className).toContain('bg-[var(--sys-destructive)]');
    expect(go.disabled).toBe(true);
    fireEvent.change(dialog.querySelector('textarea')!, { target: { value: '  غلط بالمبلغ  ' } });
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ url: '/api/finance/wallets/w1/movements', method: 'PATCH', body: { movementId: 'd1', reason: 'غلط بالمبلغ' } });
  });

  it('NEGATIVE: with the partners\' key but not the cash box\'s, no «عكس»', async () => {
    phone.value = false;
    user = { role: 'MODERATOR', permissions: ['finance.partners'] };
    await drawSection();
    expect(screen.queryByRole('button', { name: 'عكس' })).toBeNull();
  });

  it('NEGATIVE: the profit screen draws no partners section without `finance.partners`', async () => {
    user = { role: 'MODERATOR', permissions: ['finance.view'] };
    await drawScreen();
    expect(screen.queryByText('سحوبات الشركاء')).toBeNull();
    expect(api.mock.calls.map((c) => c[0])).not.toContain('/api/finance/partners/statement');
  });

  it('the way to the partners\' settings leads to «قواعد المال» (R13i moved it)', async () => {
    await drawSection();
    // Only the empty state carries it.
    cleanup();
    api.mockImplementation(async (url: string) => (url === '/api/finance/partners/statement' ? { ...STATEMENT, state: 'NO_PARTNERS', lines: [] } : {}));
    render(<PartnersSection />);
    await screen.findByText('ما في شركاء محفوظين');
    // 19/11 (R13i): was «افتح إعدادات النظام» → /settings/system; the partners card moved to «قواعد المال», so the link names it and goes there.
    expect(screen.getByText('افتح قواعد المال').closest('a')!.getAttribute('href')).toBe('/finance/rules');
  });
});

describe('«الأرباح» on a phone (375 px, jsdom — no photograph: every account has a second factor)', () => {
  it('no element carries a fixed width wider than the screen, and the toolbar wraps', async () => {
    user = { role: 'SUPER_ADMIN', permissions: ['finance.partners', 'finance.cashbox'] };
    await drawScreen();
    await screen.findAllByText('شريك أ');
    const tooWide = [...document.querySelectorAll('[class]')].filter((e) => {
      const m = String(e.getAttribute('class')).match(/(?:^|\s)(?:w|min-w)-\[(\d+)px\]/);
      return m && Number(m[1]) > 375;
    });
    expect(tooWide).toHaveLength(0);
    const row = screen.getByText(/^الأرقام (للمدة المختارة|منذ البداية)/).parentElement!;
    expect(row.className.split(' ')).toContain('flex-wrap');
  });

  it('the ledger goes through the shared Rows: its expense is also a phone card (a list item), not only a table row', async () => {
    await drawScreen();
    const cards = [...document.querySelectorAll('li')].filter((li) => li.textContent?.includes('إيجار المستودع'));
    expect(cards.length).toBeGreaterThan(0);
  });
});
