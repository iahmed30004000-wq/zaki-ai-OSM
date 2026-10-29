// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * THE EXPENSE LIST CANCELS — IT DOES NOT DELETE, AND IT SHOWS WHAT WAS CANCELLED.
 *
 * A cancelled expense stays on the list, marked «ملغى» with the reason, and leaves the profit; the button that
 * cancels one is shown only to a person who holds «تعديل المالية» (the door asks it too), asks for a reason,
 * and sends exactly the id and the reason — never a store, never an amount.
 */

let user: { role: string; permissions: string[] } = { role: 'SUPER_ADMIN', permissions: [] };
vi.mock('next/link', () => ({
  default: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ t: { cancel: 'تراجع' }, locale: 'ar', currentUser: user }),
}));

import { FinanceProfitScreen } from './FinanceProfitScreen';

const LIVE = { id: 'e-live', title: 'إيجار المستودع', category: 'OFFICE', amount: 100, expenseDate: '2026-10-10T00:00:00Z', voidedAt: null, voidReason: null, notes: null };
const GONE = { id: 'e-gone', title: 'حملة مكررة', category: 'MARKETING', amount: 50, expenseDate: '2026-10-11T00:00:00Z', voidedAt: '2026-10-12T00:00:00Z', voidReason: 'سُجّلت مرتين', notes: null };

let sent: { url: string; method: string; body: any }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  user = { role: 'SUPER_ADMIN', permissions: [] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: JSON.parse(String(init?.body ?? 'null')) });
        return new Response(JSON.stringify({ success: true, moneyReturned: true }), { status: 200 });
      }
      if (url.startsWith('/api/finance/profitability')) return new Response(JSON.stringify({ products: [] }), { status: 200 });
      return new Response(
        JSON.stringify({ currency: 'JOD', summary: null, expenses: [LIVE, GONE], recentDeliveredOrders: [], spend: null }),
        { status: 200 }
      );
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The ledger renders a table and a card list; the table is the one with the header cells. */
const ledger = async () => {
  render(<FinanceProfitScreen />);
  await screen.findAllByText('إيجار المستودع');
  return screen.getAllByRole('table')[0];
};

describe('the expense list', () => {
  it('shows a cancelled expense, marked, with its reason — and the live one without a mark', async () => {
    const table = await ledger();
    expect(within(table).getByText('حملة مكررة')).toBeTruthy();
    expect(within(table).getAllByText('ملغى')).toHaveLength(1);
    expect(within(table).getByText('أُلغي: سُجّلت مرتين')).toBeTruthy();
  });

  it('offers «إلغاء المصروف» on the live expense only — never on one already cancelled', async () => {
    const table = await ledger();
    expect(within(table).getAllByRole('button', { name: 'إلغاء المصروف' })).toHaveLength(1);
  });

  it('NEGATIVE: a person without «تعديل المالية» sees no cancel button at all', async () => {
    user = { role: 'MODERATOR', permissions: ['finance.view'] };
    const table = await ledger();
    expect(within(table).queryByRole('button', { name: 'إلغاء المصروف' })).toBeNull();
  });

  it('a person who holds it can cancel, with a reason — and the request carries the id and the reason only', async () => {
    user = { role: 'ACCOUNTANT', permissions: ['finance.view', 'finance.update'] };
    const table = await ledger();
    await userEvent.click(within(table).getByRole('button', { name: 'إلغاء المصروف' }));
    await userEvent.type(await screen.findByLabelText(/سبب الإلغاء/), 'سُجّل بالخطأ');
    await userEvent.click(screen.getByRole('button', { name: 'ألغِ المصروف' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: '/api/finance',
      method: 'PATCH',
      body: { expenseId: 'e-live', reason: 'سُجّل بالخطأ' },
    });
  });
});
