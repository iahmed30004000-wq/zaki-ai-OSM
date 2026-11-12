// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «المطابقة اليدوية شو؟ ... افرض مندوب أو شركة ما عندها سيستم أو إكسل، شو أعمل؟»
 *
 * The mechanism existed — a button at the bottom of the shipment follow-up — and the person who
 * asked could not find it. What the matching screen owes now, for a courier or a company with no
 * statement and no file:
 *
 *   • the choice is on the screen before any click: two named tabs, «بكشف من الشركة» and «يدوي — بلا كشف»,
 *     and the manual one says in three lines what to do;
 *   • the courier's open parcels, in pages of 50, found by courier or by a word;
 *   • a parcel is ticked only if a door can settle it: out for delivery → «تم تسليمها» / «رجعت»;
 *     delivered and unsettled → «استلمت منه» through the dialog that already writes the wallet;
 *     a cancelled-while-travelling parcel, one still to be picked up, a returned one: no box;
 *   • one kind of work per press, and for money one courier and one currency — said in words;
 *   • each order is its own call, one after another, and a refusal does not stop the rest: the
 *     answer is «2 من 3» with the door's own reason for the third;
 *   • nobody is offered a button its door always refuses (no cash-box permission: no money box);
 *   • and nothing here writes money or holds arithmetic — the collect goes through `CollectDialog`.
 */

const { api, confirm, search, user, dialog } = vi.hoisted(() => ({
  api: vi.fn(),
  confirm: vi.fn(),
  search: { value: '' },
  user: { current: null as unknown },
  dialog: { props: null as null | { orders: { id: string }[]; onClose: () => void; onDone: (m: string) => void } },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(search.value),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/matching',
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirm, useAsk: () => async () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({
  CollectDialog: (p: { orders: { id: string }[]; onClose: () => void; onDone: (m: string) => void }) => {
    dialog.props = p;
    return (
      <div role="dialog" aria-label="استلام المبلغ">
        <p data-testid="dialog-orders">{p.orders.map((o) => o.id).join(',')}</p>
        <button onClick={() => p.onDone('سُجِّل استلام المبلغ')}>أتمّ الاستلام</button>
        <button onClick={p.onClose}>أغلق النافذة</button>
      </div>
    );
  },
}));

import { ManualMatching, readChoice, stepFor } from './ManualMatching';
import { MatchingScreen } from './MatchingScreen';
import { CollectionScreen } from './CollectionScreen';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ADMIN = { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['ops.track', 'finance.cashbox', 'settlement.review'] };
const TRACKER = { id: 'u2', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.track'] };
const OFFICER = { id: 'u3', status: 'ACTIVE', role: 'SETTLEMENT_OFFICER', permissions: ['settlement.review'] };

type Parcel = ReturnType<typeof parcel>;
const parcel = (ref: string, over: Record<string, unknown> = {}) => ({
  id: `id-${ref}`,
  orderNumber: `ORD-${ref}`,
  merchantRef: ref,
  trackingNumber: `TRK-${ref}`,
  shippingStatus: 'SHIPPED',
  settlementStatus: 'NOT_APPLICABLE',
  daysInTransit: 1,
  late: false,
  totalAmount: 40,
  currency: 'JOD',
  customer: { fullName: `زبون ${ref}`, phone: '0790000000', city: 'عمّان' },
  deliveryProvider: { id: A, name: 'أبو علي', kind: 'AGENT' },
  expectedCollection: 37.5,
  alert: null as null | { kind: 'CANCELLED' | 'CHANGED'; at: string; acknowledged: boolean },
  ...over,
});
const delivered = (ref: string, over: Record<string, unknown> = {}) =>
  parcel(ref, { shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED', ...over });

const PRODUCTS = [
  { id: 'prod-cream', name: 'كريم الندبات', basePrice: 20 },
  { id: 'prod-hoodie', name: 'هودي بديل المازوت', basePrice: 25 },
];

const FACTS = {
  total: 9,
  tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 },
  lateCount: 0,
  couriers: [
    { id: A, name: 'أبو علي', count: 5 },
    { id: B, name: 'أمان', count: 2 },
  ],
  regions: [],
  ages: { fresh: 0, few: 0, week: 0, old: 0 },
};

/** What the follow-up door holds right now, and how the deliver door answers. */
let parcels: Parcel[];
let refuse: Record<string, string>;
let hold: Promise<void> | null;
let running: number;
let overlapped: number;

const gets = () =>
  api.mock.calls
    .filter((c) => !(c[1] && (c[1] as RequestInit).method))
    .map((c) => new URL(c[0] as string, 'http://x'))
    .filter((u) => u.pathname === '/api/ops/tracking')
    .map((u) => u.searchParams);
const posts = () =>
  api.mock.calls
    .filter((c) => c[1] && (c[1] as RequestInit).method === 'POST')
    .map((c) => ({ url: c[0] as string, body: JSON.parse(String((c[1] as RequestInit).body)) as { orderId: string; outcome: string } }));

beforeEach(() => {
  vi.clearAllMocks();
  search.value = '';
  user.current = ADMIN;
  dialog.props = null;
  confirm.mockResolvedValue(true);
  refuse = {};
  hold = null;
  running = 0;
  overlapped = 0;
  parcels = [parcel('M1'), parcel('M2'), parcel('M3')];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { orderId: string };
      running += 1;
      overlapped = Math.max(overlapped, running);
      try {
        if (hold) await hold;
        else await Promise.resolve();
        if (refuse[body.orderId]) throw new Error(refuse[body.orderId]);
        return { message: 'سُجِّل' };
      } finally {
        running -= 1;
      }
    }
    const u = new URL(url, 'http://x');
    if (u.pathname === '/api/finance/statements') return { statements: [] };
    if (u.pathname === '/api/ops/references') return { providers: [] };
    if (u.pathname === '/api/finance/wallets') return { wallets: [] };
    if (u.pathname === '/api/products') return { products: PRODUCTS };
    const q = u.searchParams;
    let list = parcels;
    if (q.get('status')) list = list.filter((p) => p.shippingStatus === q.get('status'));
    if (q.get('product')) list = list.filter((p) => (p as { productId?: string }).productId === q.get('product'));
    if (q.get('courier')) list = list.filter((p) => p.deliveryProvider?.id === q.get('courier'));
    if (q.get('task') === 'COLLECT') {
      list = list.filter((p) => ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(p.shippingStatus) && p.settlementStatus !== 'SETTLED');
    }
    if (q.get('q')) list = list.filter((p) => `${p.merchantRef} ${p.customer.fullName}`.includes(q.get('q')!));
    const limit = Number(q.get('limit'));
    const totalPages = Math.max(1, Math.ceil(list.length / limit));
    const page = Math.min(Number(q.get('page')), totalPages);
    return {
      orders: list.slice((page - 1) * limit, page * limit),
      pagination: { total: list.length, page, limit, totalPages },
      facts: FACTS,
    };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<ManualMatching />);
  await screen.findByLabelText('جهة الشحن');
  await waitFor(() => expect(document.querySelector('tbody tr')).not.toBeNull());
};

/**
 * The DESK's row — `Rows` draws every row twice, as a table row and as a card.
 *
 * A row is found by the reference IN ITS REFERENCE CELL, never by a substring of the row: "JOD" + "37.50" is
 * "…D37…", which contains "D3", and a helper that matched on text ticked the wrong parcel for an hour.
 */
const refOf = (tr: Element) =>
  [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').match(/^[A-Z0-9]+/)?.[0]).find(Boolean);
const deskRow = (ref: string) =>
  [...document.querySelectorAll('tbody tr')].find((tr) => refOf(tr) === ref) as HTMLElement | undefined;
const box = (ref: string) => deskRow(ref)?.querySelector('input[type="checkbox"]') as HTMLInputElement | null | undefined;
const tick = (...refs: string[]) => refs.forEach((r) => fireEvent.click(box(r)!));
const ticked = () =>
  [...document.querySelectorAll('tbody tr')]
    .filter((tr) => (tr.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked)
    .map((tr) => refOf(tr));
const press = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const choose = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('the reference opens the order', () => {
  it('— for somebody who may open the orders screen, the reference is a link to that order', async () => {
    user.current = { ...ADMIN, permissions: [...ADMIN.permissions, 'orders.view'] };
    await draw();
    const link = screen.getAllByRole('link', { name: 'M1' })[0];
    expect(link.getAttribute('href')).toBe('/orders/id-M1');
  });

  it('NEGATIVE: and for somebody who may not, it is the text it was — no link that ends in a refusal', async () => {
    await draw();
    expect(screen.queryByRole('link', { name: 'M1' })).toBeNull();
    expect(screen.getAllByText('M1').length).toBeGreaterThan(0);
  });
});

describe('opening it', () => {
  it('asks the follow-up door for page one, fifty to a page, and nothing else', async () => {
    await draw();
    expect(gets()).toHaveLength(1);
    expect(gets()[0].toString()).toBe('page=1&limit=50');
  });

  it('shows what to do before anything is clicked — in three lines that name the three buttons', async () => {
    await draw();
    const text = document.body.textContent ?? '';
    expect(text).toContain('مطابقة يدوية');
    for (const word of ['تم تسليمها', 'رجعت', 'استلمت منه']) expect(text, word).toContain(word);
  });

  it('if the first answer fails, the reason is shown and the spinner stops — it does not turn for ever', async () => {
    // The FOLLOW-UP list's first answer fails — whichever request the screen happens to make first (the product
    // list for the filter is another one).
    const base = api.getMockImplementation()!;
    let failed = false;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (!failed && url.startsWith('/api/ops/tracking')) {
        failed = true;
        throw new Error('تعذّر الوصول إلى الخادم');
      }
      return base(url, init);
    });
    render(<ManualMatching />);
    expect(await screen.findByText('تعذّر الوصول إلى الخادم')).toBeTruthy();
    expect(screen.queryByText(/جارٍ التحميل/)).toBeNull();
    // and it is not a dead end: the search box is there to ask again.
    expect(screen.getByLabelText('بحث')).toBeTruthy();
  });

  it('while the first answer is on its way a spinner says so', async () => {
    let answer!: (v: unknown) => void;
    const base = api.getMockImplementation()!;
    let held = false;
    api.mockImplementation((url: string, init?: RequestInit) => {
      if (!held && url.startsWith('/api/ops/tracking')) {
        held = true;
        return new Promise((r) => (answer = r));
      }
      return base(url, init);
    });
    render(<ManualMatching />);
    expect(await screen.findByText(/جارٍ التحميل/)).toBeTruthy();
    answer({ orders: [], pagination: { total: 0, page: 1, limit: 50, totalPages: 1 }, facts: FACTS });
    await waitFor(() => expect(screen.queryByText(/جارٍ التحميل/)).toBeNull());
  });

  it('draws a labelled search field and the server’s couriers with their counts', async () => {
    await draw();
    expect((screen.getByLabelText('بحث') as HTMLInputElement).tagName).toBe('INPUT');
    const options = within(screen.getByLabelText('جهة الشحن'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['كل الجهات', 'أبو علي (5)', 'أمان (2)']);
  });
});

describe('which parcel can be ticked', () => {
  const everyStatus = () => [
    parcel('SHIP'),
    parcel('OUT', { shippingStatus: 'OUT_FOR_DELIVERY' }),
    delivered('DEL'),
    delivered('PART', { shippingStatus: 'PARTIALLY_DELIVERED' }),
    delivered('PAID', { settlementStatus: 'SETTLED' }),
    parcel('PICK', { shippingStatus: 'READY_FOR_PICKUP' }),
    parcel('FAIL', { shippingStatus: 'FAILED_DELIVERY' }),
    parcel('BACK', { shippingStatus: 'RETURN_REQUESTED' }),
    parcel('GONE', { shippingStatus: 'RETURNED' }),
  ];

  it('only the ones a door can settle: out for delivery, and delivered with the money still owed', async () => {
    parcels = everyStatus();
    await draw();
    const withBox = ['SHIP', 'OUT', 'DEL', 'PART', 'PAID', 'PICK', 'FAIL', 'BACK', 'GONE'].filter((r) => box(r));
    expect(withBox).toEqual(['SHIP', 'OUT', 'DEL', 'PART']);
  });

  it('and a row with no box says where it is handled, instead of a dead checkbox', async () => {
    parcels = everyStatus();
    await draw();
    for (const ref of ['PAID', 'PICK', 'FAIL', 'BACK', 'GONE']) {
      expect(deskRow(ref)!.textContent, ref).toContain('من شاشة متابعة الشحن');
    }
  });

  it('each row says what it needs; the server’s figure of what is owed is on a delivered one and on no other', async () => {
    parcels = [parcel('SHIP'), delivered('DEL')];
    await draw();
    expect(deskRow('SHIP')!.textContent).toContain('تسجيل التسليم أو الرجوع');
    expect(deskRow('DEL')!.textContent).toContain('استلام المبلغ');
    expect(deskRow('DEL')!.textContent).toContain('37.50');
    expect(deskRow('SHIP')!.textContent).not.toContain('37.50');
  });

  it('a parcel whose order was cancelled while it travels cannot be ticked «delivered» — and says why', async () => {
    parcels = [
      parcel('CAN', { alert: { kind: 'CANCELLED', at: '2026-10-20', acknowledged: false } }),
      parcel('CHG', { alert: { kind: 'CHANGED', at: '2026-10-20', acknowledged: false } }),
    ];
    await draw();
    expect(box('CAN')).toBeNull();
    expect(deskRow('CAN')!.textContent).toContain('أُلغي');
    expect(box('CHG')).not.toBeNull();
  });

  it('without the cash-box permission the delivered rows have no box, and a sentence says so', async () => {
    user.current = TRACKER;
    parcels = [parcel('SHIP'), delivered('DEL')];
    await draw();
    expect(box('SHIP')).not.toBeNull();
    expect(box('DEL')).toBeNull();
    expect(document.body.textContent).toContain('استلام المبلغ يحتاج صلاحية الصندوق');
  });

  it('and with it there is no such sentence', async () => {
    parcels = [parcel('SHIP'), delivered('DEL')];
    await draw();
    expect(document.body.textContent).not.toContain('يحتاج صلاحية الصندوق');
  });
});

describe('what the ticked parcels ask for', () => {
  it('parcels out for delivery offer exactly the two outcomes — with the count in the button', async () => {
    await draw();
    tick('M1', 'M2');
    expect(screen.getByRole('button', { name: /تم تسليمها \(2\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /رجعت \(2\)/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /استلمت منه/ })).toBeNull();
  });

  it('delivered parcels offer the money button, and only it', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await draw();
    tick('D1', 'D2');
    expect(screen.getByRole('button', { name: /استلمت منه \(2\)/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /تم تسليمها/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /رجعت/ })).toBeNull();
  });

  it('a delivery and a collection in one choice is said in words, and no action button is drawn', async () => {
    parcels = [parcel('M1'), delivered('D1')];
    await draw();
    tick('M1', 'D1');
    expect(document.body.textContent).toContain('اختر نوعاً واحداً في كل مرة');
    for (const name of [/تم تسليمها/, /رجعت \(/, /استلمت منه \(/]) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('money from two couriers in one press is refused in words — the dialog says «منه», it means one person', async () => {
    parcels = [delivered('D1'), delivered('D2', { deliveryProvider: { id: B, name: 'أمان', kind: 'COMPANY' } })];
    await draw();
    tick('D1', 'D2');
    expect(document.body.textContent).toContain('جهة واحدة');
    expect(screen.queryByRole('button', { name: /استلمت منه \(/ })).toBeNull();
  });

  it('and in two currencies likewise — the door refuses a mixture, so the button is never offered one', async () => {
    parcels = [delivered('D1'), delivered('D2', { currency: 'USD' })];
    await draw();
    tick('D1', 'D2');
    expect(document.body.textContent).toContain('أكثر من عملة');
    expect(screen.queryByRole('button', { name: /استلمت منه \(/ })).toBeNull();
  });

  it('two couriers are fine for an OUTCOME — each order stands alone at the door', async () => {
    parcels = [parcel('M1'), parcel('M2', { deliveryProvider: { id: B, name: 'أمان', kind: 'COMPANY' } })];
    await draw();
    tick('M1', 'M2');
    expect(screen.getByRole('button', { name: /تم تسليمها \(2\)/ })).toBeTruthy();
  });
});

describe('quick picks', () => {
  it('«اختر كل ما بانتظار التسليم» ticks those and no others; «إلغاء الاختيار» clears', async () => {
    parcels = [parcel('M1'), parcel('M2'), delivered('D1')];
    await draw();
    // One page: «all» is all, and says nothing more.
    expect(screen.getByRole('button', { name: /اختر كل ما بانتظار التسليم \(2\)$/ })).toBeTruthy();
    press(/اختر كل ما بانتظار التسليم \(2\)/);
    expect(ticked()).toEqual(['M1', 'M2']);
    press(/إلغاء الاختيار/);
    expect(ticked()).toEqual([]);
  });

  it('«اختر كل ما بانتظار التحصيل» ticks the delivered ones', async () => {
    parcels = [parcel('M1'), delivered('D1'), delivered('D2')];
    await draw();
    press(/اختر كل ما بانتظار التحصيل \(2\)/);
    expect(ticked()).toEqual(['D1', 'D2']);
  });

  it('and with no cash-box permission the money pick is not offered at all', async () => {
    user.current = TRACKER;
    parcels = [parcel('M1'), delivered('D1')];
    await draw();
    expect(screen.queryByRole('button', { name: /اختر كل ما بانتظار التحصيل/ })).toBeNull();
    expect(screen.getByRole('button', { name: /اختر كل ما بانتظار التسليم \(1\)/ })).toBeTruthy();
  });
});

describe('recording the outcome', () => {
  it('«تم تسليمها»: asks first, then one call per order, one AFTER another, outcome ALL', async () => {
    await draw();
    tick('M1', 'M2');
    press(/تم تسليمها \(2\)/);
    await screen.findByText(/سُجِّل تسليم 2 طلب/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0].title).toContain('2');
    expect(confirm.mock.calls[0][0].tone).not.toBe('danger');
    expect(posts()).toEqual([
      { url: '/api/ops/tracking/deliver', body: { orderId: 'id-M1', outcome: 'ALL' } },
      { url: '/api/ops/tracking/deliver', body: { orderId: 'id-M2', outcome: 'ALL' } },
    ]);
    expect(overlapped).toBe(1);
  });

  it('and says what comes next: the money is taken with «استلمت منه»', async () => {
    await draw();
    tick('M1');
    press(/تم تسليمها \(1\)/);
    expect((await screen.findByText(/سُجِّل تسليم 1 طلب/)).textContent).toContain('استلمت منه');
  });

  it('«رجعت»: a DANGER confirmation, outcome NONE, and the goods are said to be counted in the returns desk', async () => {
    await draw();
    tick('M1', 'M3');
    press(/رجعت \(2\)/);
    const done = await screen.findByText(/سُجِّل رجوع 2 طلب/);
    expect(done.textContent).toContain('المرتجعات');
    expect(confirm.mock.calls[0][0].tone).toBe('danger');
    expect(posts().map((p) => p.body)).toEqual([
      { orderId: 'id-M1', outcome: 'NONE' },
      { orderId: 'id-M3', outcome: 'NONE' },
    ]);
  });

  it('refusing the question writes nothing and keeps the ticks', async () => {
    confirm.mockResolvedValue(false);
    await draw();
    tick('M1', 'M2');
    press(/رجعت \(2\)/);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(posts()).toEqual([]);
    expect(ticked()).toHaveLength(2);
  });

  it('afterwards the page is read again with what was chosen, and the ticks are gone', async () => {
    await draw();
    choose('جهة الشحن', A);
    await waitFor(() => expect(gets().at(-1)!.get('courier')).toBe(A));
    await waitFor(() => expect(box('M1')).not.toBeNull());
    tick('M1');
    const before = gets().length;
    press(/تم تسليمها \(1\)/);
    await screen.findByText(/سُجِّل تسليم 1 طلب/);
    await waitFor(() => expect(gets().length).toBe(before + 1));
    expect(gets().at(-1)!.toString()).toBe(`courier=${A}&page=1&limit=50`);
    expect(ticked()).toEqual([]);
  });

  it('a refusal in the middle does not stop the rest — the answer is «2 من 3», and the door’s own reason', async () => {
    refuse = { 'id-M2': 'لا يمكن تسجيل التسليم قبل خروج الشحنة للتوصيل' };
    await draw();
    tick('M1', 'M2', 'M3');
    press(/تم تسليمها \(3\)/);
    await screen.findByText(/سُجِّل تسليم 2 من 3/);
    expect(posts().map((p) => p.body.orderId)).toEqual(['id-M1', 'id-M2', 'id-M3']);
    const failure = screen.getByText(/تعذّر تسجيل 1 طلب/).parentElement!;
    // The seller's own reference — what they typed on the parcel — not the system's number for it.
    expect(failure.textContent).toContain('M2');
    expect(failure.textContent).not.toContain('ORD-');
    expect(failure.textContent).toContain('لا يمكن تسجيل التسليم قبل خروج الشحنة للتوصيل');
  });

  it('and a parcel with no reference of its own is named by the order number', async () => {
    parcels = [parcel('M9', { merchantRef: null })];
    refuse = { 'id-M9': 'سُجِّل تسليم هذا الطلب مسبقاً' };
    await draw();
    fireEvent.click(document.querySelector('tbody tr input[type="checkbox"]')!);
    press(/تم تسليمها \(1\)/);
    const failure = (await screen.findByText(/تعذّر تسجيل 1 طلب/)).parentElement!;
    expect(failure.textContent).toContain('ORD-M9');
  });

  it('when every one is refused there is no success sentence — only the reasons', async () => {
    refuse = { 'id-M1': 'سُجِّل تسليم هذا الطلب مسبقاً', 'id-M2': 'سُجِّل تسليم هذا الطلب مسبقاً' };
    await draw();
    tick('M1', 'M2');
    press(/تم تسليمها \(2\)/);
    await screen.findByText(/تعذّر تسجيل 2 طلب/);
    expect(document.body.textContent).not.toContain('سُجِّل تسليم 0');
    expect(document.body.textContent).not.toMatch(/سُجِّل تسليم \d+ (طلب|من)/);
  });

  it('a new press starts clean: the last sentence and the last reasons do not outlive it', async () => {
    await draw();
    tick('M1');
    press(/تم تسليمها \(1\)/);
    await screen.findByText(/سُجِّل تسليم 1 طلب/);

    // A second run in which everything is refused: the earlier success must not stay on the screen beside it.
    refuse = { 'id-M2': 'سُجِّل تسليم هذا الطلب مسبقاً', 'id-M3': 'سُجِّل تسليم هذا الطلب مسبقاً' };
    tick('M2', 'M3');
    press(/تم تسليمها \(2\)/);
    await screen.findByText(/تعذّر تسجيل 2 طلب/);
    expect(document.body.textContent).not.toMatch(/سُجِّل تسليم \d+ (طلب|من)/);

    // And a third, clean one: the earlier reasons must not stay beside the new success.
    refuse = {};
    tick('M2');
    press(/تم تسليمها \(1\)/);
    await screen.findByText(/سُجِّل تسليم 1 طلب/);
    expect(screen.queryByText(/تعذّر تسجيل/)).toBeNull();
  });

  it('a tick on a parcel that stopped being settleable while the screen was open is not acted on', async () => {
    await draw();
    tick('M1', 'M2');
    // Somebody else moved M1 on while this screen sat open; coming back to the window reads the page again.
    parcels = [parcel('M1', { shippingStatus: 'RETURN_REQUESTED' }), parcel('M2'), parcel('M3')];
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(box('M1')).toBeNull());
    press(/تم تسليمها \(1\)/);
    await screen.findByText(/سُجِّل تسليم 1 طلب/);
    expect(posts().map((p) => p.body.orderId)).toEqual(['id-M2']);
  });

  it('and while a new press is in the air the last press’s reasons are already gone', async () => {
    refuse = { 'id-M1': 'سُجِّل تسليم هذا الطلب مسبقاً' };
    await draw();
    tick('M1');
    press(/تم تسليمها \(1\)/);
    await screen.findByText(/تعذّر تسجيل 1 طلب/);

    refuse = {};
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    tick('M2');
    press(/تم تسليمها \(1\)/);
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(screen.queryByText(/تعذّر تسجيل/)).toBeNull();
    release();
    await screen.findByText(/سُجِّل تسليم 1 طلب/);
  });

  it('while it runs the buttons are shut — a second press cannot start the same orders twice', async () => {
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    await draw();
    tick('M1', 'M2');
    press(/تم تسليمها \(2\)/);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect((screen.getByRole('button', { name: /تم تسليمها \(2\)/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /رجعت \(2\)/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await screen.findByText(/سُجِّل تسليم 2 طلب/);
    expect(posts()).toHaveLength(2);
  });
});

describe('taking the money', () => {
  it('«استلمت منه» opens the dialog that already writes the wallet, with exactly the ticked orders', async () => {
    parcels = [delivered('D1'), delivered('D2'), delivered('D3')];
    await draw();
    tick('D1', 'D3');
    press(/استلمت منه \(2\)/);
    expect((await screen.findByTestId('dialog-orders')).textContent).toBe('id-D1,id-D3');
    // Opening it records nothing: the dialog is where the wallet and the amount are named.
    expect(posts()).toEqual([]);
  });

  it('closing the dialog keeps the ticks; finishing it says what the door said, clears them and reads the page again', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await draw();
    tick('D1', 'D2');
    press(/استلمت منه \(2\)/);
    fireEvent.click(await screen.findByText('أغلق النافذة'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ticked()).toHaveLength(2);

    press(/استلمت منه \(2\)/);
    const before = gets().length;
    fireEvent.click(await screen.findByText('أتمّ الاستلام'));
    await screen.findByText('سُجِّل استلام المبلغ');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(ticked()).toEqual([]);
    await waitFor(() => expect(gets().length).toBe(before + 1));
  });
});

describe('taking the money — when the page moves under the dialog, or under the last answer', () => {
  it('finishing a collection also clears the reasons left by an earlier refused press', async () => {
    parcels = [parcel('M1'), delivered('D1')];
    refuse = { 'id-M1': 'سُجِّل تسليم هذا الطلب مسبقاً' };
    await draw();
    tick('M1');
    press(/تم تسليمها \(1\)/);
    await screen.findByText(/تعذّر تسجيل 1 طلب/);

    tick('D1');
    press(/استلمت منه \(1\)/);
    fireEvent.click(await screen.findByText('أتمّ الاستلام'));
    await screen.findByText('سُجِّل استلام المبلغ');
    expect(screen.queryByText(/تعذّر تسجيل/)).toBeNull();
  });

  it('a dialog does not outlive the parcels it was opened for: if somebody else took the money first, it is gone', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await draw();
    tick('D1', 'D2');
    press(/استلمت منه \(2\)/);
    await screen.findByRole('dialog');

    parcels = [delivered('D1', { settlementStatus: 'SETTLED' }), delivered('D2', { settlementStatus: 'SETTLED' })];
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('taking the money — the dialog is the choice it was opened for, and nothing else', () => {
  const openFor = async (...refs: string[]) => {
    await draw();
    tick(...refs);
    press(new RegExp(`استلمت منه \\(${refs.length}\\)`));
    await screen.findByRole('dialog');
  };
  const pageReadsAgain = async () => {
    const before = gets().length;
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(gets().length).toBe(before + 1));
  };

  it('if somebody else took one parcel’s money meanwhile, the dialog closes instead of keeping a total typed for the old set', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await openFor('D1', 'D2');
    parcels = [delivered('D1'), delivered('D2', { settlementStatus: 'SETTLED' })];
    await pageReadsAgain();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('and once closed that way it does not open itself on the next money choice — only the button opens it', async () => {
    parcels = [delivered('D1'), delivered('D2'), delivered('D3')];
    await openFor('D1', 'D2');
    parcels = [delivered('D1'), delivered('D2', { settlementStatus: 'SETTLED' }), delivered('D3')];
    await pageReadsAgain();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    tick('D3');
    expect(screen.queryByRole('dialog')).toBeNull();
    press(/استلمت منه \(2\)/);
    expect((await screen.findByTestId('dialog-orders')).textContent).toBe('id-D1,id-D3');
  });

  it('the same two parcels coming back in another order are still the same choice — the dialog stays', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await openFor('D1', 'D2');
    parcels = [delivered('D2'), delivered('D1')];
    await pageReadsAgain();
    await waitFor(() => expect(refOf(document.querySelector('tbody tr')!)).toBe('D2'));
    expect(screen.queryByRole('dialog')).not.toBeNull();
  });

  it('and if every parcel of it has gone back to being out for delivery, it is not a money choice any more', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await openFor('D1', 'D2');
    parcels = [parcel('D1', { shippingStatus: 'OUT_FOR_DELIVERY' }), parcel('D2', { shippingStatus: 'OUT_FOR_DELIVERY' })];
    await pageReadsAgain();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('taking the money — and the parcels stop being one courier’s under the dialog', () => {
  it('a dialog that said «منه» for one person closes when the page says they are two', async () => {
    parcels = [delivered('D1'), delivered('D2')];
    await draw();
    tick('D1', 'D2');
    press(/استلمت منه \(2\)/);
    await screen.findByRole('dialog');

    parcels = [delivered('D1'), delivered('D2', { deliveryProvider: { id: B, name: 'أمان', kind: 'COMPANY' } })];
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).toContain('جهة واحدة');
  });
});

describe('narrowing it', () => {
  it('choosing a courier asks for that courier from page one, and a new question starts a new selection', async () => {
    parcels = [parcel('M1'), parcel('M2', { deliveryProvider: { id: B, name: 'أمان', kind: 'COMPANY' } })];
    await draw();
    tick('M1');
    choose('جهة الشحن', B);
    await waitFor(() => expect(gets().at(-1)!.get('courier')).toBe(B));
    expect(gets().at(-1)!.get('page')).toBe('1');
    await waitFor(() => expect(box('M2')).not.toBeNull());
    expect(ticked()).toEqual([]);
  });

  it('and a question that leaves the ticked parcel on the screen still starts clean — the old ticks are not carried over', async () => {
    parcels = [parcel('M1'), parcel('M2', { deliveryProvider: { id: B, name: 'أمان', kind: 'COMPANY' } })];
    await draw();
    tick('M1');
    choose('جهة الشحن', A);
    await waitFor(() => expect(gets().at(-1)!.get('courier')).toBe(A));
    await waitFor(() => expect(deskRow('M2')).toBeUndefined());
    expect(deskRow('M1')).toBeDefined();
    expect(ticked()).toEqual([]);
  });

  it('«المسلَّم بانتظار التحصيل فقط» asks the door for the COLLECT task', async () => {
    parcels = [parcel('M1'), delivered('D1')];
    await draw();
    choose('ما أعرضه', 'COLLECT');
    await waitFor(() => expect(gets().at(-1)!.get('task')).toBe('COLLECT'));
    await waitFor(() => expect(deskRow('M1')).toBeUndefined());
    expect(deskRow('D1')).toBeDefined();
  });

  it('«الحالة» asks the door for THAT shipping status, from page one — and «كل الحالات المفتوحة» asks for none', async () => {
    parcels = [parcel('M1'), parcel('M2', { shippingStatus: 'OUT_FOR_DELIVERY' }), delivered('D1')];
    await draw();
    const options = within(screen.getByLabelText('الحالة')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['كل الحالات المفتوحة', 'مشحون', 'خرج للتوصيل', 'بانتظار الاستلام', 'فشل التوصيل', 'طلب إرجاع', 'مسلَّم', 'مسلَّم جزئياً']);
    choose('الحالة', 'OUT_FOR_DELIVERY');
    await waitFor(() => expect(gets().at(-1)!.get('status')).toBe('OUT_FOR_DELIVERY'));
    expect(gets().at(-1)!.get('page')).toBe('1');
    await waitFor(() => expect(deskRow('M1')).toBeUndefined());
    expect(deskRow('M2')).toBeDefined();
    choose('الحالة', 'all');
    await waitFor(() => expect(gets().at(-1)!.get('status')).toBeNull());
    await waitFor(() => expect(deskRow('M1')).toBeDefined());
  });

  it('«المنتج» lists the store’s products, and choosing one asks the door for it — and only its parcels stay', async () => {
    parcels = [parcel('M1', { productId: 'prod-cream' }), parcel('M2', { productId: 'prod-hoodie' })];
    await draw();
    await waitFor(() => expect(within(screen.getByLabelText('المنتج')).getAllByRole('option')).toHaveLength(3));
    expect(within(screen.getByLabelText('المنتج')).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'كل المنتجات', 'كريم الندبات', 'هودي بديل المازوت',
    ]);
    choose('المنتج', 'prod-hoodie');
    await waitFor(() => expect(gets().at(-1)!.get('product')).toBe('prod-hoodie'));
    await waitFor(() => expect(deskRow('M1')).toBeUndefined());
    expect(deskRow('M2')).toBeDefined();
  });

  it('a new status or product starts a new selection, and both ride together with the courier', async () => {
    parcels = [parcel('M1', { productId: 'prod-cream' }), parcel('M2', { productId: 'prod-hoodie' })];
    await draw();
    await waitFor(() => expect(within(screen.getByLabelText('المنتج')).getAllByRole('option')).toHaveLength(3));
    tick('M1');
    choose('الحالة', 'SHIPPED');
    await waitFor(() => expect(gets().at(-1)!.get('status')).toBe('SHIPPED'));
    expect(ticked()).toEqual([]);
    await waitFor(() => expect(box('M1')).not.toBeNull());
    tick('M1');
    choose('المنتج', 'prod-cream');
    await waitFor(() => expect(gets().at(-1)!.get('product')).toBe('prod-cream'));
    expect(ticked()).toEqual([]);
    choose('جهة الشحن', A);
    choose('الحالة', 'SHIPPED');
    await waitFor(() => {
      const last = gets().at(-1)!;
      expect([last.get('courier'), last.get('status'), last.get('product')]).toEqual([A, 'SHIPPED', 'prod-cream']);
    });
  });

  it('«إعادة تعيين» puts the status and the product back too — and counts them while they are chosen', async () => {
    parcels = [parcel('M1', { productId: 'prod-cream' }), parcel('M2', { productId: 'prod-hoodie' })];
    await draw();
    await waitFor(() => expect(within(screen.getByLabelText('المنتج')).getAllByRole('option')).toHaveLength(3));
    choose('الحالة', 'SHIPPED');
    choose('المنتج', 'prod-cream');
    await waitFor(() => expect(gets().at(-1)!.get('product')).toBe('prod-cream'));
    fireEvent.click(screen.getByRole('button', { name: 'إعادة تعيين (2)' }));
    await waitFor(() => expect(gets().at(-1)!.get('product')).toBeNull());
    expect(gets().at(-1)!.get('status')).toBeNull();
    expect((screen.getByLabelText('الحالة') as HTMLSelectElement).value).toBe('all');
    expect((screen.getByLabelText('المنتج') as HTMLSelectElement).value).toBe('all');
  });

  it('a typed word is the door’s `q`', async () => {
    await draw();
    fireEvent.change(screen.getByLabelText('بحث'), { target: { value: 'M2' } });
    await waitFor(() => expect(gets().at(-1)!.get('q')).toBe('M2'));
    await waitFor(() => expect(deskRow('M1')).toBeUndefined());
    expect(deskRow('M2')).toBeDefined();
  });

  it('nothing open says so, with a way out', async () => {
    parcels = [];
    render(<ManualMatching />);
    expect(await screen.findByText('لا طلبات مفتوحة تطابق اختيارك')).toBeTruthy();
  });

  it('a second page is the pager’s, keeps the choices and drops the ticks', async () => {
    parcels = Array.from({ length: 120 }, (_, i) => parcel(`P${String(i + 1).padStart(3, '0')}`));
    await draw();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    // With a second page «all» would be a lie: it is all of THIS page, and the button says so.
    expect(screen.getByRole('button', { name: /اختر كل ما بانتظار التسليم \(50\) في هذه الصفحة$/ })).toBeTruthy();
    tick('P001');
    fireEvent.click(screen.getByRole('button', { name: /التالي/ }));
    await waitFor(() => expect(gets().at(-1)!.get('page')).toBe('2'));
    await waitFor(() => expect(deskRow('P051')).toBeDefined());
    expect(ticked()).toEqual([]);
    // … and coming back to the first page finds it as it would find a new one: nothing ticked.
    fireEvent.click(screen.getByRole('button', { name: /السابق/ }));
    await waitFor(() => expect(gets().at(-1)!.get('page')).toBe('1'));
    await waitFor(() => expect(deskRow('P001')).toBeDefined());
    expect(ticked()).toEqual([]);
  });
});

describe('the two pure questions', () => {
  const row = (over: Record<string, unknown> = {}) => parcel('X', over) as Parameters<typeof stepFor>[0] & Parameters<typeof readChoice>[0][number];

  it('stepFor: the door’s two statuses deliver, the follow-up’s predicate collects, the rest are nobody’s here', () => {
    expect(stepFor(row({ shippingStatus: 'SHIPPED' }))).toBe('DELIVER');
    expect(stepFor(row({ shippingStatus: 'OUT_FOR_DELIVERY' }))).toBe('DELIVER');
    expect(stepFor(row({ shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED' }))).toBe('COLLECT');
    expect(stepFor(row({ shippingStatus: 'PARTIALLY_DELIVERED', settlementStatus: 'UNSETTLED' }))).toBe('COLLECT');
    expect(stepFor(row({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' }))).toBeNull();
    for (const s of ['READY_FOR_PICKUP', 'FAILED_DELIVERY', 'RETURN_REQUESTED', 'RETURNED', 'CANCELLED', 'PENDING']) {
      expect(stepFor(row({ shippingStatus: s })), s).toBeNull();
    }
  });

  it('stepFor: «cancelled while it travels» stops the DELIVER, whether or not anyone has seen the alert', () => {
    for (const acknowledged of [false, true]) {
      expect(stepFor(row({ alert: { kind: 'CANCELLED', at: 'x', acknowledged } }))).toBeNull();
    }
    expect(stepFor(row({ alert: { kind: 'CHANGED', at: 'x', acknowledged: false } }))).toBe('DELIVER');
  });

  it('readChoice: nothing → nothing; one kind → its step; two kinds → a sentence', () => {
    expect(readChoice([])).toEqual({ step: null, problem: null });
    expect(readChoice([row(), row()])).toEqual({ step: 'DELIVER', problem: null });
    const money = { shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED' };
    expect(readChoice([row(money), row(money)])).toEqual({ step: 'COLLECT', problem: null });
    const mixed = readChoice([row(), row(money)]);
    expect(mixed.step).toBeNull();
    expect(mixed.problem).toMatch(/نوعاً واحداً/);
  });

  it('readChoice: money needs one courier and one currency; an outcome needs neither', () => {
    const money = { shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED' };
    const other = { deliveryProvider: { id: B, name: 'أمان' } };
    expect(readChoice([row(money), row({ ...money, ...other })]).problem).toMatch(/جهة واحدة/);
    expect(readChoice([row(money), row({ ...money, currency: 'USD' })]).problem).toMatch(/عملة/);
    expect(readChoice([row(), row(other)])).toEqual({ step: 'DELIVER', problem: null });
    // A parcel with no company at all is a courier of its own: never merged into a named one …
    expect(readChoice([row(money), row({ ...money, deliveryProvider: null })]).problem).toMatch(/جهة واحدة/);
    // … and two of them are the SAME «nobody», not two different ones.
    const nobody = { ...money, deliveryProvider: null };
    expect(readChoice([row({ ...nobody, id: 'a' }), row({ ...nobody, id: 'b' })])).toEqual({ step: 'COLLECT', problem: null });
  });
});

describe('what this screen is allowed to be', () => {
  const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/finance/ManualMatching.tsx'), 'utf8'));

  it('reads the follow-up door and writes only the delivery door — the money goes through the dialog that owns it', () => {
    expect([...src.matchAll(/['"`](\/api\/[^'"`?]*)/g)].map((m) => m[1]).sort()).toEqual([
      '/api/ops/tracking',
      '/api/ops/tracking/deliver',
    ]);
    expect(src).toMatch(/import \{ CollectDialog \} from '@\/components\/screens\/tracking\/CollectDialog'/);
    expect(src).not.toMatch(/\/collect|\/api\/finance|recordMovement|walletId/);
  });

  it('goes through apiJson — never a bare fetch', () => {
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).toMatch(/apiJson\(/);
  });

  it('holds no arithmetic on a figure: it shows the server’s expectedCollection and sums nothing', () => {
    expect(src).not.toMatch(/\.reduce\(/);
    expect(src).not.toMatch(/expectedCollection[^\n]*[-+*/]\s|[-+*/]\s*Number\([^)]*expectedCollection/);
  });
});

describe('where it lives: the matching screen', () => {
  const statements = () => api.mock.calls.filter((c) => c[0] === '/api/finance/statements');

  it('somebody who cannot follow a parcel sees the screen exactly as it was — no tabs, the statement picker', async () => {
    user.current = OFFICER;
    render(<MatchingScreen queuesStartOpen />);
    expect(await screen.findByLabelText('الكشف')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText('يدوي — بلا كشف')).toBeNull();
    expect(gets()).toHaveLength(0);
  });

  it('somebody who can sees both halves named before any click, on the statement half', async () => {
    render(<MatchingScreen queuesStartOpen />);
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['بكشف من الشركة', 'يدوي — بلا كشف']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByLabelText('الكشف')).toBeTruthy();
    expect(statements().length).toBeGreaterThan(0);
    // The manual half has not even asked for its list: it is not on screen.
    expect(gets()).toHaveLength(0);
  });

  it('«يدوي — بلا كشف» swaps the statement picker for the manual panel, and back', async () => {
    render(<MatchingScreen queuesStartOpen />);
    fireEvent.click(await screen.findByRole('tab', { name: 'يدوي — بلا كشف' }));
    expect(await screen.findByLabelText('جهة الشحن')).toBeTruthy();
    expect(screen.queryByLabelText('الكشف')).toBeNull();
    expect(document.body.textContent).toContain('مطابقة يدوية');
    fireEvent.click(screen.getByRole('tab', { name: 'بكشف من الشركة' }));
    expect(await screen.findByLabelText('الكشف')).toBeTruthy();
    expect(screen.queryByLabelText('جهة الشحن')).toBeNull();
  });

  it('`?mode=manual` — what the pointers carry — opens on the manual half', async () => {
    search.value = 'mode=manual';
    render(<MatchingScreen queuesStartOpen />);
    expect(await screen.findByLabelText('جهة الشحن')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'يدوي — بلا كشف' }).getAttribute('aria-selected')).toBe('true');
  });

  it('and `?mode=manual` for somebody who cannot follow a parcel changes nothing — the door would refuse them', async () => {
    search.value = 'mode=manual';
    user.current = OFFICER;
    render(<MatchingScreen queuesStartOpen />);
    expect(await screen.findByLabelText('الكشف')).toBeTruthy();
    expect(gets()).toHaveLength(0);
  });
});

describe('where it is pointed to: the statements screen', () => {
  const pointer = () => screen.queryByRole('link', { name: /يدوي — بلا كشف/ });

  it('says, to somebody who may use it, that a company with no statement needs nothing imported — and links to the tab', async () => {
    render(<CollectionScreen />);
    await screen.findByText('لا توجد كشوف مستوردة بعد.');
    const link = pointer();
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/finance/matching?mode=manual');
  });

  it('draws nothing for somebody who cannot follow a parcel — a link is a promise it can keep', async () => {
    user.current = OFFICER;
    render(<CollectionScreen />);
    await screen.findByText('لا توجد كشوف مستوردة بعد.');
    expect(pointer()).toBeNull();
  });

  it('nor for somebody who can follow a parcel but may not open the matching screen', async () => {
    user.current = { id: 'u4', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.track', 'settlement.upload', 'settlement.view'] };
    render(<CollectionScreen />);
    await screen.findByText('لا توجد كشوف مستوردة بعد.');
    expect(pointer()).toBeNull();
  });
});
