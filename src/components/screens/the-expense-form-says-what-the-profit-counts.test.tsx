// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { EXPENSE_FORM_HINT, EXPENSE_FORM_LABEL, EXPENSE_FORM_ORDER, EXPENSE_CATEGORY_AR } from '@/lib/expense-grade';

/**
 * THE EXPENSE FORM SAYS WHICH TWO TYPES THE PROFIT ALREADY COUNTS.
 *
 * Net profit subtracts every expense AND the courier fee and the batch cost each delivered order carries, so a
 * «شحن» or «تصنيع» expense for a delivered parcel or a costed batch is counted twice. The form used to list the
 * eight types with no word of that. Now the two types are named for what they are FOR, and choosing one shows the
 * sentence that says what not to put in it.
 */

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ t: { cancel: 'إلغاء' }, locale: 'ar' }) }));

import { FinanceProfitScreen } from './FinanceProfitScreen';

const WALLET = { id: 'w-1', name: 'الصندوق', currencyCode: 'SYP' };

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/finance/wallets')) return json({ wallets: [WALLET] });
      if (url.startsWith('/api/finance/profitability')) return json({ products: [] });
      return json({ currency: 'SYP', summary: null, expenses: [], recentDeliveredOrders: [], spend: null });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openForm() {
  const user = userEvent.setup();
  render(<FinanceProfitScreen />);
  await user.click(await screen.findByText('سجّل مصروفاً'));
  await waitFor(() => expect(screen.getByDisplayValue('اختر المحفظة…')).toBeTruthy());
  const box = screen.getByLabelText(/النوع/) as HTMLSelectElement;
  return { user, box };
}

describe('the type box', () => {
  it('lists the eight once each, in the form order, with the two special labels', async () => {
    const { box } = await openForm();
    const options = Array.from(box.options).map((o) => ({ value: o.value, text: o.textContent }));
    expect(options.map((o) => o.value)).toEqual([...EXPENSE_FORM_ORDER]);
    for (const o of options) {
      expect(o.text).toBe(EXPENSE_FORM_LABEL[o.value as keyof typeof EXPENSE_FORM_LABEL] ?? EXPENSE_CATEGORY_AR[o.value]);
    }
    expect(options.find((o) => o.value === 'SHIPPING')!.text).toContain('غير محسوب على طلب مسلَّم');
    expect(options.find((o) => o.value === 'MANUFACTURING')!.text).toContain('بلا كلفة');
    expect(box.value, 'الافتراضي تغيّر').toBe('MARKETING');
  });

  it('shows no hint on the default type', async () => {
    await openForm();
    expect(screen.queryByText(EXPENSE_FORM_HINT.SHIPPING!)).toBeNull();
    expect(screen.queryByText(EXPENSE_FORM_HINT.MANUFACTURING!)).toBeNull();
  });

  it('shows the shipping sentence when shipping is chosen, and only then', async () => {
    const { user, box } = await openForm();
    await user.selectOptions(box, 'SHIPPING');
    expect(screen.getByText(EXPENSE_FORM_HINT.SHIPPING!)).toBeTruthy();
    expect(screen.queryByText(EXPENSE_FORM_HINT.MANUFACTURING!)).toBeNull();
    await user.selectOptions(box, 'OFFICE');
    expect(screen.queryByText(EXPENSE_FORM_HINT.SHIPPING!)).toBeNull();
  });

  it('shows the manufacturing sentence when manufacturing is chosen', async () => {
    const { user, box } = await openForm();
    await user.selectOptions(box, 'MANUFACTURING');
    expect(screen.getByText(EXPENSE_FORM_HINT.MANUFACTURING!)).toBeTruthy();
  });
});
