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
    expect(card(MISSING).textContent).toContain('3');
    expect(card(MISMATCH).textContent).toContain('3');
    expect(card(MISMATCH).textContent).toContain('3 بلا بتّ');
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

  it('the pages of a queue are the queue’s own: opening one never changes how many another draws', async () => {
    rows = [...Array.from({ length: 130 }, (_, i) => missing(i + 1)), mismatch(1), mismatch(2)];
    render(<MatchingScreen />);
    await loaded();
    fireEvent.click(toggle(MISSING));
    fireEvent.click(toggle(MISMATCH));
    expect(bodyRows(MISSING)).toHaveLength(100);
    expect(bodyRows(MISMATCH)).toHaveLength(2);
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
});
