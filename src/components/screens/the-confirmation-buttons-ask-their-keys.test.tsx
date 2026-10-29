// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE BUTTONS ARE DRAWN FOR WHO THE DOOR WILL ANSWER (perm-plan PR-7).
 *
 *   · «اعرضه من جديد» asks `confirmation.winback` — the server says whether the reader holds it (`canOffer`);
 *   · «إلى الطابور» on a COLLEAGUE'S postponed order asks `confirmation.reassign`; on her own it needs nothing more
 *     (`mayHandBack`, from the server, row by row);
 *   · «صحّح البيانات» asks `confirmation.issues_correct` and the void asks `orders.cancel` — and the correction saves the
 *     ORDER first and closes the issue second, so a button the close would refuse must not be drawn at all;
 *   · «موافقة» on a change request that moves a figure asks `orders.change_price` (`needsPriceKey`, from the server),
 *     «رفض» never does.
 *
 * Each case has its NEGATIVE: the same screen, the same row, the key absent.
 */

const { api, user } = vi.hoisted(() => ({
  api: vi.fn(),
  user: { current: { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: [] as string[], status: 'ACTIVE' } as Record<string, unknown> },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, t: { cancel: 'إلغاء' }, locale: 'ar', isRtl: true }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ done: vi.fn(), warn: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/ui/Confirm', () => ({ useAsk: () => vi.fn(), useTell: () => vi.fn(), useConfirm: () => vi.fn() }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/hooks/useRegions', () => ({ useRegions: () => ({ regions: [{ id: 'r1', name: 'دمشق' }], countryName: 'سوريا', currency: { code: 'JOD', minorUnit: 2 } }) }));
vi.mock('@/components/orders/useOrderPatch', () => ({ useOrderPatch: () => vi.fn() }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));

import { WinbackScreen } from './WinbackScreen';
import { ConfirmationPostponedScreen } from './ConfirmationPostponedScreen';
import { ConfirmationIssuesScreen } from './ConfirmationIssuesScreen';
import { ChangeRequestReview } from '@/components/orders/ChangeRequestReview';

const holding = (...keys: string[]) => {
  user.current = { id: 'u1', name: 'سارة', role: 'CUSTOM', permissions: keys, status: 'ACTIVE' };
};

beforeEach(() => {
  vi.clearAllMocks();
  holding();
});
afterEach(cleanup);

// ───────────────────────────── the win-back list ─────────────────────────────

const WINBACK_ROW = {
  id: 'w1', orderNumber: 'ORD-W1', customer: { fullName: 'عميل تجريبي', phone: '0790000000' }, product: 'ساعة', quantity: 2, sellingPrice: 40,
  discountAmount: 0, rejectionReason: 'PRICE_TOO_HIGH', rejectionNote: null, rejectedAt: '2026-09-20T10:00:00.000Z',
  verdict: { eligible: true, dueAt: '2026-10-04T10:00:00.000Z', maxDiscount: 10 },
};
const winbackBody = (over: Record<string, unknown>) => ({
  rows: [WINBACK_ROW],
  pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
  facts: { views: { ready: 1, cooling: 0, skipped: 0 }, reasons: [], products: [], periods: { '7': 0, '30': 0, '90': 0 }, shipping: { before: 1, after: 0 } },
  rule: { reasons: ['PRICE_TOO_HIGH'], afterShipping: true, coolingDays: 14, lookbackDays: 120, maxDiscountShare: 0.25 },
  canEditRule: false,
  ...over,
});

describe('«اعرضه من جديد»', () => {
  it('is drawn when the server says the reader holds the offer’s box', async () => {
    api.mockResolvedValue(winbackBody({ canOffer: true }));
    render(<WinbackScreen />);
    await screen.findByText('ORD-W1');
    expect(screen.getByRole('button', { name: /اعرضه من جديد/ })).toBeTruthy();
  });

  it('NEGATIVE: is NOT drawn when the reader only sees the list — and the row, its ceiling and its reason still are', async () => {
    api.mockResolvedValue(winbackBody({ canOffer: false }));
    render(<WinbackScreen />);
    await screen.findByText('ORD-W1');
    expect(screen.queryByRole('button', { name: /اعرضه من جديد/ }), 'زرٌّ لا يُجاب').toBeNull();
    expect(screen.getByText(/أقصى خصم/)).toBeTruthy();
  });

  it('an older server that does not say is read as «yes» — the door itself still asks', async () => {
    api.mockResolvedValue(winbackBody({}));
    render(<WinbackScreen />);
    await screen.findByText('ORD-W1');
    expect(screen.getByRole('button', { name: /اعرضه من جديد/ })).toBeTruthy();
  });
});

// ───────────────────────────── the postponed list ─────────────────────────────

const POSTPONED_ROW = {
  id: 'p1', orderNumber: 'ORD-P1', totalAmount: 10, currency: 'USD', dueAt: '2026-10-22T10:00:00.000Z', daysRemaining: 1,
  postponePreferredTime: 'MORNING', postponeCount: 2, followUpReason: 'CUSTOMER_BUSY', actionable: true,
  customer: { fullName: 'عميل تجريبي', phone: '0790000000', city: 'عمّان' }, claimer: { id: 'a1', name: 'سارة' },
};
const postponedBody = (over: Record<string, unknown>) => ({
  leadDays: 2, count: 1, orders: [{ ...POSTPONED_ROW, ...over }],
  pagination: { total: 1, page: 1, limit: 25, totalPages: 1 },
  facts: { total: 1, whens: { now: 1, overdue: 0, soon: 0, week: 0, later: 0 }, kinds: { postponed: 1, followup: 0 }, times: { once: 0, many: 1 }, agents: null },
  applied: {},
});

describe('«إلى الطابور»', () => {
  it('is drawn on a row the server says may be handed back', async () => {
    api.mockResolvedValue(postponedBody({ mayHandBack: true }));
    render(<ConfirmationPostponedScreen />);
    await screen.findByLabelText('الموعد');
    expect(screen.getAllByRole('button', { name: /إلى الطابور/ }).length).toBeGreaterThan(0);
  });

  it('NEGATIVE: is NOT drawn on a colleague’s order when the reader lacks the reassign box — a dash stands in its place', async () => {
    api.mockResolvedValue(postponedBody({ mayHandBack: false }));
    render(<ConfirmationPostponedScreen />);
    await screen.findByLabelText('الموعد');
    expect(screen.queryByRole('button', { name: /إلى الطابور/ })).toBeNull();
  });

  it('an older server that does not say is read as «yes»', async () => {
    api.mockResolvedValue(postponedBody({}));
    render(<ConfirmationPostponedScreen />);
    await screen.findByLabelText('الموعد');
    expect(screen.getAllByRole('button', { name: /إلى الطابور/ }).length).toBeGreaterThan(0);
  });
});

// ───────────────────────────── the issues list ─────────────────────────────

const ISSUE = {
  id: 'i1', reason: 'WRONG_PHONE', note: null, status: 'OPEN', createdAt: '2026-10-28T08:00:00.000Z',
  order: {
    id: 'o1', orderNumber: 'JO-1', createdAt: '2026-10-27T08:00:00.000Z', merchantRef: null, source: 'MANUAL', confirmationStatus: 'NEW',
    moderatorId: 'm1', version: 1, regionId: 'r1', region: { id: 'r1', name: 'دمشق' }, product: { name: 'كريم' }, quantity: 1,
    customer: { id: 'c1', fullName: 'سعاد', phone: '0790000000', rawPhone: '0790000000', altPhone: null, city: 'دمشق', address: 'شارع' },
    moderator: { id: 'm1', name: 'منى' },
  },
};

describe('the issues list', () => {
  const draw = async () => {
    api.mockResolvedValue({ issues: [ISSUE] });
    render(<ConfirmationIssuesScreen />);
    await screen.findByText(/JO-1/);
  };

  it('draws «صحّح البيانات» for who holds the correction’s box, and the void for who holds the cancel', async () => {
    holding('confirmation.issues', 'confirmation.issues_correct', 'orders.cancel');
    await draw();
    expect(screen.getByRole('button', { name: /صحّح البيانات/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /إبطال الطلب/ })).toBeTruthy();
  });

  it('NEGATIVE: who only SEES the list gets neither button — the list is all they have', async () => {
    holding('confirmation.issues');
    await draw();
    expect(screen.queryByRole('button', { name: /صحّح البيانات/ }), 'زرٌّ يحفظ الطلب ثم يُرفض إغلاقه').toBeNull();
    expect(screen.queryByRole('button', { name: /إبطال الطلب/ })).toBeNull();
    expect(screen.getByText(/JO-1/)).toBeTruthy();
  });

  it('NEGATIVE: the two boxes are separate — the correction without the cancel draws no void, and the cancel without the correction draws no correction', async () => {
    holding('confirmation.issues', 'confirmation.issues_correct');
    await draw();
    expect(screen.getByRole('button', { name: /صحّح البيانات/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /إبطال الطلب/ })).toBeNull();
    cleanup();
    holding('confirmation.issues', 'orders.cancel');
    await draw();
    expect(screen.queryByRole('button', { name: /صحّح البيانات/ })).toBeNull();
    expect(screen.getByRole('button', { name: /إبطال الطلب/ })).toBeTruthy();
  });
});

// ───────────────────────────── the change request being decided ─────────────────────────────

const REQUEST = {
  id: 'cr1', orderId: 'o1', reason: 'الزبون طلب ثلاثة', createdAt: '2026-10-28T08:00:00.000Z', requestedByName: 'منى',
  order: { orderNumber: 'JO-7' }, changes: { quantity: { from: 2, to: 3 } },
};

describe('«موافقة» on a request that moves a figure', () => {
  const draw = async (over: Record<string, unknown>) => {
    api.mockResolvedValue({ requests: [{ ...REQUEST, ...over }] });
    render(<ChangeRequestReview requestId="cr1" onClose={vi.fn()} onDecided={vi.fn()} />);
    await screen.findAllByText(over.changes ? /ملاحظات العميل/ : /الكمية/);
  };

  it('is pressable for who holds the price key', async () => {
    await draw({ needsPriceKey: false });
    expect((screen.getByRole('button', { name: /موافقة/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/صلاحية تغيير السعر/)).toBeNull();
  });

  it('NEGATIVE: is disabled for who lacks it — the sentence says why, and «رفض» is still there', async () => {
    await draw({ needsPriceKey: true });
    expect((screen.getByRole('button', { name: /موافقة/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText(/صلاحية تغيير السعر/).length).toBeGreaterThan(0);
    // refusing a figure changes none: the reject button needs only its written reason, not the key
    expect(screen.getByRole('button', { name: /رفض/ })).toBeTruthy();
  });

  it('a request that moves nothing of the kind is never held back (the server leaves the flag false)', async () => {
    await draw({ needsPriceKey: false, changes: { customerNotes: { from: 'a', to: 'b' } } });
    await waitFor(() => expect((screen.getByRole('button', { name: /موافقة/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});
