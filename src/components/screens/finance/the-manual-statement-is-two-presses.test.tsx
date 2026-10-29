// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * THE MANUAL STATEMENT, AS A PERSON MEETS IT: two presses on two screens.
 *
 *   «مطابق يدوي»  on the manual matching screen, beside «استلمت منه», for the delivered parcels ticked.
 *   «تجميع»        on the collection screen, on the draft that press made.
 *
 * What these tests hold: the first press is offered only to somebody who may make a statement and only for ONE
 * courier's money; a field left empty is sent as «the expected amount» (the screen computes nothing); the second
 * press is on the draft and nowhere else; a draft offers no receipt, no matching and no approval; and a rate typed
 * on a receipt in another currency shows what it is worth in the statement's own.
 */

const { api, fetchApi, confirm, user, dialog } = vi.hoisted(() => ({
  api: vi.fn(),
  fetchApi: vi.fn(),
  confirm: vi.fn(),
  user: { current: null as unknown },
  dialog: { props: null as null | { orders: { id: string }[]; onClose: () => void; onDone: (m: string) => void } },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: (...a: unknown[]) => fetchApi(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/finance/matching',
}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المطابقة</h1> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirm, useAsk: () => async () => null }));
vi.mock('@/components/screens/tracking/CollectDialog', () => ({
  CollectDialog: (p: { orders: { id: string }[]; onClose: () => void; onDone: (m: string) => void }) => {
    dialog.props = p;
    return <div role="dialog" aria-label="استلام المبلغ" />;
  },
}));

import { ManualMatching } from './ManualMatching';
import { CollectionScreen } from './CollectionScreen';
import { addedSentence } from './ManualStatementDialog';
import { StoreCurrencyProvider } from '@/context/StoreCurrency';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const GATHERER = { id: 'u1', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.track', 'finance.cashbox', 'settlement.upload'] };
const CASHIER = { id: 'u2', status: 'ACTIVE', role: 'MANAGER', permissions: ['ops.track', 'finance.cashbox'] };

const parcel = (ref: string, over: Record<string, unknown> = {}) => ({
  id: `id-${ref}`, orderNumber: `ORD-${ref}`, merchantRef: ref, trackingNumber: null,
  shippingStatus: 'DELIVERED', settlementStatus: 'UNSETTLED', daysInTransit: 1, late: false,
  totalAmount: 40, currency: 'JOD', customer: { fullName: `زبون ${ref}`, phone: '0790000000', city: 'عمّان' },
  deliveryProvider: { id: A, name: 'أبو علي', kind: 'AGENT' }, expectedCollection: 17.5, alert: null, ...over,
});

const FACTS = {
  total: 3,
  tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 3 },
  lateCount: 0,
  couriers: [{ id: A, name: 'أبو علي', count: 3 }, { id: B, name: 'أمان', count: 1 }],
  regions: [], ages: { fresh: 0, few: 0, week: 0, old: 0 },
};

let parcels: ReturnType<typeof parcel>[];
let statements: Record<string, unknown>[];
let wallets: { id: string; name: string; currencyCode: string }[];
const posts = () =>
  api.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST')
    .map((c) => ({ url: c[0] as string, body: JSON.parse(String((c[1] as RequestInit).body)) }));

beforeEach(() => {
  vi.clearAllMocks();
  user.current = GATHERER;
  dialog.props = null;
  confirm.mockResolvedValue(true);
  parcels = [parcel('M1'), parcel('M2'), parcel('M3', { deliveryProvider: { id: B, name: 'أمان', kind: 'COMPANY' } })];
  statements = [];
  wallets = [];
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = new URL(url, 'http://x');
    if (init?.method === 'POST' && u.pathname === '/api/finance/statements/manual') {
      return { statementId: 's1', courier: 'أبو علي', currencyCode: 'JOD', created: true, added: 2, updated: 0, lines: 2, total: 35 };
    }
    if (init?.method === 'POST' || init?.method === 'DELETE') return { ok: true };
    if (u.pathname === '/api/finance/statements') return { statements };
    if (u.pathname === '/api/ops/references') return { providers: [] };
    if (u.pathname === '/api/finance/wallets') return { wallets };
    if (u.pathname === '/api/products') return { products: [] };
    let list = parcels;
    if (u.searchParams.get('courier')) list = list.filter((p) => p.deliveryProvider?.id === u.searchParams.get('courier'));
    return { orders: list, pagination: { total: list.length, page: 1, limit: 50, totalPages: 1 }, facts: FACTS };
  });
});
afterEach(cleanup);

/* ───────────────────────── press 1, on the manual matching screen ───────────────────────── */

const refOf = (tr: Element) =>
  [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').match(/^[A-Z0-9]+/)?.[0]).find(Boolean);
const box = (ref: string) =>
  ([...document.querySelectorAll('tbody tr')].find((tr) => refOf(tr) === ref) as HTMLElement | undefined)?.querySelector(
    'input[type="checkbox"]'
  ) as HTMLInputElement;
const drawMatching = async () => {
  render(<ManualMatching />);
  await screen.findByLabelText('جهة الشحن');
  await waitFor(() => expect(document.querySelector('tbody tr')).not.toBeNull());
};

describe('«مطابق يدوي» beside «استلمت منه»', () => {
  it('both are offered for the delivered parcels ticked, to somebody who may make a statement', async () => {
    await drawMatching();
    fireEvent.click(box('M1'));
    fireEvent.click(box('M2'));
    expect(screen.getByRole('button', { name: /مطابق يدوي \(2\)/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /استلمت منه \(2\)/ })).toBeTruthy();
  });

  it('NEGATIVE: somebody who may take cash but not make a statement is offered «استلمت منه» only', async () => {
    user.current = CASHIER;
    await drawMatching();
    fireEvent.click(box('M1'));
    expect(screen.getByRole('button', { name: /استلمت منه \(1\)/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /مطابق يدوي/ })).toBeNull();
  });

  it('two couriers ticked: neither money button is drawn, and the screen says one courier at a time', async () => {
    await drawMatching();
    fireEvent.click(box('M1'));
    fireEvent.click(box('M3'));
    expect(screen.queryByRole('button', { name: /مطابق يدوي/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /استلمت منه/ })).toBeNull();
    expect(screen.getByText(/جهة واحدة/)).toBeTruthy();
  });

  it('the screen tells the owner which of the two to use, before any click', async () => {
    await drawMatching();
    const text = document.body.textContent ?? '';
    expect(text).toContain('لنقد بعملة الطلب نفسها إلى محفظة فعّالة');
    expect(text).toContain('عملة ثانية');
    expect(text).toContain('سعر صرف');
    expect(text).toContain('تجميع');
  });
});

describe('the dialog of the first press', () => {
  const open = async () => {
    await drawMatching();
    fireEvent.click(box('M1'));
    fireEvent.click(box('M2'));
    fireEvent.click(screen.getByRole('button', { name: /مطابق يدوي \(2\)/ }));
    return await screen.findByRole('dialog');
  };

  it('lists the ticked orders, each with the expected amount as its placeholder — nothing is computed here', async () => {
    const d = await open();
    expect(within(d).getByText(/ORD-M1/)).toBeTruthy();
    expect(within(d).getByText(/ORD-M2/)).toBeTruthy();
    const fields = within(d).getAllByRole('spinbutton') as HTMLInputElement[];
    expect(fields).toHaveLength(2);
    expect(fields.map((f) => f.placeholder)).toEqual(['17.5', '17.5']);
    expect(fields.map((f) => f.value)).toEqual(['', '']);
    // …and it says, in its own words, the line about the currency.
    expect(d.textContent).toContain('أيّ عملة ثانية أو سعر صرف');
  });

  it('sends a field left empty as «the expected amount» (no amount at all), and a typed one as typed', async () => {
    const d = await open();
    const [, second] = within(d).getAllByRole('spinbutton');
    fireEvent.change(second, { target: { value: '15.5' } });
    fireEvent.click(within(d).getByRole('button', { name: 'أضف إلى المسوّدة' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/finance/statements/manual');
    expect(posts()[0].body).toEqual({ orders: [{ orderId: 'id-M1' }, { orderId: 'id-M2', amount: 15.5 }] });
  });

  it('on success the dialog closes, the selection is cleared, and the screen says what happened and what comes next', async () => {
    const d = await open();
    fireEvent.click(within(d).getByRole('button', { name: 'أضف إلى المسوّدة' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const said = await screen.findByText(/أُضيف 2 طلب إلى مسوّدة كشف أبو علي/);
    expect(said.textContent).toContain('35 JOD');
    expect(said.textContent).toContain('تجميع');
    expect(said.textContent).toContain('«التحصيل والكشوف»');
    expect(box('M1').checked).toBe(false);
  });

  it('a refusal stays in the dialog, in the door’s words, and the orders stay ticked', async () => {
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('طلبات بلا شركة شحن: ORD-M2');
      return base(url, init);
    });
    const d = await open();
    fireEvent.click(within(d).getByRole('button', { name: 'أضف إلى المسوّدة' }));
    expect(await within(d).findByText('طلبات بلا شركة شحن: ORD-M2')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('the sentence it says: how many were added, how many were already there, the total, the next step', () => {
    const base = { statementId: 's', courier: 'الباشا', currencyCode: 'JOD', created: false, lines: 5, total: 87.5 };
    expect(addedSentence({ ...base, added: 3, updated: 0 })).toContain('أُضيف 3 طلب إلى مسوّدة كشف الباشا');
    expect(addedSentence({ ...base, added: 3, updated: 0 })).toContain('في المسوّدة الآن 5 طلب بإجمالي 87.5 JOD');
    expect(addedSentence({ ...base, added: 1, updated: 2 })).toContain('وعُدِّل 2 موجود فيها');
    expect(addedSentence({ ...base, added: 1, updated: 0 })).not.toContain('وعُدِّل');
  });
});

/* ───────────────────────── press 2, on the collection screen ───────────────────────── */

const gap = { claimed: 35, received: 0, gap: -35, needsExplanation: true, explained: false, unconvertible: 0 };
const statement = (over: Record<string, unknown> = {}) => ({
  id: 's1', reference: 'مسوّدة كشف يدوي', fileName: 'كشف يدوي', status: 'IMPORTED', approvedAt: null, manual: true, draft: true,
  currencyCode: 'JOD', totalAmount: 35, createdAt: '2026-10-29T00:00:00Z', periodFrom: null, periodTo: null,
  counts: { lines: 2, receipts: 0, matches: 0 }, receipts: [], gap, ...over,
});

describe('«تجميع» — on the draft and nowhere else', () => {
  it('a draft is called a draft, and offers «تجميع» and «حذف المسوّدة» — no receipt, no matching, no approval', async () => {
    statements = [statement()];
    render(<CollectionScreen />);
    expect((await screen.findAllByText('مسوّدة')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'تجميع' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'حذف المسوّدة' }).length).toBeGreaterThan(0);
    for (const name of ['إيصال استلام', 'مطابقة', 'اعتماد', 'إلغاء الاستيراد']) {
      expect(screen.queryByRole('button', { name }), name).toBeNull();
    }
  });

  it('a gathered manual statement is an ordinary statement: receipt, matching and approval, and no «تجميع»', async () => {
    statements = [statement({ draft: false, reference: 'كشف الأحد', status: 'RECEIPTED', counts: { lines: 2, receipts: 1, matches: 0 },
      receipts: [{ id: 'r1', amount: 35, currencyCode: 'JOD', receivedAt: '2026-10-29T09:00:00Z', note: null, wallet: 'الصندوق', proof: null }] })];
    render(<CollectionScreen />);
    await screen.findAllByText('كشف الأحد');
    for (const name of ['إيصال استلام', 'مطابقة', 'اعتماد', 'إلغاء الاستيراد']) {
      expect(screen.getAllByRole('button', { name }).length, name).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('button', { name: 'تجميع' })).toBeNull();
  });

  it('a file statement is untouched by all of this', async () => {
    statements = [statement({ manual: false, draft: false, reference: 'ST-1', fileName: 'x.xlsx' })];
    render(<CollectionScreen />);
    await screen.findAllByText('ST-1');
    expect(screen.queryByRole('button', { name: 'تجميع' })).toBeNull();
    expect(screen.queryByText('مسوّدة')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'إلغاء الاستيراد' }).length).toBeGreaterThan(0);
  });

  it('«تجميع» asks for a reference and a period, shows the draft’s count and total, and sends them to THIS draft', async () => {
    statements = [statement()];
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'تجميع' }))[0]);
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toContain('في المسوّدة 2 طلب بإجمالي');
    expect(d.textContent).toContain('35');

    // No reference yet: the button waits.
    expect((within(d).getByRole('button', { name: 'تجميع' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(d).getByLabelText('مرجع الكشف'), { target: { value: '  كشف الأحد ' } });
    fireEvent.change(within(d).getByLabelText('من تاريخ (اختياري)'), { target: { value: '2026-10-01' } });
    fireEvent.change(within(d).getByLabelText('إلى تاريخ (اختياري)'), { target: { value: '2026-10-07' } });
    fireEvent.click(within(d).getByRole('button', { name: 'تجميع' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    const sent = posts()[0];
    expect(sent.url).toBe('/api/finance/statements/s1/assemble');
    expect(sent.body.reference).toBe('كشف الأحد');
    expect(new Date(sent.body.periodFrom).getTime()).toBe(new Date('2026-10-01T00:00:00').getTime());
    expect(new Date(sent.body.periodTo).getTime()).toBe(new Date('2026-10-07T23:59:59').getTime());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await screen.findAllByText(/جُمِّع الكشف «كشف الأحد»/)).length).toBeGreaterThan(0);
  });

  it('a period is not required', async () => {
    statements = [statement()];
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'تجميع' }))[0]);
    const d = await screen.findByRole('dialog');
    fireEvent.change(within(d).getByLabelText('مرجع الكشف'), { target: { value: 'ST-9' } });
    fireEvent.click(within(d).getByRole('button', { name: 'تجميع' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].body).toEqual({ reference: 'ST-9' });
  });

  it('a refusal (the reference is used) stays in the dialog in the door’s words', async () => {
    statements = [statement()];
    const base = api.getMockImplementation()!;
    api.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') throw new Error('المرجع «ST-9» مستعمل لهذه الشركة في كشف يدوي آخر — اختر مرجعاً مختلفاً');
      return base(url, init);
    });
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'تجميع' }))[0]);
    const d = await screen.findByRole('dialog');
    fireEvent.change(within(d).getByLabelText('مرجع الكشف'), { target: { value: 'ST-9' } });
    fireEvent.click(within(d).getByRole('button', { name: 'تجميع' }));
    expect(await within(d).findByText(/مستعمل لهذه الشركة/)).toBeTruthy();
  });

  it('deleting a draft asks first, in its own words, and calls the delete door', async () => {
    statements = [statement()];
    render(<CollectionScreen />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'حذف المسوّدة' }))[0]);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].title).toBe('حذف مسوّدة الكشف اليدوي؟');
    expect(confirm.mock.calls[0][0].tone).toBe('danger');
    await waitFor(() => expect(api.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true));
    expect(api.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')![0]).toBe('/api/finance/statements/s1');
  });

});

/* ───────────────────────── the receipt, in another currency ───────────────────────── */

describe('a receipt in another currency shows what it is worth, and the rate has a floor', () => {
  const open = async () => {
    wallets = [{ id: 'w-usd', name: 'دولار', currencyCode: 'USD' }, { id: 'w-jod', name: 'الصندوق', currencyCode: 'JOD' }];
    statements = [statement({ draft: false, reference: 'كشف الأحد', status: 'IMPORTED' })];
    // As in the shell: the store is a dinar store, so a dinar figure is drawn to the fils.
    render(
      <StoreCurrencyProvider code="JOD">
        <CollectionScreen />
      </StoreCurrencyProvider>
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'إيصال استلام' }))[0]);
    return await screen.findByRole('dialog');
  };

  it('the same currency asks for no rate and shows no conversion', async () => {
    const d = await open();
    fireEvent.change(within(d).getByLabelText('المحفظة التي وصل إليها المبلغ'), { target: { value: 'w-jod' } });
    expect(within(d).queryByLabelText(/سعر الصرف/)).toBeNull();
    expect(d.textContent).not.toContain('بعملة الكشف');
  });

  it('another currency asks for the rate, whose floor is 0.000001, and says what the receipt is worth in the statement’s currency', async () => {
    const d = await open();
    fireEvent.change(within(d).getByLabelText('المحفظة التي وصل إليها المبلغ'), { target: { value: 'w-usd' } });
    const rate = within(d).getByLabelText(/سعر الصرف/) as HTMLInputElement;
    expect(rate.min).toBe('0.000001');
    expect(rate.step).toBe('0.000001');
    expect(d.textContent).not.toContain('بعملة الكشف');

    fireEvent.change(within(d).getByLabelText('المبلغ الواصل'), { target: { value: '49.35' } });
    fireEvent.change(rate, { target: { value: '1.41' } });
    // 49.35 of the wallet's currency, at 1.41 per dinar, is 35.000 dinars of the statement's.
    expect(d.textContent).toMatch(/يساوي\s*35\.000 JOD\s*بعملة الكشف/);
  });

  it('and a rate typed upside down shows the absurd figure BEFORE saving, which is the point of showing it', async () => {
    const d = await open();
    fireEvent.change(within(d).getByLabelText('المحفظة التي وصل إليها المبلغ'), { target: { value: 'w-usd' } });
    fireEvent.change(within(d).getByLabelText('المبلغ الواصل'), { target: { value: '49.35' } });
    fireEvent.change(within(d).getByLabelText(/سعر الصرف/), { target: { value: '0.709' } });
    expect(d.textContent).toMatch(/يساوي\s*69\.605 JOD/);
  });

  it('sends the rate with the receipt as typed', async () => {
    const d = await open();
    fireEvent.change(within(d).getByLabelText('المحفظة التي وصل إليها المبلغ'), { target: { value: 'w-usd' } });
    fireEvent.change(within(d).getByLabelText('المبلغ الواصل'), { target: { value: '49.35' } });
    fireEvent.change(within(d).getByLabelText(/سعر الصرف/), { target: { value: '0.000001' } });
    fireEvent.click(within(d).getByRole('button', { name: 'حفظ الإيصال' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0].url).toBe('/api/finance/statements/s1/receipts');
    expect(posts()[0].body).toMatchObject({ walletId: 'w-usd', amount: 49.35, exchangeRate: 0.000001 });
  });
});

describe('what these two dialogs are allowed to be', () => {
  const read = (rel: string) => stripComments(readFileSync(join(process.cwd(), rel), 'utf8'));

  it('the manual matching screen itself still writes only the delivery door — the new door is the dialog’s', () => {
    const src = read('src/components/screens/finance/ManualMatching.tsx');
    expect([...src.matchAll(/['"`](\/api\/[^'"`?]*)/g)].map((m) => m[1]).sort()).toEqual(['/api/ops/tracking', '/api/ops/tracking/deliver']);
    expect(src).toMatch(/import \{ ManualStatementDialog \} from '@\/components\/screens\/finance\/ManualStatementDialog'/);
  });

  it('the first press’s dialog goes through apiJson, calls one door, and holds no arithmetic', () => {
    const src = read('src/components/screens/finance/ManualStatementDialog.tsx');
    expect([...src.matchAll(/['"`](\/api\/[^'"`?]*)/g)].map((m) => m[1])).toEqual(['/api/finance/statements/manual']);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).not.toMatch(/\.reduce\(|toFixed\(|expectedCollection[^\n]*[-+*/]\s/);
    expect(src).not.toMatch(/walletId|recordMovement/);
  });

  it('the second press’s dialog calls only the assemble door of the draft it was given', () => {
    const src = read('src/components/screens/finance/AssembleStatementDialog.tsx');
    expect([...src.matchAll(/`(\/api\/[^`]*)`/g)].map((m) => m[1])).toEqual(['/api/finance/statements/${statement.id}/assemble']);
    expect(src).not.toMatch(/\bfetch\(/);
  });
});
