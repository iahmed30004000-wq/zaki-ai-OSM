// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «اربطه بطلب» ON THE MATCHING SCREEN.
 *
 * · offered on the rows of «في الكشف وليس عندنا» and on no other group;
 * · only to somebody who holds the review permission, and never on an approved statement;
 * · a real search box, the header «لهذا الرقم …» from the server, an order the rules refuse shown greyed with
 *   its reason, and a warning on an order of another courier that must be acknowledged on the way through.
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
  matchedBy: null, expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  courierWord: null, orderOutcome: null, followUp: null, expectedAmount: null, difference: null,
};
const matches = [
  {
    ...base, id: 'nosys', result: 'MISSING_IN_SYSTEM', note: 'x', statementAmount: 7, order: null,
    statementLine: { merchantRef: null, barcode: 'BC-77', amount: 7, status: null, rawRow: '0790000001' },
  },
  {
    ...base, id: 'dif', result: 'MISMATCHED', note: null, expectedAmount: 20, statementAmount: 18, difference: -2,
    order: { id: 'o2', orderNumber: 'ORD-2', merchantRef: 'REF-2', shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: 'REF-2', barcode: null, amount: 18, status: null, rawRow: null },
  },
];

const found = {
  header: 'لهذا الرقم 3 طلبات: 1 مغلق، 2 مفتوحة',
  counts: { total: 3, closed: 1, open: 2 },
  hint: null,
  otherCourierWarning: 'هذا الطلب مع شركة شحن أخرى غير صاحبة الكشف',
  candidates: [
    { id: 'a', orderNumber: 'ORD-A', merchantRef: null, customer: { id: 'c', fullName: 'سارة', phone: '0790000001' }, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING', closed: false, expected: 7, distance: 0, otherCourier: false, blockedBy: [] },
    { id: 'b', orderNumber: 'ORD-B', merchantRef: null, customer: { id: 'c', fullName: 'سارة', phone: '0790000001' }, shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED', closed: true, expected: 7, distance: 0, otherCourier: false, blockedBy: ['حُصّل يدوياً — مبلغه دخل قبل الكشف'] },
    { id: 'c', orderNumber: 'ORD-C', merchantRef: null, customer: { id: 'c', fullName: 'سارة', phone: '0790000001' }, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING', closed: false, expected: 9, distance: 2, otherCourier: true, blockedBy: [] },
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
          currencyCode: 'JOD', counts: { lines: 2, receipts: 1, matches: 2 },
        }],
      };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches } };
    if (url.startsWith('/api/finance/statements/s1/matches/nosys/link') && init?.method === 'POST') {
      return { message: 'رُبط السطر بالطلب', linked: { result: 'MATCHED' } };
    }
    if (url.startsWith('/api/finance/statements/s1/matches/nosys/link')) return found;
    return {};
  });
});
afterEach(cleanup);

const open = async () => {
  render(<MatchingScreen />);
  return screen.findAllByRole('button', { name: /اربطه بطلب/ });
};

describe('where the button is', () => {
  it('is on the row of «في الكشف وليس عندنا», once per row (desk and card), and not on the difference row', async () => {
    const buttons = await open();
    expect(buttons.length).toBeGreaterThan(0);
    // One per rendering of the unlinked line, and the difference row (ORD-2) has its own answers instead.
    expect(buttons).toHaveLength(screen.getAllByText('BC-77').length);
    expect(screen.queryAllByText('رقمنا هو المعتمد').length).toBeGreaterThan(0);
    expect(api.mock.calls.filter((c) => String(c[0]).includes('/link'))).toEqual([]);
  });

  it('is not offered to somebody without the review permission', async () => {
    permissions.current = ['ops.track'];
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.queryAllByRole('button', { name: /اربطه بطلب/ })).toEqual([]);
  });

  it('is not offered once the statement is approved', async () => {
    approved.current = true;
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.queryAllByRole('button', { name: /اربطه بطلب/ })).toEqual([]);
  });
});

describe('the dialog', () => {
  const search = async () => {
    const [button] = await open();
    fireEvent.click(button);
    const box = await screen.findByLabelText('البحث');
    fireEvent.change(box, { target: { value: '0790000001' } });
    fireEvent.click(screen.getByRole('button', { name: 'ابحث' }));
    await screen.findByText(found.header);
    return box;
  };

  it('has a real search box, and asks the server with what was typed', async () => {
    const box = await search();
    expect(box.tagName).toBe('INPUT');
    expect(api).toHaveBeenCalledWith('/api/finance/statements/s1/matches/nosys/link?q=0790000001');
  });

  it('shows the header, greys out the refused order with its reason, and warns on the other courier’s', async () => {
    await search();
    expect(screen.getByText('حُصّل يدوياً — مبلغه دخل قبل الكشف')).toBeTruthy();
    const refused = screen.getByText('ORD-B').closest('button')!;
    expect((refused as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(found.otherCourierWarning)).toBeTruthy();
    expect((screen.getByText('ORD-A').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('links the order picked; an ordinary order carries no acknowledgement', async () => {
    await search();
    fireEvent.click(screen.getByText('ORD-A'));
    fireEvent.click(screen.getByRole('button', { name: 'اربطه بالطلب ORD-A' }));
    await waitFor(() => expect(api.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(post[0]).toBe('/api/finance/statements/s1/matches/nosys/link');
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ orderId: 'a', acceptOtherCourier: false });
  });

  it('an order of another courier is sent with the acknowledgement the warning asked for', async () => {
    await search();
    fireEvent.click(screen.getByText('ORD-C'));
    fireEvent.click(screen.getByRole('button', { name: 'اربطه بالطلب ORD-C' }));
    await waitFor(() => expect(api.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ orderId: 'c', acceptOtherCourier: true });
  });

  it('says nothing is chosen until an order is picked', async () => {
    await search();
    const dialog = screen.getByRole('dialog');
    const go = within(dialog).getByRole('button', { name: 'اختر طلباً' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
  });
});
