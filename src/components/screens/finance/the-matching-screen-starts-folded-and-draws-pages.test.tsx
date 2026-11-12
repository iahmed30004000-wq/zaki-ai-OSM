// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE MATCHING SCREEN OPENS FOLDED, AND DRAWS A LONG QUEUE IN PAGES
 * (the owner, 12/11: «هدول يكونو مخفيات لانو أول ما أفتح بيكونو معروضات» · «هدول نفس الشي اخفاء اصلا ما في زر اخفاء» ·
 * «الصفحة بتضل تنزل للمالانهاية وبيظهر ابيض»)
 *
 *  1. The queues START CLOSED — each with its count (and the lines still a question) on its heading, «عرض» on the side, and
 *     `aria-expanded` saying so. One press opens it and flips the word to «إخفاء». Nothing is drawn of a closed queue.
 *  2. The two summary cards above the queues — «شو كتبت الشركة…» and «الفروق حسب من أكّد الطلب» — fold the same way: closed,
 *     a heading with what is inside in one line, «عرض» / «إخفاء». FOLDED, NOT REMOVED: the body stays in the page while closed.
 *  3. A queue is drawn a PAGE (100 lines) at a time, «معروض 100 من 130 سطر» and «اعرض 30 كمان»; the heading, the counters and the
 *     gate still count ALL the lines, the search and the filters still look through ALL of them, and a new search starts again from
 *     the first page.
 *  4. `queuesStartOpen` keeps the old behaviour for a caller that wants it. No new utility class: the stylesheet does not move.
 *  5. WHAT A PERSON OPENED STAYS OPENED through the reload an answer causes: the screen swaps every queue and both cards for a spinner
 *     while it reloads, which unmounts them, so the folds and the number of pages drawn are kept by the screen (the reviewer of #256 —
 *     without this, «فرق في المبلغ» would be shut again after EVERY answer). Within a visit only; nothing is written anywhere.
 *
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */
const { api, phone } = vi.hoisted(() => ({ api: vi.fn(), phone: { value: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/matching',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'ACCOUNTANT', permissions: ['settlement.review'] } }),
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/NextStep', () => ({ NextStepButton: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';
import { StatementTally } from './StatementTally';
import { DifferencesByPerson } from './DifferencesByPerson';
import { FoldCard } from './FoldCard';

const delivered = { phrase: 'تم توصيلها', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' };
const returned = { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' };
const base = {
  matchedBy: null, expectedFee: null, statementFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  orderOutcome: null, followUp: null, expectedAmount: null, difference: null, note: null, order: null,
};
const lineOf = (n: number, over: Record<string, unknown> = {}) => ({
  merchantRef: `2000${n}`, barcode: `B${String(n).padStart(6, '0')}`, amount: '12', collected: '15', fee: '3', status: 'تم توصيلها',
  rawRow: `B${n} | 2000${n} | كاش`, receiverName: `زبون ${n}`, receiverPhone: `+963 9${String(n).padStart(8, '0')}`,
  receiverAddress: `شارع ${n}`, receiverCity: 'حماة', receiverArea: 'حماة',
  ...over,
});
/** A line the company wrote and no order of ours carries — the queue «في الكشف وليس عندنا». */
const missing = (n: number, word = delivered) => ({
  ...base, id: `m${n}`, result: 'MISSING_IN_SYSTEM', statementAmount: '12', courierWord: word, statementLine: lineOf(n),
});
/** A line that matched clean — the green queue «مطابق». */
const matched = (n: number) => ({
  ...base, id: `k${n}`, result: 'MATCHED', statementAmount: '12', expectedAmount: '12', difference: '0', courierWord: delivered,
  statementLine: lineOf(1000 + n), order: { id: `o${n}`, orderNumber: `ORD-${n}`, merchantRef: null, shippingStatus: 'DELIVERED' },
});
/** A line that came out a difference — the queue «فرق في المبلغ». */
const mismatch = (n: number) => ({
  ...base, id: `d${n}`, result: 'MISMATCHED', statementAmount: '10', expectedAmount: '12', difference: '-2', courierWord: delivered,
  statementLine: lineOf(2000 + n), order: { id: `p${n}`, orderNumber: `ORD-D${n}`, merchantRef: null, shippingStatus: 'DELIVERED' },
});

let rows: Record<string, unknown>[];
let people: unknown;
let store: Record<string, string>;
beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  rows = [matched(1), matched(2), mismatch(1), mismatch(2), mismatch(3), missing(1), missing(2), missing(3, returned)];
  people = {
    people: [
      { personId: 'a', name: 'Abeer', role: null, differences: 15, accepted: 4, open: 11, acceptedValue: 0, settledOrders: 182, rate: 0.082, why: '15 فرقاً على 182 طلباً وصلت كشفاً' },
      { personId: 'b', name: 'salwa', role: null, differences: 13, accepted: 0, open: 13, acceptedValue: 0, settledOrders: 120, rate: 0.108, why: '13 فرقاً على 120 طلباً وصلت كشفاً' },
      { personId: 'c', name: 'mimu', role: null, differences: 0, accepted: 0, open: 0, acceptedValue: 0, settledOrders: 1, rate: null, why: 'تحت الحدّ' },
    ],
    minSettledOrders: 20,
    unattributed: { settledOrders: 0, differences: 0 },
  };
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/statements') {
      return { statements: [{ id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, currencyCode: 'USD', counts: { lines: rows.length, receipts: 1, matches: rows.length } }] };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches: rows } };
    if (url === '/api/finance/settlement-differences') return people;
    return {};
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MISSING = 'في الكشف وليس عندنا';
const MISMATCH = 'فرق في المبلغ';
const EXCLUDED = 'مستبعدة — مرتجع أو مؤجل';
/** A line the company wrote at zero for a parcel it says came back — the queue «مستبعدة»; drawn like the missing ones (no answer controls). */
const excluded = (n: number) => ({
  ...base, id: `x${n}`, result: 'EXCLUDED', statementAmount: '0', courierWord: returned, statementLine: lineOf(3000 + n),
  order: { id: `q${n}`, orderNumber: `ORD-X${n}`, merchantRef: null, shippingStatus: 'RETURNED' },
});
/** The card of one queue, found by its title button (the structure the screen's other tests rely on). */
const toggle = (title: string) =>
  screen.getAllByText(title).map((el) => el.closest('button')).find((b): b is HTMLButtonElement => !!b && b.hasAttribute('aria-expanded'))!;
const card = (title: string) => toggle(title).parentElement as HTMLElement;
const bodyRows = (title: string) => Array.from(card(title).querySelectorAll('tbody tr'));
const loaded = () => screen.findAllByText(MISSING);

/** What a browser DRAWS: a closed <details> draws its <summary> and nothing else (jsdom keeps both in the tree). */
function drawn(el: Element): boolean {
  for (let box = el.closest('details'); box; box = box.parentElement?.closest('details') ?? null) {
    const summary = box.querySelector(':scope > summary');
    if (!box.open && !summary?.contains(el)) return false;
  }
  return true;
}

describe('the queues start CLOSED, with their count on the heading', () => {
  it('every queue is closed: its heading says «عرض», aria-expanded is false, and no row of it is drawn', async () => {
    render(<MatchingScreen />);
    await loaded();
    for (const title of ['مطابق', MISMATCH, MISSING]) {
      expect(toggle(title).getAttribute('aria-expanded'), `${title} انفتح وحده`).toBe('false');
      expect(card(title).textContent).toContain('عرض');
      expect(bodyRows(title), `${title}: أسطر مرسومة بقسم مطوي`).toHaveLength(0);
    }
  });

  it('the heading says how many lines the queue holds, and how many are still a question', async () => {
    render(<MatchingScreen />);
    await loaded();
    // The count badge itself (an element whose whole text is «3») — «3 بلا بتّ» is another element and does not stand in for it.
    expect(within(toggle(MISSING)).getByText('3')).toBeTruthy();
    expect(within(toggle(MISMATCH)).getByText('3')).toBeTruthy();
    expect(within(toggle(MISMATCH)).getByText('3 بلا بتّ')).toBeTruthy();
    // The green queue has no question to answer, so its heading carries no «بلا بتّ».
    expect(within(toggle('مطابق')).getByText('2')).toBeTruthy();
    expect(toggle('مطابق').textContent).not.toContain('بلا بتّ');
  });

  it('one press opens it — the rows are drawn, the word flips to «إخفاء» — and one press closes it again', async () => {
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    expect(toggle(MISSING).getAttribute('aria-expanded')).toBe('true');
    expect(card(MISSING).textContent).toContain('إخفاء');
    expect(bodyRows(MISSING)).toHaveLength(3);
    // The others stay as they were: a press opens ONE queue.
    expect(bodyRows(MISMATCH)).toHaveLength(0);
    fireEvent.click(toggle(MISSING));
    expect(bodyRows(MISSING)).toHaveLength(0);
    expect(card(MISSING).textContent).toContain('عرض');
  });

  it('`queuesStartOpen` is the old behaviour: a queue with lines opens itself (the green one never does)', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await loaded();
    expect(bodyRows(MISSING)).toHaveLength(3);
    expect(bodyRows(MISMATCH)).toHaveLength(3);
    expect(bodyRows('مطابق')).toHaveLength(0);
  });
});

// 100–130 table rows are drawn on every press, and the whole suite runs ~900 files at once: the search test took 24 s in the wide
// run and ~3 s alone, so these five carry their own generous limit (the repo’s `{ timeout }` form) instead of the 20 s default.
describe('a long queue is drawn a page at a time — the owner’s 938', { timeout: 60_000 }, () => {
  const longQueue = (n: number) => {
    rows = Array.from({ length: n }, (_, i) => missing(i + 1));
  };

  it('130 lines: 100 are drawn, the footer says «معروض 100 من 130 سطر», and the heading still says 130', async () => {
    longQueue(130);
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    expect(bodyRows(MISSING)).toHaveLength(100);
    expect(card(MISSING).textContent).toContain('معروض 100 من 130 سطر');
    expect(card(MISSING).textContent).toContain('اعرض 30 كمان');
    // The heading counts ALL of them, drawn or not.
    expect(within(toggle(MISSING)).getByText('130')).toBeTruthy();
  });

  it('«اعرض 30 كمان» draws the rest — the button names how many are left — and then the footer is gone', async () => {
    longQueue(130);
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    fireEvent.click(within(card(MISSING)).getByRole('button', { name: 'اعرض 30 كمان' }));
    expect(bodyRows(MISSING)).toHaveLength(130);
    expect(card(MISSING).textContent).not.toContain('معروض');
    expect(within(card(MISSING)).queryByRole('button', { name: /كمان/ })).toBeNull();
  });

  it('NEGATIVE: exactly 100 lines fit one page — no footer, no button', async () => {
    longQueue(100);
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    expect(bodyRows(MISSING)).toHaveLength(100);
    expect(card(MISSING).textContent).not.toContain('معروض');
  });

  it('a search looks through ALL the lines, and starts again from the first page', async () => {
    longQueue(130);
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    // A name that lives in the LAST lines (129 — past the 100 drawn): the search reads every line, not only the drawn ones.
    fireEvent.change(within(card(MISSING)).getByLabelText('ابحث بهالقسم'), { target: { value: 'زبون 129' } });
    expect(bodyRows(MISSING)).toHaveLength(1);
    expect(card(MISSING).textContent).not.toContain('معروض');
    // With every line drawn, a new search that matches ALL of them starts again from the first page (100), not from the 130.
    fireEvent.change(within(card(MISSING)).getByLabelText('ابحث بهالقسم'), { target: { value: '' } });
    fireEvent.click(within(card(MISSING)).getByRole('button', { name: 'اعرض 30 كمان' }));
    expect(bodyRows(MISSING)).toHaveLength(130);
    fireEvent.change(within(card(MISSING)).getByLabelText('ابحث بهالقسم'), { target: { value: 'زبون 129' } });
    fireEvent.change(within(card(MISSING)).getByLabelText('ابحث بهالقسم'), { target: { value: 'حماة' } });
    expect(bodyRows(MISSING)).toHaveLength(100);
    expect(card(MISSING).textContent).toContain('معروض 100 من 130 سطر');
  });

  it('the pages of a queue are the queue’s own: «اعرض كمان» on one never changes how many another draws', async () => {
    rows = [...Array.from({ length: 130 }, (_, i) => missing(i + 1)), ...Array.from({ length: 101 }, (_, i) => excluded(i + 1))];
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    fireEvent.click(toggle(EXCLUDED));
    expect(bodyRows(MISSING)).toHaveLength(100);
    expect(bodyRows(EXCLUDED)).toHaveLength(100);
    // The button of the first draws the first’s rest — and ONLY the first’s.
    fireEvent.click(within(card(MISSING)).getByRole('button', { name: 'اعرض 30 كمان' }));
    expect(bodyRows(MISSING)).toHaveLength(130);
    expect(bodyRows(EXCLUDED)).toHaveLength(100);
    expect(card(EXCLUDED).textContent).toContain('معروض 100 من 101 سطر');
    // …and the other one’s own button still says how many ITS rest is.
    fireEvent.click(within(card(EXCLUDED)).getByRole('button', { name: 'اعرض 1 كمان' }));
    expect(bodyRows(EXCLUDED)).toHaveLength(101);
  });
});

describe('what a person opened STAYS opened through the reload an answer causes', { timeout: 60_000 }, () => {
  /**
   * Hold the GET that reloads the rows, so the spinner — the moment every queue and both cards are UNMOUNTED — can be seen, and then
   * let it go. Installed only after the first load, so it intercepts the reload and nothing else. (A mock that answers at once could
   * batch the two `setMatches` calls and hide the unmount; the network GET cannot.)
   */
  function holdTheReload(after: () => Record<string, unknown>[]) {
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

  it('an answer on a line: the queue she opened and both cards are open again when the rows come back — the queue she never opened is not', async () => {
    render(<MatchingScreen />);
    await loaded();
    const tally = (await screen.findByText('شو كتبت الشركة، ووين صار كل نوع')).closest('summary') as HTMLElement;
    const people = (await screen.findByText('الفروق حسب من أكّد الطلب')).closest('summary') as HTMLElement;
    await userEvent.click(tally);
    await userEvent.click(people);
    await waitFor(() => expect(tally.getAttribute('aria-expanded')).toBe('true'));
    await waitFor(() => expect(people.getAttribute('aria-expanded')).toBe('true'));
    fireEvent.click(toggle(MISMATCH));
    expect(bodyRows(MISMATCH)).toHaveLength(3);

    // She answers the first line (d1): the answer is posted, the rows are fetched again, and on the way the screen shows a spinner.
    const release = holdTheReload(() => rows.filter((m) => m.id !== 'd1'));
    fireEvent.change(within(card(MISMATCH)).getAllByLabelText('تفسير القرار')[0], { target: { value: 'اتفقنا على رقم الشركة' } });
    fireEvent.click(within(card(MISMATCH)).getAllByRole('button', { name: /رقمنا هو المعتمد/ })[0]);
    expect(await screen.findByText('جارٍ التحميل…')).toBeTruthy();
    // Everything is gone while it loads: this is the moment a fold kept INSIDE a queue or a card would be lost.
    expect(screen.queryAllByText(MISMATCH)).toHaveLength(0);
    expect(screen.queryAllByText('شو كتبت الشركة، ووين صار كل نوع')).toHaveLength(0);

    release();
    await screen.findAllByText(MISMATCH);
    expect(toggle(MISMATCH).getAttribute('aria-expanded')).toBe('true');
    expect(bodyRows(MISMATCH)).toHaveLength(2); // d1 is answered and gone; d2 and d3 are drawn without a press
    expect(toggle(MISSING).getAttribute('aria-expanded')).toBe('false'); // she never opened it: it is still shut
    expect(bodyRows(MISSING)).toHaveLength(0);
    const tallyBack = (await screen.findByText('شو كتبت الشركة، ووين صار كل نوع')).closest('details') as HTMLDetailsElement;
    expect(tallyBack.open).toBe(true);
    const peopleBack = (await screen.findByText('الفروق حسب من أكّد الطلب')).closest('details') as HTMLDetailsElement;
    expect(peopleBack.open).toBe(true);
  });

  it('a queue she SHUT stays shut across the reload — what is kept is HER choice, «shut» as much as «open» (with the old open-by-itself default)', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await loaded();
    expect(toggle(MISSING).getAttribute('aria-expanded')).toBe('true'); // opened itself (the old default)
    fireEvent.click(toggle(MISSING)); // she shuts it: a touched queue remembers «shut» and the default no longer decides
    expect(toggle(MISSING).getAttribute('aria-expanded')).toBe('false');
    const release = holdTheReload(() => rows);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    expect(await screen.findByText('جارٍ التحميل…')).toBeTruthy();
    release();
    await screen.findAllByText(MISSING);
    expect(toggle(MISSING).getAttribute('aria-expanded')).toBe('false');
    expect(bodyRows(MISSING)).toHaveLength(0);
  });

  it('a long queue keeps its pages: 130 drawn before the re-run are 130 drawn after it, not the first 100 again', async () => {
    rows = Array.from({ length: 130 }, (_, i) => missing(i + 1));
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    fireEvent.click(within(card(MISSING)).getByRole('button', { name: 'اعرض 30 كمان' }));
    expect(bodyRows(MISSING)).toHaveLength(130);
    const release = holdTheReload(() => rows);
    fireEvent.click(screen.getByRole('button', { name: 'تشغيل المطابقة' }));
    expect(await screen.findByText('جارٍ التحميل…')).toBeTruthy();
    release();
    await screen.findAllByText(MISSING);
    expect(toggle(MISSING).getAttribute('aria-expanded')).toBe('true');
    expect(bodyRows(MISSING)).toHaveLength(130);
    expect(card(MISSING).textContent).not.toContain('معروض');
  });
});

describe('the two summary cards fold the same way — closed, with what is inside on the heading', () => {
  it('«شو كتبت الشركة…»: closed, the count of each kind on the heading, and the table is still IN the page', async () => {
    render(<MatchingScreen />);
    const region = await screen.findByRole('region', { name: 'شو كتبت الشركة وين صار' });
    const summary = region.querySelector('summary') as HTMLElement;
    const details = region.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('شو كتبت الشركة، ووين صار كل نوع');
    expect(summary.textContent).toContain('عرض');
    expect(summary.textContent).toMatch(/\d+ سُلِّمت/);
    // Folded, not removed: the table is in the tree (find-in-page reaches it) but a browser does not draw it.
    const table = region.querySelector('table') as HTMLElement;
    expect(table).toBeTruthy();
    expect(drawn(summary)).toBe(true);
    expect(drawn(table)).toBe(false);
  });

  it('opens on a tap: the table is drawn, the word says «إخفاء», aria-expanded follows — and it is not remembered', async () => {
    render(<StatementTally matches={rows as never} />);
    const summary = (await screen.findByText('شو كتبت الشركة، ووين صار كل نوع')).closest('summary') as HTMLElement;
    const details = summary.closest('details') as HTMLDetailsElement;
    await userEvent.click(summary);
    await waitFor(() => expect(summary.getAttribute('aria-expanded')).toBe('true'));
    expect(details.open).toBe(true);
    expect(summary.textContent).toContain('إخفاء');
    expect(drawn(details.querySelector('table')!)).toBe(true);
    await userEvent.click(summary);
    await waitFor(() => expect(summary.getAttribute('aria-expanded')).toBe('false'));
    cleanup();
    // A fresh mount starts closed again, and nothing was written anywhere.
    render(<StatementTally matches={rows as never} />);
    expect((screen.getByText('شو كتبت الشركة، ووين صار كل نوع').closest('details') as HTMLDetailsElement).open).toBe(false);
    expect(store).toEqual({});
  });

  it('«الفروق حسب من أكّد الطلب»: closed, the sum of the people on the heading, the names still in the page', async () => {
    render(<DifferencesByPerson currency="USD" />);
    const summary = (await screen.findByText('الفروق حسب من أكّد الطلب')).closest('summary') as HTMLElement;
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // 15 + 13 + 0 differences, of which 11 + 13 + 0 are still waiting (Abeer’s other 4 were answered «اعتُمد رقم الشركة»).
    expect(summary.textContent).toContain('28 فرقاً · 24 بانتظار البتّ');
    expect(summary.textContent).toContain('عرض');
    const abeer = screen.getByText('Abeer');
    expect(drawn(abeer)).toBe(false);
    await userEvent.click(summary);
    await waitFor(() => expect(drawn(abeer)).toBe(true));
    expect(summary.textContent).toContain('إخفاء');
  });

  it('NEGATIVE: nobody with a difference draws nothing — no empty card, no heading with a zero', async () => {
    people = { people: [], minSettledOrders: 20, unattributed: { settledOrders: 0, differences: 0 } };
    const { container } = render(<DifferencesByPerson currency="USD" />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('`FoldCard` carries whatever it is given, and starts closed', () => {
    render(<FoldCard title="عنوان" holds="سطر واحد"><p>محتوى</p></FoldCard>);
    const details = screen.getByText('عنوان').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText('سطر واحد')).toBeTruthy();
    expect(screen.getByText('محتوى')).toBeTruthy();
  });

  it('the BROWSER owns `open`: a card opened with no press (find-in-page, a script) says «إخفاء» — and shut again, «عرض»', () => {
    render(<FoldCard title="عنوان"><p>محتوى</p></FoldCard>);
    const details = screen.getByText('عنوان').closest('details') as HTMLDetailsElement;
    const summary = details.querySelector('summary') as HTMLElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(summary.textContent).toContain('إخفاء');
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    expect(summary.textContent).toContain('عرض');
  });

  it('a caller that KEEPS it: `open` is where it starts, and every change the browser makes is told to `onOpenChange`', () => {
    const told = vi.fn();
    render(<FoldCard title="عنوان" open onOpenChange={told}><p>محتوى</p></FoldCard>);
    const details = screen.getByText('عنوان').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(details.querySelector('summary')!.getAttribute('aria-expanded')).toBe('true');
    details.open = false;
    fireEvent(details, new Event('toggle'));
    expect(told).toHaveBeenLastCalledWith(false);
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(told).toHaveBeenLastCalledWith(true);
  });
});

describe('NO NEW CSS — every class the fold and the page footer use is one the product already ships', () => {
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

  it('`FoldCard`’s classes all appear in another source file', () => {
    const own = join(root, 'components/screens/finance/FoldCard.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
    expect(relative(root, own)).toContain('FoldCard');
  });

  it('the page footer’s classes (inside `MatchingScreen`) all appear in another source file too', () => {
    const own = join(root, 'components/screens/finance/MatchingScreen.tsx');
    const src = readFileSync(own, 'utf8');
    const from = src.indexOf('{drawn.length < shown.length && (');
    const to = src.indexOf('اعرض {Math.min(PAGE_ROWS', from);
    expect(from, 'the footer moved: update this test').toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const used = new Set(classesOf(src.slice(from, to)));
    expect(used.size, 'the footer has classes').toBeGreaterThan(5);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });
});
