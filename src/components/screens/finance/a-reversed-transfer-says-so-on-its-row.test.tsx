// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «القيد العكسي ما بيسمع بالتحويلات هاد خطأ عظيم» · «هل لازم أعمل قيد عكسي بالمكانين؟» — THE TRANSFERS SCREEN, 14/11.
 *
 * The history has a «الحالة» column: a transfer nobody touched says «ساري»; one whose money was taken back says «معكوس» (both
 * legs) or «معكوس جزئياً» (one leg reversed by hand, the other still standing), with the reason and who wrote it. A row that is
 * not reversed whole carries «قيد عكسي» — drawn only for the key its door asks (`finance.cashbox`, the one that writes a
 * transfer) — and ONE press reverses both legs: the dialog says so and names the two wallets (with their stores), sends the
 * reason to `PATCH /api/finance/transfers/:id`, reads the list again BEFORE it closes, and says so in a toast. It names the
 * amounts the transfer stored; it computes none.
 *
 * What the independent screen review measured, and these hold: the press lives INSIDE the status cell (a column of its own,
 * beside a long reason, pushed the desk table past a 1254px window and clipped the button) and that cell is capped; a person
 * without the key gets no empty strip on a card; the message is a toast, not a line 800px above the history.
 *
 * `Rows` draws BOTH the desk table and a card per row into the DOM, table first — so each query below says which one it asks.
 */

const { apiJson, phone, who, toast } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: false },
  who: { keys: [] as string[] },
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
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
/** The other half: the SENDING leg was reversed by hand, the receiving one still stands. */
const HALF_OTHER = {
  ...base, id: 't-half-other', note: 'تحويل نصف معكوس من المرسل', state: 'PARTLY_REVERSED', reversedWalletIds: ['w-sham'],
  reversal: { reason: 'تصحيح', at: '2026-11-14T18:29:00.000Z', byName: 'سلوى' },
};
const DONE = {
  ...base, id: 't-done', note: 'تحويل معكوس كله', state: 'REVERSED', reversedWalletIds: ['w-bin', 'w-sham'],
  reversal: { reason: 'سُجِّل بالخطأ', at: '2026-11-14T18:30:00.000Z', byName: 'سلوى' },
};

const as = (...keys: string[]) => { who.keys = keys; };
const serve = (transfers: unknown[]) =>
  apiJson.mockImplementation(async (url: string) =>
    String(url).startsWith('/api/finance/transfers') ? { transfers } : { wallets: [SHAM, BINANCE] }
  );

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  as();
  serve([LIVE, HALF, DONE]);
});
afterEach(() => cleanup());

/** The row of the DESK table that carries this note. */
const deskRow = async (note: string) => (await screen.findAllByText(note))[0].closest('tr') as HTMLElement;
/** The CARD (a phone's row) that carries this note: `Rows` draws it as an `li`, after the table. */
const card = async (note: string) =>
  (await screen.findAllByText(note)).map((el) => el.closest('li')).find((li): li is HTMLLIElement => !!li) as HTMLLIElement;
const pressIn = (within_: HTMLElement) => within(within_).queryByRole('button', { name: /قيد عكسي/ });
const allPresses = () => screen.queryAllByRole('button', { name: /قيد عكسي/, hidden: true });

describe('the «الحالة» column — read from the legs, so the list agrees with the ledger', () => {
  it('has the column, and each row of the desk table says what became of its money', async () => {
    render(<TransfersScreen />);
    expect(await screen.findAllByRole('columnheader', { name: 'الحالة' })).not.toHaveLength(0);

    expect(within(await deskRow('تحويل ساري')).getByText('ساري')).toBeTruthy();

    const half = within(await deskRow('تحويل نصف معكوس'));
    expect(half.getByText('معكوس جزئياً')).toBeTruthy();
    expect(half.getByText('قيد عكسي: خطأ من البنت')).toBeTruthy();
    expect(half.getByText(/احمد/)).toBeTruthy();
    // It says what is left to do, in words.
    expect(half.getByText(/الطرف الآخر لسا قائم/)).toBeTruthy();

    const done = within(await deskRow('تحويل معكوس كله'));
    expect(done.getByText('معكوس')).toBeTruthy();
    expect(done.getByText('قيد عكسي: سُجِّل بالخطأ')).toBeTruthy();
    expect(done.getByText(/سلوى/)).toBeTruthy();
  });

  it('a phone card says the same — the state, the reason and who wrote it', async () => {
    render(<TransfersScreen />);
    const half = within(await card('تحويل نصف معكوس'));
    expect(half.getByText('معكوس جزئياً')).toBeTruthy();
    expect(half.getByText('قيد عكسي: خطأ من البنت')).toBeTruthy();
    expect(half.getByText(/احمد/)).toBeTruthy();
  });

  it('a row of an old answer, with no state at all, still reads as «ساري» — never an empty cell', async () => {
    const { state: _s, reversedWalletIds: _r, reversal: _v, ...old } = LIVE;
    void _s; void _r; void _v;
    serve([{ ...old, note: 'من جواب قديم' }]);
    render(<TransfersScreen />);
    expect(within(await deskRow('من جواب قديم')).getByText('ساري')).toBeTruthy();
  });

  it('the desk table has NO column of its own for the press: every header says a word, and the long cell is capped so a reason wraps', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    const table = (await screen.findAllByRole('table'))[0];
    const heads = within(table).getAllByRole('columnheader');
    // The press had a column of its own (an empty header) that pushed the table past a 1254px window and clipped the button.
    expect(heads.map((h) => h.textContent?.trim())).not.toContain('');
    expect(heads.map((h) => h.textContent?.trim())).toContain('الحالة');
    // The status cell is the one that holds a long reason; it is capped and wraps (classes the product already ships).
    const reason = within(await deskRow('تحويل نصف معكوس')).getByText('قيد عكسي: خطأ من البنت');
    const cell = reason.closest('div') as HTMLElement;
    expect(cell.className).toContain('max-w-[10rem]');
    expect(cell.className).toContain('break-words');
    // And the press is inside that very cell — beside the reason, not in a column of its own.
    expect(pressIn(cell)).toBeTruthy();
  });
});

describe('«قيد عكسي» on a row — drawn for the key its door asks', () => {
  it('NEGATIVE: who only SEES the cash box is offered no press on any row, desk or card, and the states are still readable', async () => {
    as('finance.cashbox_view');
    render(<TransfersScreen />);
    await deskRow('تحويل ساري');
    expect(allPresses()).toHaveLength(0);
    expect(within(await deskRow('تحويل نصف معكوس')).getByText('معكوس جزئياً')).toBeTruthy();
  });

  it('NEGATIVE: the wallets’ key and the finance-edit key do not draw it either — only the key that writes a transfer', async () => {
    as('finance.cashbox_view', 'finance.wallets_manage', 'finance.update');
    render(<TransfersScreen />);
    await deskRow('تحويل ساري');
    expect(allPresses()).toHaveLength(0);
  });

  it('NEGATIVE: a card of a person who may not press ends with no empty strip of actions', async () => {
    as('finance.cashbox_view');
    render(<TransfersScreen />);
    await card('تحويل ساري');
    expect(document.querySelectorAll('.card-acts')).toHaveLength(0);
  });

  it('the cash key draws it on a standing transfer and on a half-reversed one — and NOT on one reversed whole (desk)', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    expect(pressIn(await deskRow('تحويل ساري'))).toBeTruthy();
    expect(pressIn(await deskRow('تحويل نصف معكوس'))).toBeTruthy();
    expect(pressIn(await deskRow('تحويل معكوس كله'))).toBeNull();
  });

  it('and the same on the phone cards — each card carries its own press, and the reversed one carries none', async () => {
    phone.value = true;
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    expect(pressIn(await card('تحويل ساري'))).toBeTruthy();
    expect(pressIn(await card('تحويل نصف معكوس'))).toBeTruthy();
    expect(pressIn(await card('تحويل معكوس كله'))).toBeNull();
  });

  it('under a finger the press is 44px tall on a phone and back to its own height on a desk — it left the actions strip that gave it that', async () => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    const press = pressIn(await card('تحويل ساري')) as HTMLElement;
    expect(press.className).toContain('min-h-11');
    expect(press.className).toContain('md:min-h-0');
  });

  it('the way to finish a half-reversed transfer is said ONLY to who has the press — nobody is pointed at a button they do not have', async () => {
    as('finance.cashbox_view');
    const { unmount } = render(<TransfersScreen />);
    const without = within(await deskRow('تحويل نصف معكوس'));
    expect(without.getByText('الطرف الآخر لسا قائم')).toBeTruthy();
    expect(without.queryByText(/بيكمّل عكسه/)).toBeNull();
    unmount();

    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    expect(within(await deskRow('تحويل نصف معكوس')).getByText(/بيكمّل عكسه/)).toBeTruthy();
  });
});

describe('one press, both legs', () => {
  const openFor = async (note: string) => {
    as('finance.cashbox_view', 'finance.cashbox');
    render(<TransfersScreen />);
    fireEvent.click(pressIn(await deskRow(note)) as HTMLElement);
    return within(await screen.findByRole('dialog', { name: 'قيد عكسي' }));
  };

  it('says BOTH wallets, with their stores, and gives each the right verb and the right stored amount', async () => {
    const dialog = await openFor('تحويل ساري');
    expect(dialog.getByText(/سيُسجَّل قيدان معاكسان بمرة واحدة/)).toBeTruthy();

    // The wallet the money LEFT gets it back, in its own currency; the wallet it ARRIVED in gives it up, in its own.
    const sham = dialog.getByText('شام كاش سوري').closest('p') as HTMLElement;
    expect(sham.textContent).toContain('يرجع إليها');
    expect(sham.textContent).toContain('663,958');
    expect(sham.textContent).not.toContain('يخرج منها');
    expect(sham.textContent).not.toContain('4,501.41');

    const binance = dialog.getByText('بينانس').closest('p') as HTMLElement;
    expect(binance.textContent).toContain('يخرج منها');
    expect(binance.textContent).toContain('4,501.41');
    expect(binance.textContent).not.toContain('يرجع إليها');
    expect(binance.textContent).not.toContain('663,958');
  });

  it('names the STORE of each wallet — a wallet’s name is unique only inside its store', async () => {
    const dialog = await openFor('تحويل ساري');
    expect(dialog.getAllByText(/\(متجر دمشق\)/)).toHaveLength(2);
  });

  it('on a half-reversed transfer (the receiving leg done) it names only the sending leg, and says the other was done', async () => {
    const dialog = await openFor('تحويل نصف معكوس');
    expect(dialog.getByText(/أحد طرفي هذا التحويل معكوس من قبل/)).toBeTruthy();
    expect(dialog.getByText(/ويكتمل عكس التحويل/)).toBeTruthy();
    expect(dialog.getByText('شام كاش سوري')).toBeTruthy();
    expect(dialog.queryByText('بينانس')).toBeNull();
    expect(dialog.queryByText(/يخرج منها/)).toBeNull();
  });

  it('and the other half (the sending leg done) names only the receiving leg', async () => {
    serve([LIVE, HALF_OTHER, DONE]);
    const dialog = await openFor('تحويل نصف معكوس من المرسل');
    expect(dialog.getByText('بينانس')).toBeTruthy();
    expect(dialog.getByText(/يخرج منها/)).toBeTruthy();
    expect(dialog.queryByText('شام كاش سوري')).toBeNull();
    expect(dialog.queryByText(/يرجع إليها/)).toBeNull();
  });

  it('asks for the reason — mandatory, at least five letters — and says the originals stay', async () => {
    const dialog = await openFor('تحويل ساري');
    const box = dialog.getByRole('textbox') as HTMLTextAreaElement;
    expect(box.required).toBe(true);
    expect(box.minLength).toBe(5);
    expect(dialog.getByText(/القيدان الأصليان لا يُحذفان ولا يُعدَّلان/)).toBeTruthy();
  });

  it('sends the trimmed reason to the transfer’s door, keeps the dialog BUSY until the list is read again, then closes it, tells the person in a toast, and the row says «معكوس»', async () => {
    const dialog = await openFor('تحويل ساري');
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: '  سُجِّل التحويل بالخطأ  ' } });

    // The list is read again only when the test says so, so what the dialog does in the meantime can be seen.
    let release!: () => void;
    const listIsRead = new Promise<void>((resolve) => { release = resolve; });
    apiJson.mockClear();
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/finance/transfers/')) return { transferId: 't-live' };
      if (String(url).startsWith('/api/finance/transfers')) {
        await listIsRead;
        return { transfers: [{ ...LIVE, state: 'REVERSED', reversedWalletIds: ['w-bin', 'w-sham'], reversal: { reason: 'سُجِّل التحويل بالخطأ', at: null, byName: null } }, HALF, DONE] };
      }
      return { wallets: [SHAM, BINANCE] };
    });
    fireEvent.click(dialog.getByRole('button', { name: 'تسجيل القيد العكسي' }));

    await waitFor(() =>
      expect(apiJson).toHaveBeenCalledWith('/api/finance/transfers/t-live', { method: 'PATCH', body: JSON.stringify({ reason: 'سُجِّل التحويل بالخطأ' }) })
    );
    // While the list is being read again the dialog is STILL there with its button busy — closed first, the row would say «ساري»
    // with its press until the answer came, and a second press would meet the 409.
    await waitFor(() => expect(apiJson.mock.calls.some((c) => c[0] === '/api/finance/transfers')).toBe(true));
    expect(screen.getByRole('dialog', { name: 'قيد عكسي' })).toBeTruthy();
    expect(dialog.getByRole('button', { name: 'جارٍ التسجيل…' })).toBeTruthy();
    expect(toast.done).not.toHaveBeenCalled();
    // It cannot be closed meanwhile — by the cancel button or by the X: closed now, the row behind would still say «ساري» with a press.
    expect((dialog.getByRole('button', { name: 'إلغاء' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(dialog.getByRole('button', { name: 'إغلاق' }));
    expect(screen.getByRole('dialog', { name: 'قيد عكسي' })).toBeTruthy();

    release();
    await waitFor(() => expect(toast.done).toHaveBeenCalledWith('انعكس التحويل — الطرفان معاً'));
    expect(screen.queryByRole('dialog', { name: 'قيد عكسي' })).toBeNull();
    // The row now says what happened, and offers no second press.
    const row = await deskRow('تحويل ساري');
    expect(within(row).getByText('معكوس')).toBeTruthy();
    expect(pressIn(row)).toBeNull();
  });

  it('if the list cannot be read again after a good press, the row still says «معكوس» with no press — it never keeps a live press', async () => {
    const dialog = await openFor('تحويل ساري');
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'سبب مكتوب' } });
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/finance/transfers/')) return { transferId: 't-live' };
      if (String(url).startsWith('/api/finance/transfers')) throw new Error('انقطع الاتصال');
      return { wallets: [SHAM, BINANCE] };
    });
    fireEvent.click(dialog.getByRole('button', { name: 'تسجيل القيد العكسي' }));

    await waitFor(() => expect(toast.done).toHaveBeenCalledWith('انعكس التحويل — الطرفان معاً'));
    expect(screen.queryByRole('dialog', { name: 'قيد عكسي' })).toBeNull();
    // The door said yes, so the row says so at once — a second press on it would have met the 409.
    const row = await deskRow('تحويل ساري');
    expect(within(row).getByText('معكوس')).toBeTruthy();
    expect(pressIn(row)).toBeNull();
  });

  it('a refusal from the door is shown as it was said, the dialog stays for another try, and nothing is announced', async () => {
    const dialog = await openFor('تحويل ساري');
    fireEvent.change(dialog.getByRole('textbox'), { target: { value: 'سبب مكتوب' } });
    apiJson.mockImplementation(async (url: string) => {
      if (String(url).startsWith('/api/finance/transfers/')) throw new Error('هذا التحويل معكوس بالكامل من قبل');
      return String(url).startsWith('/api/finance/transfers') ? { transfers: [LIVE] } : { wallets: [SHAM, BINANCE] };
    });
    fireEvent.click(dialog.getByRole('button', { name: 'تسجيل القيد العكسي' }));
    expect(await screen.findByText('هذا التحويل معكوس بالكامل من قبل')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'قيد عكسي' })).toBeTruthy();
    expect(toast.done).not.toHaveBeenCalled();
  });
});
