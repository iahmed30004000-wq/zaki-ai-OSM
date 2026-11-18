// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE BENCH SCREEN SHOWS EACH PRODUCT'S VERDICT AS A WORD, ITS CONFIRMATION
 * RATE, AND A PANEL FOR ITS RULES AND SPEND (18/11, request B3).
 *
 * Nothing behind the login can be photographed, so the screen is rendered
 * here: the chip carries a word (never colour alone), the rules editor shows
 * every default, a refusal from the door is printed, and the panel divides
 * nothing — every figure arrives computed.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/growth/bench' }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => null }));

import { BenchScreen } from './BenchScreen';
import { DEFAULT_BENCH_RULES } from '@/lib/bench-verdict';

const test = (over: Record<string, unknown> = {}) => ({
  startDay: '2026-11-16', dayIndex: 3, spend: 30, orders: 10, confirmed: 8, confirmationRate: 80,
  costPerOrder: 3, costPerConfirmed: 3.75, missingSpendDays: [], ordersBeforeStart: 0, spendBeforeStart: 0, ...over,
});
const product = (id: string, verdict: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  id, name: `منتج ${id}`, sku: null, bench: 'منصّة', price: 10, category: null, triedAt: '2026-11-16',
  orders: 10, delivered: 0, returned: 0, deliveryRate: null, decided: 0,
  currency: 'USD', minorUnit: 2, today: '2026-11-18', test: test(), rules: { ...DEFAULT_BENCH_RULES }, customRules: false,
  verdict: { flag: null, ...verdict },
  spendEntries: [{ id: 's1', day: '2026-11-16', amount: 10, at: 'T', byId: 'u' }],
  ...over,
});

const PAYLOAD = {
  currency: 'USD',
  benches: [{ id: 'b1', name: 'منصّة' }],
  excluded: null,
  dna: { sellers: 0, minSellers: 10, traits: null, whyNot: 'لا' },
  results: [
    product('a', { state: 'SUCCESS', reason: 'اليوم 3: تكلفة الطلب 3 تحت الهدف 4' }),
    product('b', { state: 'FAIL', reason: 'فاشل' }),
    product('c', { state: 'NOT_JUDGED', reason: 'الصرف ناقص: …', flag: 'MISSING_SPEND' }),
    product('d', { state: 'CAPPED', reason: 'السقف' }, { test: test({ spend: null, confirmationRate: null, costPerOrder: null }) }),
  ],
};

beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return { ok: true };
    return PAYLOAD;
  });
});
afterEach(cleanup);

describe('the bench table', () => {
  it('every product has a verdict WORD, and the missing-spend one says so', async () => {
    render(<BenchScreen />);
    await screen.findAllByText('منتج a');
    expect(screen.getAllByText('ناجح').length).toBeGreaterThan(0);
    expect(screen.getAllByText('فاشل').length).toBeGreaterThan(0);
    expect(screen.getAllByText('الصرف ناقص').length).toBeGreaterThan(0);
    expect(screen.getAllByText('وصل السقف').length).toBeGreaterThan(0);
  });

  it('shows the confirmation rate column, and «—» before the first order', async () => {
    render(<BenchScreen />);
    await screen.findAllByText('منتج a');
    expect(screen.getAllByText('نسبة التأكيد').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/80%/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('ما انكتب').length).toBeGreaterThan(0);
  });
});

describe('the panel', () => {
  const openA = async () => {
    render(<BenchScreen />);
    await screen.findAllByText('منتج a');
    await userEvent.click(screen.getAllByRole('button', { name: 'الأرقام والصرف' })[0]);
    return screen.getByRole('dialog');
  };

  it('shows the reason, the rules used, and every default beside its field', async () => {
    const d = await openA();
    expect(within(d).getByText(/تحت الهدف 4/)).toBeTruthy();
    expect(within(d).getByText(/انحكم بهالقواعد/)).toBeTruthy();
    for (const label of ['هدف تكلفة الطلب', 'سقف التيست', 'صرف اليوم', 'يوم النجاح', 'أول يوم بينحكم فيه', 'طلبات قاعدة الفشل']) {
      expect(within(d).getByLabelText(label)).toBeTruthy();
    }
    expect(within(d).getByText('الافتراضي: 60')).toBeTruthy();
    expect(within(d).getByText('الافتراضي: 1.3')).toBeTruthy();
    expect(within(d).getByText(/بينكتب بالإيد/)).toBeTruthy();
  });

  it('records spend through the door and reloads', async () => {
    const d = await openA();
    await userEvent.type(within(d).getByLabelText(/المبلغ/), '12.5');
    await userEvent.click(within(d).getByRole('button', { name: 'سجّل الصرف' }));
    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith('/api/growth/bench', expect.objectContaining({ method: 'POST' }))
    );
    const call = apiJson.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(JSON.parse(call[1].body)).toMatchObject({ action: 'spend', productId: 'a', day: '2026-11-18', amount: '12.5' });
    await waitFor(() => expect(apiJson.mock.calls.filter((c) => !c[1]).length).toBeGreaterThan(1));
  });

  it('NEGATIVE: the door’s refusal is printed', async () => {
    apiJson.mockImplementation(async (_u: string, init?: { method?: string }) => {
      if (init?.method === 'POST') throw new Error('في صرف مكتوب ليوم 2026-11-18 — صحّحه بدل ما تكتب واحد تاني.');
      return PAYLOAD;
    });
    const d = await openA();
    await userEvent.type(within(d).getByLabelText(/المبلغ/), '5');
    await userEvent.click(within(d).getByRole('button', { name: 'سجّل الصرف' }));
    expect((await within(d).findByRole('alert')).textContent).toContain('صحّحه');
  });

  it('a void asks for a reason and sends it', async () => {
    const d = await openA();
    await userEvent.click(within(d).getByRole('button', { name: 'ألغِ' }));
    await userEvent.type(within(d).getByLabelText('سبب الإلغاء'), 'غلط');
    await userEvent.click(within(d).getByRole('button', { name: 'ألغِ السطر' }));
    await waitFor(() => {
      const call = apiJson.mock.calls.find((c) => c[1]?.method === 'POST');
      expect(call && JSON.parse(call[1].body)).toMatchObject({ action: 'void', entryId: 's1', reason: 'غلط' });
    });
  });
});

describe('the screen computes nothing', () => {
  it('no division or cost arithmetic in the panel or the screen', () => {
    for (const f of ['BenchTestPanel.tsx', 'BenchScreen.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src/components/screens', f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/'[^'\n]*'/g, "''") // a path in a string carries «/»
        .replace(/<\/?[A-Za-z][^>]*>/g, ''); // and so do JSX tags
      expect(src, `${f} يقسم رقماً — الحساب مكانه bench-verdict.ts`).not.toMatch(/[\w)\]]\s*\/\s*[\w(]/);
    }
  });

  it('no horizontal-overflow classes on the panel', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/screens/BenchTestPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/overflow-x-(auto|scroll)|min-w-\[|w-\[\d{3,}px\]|whitespace-nowrap/);
  });
});
