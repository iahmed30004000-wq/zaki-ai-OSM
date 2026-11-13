// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «بحث بكل الكشوف» ON THE MATCHING SCREEN
 * (the owner, 13/11 02:52, over /finance/matching on his phone: «اعمل زر بحث داخل كل الكشوف»)
 *
 *  1. A button «بحث بكل الكشوف» in the top card, beside the statement list and «تشغيل المطابقة» — for whoever holds the key the
 *     screen's reads ask (`settlement.view`); nobody else is offered it. It opens a dialog with a real search box, «ابحث»,
 *     and the camera button beside the box like every other screen's.
 *  2. Three characters at least (the box says so and «ابحث» is grey); a whole barcode the camera read is searched at any length
 *     and searched at once. Only the latest question's answer is drawn.
 *  3. Every line that mentions the word is listed: the statement (reference, company, date, state), what the matching made of it
 *     in the group's own words, the answer, the order / barcode / reference, the three figures. «معروض 50 من 137 سطر — ضيّق
 *     البحث» when the answer was cut; «ما انذكر بأي كشف» when nothing is anywhere.
 *  4. A press on a line opens THAT statement on the screen, opens the group the line is in, and puts the same word in that
 *     group's own search box. A statement the screen does not list is shown, with the way to it, and cannot be pressed.
 *  5. Nothing else moves: the search inside the open statement is what it was; the other groups and cards keep their folds; the
 *     phone gets two 44px-high controls and a full-width button; no new CSS class.
 *
 * Blockers: none of the money ones — it reads; `/api/finance/statements/search` is the only new door and it writes nothing.
 * ═══════════════════════════════════════════════════════════════════════
 */
configure({ asyncUtilTimeout: 5000 });

const { api, phone, perms, scan } = vi.hoisted(() => ({
  api: vi.fn(),
  phone: { value: false },
  perms: { current: [] as string[] },
  scan: { code: 'SCANNED-1' },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: perms.current } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
// The camera is not under test (its own file is): a button that hands the screen the code it was told to read.
vi.mock('@/components/scan/ScanButton', () => ({
  ScanButton: ({ onScan, className }: { onScan: (code: string) => unknown; className?: string }) => (
    <button type="button" className={className} onClick={() => void onScan(scan.code)}>
      مسح
    </button>
  ),
}));

import { MatchingScreen } from './MatchingScreen';
import { arDate } from '@/lib/format';
import { MAX_HITS, NOT_IN_ANY_STATEMENT_AR, RESULT_AR, TOO_SHORT_AR } from '@/lib/statement-search-rules';
import { STATEMENT_STATE_AR } from '@/lib/statement-search';

const SEARCH = '/api/finance/statements/search';
const BUTTON = 'بحث بكل الكشوف';
const MISMATCH = 'فرق في المبلغ';
const UNMENTIONED = 'طلبات لم يذكرها أي كشف';

const returned = { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' };
const lineOf = (barcode: string) => ({
  merchantRef: `ref-${barcode}`, barcode, amount: '12', collected: '15', fee: '3', status: 'تم إرجاعها', rawRow: `${barcode} | كاش`,
  receiverName: 'زبون', receiverPhone: '+963 900000001', receiverAddress: 'شارع', receiverCity: 'حماة', receiverArea: 'حماة',
});
const base = {
  matchedBy: null, expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  orderOutcome: null, followUp: null, note: null, wordGroup: null,
};
const mismatch = (id: string, barcode: string, orderNumber: string) => ({
  ...base, id, result: 'MISMATCHED', statementAmount: '10', expectedAmount: '12', difference: '-2', courierWord: returned, statementLine: lineOf(barcode),
  order: { id: `o-${id}`, orderNumber, merchantRef: null, shippingStatus: 'DELIVERED' },
});
const matched = (id: string, barcode: string, orderNumber: string) => ({
  ...base, id, result: 'MATCHED', statementAmount: '12', expectedAmount: '12', difference: '0', courierWord: returned, statementLine: lineOf(barcode),
  order: { id: `o-${id}`, orderNumber, merchantRef: null, shippingStatus: 'DELIVERED' },
});
/** An order of ours the statement did not name: no line at all. */
const unnamed = (id: string, orderNumber: string) => ({
  ...base, id, result: 'MISSING_IN_STATEMENT', statementAmount: null, expectedAmount: '15', difference: null, courierWord: null, statementLine: null,
  order: { id: `o-${id}`, orderNumber, merchantRef: null, shippingStatus: 'DELIVERED' },
  orderOutcome: { key: 'DELIVERED_WAITING', label: 'تم التسليم — بانتظار التحصيل' },
});

const statementRow = (id: string, reference: string, matches: number) => ({
  id, reference, status: 'MATCHED', approvedAt: null, matchingClosedAt: null, currencyCode: 'JOD', counts: { lines: matches, receipts: 1, matches },
});
const hit = (over: Record<string, unknown> = {}) => ({
  matchId: 'hm1',
  statement: { id: 's2', reference: 'ST-2', company: 'أمان', at: '2026-10-01T10:00:00.000Z', state: 'MATCHED', stateAr: 'مطابَق', currencyCode: 'JOD' },
  queue: 'MISMATCHED', resultAr: RESULT_AR.MISMATCHED, answerAr: 'اعتُمد رقم الشركة', order: { id: 'o-d1', orderNumber: 'ORD-9' },
  barcode: 'BC-9', merchantRef: 'ref-BC-9', expected: 12, stated: 10, difference: -2,
  ...over,
});

let statements: ReturnType<typeof statementRow>[];
let rowsOf: Record<string, Record<string, unknown>[]>;
let answerFor: (url: string) => unknown;
let calls: string[];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  perms.current = ['settlement.view', 'settlement.review'];
  scan.code = 'SCANNED-1';
  calls = [];
  statements = [statementRow('s1', 'ST-1', 2), statementRow('s2', 'ST-2', 4)];
  rowsOf = {
    s1: [matched('k1', 'BC-1', 'ORD-1'), mismatch('d0', 'BC-0', 'ORD-0')],
    s2: [mismatch('d1', 'BC-9', 'ORD-9'), mismatch('d2', 'BC-OTHER', 'ORD-OTHER'), unnamed('u1', 'ORD-7'), unnamed('u2', 'ORD-8')],
  };
  answerFor = (url) => ({ q: decodeURIComponent(/q=([^&]*)/.exec(url)![1]), hits: [hit()], total: 1, limit: MAX_HITS });
  api.mockImplementation(async (url: string) => {
    calls.push(url);
    if (url === '/api/finance/statements') return { statements };
    if (url.startsWith(SEARCH)) return answerFor(url);
    const m = /^\/api\/finance\/statements\/([^/?]+)$/.exec(url);
    if (m) return { statement: { matches: rowsOf[m[1]] ?? [] } };
    return {};
  });
});
afterEach(() => {
  cleanup();
});

/* ── finding things ─────────────────────────────────────────────────────── */

const trigger = () => screen.getByRole('button', { name: BUTTON }) as HTMLButtonElement;
const dialog = () => screen.getByRole('dialog', { name: BUTTON });
const box = () => within(dialog()).getByLabelText('البحث') as HTMLInputElement;
const go = () => within(dialog()).getByRole('button', { name: 'ابحث' }) as HTMLButtonElement;
const searches = () => calls.filter((u) => u.startsWith(SEARCH));
const statementList = () => screen.getByLabelText('الكشف') as HTMLSelectElement;
const toggle = (title: string) =>
  screen.getAllByText(title).map((el) => el.closest('button')).find((b): b is HTMLButtonElement => !!b && b.hasAttribute('aria-expanded'))!;
const card = (title: string) => toggle(title).parentElement as HTMLElement;
const bodyRows = (title: string) => Array.from(card(title).querySelectorAll('tbody tr'));
const queueBox = (title: string) => within(card(title)).getByLabelText('ابحث بهالقسم') as HTMLInputElement;

async function draw() {
  render(<MatchingScreen />);
  await screen.findAllByText('مطابق');
  await waitFor(() => expect(statementList().value).toBe('s1'));
}
async function openDialog() {
  fireEvent.click(trigger());
  await screen.findByRole('dialog', { name: BUTTON });
}
async function searchFor(word: string, answer?: unknown) {
  if (answer !== undefined) answerFor = () => answer;
  fireEvent.change(box(), { target: { value: word } });
  fireEvent.click(go());
  await waitFor(() => expect(searches().length).toBeGreaterThan(0));
}

describe('1 — the button, and who is offered it', () => {
  it('a real button in the top card, beside the statement list and «تشغيل المطابقة»', async () => {
    await draw();
    expect(trigger().tagName).toBe('BUTTON');
    expect(trigger().closest('div')).toBe(statementList().closest('div'));
    expect(screen.getByRole('button', { name: 'تشغيل المطابقة' }).parentElement).toBe(trigger().parentElement);
    // Nothing is asked of the server until somebody searches.
    expect(searches()).toHaveLength(0);
  });

  it('NEGATIVE: without the key the screen’s reads ask (`settlement.view`) there is no button — the review key alone does not draw it', async () => {
    perms.current = ['settlement.review'];
    render(<MatchingScreen />);
    await screen.findAllByText('مطابق');
    expect(screen.queryByRole('button', { name: BUTTON })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('it opens a dialog with a real search box, «ابحث» and the camera button beside the box — and says what it can search for', async () => {
    await draw();
    await openDialog();
    expect(box().type).toBe('search');
    expect(go().disabled).toBe(true);
    expect(within(dialog()).getByRole('button', { name: 'مسح' })).toBeTruthy();
    expect(within(dialog()).getByText(/رقم الطلب أو الباركود أو مرجع الشركة — بكل كشوف المتجر/)).toBeTruthy();
  });

  it('who may read customers’ numbers is told they can type a name or a phone; the others are not', async () => {
    perms.current = ['settlement.view', 'customers.view'];
    await draw();
    await openDialog();
    expect(within(dialog()).getByText(/اسم الزبون أو هاتفو/)).toBeTruthy();
    expect(box().placeholder).toMatch(/اسم أو هاتف/);
    cleanup();
    perms.current = ['settlement.view'];
    await draw();
    await openDialog();
    expect(within(dialog()).queryByText(/اسم الزبون أو هاتفو/)).toBeNull();
    expect(box().placeholder).not.toMatch(/هاتف/);
  });
});

describe('2 — how much is typed, and the camera', () => {
  it('two characters: «ابحث» stays grey, the sentence says why, and nothing is asked', async () => {
    await draw();
    await openDialog();
    fireEvent.change(box(), { target: { value: 'ab' } });
    expect(go().disabled).toBe(true);
    expect(within(dialog()).getByText(TOO_SHORT_AR)).toBeTruthy();
    fireEvent.submit(box().closest('form')!);
    expect(searches()).toHaveLength(0);
    fireEvent.change(box(), { target: { value: 'abc' } });
    expect(go().disabled).toBe(false);
    expect(within(dialog()).queryByText(TOO_SHORT_AR)).toBeNull();
  });

  it('a typed word is asked for as typed — cleaned: Latin digits, no stray spaces — and Enter asks too', async () => {
    await draw();
    await openDialog();
    fireEvent.change(box(), { target: { value: '  ORD-٢٠٢٦  ' } });
    fireEvent.submit(box().closest('form')!);
    await waitFor(() => expect(searches()).toEqual([`${SEARCH}?q=ORD-2026`]));
  });

  it('the camera fills the box and asks AT ONCE, with the scan flag — even for a code of two characters', async () => {
    scan.code = 'A1';
    await draw();
    await openDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'مسح' }));
    await waitFor(() => expect(searches()).toEqual([`${SEARCH}?q=A1&scan=1`]));
    expect(box().value).toBe('A1');
  });

  it('a scanned code that is then edited is a typed word again: three characters, no scan flag', async () => {
    scan.code = 'A1';
    await draw();
    await openDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'مسح' }));
    await waitFor(() => expect(searches()).toHaveLength(1));
    fireEvent.change(box(), { target: { value: 'A12' } });
    fireEvent.submit(box().closest('form')!);
    await waitFor(() => expect(searches()).toHaveLength(2));
    expect(searches()[1]).toBe(`${SEARCH}?q=A12`);
    // …and two typed characters after a scan are refused like any two typed characters.
    fireEvent.change(box(), { target: { value: 'A1' } });
    expect(go().disabled).toBe(true);
  });

  it('only the LATEST question’s answer is drawn — a slow earlier one that arrives last is dropped', async () => {
    await draw();
    await openDialog();
    const release: Record<string, () => void> = {};
    const first = new Promise<void>((r) => { release.first = r; });
    answerFor = () => ({ q: 'x', hits: [], total: 0, limit: MAX_HITS });
    const before = api.getMockImplementation() as (url: string) => Promise<unknown>;
    api.mockImplementation(async (url: string) => {
      if (url === `${SEARCH}?q=AAA`) {
        await first;
        return { q: 'AAA', hits: [hit({ statement: { ...hit().statement, reference: 'ST-LATE' } })], total: 1, limit: MAX_HITS };
      }
      if (url === `${SEARCH}?q=BBB`) return { q: 'BBB', hits: [hit({ statement: { ...hit().statement, reference: 'ST-FRESH' } })], total: 1, limit: MAX_HITS };
      return before(url);
    });
    fireEvent.change(box(), { target: { value: 'AAA' } });
    fireEvent.submit(box().closest('form')!);
    fireEvent.change(box(), { target: { value: 'BBB' } });
    fireEvent.submit(box().closest('form')!);
    expect(await within(dialog()).findByText(/ST-FRESH/)).toBeTruthy();
    release.first();
    await new Promise((r) => setTimeout(r, 30));
    expect(within(dialog()).queryByText(/ST-LATE/)).toBeNull();
    expect(within(dialog()).getByText(/ST-FRESH/)).toBeTruthy();
  });
});

describe('3 — what is listed', () => {
  it('each line says which statement wrote it, what the matching made of it, the answer, the references and the three figures', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-9');
    const item = (await within(dialog()).findByText(/ST-2/)).closest('li') as HTMLElement;
    const text = item.textContent!;
    expect(text).toContain('ST-2');
    expect(text).toContain('أمان');
    expect(text).toContain(arDate('2026-10-01T10:00:00.000Z'));
    expect(text).toContain('مطابَق');
    expect(text).toContain(RESULT_AR.MISMATCHED);
    expect(text).toContain('البتّ: اعتُمد رقم الشركة');
    expect(text).toMatch(/طلب\s*ORD-9/);
    expect(text).toMatch(/باركود\s*BC-9/);
    expect(text).toMatch(/مرجع الشركة\s*ref-BC-9/);
    expect(text).toContain('المتوقَّع');
    expect(text).toContain('بالكشف');
    expect(text).toContain('الفرق');
    expect(within(dialog()).getByText('1 سطر')).toBeTruthy();
  });

  it('the figures that a row does not have are not drawn — an order the statement did not name has only what we expected', async () => {
    await draw();
    await openDialog();
    await searchFor('ORD-7', {
      q: 'ORD-7',
      hits: [hit({ queue: 'MISSING_IN_STATEMENT', resultAr: RESULT_AR.MISSING_IN_STATEMENT, answerAr: null, barcode: null, merchantRef: null, expected: 15, stated: null, difference: null })],
      total: 1,
      limit: MAX_HITS,
    });
    const item = (await within(dialog()).findByText(/ST-2/)).closest('li') as HTMLElement;
    expect(item.textContent).toContain('المتوقَّع');
    expect(item.textContent).not.toContain('بالكشف');
    expect(item.textContent).not.toContain('الفرق');
    expect(item.textContent).not.toContain('البتّ');
    expect(item.textContent).not.toContain('باركود');
  });

  it('a line in a statement the matching has not been run on says so in place of a group', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-3', { q: 'BC-3', hits: [hit({ matchId: null, queue: null, resultAr: 'المطابقة لم تُشغَّل على هذا الكشف بعد', answerAr: null, expected: null, stated: null, difference: null })], total: 1, limit: MAX_HITS });
    expect(await within(dialog()).findByText('المطابقة لم تُشغَّل على هذا الكشف بعد')).toBeTruthy();
  });

  it('a cut answer says how many there really are: «معروض 50 من 137 سطر — ضيّق البحث»', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-', { q: 'BC-', hits: Array.from({ length: 50 }, (_, i) => hit({ matchId: `h${i}`, barcode: `BC-${i}` })), total: 137, limit: MAX_HITS });
    expect(await within(dialog()).findByText('معروض 50 من 137 سطر — ضيّق البحث')).toBeTruthy();
    expect(within(dialog()).getAllByRole('listitem')).toHaveLength(50);
  });

  it('an answer that is not cut just says how many', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-', { q: 'BC-', hits: [hit({ matchId: 'a' }), hit({ matchId: 'b' }), hit({ matchId: 'c' })], total: 3, limit: MAX_HITS });
    expect(await within(dialog()).findByText('3 سطر')).toBeTruthy();
    expect(within(dialog()).queryByText(/ضيّق البحث/)).toBeNull();
  });

  it('nothing anywhere: «ما انذكر بأي كشف», with the word that was searched', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-404', { q: 'BC-404', hits: [], total: 0, limit: MAX_HITS });
    const sentence = await within(dialog()).findByText(new RegExp(NOT_IN_ANY_STATEMENT_AR));
    expect(sentence.textContent).toContain('BC-404');
    expect(within(dialog()).queryByRole('listitem')).toBeNull();
  });

  it('a refusal of the door is shown in the dialog, in the door’s own words, and no list is drawn', async () => {
    await draw();
    await openDialog();
    const before = api.getMockImplementation() as (url: string) => Promise<unknown>;
    api.mockImplementation(async (url: string) => {
      if (url.startsWith(SEARCH)) throw new Error('لا تملك صلاحية «عرض التسويات». اطلبها من مدير النظام إن كانت من عملك.');
      return before(url);
    });
    fireEvent.change(box(), { target: { value: 'ORD-1' } });
    fireEvent.click(go());
    const alert = await within(dialog()).findByRole('alert');
    expect(alert.textContent).toContain('لا تملك صلاحية');
    expect(within(dialog()).queryByRole('listitem')).toBeNull();
    // The button is back: a second try is possible.
    await waitFor(() => expect(go().disabled).toBe(false));
  });
});

describe('4 — a press opens the statement where the line lives', () => {
  it('that statement is the one on the screen, the group is open, and the same word is in the group’s own search box', async () => {
    await draw();
    expect(statementList().value).toBe('s1');
    await openDialog();
    await searchFor('BC-9');
    fireEvent.click((await within(dialog()).findByText(/ST-2/)).closest('button')!);

    // The dialog is gone; the statement is the screen's; its rows are fetched.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(statementList().value).toBe('s2'));
    await waitFor(() => expect(calls).toContain('/api/finance/statements/s2'));
    await screen.findAllByText(MISMATCH);
    // The group the line is in is open, with the word in its box — and only the line that carries it is drawn.
    await waitFor(() => expect(toggle(MISMATCH).getAttribute('aria-expanded')).toBe('true'));
    expect(queueBox(MISMATCH).value).toBe('BC-9');
    expect(bodyRows(MISMATCH)).toHaveLength(1);
    expect(card(MISMATCH).textContent).toContain('ORD-9');
    expect(card(MISMATCH).textContent).not.toContain('ORD-OTHER');
    expect(card(MISMATCH).textContent).toContain('يعرض 1 من 2');
  });

  it('the other groups keep their folds: nothing else was opened or filled', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-9');
    fireEvent.click((await within(dialog()).findByText(/ST-2/)).closest('button')!);
    await waitFor(() => expect(toggle(MISMATCH).getAttribute('aria-expanded')).toBe('true'));
    for (const title of ['مطابق', 'في الكشف وليس عندنا', UNMENTIONED]) {
      expect(toggle(title).getAttribute('aria-expanded'), title).toBe('false');
    }
  });

  it('a line of «طلبات لم يذكرها أي كشف» opens THAT group, with the order number in its box', async () => {
    await draw();
    await openDialog();
    await searchFor('ORD-7', {
      q: 'ORD-7',
      hits: [hit({ queue: 'MISSING_IN_STATEMENT', resultAr: RESULT_AR.MISSING_IN_STATEMENT, answerAr: null, barcode: null, merchantRef: null, order: { id: 'o-u1', orderNumber: 'ORD-7' } })],
      total: 1,
      limit: MAX_HITS,
    });
    fireEvent.click((await within(dialog()).findByText(/ST-2/)).closest('button')!);
    await waitFor(() => expect(toggle(UNMENTIONED).getAttribute('aria-expanded')).toBe('true'));
    expect(queueBox(UNMENTIONED).value).toBe('ORD-7');
    expect(bodyRows(UNMENTIONED)).toHaveLength(1);
    expect(toggle(MISMATCH).getAttribute('aria-expanded')).toBe('false');
  });

  it('the word is the one that was SEARCHED — not what is in the box by the time she presses', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-9');
    fireEvent.change(box(), { target: { value: 'something else' } });
    fireEvent.click((await within(dialog()).findByText(/ST-2/)).closest('button')!);
    await waitFor(() => expect(toggle(MISMATCH).getAttribute('aria-expanded')).toBe('true'));
    expect(queueBox(MISMATCH).value).toBe('BC-9');
  });

  it('a line in the statement that is ALREADY open: nothing is fetched again, the group opens and the word is filled', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-0', { q: 'BC-0', hits: [hit({ statement: { ...hit().statement, id: 's1', reference: 'ST-1' }, barcode: 'BC-0', order: { id: 'o-d0', orderNumber: 'ORD-0' } })], total: 1, limit: MAX_HITS });
    const loadsBefore = calls.filter((u) => u === '/api/finance/statements/s1').length;
    fireEvent.click((await within(dialog()).findByText(/ST-1/)).closest('button')!);
    await waitFor(() => expect(toggle(MISMATCH).getAttribute('aria-expanded')).toBe('true'));
    expect(queueBox(MISMATCH).value).toBe('BC-0');
    expect(bodyRows(MISMATCH)).toHaveLength(1);
    expect(calls.filter((u) => u === '/api/finance/statements/s1')).toHaveLength(loadsBefore);
  });

  it('a line the matching has not placed in any group opens its statement and opens and fills nothing', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-3', { q: 'BC-3', hits: [hit({ matchId: null, queue: null, resultAr: 'المطابقة لم تُشغَّل على هذا الكشف بعد', answerAr: null })], total: 1, limit: MAX_HITS });
    fireEvent.click((await within(dialog()).findByText(/ST-2/)).closest('button')!);
    await waitFor(() => expect(statementList().value).toBe('s2'));
    await screen.findAllByText(MISMATCH);
    for (const title of ['مطابق', MISMATCH, 'في الكشف وليس عندنا', UNMENTIONED]) {
      expect(toggle(title).getAttribute('aria-expanded'), title).toBe('false');
    }
  });

  it('a statement the screen does not list is SHOWN, with the way to it, and is not a button', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-OLD', { q: 'BC-OLD', hits: [hit({ statement: { ...hit().statement, id: 'sOld', reference: 'ST-OLD', state: 'DRAFT', stateAr: 'مسوّدة' } })], total: 1, limit: MAX_HITS });
    const item = (await within(dialog()).findByText(/ST-OLD/)).closest('li') as HTMLElement;
    expect(item.querySelector('button')).toBeNull();
    expect(item.textContent).toContain('هذا الكشف مش بقائمة كشوف الشاشة');
    expect(item.textContent).toContain('التحصيل والكشوف');
    expect(statementList().value).toBe('s1');
  });

  it('the search inside the open statement is what it was: it narrows, it clears, and nothing about it changed', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-9');
    fireEvent.click((await within(dialog()).findByText(/ST-2/)).closest('button')!);
    await waitFor(() => expect(bodyRows(MISMATCH)).toHaveLength(1));
    fireEvent.change(queueBox(MISMATCH), { target: { value: 'BC-OTHER' } });
    expect(bodyRows(MISMATCH)).toHaveLength(1);
    expect(card(MISMATCH).textContent).toContain('ORD-OTHER');
    fireEvent.click(within(card(MISMATCH)).getByRole('button', { name: 'امسح البحث والفلتر' }));
    expect(bodyRows(MISMATCH)).toHaveLength(2);
    expect(queueBox(MISMATCH).value).toBe('');
  });

  it('the dialog and its answer outlive the reload every answer causes: reopened, the last search is still there', async () => {
    await draw();
    await openDialog();
    await searchFor('BC-9');
    await within(dialog()).findByText(/ST-2/);
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // An answer elsewhere on the screen reloads the rows: the screen swaps its list for a spinner and back.
    const loads = () => calls.filter((u) => u === '/api/finance/statements/s1').length;
    const before = loads();
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    await waitFor(() => expect(loads()).toBeGreaterThan(before));
    await screen.findAllByText('مطابق');

    await openDialog();
    expect(box().value).toBe('BC-9');
    expect(within(dialog()).getByText(/ST-2/)).toBeTruthy();
  });
});

describe('5 — the phone, and no new CSS', () => {
  it('PHONE: the button takes the whole row like «تشغيل المطابقة», and every control in the dialog is a finger’s height', async () => {
    phone.value = true;
    await draw();
    const tokens = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));
    expect(tokens(trigger()).has('w-full')).toBe(true);
    expect(tokens(trigger()).has('justify-center')).toBe(true);
    expect(tokens(trigger()).has('h-11')).toBe(true);
    await openDialog();
    for (const el of [box(), go(), within(dialog()).getByRole('button', { name: 'مسح' })]) {
      expect(tokens(el).has('h-11'), el.outerHTML.slice(0, 60)).toBe(true);
    }
  });

  it('DESK: the button is not stretched', async () => {
    await draw();
    expect(new Set(trigger().className.split(/\s+/)).has('w-full')).toBe(false);
  });

  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  /** Tailwind reads a source file as raw text: every whitespace- or quote-separated word of it is a candidate class. */
  const words = (text: string) => text.split(/[\s"'`{}<>=,;]+/).filter(Boolean);
  const classesIn = (src: string) => {
    const out: string[] = [];
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`((?:[^`$]|\$\{[^}]*\})*)`\})/g)) {
      if (m[1] !== undefined) out.push(...m[1].split(/\s+/));
      else {
        out.push(
          ...m[2]
            .replace(/\$\{([^}]*)\}/g, (_, expr: string) => {
              for (const s of expr.matchAll(/'([^']*)'/g)) out.push(...s[1].split(/\s+/));
              return ' ';
            })
            .split(/\s+/)
        );
      }
    }
    return out.filter(Boolean);
  };
  // The tone maps are plain strings, not `className`s: their words are read as words.
  it('NO NEW CSS — every class the dialog and its button wear is one the product already ships', () => {
    const own = join(root, 'components/screens/finance/SearchAllStatements.tsx');
    const src = readFileSync(own, 'utf8');
    const used = new Set([...classesIn(src), ...words(src.slice(src.indexOf('const TONE'), src.indexOf('function HitCard'))).filter((w) => /^(bg|text|border)-/.test(w))]);
    expect(used.size, 'the dialog has classes').toBeGreaterThan(40);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => words(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the screen’s own addition carries no class of its own — the button’s are the dialog file’s', () => {
    const screenSrc = readFileSync(join(root, 'components/screens/finance/MatchingScreen.tsx'), 'utf8');
    const from = screenSrc.indexOf('{maySearch && (');
    const to = screenSrc.indexOf('/>', from);
    expect(from, 'the button moved: update this test').toBeGreaterThan(0);
    expect(classesIn(screenSrc.slice(from, to))).toEqual([]);
  });
});

describe('the words are the screen’s own words', () => {
  const screenSrc = readFileSync(join(process.cwd(), 'src/components/screens/finance/MatchingScreen.tsx'), 'utf8');
  const collectionSrc = readFileSync(join(process.cwd(), 'src/components/screens/finance/CollectionScreen.tsx'), 'utf8');

  it('what a line is called in the list is the title of the group it is drawn in', () => {
    for (const queue of ['MATCHED', 'MISMATCHED', 'MISSING_IN_SYSTEM', 'EXCLUDED'] as const) {
      expect(screenSrc, queue).toContain(`title="${RESULT_AR[queue]}"`);
    }
    // The fifth group is called by what it holds, plural; a line in it says which statement did not name the order, singular.
    expect(screenSrc).toContain(`title="${UNMENTIONED}"`);
    expect(RESULT_AR.MISSING_IN_STATEMENT).toBe('طلب عندنا لم يذكره الكشف');
  });

  it('the state of a statement is said with the collection screen’s words', () => {
    for (const [key, word] of Object.entries(STATEMENT_STATE_AR)) {
      if (key === 'CLOSED') continue;
      if (key === 'DRAFT') expect(collectionSrc).toContain(`'${word}'`);
      else expect(collectionSrc, key).toContain(`${key}: '${word}'`);
    }
  });

  it('the groups a hit can name are exactly the ones the screen draws', () => {
    for (const queue of ['MATCHED', 'MISMATCHED', 'MISSING_IN_SYSTEM', 'EXCLUDED', 'MISSING_IN_STATEMENT']) {
      expect(screenSrc, queue).toContain(`viewOf('${queue}')`);
    }
  });
});
