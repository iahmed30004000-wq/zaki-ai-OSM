// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * «حركة جديدة» — «سحب شريك» IS A KIND OF THE DIALOG, FOR THE HOLDERS OF `finance.partners` (13/11).
 *
 * «السحوبات لازم تنضاف بند … اذا حد تجاوز نسبة سحبة نسبة الربح بينعد مكسور عليه» (the owner). Chosen after «مصروف» in the same box, it
 * turns the dialog into the draw form — partner, amount, the equivalent in the store's currency when the wallet holds another, an optional
 * note and the live sentence «نصيبه من الصافي · سحب لحد هلق · بعد هالسحب» — and sends it to the PARTNERS' door, nowhere else.
 *
 *   · it is offered going OUT, to nobody without the key (not even a role that holds every other finance key), and the people without it
 *     are never asked for the statement;
 *   · a draw past the share is NOT blocked: the sentence says «مكسور عليه» and the button still sends it;
 *   · every OTHER kind still sends exactly what it sent.
 */

const { who, sent, reads, answers } = vi.hoisted(() => ({
  who: { role: 'CUSTOM', keys: [] as string[] },
  sent: [] as { url: string; method: string; body: Record<string, unknown> }[],
  reads: [] as string[],
  answers: { statement: null as unknown, refusal: null as { status: number; body: unknown } | null, wallet: null as unknown },
}));

vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: who.role, permissions: who.keys } }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));

import { StoreCurrencyProvider } from '@/context/StoreCurrency';
import { WalletsScreen } from './WalletsScreen';

const USD_WALLET = {
  id: 'w1', name: 'الصندوق', currencyCode: 'USD', isActive: true, opening: 0, in: 0, out: 0, balance: 0,
  movements: 0, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
};
const JOD_WALLET = { ...USD_WALLET, id: 'w2', name: 'صندوق الدينار', currencyCode: 'JOD' };

const line = (id: string, name: string, share: number, entitlement: number | null, draws: number, isActive = true) => ({
  id, name, sharePercent: share, isActive, entitlement, draws,
  balance: entitlement === null ? null : entitlement - draws, broken: entitlement === null ? null : Math.max(0, draws - entitlement),
});
const statementOf = (over: Record<string, unknown> = {}) => ({
  state: 'OK', sharesTotal: 100, currency: 'USD', minorUnit: 2, netProfit: 1000, uncounted: 0, draws: [],
  trust: { level: 'STATED', present: 10, population: 10, share: 100, ar: 'x' },
  totals: { entitlement: 1000, draws: 100, broken: 0 },
  lines: [line('mk', 'محمد كوري', 15, 150, 100), line('ah', 'احمد كيوان', 55, 550, 0), line('old', 'شريك سابق', 10, 0, 0, false)],
  ...over,
});

/** The key of the movements door's dialog, plus whatever the case adds. */
const as = (...extra: string[]) => {
  who.role = 'CUSTOM';
  who.keys = ['finance.cashbox_view', 'finance.cashbox', ...extra];
};

beforeEach(() => {
  vi.clearAllMocks();
  who.role = 'CUSTOM';
  who.keys = [];
  sent.length = 0;
  reads.length = 0;
  answers.statement = statementOf();
  answers.refusal = null;
  answers.wallet = USD_WALLET;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : {} });
        if (answers.refusal) return json(answers.refusal.body, answers.refusal.status);
        return url === '/api/finance/partners/draws' ? json({ movement: { id: 'm1' } }, 201) : json({ movement: { id: 'm1' } }, 201);
      }
      reads.push(url);
      if (url === '/api/finance/partners/statement') return answers.statement instanceof Error ? json({ error: 'x' }, 500) : json(answers.statement);
      if (url.includes('/movements')) return json({ movements: [] });
      return json({ wallets: [answers.wallet] });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openDialog(storeCode = 'USD') {
  render(
    <StoreCurrencyProvider code={storeCode}>
      <WalletsScreen />
    </StoreCurrencyProvider>
  );
  // The wallet's own press: the LAST «حركة جديدة» (the one at the top of the screen comes first, and is held by its own test file).
  fireEvent.click((await screen.findAllByText('حركة جديدة')).at(-1)!);
  return screen.findByRole('dialog');
}

/** The kind box, by its label — in the draw form the partner box sits above it, so «the first select» is no longer the kind. */
const categoryBox = (d: HTMLElement) => within(d).getByLabelText(/^البند/) as HTMLSelectElement;
const options = (d: HTMLElement) =>
  within(categoryBox(d)).getAllByRole('option').map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled, text: o.textContent ?? '' }));
const choosable = (d: HTMLElement) => options(d).filter((o) => !o.disabled).map((o) => o.value);
const partnerBox = (d: HTMLElement) => within(d).getByLabelText('الشريك') as HTMLSelectElement;
const amountBox = (d: HTMLElement) => within(d).getByLabelText(/^المبلغ/) as HTMLInputElement;
const valueBox = (d: HTMLElement) => within(d).queryByLabelText(/^ما يعادله بعملة المتجر/) as HTMLInputElement | null;
const noteBox = (d: HTMLElement) => within(d).getByLabelText(/^الملاحظة/) as HTMLInputElement;
const send = (d: HTMLElement) => within(d).getByRole('button', { name: 'تسجيل السحب' }) as HTMLButtonElement;
const chooseDraw = async (d: HTMLElement) => {
  await waitFor(() => expect(choosable(d)).toContain('PARTNER_DRAW'));
  fireEvent.change(categoryBox(d), { target: { value: 'PARTNER_DRAW' } });
  // the partners are read once, when the dialog opens: wait for them to be in the box
  await waitFor(() => expect(within(partnerBox(d)).getAllByRole('option').length).toBeGreaterThan(1));
};
const hintText = (d: HTMLElement) => d.textContent ?? '';
const writes = () => sent.filter((s) => s.method !== 'GET');

describe('who is offered «سحب شريك»', () => {
  it('whoever holds finance.partners can choose it going OUT — listed right after «مصروف» and before «عمولة»', async () => {
    as('finance.create', 'finance.partners');
    const dialog = await openDialog();
    expect(options(dialog).map((o) => o.value)).toEqual(['ADJUSTMENT', 'OTHER', 'EXPENSE', 'PARTNER_DRAW', 'COMMISSION']);
    expect(choosable(dialog)).toEqual(['ADJUSTMENT', 'OTHER', 'EXPENSE', 'PARTNER_DRAW']);
    expect(options(dialog).find((o) => o.value === 'PARTNER_DRAW')?.text).toBe('سحب شريك');
  });

  it('without finance.create the expense is greyed, and «سحب شريك» is still the partners’ key’s own', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    expect(options(dialog).map((o) => [o.value, o.disabled])).toEqual([
      ['ADJUSTMENT', false], ['OTHER', false], ['EXPENSE', true], ['PARTNER_DRAW', false], ['COMMISSION', true],
    ]);
  });

  it('NEGATIVE: a role that holds EVERY other finance key but not «الشركاء والسحوبات» is not offered it — not even greyed, not by name', async () => {
    as('finance.view', 'finance.create', 'finance.update', 'finance.wallets_manage', 'finance.closing_approve', 'settlement.approve', 'costs.view');
    const dialog = await openDialog();
    expect(options(dialog).map((o) => o.value)).toEqual(['ADJUSTMENT', 'OTHER', 'EXPENSE', 'COMMISSION']);
    expect(dialog.textContent).not.toContain('سحب شريك');
    expect(dialog.textContent).not.toContain('الشركاء');
  });

  it('and NEGATIVE: such a person is never asked for the statement — nobody without the key reads the partners', async () => {
    as('finance.create');
    await openDialog();
    expect(reads).not.toContain('/api/finance/partners/statement');
  });

  it('the owner holds every key, so it is offered to him', async () => {
    who.role = 'SUPER_ADMIN';
    who.keys = [];
    const dialog = await openDialog();
    expect(choosable(dialog)).toContain('PARTNER_DRAW');
  });

  it('only going OUT: coming IN it is not offered at all (a draw coming back is a reversal), and the choice falls back', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'وارد' }));
    await waitFor(() => expect(choosable(dialog)).toEqual(['ADJUSTMENT', 'OTHER']));
    expect(options(dialog).some((o) => o.value === 'PARTNER_DRAW')).toBe(false);
    expect(categoryBox(dialog).value).toBe('ADJUSTMENT');
  });

  it('the holders read the statement ONCE, when the dialog opens', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    expect(reads.filter((u) => u === '/api/finance/partners/statement')).toHaveLength(1);
  });
});

describe('the draw form: partner, amount, note — and no «الطرف»', () => {
  it('turns the dialog into the draw form: the partner box with the ACTIVE partners only, the note optional, a button of its own', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    expect(within(partnerBox(dialog)).getAllByRole('option').map((o) => o.textContent)).toEqual(['اختر الشريك…', 'محمد كوري', 'احمد كيوان']);
    expect(within(dialog).queryByLabelText('الطرف')).toBeNull();
    expect(noteBox(dialog).required).toBe(false);
    expect(within(dialog).getByText('الملاحظة (اختيارية)')).toBeTruthy();
    expect(send(dialog).disabled).toBe(true);
    expect(valueBox(dialog)).toBeNull();
  });

  it('the button waits for a partner and an amount', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(amountBox(dialog), { target: { value: '100' } });
    expect(send(dialog).disabled).toBe(true);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    expect(send(dialog).disabled).toBe(false);
    fireEvent.change(amountBox(dialog), { target: { value: '0' } });
    expect(send(dialog).disabled).toBe(true);
  });

  it('a draw in the store’s own currency: ONE request, to the partners’ door, with exactly the characters typed — and nothing else', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '100' } });
    fireEvent.click(send(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/finance/partners/draws',
      method: 'POST',
      body: { walletId: 'w1', partnerId: 'mk', amount: '100' },
    });
    // not the movements door and not the expense door
    expect(sent.some((s) => s.url.includes('/movements') || s.url === '/api/finance')).toBe(false);
  });

  it('a typed note goes with it, trimmed; an empty one is not sent', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'ah' } });
    fireEvent.change(amountBox(dialog), { target: { value: '12.5' } });
    fireEvent.change(noteBox(dialog), { target: { value: '  مصروف البيت  ' } });
    fireEvent.click(send(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w1', partnerId: 'ah', amount: '12.5', note: 'مصروف البيت' });
  });

  it('the door’s refusal is printed and the dialog stays open — nothing is said to have been saved', async () => {
    as('finance.partners');
    answers.refusal = { status: 409, body: { error: 'سجّلت نفس السحب قبل لحظات — ما انسجّل مرتين.', code: 'DUPLICATE_DRAW' } };
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '100' } });
    fireEvent.click(send(dialog));
    expect(await within(dialog).findByText(/ما انسجّل مرتين/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });

  it('no partner saved: it says so, and the button stays shut', async () => {
    as('finance.partners');
    answers.statement = statementOf({ state: 'NO_PARTNERS', lines: [] });
    const dialog = await openDialog();
    await waitFor(() => expect(choosable(dialog)).toContain('PARTNER_DRAW'));
    fireEvent.change(categoryBox(dialog), { target: { value: 'PARTNER_DRAW' } });
    expect(await within(dialog).findByText(/ما في شركاء فعّالين/)).toBeTruthy();
    fireEvent.change(amountBox(dialog), { target: { value: '100' } });
    expect(send(dialog).disabled).toBe(true);
  });

  it('the statement cannot be read: it says so, and the button stays shut — a draw is never sent blind', async () => {
    as('finance.partners');
    answers.statement = new Error('x');
    const dialog = await openDialog();
    await waitFor(() => expect(choosable(dialog)).toContain('PARTNER_DRAW'));
    fireEvent.change(categoryBox(dialog), { target: { value: 'PARTNER_DRAW' } });
    expect(await within(dialog).findByText(/تعذّر تحميل الشركاء/)).toBeTruthy();
    fireEvent.change(amountBox(dialog), { target: { value: '100' } });
    expect(send(dialog).disabled).toBe(true);
  });
});

describe('THE CURRENCY: a wallet in another currency than the store’s', () => {
  beforeEach(() => {
    answers.wallet = JOD_WALLET;
  });

  it('asks «ما يعادله بعملة المتجر (USD)» — required — and the button waits for it', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    const box = valueBox(dialog)!;
    expect(box).toBeTruthy();
    expect(box.required).toBe(true);
    expect(within(dialog).getByText('ما يعادله بعملة المتجر (USD)')).toBeTruthy();
    expect(within(dialog).getByText(/غير عملة المتجر \(USD\)/)).toBeTruthy();
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '70' } });
    expect(send(dialog).disabled).toBe(true);
    fireEvent.change(box, { target: { value: '98.7' } });
    expect(send(dialog).disabled).toBe(false);
  });

  it('sends both figures as typed: the wallet’s amount and the store’s equivalent', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '70' } });
    fireEvent.change(valueBox(dialog)!, { target: { value: '98.7' } });
    fireEvent.click(send(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toEqual({ walletId: 'w2', partnerId: 'mk', amount: '70', valueInStoreCurrency: '98.7' });
  });

  it('the live sentence counts the EQUIVALENT, not the dinars', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '70' } });
    fireEvent.change(valueBox(dialog)!, { target: { value: '30' } });
    // 150 - 100 drawn = 50 left; 30 of it: 20 stays
    expect(hintText(dialog)).toContain('بعد هالسحب: بيضل له 20.00 USD');
    fireEvent.change(valueBox(dialog)!, { target: { value: '60' } });
    expect(hintText(dialog)).toContain('بعد هالسحب: مكسور عليه 10.00 USD');
  });
});

describe('«نصيبه من الصافي · سحب لحد هلق · بعد هالسحب» — and the draw is never blocked', () => {
  const open = async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    return dialog;
  };

  it('as soon as the partner is chosen: his share of the net and what he has drawn so far', async () => {
    const dialog = await open();
    expect(hintText(dialog)).toContain('نصيبه من الصافي 150.00 USD · سحب لحد هلق 100.00 USD');
    expect(hintText(dialog)).not.toContain('بعد هالسحب');
  });

  it('a draw inside the share says what is left', async () => {
    const dialog = await open();
    fireEvent.change(amountBox(dialog), { target: { value: '30' } });
    expect(hintText(dialog)).toContain('بعد هالسحب: بيضل له 20.00 USD');
  });

  it('EQUAL IS NOT BROKEN: a draw of exactly what is left leaves zero', async () => {
    const dialog = await open();
    fireEvent.change(amountBox(dialog), { target: { value: '50' } });
    expect(hintText(dialog)).toContain('بعد هالسحب: بيضل له 0.00 USD');
    // (the line under the kind box explains «مكسور عليه» in general; the live sentence is the one that must not say it)
    expect(within(dialog).queryByText(/بعد هالسحب: مكسور عليه/)).toBeNull();
  });

  it('ONE CENT over: «مكسور عليه 0.01 USD» — in red', async () => {
    const dialog = await open();
    fireEvent.change(amountBox(dialog), { target: { value: '50.01' } });
    const broken = within(dialog).getByText(/بعد هالسحب: مكسور عليه/);
    expect(broken.textContent).toContain('0.01 USD');
    expect(broken.className).toContain('text-[var(--sys-destructive)]');
  });

  it('a draw far past the share is STILL SENT: «مكسور عليه» is a message, the press goes through', async () => {
    const dialog = await open();
    fireEvent.change(amountBox(dialog), { target: { value: '900' } });
    expect(hintText(dialog)).toContain('بعد هالسحب: مكسور عليه 850.00 USD');
    expect(send(dialog).disabled).toBe(false);
    fireEvent.click(send(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ partnerId: 'mk', amount: '900' });
  });

  it('it is the statement’s own subtraction: changing the partner changes the sentence, and a bad number says nothing', async () => {
    const dialog = await open();
    fireEvent.change(amountBox(dialog), { target: { value: '30' } });
    fireEvent.change(partnerBox(dialog), { target: { value: 'ah' } });
    expect(hintText(dialog)).toContain('نصيبه من الصافي 550.00 USD · سحب لحد هلق 0.00 USD');
    expect(hintText(dialog)).toContain('بعد هالسحب: بيضل له 520.00 USD');
    fireEvent.change(amountBox(dialog), { target: { value: '-4' } });
    expect(hintText(dialog)).not.toContain('بعد هالسحب');
  });

  it('shares that cannot be cut: the sentence says so instead of figures — and the draw is still allowed', async () => {
    as('finance.partners');
    answers.statement = statementOf({ state: 'SHARES_NOT_100', lines: [line('mk', 'محمد كوري', 15, null, 100), line('ah', 'احمد كيوان', 80, null, 0)] });
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '30' } });
    expect(hintText(dialog)).toContain('الصافي ما انقسم لأن مجموع النسب مش 100');
    expect(send(dialog).disabled).toBe(false);
  });
});

describe('every OTHER kind still sends exactly what it sent', () => {
  it('a hand movement from a partners-holder: the movements door, the old body, the «الطرف» box and a required note', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await waitFor(() => expect(choosable(dialog)).toContain('PARTNER_DRAW'));
    fireEvent.change(within(dialog).getByLabelText('الطرف'), { target: { value: 'مورّد' } });
    fireEvent.change(amountBox(dialog), { target: { value: '25.5' } });
    expect(noteBox(dialog).required).toBe(true);
    fireEvent.change(noteBox(dialog), { target: { value: 'دفعة شهرية' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'تسجيل' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/finance/wallets/w1/movements',
      method: 'POST',
      body: { direction: 'OUT', amount: 25.5, party: 'مورّد', category: 'ADJUSTMENT', note: 'دفعة شهرية' },
    });
  });

  it('choosing the draw and going back to another kind brings the old form back — «الطرف» and the required note', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    await chooseDraw(dialog);
    fireEvent.change(categoryBox(dialog), { target: { value: 'OTHER' } });
    expect(within(dialog).getByLabelText('الطرف')).toBeTruthy();
    expect(within(dialog).queryByLabelText('الشريك')).toBeNull();
    expect(noteBox(dialog).required).toBe(true);
    expect(within(dialog).getByRole('button', { name: 'تسجيل' })).toBeTruthy();
  });
});

describe('the press from the TOP of the screen opens the same dialog — with the same kinds', () => {
  /** The top button comes first in the page: the wallet's own press is the last «حركة جديدة». */
  const openFromTop = async () => {
    render(
      <StoreCurrencyProvider code="USD">
        <WalletsScreen />
      </StoreCurrencyProvider>
    );
    fireEvent.click((await screen.findAllByText('حركة جديدة'))[0]);
    return screen.findByRole('dialog');
  };

  it('a holder of finance.partners is offered «سحب شريك» there too, and records the draw on the wallet that was picked', async () => {
    as('finance.partners');
    const dialog = await openFromTop();
    await chooseDraw(dialog);
    fireEvent.change(partnerBox(dialog), { target: { value: 'mk' } });
    fireEvent.change(amountBox(dialog), { target: { value: '40' } });
    fireEvent.click(send(dialog));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/finance/partners/draws', method: 'POST', body: { walletId: 'w1', partnerId: 'mk', amount: '40' } });
  });

  it('NEGATIVE: nobody else is offered it from the top either — and nobody without the key asks for the statement', async () => {
    as('finance.create');
    const dialog = await openFromTop();
    await waitFor(() => expect(choosable(dialog)).toContain('EXPENSE'));
    expect(options(dialog).some((o) => o.value === 'PARTNER_DRAW')).toBe(false);
    expect(reads).not.toContain('/api/finance/partners/statement');
  });
});

describe('the profit is not touched by what the dialog says', () => {
  it('the sentence under the kind box says a draw counts on the share and is never blocked — for the holders only', async () => {
    as('finance.partners');
    const dialog = await openDialog();
    expect(dialog.textContent).toContain('سحب الشريك من «سحب شريك»: بيتحسب على نصيبه من صافي الربح، ولو زاد بيتسجّل «مكسور عليه» وما بينمنع.');
    cleanup();
    as('finance.create');
    const other = await openDialog();
    expect(other.textContent).not.toContain('سحب الشريك من «سحب شريك»');
  });
});

describe('NO NEW CSS — the draw form is made of classes the product already ships', () => {
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  const classesOf = (src: string) =>
    [...src.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\})/g)].flatMap((m) => {
      const text = m[1] ?? m[2];
      const inHoles = [...text.matchAll(/\$\{([^}]*)\}/g)].flatMap((h) => [...h[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map((q) => q[1] ?? q[2]));
      return [text.replace(/\$\{[^}]*\}/g, ' '), ...inHoles].flatMap((s) => s.split(/\s+/)).filter(Boolean);
    });

  it('every class between «سحب شريك: ما يعادله» and the kind box appears in a file other than the wallets screen', () => {
    const own = join(root, 'components/screens/finance/WalletsScreen.tsx');
    const src = readFileSync(own, 'utf8');
    const from = src.indexOf('{/* «سحب شريك»: what the draw is worth');
    const to = src.indexOf('<span className="block text-xs font-medium text-[var(--sys-foreground)] mb-1">البند</span>');
    expect(from, 'the draw fields moved: update this test').toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const used = new Set(classesOf(src.slice(from, to)));
    expect(used.size, 'the draw fields have classes').toBeGreaterThan(10);
    const elsewhere = new Set(files.filter((f) => f !== own).flatMap((f) => classesOf(readFileSync(f, 'utf8'))));
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });
});
