// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «كان من طرد طلب آخر» ON THE MATCHING SCREEN.
 *
 * · offered on a «فرق في المبلغ» row that carries money for an order and has no answer — and on no other row;
 * · only to somebody who holds the review permission, and never on an approved statement;
 * · three real questions: who took the goods (a search box), how many pieces (a number that cannot pass the box),
 *   whether the customer's own box came back (a select) — and a customer the rules refuse is greyed with its reason;
 * · what is posted is exactly those three answers, and the server's own sentence is what a refusal shows.
 */
const { api, permissions, approved } = vi.hoisted(() => ({
  api: vi.fn(),
  permissions: { current: ['settlement.review'] as string[] },
  approved: { current: false },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: permissions.current } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';

const base = {
  matchedBy: 'MERCHANT_REF', expectedFee: null, statementFee: 2.5, feeDifference: null, resolution: null, resolutionNote: null,
  courierWord: null, orderOutcome: null, followUp: null, difference: null,
};
const matches = [
  {
    ...base, id: 'money', result: 'MISMATCHED', note: null, expectedAmount: 32.5, statementAmount: 37.5, difference: 5,
    order: { id: 'y', orderNumber: 'JO-2026-0002', merchantRef: 'JO-2026-0002', shippingStatus: 'SHIPPED' },
    statementLine: { merchantRef: 'JO-2026-0002', barcode: null, amount: 37.5, status: 'تم', rawRow: null },
  },
  {
    ...base, id: 'zero', result: 'MISMATCHED', note: null, expectedAmount: 17.5, statementAmount: 0, difference: -17.5, statementFee: null,
    order: { id: 'x', orderNumber: 'JO-2026-0001', merchantRef: 'JO-2026-0001', shippingStatus: 'SHIPPED' },
    statementLine: { merchantRef: 'JO-2026-0001', barcode: null, amount: 0, status: 'مرتجع', rawRow: null },
  },
  {
    ...base, id: 'answered', result: 'MISMATCHED', note: null, expectedAmount: 20, statementAmount: 18, difference: -2, resolution: 'OURS_STANDS', resolutionNote: 'نطالب',
    order: { id: 'o3', orderNumber: 'JO-2026-0003', merchantRef: 'JO-2026-0003', shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: 'JO-2026-0003', barcode: null, amount: 18, status: null, rawRow: null },
  },
  {
    ...base, id: 'by-hand', result: 'MISMATCHED', note: null, matchedBy: 'MANUAL', expectedAmount: 20, statementAmount: 18, difference: -2,
    order: { id: 'o4', orderNumber: 'JO-2026-0004', merchantRef: 'JO-2026-0004', shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: 'JO-2026-0004', barcode: null, amount: 18, status: null, rawRow: null },
  },
  {
    ...base, id: 'clean', result: 'MATCHED', note: null, expectedAmount: 10, statementAmount: 10, difference: 0,
    order: { id: 'o5', orderNumber: 'JO-2026-0005', merchantRef: 'JO-2026-0005', shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: 'JO-2026-0005', barcode: null, amount: 10, status: null, rawRow: null },
  },
];

const found = {
  box: { orderNumber: 'JO-2026-0002', pieces: 2, products: ['عطر'], blockedBy: [] as string[] },
  hint: null,
  candidates: [
    { id: 'x', orderNumber: 'JO-2026-0001', customer: { id: 'cuA', fullName: 'سارة', phone: '790000001' }, shippingStatus: 'SHIPPED', expected: 17.5, blockedBy: [] as string[] },
    { id: 'z', orderNumber: 'JO-2026-0007', customer: { id: 'cuC', fullName: 'هبة', phone: '790000003' }, shippingStatus: 'DELIVERED', expected: 9, blockedBy: ['الطلب مُسوّى أصلاً (حُصّل يدوياً أو بكشف)'] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  permissions.current = ['settlement.review'];
  approved.current = false;
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/finance/statements') {
      return {
        statements: [{
          id: 's1', reference: 'ST-1', status: approved.current ? 'APPROVED' : 'MATCHED', approvedAt: approved.current ? '2026-10-29T10:00:00Z' : null,
          currencyCode: 'JOD', counts: { lines: 4, receipts: 1, matches: 5 },
        }],
      };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches } };
    if (url.startsWith('/api/finance/statements/s1/matches/money/swap') && init?.method === 'POST') {
      return { message: 'سُجّل التبديل: بضاعة JO-2026-0002 صارت بيعة زبون JO-2026-0001 بالطلب JO-2026-0100' };
    }
    if (url.startsWith('/api/finance/statements/s1/matches/money/swap')) return found;
    return {};
  });
});
afterEach(cleanup);

const buttons = () => screen.queryAllByRole('button', { name: /كان من طرد طلب آخر/ });
const open = async () => {
  render(<MatchingScreen />);
  await screen.findAllByText('فرق في المبلغ');
};

describe('where the button is', () => {
  it('is on the row that carries money for an order — once per rendering of it — and on no other', async () => {
    await open();
    await waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    // The money row shows once as a desk row and once as a card; the zero line, the answered line, the line a
    // person tied by hand and the clean line have none.
    expect(buttons()).toHaveLength(2);
  });

  it('is not offered to somebody without the review permission', async () => {
    permissions.current = ['ops.track'];
    await open();
    expect(buttons()).toEqual([]);
  });

  it('is not offered once the statement is approved', async () => {
    approved.current = true;
    await open();
    expect(buttons()).toEqual([]);
  });
});

describe('the dialog', () => {
  const search = async () => {
    await open();
    await waitFor(() => expect(buttons().length).toBeGreaterThan(0));
    fireEvent.click(buttons()[0]);
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '790000001' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'ابحث' }));
    await within(dialog).findByText('JO-2026-0001');
    return dialog;
  };

  it('asks what the box is and who might have taken it, with the server\'s sentence on a customer it refuses', async () => {
    const dialog = await search();
    expect(api.mock.calls.some((c) => String(c[0]).includes('/matches/money/swap?q=790000001'))).toBe(true);
    expect(within(dialog).getByText(/الصندوق من الطلب/).textContent).toContain('2 قطعة');
    expect(within(dialog).getByText(/مُسوّى أصلاً/)).toBeTruthy();
    const refused = within(dialog).getByText('JO-2026-0007').closest('button') as HTMLButtonElement;
    expect(refused.disabled).toBe(true);
    // nothing to answer until a customer is picked
    expect(within(dialog).queryByRole('spinbutton')).toBeNull();
    expect((within(dialog).getByRole('button', { name: 'اختر الطلب' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('after a pick: a number that starts at the whole box and cannot go past it, and a select for the other box', async () => {
    const dialog = await search();
    fireEvent.click(within(dialog).getByText('JO-2026-0001').closest('button')!);
    const pieces = within(dialog).getByRole('spinbutton') as HTMLInputElement;
    expect(pieces.value).toBe('2');
    expect(pieces.max).toBe('2');
    const save = within(dialog).getByRole('button', { name: /سجّل التبديل/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.change(pieces, { target: { value: '3' } });
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByText(/من 1 إلى 2/)).toBeTruthy();
    fireEvent.change(pieces, { target: { value: '0' } });
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByRole('combobox')).toBeTruthy();
  });

  it('posts exactly the three answers and the picked order, then closes and reloads the screen', async () => {
    const dialog = await search();
    fireEvent.click(within(dialog).getByText('JO-2026-0001').closest('button')!);
    fireEvent.change(within(dialog).getByRole('spinbutton'), { target: { value: '1' } });
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'no' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /سجّل التبديل/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toBe('/api/finance/statements/s1/matches/money/swap');
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ ownerOrderId: 'x', pieces: 1, ownerBoxBack: false });
    // the statement was read again afterwards
    expect(api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1').length).toBeGreaterThan(1);
  });

  it('shows the server\'s own sentence when it refuses, and stays open', async () => {
    const dialog = await search();
    api.mockImplementationOnce(async () => {
      throw new Error('الكشف معتمد — التصحيح بعد الاعتماد يكون بكشف تسوية');
    });
    fireEvent.click(within(dialog).getByText('JO-2026-0001').closest('button')!);
    fireEvent.click(within(dialog).getByRole('button', { name: /سجّل التبديل/ }));
    expect(await within(dialog).findByText('الكشف معتمد — التصحيح بعد الاعتماد يكون بكشف تسوية')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });

  it('greys every customer when the box itself cannot be swapped, and says why above them', async () => {
    found.box.blockedBy = ['الطلب صاحب الصندوق لم يُطلب إلغاؤه — سجّل إلغاءه (طلب إلغاء بعد الشحن) ثم أعد'];
    const dialog = await search();
    expect(within(dialog).getByText(/لم يُطلب إلغاؤه/)).toBeTruthy();
    const first = within(dialog).getByText('JO-2026-0001').closest('button') as HTMLButtonElement;
    expect(first.disabled).toBe(true);
    found.box.blockedBy = [];
  });
});
