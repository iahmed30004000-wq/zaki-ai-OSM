// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE STATEMENT SCREENS SAY WHAT IS TRUE IN BOTH MODES (S8 of the brief).
 *
 * «تسوية السطور النظيفة عند الاعتماد»: the screens used to say that a statement’s orders are settled when its matching closes. With the
 * owner’s switch ON that is not the whole truth, and a sentence true in one mode and false in the other is a lie on the screen. So the
 * list of statements carries the new sentences ONLY while the switch is on (`settling`), and the screens show them in place of their own:
 *
 *   · OFF — the field is absent, and every sentence is the one it always was, to the letter;
 *   · ON — the note over the queues and the hint of «مطابق» say the clean orders settle at the approval; «إغلاق المطابقة» says it settles
 *     the rest; and a statement approved earlier that still has clean lines waiting offers «سوّي الطلبات النظيفة هلّق (N)», which asks
 *     first what it does and does not do, then presses the door and shows its answer.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, apiFetch, confirmFn, keys, state } = vi.hoisted(() => ({
  api: vi.fn(),
  apiFetch: vi.fn(),
  confirmFn: vi.fn(async () => true),
  keys: { value: ['settlement.review', 'settlement.upload', 'settlement.approve'] as string[] },
  state: { settling: null as null | Record<string, string>, cleanWaiting: 3, openLines: 0 },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: keys.value } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => (...a: unknown[]) => (confirmFn as (...x: unknown[]) => Promise<boolean>)(...a), useAsk: () => async () => null }));
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';
import { CollectionScreen } from './CollectionScreen';
import { SETTLING_WORDS } from '@/lib/per-line-settlement-words';

const OLD_MONEY_IN =
  'المصاري دخلت المحفظة باعتماد الكشف، والمطابقة لسا مفتوحة: ابتّ بالأسطر هون، وبعدها اضغط «إغلاق المطابقة» من «التحصيل والكشوف» — عندها تتسوّى الطلبات بلا أي حركة جديدة بالمحفظة.';
const OLD_MATCHED_HINT = 'المبلغ في الكشف يساوي المتوقَّع — تتسوّى هذه الطلبات وتصبح عمولتها مستحقة عند إغلاق المطابقة (بنفس ضغطة الاعتماد إذا ما ضل سطر بلا بتّ).';
const OLD_CLOSE_TITLE = 'إغلاق المطابقة — عندها تتسوّى الطلبات، بلا أي حركة جديدة بالمحفظة';

const clean = {
  matchedBy: 'MERCHANT_REF', expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  courierWord: null, orderOutcome: null, followUp: null, difference: 0, id: 'm1', result: 'MATCHED', note: null,
  expectedAmount: 20, statementAmount: 20, orderId: 'o1', appliedAt: '2026-11-09T09:00:00Z',
  order: { id: 'o1', orderNumber: 'ORD-1', merchantRef: 'REF-1', shippingStatus: 'DELIVERED' },
  statementLine: { merchantRef: 'REF-1', barcode: null, amount: 20, status: null, rawRow: null },
};
const gap = { claimed: 20, received: 20, gap: 0, needsExplanation: false, explained: false, unconvertible: 0 };
const statementRow = () => ({
  id: 's1', reference: 'ST-1', fileName: 'x.xlsx', status: 'APPROVED', approvedAt: '2026-11-09T08:00:00Z', matchingClosedAt: null,
  currencyCode: 'JOD', totalAmount: 20, createdAt: '2026-11-08T00:00:00Z', periodFrom: null, periodTo: null,
  counts: { lines: 1, receipts: 1, matches: 1, openLines: state.openLines, ...(state.settling ? { cleanWaiting: state.cleanWaiting } : {}) },
  receipts: [{ id: 'r1', amount: 20, currencyCode: 'JOD', receivedAt: '2026-11-08T09:00:00Z', note: null, wallet: 'الصندوق', proof: null }],
  gap,
});

/** What the server answers, by default; a test that changes one answer falls through to the rest. */
const base = async (url: string): Promise<unknown> => {
  if (url === '/api/finance/statements') return { statements: [statementRow()], ...(state.settling ? { settling: state.settling } : {}) };
  if (url === '/api/finance/statements/s1') return { statement: { matches: [clean] } };
  if (url === '/api/finance/statements/s1/settle-clean') return { settled: 3, delivered: 1, heldBack: 0, rows: [], message: 'تسوّى 3 طلب نظيف' };
  if (url.startsWith('/api/ops/references')) return { providers: [] };
  if (url.startsWith('/api/finance/wallets')) return { wallets: [] };
  return {};
};

beforeEach(() => {
  vi.clearAllMocks();
  state.settling = null;
  state.cleanWaiting = 3;
  state.openLines = 0;
  keys.value = ['settlement.review', 'settlement.upload', 'settlement.approve'];
  confirmFn.mockResolvedValue(true);
  api.mockImplementation(base);
});
afterEach(cleanup);

/** The queues are drawn closed; the hint is read when one is opened. */
async function openTheMatchedQueue() {
  const heading = (await screen.findAllByText('مطابق')).find((el) => el.closest('button'))!;
  fireEvent.click(heading.closest('button')!);
}
const press = async () => (await screen.findAllByRole('button', { name: `${SETTLING_WORDS.button} (3)` }))[0];

describe('the switch OFF — every sentence is the one it always was, to the letter', () => {
  it('the matching screen says the old note over the queues and the old hint of «مطابق»', async () => {
    render(<MatchingScreen />);
    expect(await screen.findByText(OLD_MONEY_IN)).toBeTruthy();
    await openTheMatchedQueue();
    expect(screen.getByText(OLD_MATCHED_HINT)).toBeTruthy();
  });

  it('the collection screen has no press for the clean lines, and «إغلاق المطابقة» carries its old title', async () => {
    render(<CollectionScreen />);
    const close = (await screen.findAllByRole('button', { name: 'إغلاق المطابقة' }))[0] as HTMLButtonElement;
    expect(close.title).toBe(OLD_CLOSE_TITLE);
    expect(screen.queryByRole('button', { name: /سوّي الطلبات النظيفة/ })).toBeNull();
  });
});

describe('the switch ON — the sentences the server sends replace the ones that would be false', () => {
  beforeEach(() => {
    state.settling = { ...SETTLING_WORDS };
  });

  it('the matching screen shows the server’s note over the queues and the server’s hint of «مطابق» — and not the old ones', async () => {
    render(<MatchingScreen />);
    expect(await screen.findByText(SETTLING_WORDS.moneyIn)).toBeTruthy();
    await openTheMatchedQueue();
    expect(screen.getByText(SETTLING_WORDS.matchedHint)).toBeTruthy();
    expect(screen.queryByText(OLD_MONEY_IN)).toBeNull();
    expect(screen.queryByText(OLD_MATCHED_HINT)).toBeNull();
  });

  it('the new sentences are spoken Arabic with no English word, and each says what the other mode’s would have got wrong', () => {
    for (const [name, text] of Object.entries(SETTLING_WORDS)) expect(/[A-Za-z]/.test(text), `${name}: ${text}`).toBe(false);
    expect(SETTLING_WORDS.moneyIn).toContain('الطلبات المطابقة بتتسوّى معه');
    expect(SETTLING_WORDS.moneyIn).toContain('باقي الطلبات');
    expect(SETTLING_WORDS.matchedHint).toContain('لحظة اعتماد الكشف');
    expect(SETTLING_WORDS.matchedHint).toContain('ما بيعلّق غير طلبه');
    expect(SETTLING_WORDS.closeTitle).toContain('اللي لسا ما تسوّت');
  });

  it('«إغلاق المطابقة» says it settles the orders that are not settled yet', async () => {
    render(<CollectionScreen />);
    const close = (await screen.findAllByRole('button', { name: 'إغلاق المطابقة' }))[0] as HTMLButtonElement;
    expect(close.disabled).toBe(false);
    expect(close.title).toBe(SETTLING_WORDS.closeTitle);
  });

  it('a statement with clean lines waiting offers «سوّي الطلبات النظيفة هلّق (3)» — beside «إغلاق المطابقة», not instead of it', async () => {
    render(<CollectionScreen />);
    expect(await press()).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'إغلاق المطابقة' }).length).toBeGreaterThan(0);
  });

  it('pressing it asks first what it does and does not do; on a yes it posts to the door, shows the server’s answer and reloads', async () => {
    render(<CollectionScreen />);
    fireEvent.click(await press());
    await waitFor(() => expect(api.mock.calls.some((c) => c[0] === '/api/finance/statements/s1/settle-clean')).toBe(true));
    expect(confirmFn).toHaveBeenCalledWith({ title: SETTLING_WORDS.confirmTitle, body: SETTLING_WORDS.confirmBody });
    const post = api.mock.calls.find((c) => c[0] === '/api/finance/statements/s1/settle-clean')!;
    expect(post[1]).toEqual({ method: 'POST' });
    expect(await screen.findByText('تسوّى 3 طلب نظيف')).toBeTruthy();
    // …and the list was read again after it.
    expect(api.mock.calls.filter((c) => c[0] === '/api/finance/statements').length).toBeGreaterThanOrEqual(2);
  });

  it('a “no” to the question presses nothing', async () => {
    confirmFn.mockResolvedValue(false);
    render(<CollectionScreen />);
    fireEvent.click(await press());
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(api.mock.calls.some((c) => c[0] === '/api/finance/statements/s1/settle-clean')).toBe(false);
  });

  it('the question says that no money moves and that the lines needing an answer keep waiting', () => {
    expect(SETTLING_WORDS.confirmBody).toContain('ما بتتحرك أي مصاري');
    expect(SETTLING_WORDS.confirmBody).toContain('بتضل تنتظر');
  });

  it('a failure of the door is shown as the error it is, and the screen stays', async () => {
    api.mockImplementation(async (url: string) => {
      if (url === '/api/finance/statements/s1/settle-clean') throw new Error('تعذّرت تسوية الطلبات النظيفة هلّق وما انكتب شي');
      return base(url);
    });
    render(<CollectionScreen />);
    fireEvent.click(await press());
    expect(await screen.findByText(/تعذّرت تسوية الطلبات النظيفة هلّق وما انكتب شي/)).toBeTruthy();
  });

  it('NEGATIVE — no clean line waiting: no press', async () => {
    state.cleanWaiting = 0;
    render(<CollectionScreen />);
    await screen.findAllByRole('button', { name: 'إغلاق المطابقة' });
    expect(screen.queryByRole('button', { name: /سوّي الطلبات النظيفة/ })).toBeNull();
  });

  it('NEGATIVE — a person without the close’s key does not see the press (the server asks it too)', async () => {
    keys.value = ['settlement.review', 'settlement.upload'];
    render(<CollectionScreen />);
    await screen.findAllByText('ST-1');
    expect(screen.queryByRole('button', { name: /سوّي الطلبات النظيفة/ })).toBeNull();
  });

  it('NEGATIVE — a statement whose matching is closed offers neither press', async () => {
    api.mockImplementation(async (url: string) =>
      url === '/api/finance/statements'
        ? { statements: [{ ...statementRow(), matchingClosedAt: '2026-11-09T10:00:00Z' }], settling: state.settling }
        : base(url)
    );
    render(<CollectionScreen />);
    await screen.findAllByText('ST-1');
    expect(screen.queryByRole('button', { name: /سوّي الطلبات النظيفة/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'إغلاق المطابقة' })).toBeNull();
  });
});

describe('after the approval', () => {
  it('the toast carries what the early step settled, in front of the sentence it always had', async () => {
    state.settling = { ...SETTLING_WORDS };
    api.mockImplementation(async (url: string) =>
      url === '/api/finance/statements'
        ? { statements: [{ ...statementRow(), status: 'MATCHED', approvedAt: null, matchingClosedAt: undefined, counts: { lines: 1, receipts: 1, matches: 1, openLines: 1 } }], settling: state.settling }
        : base(url)
    );
    apiFetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ matchingClosed: false, openLines: 1, earlySettlement: { message: 'تسوّى 3 طلب نظيف مع الاعتماد' } }),
    });
    render(<CollectionScreen />);
    const approve = (await screen.findAllByRole('button', { name: 'اعتماد' }))[0];
    fireEvent.click(approve);
    expect(
      await screen.findByText('تسوّى 3 طلب نظيف مع الاعتماد — دخلت المصاري المحفظة، والمطابقة بقيت مفتوحة: 1 سطر بلا بتّ — ابتّ فيها ثم اضغط «إغلاق المطابقة»')
    ).toBeTruthy();
  });

  it('and with the switch OFF it is exactly the old sentence', async () => {
    api.mockImplementation(async (url: string) =>
      url === '/api/finance/statements'
        ? { statements: [{ ...statementRow(), status: 'MATCHED', approvedAt: null, matchingClosedAt: undefined, counts: { lines: 1, receipts: 1, matches: 1, openLines: 1 } }] }
        : base(url)
    );
    apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ matchingClosed: false, openLines: 1 }) });
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'اعتماد' }))[0]);
    const done = await screen.findByText(/المطابقة بقيت مفتوحة/);
    expect(within(done.parentElement ?? document.body).getByText('دخلت المصاري المحفظة، والمطابقة بقيت مفتوحة: 1 سطر بلا بتّ — ابتّ فيها ثم اضغط «إغلاق المطابقة»')).toBeTruthy();
  });
});
