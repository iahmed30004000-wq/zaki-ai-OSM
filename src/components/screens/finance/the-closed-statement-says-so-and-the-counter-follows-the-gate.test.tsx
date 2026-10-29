// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE LOCK ON THE SCREENS.
 *
 * · A statement still open shows, beside each statement and on the headings of its queues, how many lines are
 *   still a question — the number the approval waits for — and the approval button is grey for exactly that reason.
 * · A line no order carries offers the one answer it may have («قيد المراجعة» with a reason), and no figure.
 * · An approved statement says «الكشف مغلق نهائياً — التصحيح بكشف تسوية»; its unanswered rows carry that sentence
 *   instead of a form; nothing offers a decision, a link, a swap or a new matching.
 */
const { api, approved } = vi.hoisted(() => ({ api: vi.fn(), approved: { current: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({
    currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: ['settlement.review', 'settlement.upload'] },
  }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => async () => true, useAsk: () => async () => null }));
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';
import { CollectionScreen } from './CollectionScreen';

const CLOSED = 'الكشف مغلق نهائياً — التصحيح بكشف تسوية';
const base = {
  matchedBy: null, expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  courierWord: null, orderOutcome: null, followUp: null, expectedAmount: null, difference: null, orderId: null,
};
const matches = [
  {
    ...base, id: 'stray', result: 'MISSING_IN_SYSTEM', note: 'x', statementAmount: 7, order: null,
    statementLine: { merchantRef: null, barcode: 'BC-77', amount: 7, status: null, rawRow: null },
  },
  {
    ...base, id: 'dif', result: 'MISMATCHED', note: null, expectedAmount: 20, statementAmount: 18, difference: -2, orderId: 'o2',
    order: { id: 'o2', orderNumber: 'ORD-2', merchantRef: 'REF-2', shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: 'REF-2', barcode: null, amount: 18, status: null, rawRow: null },
  },
  {
    ...base, id: 'answered', result: 'MISMATCHED', note: null, expectedAmount: 20, statementAmount: 19, difference: -1, orderId: 'o3',
    resolution: 'OURS_STANDS', resolutionNote: 'نطالب بالفرق',
    order: { id: 'o3', orderNumber: 'ORD-3', merchantRef: 'REF-3', shippingStatus: 'DELIVERED' },
    statementLine: { merchantRef: 'REF-3', barcode: null, amount: 19, status: null, rawRow: null },
  },
];

const gap = { claimed: 35, received: 35, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 };
const statementRow = () => ({
  id: 's1', reference: 'ST-1', fileName: 'x.xlsx', status: approved.current ? 'APPROVED' : 'MATCHED',
  approvedAt: approved.current ? '2026-10-29T10:00:00Z' : null,
  currencyCode: 'JOD', totalAmount: 35, createdAt: '2026-10-28T00:00:00Z', periodFrom: null, periodTo: null,
  counts: { lines: 3, receipts: 1, matches: 3, openLines: approved.current ? 2 : 2 },
  receipts: [{ id: 'r1', amount: 35, currencyCode: 'JOD', receivedAt: '2026-10-28T09:00:00Z', note: null, wallet: 'الصندوق', proof: null }],
  gap,
});

beforeEach(() => {
  vi.clearAllMocks();
  approved.current = false;
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/statements') return { statements: [statementRow()] };
    if (url === '/api/finance/statements/s1') return { statement: { matches } };
    if (url.startsWith('/api/finance/statements/s1/matches/stray/resolve')) return { message: 'ok' };
    if (url.startsWith('/api/ops/references')) return { providers: [] };
    if (url.startsWith('/api/finance/wallets')) return { wallets: [] };
    return {};
  });
});
afterEach(cleanup);

describe('a statement still open', () => {
  it('the headings of the two queues say how many lines are still a question — and the answered row is not counted', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    // «فرق في المبلغ»: two rows, one answered → 1 open. «في الكشف وليس عندنا»: one row, open → 1.
    expect(screen.getAllByText('1 بلا بتّ')).toHaveLength(2);
    expect(screen.queryByText(CLOSED, { exact: false })).toBeNull();
  });

  it('the statement’s own option in the list carries the number from the list', async () => {
    render(<MatchingScreen />);
    expect(await screen.findByRole('option', { name: /ST-1 — 3 مطابقة · 2 بلا بتّ/ })).toBeTruthy();
  });

  it('a line no order carries offers «قيد المراجعة» with a reason, and NO figure to choose', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    // The difference row offers the two figures (for «dif») — the stray line must offer only the park.
    const strayRow = screen.getAllByText('BC-77')[0].closest('tr') as HTMLElement;
    expect(within(strayRow).getByRole('button', { name: 'قيد المراجعة' })).toBeTruthy();
    expect(within(strayRow).queryByRole('button', { name: 'رقمنا هو المعتمد' })).toBeNull();
    expect(within(strayRow).queryByRole('button', { name: 'اعتُمد رقم الشركة' })).toBeNull();
  });

  it('parking it asks for the reason first, and then posts «قيد المراجعة» to the door with it', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    const strayRow = screen.getAllByText('BC-77')[0].closest('tr') as HTMLElement;

    fireEvent.click(within(strayRow).getByRole('button', { name: 'قيد المراجعة' }));
    expect(api.mock.calls.some((c) => String(c[0]).includes('/stray/resolve'))).toBe(false);

    fireEvent.change(within(strayRow).getByLabelText('تفسير القرار'), { target: { value: 'من كشف شركة أخرى' } });
    fireEvent.click(within(strayRow).getByRole('button', { name: 'قيد المراجعة' }));
    await waitFor(() => expect(api.mock.calls.some((c) => String(c[0]).includes('/stray/resolve'))).toBe(true));
    const post = api.mock.calls.find((c) => String(c[0]).includes('/stray/resolve'))!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({ resolution: 'UNDER_REVIEW', note: 'من كشف شركة أخرى' });
  });

  it('the approval button is grey, and what it says is the server’s sentence for the same number', async () => {
    render(<CollectionScreen />);
    const approve = (await screen.findAllByRole('button', { name: 'اعتماد' }))[0] as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.title).toBe('بقي 2 سطر بلا بتّ أو ربط — ابتّ فيها قبل الاعتماد، فالكشف بعده يُغلق نهائياً');
    expect(screen.getAllByText(/2 بلا بتّ/).length).toBeGreaterThan(0);
  });

  it('and with nothing left to answer the same button is live', async () => {
    const was = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) =>
      url === '/api/finance/statements'
        ? { statements: [{ ...statementRow(), counts: { lines: 3, receipts: 1, matches: 3, openLines: 0 } }] }
        : was(url, init)
    );
    render(<CollectionScreen />);
    const approve = (await screen.findAllByRole('button', { name: 'اعتماد' }))[0] as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
  });
});

describe('a statement approved', () => {
  beforeEach(() => {
    approved.current = true;
  });

  it('the screen says it is closed for good and where the correction goes; no counter, no decision, no link, no new matching', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.getAllByText(CLOSED, { exact: false }).length).toBeGreaterThan(0);
    expect(screen.queryByText(/بلا بتّ/)).toBeNull();
    expect(screen.queryAllByRole('button', { name: /اربطه بطلب/ })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: 'رقمنا هو المعتمد' })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: 'قيد المراجعة' })).toEqual([]);
    expect(screen.queryAllByLabelText('تفسير القرار')).toEqual([]);
    expect((screen.getByRole('button', { name: 'تشغيل المطابقة' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'تشغيل المطابقة' }) as HTMLButtonElement).title).toBe(CLOSED);
  });

  it('the rows nobody answered carry the sentence in place of the form; an answered one still shows its answer, without «غيّر البتّ»', async () => {
    render(<MatchingScreen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    expect(screen.getAllByText(CLOSED).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('رقمنا هو المعتمد').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'غيّر البتّ' })).toEqual([]);
  });

  it('the card of the statement says it too, and keeps no «بلا بتّ» counter', async () => {
    render(<CollectionScreen />);
    expect((await screen.findAllByText(CLOSED)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/بلا بتّ/)).toBeNull();
  });
});
