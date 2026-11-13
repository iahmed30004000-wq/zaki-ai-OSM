// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE RETURNS DESK, AS A LIST THAT IS READ IN PAGES, FILTERED, SEARCHED — AND SCANNED INTO.
 *
 * «المرتجعات — صفحات + فلاتر + بحث». What the screen owes, beyond drawing:
 *
 *   • the search box is there from the first moment, with the cursor in it and the scan button beside it — a desk
 *     that scans must never open without its box, not even when the first answer fails;
 *   • a scan IS a search typed by a camera: it lands in the box and is asked like any typed word;
 *   • a view (waiting · counted in), the state, the delivery company and the age, each with the SERVER'S number beside
 *     the words — and only what was chosen is asked, and a change starts again at page one;
 *   • the columns follow the ROWS that are on screen, not the view that was just chosen: a record is never drawn with
 *     the columns of a waiting parcel while its answer is still on the way;
 *   • «استلام» reloads the page the clerk is ON, with what was chosen.
 */

const { api, scan } = vi.hoisted(() => ({
  api: vi.fn(),
  scan: { onScan: null as null | ((code: string) => unknown) },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/ops/returns' }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المرتجعات</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn() }) }));
vi.mock('@/components/orders/OrderNotesPeek', () => ({ OrderNotesPeek: () => null }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
// A camera is not a thing jsdom has; what matters is what the screen does with the code it is handed.
vi.mock('@/components/scan/ScanButton', () => ({
  ScanButton: (p: { onScan: (code: string) => unknown }) => {
    scan.onScan = p.onScan;
    return <button type="button">امسح</button>;
  },
}));

import { ReturnsScreen } from './ReturnsScreen';

const COURIER_A = '11111111-1111-4111-8111-111111111111';
const COURIER_B = '22222222-2222-4222-8222-222222222222';

const completion = {
  halves: [{ key: 'GOODS', label: 'استلام الراجع وعدّه في المستودع', settled: false, units: 3 }],
  settledCount: 0,
  degree: 'NONE',
  complete: false,
  awaiting: ['GOODS'],
  label: 'تمّ 0 من 1',
};

const waiting = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'RETURNED',
  returnReason: null,
  expectedQty: 3,
  daysWaited: 5,
  customer: { fullName: 'سارة' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'ناقل' },
  lines: [{ itemId: 'i1', productName: 'ماء الكمأ', shipped: 3, delivered: null, expectedBack: 3 }],
  completion,
  action: null,
  ...over,
});

const counted = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  trackingNumber: `TRK-${id}`,
  shippingStatus: 'RETURNED',
  returnReason: null,
  customer: { fullName: 'منى' },
  region: { name: 'عمّان' },
  deliveryProvider: { name: 'أمان' },
  receipt: {
    expectedQty: 3, receivedQty: 2, damagedQty: 1, missingQty: 0, courierFeeCharged: false,
    inspectedAt: '2026-10-19T10:00:00.000Z', inspectedBy: 'أمين', note: null,
  },
  ...over,
});

const FACTS = {
  views: { pending: 60, received: 14 },
  statuses: { RETURN_REQUESTED: 5, RETURNED: 40, FAILED_DELIVERY: 10, PARTIALLY_DELIVERED: 5 },
  couriers: [
    { id: COURIER_A, name: 'ناقل', count: 35 },
    { id: COURIER_B, name: 'أمان', count: 20 },
    { id: 'none', name: 'بلا شركة شحن', count: 5 },
  ],
  ages: { fresh: 12, few: 18, week: 20, old: 10 },
  noBarcode: 9,
};

/** What the door says right now. */
let facts: typeof FACTS;
let total: number;
let rowsOf: (view: string, page: number) => unknown[];
let firstFails: boolean;
let postBody: unknown;
let hold: Promise<void> | null;

const gets = () =>
  api.mock.calls.filter((c) => !(c[1] && (c[1] as RequestInit).method)).map((c) => new URL(c[0] as string, 'http://x').searchParams);
const posts = () => api.mock.calls.filter((c) => c[1] && (c[1] as RequestInit).method === 'POST');
const lastAsked = () => gets().at(-1)!;

beforeEach(() => {
  vi.clearAllMocks();
  scan.onScan = null;
  facts = structuredClone(FACTS);
  total = 60;
  firstFails = false;
  hold = null;
  postBody = { missingQty: 0, courierFeeAmount: 0, completion: { complete: true, label: '' } };
  rowsOf = (view, page) => (view === 'received' ? [counted(`R${page}`)] : [waiting(`P${page}`)]);
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return postBody;
    if (firstFails && api.mock.calls.length === 1) throw new Error('تعذّر التحميل');
    const q = new URL(url, 'http://x').searchParams;
    const view = q.get('view') ?? 'pending';
    if (hold && view === 'received') await hold;
    const totalPages = Math.max(1, Math.ceil(total / 25));
    const page = Math.min(Number(q.get('page')), totalPages);
    return {
      count: total === 0 ? 0 : 1,
      orders: total === 0 ? [] : rowsOf(view, page),
      pagination: { total, page, limit: 25, totalPages },
      facts,
      applied: { view, status: null, courier: null, age: null, q: null },
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ReturnsScreen />);
  await screen.findByLabelText('العرض');
};
const searchBox = () => screen.getByRole('textbox', { name: /امسح أو اكتب المرجع/ }) as HTMLInputElement;
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const options = (label: string) => within(screen.getByLabelText(label)).getAllByRole('option').map((o) => o.textContent);
const headings = () => [...document.querySelectorAll('th')].map((th) => th.textContent?.trim());
const pagerSentence = (found: boolean) =>
  (found ? screen.getByText : screen.queryByText)((_, el) => el?.tagName === 'SPAN' && /^عرض \d+ من \d+ مرتجع$/.test(el.textContent ?? ''));

describe('opening it', () => {
  it('— asks for the work, page one, 25 to a page, and nothing else', async () => {
    await draw();
    expect(gets()).toHaveLength(1);
    expect(gets()[0].toString()).toBe('view=pending&page=1&limit=25');
  });

  it('and the search box is there before the first answer — with the cursor in it and the scan button beside it', async () => {
    render(<ReturnsScreen />);
    expect(searchBox()).toBeTruthy();
    expect(document.activeElement).toBe(searchBox());
    expect(searchBox().getAttribute('dir')).toBe('ltr');
    expect(screen.getByRole('button', { name: 'امسح' })).toBeTruthy();
    await screen.findByLabelText('العرض');
  });

  it('and the box SAYS it takes a customer’s name — a clerk holding a parcel with a name on it types the name', async () => {
    render(<ReturnsScreen />);
    expect(searchBox().getAttribute('placeholder')).toBe('امسح أو اكتب المرجع أو الاسم…');
    await screen.findByLabelText('العرض');
  });

  it('and a first load that fails says so — and the box is still there, because a desk that scans must not open without it', async () => {
    firstFails = true;
    render(<ReturnsScreen />);
    expect(await screen.findByText('تعذّر التحميل')).toBeTruthy();
    expect(searchBox()).toBeTruthy();
    expect(screen.queryByLabelText('العرض')).toBeNull();
  });

  it('and draws the waiting parcels with the columns of the work, and a button for each', async () => {
    await draw();
    expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الباركود', 'السبب', 'المدّة', 'المتوقَّع رجوعه', '']);
    expect(screen.getAllByText('ORD-P1').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'استلام' }).length).toBeGreaterThan(0);
  });

  it('and says how long each has waited, in words: «منذ 5 أيام» · «اليوم» · a dash for a parcel with no moment', async () => {
    rowsOf = () => [waiting('a', { daysWaited: 5 }), waiting('b', { daysWaited: 0 }), waiting('c', { daysWaited: null }), waiting('d', { daysWaited: 1 }), waiting('e', { daysWaited: 14 })];
    await draw();
    const cell = (id: string) => screen.getAllByText(`ORD-${id}`)[0].closest('tr')!.textContent;
    expect(cell('a')).toContain('منذ 5 أيام');
    expect(cell('b')).toContain('اليوم');
    expect(cell('d')).toContain('منذ يوماً واحداً');
    expect(cell('e')).toContain('منذ 14 يوماً');
    expect(cell('c')).not.toContain('منذ');
  });

  it('and nothing is «chosen» on opening — the view it opens on is not a filter, so no «إعادة تعيين»', async () => {
    await draw();
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
  });
});

describe('the toolbar', () => {
  it('— five dropdowns for the work, each with the server’s number beside the word', async () => {
    await draw();
    expect(options('العرض')).toEqual(['بانتظار الاستلام (60)', 'تم استلامها (14)']);
    expect(options('الحالة')).toEqual(['كل الحالات', 'طلب إرجاع (5)', 'مرتجع (40)', 'فشل التوصيل (10)', 'مسلَّم جزئياً (5)']);
    expect(options('شركة الشحن')).toEqual(['كل الشركات', 'ناقل (35)', 'أمان (20)', 'بلا شركة شحن (5)']);
    expect(options('مدّة الانتظار')).toEqual(['أيّ مدّة', 'اليوم أو أمس (12)', 'منذ 2–3 أيام (18)', 'منذ 4–7 أيام (20)', 'أكثر من أسبوع (10)']);
    expect(options('الباركود')).toEqual(['كل الطرود', 'بلا باركود (9)']);
  });

  it('and a company the new counts no longer hold is still in the box, with a zero — the box never snaps back behind the reader', async () => {
    await draw();
    choose('شركة الشحن', COURIER_A);
    await waitFor(() => expect(lastAsked().get('courier')).toBe(COURIER_A));
    facts = { ...facts, couriers: [{ id: COURIER_B, name: 'أمان', count: 20 }] };
    choose('الحالة', 'RETURNED');
    await waitFor(() => expect(lastAsked().get('status')).toBe('RETURNED'));
    expect(options('شركة الشحن')).toEqual(['كل الشركات', 'أمان (20)', `${COURIER_A} (0)`]);
    expect((screen.getByLabelText('شركة الشحن') as HTMLSelectElement).value).toBe(COURIER_A);
  });
});

describe('choosing', () => {
  it('— a state is asked for by its word, and only that', async () => {
    await draw();
    choose('الحالة', 'FAILED_DELIVERY');
    await waitFor(() => expect(gets()).toHaveLength(2));
    expect(lastAsked().toString()).toBe('status=FAILED_DELIVERY&view=pending&page=1&limit=25');
  });

  it('and the dropdowns together are one question — every one that was chosen, none that was not', async () => {
    await draw();
    choose('الحالة', 'RETURNED');
    choose('شركة الشحن', 'none');
    choose('مدّة الانتظار', 'old');
    await waitFor(() => expect(lastAsked().get('age')).toBe('old'));
    expect(lastAsked().toString()).toBe('age=old&courier=none&status=RETURNED&view=pending&page=1&limit=25');
  });

  it('and a change starts again at page one, from wherever the reader was', async () => {
    await draw();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    choose('مدّة الانتظار', 'week');
    await waitFor(() => expect(lastAsked().get('age')).toBe('week'));
    expect(lastAsked().get('page')).toBe('1');
  });

  it('and a typed word is asked after the burst, trimmed; blanks are nothing', async () => {
    await draw();
    fireEvent.change(searchBox(), { target: { value: '  سارة  ' } });
    await waitFor(() => expect(lastAsked().get('q')).toBe('سارة'));
    expect(gets()).toHaveLength(2);
    fireEvent.change(searchBox(), { target: { value: '   ' } });
    await waitFor(() => expect(gets()).toHaveLength(3));
    expect(lastAsked().has('q')).toBe(false);
  });

  it('and «إعادة تعيين» counts what is chosen — the search too — and puts every one back', async () => {
    await draw();
    choose('الحالة', 'RETURNED');
    choose('شركة الشحن', COURIER_B);
    choose('مدّة الانتظار', 'few');
    fireEvent.change(searchBox(), { target: { value: 'TRK' } });
    const reset = await screen.findByRole('button', { name: 'إعادة تعيين (4)' });
    fireEvent.click(reset);
    await waitFor(() => expect(lastAsked().toString()).toBe('view=pending&page=1&limit=25'));
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
    expect(searchBox().value).toBe('');
    for (const label of ['الحالة', 'شركة الشحن', 'مدّة الانتظار']) expect((screen.getByLabelText(label) as HTMLSelectElement).value, label).toBe('all');
  });
});

describe('putting everything back', () => {
  it('— «إعادة تعيين» puts the VIEW back on the work too: from the record, one press and the desk is where it opens', async () => {
    await draw();
    choose('العرض', 'received');
    const reset = await screen.findByRole('button', { name: 'إعادة تعيين (1)' });
    fireEvent.click(reset);
    await waitFor(() => expect(lastAsked().get('view')).toBe('pending'));
    expect((screen.getByLabelText('العرض') as HTMLSelectElement).value).toBe('pending');
    expect(screen.queryByRole('button', { name: /إعادة تعيين/ })).toBeNull();
  });
});

describe('a scan', () => {
  it('— lands in the box and is asked like any typed word, and hands the code back for the scanner to show', async () => {
    await draw();
    expect(scan.onScan).toBeTruthy();
    let said: unknown;
    act(() => {
      said = scan.onScan!('TRK-909');
    });
    expect(said).toBe('TRK-909');
    expect(searchBox().value).toBe('TRK-909');
    await waitFor(() => expect(lastAsked().get('q')).toBe('TRK-909'));
    expect(lastAsked().get('page')).toBe('1');
  });

  it('and a second scan replaces the first — a pallet is twenty parcels, one after the other', async () => {
    await draw();
    act(() => void scan.onScan!('A-1'));
    await waitFor(() => expect(lastAsked().get('q')).toBe('A-1'));
    act(() => void scan.onScan!('A-2'));
    await waitFor(() => expect(lastAsked().get('q')).toBe('A-2'));
    expect(searchBox().value).toBe('A-2');
  });
});

describe('the two views', () => {
  it('— the record has its own columns, and no button: what was counted, by whom and when', async () => {
    await draw();
    choose('العرض', 'received');
    await waitFor(() => expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الباركود', 'الاستلام', 'عُدَّ في']));
    const row = screen.getAllByText('ORD-R1')[0].closest('tr')!;
    expect(row.textContent).toContain('2 من 3 · تالف 1');
    expect(row.textContent).not.toContain('ناقص');
    expect(row.textContent).toContain('أمين');
    expect(screen.queryByRole('button', { name: 'استلام' })).toBeNull();
  });

  it('and a missing count is said too — «ناقص 2» — and a receipt that has none is a dash', async () => {
    rowsOf = (view) =>
      view === 'received'
        ? [counted('m', { receipt: { ...counted('x').receipt, receivedQty: 1, damagedQty: 0, missingQty: 2 } }), counted('n', { receipt: null })]
        : [waiting('P1')];
    await draw();
    choose('العرض', 'received');
    await waitFor(() => expect(screen.getAllByText('ORD-m').length).toBeGreaterThan(0));
    expect(screen.getAllByText('ORD-m')[0].closest('tr')!.textContent).toContain('1 من 3 · ناقص 2');
    // A receipt that is not there is a dash IN ITS OWN CELLS — «الاستلام» and «عُدَّ في» — not a dash somewhere on the row.
    const cells = [...screen.getAllByText('ORD-n')[0].closest('tr')!.querySelectorAll('td')].map((td) => td.textContent?.trim());
    const at = (label: string) => headings().indexOf(label);
    expect(cells[at('الاستلام')]).toBe('—');
    expect(cells[at('عُدَّ في')]).toBe('—');
  });

  it('and the state and the age do not apply to a parcel already counted: gone from the toolbar, and not carried into the record', async () => {
    await draw();
    choose('الحالة', 'RETURNED');
    choose('مدّة الانتظار', 'old');
    choose('شركة الشحن', COURIER_A);
    await waitFor(() => expect(lastAsked().get('age')).toBe('old'));
    choose('العرض', 'received');
    await waitFor(() => expect(lastAsked().get('view')).toBe('received'));
    expect(lastAsked().has('status')).toBe(false);
    expect(lastAsked().has('age')).toBe(false);
    // The company stays: it applies to both.
    expect(lastAsked().get('courier')).toBe(COURIER_A);
    expect(screen.queryByLabelText('الحالة')).toBeNull();
    expect(screen.queryByLabelText('مدّة الانتظار')).toBeNull();
    expect(screen.getByLabelText('شركة الشحن')).toBeTruthy();
  });

  it('and the columns follow the rows on screen, not the view just chosen — while the record is on its way the waiting parcels are still drawn as such', async () => {
    let release!: () => void;
    await draw();
    hold = new Promise<void>((r) => (release = r));
    choose('العرض', 'received');
    await waitFor(() => expect(gets().some((q) => q.get('view') === 'received')).toBe(true));
    // The answer has not come: nothing has crashed, and the old rows keep the old columns and their buttons.
    expect(headings()).toEqual(['المرجع', 'العميل', 'شركة الشحن', 'الباركود', 'السبب', 'المدّة', 'المتوقَّع رجوعه', '']);
    expect(screen.getAllByRole('button', { name: 'استلام' }).length).toBeGreaterThan(0);
    release();
    await waitFor(() => expect(headings()).toContain('عُدَّ في'));
  });

  it('and «إعادة تعيين» counts the view when it is not the work', async () => {
    await draw();
    choose('العرض', 'received');
    expect(await screen.findByRole('button', { name: 'إعادة تعيين (1)' })).toBeTruthy();
  });
});

describe('the pages', () => {
  it('— a list that fits one page has no bar at all: «صفحة 1 من 1» over two dead arrows tells a clerk with eleven returns nothing', async () => {
    total = 7;
    await draw();
    expect(screen.queryByRole('button', { name: 'الصفحة التالية' })).toBeNull();
    expect(pagerSentence(false)).toBeNull();
  });

  it('and a long one says where the page stands, and turns the SAME list — «التالي» keeps what was chosen', async () => {
    await draw();
    choose('الحالة', 'RETURNED');
    await waitFor(() => expect(lastAsked().get('status')).toBe('RETURNED'));
    expect(pagerSentence(true)!.textContent).toBe('عرض 1 من 60 مرتجع');
    expect(screen.getByText('صفحة 1 من 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    expect(lastAsked().get('status')).toBe('RETURNED');
    expect(screen.getAllByText('ORD-P2').length).toBeGreaterThan(0);
    expect(screen.getByText('صفحة 2 من 3')).toBeTruthy();
  });
});

describe('when nothing is there', () => {
  it('— an empty list with nothing chosen says the task is done, in the desk’s own words', async () => {
    total = 0;
    await draw();
    expect(screen.getByText('تمّت المهمة!')).toBeTruthy();
    expect(screen.getByText('المرتجع يظهر هنا حين تُعلن شركةُ الشحن فشلَ التسليم أو إرجاعَ الطرد. فراغُ القائمة يعني أنّ لا طردَ في طريق العودة.')).toBeTruthy();
    expect(screen.queryByText('لا مرتجعات بهذه الشروط')).toBeNull();
  });

  it('and an empty list BECAUSE of what was chosen says that, and offers the way out', async () => {
    await draw();
    total = 0;
    choose('الحالة', 'FAILED_DELIVERY');
    expect(await screen.findByText('لا مرتجعات بهذه الشروط')).toBeTruthy();
    expect(screen.queryByText('لا مرتجعات بانتظار الاستلام')).toBeNull();
    total = 60;
    fireEvent.click(screen.getByRole('button', { name: 'امسح الفلاتر' }));
    await waitFor(() => expect(lastAsked().toString()).toBe('view=pending&page=1&limit=25'));
  });

  it('and an empty RECORD says that nothing has been counted in yet', async () => {
    await draw();
    total = 0;
    choose('العرض', 'received');
    expect(await screen.findByText('لم يُستلم أيّ مرتجع بعد')).toBeTruthy();
  });

  it('and a scan that finds nothing is «because of what was chosen» too', async () => {
    await draw();
    total = 0;
    act(() => void scan.onScan!('NOPE'));
    expect(await screen.findByText('لا مرتجعات بهذه الشروط')).toBeTruthy();
  });
});

describe('«استلام»', () => {
  const receive = async () => {
    fireEvent.click(screen.getAllByRole('button', { name: 'استلام' })[0]);
    fireEvent.click(await screen.findByLabelText(/أقرّ بأنني عددت البضاعة/));
    fireEvent.click(screen.getByRole('button', { name: 'تأكيد الاستلام' }));
  };

  it('— records the receipt, says what was counted, and reloads the page the clerk is ON, with what was chosen', async () => {
    await draw();
    choose('الحالة', 'RETURNED');
    await waitFor(() => expect(lastAsked().get('status')).toBe('RETURNED'));
    fireEvent.click(screen.getByRole('button', { name: 'الصفحة التالية' }));
    await waitFor(() => expect(lastAsked().get('page')).toBe('2'));
    const before = gets().length;
    await receive();
    await screen.findByText(/تم استلام ORD-P2: سليم 3، تالف 0، ناقص 0/);
    expect(JSON.parse((posts()[0][1] as RequestInit).body as string)).toMatchObject({ orderId: 'P2', receivedQty: 3, damagedQty: 0, countedAndInspected: true });
    await waitFor(() => expect(gets().length).toBeGreaterThan(before));
    expect(lastAsked().get('page')).toBe('2');
    expect(lastAsked().get('status')).toBe('RETURNED');
  });

  it('and the dialog is closed once it is done', async () => {
    await draw();
    await receive();
    await screen.findByText(/تم استلام/);
    expect(screen.queryByText('استلام مرتجع')).toBeNull();
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/screens/ReturnsScreen.tsx'), 'utf8'));

  it('— from the kit, not a seventh copy of it: the hook, the toolbar and the page bar', () => {
    expect(src()).toContain("from '@/hooks/usePagedList'");
    expect(src()).toContain("from '@/components/ui/ListToolbar'");
    expect(src()).toContain("from '@/components/ui/Pager'");
    expect(src(), 'عادت نسخةٌ محلّيّةٌ من شريط الصفحات').not.toMatch(/الصفحة التالية/);
    expect(src(), 'عاد المحمِّل المكتوب باليد').not.toMatch(/useLiveRefresh|pageRef|loadRef/);
  });

  it('and the arrows are drawn only when there IS a second page', () => {
    expect(src()).toMatch(/\{pagination\.totalPages > 1 &&/);
  });

  it('and it computes no age and no state itself — the days are the server’s, the words come from one module', () => {
    expect(src()).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(src()).toContain("from '@/lib/returns-filters'");
    expect(src()).not.toMatch(/'RETURNED'|'FAILED_DELIVERY'|'RETURN_REQUESTED'|'PARTIALLY_DELIVERED'/);
  });
});
