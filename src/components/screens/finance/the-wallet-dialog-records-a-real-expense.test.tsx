// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import {
  EXPENSE_CATEGORY_AR,
  EXPENSE_FORM_HINT,
  EXPENSE_FORM_LABEL,
  EXPENSE_FORM_ORDER,
  resolveExpenseCategory,
} from '@/lib/expense-grade';
import {
  COURIER_MONEY_HINT,
  EXPENSE_HERE_HINT,
  OWN_LEDGER,
  OWN_LEDGER_HINT,
  handMovementRefusal,
} from '@/lib/hand-movement-rules';

/**
 * «حركة جديدة» — «مصروف» IS A CHOICE THAT WORKS HERE, AND IT IS WRITTEN BY THE EXPENSE DOOR.
 *
 * The owner, looking at the category list of a wallet's dialog on his phone: «كمان هون بدن نفعل نقدر ندخل مصروف».
 * It was greyed with a pointer to «سجّل مصروفاً», because a movement typed under that category at the movements door
 * leaves the profit untouched (or counts it twice). The fix is NOT to open that door: choosing «مصروف» turns the dialog
 * into the expense form and sends it to the door that owns it (`POST /api/finance`), which writes the expense row and
 * this wallet's movement in one transaction.
 *
 * WHAT THESE PIN
 *   · who is offered it: `finance.create` and going OUT — nobody else, and «عمولة» never;
 *   · what the dialog turns into, field by field, with the profit screen's own list of types and its default;
 *   · THE WIRE: one request, to the expense door, with exactly the body that door reads — and none to the movements door;
 *   · the body is then handed to the REAL expense door, so the two halves are proved against each other;
 *   · the old movement flow is the flow it was, and the movements door still refuses a typed expense;
 *   · the one sentence about a wallet in another currency than the store's.
 */

const { who, db, requireContext, requirePermission, logAudit, commissionCostForOrders } = vi.hoisted(() => ({
  who: { role: 'CUSTOM', keys: [] as string[] },
  db: {
    expense: { findMany: vi.fn(), groupBy: vi.fn(), create: vi.fn(), update: vi.fn() },
    order: { findMany: vi.fn() },
    wallet: { findFirst: vi.fn() },
    walletMovement: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  commissionCostForOrders: vi.fn(),
}));

/* ── the expense door's dependencies (the real door is imported below) ───── */
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/commission', () => ({
  commissionCostForOrders: (...a: unknown[]) => commissionCostForOrders(...a),
}));

/* ── the screen's dependencies ───────────────────────────────────────────── */
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: who.role, permissions: who.keys } }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));

import { POST as EXPENSE_DOOR } from '@/app/api/finance/route';
import { StoreCurrencyProvider } from '@/context/StoreCurrency';
import { WalletsScreen } from './WalletsScreen';

const WALLET = {
  id: 'w1', name: 'شام كاش دولار', currencyCode: 'USD', isActive: true, opening: 0, in: 0, out: 0, balance: 0,
  movements: 0, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};

/** The key of the movements door's dialog, plus whatever the case adds. */
const as = (...extra: string[]) => {
  who.role = 'CUSTOM';
  who.keys = ['finance.cashbox_view', 'finance.cashbox', ...extra];
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Every request that WRITES, in order — and every read, so a refresh can be counted. */
let sent: Sent[] = [];
let reads: string[] = [];
/** When set, the next write is answered with this refusal instead of success. */
let refusal: { status: number; body: unknown } | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  who.role = 'CUSTOM';
  who.keys = [];
  sent = [];
  reads = [];
  refusal = null;

  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'سامر' },
    companyId: 'c1',
    storeId: 's1',
    country: { currencyCode: 'SYP', minorUnit: 2 },
  });
  requirePermission.mockResolvedValue(undefined);
  db.wallet.findFirst.mockResolvedValue({ id: WALLET.id, name: WALLET.name, currencyCode: WALLET.currencyCode });
  db.expense.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'exp-1', ...data }));
  db.walletMovement.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'mv-1', ...data }));
  db.expense.update.mockImplementation(async ({ data }: { data: object }) => ({ id: 'exp-1', ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: object) => unknown) => fn({ expense: db.expense, walletMovement: db.walletMovement }));

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({
          url,
          method,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: init?.body ? JSON.parse(String(init.body)) : {},
        });
        if (refusal) return json(refusal.body, refusal.status);
        return url === '/api/finance' ? json({ success: true, expense: { id: 'exp-1' } }) : json({ movement: { id: 'm1' } }, 201);
      }
      reads.push(url);
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets: [WALLET] });
    })
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ── driving the real screen ─────────────────────────────────────────────── */

async function openDialog(opts: { storeCode?: string } = {}) {
  render(
    opts.storeCode ? (
      <StoreCurrencyProvider code={opts.storeCode}>
        <WalletsScreen />
      </StoreCurrencyProvider>
    ) : (
      <WalletsScreen />
    )
  );
  fireEvent.click(await screen.findByText('حركة جديدة'));
  return screen.findByRole('dialog');
}

/** The first box of the dialog is the category; the expense's own type box comes after it. */
const categoryBox = (dialog: HTMLElement) => within(dialog).getAllByRole('combobox')[0] as HTMLSelectElement;
const typeBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^نوع المصروف/) as HTMLSelectElement;
const amountBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^المبلغ/) as HTMLInputElement;
const statementBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^(البيان|الطرف)/) as HTMLInputElement;
const dateBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^التاريخ/) as HTMLInputElement;
const noteBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^الملاحظة/) as HTMLInputElement;

/** What a person can actually choose in the category box, and what is listed but greyed. */
const choosable = (dialog: HTMLElement) =>
  within(categoryBox(dialog))
    .getAllByRole('option')
    .filter((o) => !(o as HTMLOptionElement).disabled)
    .map((o) => (o as HTMLOptionElement).value);
const greyed = (dialog: HTMLElement) =>
  within(categoryBox(dialog))
    .getAllByRole('option')
    .filter((o) => (o as HTMLOptionElement).disabled)
    .map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' }));

const direction = (dialog: HTMLElement, name: 'وارد' | 'صادر') =>
  fireEvent.click(within(dialog).getByRole('button', { name }));

const chooseExpense = (dialog: HTMLElement) =>
  fireEvent.change(categoryBox(dialog), { target: { value: 'EXPENSE' } });

/** Fill the expense form the way a person would, leaving the date and the type on their defaults unless told. */
function fillExpense(
  dialog: HTMLElement,
  v: { amount?: string; statement?: string; note?: string; type?: string; date?: string } = {}
) {
  fireEvent.change(amountBox(dialog), { target: { value: v.amount ?? '150.5' } });
  fireEvent.change(statementBox(dialog), { target: { value: v.statement ?? '  إيجار المستودع  ' } });
  if (v.type) fireEvent.change(typeBox(dialog), { target: { value: v.type } });
  if (v.date) fireEvent.change(dateBox(dialog), { target: { value: v.date } });
  if (v.note !== undefined) fireEvent.change(noteBox(dialog), { target: { value: v.note } });
}

/* ════════════════════════════════════════════════════════════════════════
   WHO IS OFFERED «مصروف»
   ════════════════════════════════════════════════════════════════════════ */

describe('who is offered «مصروف» in the category box', () => {
  it('whoever holds finance.create can choose it going OUT — and «عمولة» is still greyed beside it', async () => {
    as('finance.create');
    const dialog = await openDialog();
    expect(choosable(dialog)).toEqual(['ADJUSTMENT', 'OTHER', 'EXPENSE']);
    expect(greyed(dialog).map((o) => o.value)).toEqual(['COMMISSION']);
    expect(greyed(dialog)[0].text).toBe(`عمولة — ${OWN_LEDGER.COMMISSION.short}`);
  });

  it('and not coming IN: greyed, with a pointer that sends a returned expense to «تسوية» — while «عمولة» keeps its own', async () => {
    as('finance.create');
    const dialog = await openDialog();
    direction(dialog, 'وارد');
    await waitFor(() => expect(choosable(dialog)).toEqual(['ADJUSTMENT', 'OTHER']));
    const grey = Object.fromEntries(greyed(dialog).map((o) => [o.value, o.text]));
    expect(Object.keys(grey)).toEqual(['EXPENSE', 'COMMISSION']);
    expect(grey.EXPENSE).toContain('صادر فقط');
    expect(grey.EXPENSE).toContain('تسوية');
    expect(grey.COMMISSION).toBe(`عمولة — ${OWN_LEDGER.COMMISSION.short}`);
  });

  it('whoever lacks the key keeps today\'s greyed option and today\'s pointer, in both directions', async () => {
    as();
    const dialog = await openDialog();
    for (const name of ['صادر', 'وارد'] as const) {
      direction(dialog, name);
      await waitFor(() => expect(greyed(dialog).map((o) => o.value)).toEqual(['EXPENSE', 'COMMISSION']));
      const grey = Object.fromEntries(greyed(dialog).map((o) => [o.value, o.text]));
      expect(grey.EXPENSE).toBe(`مصروف — ${OWN_LEDGER.EXPENSE.short}`);
      expect(grey.COMMISSION).toBe(`عمولة — ${OWN_LEDGER.COMMISSION.short}`);
      expect(choosable(dialog)).toEqual(['ADJUSTMENT', 'OTHER']);
    }
  });

  it('the cash key alone is not the expense key, and the expense key alone does not open the dialog', async () => {
    // Cash key, no expense key: the dialog opens and «مصروف» is greyed (the case above).
    // Expense key, no cash key: the screen draws no «حركة جديدة» at all — the dialog is the cash key's.
    who.role = 'CUSTOM';
    who.keys = ['finance.cashbox_view', 'finance.create'];
    render(<WalletsScreen />);
    await screen.findAllByText('شام كاش دولار');
    expect(screen.queryAllByRole('button', { name: 'حركة جديدة', hidden: true })).toHaveLength(0);
  });

  it('SUPER_ADMIN holds every key, as the server counts it, so the option opens for the owner', async () => {
    who.role = 'SUPER_ADMIN';
    who.keys = [];
    const dialog = await openDialog();
    expect(choosable(dialog)).toEqual(['ADJUSTMENT', 'OTHER', 'EXPENSE']);
  });

  it('every type the form can send is a type the expense door accepts', () => {
    for (const type of EXPENSE_FORM_ORDER) expect(resolveExpenseCategory(type), type).toBe(type);
  });
});

describe('the line under the category box', () => {
  it('says the expense is recorded HERE, as a real one, for who may — and keeps the other pointers', async () => {
    as('finance.create');
    const dialog = await openDialog();
    expect(
      within(dialog).getByText(`${COURIER_MONEY_HINT} ${EXPENSE_HERE_HINT} التحويلات من شاشة التحويلات.`)
    ).toBeTruthy();
    // It says what the expense does: counts in the profit, leaves this wallet.
    expect(EXPENSE_HERE_HINT).toContain('بينخصم من الربح');
    expect(EXPENSE_HERE_HINT).toContain('بيطلع من هالمحفظة');
    // …and no longer claims that the profit screen is the only place.
    expect(within(dialog).queryByText(/المصروف من «سجّل مصروفاً» في «الأرباح»/)).toBeNull();
    // The courier collection, the commission, the salary and the transfers keep their pointers.
    expect(within(dialog).getByText(/تحصيل شركة الشحن لا يُكتب هنا/)).toBeTruthy();
    expect(EXPENSE_HERE_HINT).toContain('والعمولة من «صرف» في «العمولات»');
    expect(EXPENSE_HERE_HINT).toContain('والراتب من صفحة الموظف');
    expect(within(dialog).getByText(/التحويلات من شاشة التحويلات/)).toBeTruthy();
  });

  it('and for who may not, it is today\'s sentence, word for word', async () => {
    as();
    const dialog = await openDialog();
    const today =
      'المصروف من «سجّل مصروفاً» في «الأرباح»، والعمولة من «صرف» في «العمولات»، والراتب من صفحة الموظف.';
    expect(OWN_LEDGER_HINT).toBe(today);
    expect(within(dialog).getByText(`${COURIER_MONEY_HINT} ${today} التحويلات من شاشة التحويلات.`)).toBeTruthy();
    expect(within(dialog).queryByText(/بيطلع من هالمحفظة/)).toBeNull();
  });
});

/* ════════════════════════════════════════════════════════════════════════
   THE DIALOG TURNS INTO THE EXPENSE FORM
   ════════════════════════════════════════════════════════════════════════ */

describe('choosing «مصروف» turns the dialog into the expense form', () => {
  it('shows the type box on the profit screen\'s list, order and default, the statement, today\'s date and an optional note', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 11, 14, 30, 0));
    as('finance.create');
    const dialog = await openDialog();

    // Before: a typed movement — «الطرف», a note that is required, the button «تسجيل».
    expect(within(dialog).getByText('الطرف')).toBeTruthy();
    expect(within(dialog).getByText('الملاحظة (إلزامية)')).toBeTruthy();
    expect(within(dialog).queryByLabelText(/^نوع المصروف/)).toBeNull();
    expect(within(dialog).queryByLabelText(/^التاريخ/)).toBeNull();

    chooseExpense(dialog);

    // The type box: the same eight, in the same order, with the same two special labels; opened on the same default.
    expect(typeBox(dialog).value).toBe('MARKETING');
    const types = within(typeBox(dialog)).getAllByRole('option') as HTMLOptionElement[];
    expect(types.map((o) => o.value)).toEqual([...EXPENSE_FORM_ORDER]);
    expect(types.map((o) => o.textContent)).toEqual(
      EXPENSE_FORM_ORDER.map((c) => EXPENSE_FORM_LABEL[c] ?? EXPENSE_CATEGORY_AR[c])
    );
    expect(types.every((o) => !o.disabled), 'the door refuses none of the eight, so none is greyed').toBe(true);

    // The statement replaces «الطرف»; it is required and at least two characters, like the party box was.
    expect(within(dialog).queryByText('الطرف')).toBeNull();
    expect(within(dialog).getByText('البيان')).toBeTruthy();
    expect(statementBox(dialog).required).toBe(true);
    expect(statementBox(dialog).minLength).toBe(2);

    // The amount keeps the wallet's currency in its label; the date is today as the person's calendar reads it.
    expect(within(dialog).getByText('المبلغ (USD)')).toBeTruthy();
    expect(dateBox(dialog).type).toBe('date');
    expect(dateBox(dialog).value).toBe('2026-11-11');
    expect(dateBox(dialog).required).toBe(true);

    // The note is optional here, as the expense door treats it, and says so.
    expect(within(dialog).getByText('الملاحظة (اختيارية)')).toBeTruthy();
    expect(within(dialog).queryByText(/إلزامية/)).toBeNull();
    expect(noteBox(dialog).required).toBe(false);
    expect(noteBox(dialog).minLength).toBe(-1);

    expect(within(dialog).getByRole('button', { name: 'تسجيل المصروف' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'تسجيل' })).toBeNull();
  });

  it('the date is the person\'s own today, even just after midnight — not the UTC date', async () => {
    // Built from LOCAL parts: whatever zone this runs in, the local day is the first of December.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 11, 1, 0, 30, 0));
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    expect(dateBox(dialog).value).toBe('2026-12-01');
  });

  it('the two types the profit already counts elsewhere carry their warning sentence, and no other type does', async () => {
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    for (const type of ['SHIPPING', 'MANUFACTURING'] as const) {
      fireEvent.change(typeBox(dialog), { target: { value: type } });
      expect(within(dialog).getByText(EXPENSE_FORM_HINT[type]!)).toBeTruthy();
    }
    fireEvent.change(typeBox(dialog), { target: { value: 'OFFICE' } });
    expect(within(dialog).queryByText(EXPENSE_FORM_HINT.SHIPPING!)).toBeNull();
    expect(within(dialog).queryByText(EXPENSE_FORM_HINT.MANUFACTURING!)).toBeNull();
  });

  it('a typed movement still needs its note (three characters at least) — only the expense makes it optional', async () => {
    as('finance.create');
    const dialog = await openDialog();
    expect(noteBox(dialog).required).toBe(true);
    expect(noteBox(dialog).minLength).toBe(3);
    chooseExpense(dialog);
    expect(noteBox(dialog).required).toBe(false);
    // And back: the pair returns to a movement and the note to its rule.
    fireEvent.change(categoryBox(dialog), { target: { value: 'OTHER' } });
    expect(noteBox(dialog).required).toBe(true);
    expect(noteBox(dialog).minLength).toBe(3);
    expect(within(dialog).getByText('الطرف')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'تسجيل' })).toBeTruthy();
  });

  it('going back to «وارد» while «مصروف» is chosen returns to the first category of that direction; «صادر» again keeps it', async () => {
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    expect(categoryBox(dialog).value).toBe('EXPENSE');

    direction(dialog, 'صادر'); // the direction it already has: nothing to reset
    expect(categoryBox(dialog).value).toBe('EXPENSE');

    direction(dialog, 'وارد');
    await waitFor(() => expect(categoryBox(dialog).value).toBe('ADJUSTMENT'));
    expect(within(dialog).queryByLabelText(/^نوع المصروف/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'تسجيل' })).toBeTruthy();
  });
});

/* ════════════════════════════════════════════════════════════════════════
   SAVING IT — THE WIRE
   ════════════════════════════════════════════════════════════════════════ */

describe('saving the expense', () => {
  it('sends ONE request, to the expense door, with exactly the body that door reads — and none to the movements door', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 11, 14, 30, 0));
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    fillExpense(dialog, { amount: '150.5', statement: '  إيجار المستودع  ', type: 'OFFICE', note: '  عن شهر تشرين  ' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toBe('/api/finance');
    expect(sent[0].body).toStrictEqual({
      title: 'إيجار المستودع',
      category: 'OFFICE',
      amount: 150.5,
      expenseDate: '2026-11-11',
      notes: 'عن شهر تشرين',
      walletId: 'w1',
    });
    expect(typeof sent[0].body.amount).toBe('number');
    expect(sent[0].headers['Content-Type']).toBe('application/json');
    // The movements door is never reached — it would refuse a movement filed under the expense.
    expect(sent.some((s) => s.url.includes('/movements'))).toBe(false);
  });

  it('the default type goes on the wire when none is picked, and an empty note goes as an empty string the door turns into «no notes»', async () => {
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    fillExpense(dialog, { amount: '20', statement: 'إعلان' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.category).toBe('MARKETING');
    expect(sent[0].body.notes).toBe('');
    expect(sent[0].body.walletId).toBe('w1');
  });

  it('closes the dialog, says it was recorded, and reads the wallets and the ledger again', async () => {
    as('finance.create');
    const dialog = await openDialog();
    const readsBefore = reads.length;
    chooseExpense(dialog);
    fillExpense(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));

    expect(await screen.findByText('سُجِّل المصروف — خُصم من الربح وخرج من المحفظة')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(reads.length).toBeGreaterThan(readsBefore));
    const after = reads.slice(readsBefore);
    expect(after).toContain('/api/finance/wallets');
    expect(after.some((u) => u.includes('/api/finance/wallets/w1/movements'))).toBe(true);
  });

  it('shows the sentence the server answered with, keeps the dialog and what was typed, and refreshes nothing', async () => {
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    fillExpense(dialog, { statement: 'إيجار المستودع' });
    const readsBefore = reads.length;

    refusal = { status: 404, body: { error: 'المحفظة غير موجودة أو موقوفة' } };
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));

    expect(await within(dialog).findByText('المحفظة غير موجودة أو موقوفة')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(statementBox(dialog).value).toBe('إيجار المستودع');
    expect(amountBox(dialog).value).toBe('150.5');
    expect(reads.length).toBe(readsBefore);
    // The button comes back, so the person can correct and press again.
    await waitFor(() => expect((within(dialog).getByRole('button', { name: 'تسجيل المصروف' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('a refusal for the key is shown the same way — the server is the judge, not the screen', async () => {
    // The screen believed the key was held (a role changed after the page loaded); the door says otherwise.
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    fillExpense(dialog);
    refusal = { status: 403, body: { error: 'ما عندك صلاحية تسجيل المصروفات' } };
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));
    expect(await within(dialog).findByText('ما عندك صلاحية تسجيل المصروفات')).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('/api/finance');
  });

  it('the body the dialog sent is accepted by the REAL expense door: one expense and one linked movement OUT, in the wallet\'s currency', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 11, 14, 30, 0));
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    fillExpense(dialog, { amount: '150.5', statement: 'إيجار المستودع', type: 'OFFICE', note: 'عن شهر تشرين' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));
    await waitFor(() => expect(sent).toHaveLength(1));

    const res = await EXPENSE_DOOR(
      new Request('http://localhost/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sent[0].body),
      })
    );
    expect(res.status).toBe(200);
    expect(requirePermission).toHaveBeenCalledWith('finance.create');

    expect(db.expense.create).toHaveBeenCalledTimes(1);
    const expense = db.expense.create.mock.calls[0][0].data;
    expect(expense).toMatchObject({
      companyId: 'c1',
      title: 'إيجار المستودع',
      category: 'OFFICE',
      amount: 150.5,
      notes: 'عن شهر تشرين',
      walletId: 'w1',
      storeId: 's1',
      createdById: 'u1',
    });
    expect(expense.expenseDate).toEqual(new Date('2026-11-11'));

    // The money that left the wallet is the same number, written once, in the wallet's own currency.
    expect(db.walletMovement.create).toHaveBeenCalledTimes(1);
    const movement = db.walletMovement.create.mock.calls[0][0].data;
    expect(movement).toMatchObject({
      walletId: 'w1',
      direction: 'OUT',
      amount: 150.5,
      currencyCode: 'USD',
      party: 'إيجار المستودع',
      category: 'EXPENSE',
      referenceType: 'EXPENSE',
      referenceId: 'exp-1',
    });
  });

  it('and with no note the door writes «مصروف: …» on the movement and no notes on the expense', async () => {
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    fillExpense(dialog, { amount: '20', statement: 'إعلان' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));
    await waitFor(() => expect(sent).toHaveLength(1));

    const res = await EXPENSE_DOOR(
      new Request('http://localhost/api/finance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sent[0].body),
      })
    );
    expect(res.status).toBe(200);
    expect(db.expense.create.mock.calls[0][0].data.notes).toBeNull();
    expect(db.walletMovement.create.mock.calls[0][0].data.note).toBe('مصروف: إعلان');
  });
});

/* ════════════════════════════════════════════════════════════════════════
   A WALLET IN ANOTHER CURRENCY THAN THE STORE'S
   ════════════════════════════════════════════════════════════════════════ */

describe('a wallet whose currency is not the store\'s', () => {
  const WARNING = /غير عملة المتجر/;

  it('says so once, before saving, and only for the expense', async () => {
    as('finance.create');
    const dialog = await openDialog({ storeCode: 'SYP' });
    expect(within(dialog).queryByText(WARNING)).toBeNull(); // a typed movement: nothing to say

    chooseExpense(dialog);
    const line = within(dialog).getByText(WARNING);
    expect(line.textContent).toContain('USD');
    expect(line.textContent).toContain('SYP');
    expect(line.textContent).toContain('بلا تحويل');
    expect(within(dialog).getAllByText(WARNING)).toHaveLength(1);

    fireEvent.change(categoryBox(dialog), { target: { value: 'OTHER' } });
    expect(within(dialog).queryByText(WARNING)).toBeNull();
  });

  it('says nothing when the two currencies are the same', async () => {
    as('finance.create');
    const dialog = await openDialog({ storeCode: 'USD' });
    chooseExpense(dialog);
    expect(within(dialog).queryByText(WARNING)).toBeNull();
  });

  it('says nothing when the shell does not know the store\'s currency', async () => {
    as('finance.create');
    const dialog = await openDialog();
    chooseExpense(dialog);
    expect(within(dialog).queryByText(WARNING)).toBeNull();
  });

  it('and it only says — the figure typed goes on the wire as it is, without any conversion', async () => {
    as('finance.create');
    const dialog = await openDialog({ storeCode: 'SYP' });
    chooseExpense(dialog);
    fillExpense(dialog, { amount: '50' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل المصروف' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].body.amount).toBe(50);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   THE OLD FLOW, AND THE DOOR THAT STAYS SHUT
   ════════════════════════════════════════════════════════════════════════ */

describe('the movement flow is the flow it was', () => {
  it('a typed «تسوية» goes to the movements door with the body it always had, and the screen says «سُجِّلت الحركة»', async () => {
    as('finance.create'); // even for who holds the expense key
    const dialog = await openDialog();
    fireEvent.change(amountBox(dialog), { target: { value: '40' } });
    fireEvent.change(statementBox(dialog), { target: { value: 'سامر' } });
    fireEvent.change(noteBox(dialog), { target: { value: 'تصحيح رصيد' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe('/api/finance/wallets/w1/movements');
    expect(sent[0].body).toStrictEqual({
      direction: 'OUT',
      amount: 40,
      party: 'سامر',
      category: 'ADJUSTMENT',
      note: 'تصحيح رصيد',
    });
    expect(await screen.findByText('سُجِّلت الحركة')).toBeTruthy();
    expect(sent.some((s) => s.url === '/api/finance')).toBe(false);
  });

  it('the movements door still refuses a typed «مصروف» in both directions, and names the door that writes it', () => {
    // The dialog may offer the choice only because it does NOT send it there.
    for (const d of ['IN', 'OUT'] as const) {
      const refusal = handMovementRefusal('EXPENSE', d)!;
      expect(refusal.code).toBe('EXPENSE_NOT_BY_HAND');
      expect(refusal.error).toContain('سجّل مصروفاً');
      expect(handMovementRefusal('COMMISSION', d)!.code).toBe('COMMISSION_NOT_BY_HAND');
    }
  });
});
