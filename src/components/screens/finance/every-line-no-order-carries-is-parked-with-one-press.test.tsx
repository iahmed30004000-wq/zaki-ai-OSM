// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «ركّن كل السطور بلا طلب» ON THE MATCHING SCREEN
 *
 *  · above «في الكشف وليس عندنا»: how many lines it would park, said BEFORE the press — only lines with no order and no answer;
 *  · the reason under the single door's rule, checked before anything is asked;
 *  · ONE confirm that names the count; declined, nothing is sent; accepted, one request with the reason, then the rows reload;
 *  · drawn only for «مراجعة المطابقات», only while the matching is open, only when there is something to park.
 * ═══════════════════════════════════════════════════════════════════════
 */
const { api, permissions } = vi.hoisted(() => ({
  api: vi.fn(),
  permissions: { current: ['settlement.view', 'settlement.review'] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: permissions.current } }),
}));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';
import { ParkUnlinkedLines } from './ParkUnlinkedLines';

const lineOf = (n: number) => ({
  merchantRef: `1${n}051`, barcode: `B${String(n).padStart(6, '0')}`, amount: '12', collected: '15', fee: '3', status: 'تم التسليم',
  rawRow: `B${n} | 1${n}051`, receiverName: null, receiverPhone: null, receiverAddress: null, receiverCity: null, receiverArea: null,
});
const row = (id: string, n: number, over: Record<string, unknown> = {}) => ({
  id, result: 'MISSING_IN_SYSTEM', matchedBy: null, orderId: null, statementAmount: '12', expectedAmount: null, difference: null,
  expectedFee: null, statementFee: '3', feeDifference: null, resolution: null, resolutionNote: null, note: null,
  orderOutcome: null, followUp: null, claim: null, decisions: null, wordGroup: null,
  courierWord: { phrase: 'تم التسليم', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' },
  statementLine: lineOf(n), order: null, ...over,
});

const PRESS = /ركّن كل السطور بلا طلب/;
const EXPLANATION = 'اكتب تفسيراً واضحاً: 5 أحرف على الأقل، منها 3 حروف أو أرقام';
const REASON = 'طرود النظام القديم';

let rows: Record<string, unknown>[];
let statementOver: Record<string, unknown>;
let confirmSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  permissions.current = ['settlement.view', 'settlement.review'];
  statementOver = {};
  rows = [
    row('a1', 1),
    row('a2', 2),
    // tied to an order: not this question
    row('linked', 3, { orderId: 'o3', order: { id: 'o3', orderNumber: 'ORD-3', merchantRef: null, shippingStatus: 'DELIVERED' } }),
    // already answered: not counted again
    row('answered', 4, { resolution: 'UNDER_REVIEW', resolutionNote: 'سبب سابق' }),
  ];
  confirmSpy = vi.fn(() => true);
  vi.stubGlobal('confirm', confirmSpy);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/statements') {
      return {
        statements: [{ id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, matchingClosedAt: null, currencyCode: 'USD', counts: { lines: rows.length, receipts: 1, matches: rows.length }, ...statementOver }],
      };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches: rows } };
    if (url === '/api/finance/settlement-differences') return { people: [], minSettledOrders: 20, unattributed: { settledOrders: 0, differences: 0 } };
    if (url === '/api/finance/statements/s1/park-unlinked') return { parked: 2, message: 'قيد المراجعة — 2 سطراً بلا طلب.' };
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const parkCalls = () => api.mock.calls.filter((c) => String(c[0]).endsWith('/park-unlinked'));

describe('on the matching screen', () => {
  it('says the count before the press — the two lines with no order and no answer, not the linked one, not the answered one', async () => {
    render(<MatchingScreen />);
    const button = await screen.findByRole('button', { name: PRESS });
    expect(button.textContent).toContain('(2)');
    expect(screen.getByText(/^2 سطراً بالكشف/)).toBeTruthy();
  });

  it('NEGATIVE: not drawn for who may only see the statements', async () => {
    permissions.current = ['settlement.view'];
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.queryByRole('button', { name: PRESS })).toBeNull();
  });

  it('NEGATIVE: not drawn on a statement whose matching is closed', async () => {
    statementOver = { status: 'APPROVED', approvedAt: '2026-11-20T10:00:00Z', matchingClosedAt: '2026-11-20T10:00:00Z' };
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.queryByRole('button', { name: PRESS })).toBeNull();
  });

  it('NEGATIVE: not drawn when every line with no order is already answered or linked', async () => {
    rows = rows.slice(2);
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.queryByRole('button', { name: PRESS })).toBeNull();
  });

  it('one confirm naming the count, one request with the reason, then the rows are read again', async () => {
    render(<MatchingScreen />);
    await userEvent.type(await screen.findByLabelText('السبب'), REASON);
    const readsBefore = api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1').length;
    await userEvent.click(screen.getByRole('button', { name: PRESS }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(String(confirmSpy.mock.calls[0][0])).toContain('ركّن 2 سطراً بلا طلب؟');
    await waitFor(() => expect(parkCalls()).toHaveLength(1));
    const [url, init] = parkCalls()[0] as [string, { method: string; body: string }];
    expect(url).toBe('/api/finance/statements/s1/park-unlinked');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ note: REASON });
    await waitFor(() => expect(api.mock.calls.filter((c) => c[0] === '/api/finance/statements/s1').length).toBe(readsBefore + 1));
  });
});

describe('the press itself', () => {
  const lines = [
    { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: null },
    { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: null },
    { result: 'MISSING_IN_SYSTEM', orderId: null, resolution: null },
    { result: 'MISMATCHED', orderId: null, resolution: null },
  ];

  it('NEGATIVE: a reason that is not one is told at once — no question asked, nothing sent', async () => {
    render(<ParkUnlinkedLines statementId="s1" rows={lines} onDone={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('السبب'), '....');
    await userEvent.click(screen.getByRole('button', { name: PRESS }));
    expect(screen.getByText(EXPLANATION)).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(parkCalls()).toHaveLength(0);
  });

  it('NEGATIVE: declined at the question — nothing sent', async () => {
    confirmSpy.mockReturnValue(false);
    const onDone = vi.fn();
    render(<ParkUnlinkedLines statementId="s1" rows={lines} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText('السبب'), REASON);
    await userEvent.click(screen.getByRole('button', { name: PRESS }));
    expect(String(confirmSpy.mock.calls[0][0])).toContain('ركّن 3 سطراً');
    expect(parkCalls()).toHaveLength(0);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('a refusal from the door is shown in its own words, and the screen is not reloaded', async () => {
    api.mockRejectedValueOnce(new Error('الكشف مغلق نهائياً — التصحيح بكشف تسوية'));
    const onDone = vi.fn();
    render(<ParkUnlinkedLines statementId="s1" rows={lines} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText('السبب'), REASON);
    await userEvent.click(screen.getByRole('button', { name: PRESS }));
    expect(await screen.findByText('الكشف مغلق نهائياً — التصحيح بكشف تسوية')).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('every word on it is Arabic, its digits Western', () => {
    render(<ParkUnlinkedLines statementId="s1" rows={lines} onDone={vi.fn()} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/[٠-٩]/);
    expect(text).toContain('3');
  });
});
