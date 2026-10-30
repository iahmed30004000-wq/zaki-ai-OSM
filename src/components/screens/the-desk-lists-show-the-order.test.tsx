// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * THE FOUR LISTS OF «طلباتي» SHOW WHAT IS IN THE ORDER.
 *
 * The agent saw «ORD-1 · name · phone · 45» on «أكّدتها» and on «المؤجلة» and had to open the order to learn what
 * it was. Now every list carries the goods (with the gift and the add-on), the governorate and the city, the street
 * and a one-line note. Display only — the sum is still the server's, and who sees what is untouched.
 */

const { apiJson, user, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  user: { current: null as unknown },
  phone: { value: false },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/' }));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ locale: 'ar', t: {}, currentUser: user.current }) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<unknown>) => {
    const latest = React.useRef(load);
    latest.current = load;
    React.useEffect(() => {
      void latest.current();
    }, []);
  },
}));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>طلباتي</h1> }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/components/orders/OrderDetailModal', () => ({ OrderDetailModal: () => null }));
vi.mock('@/components/orders/CustomerHistory', () => ({ CustomerHistoryButton: () => null, CustomerHistoryOffer: () => null }));
vi.mock('@/components/orders/OrderLink', () => ({ OrderLink: ({ number }: { number: string }) => <span>{number}</span> }));
vi.mock('@/components/orders/ContactButtons', () => ({ ContactButtons: () => <i data-contact /> }));
vi.mock('@/components/screens/confirmation/ActionDialogs', () => ({ ChangeRequestDialog: () => null, IssueDialog: () => null, PostponeDialog: () => null, RejectDialog: () => null }));
vi.mock('@/components/screens/confirmation/AssistantDialog', () => ({ AssistantDialog: () => null }));
vi.mock('@/components/confirmation/PullPanel', () => ({ PullPanel: () => null, useQueue: () => ({ reload: vi.fn() }) }));

import { ConfirmationMineScreen } from './ConfirmationMineScreen';

const LINES = [
  { id: 'l1', productName: 'كريم مرطب', quantity: 3, freeQuantity: 1, lineTotal: 30 },
  { id: 'l2', productName: 'صابون', quantity: 1, freeQuantity: 0, lineTotal: 5 },
];
const ADD_ONS = [{ id: 'a1', productName: 'شامبو', quantity: 2, total: 15 }];

const base = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  merchantRef: null,
  confirmationStatus: 'NEW',
  state: 'NEW',
  previousOrders: 0,
  version: 1,
  totalAmount: 45,
  currency: 'JOD',
  claimedAt: null,
  firstActionAt: null,
  postponedUntil: null,
  postponePreferredTime: null,
  postponeCount: 0,
  noAnswerCount: 0,
  source: 'LANDING_PAGE',
  moderatorId: null,
  moderator: null,
  createdBy: null,
  channel: null,
  deliveryAddress: 'شارع الجلاء بناء 4',
  region: { name: 'دمشق' },
  internalNotes: 'عميل قديم',
  customerNotes: 'اتصلوا بعد العصر',
  customer: { id: `c-${id}`, fullName: `زبون ${id}`, phone: '0790000001', rawPhone: '0790000001', city: 'المزة', address: 'عنوان الزبون', totalOrders: 1 },
  items: LINES,
  addOns: ADD_ONS,
  _count: { contactAttempts: 1, notes: 0 },
  ...over,
});

const desk = (over: Record<string, unknown> = {}) => ({
  leadDays: 2,
  waitingLater: 0,
  noAnswerLimit: 3,
  serverNow: '2026-10-30T08:00:00.000Z',
  work: [base('W1')],
  noAnswer: [base('N1', { noAnswerCount: 1 })],
  closedToday: [],
  confirmed: { day: '2026-10-30', q: '', page: 1, pageSize: 25, total: 1, pages: 1, rows: [base('C1', { confirmationStatus: 'CONFIRMED', state: 'CONFIRMED' })] },
  ...over,
});

const POSTPONED_ROW = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  orderNumber: `ORD-${id}`,
  totalAmount: 45,
  currency: 'JOD',
  dueAt: '2026-10-31T10:00:00.000Z',
  daysRemaining: 1,
  postponePreferredTime: null,
  postponeCount: 1,
  followUpReason: null,
  actionable: true,
  mayHandBack: true,
  deliveryAddress: 'شارع الجلاء بناء 4',
  region: { name: 'دمشق' },
  internalNotes: null,
  customerNotes: 'اتصلوا بعد العصر',
  items: LINES,
  addOns: ADD_ONS,
  customer: { id: 'c1', fullName: 'زبون مؤجل', phone: '0790000001', city: 'المزة', address: 'عنوان الزبون' },
  claimer: { id: 'u1', name: 'سارة' },
  ...over,
});
const FACTS = { total: 1, whens: { now: 1, overdue: 0, soon: 0, week: 0, later: 0 }, kinds: { postponed: 1, followup: 0 }, times: { once: 1, many: 0 }, agents: null };

let mine: ReturnType<typeof desk>;
let postponedRows: ReturnType<typeof POSTPONED_ROW>[];

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  mine = desk();
  postponedRows = [POSTPONED_ROW('P1')];
  user.current = { id: 'u1', name: 'سارة', role: 'CONFIRMATION_AGENT', permissions: ['confirmation.work', 'orders.contact_log'], status: 'ACTIVE' };
  apiJson.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/confirmation/mine')) return mine;
    if (url.startsWith('/api/confirmation/postponed'))
      return { leadDays: 2, count: postponedRows.length, orders: postponedRows, pagination: { total: postponedRows.length, page: 1, limit: 25, totalPages: 1 }, facts: FACTS, applied: {} };
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

const draw = async (first = 'ORD-W1') => {
  render(<ConfirmationMineScreen />);
  await screen.findByText(first);
};
const openTab = (label: string) => fireEvent.click(screen.getByRole('tab', { name: new RegExp(`^${label}`) }));

/** Rows draws a table and the cards both; the desk's table is the one with a header row. */
const table = () => document.querySelector('table') as HTMLElement;

describe('«للشغل» and «لا يرد» — the working card', () => {
  it('(أ) lists every line with the gift and the add-on, and names the governorate, the street and the notes', async () => {
    await draw();
    expect(screen.getByText(/كريم مرطب × 3/)).toBeTruthy();
    expect(screen.getByText(/\(\+1 هدية\)/)).toBeTruthy();
    expect(screen.getByText(/شامبو ×2/)).toBeTruthy();
    expect(screen.getByText('المحافظة: دمشق')).toBeTruthy();
    expect(screen.getByText('شارع الجلاء بناء 4')).toBeTruthy();
    expect(screen.getByText('ملاحظة الزبون: اتصلوا بعد العصر')).toBeTruthy();
    expect(screen.getByText('ملاحظة داخلية: عميل قديم')).toBeTruthy();
  });

  it('(ب) an order with no lines and no notes does not crash, and the other card is still drawn', async () => {
    mine = desk({ work: [base('W1', { items: [], addOns: [], region: null, internalNotes: null, customerNotes: null }), base('W2')] });
    await draw();
    expect(screen.getByText('ORD-W2')).toBeTruthy();
    expect(screen.getAllByText(/ملاحظة الزبون/)).toHaveLength(1);
  });

  it('(ب) a response from before these fields existed still draws', async () => {
    const old = base('W1');
    delete (old as Record<string, unknown>).region;
    delete (old as Record<string, unknown>).internalNotes;
    delete (old as Record<string, unknown>).customerNotes;
    delete (old as Record<string, unknown>).addOns;
    mine = desk({ work: [old] });
    await draw();
    expect(screen.getByText(/كريم مرطب × 3/)).toBeTruthy();
    expect(screen.queryByText(/المحافظة/)).toBeNull();
  });

  it('(ج) «لا يرد» carries the same', async () => {
    await draw();
    openTab('لا يرد');
    expect(await screen.findByText('ORD-N1')).toBeTruthy();
    expect(screen.getByText(/كريم مرطب × 3/)).toBeTruthy();
    expect(screen.getByText('المحافظة: دمشق')).toBeTruthy();
  });
});

describe('«أكّدتها»', () => {
  it('(ج) the table has the goods and the place columns, and the row says the product, the quantity, the gift, the add-on and the street', async () => {
    await draw();
    openTab('أكّدتها');
    const t = within(table());
    expect(t.getByText('المنتجات')).toBeTruthy();
    expect(t.getByText('العنوان')).toBeTruthy();
    expect(t.getByText('كريم مرطب × 3 (+1 مجاني)')).toBeTruthy();
    expect(t.getByText('صابون × 1')).toBeTruthy();
    expect(t.getByText('شامبو × 2')).toBeTruthy();
    expect(t.getByText('إضافة:')).toBeTruthy();
    expect(t.getByText('دمشق · المزة')).toBeTruthy();
    expect(t.getByText('شارع الجلاء بناء 4')).toBeTruthy();
    expect(t.getByText('ملاحظة الزبون: اتصلوا بعد العصر')).toBeTruthy();
  });

  it('the columns it had are still there, and the sum is still what the server sent', async () => {
    await draw();
    openTab('أكّدتها');
    const t = within(table());
    for (const h of ['الطلب', 'العميل', 'الهاتف', 'المبلغ']) expect(t.getByText(h)).toBeTruthy();
    expect(t.getByText('طلب تعديل')).toBeTruthy();
  });

  it('(ب) no lines, no street: dashes, no crash', async () => {
    mine = desk({ confirmed: { ...desk().confirmed, rows: [base('C1', { items: [], addOns: [], deliveryAddress: null, region: null, customerNotes: null, internalNotes: null, customer: { ...base('C1').customer, address: '', city: '' } })] } });
    await draw();
    openTab('أكّدتها');
    expect(within(table()).getAllByText('—')).toHaveLength(2);
  });

  it('ten lines are cut to three and the rest is a number', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, productName: `صنف ${i + 1}`, quantity: 1, freeQuantity: 0, lineTotal: 1 }));
    mine = desk({ confirmed: { ...desk().confirmed, rows: [base('C1', { items: ten, addOns: [] })] } });
    await draw();
    openTab('أكّدتها');
    const t = within(table());
    expect(t.getByText('صنف 3 × 1')).toBeTruthy();
    expect(t.queryByText('صنف 4 × 1')).toBeNull();
    expect(t.getByText('+7 أخرى')).toBeTruthy();
  });

  it('(د) a phone gets cards: the goods and the place are on the card, each labelled', async () => {
    phone.value = true;
    await draw();
    openTab('أكّدتها');
    const card = document.querySelector('ul.md\\:hidden li') as HTMLElement;
    expect(card).toBeTruthy();
    const c = within(card);
    expect(c.getByText('المنتجات')).toBeTruthy();
    expect(c.getByText('العنوان')).toBeTruthy();
    expect(c.getByText('كريم مرطب × 3 (+1 مجاني)')).toBeTruthy();
    expect(c.getByText('شارع الجلاء بناء 4')).toBeTruthy();
  });
});

describe('«المؤجلة»', () => {
  it('(ج) the table has the goods and the place columns and the row carries them', async () => {
    await draw();
    openTab('المؤجلة');
    expect(await screen.findAllByText('ORD-P1')).not.toHaveLength(0);
    const t = within(table());
    expect(t.getByText('المنتجات')).toBeTruthy();
    expect(t.getByText('العنوان')).toBeTruthy();
    expect(t.getByText('كريم مرطب × 3 (+1 مجاني)')).toBeTruthy();
    expect(t.getByText('شامبو × 2')).toBeTruthy();
    expect(t.getByText('دمشق · المزة')).toBeTruthy();
    expect(t.getByText('ملاحظة الزبون: اتصلوا بعد العصر')).toBeTruthy();
    // what it had: the due date, the count, the way back to the queue
    expect(t.getByText('تاريخ الاستحقاق')).toBeTruthy();
    expect(t.getByText('إلى الطابور', { selector: 'th' })).toBeTruthy();
  });

  it('(ب) an older server without the fields draws dashes, not a crash', async () => {
    const old = POSTPONED_ROW('P1');
    for (const k of ['items', 'addOns', 'region', 'deliveryAddress', 'internalNotes', 'customerNotes'] as const) delete (old as Record<string, unknown>)[k];
    postponedRows = [old];
    await draw();
    openTab('المؤجلة');
    await screen.findAllByText('ORD-P1');
    expect(within(table()).getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('(د) a phone gets cards with the goods on them', async () => {
    phone.value = true;
    await draw();
    openTab('المؤجلة');
    await screen.findAllByText('ORD-P1');
    const card = document.querySelector('ul.md\\:hidden li') as HTMLElement;
    expect(within(card).getByText('كريم مرطب × 3 (+1 مجاني)')).toBeTruthy();
    expect(within(card).getByText('شارع الجلاء بناء 4')).toBeTruthy();
  });
});

describe('the doors — one query, the same visibility, the same customer-data tally', () => {
  const mineSrc = () => stripComments(repoFile('src/app/api/confirmation/mine/route.ts'));
  const postponedSrc = () => stripComments(repoFile('src/app/api/confirmation/postponed/route.ts'));

  it('«أكّدتها» reads the goods in the page query itself (the select is shared by all four lists)', () => {
    const s = mineSrc();
    expect(s).toContain('items: { select: { id: true, productName: true, quantity: true, freeQuantity: true, lineTotal: true, reservedQty: true } }');
    expect(s).toContain('addOns: { select: { id: true, productName: true, quantity: true, total: true } }');
    expect(s).toContain('region: { select: { name: true } }');
    expect(s).toContain('select: { ...ORDER_SELECT, changeRequests');
    expect(s).toContain('internalNotes: true');
    expect(s).toContain('customerNotes: true');
  });

  it('«المؤجلة» reads them in the page query too, bounded by the page', () => {
    const s = postponedSrc();
    expect(s).toContain('items: { select: { id: true, productName: true, quantity: true, freeQuantity: true } }');
    expect(s).toContain('addOns: { select: { id: true, productName: true, quantity: true } }');
    expect(s).toContain('region: { select: { name: true } }');
    expect(s).toContain('customer: { select: { id: true, fullName: true, phone: true, city: true, address: true } }');
    expect(s).toContain('limit: readLimit(params, 25, 100)');
  });

  it('no query per row: neither door asks the database inside a map', () => {
    for (const s of [mineSrc(), postponedSrc()]) {
      expect(s).not.toMatch(/\.map\(\s*async/);
      expect(s).not.toMatch(/\.map\([^)]*=>[^)]*db\./);
    }
  });

  it('visibility is what it was: the agent’s own claim, the supervisor’s scope, and the tally of handed-out details', () => {
    const m = mineSrc();
    expect(m).toContain('const scope = { companyId, storeId, claimedById: user.id }');
    expect(m).toContain('noteCustomersHandedOut({ companyId, storeId, user, where:');
    expect(m).toContain("await requirePermission('confirmation.work')");
    const p = postponedSrc();
    expect(p).toContain('ownOnly: supervisor ? undefined : user.id');
    expect(p).toContain('noteCustomersHandedOut({ companyId, storeId, user, where:');
  });

  it('display only: neither door nor the shared piece computes a sum', () => {
    const piece = stripComments(repoFile('src/components/orders/OrderGoods.tsx'));
    expect(piece).not.toMatch(/lineTotal|totalAmount|reduce\(|\bprice\b/i);
    expect(piece).not.toMatch(/\*\s*it\.|\*\s*a\./);
  });
});
