// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * «التحويلات» ON THE KIT (18/11, R13f — «واجهة 2» for the money screens: the screen may look different, no figure on it may move).
 *
 * The screen and its reversal dialog are drawn by the kit now: the frame is `PageShell` titled from the registry, the form is a
 * page-level `Card`, the history and everything nested (the kind line, the three figure tiles, the dialog's summary) are
 * `Card plain` so a theme's decoration never lands on them, the four hand-drawn buttons are `Button`, and captions are 13px.
 *
 * What did NOT change, and these hold it: every request — the transfer's body (both wallets, both amounts, the note, the kind the
 * screen named, one id per deal) and the reversal's body (the trimmed reason) — the figures on the tiles and in the history, who
 * gets the «قيد عكسي» press, the busy flags (a second press while the first is on the wire sends nothing), and that the swap and
 * «إلغاء» never submit their form (the kit `Button` sets no `type` of its own).
 *
 * Before this file was written the branch and osm/main's copy of both files were drawn side by side over ten scenes on a desk and
 * a phone (twenty runs) — the whole page text after every press, every box value, every button's state and every request were
 * identical. The figures below were read from that run.
 *
 * Phone layout is checked here in jsdom (classes and structure), not in a real browser.
 */

const { apiJson, phone, who, toast } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: false },
  who: { keys: [] as string[] },
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'CUSTOM', permissions: who.keys } }),
}));

import { TransfersScreen } from './TransfersScreen';
import { routeLabel } from '@/lib/route-registry';
import { PAGE_WIDTHS } from '@/components/ui/PageShell';
import { CARD_CLASS } from '@/lib/theme-shape';

/** Class names are built from pieces: the stylesheet is generated from every source file, tests included. */
const SMALL = ['text', 'xs'].join('-');
const NOTE = ['text', 'note'].join('-');

const SYRIA = { id: 'SY', name: 'سوريا', minorUnit: 2 };
const wallet = (over: Record<string, unknown>) => ({
  isActive: true, balance: 0, countryId: 'SY', storeId: 'sA', store: { id: 'sA', name: 'متجر دمشق' }, country: SYRIA,
  imageKey: null, iconKey: null, colorKey: null, ...over,
});
const USD = wallet({ id: 'w-usd', name: 'صندوق الدولار', currencyCode: 'USD', balance: 500 });
const SYP = wallet({ id: 'w-syp', name: 'صندوق الليرة', currencyCode: 'SYP', balance: 2_000_000 });
const USD2 = wallet({ id: 'w-usd2', name: 'حساب الدولار البنكي', currencyCode: 'USD', balance: 12.5 });
const end = (w: Record<string, unknown>) => ({ id: w.id, name: w.name, currencyCode: w.currencyCode, store: { name: 'متجر دمشق' }, imageKey: null, iconKey: null, colorKey: null });
const base = { amountOut: 663958, amountIn: 4501.41, exchangeRate: 0.00678, createdAt: '2026-11-14T18:27:00.000Z', kindLabel: 'صرف داخل البلد', from: end(SYP), to: end(USD) };
const LIVE = { ...base, id: 't-live', note: 'تحويل ساري', state: 'ACTIVE', reversedWalletIds: [], reversal: null };
const HALF = { ...base, id: 't-half', note: 'تحويل نصف معكوس', state: 'PARTLY_REVERSED', reversedWalletIds: ['w-usd'], reversal: { reason: 'خطأ', at: '2026-11-14T18:28:00.000Z', byName: 'موظف' } };
const DONE = { ...base, id: 't-done', note: 'تحويل معكوس كله', state: 'REVERSED', reversedWalletIds: ['w-usd', 'w-syp'], reversal: { reason: 'سُجِّل بالخطأ', at: '2026-11-14T18:30:00.000Z', byName: 'موظف' } };
const SAME = { id: 't-same', amountOut: 20, amountIn: 20, exchangeRate: 1, note: 'داخلي', createdAt: '2026-10-20T10:00:00Z', kindLabel: 'تحويل داخلي', from: end(USD), to: end(USD2) };

let history: unknown[] = [];
/** What a write answers; replace it to hold a press on the wire. */
let answer: () => Promise<unknown> = async () => ({});
let uuid = 0;
const writes = () => apiJson.mock.calls.filter((c) => (c[1] as { method?: string } | undefined)?.method);

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = false;
  who.keys = [];
  history = [LIVE, HALF, DONE, SAME];
  answer = async () => ({});
  uuid = 0;
  vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` as `${string}-${string}-${string}-${string}-${string}`);
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    if (init?.method) return answer();
    return String(url).startsWith('/api/finance/transfers') ? { transfers: history } : { wallets: [USD, SYP, USD2] };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  const view = render(<TransfersScreen />);
  await screen.findByRole('group', { name: 'من محفظة' });
  if (history.length) await screen.findAllByText(String((history[0] as { note: string }).note));
  else await screen.findByText('لا تحويلات بعد.');
  return view;
};
const side = (name: string) => within(screen.getByRole('group', { name }));
const pick = (name: string, w: string) => fireEvent.click(side(name).getByRole('button', { name: new RegExp(w) }));
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const amountBox = () => screen.getByRole('textbox', { name: /المبلغ اللي بدك تحوّلو/ });
const noteBox = () => screen.getByRole('textbox', { name: 'الملاحظة (إلزامية)' });
const valueBox = () => screen.getByRole('textbox', { name: /^(سعر الصرف:|المبلغ المستلم)/ });
const submit = () => screen.getByRole('button', { name: 'تحويل' }) as HTMLButtonElement;
const swapButton = () => screen.getByRole('button', { name: /عكس الاتجاه/ }) as HTMLButtonElement;
const form = () => document.querySelector('form') as HTMLFormElement;
const deskRow = (note: string) => screen.getAllByText(note)[0].closest('tr') as HTMLElement;

describe('the frame and the surfaces', () => {
  it('is the kit’s PageShell, titled from the registry, at the wide width', async () => {
    const { container } = await draw();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(routeLabel('/finance/transfers'));
    const frame = container.firstElementChild as HTMLElement;
    for (const c of PAGE_WIDTHS.wide.split(' ')) expect(frame.classList.contains(c)).toBe(true);
    expect(frame.classList.contains('min-w-0')).toBe(true);
  });

  it('the form sits in a page-level card (the theme reaches it); the history is a plain card (no decoration on rows)', async () => {
    await draw();
    expect((form().parentElement as HTMLElement).classList.contains(CARD_CLASS)).toBe(true);
    const history = screen.getByRole('heading', { name: 'آخر التحويلات' }).parentElement as HTMLElement;
    expect(history.classList.contains(CARD_CLASS)).toBe(false);
    expect(history.classList.contains('overflow-hidden')).toBe(true);
    expect(document.querySelectorAll(`.${CARD_CLASS}`)).toHaveLength(1);
  });

  it('the kind line and the three figure tiles are plain cards inside the form', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    const kind = screen.getAllByText('صرف داخل البلد').find((el) => form().contains(el)) as HTMLElement;
    expect((kind.parentElement as HTMLElement).classList.contains(CARD_CLASS)).toBe(false);
    for (const label of ['المحوَّل', 'السعر اللي بينحفظ', 'المستلم']) {
      const tile = within(form()).getByText(label).parentElement as HTMLElement;
      expect(tile.classList.contains(CARD_CLASS)).toBe(false);
      expect(tile.classList.contains('p-3')).toBe(true);
    }
    expect(document.querySelectorAll(`.${CARD_CLASS}`)).toHaveLength(1);
  });

  it('captions are 13px: the only 12px line left is the rate under an amount on a phone card (it sits on the rate’s own line)', async () => {
    phone.value = true;
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    // the rate under an amount on a card: it shares its line with the rate, so it kept its class (the money-line rule)
    for (const el of screen.getAllByText('السعر 0.00678')) expect(el.classList.contains(SMALL)).toBe(true);
    for (const caption of ['إلى محفظة', 'الملاحظة (إلزامية)', 'السعر اللي بينحفظ', 'المستلم', 'كيف بدك تحدد القيمة؟']) {
      const el = screen.getAllByText(caption).find((e) => form().contains(e)) as HTMLElement;
      expect(el.classList.contains(NOTE)).toBe(true);
      expect(el.classList.contains(SMALL)).toBe(false);
    }
    expect(screen.getAllByText('معكوس جزئياً')[0].classList.contains(NOTE)).toBe(true);
    expect(screen.getByText('من محفظة').classList.contains(NOTE)).toBe(true);
    expect(within(form()).getByText('المحوَّل').classList.contains(NOTE)).toBe(true);
  });
});

describe('the buttons — same presses, same rules', () => {
  it('«عكس الاتجاه» is a secondary kit button that never submits, and stays shut until both wallets are chosen', async () => {
    await draw();
    expect(swapButton().getAttribute('type')).toBe('button');
    expect(swapButton().disabled).toBe(true);
    pick('من محفظة', 'صندوق الدولار');
    expect(swapButton().disabled).toBe(true);
    pick('إلى محفظة', 'حساب الدولار البنكي');
    expect(swapButton().disabled).toBe(false);
    type(amountBox(), '12.5');
    type(noteBox(), 'إيداع');
    fireEvent.click(swapButton());
    await new Promise((r) => setTimeout(r, 0));
    expect(writes()).toHaveLength(0);
    // it turned the transfer round: the bank account sends now
    expect(side('من محفظة').getByRole('button', { name: /حساب الدولار البنكي/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('«تحويل» is the submit; a second press while the first is on the wire sends nothing, and the button is shut meanwhile', async () => {
    await draw();
    let release: () => void = () => undefined;
    answer = () => new Promise((r) => { release = () => r({}); });
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'حساب الدولار البنكي');
    type(amountBox(), '12.5');
    type(noteBox(), 'إيداع');
    expect(submit().getAttribute('type')).toBe('submit');
    fireEvent.click(submit());
    await waitFor(() => expect(submit().disabled).toBe(true));
    fireEvent.submit(form());
    expect(writes()).toHaveLength(1);
    release();
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(screen.getByText('تم تحويل داخلي — سُجِّلت حركتان: صادر من الأولى ووارد إلى الثانية')).toBeTruthy();
  });

  it('NEGATIVE: a press with nothing chosen says why and sends nothing', async () => {
    await draw();
    fireEvent.submit(form());
    expect(await screen.findByText('اختر المحفظتين')).toBeTruthy();
    expect(writes()).toHaveLength(0);
  });
});

describe('the requests and the figures — frozen from osm/main’s drawing', () => {
  it('a same-currency transfer sends exactly this body', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'حساب الدولار البنكي');
    type(amountBox(), '12.5');
    type(noteBox(), '  إيداع  ');
    fireEvent.click(submit());
    await waitFor(() => expect(writes()).toHaveLength(1));
    // UPDATED 22/11 (the real date): the body now also carries «تاريخ الحركة الفعلي» — the box's ISO moment, now by default.
    // Old: the body string was compared whole. New: the same string with the real date, which is the only key added.
    expect(writes()[0][0]).toBe('/api/finance/transfers');
    const { occurredAt, ...rest } = JSON.parse((writes()[0][1] as { body: string }).body);
    expect(occurredAt).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00[.]000Z$/);
    expect(JSON.stringify(rest)).toBe('{"transferId":"00000000-0000-4000-8000-000000000001","fromWalletId":"w-usd","toWalletId":"w-usd2","amountOut":12.5,"note":"إيداع","expectKind":"INTERNAL"}');
  });

  it('an exchange sends the amount that arrives, and the tiles say what main said', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    type(noteBox(), 'صرف دولار');
    const tiles = (label: string) => (within(form()).getByText(label).parentElement as HTMLElement).textContent;
    expect(tiles('المحوَّل')).toBe('المحوَّل100.00 USD');
    expect(tiles('السعر اللي بينحفظ')).toBe('السعر اللي بينحفظ13,000 ليرة لكل 1 دولار0.00007692 دولار لكل 1 ليرة');
    expect(tiles('المستلم')).toBe('المستلم1,300,000.00 SYP');
    fireEvent.click(submit());
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(JSON.parse((writes()[0][1] as { body: string }).body)).toEqual({
      transferId: '00000000-0000-4000-8000-000000000001', fromWalletId: 'w-usd', toWalletId: 'w-syp', amountOut: 100, amountIn: 1300000,
      note: 'صرف دولار', expectKind: 'EXCHANGE',
      // UPDATED 22/11 (the real date): the body now also carries «تاريخ الحركة الفعلي» — the box's ISO moment, now by default.
      occurredAt: expect.any(String),
    });
  });

  it('the history row says the stored figures, its state and its reversal as it did', async () => {
    await draw();
    expect(deskRow('تحويل نصف معكوس').textContent).toContain('663,958');
    expect(deskRow('تحويل نصف معكوس').textContent).toContain('4,501.41');
    expect(deskRow('تحويل نصف معكوس').textContent).toContain('معكوس جزئياً');
    expect(deskRow('تحويل نصف معكوس').textContent).toContain('قيد عكسي: خطأ');
    expect(deskRow('داخلي').textContent).toContain('ساري');
  });

  it('an empty history says the same sentence', async () => {
    history = [];
    await draw();
    expect(screen.getByText('لا تحويلات بعد.')).toBeTruthy();
  });
});

describe('«قيد عكسي» — the press and the dialog', () => {
  it('the press is a quiet kit button, drawn for finance.cashbox and never on a transfer reversed whole', async () => {
    who.keys = ['finance.cashbox_view', 'finance.cashbox'];
    await draw();
    const press = within(deskRow('تحويل ساري')).getByRole('button', { name: /قيد عكسي/ });
    expect(press.getAttribute('type')).toBe('button');
    expect(press.className).toContain('bg-transparent');
    expect(within(deskRow('تحويل نصف معكوس')).queryByRole('button', { name: /قيد عكسي/ })).toBeTruthy();
    expect(within(deskRow('تحويل معكوس كله')).queryByRole('button', { name: /قيد عكسي/ })).toBeNull();
  });

  it('NEGATIVE: without finance.cashbox no row carries the press', async () => {
    who.keys = ['finance.cashbox_view'];
    await draw();
    expect(screen.queryAllByRole('button', { name: /قيد عكسي/, hidden: true })).toHaveLength(0);
  });

  it('the dialog: «إلغاء» is secondary and never submits; the record button is the danger one; the body is the trimmed reason', async () => {
    who.keys = ['finance.cashbox'];
    await draw();
    fireEvent.click(within(deskRow('تحويل نصف معكوس')).getByRole('button', { name: /قيد عكسي/ }));
    const dialog = within(screen.getByRole('dialog', { name: 'قيد عكسي' }));
    const cancel = dialog.getByRole('button', { name: 'إلغاء' });
    const record = dialog.getByRole('button', { name: 'تسجيل القيد العكسي' });
    expect(cancel.getAttribute('type')).toBe('button');
    expect(record.getAttribute('type')).toBe('submit');
    expect(record.className).toContain('bg-[var(--sys-destructive)]');
    expect(cancel.className).not.toContain('sys-destructive');
    // its summary is a plain card: the dialog is not a page
    const summary = dialog.getByText(/القيدان الأصليان/).parentElement as HTMLElement;
    expect(summary.classList.contains(CARD_CLASS)).toBe(false);
    expect(summary.classList.contains('p-3')).toBe(true);
    // half reversed: only the standing leg is named, with the figure it stored
    expect(summary.textContent).toContain('يرجع إليها 663,958');
    expect(summary.textContent).not.toContain('يخرج منها');

    let release: () => void = () => undefined;
    answer = () => new Promise((r) => { release = () => r({}); });
    type(dialog.getByRole('textbox'), '  سُجِّل التحويل بالخطأ  ');
    fireEvent.click(record);
    await waitFor(() => expect((dialog.getByRole('button', { name: 'إلغاء' }) as HTMLButtonElement).disabled).toBe(true));
    expect((dialog.getByRole('button', { name: 'جارٍ التسجيل…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(writes()).toEqual([['/api/finance/transfers/t-half', { method: 'PATCH', body: '{"reason":"سُجِّل التحويل بالخطأ"}' }]]);
    release();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.done).toHaveBeenCalledWith('انعكس التحويل — الطرفان معاً');
  });

  it('NEGATIVE: «إلغاء» closes and writes nothing', async () => {
    who.keys = ['finance.cashbox'];
    await draw();
    fireEvent.click(within(deskRow('تحويل ساري')).getByRole('button', { name: /قيد عكسي/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(writes()).toHaveLength(0);
  });
});

describe('a phone (375px, in jsdom)', () => {
  it('nothing on the screen carries a fixed width, the history is cards, and «تحويل» is the width of its line', async () => {
    phone.value = true;
    who.keys = ['finance.cashbox'];
    const { container } = await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    const fixed = [...container.querySelectorAll('[class]')].flatMap((el) =>
      [...el.classList].filter((c) => /^(min-)?w-\[|^w-(screen|9[6-9]|[1-9]\d{2,})$/.test(c))
    );
    expect(fixed).toEqual([]);
    expect(submit().className).toContain('w-full');
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(4);
    // a row's press still opens the dialog from a card
    const card = screen.getAllByText('تحويل ساري').map((el) => el.closest('li')).find(Boolean) as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /قيد عكسي/ }));
    expect(screen.getByRole('dialog', { name: 'قيد عكسي' })).toBeTruthy();
  });
});
