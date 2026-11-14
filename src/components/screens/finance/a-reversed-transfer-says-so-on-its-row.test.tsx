// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «القيد العكسي ما بيسمع بالتحويلات هاد خطأ عظيم» · «هل لازم أعمل قيد عكسي بالمكانين؟» — THE TRANSFERS SCREEN, 14/11.
 *
 * The history now has a «الحالة» column: a transfer nobody touched says «ساري»; one whose money was taken back says
 * «معكوس» (both legs) or «معكوس جزئياً» (one leg reversed by hand, the other still standing), with the reason and who wrote
 * it. A row that is not reversed whole carries «قيد عكسي» — drawn only for the key its door asks (`finance.cashbox`, the one
 * that writes a transfer) — and ONE press reverses both legs: the dialog says so and names the two wallets, sends the reason
 * to `PATCH /api/finance/transfers/:id`, and the list is read again. It names the amounts the transfer stored; it computes
 * none.
 */

const { apiJson, phone, who } = vi.hoisted(() => ({ apiJson: vi.fn(), phone: { value: false }, who: { keys: [] as string[] } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: who.keys } }),
}));

import { TransfersScreen } from './TransfersScreen';

const SYRIA = { id: 'SY', name: 'سوريا', minorUnit: 2 };
const wallet = (over: Record<string, unknown>) => ({
  isActive: true, balance: 0, countryId: 'SY', storeId: 'sA', store: { id: 'sA', name: 'متجر دمشق' }, country: SYRIA,
  imageKey: null, iconKey: null, colorKey: null, ...over,
});
const SHAM = wallet({ id: 'w-sham', name: 'شام كاش سوري', currencyCode: 'SYP' });
const BINANCE = wallet({ id: 'w-bin', name: 'بينانس', currencyCode: 'USDT' });
const end = (w: Record<string, unknown>) => ({
  id: w.id, name: w.name, currencyCode: w.currencyCode, store: { name: 'متجر دمشق' }, imageKey: null, iconKey: null, colorKey: null,
});

const base = {
  amountOut: 663958, amountIn: 4501.41, exchangeRate: 0.00678, createdAt: '2026-11-14T18:27:00.000Z',
  kindLabel: 'بين دولتين', from: end(SHAM), to: end(BINANCE),
};
const LIVE = { ...base, id: 't-live', note: 'تحويل ساري', state: 'ACTIVE', reversedWalletIds: [], reversal: null };
const HALF = {
  ...base, id: 't-half', note: 'تحويل نصف معكوس', state: 'PARTLY_REVERSED', reversedWalletIds: ['w-bin'],
  reversal: { reason: 'خطأ من البنت', at: '2026-11-14T18:28:00.000Z', byName: 'احمد' },
};
const DONE = {
  ...base, id: 't-done', note: 'تحويل معكوس كله', state: 'REVERSED', reversedWalletIds: ['w-bin', 'w-sham'],
  reversal: { reason: 'سُجِّل بالخطأ', at: '2026-11-14T18:30:00.000Z', byName: 'سلوى' },
};

const as = (...keys: string[]) => { who.keys = keys; };

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  as();
  apiJson.mockImplementation(async (url: string) =>
    String(url).startsWith('/api/finance/transfers') ? { transfers: [LIVE, HALF, DONE] } : { wallets: [SHAM, BINANCE] }
  );
});
afterEach(() => cleanup());

const rowOf = async (note: string) => (await screen.findAllByText(note))[0].closest('tr') as HTMLElement;
const pressIn = (row: HTMLElement) => within(row).queryByRole('button', { name: /قيد عكسي/ });
const anyPress = () => screen.queryAllByRole('button', { name: /قيد عكسي/, hidden: true });

describe('the «الحالة» column — read from the legs, so the list agrees with the ledger', () => {
  it('has the column, and each row says what became of its money', async () => {
    render(<TransfersScreen />);
    expect(await screen.findAllByRole('columnheader', { name: 'الحالة' })).not.toHaveLength(0);

    expect(within(await rowOf('تحويل ساري')).getByText('ساري')).toBeTruthy();

    const half = within(await rowOf('تحويل نصف معكوس'));
    expect(half.getByText('معكوس جزئياً')).toBeTruthy();
    expect(half.getByText('قيد عكسي: خطأ من البنت')).toBeTruthy();
    expect(half.getByText(/احمد/)).toBeTruthy();
    // It says what is left to do, in words.
    expect(half.getByText(/الطرف الآخر لسا قائم/)).toBeTruthy();

    const done = within(await rowOf('تحويل معكوس كله'));
    expect(done.getByText('معكوس')).toBeTruthy();
    expect(done.getByText('قيد عكسي: سُجِّل بالخطأ')).toBeTruthy();
    expect(done.getByText(/سلوى/)).toBeTruthy();
  });

  it('a row of an old answer, with no state at all, still reads as «ساري» — never an empty cell', async () => {
    const { state: _s, reversedWalletIds: _r, reversal: _v, ...old } = LIVE;
    void _s; void _r; void _v;
    apiJson.mockImplementation(async (url: string) =>
      String(url).startsWith('/api/finance/transfers') ? { transfers: [{ ...old, note: 'من جواب قديم' }] } : { wallets: [SHAM, BINANCE] }
    );
    render(<TransfersScreen />);
    expect(within(await rowOf('من جواب قديم')).getByText('ساري')).toBeTruthy();
  });
});

describe('«قيد عكسي» on a row — drawn for the key its door asks', () => {
  it('NEGATIVE: who only SEES the cash box is offered no press on any row, and the states are still readable', async () => {
    as('finance.cashbox_view');
    render(<TransfersScreen />);
    await rowOf('تحويل ساري');
    expect(anyPress()).toHaveLength(0);
    expect(within(await rowOf('تحويل نصف معكوس')).getByText('معكوس جزئياً')).toBeTruthy();
  });

  it('NEGATIVE: the wallets’ key and the view key do not draw it either — only the key that writes a transfer', async () => {
    as('finance.cashbox_view', 'finance.wallets_manage', 'finance.update');
    render(<TransfersScreen />);
    await rowOf('تحويل ساري');
    expect(anyPress()).toHaveLength(0);
  });

  it('the cash key draws it on a standing transfer and on a half-reversed one — and NOT on one reversed whole', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    expect(pressIn(await rowOf('تحويل ساري'))).toBeTruthy();
    expect(pressIn(await rowOf('تحويل نصف معكوس'))).toBeTruthy();
    expect(pressIn(await rowOf('تحويل معكوس كله'))).toBeNull();
  });

  it('a phone card carries the same press and the same state', async () => {
    phone.value = true;
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    await rowOf('تحويل ساري');
    expect(screen.getAllByText('معكوس جزئياً').length).toBeGreaterThan(0);
    expect(anyPress().length).toBeGreaterThan(0);
  });
});

describe('one press, both legs', () => {
  const openFor = async (note: string) => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    fireEvent.click(pressIn(await rowOf(note)) as HTMLElement);
    return within(await screen.findByRole('dialog', { name: 'قيد عكسي' }));
  };

  it('says BOTH wallets and what comes back to each, from the amounts the transfer stored', async () => {
    const dialog = await openFor('تحويل ساري');
    expect(dialog.getByText(/سيُسجَّل قيدان معاكسان بمرة واحدة/)).toBeTruthy();
    // The wallet the money left gets it back; the wallet it arrived in gives it up.
    expect(dialog.getByText(/شام كاش سوري/)).toBeTruthy();
    expect(dialog.getByText(/يرجع إليها/)).toBeTruthy();
    expect(dialog.getByText(/بينانس/)).toBeTruthy();
    expect(dialog.getByText(/يخرج منها/)).toBeTruthy();
    expect(dialog.getByText(/663,958/)).toBeTruthy();
    expect(dialog.getByText(/4,501\.41/)).toBeTruthy();
  });

  it('on a half-reversed transfer it names only the leg that is left, and says the other was done', async () => {
    const dialog = await openFor('تحويل نصف معكوس');
    expect(dialog.getByText(/أحد طرفي هذا التحويل معكوس من قبل/)).toBeTruthy();
    expect(dialog.getByText(/شام كاش سوري/)).toBeTruthy();
    expect(dialog.queryByText(/يخرج منها/)).toBeNull();
  });

  it('asks for the reason — mandatory, at least five letters — and says the originals stay', async () => {
    const dialog = await openFor('تحويل ساري');
    const box = dialog.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.required).toBe(true);
    expect(box.minLength).toBe(5);
    expect(dialog.getByText(/القيدان الأصليان لا يُحذفان ولا يُعدَّلان/)).toBeTruthy();
  });

  it('sends the reason to the transfer’s door, then reads the list again and says both legs were reversed', async () => {
    const dialog = await openFor('تحويل ساري');
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '  سُجِّل التحويل بالخطأ  ' } });
    apiJson.mockClear();
    apiJson.mockImplementation(async (url: string) =>
      String(url).startsWith('/api/finance/transfers/') ? { transferId: 't-live' } :
      String(url).startsWith('/api/finance/transfers') ? { transfers: [{ ...LIVE, state: 'REVERSED', reversedWalletIds: ['w-bin', 'w-sham'], reversal: { reason: 'سُجِّل التحويل بالخطأ', at: null, byName: null } }, HALF, DONE] } :
      { wallets: [SHAM, BINANCE] }
    );
    fireEvent.click(dialog.getByRole('button', { name: 'تسجيل القيد العكسي' }));

    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/finance/transfers/t-live', { method: 'PATCH', body: JSON.stringify({ reason: 'سُجِّل التحويل بالخطأ' }) }));
    // The list is asked for again, so the row now says what happened.
    await waitFor(() => expect(apiJson.mock.calls.some((c) => c[0] === '/api/finance/transfers')).toBe(true));
    expect(await screen.findByText('انعكس التحويل — الطرفان معاً')).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'قيد عكسي' })).toBeNull();
  });

  it('a refusal from the door is shown as it was said, and the dialog stays for another try', async () => {
    const dialog = await openFor('تحويل ساري');
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'سبب مكتوب' } });
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/finance/transfers/')) throw new Error('هذا التحويل معكوس بالكامل من قبل');
      return String(url).startsWith('/api/finance/transfers') ? { transfers: [LIVE] } : { wallets: [SHAM, BINANCE] };
    });
    fireEvent.click(dialog.getByRole('button', { name: 'تسجيل القيد العكسي' }));
    expect(await screen.findByText('هذا التحويل معكوس بالكامل من قبل')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'قيد عكسي' })).toBeTruthy();
  });
});
