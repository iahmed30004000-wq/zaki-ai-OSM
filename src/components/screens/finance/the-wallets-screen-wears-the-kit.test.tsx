// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { routeLabel } from '@/lib/route-registry';
import { CARD_CLASS } from '@/lib/theme-shape';

/**
 * «المحافظ والحركات» ON THE KIT (R13e, plan 17/11) — ONE LOOK, AND NOT ONE FIGURE OR REQUEST MOVED.
 *
 * A money screen: it may look different, and nothing it prints or sends may change. So this file holds
 *   the frame    — `PageShell` at the page's width, the menu's own name as the one h1;
 *   the surfaces — the ledger and the nested boxes of the dialogs are the kit's PLAIN card (no theme ornament on rows);
 *   the presses  — the kit's `Button`/`IconButton`; delete and the reversal are `danger`; the screen's own busy flag still shuts
 *                  a press while its request is in the air (the `void` wrapper keeps the kit from adding a second lock);
 *                  inside a form only the submit can submit;
 *   the figures  — every leaf text that carries a digit, frozen from the screen as main drew it before this request (18/11),
 *                  on a desk and on a phone (dates left out: they follow the machine's clock zone);
 *   the requests — the bodies of create · rename · stop · delete · restart · opening count · expense · draw · reversal · look,
 *                  frozen from main's screen byte for byte;
 *   the phone    — no fixed width wider than a phone, the ledger's header wraps, a row's dialog opens.
 */

configure({ asyncUtilTimeout: 5000 });

const { who, phone } = vi.hoisted(() => ({ who: { role: 'SUPER_ADMIN', keys: [] as string[] }, phone: { value: false } }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: who.role, permissions: who.keys } }),
}));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('next/navigation', () => ({ usePathname: () => '/finance/wallets', useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => true), useTell: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ show: vi.fn(), push: vi.fn(), failed: vi.fn() }) }));

import { StoreCurrencyProvider } from '@/context/StoreCurrency';
import { WalletsScreen } from './WalletsScreen';

const W = (over: Record<string, unknown>) => ({
  id: 'w1', name: 'الصندوق', currencyCode: 'USD', isActive: true, opening: 1250.5, in: 3400.125, out: 980.75, balance: 3669.875,
  movements: 4, country: { id: 'c1', name: 'سوريا' },
  openingCount: { countedAmount: 1250.5, countedByName: 'عادل', countedAt: '2026-11-01T08:00:00.000Z', note: null },
  ...over,
});
const WALLETS = [
  W({}),
  W({ id: 'w2', name: 'صندوق الدينار', currencyCode: 'JOD', opening: 0, in: 0, out: 0, balance: 0, movements: 0, openingCount: null }),
  W({ id: 'w3', name: 'بينانس القديمة', currencyCode: 'USDT', isActive: false, opening: 10, in: 0.333, out: 0, balance: 10.333, movements: 1, openingCount: null }),
];
const mv = (id: string, direction: 'IN' | 'OUT', amount: number, party: string, category: string, extra: Record<string, unknown> = {}) => ({
  id, direction, amount, party, category, note: null, reversalReason: null, createdAt: '2026-11-10T09:00:00.000Z', createdByName: 'سارة',
  isReversal: false, wasReversed: false, referenceType: null, ...extra,
});
const MOVES = [
  mv('m1', 'IN', 3400.125, 'شركة الشحن', 'COURIER_SETTLEMENT', { note: 'كشف 7' }),
  mv('m2', 'OUT', 500, 'إيجار', 'EXPENSE', { referenceType: 'EXPENSE', createdByName: null }),
  mv('m3', 'OUT', 480.75, 'تحويل', 'TRANSFER_OUT', { referenceType: 'TRANSFER' }),
  mv('m4', 'IN', 0.001, 'تصحيح', 'ADJUSTMENT', { note: 'فرق', reversalReason: 'مكرر بالخطأ', isReversal: true }),
];
const line = (id: string, name: string, entitlement: number, draws: number) => ({
  id, name, sharePercent: 50, isActive: true, entitlement, draws, balance: entitlement - draws, broken: Math.max(0, draws - entitlement),
});
const STATEMENT = {
  state: 'OK', sharesTotal: 100, currency: 'USD', minorUnit: 2, netProfit: 1000, uncounted: 0, draws: [],
  trust: { level: 'STATED', present: 10, population: 10, share: 100, ar: 'x' }, totals: { entitlement: 700, draws: 100, broken: 0 },
  lines: [line('pa', 'شريك أ', 150, 100), line('pd', 'شريك د', 550, 0)],
};
const KEY = 'companies/c1/products/w1/5e5e5e5e-4e5f-4a6b-8c7d-9e0f1a2b3c4d.png';

let sent: { url: string; method: string; headers: string; body: string }[];
let hold: Promise<void> | null;
beforeEach(() => {
  phone.value = false;
  who.role = 'SUPER_ADMIN';
  who.keys = [];
  sent = [];
  hold = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ url, method, headers: JSON.stringify(init?.headers ?? {}), body: init?.body instanceof FormData ? 'FORM' : String(init?.body ?? '') });
      if (hold) await hold;
      if (url.endsWith('/image')) return json({ imageKey: KEY });
      if (method === 'DELETE') return json({ message: 'أُوقِفت بدل الحذف', deleted: false });
      return json({ ok: true });
    }
    if (url === '/api/finance/wallets') return json({ wallets: WALLETS });
    if (url.includes('/movements')) return json({ movements: url.includes('/w1/') ? MOVES : [] });
    if (url === '/api/geo/countries') return json({ countries: [{ id: 'c1', name: 'سوريا', currencyCode: 'USD' }] });
    if (url === '/api/finance/partners/statement') return json(STATEMENT);
    return json({});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
async function draw() {
  render(<StoreCurrencyProvider code="USD"><WalletsScreen /></StoreCurrencyProvider>);
  await screen.findAllByText('الصندوق');
  await screen.findAllByText('شركة الشحن');
}
const tokens = (el: Element) => new Set(el.className.split(/\s+/).filter(Boolean));
/** The kit's `Button` draws its words inside a span and starts its class list with these two. */
/*
 * 22/11 (F5, «سحب السجل»): the screen now draws the kit's `DateRange` above the ledger, whose opener is its own press (a
 * `button[aria-expanded]` directly inside the kit's `relative` box). Old: only `Button`'s classes were the kit. New: that opener
 * is the kit too. Why: it is `components/ui/DateRange`, not a raw press of this screen.
 */
const isDateRange = (b: Element) => b.hasAttribute('aria-expanded') && !!b.parentElement && tokens(b.parentElement).has('relative') && !!b.querySelector('svg');
const isKit = (b: Element) => (tokens(b).has('relative') && tokens(b).has('cursor-pointer')) || isDateRange(b);
const byName = (name: string) => document.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement;
const press = (root: HTMLElement, name: string) => within(root).getByRole('button', { name });
const card = (name: string) => screen.getAllByText(name).map((n) => n.closest('button')).find(Boolean) as HTMLButtonElement;
const ownRecord = () => screen.getAllByRole('button', { name: 'حركة جديدة' })[1];
const ledger = () => screen.getByText(/^حركات الصندوق/).closest('.overflow-hidden') as HTMLElement;
const pick = (d: HTMLElement, has: string) => [...d.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === has))!;
const digitLeaves = () =>
  [...document.querySelectorAll('body *')]
    .filter((e) => e.children.length === 0 && /\d/.test(e.textContent ?? ''))
    .map((e) => norm(e.textContent))
    .filter((t) => !/نوفمبر/.test(t));

describe('the frame', () => {
  it('is the kit’s PageShell at the page’s width, with the menu’s own name as the one h1', async () => {
    await draw();
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toBe(routeLabel('/finance/wallets'));
    expect(tokens(h1s[0].closest('header')!.parentElement!).has('max-w-6xl')).toBe(true);
  });
});

describe('the surfaces', () => {
  it('the ledger is the kit’s PLAIN card: an edge and the card fill, never the theme’s ornament on its rows', async () => {
    await draw();
    const box = ledger();
    expect(box).toBeTruthy();
    expect(tokens(box).has('border')).toBe(true);
    expect(tokens(box).has('bg-[var(--sys-card)]')).toBe(true);
    for (const t of CARD_CLASS.split(/\s+/).filter(Boolean)) expect(tokens(box).has(t), t).toBe(false);
  });

  it('the reversal’s sentences sit on plain cards too — and the sentence with the amount is the one it always was', async () => {
    await draw();
    fireEvent.click(within(ledger()).getAllByRole('button', { name: 'قيد عكسي' })[2]);
    const d = await screen.findByRole('dialog');
    const first = within(d).getByText(/سيُسجَّل قيد معاكس/);
    expect(tokens(first).has('border')).toBe(true);
    for (const t of CARD_CLASS.split(/\s+/).filter(Boolean)) expect(tokens(first).has(t), t).toBe(false);
    expect(norm(first.textContent)).toBe('سيُسجَّل قيد معاكس بمبلغ 480.75 USD (وارد) مرتبطاً بالحركة الأصلية. القيد الأصلي لا يُحذف ولا يُعدَّل.');
    expect(within(d).getByText(/هذه حركة تحويل/)).toBeTruthy();
  });
});

describe('the presses', () => {
  it('every press of the screen is the kit’s, except the wallet cards (a card press, left raw for R19)', async () => {
    await draw();
    const raw = [...document.querySelectorAll('button')].filter((b) => !isKit(b) && !b.closest('summary'));
    const cards = raw.filter((b) => /الصندوق|صندوق الدينار|بينانس القديمة/.test(b.textContent ?? ''));
    expect(cards).toHaveLength(3);
    expect(raw.filter((b) => !cards.includes(b)).map((b) => norm(b.textContent))).toEqual([]);
  });

  it('the upkeep is three named icon presses and one worded one; delete is the danger look', async () => {
    await draw();
    for (const name of ['عدّل الاسم', 'أوقف المحفظة', 'احذف']) {
      expect(byName(name), name).toBeTruthy();
      expect(byName(name).getAttribute('title')).toBe(name);
    }
    expect(tokens(byName('احذف')).has('bg-[var(--sys-destructive)]'), 'delete is danger').toBe(true);
    expect(tokens(byName('أوقف المحفظة')).has('bg-[var(--sys-destructive)]')).toBe(false);
    expect(isKit(screen.getByText('تعديل شكل المحفظة').closest('button')!)).toBe(true);
  });

  it('the screen’s busy flag still shuts «أوقف المحفظة» while its request is in the air: two presses, ONE request', async () => {
    await draw();
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    fireEvent.click(byName('أوقف المحفظة'));
    fireEvent.click(byName('أوقف المحفظة'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(byName('أوقف المحفظة').disabled).toBe(true);
    expect(byName('احذف').disabled, 'the same flag shuts delete').toBe(true);
    release();
    await waitFor(() => expect(byName('احذف').disabled).toBe(false));
    expect(sent).toHaveLength(1);
  });

  it('the reversal’s own submit is the danger look; in every form only the submit can submit', async () => {
    await draw();
    fireEvent.click(within(ledger()).getAllByRole('button', { name: 'قيد عكسي' })[0]);
    let d = await screen.findByRole('dialog');
    expect(tokens(press(d, 'تسجيل القيد العكسي')).has('bg-[var(--sys-destructive)]')).toBe(true);
    const onlySubmit = (dialog: HTMLElement, submit: string) => {
      const form = dialog.querySelector('form')!;
      const submitters = [...form.querySelectorAll('button')].filter((b) => b.type === 'submit');
      expect(submitters.map((b) => norm(b.textContent))).toEqual([submit]);
    };
    onlySubmit(d, 'تسجيل القيد العكسي');
    fireEvent.click(press(d, 'إلغاء'));
    expect(sent, 'cancel sends nothing').toHaveLength(0);
    fireEvent.click(ownRecord());
    d = await screen.findByRole('dialog');
    onlySubmit(d, 'تسجيل');
    fireEvent.click(press(d, 'إلغاء'));
    fireEvent.click(screen.getAllByRole('button', { name: 'محفظة جديدة' })[0]);
    d = await screen.findByRole('dialog');
    onlySubmit(d, 'إنشاء');
    fireEvent.click(press(d, 'إلغاء'));
    expect(sent).toHaveLength(0);
  });

  it('NEGATIVE: who holds only the VIEW key gets no press that writes — no upkeep, no count, no record, no reversal', async () => {
    who.role = 'CUSTOM';
    who.keys = ['finance.cashbox_view'];
    await draw();
    for (const name of ['عدّل الاسم', 'أوقف المحفظة', 'احذف']) expect(byName(name), name).toBeNull();
    expect(screen.queryByRole('button', { name: 'حركة جديدة' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'محفظة جديدة' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'قيد عكسي' })).toBeNull();
  });
});

describe('the figures — frozen from main’s screen, 18/11', () => {
  it('desk', async () => {
    await draw();
    expect(digitLeaves()).toEqual([
      'افتتاحي 1250.5 · وارد 3400.125 · صادر 980.75', 'عُدَّ بمعرفة عادل · 2026-11-01', 'افتتاحي 0 · وارد 0 · صادر 0',
      'افتتاحي 10 · وارد 0.333 · صادر 0', 'كشف 7', '3400.125', '500', '480.75', '0.001', 'كشف 7', '3400.125', '500', '480.75', '0.001',
    ]);
    expect(norm(card('الصندوق').textContent)).toContain('3669.875 USD');
    expect(norm(card('بينانس القديمة').textContent)).toContain('10.333 USDT');
  });

  it('phone', async () => {
    phone.value = true;
    await draw();
    expect(digitLeaves()).toEqual([
      '3,669.875 USD', '1,250.500', '3,400.125', '980.750', 'عُدَّ بمعرفة عادل · 2026-11-01', '0.00 JOD', '0.00', '0.00', '0.00',
      '10.333 USDT', '10.000', '0.333', '0.000', '3,400.125 USD', 'كشف 7', '500.00 USD', '480.75 USD', '0.001 USD',
      '3,400.125 USD', 'كشف 7', '500.00 USD', '480.75 USD', '0.001 USD',
    ]);
  });
});

describe('the requests — frozen from main’s screen, byte for byte, 18/11', () => {
  it('create · rename · stop · delete · restart', async () => {
    await draw();
    fireEvent.click(screen.getAllByRole('button', { name: 'محفظة جديدة' })[0]);
    const d = await screen.findByRole('dialog');
    await waitFor(() => expect(within(d).getByText('سوريا — USD')).toBeTruthy());
    fireEvent.change(within(d).getByPlaceholderText('مثال: الصندوق النقدي، حساب البنك العربي'), { target: { value: ' صندوق جديد ' } });
    fireEvent.change(within(d).getByPlaceholderText('USD'), { target: { value: 'jod' } });
    fireEvent.change(within(d).getByPlaceholderText('0'), { target: { value: '12.345' } });
    fireEvent.click(press(d, 'إنشاء'));
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(byName('عدّل الاسم'));
    const box = await waitFor(() => {
      const b = document.querySelector('input:not([type])') as HTMLInputElement;
      expect(b?.value).toBe('الصندوق');
      return b;
    });
    fireEvent.change(box, { target: { value: '  الصندوق الكبير ' } });
    fireEvent.click(byName('احفظ'));
    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() => expect(byName('أوقف المحفظة')).toBeTruthy());
    fireEvent.click(byName('أوقف المحفظة'));
    await waitFor(() => expect(sent).toHaveLength(3));
    await waitFor(() => expect(byName('احذف').disabled).toBe(false));
    fireEvent.click(byName('احذف'));
    await waitFor(() => expect(sent).toHaveLength(4));
    fireEvent.click(card('بينانس القديمة'));
    const restart = (await screen.findByText('أعِد تشغيلها')).closest('button')!;
    await waitFor(() => expect(restart.disabled).toBe(false));
    fireEvent.click(restart);
    await waitFor(() => expect(sent).toHaveLength(5));
    const J = '{"Content-Type":"application/json"}';
    expect(sent).toEqual([
      { url: '/api/finance/wallets', method: 'POST', headers: '{}', body: '{"countryId":"c1","name":"صندوق جديد","currencyCode":"JOD","openingBalance":12.345}' },
      { url: '/api/finance/wallets/w1', method: 'PATCH', headers: J, body: '{"name":"الصندوق الكبير"}' },
      { url: '/api/finance/wallets/w1', method: 'PATCH', headers: J, body: '{"isActive":false}' },
      { url: '/api/finance/wallets/w1', method: 'DELETE', headers: '{}', body: '' },
      { url: '/api/finance/wallets/w3', method: 'PATCH', headers: J, body: '{"isActive":true}' },
    ]);
  });

  it('the opening count', async () => {
    await draw();
    fireEvent.click(card('صندوق الدينار'));
    fireEvent.click((await screen.findByText('العدّ الافتتاحيّ')).closest('button')!);
    const d = await screen.findByRole('dialog');
    const boxes = d.querySelectorAll('input');
    fireEvent.change(boxes[0], { target: { value: '4350.75' } });
    fireEvent.change(boxes[1], { target: { value: ' سامر الحلبي ' } });
    fireEvent.change(boxes[2], { target: { value: '2026-11-01T08:30' } });
    fireEvent.change(d.querySelector('textarea')!, { target: { value: ' ورقة 3 ' } });
    fireEvent.click(press(d, 'سجّل العدّ'));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      url: '/api/finance/wallets/w2/opening-count', method: 'POST', headers: '{"Content-Type":"application/json"}',
      body: JSON.stringify({ countedAmount: 4350.75, countedByName: 'سامر الحلبي', countedAt: new Date('2026-11-01T08:30').toISOString(), note: 'ورقة 3' }),
    });
  });

  it('an expense, a partner’s draw in another currency, and a transfer’s reversal', async () => {
    await draw();
    fireEvent.click(ownRecord());
    let d = await screen.findByRole('dialog');
    fireEvent.change(pick(d, 'ADJUSTMENT'), { target: { value: 'EXPENSE' } });
    fireEvent.change(within(d).getByLabelText(/^المبلغ/), { target: { value: '150.5' } });
    fireEvent.change(within(d).getByLabelText(/^(البيان|الطرف)/), { target: { value: ' إيجار ' } });
    fireEvent.change(within(d).getByLabelText(/^نوع المصروف/), { target: { value: 'OFFICE' } });
    fireEvent.change(d.querySelector('input[type="date"]')!, { target: { value: '2026-11-15' } });
    fireEvent.change(within(d).getByLabelText(/^الملاحظة/), { target: { value: ' تشرين ' } });
    fireEvent.click(press(d, 'تسجيل المصروف'));
    await waitFor(() => expect(sent).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getAllByRole('button', { name: 'حركة جديدة' })[0]);
    d = await screen.findByRole('dialog');
    fireEvent.change(within(d).getByLabelText('المحفظة'), { target: { value: 'w2' } });
    fireEvent.change(pick(d, 'ADJUSTMENT'), { target: { value: 'PARTNER_DRAW' } });
    await within(d).findByText('شريك أ');
    fireEvent.change(within(d).getByLabelText(/^المبلغ/), { target: { value: '70' } });
    fireEvent.change(within(d).getByLabelText(/^ما يعادله/), { target: { value: '98.73' } });
    fireEvent.change(within(d).getByLabelText(/^الشريك/), { target: { value: 'pd' } });
    const go = press(d, 'تسجيل السحب');
    (go.closest('form') as HTMLFormElement).noValidate = true;
    fireEvent.click(go);
    await waitFor(() => expect(sent).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(within(ledger()).getAllByRole('button', { name: 'قيد عكسي' })[2]);
    d = await screen.findByRole('dialog');
    fireEvent.change(d.querySelector('textarea')!, { target: { value: ' سُجّل مرتين بالخطأ ' } });
    fireEvent.click(press(d, 'تسجيل القيد العكسي'));
    await waitFor(() => expect(sent).toHaveLength(3));
    const J = '{"Content-Type":"application/json"}';
    expect(sent).toEqual([
      { url: '/api/finance', method: 'POST', headers: J, body: '{"title":"إيجار","category":"OFFICE","amount":150.5,"expenseDate":"2026-11-15","notes":"تشرين","walletId":"w1"}' },
      { url: '/api/finance/partners/draws', method: 'POST', headers: J, body: '{"walletId":"w2","partnerId":"pd","amount":"70","valueInStoreCurrency":"98.73"}' },
      { url: '/api/finance/wallets/w1/movements', method: 'PATCH', headers: '{}', body: '{"movementId":"m3","reason":"سُجّل مرتين بالخطأ"}' },
    ]);
  });

  it('the wallet’s look: a picture uploaded, taken off, an icon and a colour saved', async () => {
    await draw();
    fireEvent.click(screen.getByText('تعديل شكل المحفظة').closest('button')!);
    const d = await screen.findByRole('dialog');
    fireEvent.change(d.querySelector('input[type="file"]')!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    fireEvent.click((await within(d).findByText('شيل الصورة')).closest('button')!);
    fireEvent.click(within(d).getAllByRole('button', { pressed: false })[2]);
    fireEvent.click(within(d).getByRole('button', { name: 'لون 3' }));
    fireEvent.click(press(d, 'احفظ'));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual([
      { url: '/api/finance/wallets/w1/image', method: 'POST', headers: '{}', body: 'FORM' },
      { url: '/api/finance/wallets/w1', method: 'PATCH', headers: '{"Content-Type":"application/json"}', body: '{"iconKey":"wallet","colorKey":"warning"}' },
    ]);
  });
});

describe('the phone (jsdom: classes, not pixels)', () => {
  it('no fixed width wider than a phone, the ledger’s header wraps, and a row’s reversal opens its dialog', async () => {
    phone.value = true;
    await draw();
    const wide = [...document.querySelectorAll('[class]')].flatMap((e) =>
      [...(e.getAttribute('class') ?? '').matchAll(/(?:^|\s)(?:min-)?w-\[(\d+)px\]/g)].map((m) => Number(m[1])).filter((n) => n > 375)
    );
    expect(wide).toEqual([]);
    const header = ledger().firstElementChild as HTMLElement;
    expect(tokens(header).has('flex-wrap')).toBe(true);
    expect(tokens(ownRecord().parentElement!).has('flex-wrap')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'قيد عكسي' })[0]);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});
