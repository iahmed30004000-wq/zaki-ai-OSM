// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PartnerStatement } from '@/lib/partner-statement-core';

/**
 * «الشركاء» ON THE PROFIT SCREEN — it prints what the server cut, and a red chip for «مكسور عليه» (13/11).
 *
 * «اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner). The section reads `GET /api/finance/partners/statement` and draws it:
 * the share, the draws, the balance, a red chip with the amount for who is over — and nothing is added or compared here. It is not drawn
 * for anybody without `finance.partners`, and its «عكس» is drawn only for who holds that key AND the cash box's (the door asks both).
 */

type Stub = (url: string, init?: { method?: string; body?: string }) => Promise<unknown>;
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a> }));

let user: { role: string; permissions: string[] } = { role: 'SUPER_ADMIN', permissions: [] };
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'تراجع' }, locale: 'ar', currentUser: user }) }));

import { PartnersSection } from './PartnersSection';

const line = (id: string, name: string, share: number, ent: number | null, draws: number, extra: Record<string, unknown> = {}) => {
  const balance = ent === null ? null : Math.round((ent - draws) * 100) / 100;
  return {
    id, name, sharePercent: share, isActive: true, entitlement: ent, draws, balance,
    broken: balance === null ? null : balance < 0 ? -balance : 0, ...extra,
  };
};

const statementOf = (over: Partial<PartnerStatement> = {}): PartnerStatement => ({
  state: 'OK',
  sharesTotal: 100,
  lines: [
    line('pa', 'شريك أ', 15, 150, 200),
    line('pb', 'شريك ب', 15, 150, 0),
    line('pc', 'شريك ج', 15, 150, 150),
    line('pd', 'شريك د', 55, 550, 300),
  ],
  totals: { entitlement: 1000, draws: 650, broken: 50 },
  currency: 'USD',
  minorUnit: 2,
  netProfit: 1000,
  trust: { level: 'STATED', present: 10, population: 10, share: 100, ar: 'كلفة البضاعة مسجَّلة على 10 من 10 طلب — الرقم صالح.' },
  uncounted: 0,
  draws: [
    { id: 'd2', walletId: 'w1', walletName: 'الصندوق', partnerId: 'pd', partnerName: 'شريك د', amount: 300, currencyCode: 'USD', valueInStoreCurrency: 300, note: 'سحب شخصي', createdAt: '2026-11-12T10:00:00.000Z', createdByName: 'سارة', reversed: false },
    { id: 'd1', walletId: 'w2', walletName: 'صندوق الدينار', partnerId: 'pa', partnerName: 'شريك أ', amount: 70, currencyCode: 'JOD', valueInStoreCurrency: 98.7, note: 'سحب', createdAt: '2026-11-11T10:00:00.000Z', createdByName: 'أحمد', reversed: false },
    { id: 'd0', walletId: 'w1', walletName: 'الصندوق', partnerId: 'pa', partnerName: 'شريك أ', amount: 100, currencyCode: 'USD', valueInStoreCurrency: 100, note: 'غلط', createdAt: '2026-11-10T10:00:00.000Z', createdByName: 'أحمد', reversed: true },
  ],
  ...over,
});

let answer: unknown;
const patches = () => api.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method === 'PATCH');

beforeEach(() => {
  vi.clearAllMocks();
  user = { role: 'SUPER_ADMIN', permissions: [] };
  answer = statementOf();
  api.mockImplementation((async (url: string, init?: { method?: string }) => {
    if (init?.method === 'PATCH') return { reversal: { id: 'r1' } };
    if (url === '/api/finance/partners/statement') return answer;
    throw new Error('unexpected ' + url);
  }) as Stub);
});
afterEach(cleanup);

/** The statement table is the first one on the section (the draws list is the second). */
const tables = async () => {
  render(<PartnersSection />);
  await screen.findAllByText('شريك د');
  return screen.getAllByRole('table');
};

describe('the table of the partners', () => {
  it('reads the statement once, from the one door', async () => {
    await tables();
    expect(api.mock.calls.map((c) => c[0])).toEqual(['/api/finance/partners/statement']);
  });

  it('prints each partner with his share, his entitlement, his draws and his balance — the server’s figures, to the cent', async () => {
    const [statement] = await tables();
    const rows = within(statement).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    const first = within(rows[0]).getAllByRole('cell').map((c) => c.textContent);
    expect(first[0]).toBe('شريك أ');
    expect(first[1]).toBe('15%');
    expect(first[2]).toBe('150.00 USD');
    expect(first[3]).toBe('200.00 USD');
    expect(first[4]).toBe('-50.00 USD');
    const last = within(rows[3]).getAllByRole('cell').map((c) => c.textContent);
    expect(last.slice(0, 5)).toEqual(['شريك د', '55%', '550.00 USD', '300.00 USD', '250.00 USD']);
  });

  it('«مكسور عليه» is a red chip with the amount beside the one who is over — and nobody else gets one', async () => {
    const [statement] = await tables();
    const rows = within(statement).getAllByRole('row').slice(1);
    const chips = rows.map((r) => within(r).queryByText(/^مكسور عليه/));
    expect(chips[0]?.textContent).toContain('مكسور عليه');
    expect(chips[0]?.textContent).toContain('50.00 USD');
    expect(chips[1]).toBeNull();
    expect(chips[2]).toBeNull();
    expect(chips[3]).toBeNull();
  });

  it('EQUAL IS NOT BROKEN: a partner who drew exactly his share has a balance of zero and no chip', async () => {
    const [statement] = await tables();
    const row = within(statement).getAllByRole('row')[3];
    expect(within(row).getAllByRole('cell')[4].textContent).toBe('0.00 USD');
    expect(within(row).queryByText(/^مكسور عليه/)).toBeNull();
  });

  it('the totals line says what the server summed', async () => {
    await tables();
    expect(screen.getByText(/نصيب:/).textContent).toContain('1,000.00 USD');
    expect(screen.getByText(/سحوبات:/).textContent).toContain('650.00 USD');
    expect(screen.getAllByText(/مكسور عليه:/)[0].textContent).toContain('50.00 USD');
  });

  it('says WHICH profit was divided: «صافي الربح الموزَّع» with the number', async () => {
    await tables();
    expect(screen.getByText(/صافي الربح الموزَّع/).textContent).toContain('1,000.00 USD');
  });

  it('a loss says there is nothing to divide, and every share reads zero', async () => {
    answer = statementOf({
      netProfit: -722.1,
      lines: [line('pd', 'شريك د', 100, 0, 10)],
      totals: { entitlement: 0, draws: 10, broken: 10 },
    });
    await tables();
    expect(screen.getByText(/ما في ربح للتوزيع/)).toBeTruthy();
    expect(screen.getByText(/صافي الربح الموزَّع/).textContent).toContain('-722.10 USD');
  });

  it('a switched-off partner who still has draws is listed with «موقوف»', async () => {
    answer = statementOf({ lines: [line('pc', 'شريك ج', 15, 0, 25, { isActive: false }), line('pd', 'شريك د', 100, 1000, 0)] });
    const [statement] = await tables();
    expect(within(statement).getByText('موقوف')).toBeTruthy();
  });
});

describe('the sentence about the cost behind the profit', () => {
  it('is silent when the cost was recorded on enough orders', async () => {
    await tables();
    expect(screen.queryByText(/فالتوزيع على رقم ناقص/)).toBeNull();
  });

  it('is printed beside the figures when it was not — the dashboard’s own sentence', async () => {
    answer = statementOf({
      trust: { level: 'WITHHELD', present: 4, population: 119, share: 3, ar: 'كلفة البضاعة مسجَّلة على 4 من 119 طلب فقط (3%) — الرقم لا يُقال.' },
    });
    await tables();
    expect(screen.getByText(/كلفة البضاعة مسجَّلة على 4 من 119 طلب فقط \(3%\) — الرقم لا يُقال\. — فالتوزيع على رقم ناقص\./)).toBeTruthy();
  });

  it('a draw that cannot be counted is said, with how many', async () => {
    answer = statementOf({ uncounted: 2 });
    await tables();
    expect(screen.getByText(/في 2 سحب بلا قيمة بعملة المتجر أو بلا شريك/)).toBeTruthy();
  });
});

describe('when the shares cannot be cut', () => {
  it('no partner saved: an empty state with the way to the settings, and no table of shares', async () => {
    answer = statementOf({ state: 'NO_PARTNERS', sharesTotal: 0, lines: [], totals: { entitlement: null, draws: 0, broken: null } });
    render(<PartnersSection />);
    expect(await screen.findByText('ما في شركاء محفوظين')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'افتح إعدادات النظام' }).getAttribute('href')).toBe('/settings/system');
  });

  it('shares that do not total 100: it says so in red, splits nothing, and prints a dash — never a zero that makes everyone broken', async () => {
    answer = statementOf({
      state: 'SHARES_NOT_100',
      sharesTotal: 95,
      lines: [line('pa', 'شريك أ', 15, null, 30), line('pd', 'شريك د', 80, null, 0)],
      totals: { entitlement: null, draws: 30, broken: null },
    });
    const [statement] = await tables();
    expect(screen.getByText(/مجموع نسب الشركاء الفعّالين 95 مش 100 — ما انقسم شي/)).toBeTruthy();
    const row = within(statement).getAllByRole('row')[1];
    expect(within(row).getAllByRole('cell').map((c) => c.textContent).slice(2)).toEqual(['—', '30.00 USD', '—', '—']);
    for (const body of within(statement).getAllByRole('row').slice(1)) expect(within(body).queryByText(/^مكسور عليه/)).toBeNull();
  });

  it('an answer that is not a statement is a failure said in a sentence — it never takes the profit screen down', async () => {
    answer = { currency: 'JOD', summary: null, expenses: [] };
    render(<PartnersSection />);
    expect(await screen.findByText(/تعذّر تحميل حساب الشركاء/)).toBeTruthy();
  });

  it('a refusal of the door (the key was taken away) is the same sentence', async () => {
    api.mockRejectedValue(Object.assign(new Error('لا تملك صلاحية «الشركاء والسحوبات»'), { status: 403 }));
    render(<PartnersSection />);
    expect(await screen.findByText(/تعذّر تحميل حساب الشركاء/)).toBeTruthy();
  });
});

describe('the draws, with «عكس»', () => {
  it('lists date, partner, amount, the store value only when the currency differs, wallet, note and who recorded it', async () => {
    const [, draws] = await tables();
    const rows = within(draws).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const cells = (r: HTMLElement) => within(r).getAllByRole('cell').map((c) => c.textContent);
    // a dollar draw from a dollar wallet: no equivalent column value
    expect(cells(rows[0]).slice(1, 7)).toEqual(['شريك د', '300.00 USD', '—', 'الصندوق', 'سحب شخصي', 'سارة']);
    // dinars from a dinar wallet: the equivalent in the store's currency is printed
    expect(cells(rows[1]).slice(1, 7)).toEqual(['شريك أ', '70.00 JOD', '98.70 USD', 'صندوق الدينار', 'سحب', 'أحمد']);
  });

  it('a reversed draw is marked «معكوس» and has no «عكس»', async () => {
    const [, draws] = await tables();
    const rows = within(draws).getAllByRole('row').slice(1);
    expect(within(rows[2]).getByText('معكوس')).toBeTruthy();
    expect(within(rows[2]).queryByRole('button', { name: 'عكس' })).toBeNull();
    expect(within(rows[0]).getByRole('button', { name: 'عكس' })).toBeTruthy();
  });

  it('with no draw: an empty state that says where a draw is written', async () => {
    answer = statementOf({ draws: [] });
    render(<PartnersSection />);
    expect(await screen.findByText('ما في سحوبات مسجَّلة')).toBeTruthy();
    expect(screen.getByText(/بند «سحب شريك»/)).toBeTruthy();
  });

  it('«عكس» is drawn for the owner, for who holds the partners’ key AND the cash box’s, and for nobody else', async () => {
    for (const [permissions, shown] of [
      [['finance.view', 'finance.partners', 'finance.cashbox'], true],
      [['finance.view', 'finance.partners'], false],
      [['finance.view', 'finance.cashbox'], false],
    ] as const) {
      cleanup();
      user = { role: 'ACCOUNTANT', permissions: [...permissions] };
      const [, draws] = await tables();
      expect(within(draws).queryAllByRole('button', { name: 'عكس' }).length > 0, permissions.join()).toBe(shown);
    }
  });

  it('pressing it asks for a reason of at least five characters, and sends the movement and the reason to the wallet’s own door', async () => {
    const [, draws] = await tables();
    fireEvent.click(within(draws).getAllByRole('button', { name: 'عكس' })[0]);
    const confirm = await screen.findByRole('button', { name: 'اعكس السحب' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/سبب العكس/), { target: { value: 'قصير' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/سبب العكس/), { target: { value: 'سُجّل بالغلط' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(patches()).toHaveLength(1));
    const [url, init] = patches()[0] as [string, { body: string }];
    expect(url).toBe('/api/finance/wallets/w1/movements');
    expect(JSON.parse(init.body)).toEqual({ movementId: 'd2', reason: 'سُجّل بالغلط' });
    // and the statement is read again: the draw leaves the partner's account
    await waitFor(() => expect(api.mock.calls.filter((c) => c[0] === '/api/finance/partners/statement').length).toBeGreaterThanOrEqual(2));
  });

  it('a refusal of the door is printed in the dialog, and nothing is reloaded as if it had worked', async () => {
    api.mockImplementation((async (url: string, init?: { method?: string }) => {
      if (init?.method === 'PATCH') throw new Error('عكس سحب شريك بيغيّر رصيده عند الشركاء — بيحتاج «الشركاء والسحوبات»');
      return answer;
    }) as Stub);
    const [, draws] = await tables();
    fireEvent.click(within(draws).getAllByRole('button', { name: 'عكس' })[0]);
    fireEvent.change(await screen.findByLabelText(/سبب العكس/), { target: { value: 'سُجّل بالغلط' } });
    fireEvent.click(screen.getByRole('button', { name: 'اعكس السحب' }));
    expect(await screen.findByText(/بيحتاج «الشركاء والسحوبات»/)).toBeTruthy();
  });
});

describe('the section is for its key-holders only, on the profit screen', () => {
  it('the screen draws it for the owner and asks for the statement — and for nobody else it asks for nothing', async () => {
    const { FinanceProfitScreen } = await import('../FinanceProfitScreen');
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url);
        if (url.startsWith('/api/finance/profitability')) return new Response(JSON.stringify({ products: [] }), { status: 200 });
        return new Response(JSON.stringify({ currency: 'USD', summary: null, expenses: [], recentDeliveredOrders: [], spend: null }), { status: 200 });
      })
    );
    try {
      user = { role: 'ACCOUNTANT', permissions: ['finance.view', 'finance.cashbox', 'finance.create'] };
      render(<FinanceProfitScreen />);
      await screen.findByText('سجل المصاريف');
      expect(api).not.toHaveBeenCalled();
      expect(screen.queryByText('سحوبات الشركاء')).toBeNull();
      cleanup();

      user = { role: 'ACCOUNTANT', permissions: ['finance.view', 'finance.partners'] };
      render(<FinanceProfitScreen />);
      expect(await screen.findByText('سحوبات الشركاء')).toBeTruthy();
      expect(api.mock.calls.map((c) => c[0])).toContain('/api/finance/partners/statement');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('nothing is computed in the browser', () => {
  const source = readFileSync(join(process.cwd(), 'src/components/screens/finance/PartnersSection.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('no rounding, no `toFixed`, no sum, no share — every figure is printed from the statement', () => {
    expect(source).not.toMatch(/toFixed|Math\.(round|floor|ceil|max|min)\(.*(entitlement|draws|balance|broken|netProfit)/);
    expect(source).not.toMatch(/\.reduce\(/);
    expect(source).not.toMatch(/\*\s*(l|line|statement)\.sharePercent|sharePercent\s*\*|\/\s*100/);
    // the only subtraction-like comparisons are signs for a tone, never an amount that is printed
    expect(source).not.toMatch(/entitlement\s*-\s*|netProfit\s*[-*+/]/);
  });
});

describe('NO NEW CSS — every class the section uses is one the product already ships', () => {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const classesOf = (src: string) =>
    [...src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].flatMap((m) => {
      const text = m[1] ?? m[2];
      const inHoles = [...text.matchAll(/\$\{([^}]*)\}/g)].flatMap((h) => [...h[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((q) => q[1] ?? q[2]));
      return [text.replace(/\$\{[^}]*\}/g, ' '), ...inHoles].flatMap((s) => s.split(/\s+/)).filter(Boolean);
    });

  it('`PartnersSection`’s classes all appear in another source file', () => {
    const own = join(root, 'components/screens/finance/PartnersSection.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the section has classes').toBeGreaterThan(8);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });
});
