// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «حركة جديدة» AT THE TOP OF «المحافظ والحركات»
 * (the owner, 13/11 02:31, over a phone screenshot of the wallets screen, which had only «محفظة جديدة» at the top: «زر حركة جديدة بالاعلى»)
 *
 *  1. A primary «حركة جديدة» sits in the top row beside «محفظة جديدة», for whoever may record movements — the SAME key the wallet's own
 *     press asks (`finance.cashbox`, not widened). Whoever lacks it sees neither the button nor the dialog.
 *  2. With several wallets the dialog first asks WHICH wallet (a `<select>` of the RUNNING wallets, «name — currency») and cannot be
 *     submitted without one; with one running wallet it is preselected, and so is the wallet that is open. A stopped wallet is never
 *     offered (the wallet's own press is grey for it).
 *  3. It is THE SAME dialog: the request is byte-for-byte what the wallet's own press sends for the same inputs (url, method, headers,
 *     body), and the dialog is the same markup — the kinds, the validation, the currency sentence — whichever press opened it.
 *  4. Phone and desk: on a phone the two presses share the row, 44px each; on a desk they sit side by side at its end. No new CSS class.
 *
 * Blockers: none of the money ones — a door is added, not a rule; the movement route and the expense route are not touched.
 * ═══════════════════════════════════════════════════════════════════════
 */

// The suite runs ~900 jsdom files at once: a `findBy`/`waitFor` that gives up after a second is a load flake, not a finding.
configure({ asyncUtilTimeout: 5000 });

const { who, phone } = vi.hoisted(() => ({
  who: { role: 'CUSTOM', keys: [] as string[] },
  phone: { value: false },
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: who.role, permissions: who.keys } }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>المحافظ</h1> }));

import { StoreCurrencyProvider } from '@/context/StoreCurrency';
import { WalletsScreen } from './WalletsScreen';

const wallet = (id: string, name: string, currencyCode: string, isActive = true) => ({
  id, name, currencyCode, isActive, opening: 0, in: 0, out: 0, balance: 0, movements: 0, country: { id: 'c1', name: 'سوريا' }, openingCount: null,
});
const CASH = wallet('w1', 'الصندوق', 'USD');
const SHAM = wallet('w2', 'شام كاش', 'SYP');
const OLD = wallet('w3', 'بينانس القديمة', 'USDT', false);

/** The key of the wallet's own press (the one the top press must ask too), plus whatever the case adds. */
const as = (...extra: string[]) => {
  who.role = 'CUSTOM';
  who.keys = ['finance.cashbox_view', 'finance.cashbox', ...extra];
};

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  raw: string;
}
let sent: Sent[];
let reads: string[];
let wallets: ReturnType<typeof wallet>[];
let refusal: { status: number; body: unknown } | null;
let holdWallets: Promise<void> | null;

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  as('finance.wallets_manage');
  sent = [];
  reads = [];
  wallets = [CASH, SHAM, OLD];
  refusal = null;
  holdWallets = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const method = init?.method ?? 'GET';
      if (method !== 'GET') {
        sent.push({ url, method, headers: (init?.headers ?? {}) as Record<string, string>, raw: String(init?.body ?? '') });
        if (refusal) return json(refusal.body, refusal.status);
        return url === '/api/finance' ? json({ success: true, expense: { id: 'exp-1' } }) : json({ movement: { id: 'm1' } }, 201);
      }
      reads.push(url);
      if (url.includes('/movements')) return json({ movements: [] });
      if (holdWallets) await holdWallets;
      return json({ wallets });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ── finding things on the real screen ───────────────────────────────────── */

/** The top row is the SENTENCE's parent; the pair of presses is its child. */
const topRow = () => screen.getByText(/المحفظة تتبع متجراً واحداً/).parentElement as HTMLElement;
const topRecord = () => within(topRow()).getByRole('button', { name: 'حركة جديدة' }) as HTMLButtonElement;
const createWallet = () => within(topRow()).getByRole('button', { name: 'محفظة جديدة' }) as HTMLButtonElement;
/** The wallet's own press, in the ledger's header: the «حركة جديدة» that is NOT in the top row. */
const ownRecord = () =>
  screen.getAllByRole('button', { name: 'حركة جديدة' }).find((b) => !topRow().contains(b)) as HTMLButtonElement;
const recordButtons = () => screen.queryAllByRole('button', { name: 'حركة جديدة', hidden: true });
const loaded = () => screen.findAllByText('الصندوق');
const walletCard = (name: RegExp) => screen.getByRole('button', { name });

async function draw(over: { storeCode?: string; ready?: string } = {}) {
  render(
    over.storeCode ? (
      <StoreCurrencyProvider code={over.storeCode}>
        <WalletsScreen />
      </StoreCurrencyProvider>
    ) : (
      <WalletsScreen />
    )
  );
  await screen.findAllByText(over.ready ?? 'الصندوق');
}
const openTop = async () => {
  fireEvent.click(topRecord());
  return screen.findByRole('dialog');
};
const openOwn = async () => {
  fireEvent.click(ownRecord());
  return screen.findByRole('dialog');
};

/** The wallet question inside the dialog (only the top press draws one). */
const chooserIn = (dialog: HTMLElement) => within(dialog).queryByLabelText('المحفظة') as HTMLSelectElement | null;
const optionsOf = (select: HTMLSelectElement) =>
  within(select).getAllByRole('option').map((o) => ({ value: (o as HTMLOptionElement).value, text: o.textContent ?? '' }));

const amountBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^المبلغ/) as HTMLInputElement;
const partyBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^(البيان|الطرف)/) as HTMLInputElement;
const noteBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^الملاحظة/) as HTMLInputElement;
/** The category box is the one that offers the typed kinds (its label also wraps a long hint, so it is not found by its label). */
const categoryBox = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'ADJUSTMENT')) as HTMLSelectElement;
const direction = (dialog: HTMLElement, name: 'وارد' | 'صادر') => fireEvent.click(within(dialog).getByRole('button', { name }));
const typeBox = (dialog: HTMLElement) => within(dialog).getByLabelText(/^نوع المصروف/) as HTMLSelectElement;

/** The kinds of what is typed — each fills the dialog the way a person would, and names the button that sends it. */
type Kind = 'adjustment-out' | 'other-in' | 'expense';
const SUBMIT: Record<Kind, string> = { 'adjustment-out': 'تسجيل', 'other-in': 'تسجيل', expense: 'تسجيل المصروف' };
function fill(dialog: HTMLElement, kind: Kind) {
  if (kind === 'adjustment-out') {
    fireEvent.change(amountBox(dialog), { target: { value: '40' } });
    fireEvent.change(partyBox(dialog), { target: { value: '  سامر  ' } });
    fireEvent.change(noteBox(dialog), { target: { value: '  تصحيح رصيد  ' } });
  } else if (kind === 'other-in') {
    direction(dialog, 'وارد');
    fireEvent.change(categoryBox(dialog), { target: { value: 'OTHER' } });
    fireEvent.change(amountBox(dialog), { target: { value: '12.5' } });
    fireEvent.change(partyBox(dialog), { target: { value: 'ورشة' } });
    fireEvent.change(noteBox(dialog), { target: { value: 'دفعة ورشة' } });
  } else {
    fireEvent.change(categoryBox(dialog), { target: { value: 'EXPENSE' } });
    fireEvent.change(amountBox(dialog), { target: { value: '150.5' } });
    fireEvent.change(partyBox(dialog), { target: { value: '  إيجار المستودع  ' } });
    fireEvent.change(typeBox(dialog), { target: { value: 'OFFICE' } });
    fireEvent.change(noteBox(dialog), { target: { value: '  عن شهر تشرين  ' } });
  }
}
const send = (dialog: HTMLElement, kind: Kind) => fireEvent.click(within(dialog).getByRole('button', { name: SUBMIT[kind] }));

/** What a dialog IS, as markup: the ids React hands out differ between two renders and say nothing, so they are put aside. */
const markup = (dialog: HTMLElement, withoutChooser: boolean) => {
  const copy = dialog.cloneNode(true) as HTMLElement;
  if (withoutChooser) copy.querySelector('select')?.closest('label')?.remove();
  return copy.outerHTML.replace(/\s(id|for|aria-labelledby|aria-describedby)="[^"]*"/g, '');
};

describe('1 — who is offered the top press', () => {
  it('the cash key draws it in the top row — first, before «محفظة جديدة» — and the wallet’s own press is still in the ledger’s header', async () => {
    await draw();
    expect(topRow().contains(topRecord())).toBe(true);
    expect(topRecord().compareDocumentPosition(createWallet()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // They are the two presses of one pair: the same parent, the day's press first.
    expect(topRecord().parentElement).toBe(createWallet().parentElement);
    // And the wallet's own press is outside the row — two «حركة جديدة» on the screen, each where it belongs.
    expect(recordButtons()).toHaveLength(2);
    expect(topRow().contains(ownRecord())).toBe(false);
  });

  it('NEGATIVE: the cash box’s VIEW key alone draws neither press, and there is no dialog to open', async () => {
    who.keys = ['finance.cashbox_view'];
    render(<WalletsScreen />);
    await loaded();
    expect(recordButtons()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'محفظة جديدة' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('NEGATIVE: the wallets’ key alone — or the expense key — does not draw it: only «محفظة جديدة» is there for the first', async () => {
    who.keys = ['finance.cashbox_view', 'finance.wallets_manage'];
    render(<WalletsScreen />);
    await loaded();
    expect(recordButtons()).toHaveLength(0);
    expect(createWallet()).toBeTruthy();
    cleanup();
    who.keys = ['finance.cashbox_view', 'finance.create'];
    render(<WalletsScreen />);
    await loaded();
    expect(recordButtons()).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'محفظة جديدة' })).toBeNull();
  });

  it('the cash key WITHOUT the wallets’ key: the pair holds the one press, and no «محفظة جديدة»', async () => {
    as();
    await draw();
    expect(topRecord().parentElement!.querySelectorAll('button')).toHaveLength(1);
    expect(within(topRow()).queryByRole('button', { name: 'محفظة جديدة' })).toBeNull();
  });

  it('SUPER_ADMIN holds every key, as the server counts it: the press is there', async () => {
    who.role = 'SUPER_ADMIN';
    who.keys = [];
    await draw();
    expect(topRecord()).toBeTruthy();
  });

  it('it appears when the wallet’s own press does — not while the wallets load, and not with none to record on', async () => {
    let release!: () => void;
    holdWallets = new Promise<void>((r) => { release = r; });
    render(<WalletsScreen />);
    expect(await screen.findByText('جارٍ التحميل…')).toBeTruthy();
    expect(recordButtons()).toHaveLength(0);
    release();
    await loaded();
    expect(recordButtons()).toHaveLength(2);
    cleanup();

    wallets = [];
    render(<WalletsScreen />);
    expect(await screen.findByText('لا محافظ بعد')).toBeTruthy();
    expect(recordButtons()).toHaveLength(0);
  });

  it('it is grey while every wallet is stopped — as the wallet’s own press is — and opens nothing', async () => {
    wallets = [OLD];
    await draw({ ready: 'بينانس القديمة' });
    expect(topRecord().disabled).toBe(true);
    expect(ownRecord().disabled).toBe(true);
    fireEvent.click(topRecord());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('2 — it asks WHICH wallet, and only of the running ones', () => {
  it('opens on the wallet that is open, with a select of the RUNNING wallets «name — currency» — the stopped one is not offered', async () => {
    await draw();
    const dialog = await openTop();
    const select = chooserIn(dialog)!;
    expect(select).toBeTruthy();
    expect(select.value).toBe('w1');
    expect(optionsOf(select)).toEqual([
      { value: 'w1', text: 'الصندوق — USD' },
      { value: 'w2', text: 'شام كاش — SYP' },
    ]);
    expect(within(dialog).queryByText(/بينانس القديمة/)).toBeNull();
    // It is the wallet’s dialog from there on: titled with the wallet, its figures, its form.
    expect(screen.getByRole('dialog', { name: /حركة جديدة — الصندوق/ })).toBeTruthy();
    expect(within(dialog).getByText('المبلغ (USD)')).toBeTruthy();
  });

  it('«the wallet that is open» is the one she picked on the screen: select another card first, and the press offers THAT one', async () => {
    await draw();
    fireEvent.click(walletCard(/شام كاش/));
    await screen.findByText(/حركات شام كاش/);
    const dialog = await openTop();
    expect(chooserIn(dialog)!.value).toBe('w2');
    expect(screen.getByRole('dialog', { name: /حركة جديدة — شام كاش/ })).toBeTruthy();
  });

  it('changing the wallet in the select moves the dialog to it — its name, its face line, its currency — and the record goes to THAT wallet', async () => {
    await draw();
    const dialog = await openTop();
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w2' } });
    expect(screen.getByRole('dialog', { name: /حركة جديدة — شام كاش/ })).toBeTruthy();
    expect(within(dialog).getByText('المبلغ (SYP)')).toBeTruthy();
    expect(within(dialog).getByText('سوريا · SYP')).toBeTruthy();
    fill(dialog, 'adjustment-out');
    send(dialog, 'adjustment-out');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe('/api/finance/wallets/w2/movements');
    expect(JSON.parse(sent[0].raw)).toStrictEqual({ direction: 'OUT', amount: 40, party: 'سامر', category: 'ADJUSTMENT', note: 'تصحيح رصيد' });
  });

  it('and what was typed stays when the wallet is changed — only the wallet moves', async () => {
    await draw();
    const dialog = await openTop();
    fireEvent.change(amountBox(dialog), { target: { value: '77' } });
    fireEvent.change(partyBox(dialog), { target: { value: 'سامر' } });
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w2' } });
    expect(amountBox(dialog).value).toBe('77');
    expect(partyBox(dialog).value).toBe('سامر');
  });

  it('with ONE running wallet it is preselected — and the form is there at once — even when the open wallet is a stopped one', async () => {
    wallets = [OLD, SHAM]; // the stopped one is first, so it is the one the screen has open
    await draw({ ready: 'شام كاش' });
    await screen.findByText(/حركات بينانس القديمة/);
    const dialog = await openTop();
    const select = chooserIn(dialog)!;
    expect(select.value).toBe('w2');
    expect(optionsOf(select)).toEqual([{ value: 'w2', text: 'شام كاش — SYP' }]);
    expect(amountBox(dialog)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'تسجيل' })).toBeTruthy();
  });

  it('with several running wallets and the open one STOPPED nothing is chosen for her: it asks first, draws no form and cannot be submitted', async () => {
    wallets = [OLD, CASH, SHAM];
    await draw();
    await screen.findByText(/حركات بينانس القديمة/);
    const dialog = await openTop();
    const select = chooserIn(dialog)!;
    expect(select.value).toBe('');
    expect(optionsOf(select).map((o) => o.value)).toEqual(['', 'w1', 'w2']);
    expect(optionsOf(select)[0].text).toBe('اختر المحفظة…');
    // No form, no way to send: nothing to type into, no submit button.
    expect(within(dialog).queryByLabelText(/^المبلغ/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'تسجيل' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'تسجيل المصروف' })).toBeNull();
    expect(sent).toHaveLength(0);

    // Picking one draws THE dialog for that wallet.
    fireEvent.change(select, { target: { value: 'w2' } });
    const full = await screen.findByRole('dialog', { name: /حركة جديدة — شام كاش/ });
    expect(chooserIn(full)!.value).toBe('w2');
    expect(amountBox(full)).toBeTruthy();
    expect(within(full).getByRole('button', { name: 'تسجيل' })).toBeTruthy();
  });

  it('«إلغاء» on the question closes it, and nothing was sent', async () => {
    wallets = [OLD, CASH, SHAM];
    await draw();
    await screen.findByText(/حركات بينانس القديمة/);
    const dialog = await openTop();
    fireEvent.click(within(dialog).getByRole('button', { name: 'إلغاء' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent).toHaveLength(0);
  });

  it('the wallet’s OWN press asks nothing: no wallet question, titled with the wallet, the dialog it always was', async () => {
    await draw();
    const dialog = await openOwn();
    expect(chooserIn(dialog)).toBeNull();
    expect(screen.getByRole('dialog', { name: /حركة جديدة — الصندوق/ })).toBeTruthy();
    // The first box of the dialog is still the category, as the older tests rely on.
    expect(within(dialog).getAllByRole('combobox')[0]).toBe(categoryBox(dialog));
  });
});

describe('3 — the SAME dialog: the same request, byte for byte, whichever press opened it', () => {
  const CASES: { name: string; kind: Kind; extra: string[] }[] = [
    { name: '«تسوية» going OUT — the movements door', kind: 'adjustment-out', extra: [] },
    { name: '«أخرى» coming IN — the movements door', kind: 'other-in', extra: [] },
    { name: '«مصروف» — the EXPENSE door', kind: 'expense', extra: ['finance.create'] },
  ];

  for (const c of CASES) {
    it(`${c.name}: url, method, headers and body are identical for the two presses`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 10, 13, 10, 0, 0));
      as('finance.wallets_manage', ...c.extra);

      await draw();
      const own = await openOwn();
      fill(own, c.kind);
      send(own, c.kind);
      await waitFor(() => expect(sent).toHaveLength(1));
      const viaOwn = sent[0];
      cleanup();
      sent = [];

      await draw();
      const top = await openTop();
      expect(chooserIn(top)!.value).toBe('w1'); // the same wallet
      fill(top, c.kind);
      send(top, c.kind);
      await waitFor(() => expect(sent).toHaveLength(1));
      const viaTop = sent[0];

      expect(viaTop).toStrictEqual(viaOwn);
      // …and that is not two empty bodies agreeing: it is a real request, to the right door, for the wallet.
      expect(viaTop.method).toBe('POST');
      expect(viaTop.url).toBe(c.kind === 'expense' ? '/api/finance' : '/api/finance/wallets/w1/movements');
      expect(viaTop.raw.length).toBeGreaterThan(20);
      if (c.kind === 'expense') {
        expect(JSON.parse(viaTop.raw)).toStrictEqual({
          title: 'إيجار المستودع', category: 'OFFICE', amount: 150.5, expenseDate: '2026-11-13', notes: 'عن شهر تشرين', walletId: 'w1',
        });
      }
    });
  }

  it('an expense picked for ANOTHER wallet goes to the expense door with THAT wallet’s id — and nothing to the movements door', async () => {
    as('finance.wallets_manage', 'finance.create');
    await draw();
    const dialog = await openTop();
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w2' } });
    fill(dialog, 'expense');
    send(dialog, 'expense');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].url).toBe('/api/finance');
    expect(JSON.parse(sent[0].raw).walletId).toBe('w2');
    expect(sent.some((s) => s.url.includes('/movements'))).toBe(false);
  });

  it('the dialog is the same MARKUP — the kinds, the labels, the validation attributes, the hints — before and after the same steps', async () => {
    as('finance.wallets_manage', 'finance.create');
    await draw();
    const own = await openOwn();
    const steps: Array<(d: HTMLElement) => void> = [
      () => undefined,
      (d) => direction(d, 'وارد'),
      (d) => fireEvent.change(categoryBox(d), { target: { value: 'OTHER' } }),
      (d) => direction(d, 'صادر'),
      (d) => fireEvent.change(categoryBox(d), { target: { value: 'EXPENSE' } }),
    ];
    const viaOwn: string[] = [];
    for (const step of steps) {
      step(own);
      viaOwn.push(markup(own, false));
    }
    cleanup();

    await draw();
    const top = await openTop();
    const viaTop: string[] = [];
    for (const step of steps) {
      step(top);
      viaTop.push(markup(top, true));
    }
    expect(viaTop).toHaveLength(viaOwn.length);
    viaOwn.forEach((html, i) => expect(viaTop[i], `step ${i}`).toBe(html));
    // The dialog the markup describes has the kinds it always had: the two typed ones, the expense for who may, the commission greyed.
    expect(viaTop[4]).toContain('value="EXPENSE"');
    expect(viaTop[4]).toContain('نوع المصروف');
  });

  it('the currency sentence of the expense follows the wallet picked: it is there for a wallet in another currency than the store’s, gone for one in the same', async () => {
    as('finance.wallets_manage', 'finance.create');
    await draw({ storeCode: 'SYP' });
    const dialog = await openTop();
    fireEvent.change(categoryBox(dialog), { target: { value: 'EXPENSE' } });
    expect(within(dialog).getByText(/غير عملة المتجر/).textContent).toContain('USD');
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w2' } }); // SYP: the store's own currency
    expect(within(dialog).queryByText(/غير عملة المتجر/)).toBeNull();
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w1' } });
    expect(within(dialog).getByText(/غير عملة المتجر/)).toBeTruthy();
  });

  it('a refusal of the door is shown inside the dialog, as for the wallet’s own press: it stays, with the wallet and what was typed', async () => {
    await draw();
    const dialog = await openTop();
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w2' } });
    fill(dialog, 'adjustment-out');
    refusal = { status: 422, body: { error: 'المحفظة غير موجودة أو موقوفة' } };
    send(dialog, 'adjustment-out');
    expect(await within(dialog).findByText('المحفظة غير موجودة أو موقوفة')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(chooserIn(dialog)!.value).toBe('w2');
    expect(amountBox(dialog).value).toBe('40');
    expect(sent).toHaveLength(1);
  });

  it('after saving: the dialog closes, «سُجِّلت الحركة» is said, the wallets and the ledger are read again — and the wallet that was open stays open', async () => {
    await draw();
    const dialog = await openTop();
    fireEvent.change(chooserIn(dialog)!, { target: { value: 'w2' } });
    fill(dialog, 'adjustment-out');
    const readsBefore = reads.length;
    send(dialog, 'adjustment-out');
    expect(await screen.findByText('سُجِّلت الحركة')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(reads.length).toBeGreaterThan(readsBefore));
    const after = reads.slice(readsBefore);
    expect(after).toContain('/api/finance/wallets');
    expect(after.some((u) => u.includes('/api/finance/wallets/w1/movements'))).toBe(true);
    expect(screen.getByText(/حركات الصندوق/)).toBeTruthy();
  });
});

describe('4 — the top row, on a phone and on a desk', () => {
  /** What a class list says, as a set — the order of the tokens is nobody's business. */
  const tokens = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));

  it('PHONE: the sentence takes the line as before, and the two presses SHARE the row beneath it — each 44px, each half of it', async () => {
    phone.value = true;
    await draw();
    expect(topRow().className).toBe('flex flex-col gap-2');
    const pair = topRecord().parentElement!;
    expect(pair.parentElement).toBe(topRow());
    expect(pair.className).toBe('flex gap-2');
    for (const b of [topRecord(), createWallet()]) {
      expect(tokens(b).has('h-11'), 'a finger’s height').toBe(true);
      expect(tokens(b).has('flex-1')).toBe(true);
      expect(tokens(b).has('justify-center')).toBe(true);
      expect(tokens(b).has('bg-[var(--sys-primary)]'), 'primary').toBe(true);
    }
    expect(pair.querySelectorAll('button')).toHaveLength(2);
  });

  it('PHONE: with only one of the two keys the one press still takes the whole row', async () => {
    phone.value = true;
    as();
    await draw();
    const pair = topRecord().parentElement!;
    expect(pair.querySelectorAll('button')).toHaveLength(1);
    expect(tokens(topRecord()).has('flex-1')).toBe(true);
  });

  it('DESK: the row is the one it always was, with the pair at its end — side by side, neither squeezed, the sentence yields', async () => {
    await draw();
    expect(topRow().className).toBe('flex items-center justify-between gap-3');
    const pair = topRecord().parentElement!;
    expect(pair.parentElement).toBe(topRow());
    expect(pair.className).toBe('flex items-center gap-2 shrink-0');
    for (const b of [topRecord(), createWallet()]) {
      expect(tokens(b).has('md:h-10')).toBe(true);
      expect(tokens(b).has('shrink-0')).toBe(true);
      expect(tokens(b).has('flex-1'), 'a desk button stretched to half a row').toBe(false);
      expect(tokens(b).has('bg-[var(--sys-primary)]')).toBe(true);
    }
    // The sentence is the first thing in the row and the pair the last: the row’s `justify-between` puts the pair at the far end.
    expect(topRow().firstElementChild?.tagName).toBe('P');
    expect(topRow().lastElementChild).toBe(pair);
  });

  it('the wallet’s own press is exactly what it was — the same classes, the same place', async () => {
    await draw();
    expect(ownRecord().className).toBe(
      'h-11 md:h-8 px-3 rounded-lg bg-[var(--sys-primary)] text-[var(--sys-primary-foreground)] text-xs font-medium inline-flex items-center gap-1.5 disabled:opacity-50'
    );
    expect(ownRecord().parentElement!.className).toBe('flex items-center gap-1.5');
  });

  it('the top press is a real `<button>` with the label «حركة جديدة» and its icon, and it sits in no form', async () => {
    await draw();
    expect(topRecord().tagName).toBe('BUTTON');
    expect(topRecord().querySelector('svg')).toBeTruthy();
    expect(topRecord().closest('form'), 'a press inside a form could submit it').toBeNull();
  });
});

describe('NO NEW CSS — every class the top press, the row and the wallet question wear is one the product already ships', () => {
  const root = join(process.cwd(), 'src');
  const own = join(root, 'components/screens/finance/WalletsScreen.tsx');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);
  /** Tailwind reads a source file as raw text: every whitespace- or quote-separated word of it is a candidate class. */
  const words = (text: string) => text.split(/[\s"'`{}<>=,;]+/).filter(Boolean);
  /** The words of every class attribute in a piece of source, template strings and their ternaries included. */
  const classesIn = (src: string) => {
    const out: string[] = [];
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`((?:[^`$]|\$\{[^}]*\})*)`\})/g)) {
      if (m[1] !== undefined) out.push(...m[1].split(/\s+/));
      else {
        out.push(...m[2].replace(/\$\{([^}]*)\}/g, (_, expr: string) => {
          for (const s of expr.matchAll(/'([^']*)'/g)) out.push(...s[1].split(/\s+/));
          return ' ';
        }).split(/\s+/));
      }
    }
    return out.filter(Boolean);
  };

  /** The three pieces of this change, cut out of the screen by what stands at their two ends — and what is left of the file without them. */
  const analysed = () => {
    const src = readFileSync(own, 'utf8');
    const cut = (from: string, to: string) => {
      const a = src.indexOf(from);
      const b = src.indexOf(to, a + from.length);
      expect(a, `«${from}» moved: update this test`).toBeGreaterThan(-1);
      expect(b, `«${to}» moved: update this test`).toBeGreaterThan(a);
      return [a, b] as const;
    };
    const pieces = [
      cut('const topRecordButton =', '* THE LEDGER ON A CARD'),
      cut('{(topRecordButton || mayManage) && (', '{!wallets ? ('),
      cut('function RecordFromTop(', 'function RecordDialog('),
    ];
    return {
      mine: pieces.map(([a, b]) => src.slice(a, b)),
      rest: pieces.reduceRight((left, [a, b]) => left.slice(0, a) + left.slice(b), src),
    };
  };

  it('the three pieces carry classes at all (the scan is not empty), and they are written from what the file and the product already use', () => {
    const { mine, rest } = analysed();
    const used = new Set(mine.flatMap(classesIn));
    expect(used.size, 'the pieces have classes').toBeGreaterThan(30);
    const elsewhere = new Set([...files.filter((f) => f !== own).flatMap((f) => words(readFileSync(f, 'utf8'))), ...words(rest)]);
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the scan really reads template strings: the conditional tokens of the top press are among the ones it checks', () => {
    const used = new Set(analysed().mine.flatMap(classesIn));
    for (const token of ['flex-1', 'justify-center', 'shrink-0', 'h-11', 'md:h-10', 'bg-[var(--sys-primary)]', 'w-full', 'space-y-3', 'pt-1']) {
      expect(used.has(token), token).toBe(true);
    }
  });
});
