// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { arDateTime } from '@/lib/format';

/**
 * «ما في زر زي العين يعرضلك التفاصيل والملاحظات وتاريخ الحركة الحقيقي … المفروض تاريخ الحركة وتاريخ التسجيل برّا وجوّا» (22/11).
 *
 * Both lists — a wallet's movements and «آخر التحويلات» — show the REAL date on the row, and «سُجّلت …» smaller under it only when
 * the door says the registration fell on another day of the store. Each row has an eye (the kit's IconButton) that opens a
 * read-only panel: both dates, who registered it, the money, the full note, what wrote it, and its reversal. And both entry forms
 * carry «تاريخ الحركة الفعلي», which is sent to the door as an ISO moment.
 *
 * `Rows` draws BOTH the desk table and a card per row into the DOM — so each query below says which one it asks.
 */

const { api, who } = vi.hoisted(() => ({ api: vi.fn(), who: { keys: [] as string[] } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/wallets',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: who.keys } }),
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useAsk: () => async () => null, useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => true }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => false }));

import { WalletsScreen } from './WalletsScreen';
import { TransfersScreen } from './TransfersScreen';

const REAL = '2026-11-19T14:00:00.000Z';
const REGISTERED = '2026-11-20T08:00:00.000Z';

const WALLET = {
  id: 'w1', name: 'بينانس', currencyCode: 'USDT', isActive: true, opening: 0, in: 60, out: 0, balance: 60,
  movements: 2, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};
const move = (over: Record<string, unknown>) => ({
  direction: 'IN', party: 'x', category: 'OTHER', isReversal: false, wasReversed: false, reversalReason: null,
  referenceType: null, referenceId: null, reversalOf: null, reversedBy: null, createdByName: 'سلوى', ...over,
});
/** Happened on the 19th, registered on the 20th, and reversed since. */
const LATE = move({
  id: 'm-late', amount: 50, party: 'تحويل من شام كاش', category: 'TRANSFER_IN', note: 'الملاحظة كاملة: تصريف يوم الخميس',
  referenceType: 'TRANSFER', referenceId: 't-77', createdAt: REGISTERED, realDate: REAL, registeredOnAnotherDay: true,
  wasReversed: true, reversedBy: { id: 'm-rev', reversalReason: 'انسجّل مرتين', createdAt: '2026-11-20T09:00:00.000Z' },
});
/** No real date typed: the door answers the registration as the real date. */
const PLAIN = move({
  id: 'm-plain', amount: 10, note: 'ملاحظة يدوية', createdAt: '2026-11-20T07:00:00.000Z', realDate: '2026-11-20T07:00:00.000Z',
  registeredOnAnotherDay: false,
});

const end = (id: string, name: string, currencyCode: string) => ({ id, name, currencyCode, store: { name: 'متجر دمشق' }, imageKey: null, iconKey: null, colorKey: null });
const TRANSFER = {
  id: 't-77', amountOut: 663958, amountIn: 4501.41, exchangeRate: 0.00678, note: 'تصريف ليرة لدولار', createdAt: REGISTERED,
  realDate: REAL, registeredOnAnotherDay: true, createdByName: 'احمد', kindLabel: 'تصريف عملة',
  from: end('w-sham', 'شام كاش', 'SYP'), to: end('w1', 'بينانس', 'USDT'), state: 'ACTIVE', reversedWalletIds: [], reversal: null,
};
const SAME_DAY = { ...TRANSFER, id: 't-78', note: 'تحويل بنفس اليوم', realDate: REGISTERED, registeredOnAnotherDay: false };

const tw = (id: string, name: string, currencyCode: string) => ({
  id, name, currencyCode, isActive: true, balance: 0, countryId: 'SY', storeId: 's1', store: { id: 's1', name: 'متجر دمشق' },
  country: { id: 'SY', name: 'سوريا', minorUnit: 2 }, imageKey: null, iconKey: null, colorKey: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  who.keys = ['finance.cashbox_view', 'finance.cashbox'];
  api.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return {};
    const u = String(url);
    if (u.includes('/movements')) return { movements: [PLAIN, LATE] };
    if (u.startsWith('/api/finance/transfers')) return { transfers: [TRANSFER, SAME_DAY] };
    if (u.startsWith('/api/finance/wallets?scope=transfer')) return { wallets: [tw('w-sham', 'شام كاش', 'USDT'), tw('w1', 'بينانس', 'USDT')] };
    if (u.startsWith('/api/finance/wallets')) return { wallets: [WALLET] };
    return {};
  });
});
afterEach(cleanup);

const tableRow = async (text: string) => (await screen.findAllByText(text))[0].closest('tr') as HTMLElement;

describe('a wallet\'s movements', () => {
  it('the row shows the REAL date, and «سُجّلت …» under it when registered on another day', async () => {
    render(<WalletsScreen />);
    const row = within(await tableRow('الملاحظة كاملة: تصريف يوم الخميس'));
    expect(row.getByText(arDateTime(REAL), { exact: false })).toBeTruthy();
    expect(row.getByText(`سُجّلت ${arDateTime(REGISTERED)}`)).toBeTruthy();
  });

  it('a row with no real date shows its registration, and no second date', async () => {
    render(<WalletsScreen />);
    const row = within(await tableRow('ملاحظة يدوية'));
    expect(row.getByText(arDateTime('2026-11-20T07:00:00.000Z'))).toBeTruthy();
    expect(row.queryByText(/سُجّلت/)).toBeNull();
  });

  it('the eye opens a read-only panel: both dates, who, the money, the full note, what wrote it, and the reversal', async () => {
    render(<WalletsScreen />);
    const row = within(await tableRow('الملاحظة كاملة: تصريف يوم الخميس'));
    fireEvent.click(row.getByRole('button', { name: 'تفاصيل الحركة' }));
    const panel = within(await screen.findByRole('dialog', { name: 'تفاصيل الحركة' }));
    expect(panel.getByText('تاريخ الحركة الفعلي')).toBeTruthy();
    expect(panel.getByText(arDateTime(REAL))).toBeTruthy();
    expect(panel.getByText('تاريخ التسجيل')).toBeTruthy();
    expect(panel.getByText(arDateTime(REGISTERED))).toBeTruthy();
    expect(panel.getByText('سلوى')).toBeTruthy();
    expect(panel.getByText('الملاحظة كاملة: تصريف يوم الخميس')).toBeTruthy();
    expect(panel.getByText('تحويل بين المحافظ')).toBeTruthy();
    expect(panel.getByText('t-77')).toBeTruthy();
    expect(panel.getByText('السبب: انسجّل مرتين')).toBeTruthy();
    // Read-only: nothing in it records, reverses or edits.
    expect(panel.queryByRole('textbox')).toBeNull();
    expect(panel.queryByRole('button', { name: /قيد عكسي|تسجيل|احفظ/ })).toBeNull();
  });

  it('the eye is there for a person who may only look (the list\'s own key), and «قيد عكسي» is not', async () => {
    who.keys = ['finance.cashbox_view'];
    render(<WalletsScreen />);
    const row = within(await tableRow('ملاحظة يدوية'));
    expect(row.getByRole('button', { name: 'تفاصيل الحركة' })).toBeTruthy();
    expect(row.queryByRole('button', { name: /قيد عكسي/ })).toBeNull();
  });

  it('«حركة جديدة» carries «تاريخ الحركة الفعلي» (now, never later) and sends what was typed', async () => {
    render(<WalletsScreen />);
    await tableRow('ملاحظة يدوية');
    fireEvent.click(screen.getAllByRole('button', { name: /حركة جديدة/ })[0]);
    const dialog = within(await screen.findByRole('dialog', { name: /حركة جديدة/ }));
    const box = dialog.getByLabelText('تاريخ الحركة الفعلي') as HTMLInputElement;
    expect(box.type).toBe('datetime-local');
    expect(box.value).not.toBe('');
    expect(box.max >= box.value).toBe(true);
    fireEvent.change(box, { target: { value: '2026-11-19T17:00' } });
    fireEvent.change(dialog.getByRole('spinbutton'), { target: { value: '25' } });
    fireEvent.change(dialog.getByPlaceholderText('اسم الشخص أو الجهة'), { target: { value: 'زبون' } });
    fireEvent.change(dialog.getByLabelText('الملاحظة (إلزامية)'), { target: { value: 'دفعة متأخرة' } });
    fireEvent.click(dialog.getByRole('button', { name: 'تسجيل' }));
    await waitFor(() => expect(api.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
    const [, init] = api.mock.calls.find(([, i]) => i?.method === 'POST')!;
    const body = JSON.parse(init.body);
    expect(body.occurredAt).toBe(new Date('2026-11-19T17:00').toISOString());
    // The registration is the server's: it is never sent.
    expect(body.createdAt).toBeUndefined();
  });
});

describe('«آخر التحويلات»', () => {
  it('the row shows the real date and «سُجّلت …», and one date when the two fall on one day', async () => {
    render(<TransfersScreen />);
    const late = within(await tableRow('تصريف ليرة لدولار'));
    expect(late.getByText(arDateTime(REAL), { exact: false })).toBeTruthy();
    expect(late.getByText(`سُجّلت ${arDateTime(REGISTERED)}`)).toBeTruthy();
    const same = within(await tableRow('تحويل بنفس اليوم'));
    expect(same.queryByText(/سُجّلت/)).toBeNull();
  });

  it('the eye opens the transfer: both dates, who, both ends, both amounts, the rate and the note', async () => {
    render(<TransfersScreen />);
    const row = within(await tableRow('تصريف ليرة لدولار'));
    fireEvent.click(row.getByRole('button', { name: 'تفاصيل التحويل' }));
    const panel = within(await screen.findByRole('dialog', { name: 'تفاصيل التحويل' }));
    expect(panel.getByText(arDateTime(REAL))).toBeTruthy();
    expect(panel.getByText(arDateTime(REGISTERED))).toBeTruthy();
    expect(panel.getByText('احمد')).toBeTruthy();
    expect(panel.getByText('شام كاش · متجر دمشق')).toBeTruthy();
    expect(panel.getByText('بينانس · متجر دمشق')).toBeTruthy();
    expect(panel.getByText('0.00678')).toBeTruthy();
    expect(panel.getByText('تصريف ليرة لدولار')).toBeTruthy();
    expect(panel.getByText('ساري')).toBeTruthy();
    expect(panel.queryByRole('textbox')).toBeNull();
  });

  it('the form carries «تاريخ الحركة الفعلي» as a date-and-time box, defaulting to now', async () => {
    render(<TransfersScreen />);
    await tableRow('تصريف ليرة لدولار');
    const box = screen.getByLabelText('تاريخ الحركة الفعلي') as HTMLInputElement;
    expect(box.type).toBe('datetime-local');
    expect(box.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
