// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE BULK-DECISION CARD «بتّ جماعي» FOLDS, AND STARTS FOLDED
 * (the owner, 13/11 02:28, over a phone screenshot of /finance/matching: «بث جماعي اسطر تكون فيها زر اخفاء وعرض الاخفاء هو الديفولت»)
 *
 *  1. The card is a `FoldCard`: CLOSED by default, «بتّ جماعي» for a heading, what is inside said in one line beside it («2 أسطر بكلمة
 *     «تم إرجاعها»» — the count its select already shows), «عرض» / «إخفاء» on the other side, `aria-expanded` saying so.
 *  2. WHETHER IT IS OPEN is kept by the SCREEN. Every answer on a line, every bulk press and «تشغيل المطابقة» reload the rows; the screen
 *     swaps ALL its children for a spinner and the card is UNMOUNTED — a fold kept inside it would be shut on the owner once per line (the
 *     trap #256 hit with the queues). Tested with the reload HELD, so the spinner is really seen, and WITHOUT `queuesStartOpen`, which
 *     re-opens the queues on a remount and would hide the bug. The word she picked, the decision and the explanation she typed survive
 *     a fold and an unfold: the body stays in the page while the card is closed.
 *  3. Nothing else moves: the other two cards and the queues keep their own folds, `queuesStartOpen` opens queues only, the card is
 *     still absent after the close and for somebody who may not review, and the press sends the body it always sent.
 *  4. No new CSS class: every class the card wears is one the product already ships.
 *
 * Blockers: none of the money ones — a pure UI change; `/api/finance/statements/**` is not touched.
 * ═══════════════════════════════════════════════════════════════════════
 */
const { api, phone, permissions } = vi.hoisted(() => ({
  api: vi.fn(),
  phone: { value: false },
  permissions: { current: ['settlement.review'] as string[] },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
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
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';
import { BulkDecide } from './BulkDecide';

const returned = { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' };
const postponed = { phrase: 'مؤجلة', outcome: 'POSTPONED', known: true, label: 'تقول الشركة: مؤجَّل' };
const OK = { allowed: true, why: null };
const lineOf = (n: number) => ({
  merchantRef: `2000${n}`, barcode: `B${String(n).padStart(6, '0')}`, amount: '0', collected: '0', fee: '0', status: 'تم إرجاعها',
  rawRow: `B${n} | 2000${n} | كاش`, receiverName: `زبون ${n}`, receiverPhone: `+963 9${String(n).padStart(8, '0')}`,
  receiverAddress: `شارع ${n}`, receiverCity: 'حماة', receiverArea: 'حماة',
});
/** A line that came out a difference and carries the company's word — what «بتّ جماعي» groups by (`wordGroup`). */
const mismatch = (n: number, word = returned, over: Record<string, unknown> = {}) => ({
  id: `d${n}`, result: 'MISMATCHED', matchedBy: 'MERCHANT_REF', statementAmount: '0', expectedAmount: '20', difference: '-20',
  expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null, note: null,
  orderOutcome: null, followUp: null, claim: null, decisions: { ACCEPTED_COURIER: OK, OURS_STANDS: OK, UNDER_REVIEW: OK },
  wordGroup: `MEANS:${word.outcome}`, courierWord: word, statementLine: lineOf(n),
  order: { id: `o${n}`, orderNumber: `ORD-${n}`, merchantRef: null, shippingStatus: 'DELIVERED' },
  ...over,
});

const CARD = 'بتّ جماعي';
const EXPLANATION = 'اكتب تفسيراً واضحاً: 5 أحرف على الأقل، منها 3 حروف أو أرقام';
const TALLY = 'شو كتبت الشركة، ووين صار كل نوع';
const PEOPLE = 'الفروق حسب من أكّد الطلب';
const MISMATCH = 'فرق في المبلغ';

let rows: Record<string, unknown>[];
let people: unknown;
let statementOver: Record<string, unknown>;
let store: Record<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  permissions.current = ['settlement.review'];
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  // Two words the owner could answer in one press: two lines «تم إرجاعها» and three «مؤجلة».
  rows = [mismatch(1), mismatch(2), mismatch(3, postponed), mismatch(4, postponed), mismatch(5, postponed)];
  statementOver = {};
  people = {
    people: [{ personId: 'a', name: 'Abeer', role: null, differences: 15, accepted: 4, open: 11, acceptedValue: 0, settledOrders: 182, rate: 0.082, why: '15 فرقاً على 182 طلباً وصلت كشفاً' }],
    minSettledOrders: 20,
    unattributed: { settledOrders: 0, differences: 0 },
  };
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/statements') {
      return {
        statements: [{ id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, currencyCode: 'JOD', counts: { lines: rows.length, receipts: 1, matches: rows.length }, ...statementOver }],
      };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches: rows } };
    if (url === '/api/finance/settlement-differences') return people;
    if (url === '/api/finance/statements/s1/decisions') return { message: 'تم بتّ الأسطر' };
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The card's heading row, its `<details>`, and the controls inside (a closed `<details>` keeps them in the tree). */
const summary = () => screen.getByText(CARD).closest('summary') as HTMLElement;
const details = () => summary().closest('details') as HTMLDetailsElement;
const loaded = () => screen.findByText(CARD);
const MISMATCH_TOGGLE = () =>
  screen.getAllByText(MISMATCH).map((el) => el.closest('button')).find((b): b is HTMLButtonElement => !!b && b.hasAttribute('aria-expanded'))!;
const queueCard = () => MISMATCH_TOGGLE().parentElement as HTMLElement;

/** What a browser DRAWS: a closed <details> draws its <summary> and nothing else (jsdom keeps both in the tree). */
function drawn(el: Element): boolean {
  for (let box = el.closest('details'); box; box = box.parentElement?.closest('details') ?? null) {
    const own = box.querySelector(':scope > summary');
    if (!box.open && !own?.contains(el)) return false;
  }
  return true;
}

/** Press the heading and wait until the browser's own `open` — which the word on the card follows — says it has been taken. */
async function press(expectOpen: boolean) {
  await userEvent.click(summary());
  await waitFor(() => expect(details().open).toBe(expectOpen));
  await waitFor(() => expect(summary().getAttribute('aria-expanded')).toBe(String(expectOpen)));
}

/**
 * Hold the GET that reloads the rows, so the spinner — the moment every queue and every card is UNMOUNTED — can be seen, and then let it
 * go. Installed only after the first load, so it intercepts the reload and nothing else. (A mock that answers at once could batch the
 * two `setMatches` calls and hide the unmount; a network GET cannot.)
 */
function holdTheReload(after: () => Record<string, unknown>[] = () => rows) {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const before = api.getMockImplementation() as (url: string, init?: unknown) => Promise<unknown>;
  api.mockImplementation(async (url: string, init?: unknown) => {
    if (url === '/api/finance/statements/s1') {
      await held;
      return { statement: { matches: after() } };
    }
    return before(url, init);
  });
  return release;
}

/** The spinner is on the page and the card is NOT: the moment a fold kept inside the card would be lost. */
async function seeTheSpinner() {
  expect(await screen.findByText('جارٍ التحميل…')).toBeTruthy();
  expect(screen.queryByText(CARD)).toBeNull();
}

describe('1 — the card is CLOSED by default and says what is inside', () => {
  it('starts closed: «عرض» on the side, aria-expanded false, its controls are in the page but a browser draws none of them', async () => {
    render(<MatchingScreen />);
    await loaded();
    expect(details().open).toBe(false);
    expect(summary().getAttribute('aria-expanded')).toBe('false');
    expect(summary().textContent).toContain('عرض');
    expect(summary().textContent).not.toContain('إخفاء');
    // Folded, NOT removed: every control is in the tree (find-in-page reaches it) and none is drawn.
    for (const control of [
      screen.getByLabelText('أسطر بكلمة واحدة للشركة'),
      screen.getByLabelText('البتّ'),
      screen.getByLabelText('التفسير'),
      screen.getByRole('button', { name: 'بتّ الأسطر' }),
    ]) {
      expect(details().contains(control)).toBe(true);
      expect(drawn(control), 'a control of a closed card is drawn').toBe(false);
    }
    expect(drawn(summary())).toBe(true);
  });

  it('the heading says what is inside, in one line: how many lines under which word — the count the select shows', async () => {
    render(<MatchingScreen />);
    await loaded();
    expect(summary().textContent).toContain('2 أسطر بكلمة «تم إرجاعها»');
    expect(summary().textContent).toContain('3 أسطر بكلمة «مؤجلة»');
    // …the very counts the select offers once it is opened.
    expect(screen.getByText('«تم إرجاعها» — 2 أسطر')).toBeTruthy();
    expect(screen.getByText('«مؤجلة» — 3 أسطر')).toBeTruthy();
  });

  it('one word, one line: «2 أسطر بكلمة «تم إرجاعها»» — and ONLY lines nobody has answered, and only words with two or more', () => {
    render(
      <BulkDecide
        statementId="s1"
        onDone={vi.fn()}
        rows={[
          { id: 'a', wordGroup: 'K1', word: 'تم إرجاعها', answered: false },
          { id: 'b', wordGroup: 'K1', word: 'تم إرجاعها', answered: false },
          { id: 'c', wordGroup: 'K1', word: 'تم إرجاعها', answered: true }, // answered: not counted
          { id: 'd', wordGroup: 'K2', word: 'تم توصيلها', answered: false }, // one line alone: answered on its own row, not offered here
          { id: 'e', wordGroup: null, word: null, answered: false }, // no word at all
        ]}
      />
    );
    expect(summary().textContent).toContain('2 أسطر بكلمة «تم إرجاعها»');
    expect(summary().textContent).not.toContain('3 أسطر');
    expect(summary().textContent).not.toContain('تم توصيلها');
  });

  it('one press opens it — the controls are drawn, the word flips to «إخفاء» — and one press closes it again', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    expect(summary().textContent).toContain('إخفاء');
    expect(drawn(screen.getByRole('button', { name: 'بتّ الأسطر' }))).toBe(true);
    // The heading keeps saying what is inside while it is open: the count never hides behind a press.
    expect(summary().textContent).toContain('2 أسطر بكلمة «تم إرجاعها»');
    await press(false);
    expect(summary().textContent).toContain('عرض');
    expect(drawn(screen.getByRole('button', { name: 'بتّ الأسطر' }))).toBe(false);
  });
});

describe('2 — whether it is open is kept by the SCREEN, across the reload every answer causes', { timeout: 60_000 }, () => {
  it('her own press on «بتّ الأسطر»: the card she opened is open again when the rows come back — and the answered word has left it', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    fireEvent.change(screen.getByPlaceholderText(EXPLANATION), { target: { value: 'ننتظر كشف الشركة' } });
    // The server answered the returned ones: when the rows come back they carry an answer and the postponed ones still wait.
    const release = holdTheReload(() =>
      rows.map((m) => (m.wordGroup === 'MEANS:RETURNED' ? { ...m, resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر كشف الشركة' } : m))
    );
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open).toBe(true);
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    expect(drawn(screen.getByRole('button', { name: 'بتّ الأسطر' }))).toBe(true);
    expect(summary().textContent).toContain('3 أسطر بكلمة «مؤجلة»');
    expect(summary().textContent).not.toContain('تم إرجاعها');
  });

  it('an answer on a LINE of a queue: the card is open again when the rows come back — the answer she gave there is the reload', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    fireEvent.click(MISMATCH_TOGGLE());
    const release = holdTheReload(() => rows.filter((m) => m.id !== 'd1'));
    fireEvent.change(within(queueCard()).getAllByLabelText('تفسير القرار')[0], { target: { value: 'اتفقنا على رقم الشركة' } });
    fireEvent.click(within(queueCard()).getAllByRole('button', { name: /رقمنا هو المعتمد/ })[0]);
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open).toBe(true);
    expect(summary().getAttribute('aria-expanded')).toBe('true');
    // d1 is answered and gone: «تم إرجاعها» has one line left and is no longer offered; «مؤجلة» still is.
    expect(summary().textContent).not.toContain('تم إرجاعها');
    expect(summary().textContent).toContain('3 أسطر بكلمة «مؤجلة»');
  });

  it('«تشغيل المطابقة»: the same — the card she opened is open again when the rows come back', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    const release = holdTheReload();
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open).toBe(true);
    expect(drawn(screen.getByRole('button', { name: 'بتّ الأسطر' }))).toBe(true);
  });

  it('what is kept is HER choice — «shut» as much as «open»: a card she never opened, and one she shut again, are both shut after the reload', async () => {
    render(<MatchingScreen />);
    await loaded();
    // Never touched: still closed after a reload.
    let release = holdTheReload();
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open).toBe(false);
    // Opened, then shut by her: shut after the next reload too.
    await press(true);
    await press(false);
    release = holdTheReload();
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open).toBe(false);
    expect(summary().textContent).toContain('عرض');
  });

  it('it keeps its OWN fold: opening it opens neither the two summary cards nor a queue — and opening those does not open it', async () => {
    render(<MatchingScreen />);
    await loaded();
    await screen.findByText(TALLY);
    await screen.findByText(PEOPLE);
    await press(true);
    let release = holdTheReload();
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open).toBe(true);
    const tallyBack = (await screen.findByText(TALLY)).closest('details') as HTMLDetailsElement;
    const peopleBack = (await screen.findByText(PEOPLE)).closest('details') as HTMLDetailsElement;
    expect(tallyBack.open, 'the tally card opened with the bulk card').toBe(false);
    expect(peopleBack.open, 'the people card opened with the bulk card').toBe(false);
    expect(MISMATCH_TOGGLE().getAttribute('aria-expanded')).toBe('false');

    // The other way round: shut the bulk card, open the other two and a queue — after a reload the bulk card is still shut.
    await press(false);
    await userEvent.click(tallyBack.querySelector('summary') as HTMLElement);
    await userEvent.click(peopleBack.querySelector('summary') as HTMLElement);
    fireEvent.click(MISMATCH_TOGGLE());
    await waitFor(() => expect((screen.getByText(TALLY).closest('details') as HTMLDetailsElement).open).toBe(true));
    await waitFor(() => expect((screen.getByText(PEOPLE).closest('details') as HTMLDetailsElement).open).toBe(true));
    release = holdTheReload();
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    await seeTheSpinner();
    release();
    await loaded();
    expect(details().open, 'the bulk card opened with one of the others').toBe(false);
    expect((screen.getByText(TALLY).closest('details') as HTMLDetailsElement).open).toBe(true);
    expect(MISMATCH_TOGGLE().getAttribute('aria-expanded')).toBe('true');
  });

  it('nothing is written anywhere: the fold is for the visit, not remembered', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    await press(false);
    expect(store).toEqual({});
  });
});

describe('2 — what she picked and typed inside survives a fold and an unfold', () => {
  it('the word, the decision and the explanation are still there — in the very same controls, never rebuilt', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    const word = screen.getByLabelText('أسطر بكلمة واحدة للشركة') as HTMLSelectElement;
    const decision = screen.getByLabelText('البتّ') as HTMLSelectElement;
    const note = screen.getByLabelText('التفسير') as HTMLInputElement;
    fireEvent.change(word, { target: { value: 'MEANS:POSTPONED' } });
    fireEvent.change(decision, { target: { value: 'OURS_STANDS' } });
    fireEvent.change(note, { target: { value: 'نطالب الشركة بالفرق' } });

    await press(false);
    // Folded: not drawn, but the same three controls are in the page, holding what she put there.
    expect(screen.getByLabelText('أسطر بكلمة واحدة للشركة')).toBe(word);
    expect(screen.getByLabelText('البتّ')).toBe(decision);
    expect(screen.getByLabelText('التفسير')).toBe(note);
    expect(word.value).toBe('MEANS:POSTPONED');
    expect(decision.value).toBe('OURS_STANDS');
    expect(note.value).toBe('نطالب الشركة بالفرق');

    await press(true);
    expect(screen.getByLabelText('أسطر بكلمة واحدة للشركة')).toBe(word);
    expect(word.value).toBe('MEANS:POSTPONED');
    expect(decision.value).toBe('OURS_STANDS');
    expect(note.value).toBe('نطالب الشركة بالفرق');
  });

  it('the press sends what it always sent — the lines of the word she picked, the decision, the explanation — folded or not', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    fireEvent.change(screen.getByLabelText('أسطر بكلمة واحدة للشركة'), { target: { value: 'MEANS:POSTPONED' } });
    fireEvent.change(screen.getByLabelText('البتّ'), { target: { value: 'OURS_STANDS' } });
    fireEvent.change(screen.getByLabelText('التفسير'), { target: { value: '  نطالب الشركة بالفرق  ' } });
    // She folds it and opens it again before pressing: nothing she chose is lost on the way.
    await press(false);
    await press(true);
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/finance/statements/s1/decisions', expect.anything()));
    const call = api.mock.calls.find((c) => c[0] === '/api/finance/statements/s1/decisions')!;
    expect(call[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({
      matchIds: ['d3', 'd4', 'd5'],
      resolution: 'OURS_STANDS',
      note: 'نطالب الشركة بالفرق',
    });
  });

  it('four characters of explanation still never leave the browser — and the sentence is the card’s, drawn inside it', async () => {
    render(<MatchingScreen />);
    await loaded();
    await press(true);
    fireEvent.change(screen.getByLabelText('التفسير'), { target: { value: 'خصم' } });
    fireEvent.click(screen.getByRole('button', { name: 'بتّ الأسطر' }));
    const sentence = await screen.findAllByText(EXPLANATION);
    expect(sentence.some((el) => details().contains(el) && el.tagName === 'P')).toBe(true);
    expect(api.mock.calls.some((c) => c[0] === '/api/finance/statements/s1/decisions')).toBe(false);
  });
});

describe('3 — nothing else moves', () => {
  it('`queuesStartOpen` opens queues only: a queue with lines opens itself, and the card is as shut as without it', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await loaded();
    expect(MISMATCH_TOGGLE().getAttribute('aria-expanded')).toBe('true');
    expect(details().open).toBe(false);
    expect(summary().textContent).toContain('عرض');
  });

  it('the card stands between «مطابق» and «فرق في المبلغ», where it stood', async () => {
    render(<MatchingScreen />);
    await loaded();
    const matched = screen.getAllByText('مطابق').map((el) => el.closest('button')).find((b) => b?.hasAttribute('aria-expanded'))!;
    const position = (a: Element, b: Element) => a.compareDocumentPosition(b);
    expect(position(matched, details()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(position(details(), MISMATCH_TOGGLE()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('NEGATIVE: once the matching is closed there is no card — not even a folded one', async () => {
    statementOver = { approvedAt: '2026-11-01T10:00:00Z', matchingClosedAt: '2026-11-01T11:00:00Z' };
    render(<MatchingScreen />);
    await screen.findAllByText(MISMATCH);
    expect(screen.queryByText(CARD)).toBeNull();
    expect(screen.queryByLabelText('أسطر بكلمة واحدة للشركة')).toBeNull();
    expect(screen.queryByRole('button', { name: 'بتّ الأسطر' })).toBeNull();
  });

  it('NEGATIVE: somebody who may not review sees no card — not even a folded one', async () => {
    permissions.current = ['settlement.view'];
    render(<MatchingScreen />);
    await screen.findAllByText(MISMATCH);
    expect(screen.queryByText(CARD)).toBeNull();
    expect(screen.queryByLabelText('أسطر بكلمة واحدة للشركة')).toBeNull();
    expect(screen.queryByRole('button', { name: 'بتّ الأسطر' })).toBeNull();
  });

  it('the money is in but the matching is still open: the lines are still answered here, so the card is there (shut)', async () => {
    statementOver = { approvedAt: '2026-11-01T10:00:00Z', matchingClosedAt: null };
    render(<MatchingScreen />);
    await loaded();
    expect(details().open).toBe(false);
  });

  it('NEGATIVE: no two unanswered lines under one word — no card at all', async () => {
    rows = [mismatch(1), mismatch(2, returned, { resolution: 'UNDER_REVIEW', resolutionNote: 'ننتظر' }), mismatch(3, postponed)];
    render(<MatchingScreen />);
    await screen.findAllByText(MISMATCH);
    expect(screen.queryByText(CARD)).toBeNull();
  });

  it('the old behaviour of the pieces: `BulkDecide` with no fold props keeps its own state, closed — and opens on a press', async () => {
    render(
      <BulkDecide
        statementId="s1"
        onDone={vi.fn()}
        rows={[
          { id: 'a', wordGroup: 'K', word: 'مؤجلة', answered: false },
          { id: 'b', wordGroup: 'K', word: 'مؤجلة', answered: false },
        ]}
      />
    );
    expect(details().open).toBe(false);
    await press(true);
    expect(drawn(screen.getByRole('button', { name: 'بتّ الأسطر' }))).toBe(true);
  });
});

describe('4 — NO NEW CSS: every class the card wears is one the product already ships', () => {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const classesOf = (src: string) => [...src.matchAll(/className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean));

  it('`BulkDecide`’s classes all appear in another source file', () => {
    const own = join(root, 'components/screens/finance/BulkDecide.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the card has classes').toBeGreaterThan(20);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the fold itself is the shared `FoldCard` — the card draws no `<details>` of its own', () => {
    const src = readFileSync(join(root, 'components/screens/finance/BulkDecide.tsx'), 'utf8');
    expect(src).toContain("import { FoldCard } from '@/components/screens/finance/FoldCard'");
    expect(src).not.toMatch(/<details[\s>]/);
    expect(src).not.toMatch(/<summary[\s>]/);
  });
});
