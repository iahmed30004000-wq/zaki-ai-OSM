// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A CONTROL IS DRAWN FOR THE KEY ITS DOOR ASKS (perm-plan PR-9) — the three money screens.
 *
 * The cash box’s screens now open on `finance.cashbox_view`; the statement’s on its own keys. Inside them each press is
 * drawn only for the key its door asks, so nobody is offered a button that ends in a refusal:
 *
 *   «اعتماد» (a courier statement)       settlement.approve
 *   «محفظة جديدة», rename, stop, delete   finance.wallets_manage
 *   «حركة جديدة», «قيد عكسي»              finance.cashbox
 *   «تسجيل الجرد», «تعديل الجرد»          finance.cashbox
 *   «اعتماد» (a daily closing)           finance.closing_approve
 *
 * The owner’s rule for this change, in his words: «اي قرار بعد الان اتخذو دون الرجوع الي».
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, who } = vi.hoisted(() => ({ api: vi.fn(), who: { keys: [] as string[] } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/collection',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: who.keys } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>عنوان</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useAsk: () => async () => null, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));

import { CollectionScreen } from './CollectionScreen';
import { WalletsScreen } from './WalletsScreen';
import { ClosingScreen } from './ClosingScreen';

const as = (...keys: string[]) => { who.keys = keys; };

const gap = { claimed: 100, received: 0, gap: 100, needsExplanation: false, explained: false, unconvertible: 0 };
const STATEMENT = {
  id: 's1', reference: 'ST-2026-09', fileName: 'x.xlsx', status: 'MATCHED', approvedAt: null,
  currencyCode: 'USD', totalAmount: 100, createdAt: '2026-10-24T00:00:00Z', periodFrom: null, periodTo: null,
  counts: { lines: 3, receipts: 1, matches: 3 }, receipts: [], gap,
};
const WALLET = {
  id: 'w1', name: 'الصندوق', currencyCode: 'USD', isActive: true, opening: 0, in: 0, out: 0, balance: 0,
  movements: 2, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};
const CLOSING_ROW = {
  walletId: 'w1', walletName: 'الصندوق', currencyCode: 'USD', minorUnit: 2, bookBalance: 10, blockedBy: null,
  closing: { id: 'cl1', status: 'RECORDED', actualBalance: 10, difference: 0, explanation: null },
};

beforeEach(() => {
  vi.clearAllMocks();
  as();
  api.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/finance/statements')) return { statements: [STATEMENT] };
    if (url.startsWith('/api/ops/references')) return { providers: [] };
    if (url.includes('/movements')) {
      return { movements: [{ id: 'm1', direction: 'IN', amount: 5, party: 'x', category: 'OTHER', note: 'ملاحظة', createdAt: '2026-10-24T00:00:00Z', isReversal: false, wasReversed: false }] };
    }
    if (url.startsWith('/api/finance/wallets')) return { wallets: [WALLET] };
    if (url.startsWith('/api/finance/closing')) return { rows: [CLOSING_ROW] };
    return {};
  });
});
afterEach(cleanup);

const has = (name: string | RegExp) => screen.queryAllByRole('button', { name, hidden: true }).length > 0;

describe('the statement’s «اعتماد» — settlement.approve', () => {
  it('NEGATIVE: not drawn for who only reviews and uploads; the other buttons of the row are untouched', async () => {
    as('settlement.view', 'settlement.review', 'settlement.upload');
    render(<CollectionScreen />);
    await screen.findAllByText('ST-2026-09');
    expect(has('اعتماد')).toBe(false);
    expect(has('إيصال استلام')).toBe(true);
    expect(has('مطابقة')).toBe(true);
  });

  it('drawn for who holds the approval', async () => {
    as('settlement.view', 'settlement.approve');
    render(<CollectionScreen />);
    await screen.findAllByText('ST-2026-09');
    expect(has('اعتماد')).toBe(true);
  });
});

describe('the wallets — finance.wallets_manage and finance.cashbox', () => {
  it('NEGATIVE: who only SEES the cash box is offered neither a new wallet, nor a movement, nor a way to rename, stop or delete', async () => {
    as('finance.cashbox_view');
    render(<WalletsScreen />);
    await screen.findAllByText('الصندوق');
    expect(has('محفظة جديدة')).toBe(false);
    expect(has('حركة جديدة')).toBe(false);
    expect(has('عدّل الاسم')).toBe(false);
    expect(has('أوقف المحفظة')).toBe(false);
    expect(has('احذف')).toBe(false);
    expect(has(/قيد عكسي/)).toBe(false);
  });

  it('the wallets’ key draws the creation and the rename/stop/delete — and NOT the cash actions', async () => {
    as('finance.cashbox_view', 'finance.wallets_manage');
    render(<WalletsScreen />);
    await screen.findAllByText('الصندوق');
    expect(has('محفظة جديدة')).toBe(true);
    expect(has('عدّل الاسم')).toBe(true);
    expect(has('أوقف المحفظة')).toBe(true);
    expect(has('احذف')).toBe(true);
    expect(has('حركة جديدة')).toBe(false);
  });

  it('the cash key draws the movement and the reversal — and NOT the wallets’ management', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<WalletsScreen />);
    await screen.findAllByText('الصندوق');
    expect(has('حركة جديدة')).toBe(true);
    expect(await screen.findAllByRole('button', { name: /قيد عكسي/, hidden: true })).not.toHaveLength(0);
    expect(has('محفظة جديدة')).toBe(false);
    expect(has('احذف')).toBe(false);
  });
});

describe('the daily closing — finance.cashbox (the count) and finance.closing_approve (the approval)', () => {
  it('NEGATIVE: who only sees the day can neither count nor approve', async () => {
    as('finance.cashbox_view');
    render(<ClosingScreen />);
    await screen.findAllByText('الصندوق');
    expect(has('تعديل الجرد')).toBe(false);
    expect(has('اعتماد')).toBe(false);
  });

  it('who counts the cash gets the count, and NOT the approval', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<ClosingScreen />);
    await screen.findAllByText('الصندوق');
    expect(has('تعديل الجرد')).toBe(true);
    expect(has('اعتماد')).toBe(false);
  });

  it('who holds the approval gets «اعتماد», and NOT the count', async () => {
    as('finance.cashbox_view', 'finance.closing_approve');
    render(<ClosingScreen />);
    await screen.findAllByText('الصندوق');
    expect(has('اعتماد')).toBe(true);
    expect(has('تعديل الجرد')).toBe(false);
  });
});
