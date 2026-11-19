// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE EMPLOYEE'S SALARY, SHIFT AND COMMISSION CURRENCY SEND, BYTE FOR BYTE, WHAT THEY SENT (R16b2, 19/11)
 *
 * The three blocks on one employee's page moved onto the kit: `Button` for every press, `Card plain` for the
 * payslip's lines, 14px body and the 13px caption. The salary is money, so the rule is the strictest one: the screen
 * may look different, no figure on it may move and no request may change.
 *
 * So the copies as they stood on main (`*.as-on-main.test.tsx`, frozen) and the live files are driven through the
 * same presses, and must:
 *   - send the same requests — URL, method and body string — in the same order;
 *   - print the same text, figures included (the payslip's lines, the converted line, «يخرج من المحفظة», the
 *     commission still owed);
 *   - draw the same presses, fields and greyed buttons at the moment of the last press.
 * The golden path cannot run here (every local account has a second factor), so this differential is the proof.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  calls: [] as string[],
  phone: { value: false },
  slips: {} as Record<string, unknown>,
  write: { status: 200, body: {} as Record<string, unknown> },
  payFails: false,
}));

vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => h.phone.value }));
vi.mock('@/lib/api-client', () => ({
  apiJson: async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    h.calls.push(`api ${method} ${url} ${init?.body ?? ''}`);
    if (method === 'POST') {
      if (h.payFails) throw new Error('الرصيد لا يكفي');
      return { ok: true };
    }
    const slip = h.slips[url];
    if (!slip) throw new Error('تعذّر التحميل');
    return slip;
  },
}));

import { UserSalary as SalaryLive } from './UserSalary';
import { UserSalary as SalaryOnMain } from './UserSalary.as-on-main.test';
import { UserShift as ShiftLive } from './UserShift';
import { UserShift as ShiftOnMain } from './UserShift.as-on-main.test';
import { UserCommissionCurrency as CurrencyLive } from './UserCommissionCurrency';
import { UserCommissionCurrency as CurrencyOnMain } from './UserCommissionCurrency.as-on-main.test';

const USD_WALLET = { id: 'w1', name: 'الصندوق', currencyCode: 'USD', country: { minorUnit: 2 } };
const JOD_WALLET = { id: 'w2', name: 'صندوق الأردن', currencyCode: 'JOD', country: { minorUnit: 3 } };
const slip = (preview: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  period: { start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z', paid: null },
  preview: {
    salary: 300, currencyCode: 'USD', penaltyTotal: 0, net: 300, carriedOver: 0, penaltyIds: [], undecided: [],
    otherCurrency: [], converted: null, ...preview,
  },
  commission: [],
  wallets: [USD_WALLET, JOD_WALLET],
  ...extra,
});

beforeEach(() => {
  h.calls = [];
  h.phone.value = false;
  h.slips = {};
  h.write = { status: 200, body: { success: true } };
  h.payFails = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      h.calls.push(`fetch ${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
      return { ok: h.write.status < 300, status: h.write.status, json: async () => h.write.body };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const census = () => ({
  buttons: screen.queryAllByRole('button').map((b) => `${b.textContent?.trim()}${(b as HTMLButtonElement).disabled ? ' (مطفي)' : ''}`),
  fields: screen.queryAllByRole('spinbutton').length + screen.queryAllByRole('textbox').length,
  lists: screen.queryAllByRole('combobox').length,
  dialogs: screen.queryAllByRole('dialog').length,
});

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

async function run(ui: React.ReactElement, script: () => Promise<void>) {
  h.calls = [];
  render(ui);
  await settle();
  await script();
  await settle();
  const out = { calls: [...h.calls], census: census(), text: document.body.textContent };
  cleanup();
  return out;
}

async function same(live: React.ReactElement, onMain: React.ReactElement, script: () => Promise<void>) {
  const a = await run(live, script);
  const b = await run(onMain, script);
  expect(a.calls, 'الطلبات اختلفت عن main').toEqual(b.calls);
  expect(a.text, 'نص أو رقم على الشاشة اختلف عن main').toBe(b.text);
  expect(a.census, 'الأزرار أو الحقول اختلفت عن main').toEqual(b.census);
  return a;
}

const press = async (name: string | RegExp) => {
  fireEvent.click(screen.getByRole('button', { name }));
  await settle();
};
const dialog = () => screen.getByRole('dialog');

/* ───────────────────────── الراتب ───────────────────────── */

const salary = (C: typeof SalaryLive, p: Partial<React.ComponentProps<typeof SalaryLive>> = {}) => (
  <C userId="u1" initial={{ salaryAmount: 300, salaryCurrency: 'USD' }} canEdit canPay {...p} />
);

describe('الراتب — the same requests and the same figures as main', () => {
  it('saving a new amount and currency sends the same PATCH', async () => {
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      const [amount] = screen.getAllByRole('spinbutton');
      fireEvent.change(amount, { target: { value: '450.5' } });
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'jod' } });
      await press('احفظ');
    });
    expect(out.calls).toEqual([
      'fetch PATCH /api/users/u1 {"action":"updateContact","salaryAmount":450.5,"salaryCurrency":"JOD"}',
    ]);
    expect(out.text).toContain('حُفظ.');
  });

  it('clearing the amount sends null, and a refusal prints the server’s own sentence', async () => {
    h.write = { status: 400, body: { error: 'المبلغ غير صالح' } };
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '' } });
      await press('احفظ');
    });
    expect(out.calls).toEqual(['fetch PATCH /api/users/u1 {"action":"updateContact","salaryAmount":null,"salaryCurrency":"USD"}']);
    expect(out.text).toContain('المبلغ غير صالح');
    expect(out.text).toContain('لا راتب مسجّل.');
  });

  it('the payslip prints every line the same — deductions, the undecided, the carried-over, the other currency, the commission', async () => {
    h.slips['/api/payroll/payslip?userId=u1'] = slip(
      {
        penaltyTotal: 12.25, net: 287.75, carriedOver: 4.5, penaltyIds: ['p1', 's1'],
        undecided: [{ id: 's1', amount: 2, currencyCode: 'USD' }], otherCurrency: [{ currencyCode: 'JOD', amount: 0.5 }],
      },
      { commission: [{ currencyCode: 'USD', amount: 37.5 }, { currencyCode: 'EGP', amount: 120 }] }
    );
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      await press(/اصرف الراتب/);
    });
    for (const figure of ['300 USD', '− 12.25', '2 USD', '287.75 USD', '4.5', 'خصومات بعملة JOD — لا تُطرح من راتب بعملة أخرى']) {
      expect(out.text, figure).toContain(figure);
    }
    expect(out.calls).toEqual(['api GET /api/payroll/payslip?userId=u1 ']);
  });

  it('converting another currency, picking a wallet in a third and paying: same preview door, same POST', async () => {
    h.slips['/api/payroll/payslip?userId=u1'] = slip({ otherCurrency: [{ currencyCode: 'JOD', amount: 0.5 }] });
    h.slips['/api/payroll/payslip?userId=u1&convertCurrency=JOD&convertRate=1.41'] = slip({
      penaltyTotal: 0.71, net: 299.29, penaltyIds: ['j1'],
      converted: { currencyCode: 'JOD', rate: 1.41, amount: 0.5, inSalaryCurrency: 0.71 },
    });
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      await press(/اصرف الراتب/);
      fireEvent.change(within(dialog()).getAllByRole('spinbutton')[0], { target: { value: '1.41' } });
      await press('طبّق السعر');
      fireEvent.change(within(dialog()).getAllByRole('combobox').at(-1)!, { target: { value: 'w2' } });
      const rate = within(dialog()).getAllByRole('spinbutton').at(-1)!;
      fireEvent.change(rate, { target: { value: '0.709' } });
      await settle();
      await press('اصرف');
    });
    expect(out.calls).toEqual([
      'api GET /api/payroll/payslip?userId=u1 ',
      'api GET /api/payroll/payslip?userId=u1&convertCurrency=JOD&convertRate=1.41 ',
      'api POST /api/payroll/payslip {"userId":"u1","walletId":"w2","exchangeRate":0.709,"convert":{"currencyCode":"JOD","rate":1.41}}',
    ]);
    expect(out.text).toContain('صُرف الراتب.');
  });

  it('the figure that leaves the wallet, the rate sentence and the refused payment read the same', async () => {
    h.slips['/api/payroll/payslip?userId=u1'] = slip({});
    h.payFails = true;
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      await press(/اصرف الراتب/);
      fireEvent.change(within(dialog()).getAllByRole('combobox').at(-1)!, { target: { value: 'w2' } });
      fireEvent.change(within(dialog()).getAllByRole('spinbutton').at(-1)!, { target: { value: '0.709' } });
      await settle();
      await press('اصرف');
    });
    expect(out.text).toContain('يخرج من المحفظة');
    expect(out.text).toContain('بالسعر الذي كتبته أنت');
    expect(out.text).toContain('الرصيد لا يكفي');
    expect(out.calls.at(-1)).toBe('api POST /api/payroll/payslip {"userId":"u1","walletId":"w2","exchangeRate":0.709}');
  });

  it('a wallet in the salary’s own currency pays at 1, no rate field — the same as main', async () => {
    h.slips['/api/payroll/payslip?userId=u1'] = slip({});
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      await press(/اصرف الراتب/);
      fireEvent.change(within(dialog()).getAllByRole('combobox').at(-1)!, { target: { value: 'w1' } });
      await settle();
      await press('اصرف');
    });
    expect(out.calls.at(-1)).toBe('api POST /api/payroll/payslip {"userId":"u1","walletId":"w1","exchangeRate":1}');
  });

  it('NEGATIVE: a period already paid keeps «اصرف» off with the same reason, and sends nothing', async () => {
    h.slips['/api/payroll/payslip?userId=u1'] = slip({}, { period: { start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z', paid: { id: 'x', netAmount: 300, createdAt: '2026-11-01T00:00:00Z' } } });
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      await press(/اصرف الراتب/);
      fireEvent.change(within(dialog()).getAllByRole('combobox').at(-1)!, { target: { value: 'w1' } });
      await settle();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'اصرف' }));
      await settle();
    });
    expect(out.census.buttons).toContain('اصرف (مطفي)');
    expect(out.calls).toEqual(['api GET /api/payroll/payslip?userId=u1 ']);
  });

  it('a phone draws the wallet box the same way', async () => {
    h.phone.value = true;
    h.slips['/api/payroll/payslip?userId=u1'] = slip({});
    await same(salary(SalaryLive), salary(SalaryOnMain), async () => {
      await press(/اصرف الراتب/);
    });
  });
});

/* ───────────────────────── الدوام ───────────────────────── */

const shift = (C: typeof ShiftLive, p: Partial<React.ComponentProps<typeof ShiftLive>> = {}) => (
  <C userId="u1" initial={{ shiftStart: null, shiftEnd: null, restDays: null }} canEdit {...p} />
);
const timeBoxes = () => Array.from(document.querySelectorAll('input[type="time"]')) as HTMLInputElement[];

describe('الدوام — the same requests as main', () => {
  it('a shift and two rest days send the same PATCH', async () => {
    const out = await same(shift(ShiftLive), shift(ShiftOnMain), async () => {
      fireEvent.change(timeBoxes()[0], { target: { value: '12:00' } });
      fireEvent.change(timeBoxes()[1], { target: { value: '20:00' } });
      await press('الجمعة');
      await press('السبت');
      await press('احفظ');
    });
    expect(out.calls).toEqual([
      'fetch PATCH /api/users/u1 {"action":"updateContact","shiftStart":"12:00","shiftEnd":"20:00","restDays":"5,6"}',
    ]);
  });

  it('«أعد عطلة البلد» sends null rest days', async () => {
    const out = await same(
      shift(ShiftLive, { initial: { shiftStart: '09:00', shiftEnd: '17:00', restDays: '5' } }),
      shift(ShiftOnMain, { initial: { shiftStart: '09:00', shiftEnd: '17:00', restDays: '5' } }),
      async () => {
        await press('أعد عطلة البلد');
        await press('احفظ');
      }
    );
    expect(out.calls).toEqual(['fetch PATCH /api/users/u1 {"action":"updateContact","shiftStart":"09:00","shiftEnd":"17:00","restDays":null}']);
  });

  it('NEGATIVE: a hand-over before the start keeps «احفظ» off with the same sentence, and sends nothing', async () => {
    const out = await same(shift(ShiftLive), shift(ShiftOnMain), async () => {
      fireEvent.change(timeBoxes()[0], { target: { value: '18:00' } });
      fireEvent.change(timeBoxes()[1], { target: { value: '09:00' } });
      await settle();
      fireEvent.click(screen.getByRole('button', { name: 'احفظ' }));
      await settle();
    });
    expect(out.calls).toEqual([]);
    expect(out.text).toContain('وقت التسليم يجب أن يكون بعد وقت البدء.');
    expect(out.census.buttons).toContain('احفظ (مطفي)');
  });
});

/* ───────────────────────── عملة العمولة ───────────────────────── */

const currency = (C: typeof CurrencyLive, p: Partial<React.ComponentProps<typeof CurrencyLive>> = {}) => (
  <C userId="u1" initial={null} canEdit {...p} />
);

describe('عملة العمولة — the same requests as main', () => {
  it('choosing a currency sends the same PATCH', async () => {
    const out = await same(currency(CurrencyLive), currency(CurrencyOnMain), async () => {
      fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'JOD' } });
      await settle();
      await press('حفظ');
    });
    expect(out.calls).toEqual(['fetch PATCH /api/users/u1 {"action":"updateContact","commissionCurrency":"JOD"}']);
  });

  it('«استخدم عملة المتجر» then «حفظ» sends an empty code', async () => {
    const out = await same(currency(CurrencyLive, { initial: 'JOD' }), currency(CurrencyOnMain, { initial: 'JOD' }), async () => {
      await press('استخدم عملة المتجر');
      await press('حفظ');
    });
    expect(out.calls).toEqual(['fetch PATCH /api/users/u1 {"action":"updateContact","commissionCurrency":""}']);
  });
});

/* ───────────────────── what each key set draws ───────────────────── */

/*
 * The keys are read where they are, in UserDetailScreen.tsx (R16b1's file, unchanged here):
 *   salary  — drawn for `payroll.view`; canEdit = canPay = `payroll.pay`
 *   shift   — canEdit = `users.edit` && `users.shift`
 *   currency — canEdit = `payroll.pay` && `users.edit`
 * So the three components are drawn per those booleans and must draw exactly the presses main drew.
 */
describe('each key set draws exactly the presses main drew', () => {
  it('payroll.view only — no «احفظ», no «اصرف الراتب»; the fields locked', async () => {
    const out = await same(salary(SalaryLive, { canEdit: false, canPay: false }), salary(SalaryOnMain, { canEdit: false, canPay: false }), async () => {});
    expect(out.census.buttons).toEqual([]);
  });

  it('payroll.pay — «احفظ» and «اصرف الراتب»; no pay button without a recorded salary', async () => {
    const out = await same(salary(SalaryLive), salary(SalaryOnMain), async () => {});
    expect(out.census.buttons).toEqual(['احفظ (مطفي)', 'اصرف الراتب']);
    const none = await same(
      salary(SalaryLive, { initial: { salaryAmount: null, salaryCurrency: null } }),
      salary(SalaryOnMain, { initial: { salaryAmount: null, salaryCurrency: null } }),
      async () => {}
    );
    expect(none.census.buttons).toEqual(['احفظ (مطفي)']);
  });

  it('the shift without its key — seven locked days, no «احفظ», no «أعد عطلة البلد»', async () => {
    const out = await same(
      shift(ShiftLive, { canEdit: false, initial: { shiftStart: null, shiftEnd: null, restDays: '5' } }),
      shift(ShiftOnMain, { canEdit: false, initial: { shiftStart: null, shiftEnd: null, restDays: '5' } }),
      async () => {}
    );
    expect(out.census.buttons).toHaveLength(7);
    expect(out.census.buttons.every((b) => b.endsWith('(مطفي)'))).toBe(true);
  });

  it('the currency without its keys — the saved code printed, no press', async () => {
    const out = await same(currency(CurrencyLive, { canEdit: false, initial: 'EGP' }), currency(CurrencyOnMain, { canEdit: false, initial: 'EGP' }), async () => {});
    expect(out.census.buttons).toEqual([]);
    expect(out.text).toContain('EGP');
  });
});

/* ───────────────────────── the kit, and the phone ───────────────────────── */

const FILES = ['UserSalary', 'UserShift', 'UserCommissionCurrency'].map((n) => `src/components/screens/users/${n}.tsx`);
// Built from pieces so the stylesheet scanner never reads a class here.
const SMALL = ['text', 'xs'].join('-');
const FIXED_WIDE = new RegExp(['\\bw', '-\\[\\d{3,}px\\]'].join(''));

describe('the three blocks wear the kit', () => {
  it('no 12px text is left, and no raw press except the seven day chips (a toggle row, listed for R19)', () => {
    for (const f of FILES) {
      const src = stripComments(repoFile(f));
      expect(src.includes(SMALL), `${f}: نص 12px رجع`).toBe(false);
      expect(FIXED_WIDE.test(src), `${f}: عرض ثابت أكبر من الشاشة`).toBe(false);
    }
    expect(stripComments(repoFile(FILES[0])).match(/<button\b/g), 'الراتب: زرّ خام رجع').toBeNull();
    expect(stripComments(repoFile(FILES[2])).match(/<button\b/g), 'العملة: زرّ خام رجع').toBeNull();
    expect(stripComments(repoFile(FILES[1])).match(/<button\b/g), 'الدوام: غير شرائح الأيام').toHaveLength(1);
  });

  it('every kit Button says type="button" (the kit sets no default type)', () => {
    for (const f of FILES) {
      const src = stripComments(repoFile(f));
      const opens = [...src.matchAll(/<Button\b[^>]*>/g)].map((m) => m[0]);
      expect(opens.length, f).toBeGreaterThan(0);
      for (const o of opens) expect(o, `${f}: زرّ بلا type`).toContain('type="button"');
    }
  });

  it('presses that run a promise keep the screen’s own busy flag (`void` wrapper): a second press during a save sends nothing', async () => {
    let release!: () => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({}) }); })));
    render(salary(SalaryLive));
    fireEvent.change(screen.getAllByRole('spinbutton')[0], { target: { value: '500' } });
    const save = screen.getByRole('button', { name: 'احفظ' }) as HTMLButtonElement;
    fireEvent.click(save);
    await settle();
    // The screen's own flag: the label says «جارٍ…» (the kit's spinner would have hidden it).
    expect(screen.getByRole('button', { name: 'جارٍ…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'جارٍ…' }).getAttribute('aria-busy')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'جارٍ…' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { release(); });
  });

  it('the payslip lines sit on a plain kit card: the card fill and edge, no theme decoration', async () => {
    h.slips['/api/payroll/payslip?userId=u1'] = slip({});
    render(salary(SalaryLive));
    await press(/اصرف الراتب/);
    const line = within(dialog()).getByText('الصافي').parentElement!.parentElement!;
    expect(line.className).toContain('divide-y');
    expect(line.className).toContain('bg-[var(--sys-card)]');
    expect(line.className).toContain('border-[var(--sys-border)]');
    expect(line.className).not.toContain(['zk', 'card'].join('-'));
  });

  it('PHONE (jsdom, 375px): every press is 44px tall, the wallet box takes its line', async () => {
    h.phone.value = true;
    h.slips['/api/payroll/payslip?userId=u1'] = slip({ otherCurrency: [{ currencyCode: 'JOD', amount: 0.5 }] });
    render(salary(SalaryLive));
    for (const b of screen.getAllByRole('button')) expect(b.className, b.textContent ?? '').toMatch(/(^|\s)(min-)?h-11(\s|$)/);
    await press(/اصرف الراتب/);
    for (const b of within(dialog()).getAllByRole('button').filter((x) => x.textContent?.trim())) {
      expect(b.className, b.textContent ?? '').toMatch(/(^|\s)(min-)?h-11(\s|$)/);
    }
    expect(within(dialog()).getAllByRole('combobox').at(-1)!.className).toContain('w-full');
    cleanup();
    render(shift(ShiftLive, { initial: { shiftStart: null, shiftEnd: null, restDays: '5' } }));
    for (const b of screen.getAllByRole('button')) expect(b.className, b.textContent ?? '').toMatch(/(^|\s)(min-)?h-11(\s|$)/);
    cleanup();
    render(currency(CurrencyLive, { initial: 'JOD' }));
    for (const b of screen.getAllByRole('button')) expect(b.className, b.textContent ?? '').toMatch(/(^|\s)(min-)?h-11(\s|$)/);
  });

  it('the main presses are primary, the others are not', () => {
    render(salary(SalaryLive));
    const primary = (name: string) => screen.getByRole('button', { name: new RegExp(name) }).className.includes('bg-[var(--sys-primary)]');
    expect(primary('احفظ')).toBe(true);
    expect(primary('اصرف الراتب')).toBe(false);
    cleanup();
    render(currency(CurrencyLive, { initial: 'JOD' }));
    expect(screen.getByRole('button', { name: 'حفظ' }).className).toContain('bg-[var(--sys-primary)]');
    expect(screen.getByRole('button', { name: 'استخدم عملة المتجر' }).className).toContain('bg-transparent');
  });
});
