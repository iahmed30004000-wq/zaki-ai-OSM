// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE MATCHING SCREEN: THE COMPANY'S REASON IN ITS OWN WORDS, AND «طلبات لم يذكرها أي كشف».
 *
 * · «رقمنا / رقمهم» is offered on the rows of «فرق في المبلغ» and on no other row;
 * · a line with no order, and a mismatched one, show the company's status word and its whole row;
 * · the fourth group is renamed, shows each order's own outcome word, and offers three actions on the ORDER,
 *   the third only where a door exists to correct the status.
 */
const { api, permissions } = vi.hoisted(() => ({ api: vi.fn(), permissions: { current: ['settlement.review', 'ops.track'] as string[] } }));
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
  matchedBy: 'MERCHANT_REF', expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  courierWord: null, orderOutcome: null, followUp: null,
};
const order = (n: number, shippingStatus = 'DELIVERED') => ({ id: `o${n}`, orderNumber: `ORD-${n}`, merchantRef: `REF-${n}`, shippingStatus });

const matches = [
  {
    ...base, id: 'mm', result: 'MATCHED', note: null, expectedAmount: 10, statementAmount: 10, difference: 0,
    order: order(1), statementLine: { merchantRef: 'REF-1', barcode: null, amount: 10, status: 'تم توصيلها', rawRow: 'raw-matched' },
  },
  {
    ...base, id: 'dif', result: 'MISMATCHED', note: 'قالت الشركة: «مؤجلة»', expectedAmount: 20, statementAmount: 0, difference: -20,
    order: order(2),
    statementLine: { merchantRef: 'REF-2', barcode: 'BC2', amount: 0, status: 'مؤجلة', rawRow: 'BC2 | 15132 - العميل طلب التأجيل | | | | مؤجلة' },
    courierWord: { phrase: 'مؤجلة', outcome: 'POSTPONED', known: true, label: 'تقول الشركة: مؤجَّل' },
  },
  {
    ...base, id: 'nosys', result: 'MISSING_IN_SYSTEM', note: 'x', expectedAmount: null, statementAmount: 7, difference: null,
    order: null,
    statementLine: { merchantRef: 'REF-9', barcode: null, amount: 7, status: 'حالة جديدة', rawRow: 'raw-unknown-row' },
    courierWord: { phrase: 'حالة جديدة', outcome: 'UNKNOWN', known: false, label: 'كلمة لا نعرفها بعد' },
  },
  {
    ...base, id: 'miss', result: 'MISSING_IN_STATEMENT', note: null, expectedAmount: 30, statementAmount: null, difference: null,
    order: order(3), statementLine: null, orderOutcome: { key: 'DELIVERED_AWAITING_CASH', label: 'تم التسليم — بانتظار التحصيل' },
  },
  {
    ...base, id: 'miss2', result: 'MISSING_IN_STATEMENT', note: null, expectedAmount: 31, statementAmount: null, difference: null,
    order: order(4, 'PARTIALLY_DELIVERED'), statementLine: null, orderOutcome: { key: 'PARTIAL_OPEN', label: 'تسليم جزئي — بانتظار المال أو المرجع' },
    followUp: { action: 'STATEMENT_CHASE_COURIER', at: '2026-10-29T10:00:00Z' },
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  permissions.current = ['settlement.review', 'ops.track'];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/finance/statements') {
      return { statements: [{ id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, currencyCode: 'JOD', counts: { lines: 3, receipts: 1, matches: 5 } }] };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches } };
    if (url.endsWith('/order-action') && init?.method === 'POST') return { ok: true };
    return {};
  });
});
afterEach(cleanup);

const loaded = () => screen.findAllByText('طلبات لم يذكرها أي كشف');

describe('the queues', () => {
  it('names the fourth «طلبات لم يذكرها أي كشف», and the old name is gone', async () => {
    render(<MatchingScreen />);
    expect((await loaded()).length).toBeGreaterThan(0);
    expect(screen.queryByText('مسلَّم عندنا وليس في الكشف')).toBeNull();
  });

  it('offers رقمنا / رقمهم once per row of «فرق في المبلغ» — the desk and the card — and nowhere else', async () => {
    render(<MatchingScreen />);
    await loaded();
    // One mismatched row, drawn twice (table + card). Before: three queues carried it, six buttons.
    expect(screen.getAllByRole('button', { name: /رقمنا هو المعتمد/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: /اعتُمد رقم الشركة/ })).toHaveLength(2);
  });

  it('shows the company’s word and its whole row on a mismatch and on a line with no order', async () => {
    render(<MatchingScreen />);
    await loaded();
    expect(screen.getAllByText(/«مؤجلة»/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('BC2 | 15132 - العميل طلب التأجيل | | | | مؤجلة').length).toBeGreaterThan(0);
    // An unknown word is shown as written, with the plain statement that it is unknown.
    expect(screen.getAllByText(/«حالة جديدة»/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('كلمة لا نعرفها بعد').length).toBeGreaterThan(0);
    expect(screen.getAllByText('raw-unknown-row').length).toBeGreaterThan(0);
    expect(screen.getAllByText('سبب الشركة بكلامها').length).toBeGreaterThan(0);
  });

  it('and shows each unmentioned order’s own outcome word', async () => {
    render(<MatchingScreen />);
    await loaded();
    expect(screen.getAllByText('تم التسليم — بانتظار التحصيل').length).toBeGreaterThan(0);
    expect(screen.getAllByText('تسليم جزئي — بانتظار المال أو المرجع').length).toBeGreaterThan(0);
  });
});

describe('the three actions on an unmentioned order', () => {
  it('offers two of them to somebody who cannot correct a status, and all three to somebody who can', async () => {
    render(<MatchingScreen />);
    await loaded();
    expect(screen.getAllByRole('button', { name: 'انتظر كشفاً لاحقاً' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'طالِب الشركة به' }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'لم يُسلَّم — صحّح الحالة' })).toHaveLength(0);

    cleanup();
    permissions.current = ['settlement.review', 'ops.track', 'orders.unlock'];
    render(<MatchingScreen />);
    await loaded();
    expect(screen.getAllByRole('button', { name: 'لم يُسلَّم — صحّح الحالة' }).length).toBeGreaterThan(0);
  });

  it('a press posts to the order-action door for THAT row, with the answer, and reloads the statement', async () => {
    render(<MatchingScreen />);
    await loaded();
    const before = api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1').length;
    fireEvent.click(screen.getAllByRole('button', { name: 'طالِب الشركة به' })[0]);
    await waitFor(() => {
      const post = api.mock.calls.find((c) => String(c[0]).endsWith('/order-action'));
      expect(post).toBeDefined();
      expect(post![0]).toBe('/api/finance/statements/s1/matches/miss/order-action');
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ action: 'CHASE_COURIER' });
    });
    await waitFor(() => expect(api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1').length).toBeGreaterThan(before));
  });

  it('what was last recorded stays on the row as a chip', async () => {
    render(<MatchingScreen />);
    await loaded();
    // The fifth match carries a follow-up: the chip repeats the button's own words, beside the button.
    expect(screen.getAllByText('طالِب الشركة به').length).toBeGreaterThan(2);
  });
});
