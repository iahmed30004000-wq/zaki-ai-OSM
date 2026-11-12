// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * The owner, 8/11, on a real Basha statement of 116 lines — in his words:
 *
 *   «هاد الكشف فيه مرتجع، لما رفعته ما ظهر المرتجع ليش؟»          → the tally says where every kind of line landed;
 *   «ليش مش حاط الطلب ولا السعر ولا أجرة التوصيل»                  → a line no order carries shows what the company wrote;
 *   «هاي كلها لغي، بدي بس العنوان والمحافظة ورقم الهاتف والحالة»   → the reason cell says those four things (and the dialog);
 *   «كيف بدي أقارن بين الطلب الموجود والطلب اللي عنا»              → the dialog lays the company's line beside each order.
 *
 * Every name, phone and address below is invented.
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
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
vi.mock('@/components/screens/finance/DifferencesByPerson', () => ({ DifferencesByPerson: () => null }));
vi.mock('@/components/screens/finance/ManualMatching', () => ({ ManualMatching: () => null }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));

import { MatchingScreen } from './MatchingScreen';
import { StatementTally } from './StatementTally';
import { LinkLineDialog } from './LinkLineDialog';

const delivered = { phrase: 'تم توصيلها', outcome: 'DELIVERED', known: true, label: 'تقول الشركة: سُلِّم' };
const returned = { phrase: 'تم إرجاعها', outcome: 'RETURNED', known: true, label: 'تقول الشركة: رجع' };

const base = {
  matchedBy: null, expectedFee: null, feeDifference: null, resolution: null, resolutionNote: null,
  orderOutcome: null, followUp: null, expectedAmount: null, difference: null, note: null, order: null,
};
const headed = {
  receiverName: 'سلمى الاختبار', receiverPhone: '+353 87 123 4567', receiverAddress: 'إدلب - سلقين - سوق الخضار',
  receiverCity: 'إدلب', receiverArea: 'إدلب',
};
const lineOf = (over: Record<string, unknown> = {}) => ({
  merchantRef: '20001', barcode: '100000000001', amount: '12', collected: '15', fee: '3', status: 'تم توصيلها',
  rawRow: '100000000001 | 20001 | سلمى الاختبار | +353 87 123 4567 | 46322.57921296296 | عنوان | كاش', ...headed, ...over,
});

const rows = [
  // Two delivered lines no order carries, one of which the headings could not give a phone for.
  { ...base, id: 'd1', result: 'MISSING_IN_SYSTEM', statementAmount: '12', courierWord: delivered, statementLine: lineOf() },
  { ...base, id: 'd2', result: 'MISSING_IN_SYSTEM', statementAmount: '12', courierWord: delivered, statementLine: lineOf({ barcode: '100000000002', merchantRef: '20002' }) },
  // Three returned lines no order carries: zero, and one that carries a return fee.
  { ...base, id: 'r1', result: 'MISSING_IN_SYSTEM', statementAmount: '0', courierWord: returned, statementLine: lineOf({ barcode: '100000000003', merchantRef: '20003', amount: '0', collected: '0', fee: '0', status: 'تم إرجاعها' }) },
  { ...base, id: 'r2', result: 'MISSING_IN_SYSTEM', statementAmount: '0', courierWord: returned, statementLine: lineOf({ barcode: '100000000004', merchantRef: '20004', amount: '0', collected: '0', fee: '0', status: 'تم إرجاعها' }) },
  { ...base, id: 'r3', result: 'MISSING_IN_SYSTEM', statementAmount: '-3', courierWord: returned, statementLine: lineOf({ barcode: '100000000005', merchantRef: '20005', amount: '-3', collected: '0', fee: '3', status: 'تم إرجاعها' }) },
  // One returned line whose order is on the road: excluded.
  {
    ...base, id: 'x1', result: 'EXCLUDED', statementAmount: '0', statementFee: '0', matchedBy: 'BARCODE', courierWord: returned,
    order: { id: 'o7', orderNumber: 'ORD-7', merchantRef: '20006', shippingStatus: 'SHIPPED' },
    statementLine: lineOf({ barcode: '100000000006', merchantRef: '20006', amount: '0', collected: '0', fee: '0', status: 'تم إرجاعها' }),
  },
  // An order of ours no statement names: it has no line, and is not counted by what the company wrote.
  { ...base, id: 'u1', result: 'MISSING_IN_STATEMENT', statementAmount: null, expectedAmount: '20', order: { id: 'o8', orderNumber: 'ORD-8', merchantRef: null, shippingStatus: 'DELIVERED' }, statementLine: null, courierWord: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string) => {
    if (url === '/api/finance/statements') {
      return {
        statements: [{
          id: 's1', reference: 'ST-1', status: 'MATCHED', approvedAt: null, currencyCode: 'USD',
          counts: { lines: 6, receipts: 0, matches: rows.length },
        }],
      };
    }
    if (url === '/api/finance/statements/s1') return { statement: { matches: rows } };
    return {};
  });
});
afterEach(cleanup);

const text = (e: Element) => e.textContent ?? '';

describe('«المرتجع ما ظهر» — the tally says where each kind of the company’s lines landed', () => {
  it('counts the lines by what the COMPANY wrote, and where each kind went', async () => {
    render(<MatchingScreen queuesStartOpen />);
    const tally = await screen.findByRole('region', { name: 'شو كتبت الشركة وين صار' });
    const cells = (word: string) => {
      const row = Array.from(tally.querySelectorAll('tbody tr')).find((tr) => tr.querySelector('td')?.textContent === word)!;
      // word · total · matched · a difference · no order of ours · excluded — the word itself is not a count
      return Array.from(row.querySelectorAll('td')).slice(1).map((td) => td.textContent);
    };
    // total · matched · a difference · no order of ours · excluded
    expect(cells('سُلِّمت')).toEqual(['2', '0', '0', '2', '0']);
    expect(cells('رجعت')).toEqual(['4', '0', '0', '3', '1']);
  });

  it('says in a sentence that the returned lines no order carries are in «في الكشف وليس عندنا»', async () => {
    render(<MatchingScreen queuesStartOpen />);
    const tally = await screen.findByRole('region', { name: 'شو كتبت الشركة وين صار' });
    expect(text(tally)).toContain('من 4 سطر قالت الشركة إنو رجع: 3 ما عندنا طلب لها');
    expect(text(tally)).toContain('في الكشف وليس عندنا');
    expect(text(tally)).toContain('1 مستبعدة');
  });

  it('does not count an order of ours that no statement names — it has no line', () => {
    const { container } = render(<StatementTally matches={rows as never} />);
    const total = Array.from(container.querySelectorAll('tbody tr')).reduce((n, tr) => n + Number(tr.querySelectorAll('td')[1].textContent), 0);
    expect(total).toBe(6);
  });

  it('draws nothing for a statement with no lines of the company’s own', () => {
    const { container } = render(<StatementTally matches={[rows[6]] as never} />);
    expect(container.textContent).toBe('');
  });

  it('a statement whose returned lines all have an order says nothing about «ما عندنا طلب»', () => {
    const { container } = render(<StatementTally matches={[rows[5]] as never} />);
    expect(text(container)).not.toContain('ما عندنا طلب لها');
  });
});

describe('«ليش مش حاط الطلب ولا السعر ولا أجرة التوصيل» — a line no order carries shows what the company wrote', () => {
  const headingsOf = (title: string) => {
    // The card of that one queue: its title button's parent. (A page-wide search would read the tally's headings too.)
    const card = screen.getAllByText(title)[0].closest('button')!.parentElement!;
    return Array.from(card.querySelectorAll('thead th')).map((th) => th.textContent?.trim());
  };

  it('«في الكشف وليس عندنا» has no «الطلب» and no «المتوقَّع» and no «الفرق»: they would be a dash on every row', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    const headings = headingsOf('في الكشف وليس عندنا');
    expect(headings).toEqual(expect.arrayContaining(['باركود الشحنة', 'المحصَّل من الزبون', 'الصافي في الكشف', 'أجرة الشركة', 'سبب الشركة بكلامها']));
    for (const gone of ['الطلب', 'المتوقَّع', 'الفرق', 'طوبق عبر']) expect(headings).not.toContain(gone);
  });

  it('shows the company’s own collected, net and fee on the row — and its own order number under the barcode, said to be theirs', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    const tables = document.querySelectorAll('table');
    const missing = Array.from(tables).find((t) => text(t).includes('100000000001'))!;
    const row = Array.from(missing.querySelectorAll('tbody tr')).find((tr) => text(tr).includes('100000000001'))!;
    expect(text(row)).toMatch(/15\.00/); // collected
    expect(text(row)).toMatch(/12\.00/); // net
    expect(text(row)).toMatch(/3\.00/); // the fee the company kept — the match row never stored it for a line with no order
    expect(text(row)).toContain('رقم الطلب عندهم:');
    expect(text(row)).toContain('20001');
  });

  it('a returned line that carries a return fee shows the fee and the negative net as the company wrote them', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    const missing = Array.from(document.querySelectorAll('table')).find((t) => text(t).includes('100000000005'))!;
    const row = Array.from(missing.querySelectorAll('tbody tr')).find((tr) => text(tr).includes('100000000005'))!;
    expect(text(row)).toMatch(/3\.00/);
    expect(text(row)).toMatch(/[-−]\s?3\.00|3\.00-/);
  });

  it('«مستبعدة» keeps its order but takes the company’s figures and its reason, instead of dashes', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('مستبعدة — مرتجع أو مؤجل');
    const headings = headingsOf('مستبعدة — مرتجع أو مؤجل');
    expect(headings).toEqual(expect.arrayContaining(['الطلب', 'المحصَّل من الزبون', 'الصافي في الكشف', 'أجرة الشركة', 'سبب الشركة بكلامها', 'طوبق عبر']));
    expect(headings).not.toContain('المتوقَّع');
    expect(headings).not.toContain('الفرق');
  });

  it('the hint of «مستبعدة» says where the returned parcels with no order went', async () => {
    render(<MatchingScreen queuesStartOpen />);
    const hints = await screen.findAllByText(/الراجع اللي ما عندنا طلب له مش هون/);
    expect(hints.length).toBeGreaterThan(0);
  });
});

describe('«طلبات لم يذكرها أي كشف» says what it is, and why it changes from statement to statement', () => {
  it('its hint says these are OUR orders, computed when the matching runs for the statement’s courier, store and period', async () => {
    render(<MatchingScreen queuesStartOpen />);
    // A queue with rows starts open, so its hint is already on the page.
    await screen.findAllByText('طلبات لم يذكرها أي كشف');
    const hint = await screen.findByText(/هاي طلباتنا نحنا، مش أسطر الكشف/);
    expect(text(hint)).toContain('لحظة تشغيل المطابقة');
    expect(text(hint)).toContain('بيتغيّر من كشف لكشف');
    expect(text(hint)).toContain('ولا بيحرّك مصاري');
  });
});

describe('«سبب الشركة» on the screen says four things', () => {
  it('the status, the phone, the governorate and the address — the dump of the rest of the row is gone from view', async () => {
    render(<MatchingScreen queuesStartOpen />);
    await screen.findAllByText('في الكشف وليس عندنا');
    const missing = Array.from(document.querySelectorAll('table')).find((t) => text(t).includes('100000000001'))!;
    const row = Array.from(missing.querySelectorAll('tbody tr')).find((tr) => text(tr).includes('100000000001'))!;
    const clone = row.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('details').forEach((d) => d.remove());
    const seen = text(clone);
    expect(seen).toContain('الهاتف: +353871234567');
    expect(seen).toContain('المحافظة: إدلب');
    expect(seen).toContain('العنوان: إدلب - سلقين - سوق الخضار');
    expect(seen).not.toContain('ملاحظة الشركة');
    expect(seen).not.toContain('46322.57921296296');
  });
});

describe('«كيف بدي أقارن» — the dialog lays the company’s line beside each order', () => {
  const BASE = '/api/finance/statements/st1/matches/m1/link';
  const line = {
    status: 'تم توصيلها', name: 'سلمى الاختبار', phone: '+353871234567', governorate: 'إدلب',
    address: 'إدلب - سلقين - سوق الخضار', net: 16, collected: 20, fee: 4,
  };
  const candidate = (id: string, orderNumber: string, over: Record<string, unknown> = {}) => ({
    id, orderNumber, merchantRef: null, customer: { id: 'cu', fullName: 'Yazan Test', phone: '900000001' },
    shippingStatus: 'SHIPPED', settlementStatus: 'PENDING', closed: false, expected: 32, distance: 16, otherCourier: false, blockedBy: [],
    details: { name: 'Yazan Test', phone: '0900000001', address: 'حلب - الجميلية', governorate: 'حلب', shipping: 'مشحون', totalAmount: 35, deliveryFee: 3 },
    compare: { phone: 'DIFFERENT', governorate: 'DIFFERENT', amount: 'DIFFERENT' },
    ...over,
  });
  const answer = {
    header: 'لهذا الرقم طلب واحد: مفتوح', counts: { total: 1, closed: 0, open: 1 }, hint: null, otherCourierWarning: 'w',
    phone: { shown: '+353871234567', country: 'OTHER' }, line, candidates: [candidate('a', 'ORD-A')],
  };
  const mount = () => render(<LinkLineDialog statementId="st1" matchId="m1" reference="100000000001" amount={16} currency="USD" onLinked={vi.fn()} />);
  const openIt = async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /اربطه بطلب/ }));
    return screen.findByRole('dialog');
  };

  beforeEach(() => {
    api.mockImplementation(async (url: string) => (url === `${BASE}?by=phone` ? answer : {}));
  });

  it('opens with the company’s line: its words, its phone, governorate and address, and its three figures', async () => {
    const dialog = await openIt();
    const card = await within(dialog).findByRole('region', { name: 'ما كتبته الشركة' });
    for (const piece of ['تم توصيلها', 'سلمى الاختبار', '+353871234567', 'إدلب', 'إدلب - سلقين - سوق الخضار']) expect(text(card)).toContain(piece);
    expect(text(card)).toMatch(/20\.00/);
    expect(text(card)).toMatch(/4\.00/);
    expect(text(card)).toMatch(/16\.00/);
  });

  it('each order carries a mark for the phone, the governorate and the net — in words, not only in colour', async () => {
    const dialog = await openIt();
    await within(dialog).findByText('ORD-A');
    expect(text(dialog)).toContain('الهاتف: مختلف');
    expect(text(dialog)).toContain('المحافظة: مختلف');
    expect(text(dialog)).toContain('المبلغ: مختلف');
  });

  it('a pick opens the two sides of every field in one table, and the count of agreements', async () => {
    const dialog = await openIt();
    fireEvent.click(await within(dialog).findByText('ORD-A'));
    const group = within(dialog).getByRole('group', { name: 'الشركة مقابل طلبنا' });
    // one item to a field: its name first, then what the company wrote, then what we have
    const row = (name: string) => Array.from(group.querySelectorAll('li')).find((li) => li.firstElementChild?.textContent === name)!;
    expect(text(row('الهاتف'))).toContain('+353871234567');
    expect(text(row('الهاتف'))).toContain('0900000001');
    expect(text(row('المحافظة'))).toContain('إدلب');
    expect(text(row('المحافظة'))).toContain('حلب');
    expect(text(row('العنوان'))).toContain('حلب - الجميلية');
    expect(text(row('الاسم'))).toContain('Yazan Test');
    expect(text(row('الحالة'))).toContain('تم توصيلها');
    expect(text(row('الحالة'))).toContain('مشحون');
    expect(text(row('الصافي'))).toMatch(/16\.00.*32\.00/);
    expect(text(row('المحصَّل من الزبون'))).toMatch(/20\.00.*35\.00/);
    expect(text(row('أجرة التوصيل'))).toMatch(/4\.00.*3\.00/);
    expect(text(group)).toContain('يتفقان في 0 من 3');
  });

  it('a name and an address are laid side by side and never marked — only the phone, the governorate and the net are', async () => {
    const dialog = await openIt();
    fireEvent.click(await within(dialog).findByText('ORD-A'));
    const group = within(dialog).getByRole('group', { name: 'الشركة مقابل طلبنا' });
    const marked = Array.from(group.querySelectorAll('li')).filter((li) => /مطابق|مختلف|غير معروف/.test(text(li)));
    expect(marked.map((li) => li.firstElementChild!.textContent)).toEqual(['الهاتف', 'المحافظة', 'الصافي']);
  });

  it('an order that agrees on all three says so', async () => {
    api.mockImplementation(async (url: string) =>
      url === `${BASE}?by=phone`
        ? { ...answer, candidates: [candidate('a', 'ORD-A', { compare: { phone: 'SAME', governorate: 'SAME', amount: 'SAME' } })] }
        : {}
    );
    const dialog = await openIt();
    fireEvent.click(await within(dialog).findByText('ORD-A'));
    expect(text(dialog)).toContain('الهاتف: مطابق');
    expect(text(within(dialog).getByRole('group', { name: 'الشركة مقابل طلبنا' }))).toContain('يتفقان في 3 من 3');
  });

  it('a field the server could not compare is «غير معروف», and does not count either way', async () => {
    api.mockImplementation(async (url: string) =>
      url === `${BASE}?by=phone`
        ? { ...answer, candidates: [candidate('a', 'ORD-A', { compare: { phone: 'UNKNOWN', governorate: 'SAME', amount: 'UNKNOWN' } })] }
        : {}
    );
    const dialog = await openIt();
    fireEvent.click(await within(dialog).findByText('ORD-A'));
    expect(text(dialog)).toContain('الهاتف: غير معروف');
    expect(text(within(dialog).getByRole('group', { name: 'الشركة مقابل طلبنا' }))).toContain('يتفقان في 1 من 1');
  });

  it('an answer in the old shape (no line, no details, no marks) still draws the dialog and still lets a person pick', async () => {
    api.mockImplementation(async (url: string) =>
      url === `${BASE}?by=phone`
        ? {
            header: 'لهذا الرقم طلب واحد قيد الشحن', counts: { total: 1, closed: 0, open: 1 }, hint: null, otherCourierWarning: 'w',
            phone: { shown: '0933620102', country: 'SY' },
            candidates: [{ id: 'a', orderNumber: 'ORD-OLD', merchantRef: null, customer: { id: 'c', fullName: 'رنا', phone: '933620102' }, shippingStatus: 'SHIPPED', settlementStatus: 'PENDING', closed: false, expected: 20, distance: 0, otherCourier: false, blockedBy: [] }],
          }
        : {}
    );
    const dialog = await openIt();
    expect(screen.queryByRole('region', { name: 'ما كتبته الشركة' })).toBeNull();
    fireEvent.click(await within(dialog).findByText('ORD-OLD'));
    expect((screen.getByRole('button', { name: 'اربطه بالطلب ORD-OLD' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the phone of the line is shown even when it is a number of another country — the button works for it', async () => {
    const dialog = await openIt();
    await within(dialog).findByText('ORD-A');
    expect(text(dialog)).toContain('الهاتف بسطر الشركة: +353871234567');
  });

  it('comparing is only reading: nothing is posted until the person presses the link', async () => {
    const dialog = await openIt();
    fireEvent.click(await within(dialog).findByText('ORD-A'));
    expect(api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')).toEqual([]);
  });
});
