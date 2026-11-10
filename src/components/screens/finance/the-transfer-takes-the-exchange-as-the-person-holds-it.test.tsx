// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE TRANSFER SCREEN — «لازم أقدر أعمل سويتش بسعر الصرف لأني مضطر أروح للحاسبة وأقسم وأضرب».
 *
 * The owner approved a drawing with «تم»: the two wallets as chips, the kind of transfer named between them, and — only
 * when the currency changes — «كيف بدك تحدد القيمة؟» with three ways to say it (the rate one way, the rate the other
 * way, the amount that arrived), the three figures as cards, and one swap button that turns the transfer round.
 *
 * What is held here is what a person SEES and what is SENT: the figure on the card is the figure in the body, whichever
 * way the deal was given, and the same deal gives the same body from every button.
 */

const { apiJson, phone } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  phone: { value: true },
}));

vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/shell/ScreenTitle', () => ({ ScreenTitle: () => <h1>العنوان</h1> }));
vi.mock('@/hooks/useIsPhone', () => ({ useIsPhone: () => phone.value }));

import { TransfersScreen } from './TransfersScreen';

const SYRIA = { id: 'SY', name: 'سوريا', minorUnit: 2 };
const JORDAN = { id: 'JO', name: 'الأردن', minorUnit: 3 };

const wallet = (over: Record<string, unknown>) => ({
  isActive: true, balance: 0, countryId: 'SY', storeId: 'sA', store: { id: 'sA', name: 'متجر دمشق' }, country: SYRIA, ...over,
});
const USD = wallet({ id: 'w-usd', name: 'صندوق الدولار', currencyCode: 'USD', balance: 500 });
const SYP = wallet({ id: 'w-syp', name: 'صندوق الليرة', currencyCode: 'SYP', balance: 2_000_000 });
const USD2 = wallet({ id: 'w-usd2', name: 'حساب الدولار البنكي', currencyCode: 'USD' });
const SYP_B = wallet({ id: 'w-sypb', name: 'ليرة حلب', currencyCode: 'SYP', storeId: 'sB', store: { id: 'sB', name: 'متجر حلب' } });
const JOD = wallet({
  id: 'w-jod', name: 'صندوق الأردن', currencyCode: 'JOD', countryId: 'JO', country: JORDAN, storeId: 'sC', store: { id: 'sC', name: 'متجر عمّان' },
});
const GBP = wallet({ id: 'w-gbp', name: 'صندوق الجنيه', currencyCode: 'GBP' });
const ALL = [USD, SYP, USD2, SYP_B, JOD, GBP];

let posted: Array<Record<string, unknown>> = [];
let history: Array<Record<string, unknown>> = [];
/** What the POST answers; swap it to make a press fail. */
let answer: () => Promise<unknown> = async () => ({ transfer: {} });

beforeEach(() => {
  vi.clearAllMocks();
  phone.value = true;
  posted = [];
  history = [];
  answer = async () => ({ transfer: {} });
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') {
      posted.push(JSON.parse(init.body!));
      return answer();
    }
    return String(url).includes('/transfers') ? { transfers: history } : { wallets: ALL };
  });
});
afterEach(() => cleanup());

const draw = async () => {
  render(<TransfersScreen />);
  await screen.findByRole('group', { name: 'من محفظة' });
  await screen.findAllByRole('button', { name: /صندوق الدولار/ });
};

const side = (name: 'من محفظة' | 'إلى محفظة') => within(screen.getByRole('group', { name }));
const pick = (name: 'من محفظة' | 'إلى محفظة', wallet: string) => fireEvent.click(side(name).getByRole('button', { name: new RegExp(wallet) }));
const amountBox = () => screen.getByRole('textbox', { name: /المبلغ اللي بدك تحوّلو/ }) as HTMLInputElement;
const noteBox = () => screen.getByRole('textbox', { name: 'الملاحظة (إلزامية)' }) as HTMLInputElement;
const radio = (name: string) => screen.getByRole('radio', { name }) as HTMLInputElement;
const valueBox = () => screen.getByRole('textbox', { name: /^(سعر الصرف:|المبلغ المستلم)/ }) as HTMLInputElement;
const type = (box: HTMLElement, value: string) => fireEvent.change(box, { target: { value } });
const submit = () => screen.getByRole('button', { name: 'تحويل' });
const text = () => document.body.textContent ?? '';

const A_USD_SYP = 'سعر الصرف: ليرة لكل 1 دولار';
const B_USD_SYP = 'سعر الصرف: دولار لكل 1 ليرة';

/** What the screen said just before the press — a transfer that is saved clears its figures. */
let beforePress = '';

/** One transfer, through the screen: the wallets, the amount, the face, the figure, the note, and the press. */
async function transfer(opts: { from: string; to: string; amount: string; face?: string; value?: string; note?: string }) {
  pick('من محفظة', opts.from);
  pick('إلى محفظة', opts.to);
  type(amountBox(), opts.amount);
  if (opts.face) fireEvent.click(radio(opts.face));
  if (opts.value !== undefined) type(valueBox(), opts.value);
  type(noteBox(), opts.note ?? 'صرف دولار');
  beforePress = text();
  const already = posted.length;
  fireEvent.click(submit());
  await waitFor(() => expect(posted.length).toBe(already + 1));
  return posted[posted.length - 1];
}

describe('the wallets are chips, and the kind of transfer is named between them', () => {
  it.each([
    ['صندوق الدولار', 'حساب الدولار البنكي', 'تحويل داخلي'],
    ['صندوق الدولار', 'ليرة حلب', 'بين متجرين'],
    ['صندوق الدولار', 'صندوق الأردن', 'بين دولتين'],
    ['صندوق الدولار', 'صندوق الليرة', 'صرف داخل البلد'],
    ['صندوق الليرة', 'صندوق الدولار', 'صرف داخل البلد'],
  ])('%s → %s is «%s»', async (from, to, label) => {
    await draw();
    pick('من محفظة', from);
    pick('إلى محفظة', to);
    expect(text()).toContain(label);
    // nothing else claims to be the kind: the badge is one of the four words, once
    const labels = ['تحويل داخلي', 'بين متجرين', 'بين دولتين', 'صرف داخل البلد'];
    expect(labels.filter((l) => document.querySelector('form')!.textContent!.includes(l))).toEqual([label]);
  });

  it('each chip says the name, «البلد · العملة» and what is in it, and the one that is chosen says so', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    const chip = side('من محفظة').getByRole('button', { name: /صندوق الدولار/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.textContent).toContain('سوريا · USD');
    expect(chip.textContent).toContain('500.00 USD');
    expect(side('من محفظة').getByRole('button', { name: /صندوق الليرة/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('a wallet cannot send to itself: the one the other end holds is dimmed on this one', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    const same = side('إلى محفظة').getByRole('button', { name: /صندوق الدولار/ }) as HTMLButtonElement;
    expect(same.disabled).toBe(true);
    expect((side('إلى محفظة').getByRole('button', { name: /صندوق الليرة/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('on a phone a chip is a 44px target; on a desk it gives the height back', async () => {
    await draw();
    const chip = side('من محفظة').getByRole('button', { name: /صندوق الدولار/ });
    expect(chip.className).toContain('min-h-11');
    expect(chip.className).toContain('md:min-h-0');
  });

  it('the wallets are grouped by country and store, as the picker always was', async () => {
    await draw();
    const group = side('من محفظة');
    expect(group.getByText('سوريا · متجر دمشق')).toBeTruthy();
    expect(group.getByText('سوريا · متجر حلب')).toBeTruthy();
    expect(group.getByText('الأردن · متجر عمّان')).toBeTruthy();
  });
});

describe('the exchange is asked for only when the currency changes', () => {
  it('one currency: no «كيف بدك تحدد القيمة؟», no rate, no radios — and the cards say what leaves and what arrives', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'حساب الدولار البنكي');
    type(amountBox(), '250');
    expect(screen.queryByText('كيف بدك تحدد القيمة؟')).toBeNull();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(screen.queryByText('السعر اللي بينحفظ')).toBeNull();
    expect(text()).toContain('المحوَّل');
    expect(text()).toContain('المستلم');
    expect(text()).toContain('250.00 USD');
  });

  it('two currencies: the question and the three ways to answer it, in the words of the pair', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    expect(screen.getByText('كيف بدك تحدد القيمة؟')).toBeTruthy();
    const names = screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent);
    expect(names).toEqual([A_USD_SYP, B_USD_SYP, 'المبلغ المستلم']);
    // the first is chosen: «weak per one strong» is the way a rate is said
    expect(radio(A_USD_SYP).checked).toBe(true);
  });

  it('the pair reads the same from the other side: lira to dollars says «ليرة لكل 1 دولار» too, not the inverse', async () => {
    await draw();
    pick('من محفظة', 'صندوق الليرة');
    pick('إلى محفظة', 'صندوق الدولار');
    expect(screen.getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual([A_USD_SYP, B_USD_SYP, 'المبلغ المستلم']);
  });

  it('dinar and lira: «ليرة لكل 1 دينار», because the dinar is the stronger', async () => {
    await draw();
    pick('من محفظة', 'صندوق الأردن');
    pick('إلى محفظة', 'صندوق الليرة');
    expect(radio('سعر الصرف: ليرة لكل 1 دينار')).toBeTruthy();
    expect(radio('سعر الصرف: دينار لكل 1 ليرة')).toBeTruthy();
  });

  it('the old box, «سعر الصرف (USD → SYP)», which sent a person to the calculator, is gone', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    expect(text()).not.toContain('USD → SYP');
  });
});

describe('the acceptance examples, through the screen: what the card says is what is sent', () => {
  it('1 — 100 USD at «13,000 ليرة لكل دولار»: the card says 1,300,000 SYP and the body carries it', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    expect(text()).toContain('100.00 USD');
    expect(text()).toContain('13,000 ليرة لكل 1 دولار');
    expect(text()).toContain('1,300,000.00 SYP');
    type(noteBox(), 'صرف دولار');
    fireEvent.click(submit());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({
      transferId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      fromWalletId: 'w-usd', toWalletId: 'w-syp', amountOut: 100, amountIn: 1_300_000, note: 'صرف دولار', expectKind: 'EXCHANGE',
    });
    // no rate is sent: the amount is the record
    expect('exchangeRate' in posted[0]).toBe(false);
  });

  it('2 — and back: 1,300,000 SYP at the SAME «13,000 ليرة لكل دولار», with no hand inversion, is 100 USD', async () => {
    await draw();
    const body = await transfer({ from: 'صندوق الليرة', to: 'صندوق الدولار', amount: '1300000', value: '13000' });
    expect(beforePress).toContain('100.00 USD');
    expect(body).toMatchObject({ fromWalletId: 'w-syp', toWalletId: 'w-usd', amountOut: 1_300_000, amountIn: 100, expectKind: 'EXCHANGE' });
  });

  it('3 — 1,250,000 SYP at «دولار لكل ليرة» 0.00008 is 100 USD, and the card says 12,500 ليرة لكل دولار', async () => {
    await draw();
    pick('من محفظة', 'صندوق الليرة');
    pick('إلى محفظة', 'صندوق الدولار');
    type(amountBox(), '1250000');
    fireEvent.click(radio(B_USD_SYP));
    type(valueBox(), '0.00008');
    expect(text()).toContain('12,500 ليرة لكل 1 دولار');
    expect(text()).toContain('100.00 USD');
    type(noteBox(), 'صرف');
    fireEvent.click(submit());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ amountOut: 1_250_000, amountIn: 100 });
  });

  it('4 — the amount that arrived: 100 USD out, 1,290,000 SYP received — the card says 12,900 and the body carries exactly 1,290,000', async () => {
    await draw();
    const body = await transfer({ from: 'صندوق الدولار', to: 'صندوق الليرة', amount: '100', face: 'المبلغ المستلم', value: '1290000' });
    expect(beforePress).toContain('12,900 ليرة لكل 1 دولار');
    expect(body).toMatchObject({ amountOut: 100, amountIn: 1_290_000, expectKind: 'EXCHANGE' });
    expect('exchangeRate' in body).toBe(false);
  });

  it('5 — 100 JOD at «18,000 ليرة لكل دينار» is 1,800,000 SYP, between countries', async () => {
    await draw();
    const body = await transfer({ from: 'صندوق الأردن', to: 'صندوق الليرة', amount: '100', value: '18000' });
    expect(beforePress).toContain('بين دولتين');
    expect(body).toMatchObject({ fromWalletId: 'w-jod', toWalletId: 'w-syp', amountOut: 100, amountIn: 1_800_000, expectKind: 'BETWEEN_COUNTRIES' });
  });

  it('one currency sends no exchange at all', async () => {
    await draw();
    const body = await transfer({ from: 'صندوق الدولار', to: 'حساب الدولار البنكي', amount: '250', note: 'إيداع' });
    expect('amountIn' in body).toBe(false);
    expect('exchangeRate' in body).toBe(false);
    expect(body).toMatchObject({ amountOut: 250, expectKind: 'INTERNAL' });
  });

  it('the same deal through each of the three buttons is the same body', async () => {
    await draw();
    const viaA = await transfer({ from: 'صندوق الدولار', to: 'صندوق الليرة', amount: '100', value: '12500' });
    const viaB = await transfer({ from: 'صندوق الدولار', to: 'صندوق الليرة', amount: '100', face: B_USD_SYP, value: '0.00008' });
    const viaC = await transfer({ from: 'صندوق الدولار', to: 'صندوق الليرة', amount: '100', face: 'المبلغ المستلم', value: '1250000' });
    for (const b of [viaA, viaB, viaC]) expect(b).toMatchObject({ amountOut: 100, amountIn: 1_250_000, expectKind: 'EXCHANGE' });
  });
});

describe('the switch is a view, never a recalculation', () => {
  it('13,000 typed as «ليرة لكل دولار», flipped to «دولار لكل ليرة» and back: the deal never moves, and 13,000 is still 13,000', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    expect(text()).toContain('1,300,000.00 SYP');

    fireEvent.click(radio(B_USD_SYP));
    // no calculator: the inverse is in the box, and the card has not changed
    expect(valueBox().value).toBe('0.000076923077');
    expect(text()).toContain('1,300,000.00 SYP');
    expect(text()).toContain('13,000 ليرة لكل 1 دولار');

    fireEvent.click(radio(A_USD_SYP));
    expect(valueBox().value).toBe('13000');
    expect(text()).toContain('1,300,000.00 SYP');
  });

  it('C shows what arrived, and from C the rate is read off the two amounts', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '12900');
    fireEvent.click(radio('المبلغ المستلم'));
    expect(valueBox().value).toBe('1290000');
    fireEvent.click(radio(A_USD_SYP));
    expect(valueBox().value).toBe('12900');
  });

  it('typing in the other face makes it the truth: the deal follows the new figure', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    fireEvent.click(radio('المبلغ المستلم'));
    type(valueBox(), '1290000');
    expect(text()).toContain('12,900 ليرة لكل 1 دولار');
    expect(text()).toContain('1,290,000.00 SYP');
  });
});

describe('«عكس الاتجاه» turns the transfer round and keeps the deal', () => {
  it('USD → SYP, 100 at 13,000: now SYP → USD with 1,300,000 leaving and 100 arriving, at the same rate', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    fireEvent.click(screen.getByRole('button', { name: 'عكس الاتجاه' }));
    expect(side('من محفظة').getByRole('button', { name: /صندوق الليرة/ }).getAttribute('aria-pressed')).toBe('true');
    expect(side('إلى محفظة').getByRole('button', { name: /صندوق الدولار/ }).getAttribute('aria-pressed')).toBe('true');
    expect(amountBox().value).toBe('1300000');
    expect(text()).toContain('1,300,000.00 SYP');
    expect(text()).toContain('100.00 USD');
    expect(text()).toContain('13,000 ليرة لكل 1 دولار');
  });

  it('with the amount that arrived typed, the two figures change places', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    fireEvent.click(radio('المبلغ المستلم'));
    type(valueBox(), '1290000');
    fireEvent.click(screen.getByRole('button', { name: 'عكس الاتجاه' }));
    expect(amountBox().value).toBe('1290000');
    expect(valueBox().value).toBe('100');
    expect(text()).toContain('12,900 ليرة لكل 1 دولار');
    // a second turn is the deal again, exactly
    fireEvent.click(screen.getByRole('button', { name: 'عكس الاتجاه' }));
    expect(amountBox().value).toBe('100');
    expect(valueBox().value).toBe('1290000');
  });

  it('a deal the door would refuse is not carried over: the wallets turn, the figures stay as typed', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    fireEvent.click(radio('المبلغ المستلم'));
    // a third decimal for a currency that counts two: refused, so there is no «what arrived» to turn round
    type(valueBox(), '1290000.123');
    expect(text()).toContain('لا يقبل أكثر من خانتين عشريتين');
    fireEvent.click(screen.getByRole('button', { name: 'عكس الاتجاه' }));
    expect(side('من محفظة').getByRole('button', { name: /صندوق الليرة/ }).getAttribute('aria-pressed')).toBe('true');
    expect(amountBox().value).toBe('100');
  });

  it('there is nothing to turn round until both wallets are chosen', async () => {
    await draw();
    expect((screen.getByRole('button', { name: 'عكس الاتجاه' }) as HTMLButtonElement).disabled).toBe(true);
    pick('من محفظة', 'صندوق الدولار');
    expect((screen.getByRole('button', { name: 'عكس الاتجاه' }) as HTMLButtonElement).disabled).toBe(true);
    pick('إلى محفظة', 'صندوق الليرة');
    expect((screen.getByRole('button', { name: 'عكس الاتجاه' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('and the kind is read again for the new direction, and sent as such', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    fireEvent.click(screen.getByRole('button', { name: 'عكس الاتجاه' }));
    type(amountBox(), '1300000');
    type(valueBox(), '13000');
    type(noteBox(), 'صرف');
    fireEvent.click(submit());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ fromWalletId: 'w-syp', toWalletId: 'w-usd', amountOut: 1_300_000, amountIn: 100, expectKind: 'EXCHANGE' });
  });
});

describe('a figure belongs to the pair of currencies it was typed for', () => {
  it('«13,000» typed for dollars and lira is forgotten the moment the other wallet is a dinar one — it is not a rate for dollars and dinars', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    expect(text()).toContain('1,300,000.00 SYP');
    pick('إلى محفظة', 'صندوق الأردن');
    expect(valueBox().value).toBe('');
    expect(text()).not.toContain('1,300,000');
    // and the box is asked for again, not silently filled with the old figure
    fireEvent.submit(document.querySelector('form')!);
    expect(posted).toEqual([]);
  });

  it('another wallet of the SAME two currencies keeps it: a lira drawer in another store is still the lira', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    pick('إلى محفظة', 'ليرة حلب');
    expect(valueBox().value).toBe('13000');
    expect(text()).toContain('1,300,000.00 SYP');
    expect(text()).toContain('بين متجرين');
  });

  it('turning the transfer round keeps it too — the rate is about the pair, not the direction', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    fireEvent.click(screen.getByRole('button', { name: 'عكس الاتجاه' }));
    expect(valueBox().value).toBe('13000');
  });
});

describe('figures typed on an Arabic keyboard', () => {
  it('Arabic-Indic digits, the Arabic decimal point and the Arabic thousands separator are read, and the boxes show Latin digits', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '١٠٠');
    expect(amountBox().value).toBe('100');
    type(valueBox(), '١٣٬٠٠٠');
    expect(valueBox().value).toBe('13,000');
    type(noteBox(), 'صرف');
    fireEvent.click(submit());
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ amountOut: 100, amountIn: 1_300_000 });
  });

  it('a decimal typed as ٣٫٥ is 3.5', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '٣٫٥');
    type(valueBox(), '10');
    expect(text()).toContain('35.00 SYP');
  });
});

describe('what the door would refuse is said before the press, in its own words', () => {
  it('more decimals than the currency counts in: the sentence is on the screen and nothing is sent', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100.005');
    type(valueBox(), '13000');
    expect(text()).toContain('لا يقبل أكثر من خانتين عشريتين');
    type(noteBox(), 'صرف');
    fireEvent.click(submit());
    expect(posted).toEqual([]);
    expect(screen.getAllByText(/خانتين عشريتين/).length).toBeGreaterThan(0);
  });

  it('an amount that arrived with a third decimal for a currency that counts two', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    fireEvent.click(radio('المبلغ المستلم'));
    type(valueBox(), '1290000.123');
    expect(text()).toContain('لا يقبل أكثر من خانتين عشريتين');
    type(noteBox(), 'صرف');
    fireEvent.click(submit());
    expect(posted).toEqual([]);
  });

  it('a rate that leaves nothing at the other end', async () => {
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الأردن');
    type(amountBox(), '100');
    // dollars into dinars: the dinar is the stronger, so «دولار لكل ليرة» here is «دولار لكل دينار»'s inverse
    fireEvent.click(screen.getByRole('radio', { name: 'سعر الصرف: دينار لكل 1 دولار' }));
    type(valueBox(), '0.000001');
    expect(text()).toContain('صفراً');
  });

  it('pressing with nothing chosen says what is missing, in order', async () => {
    await draw();
    fireEvent.submit(document.querySelector('form')!);
    expect(text()).toContain('اختر المحفظتين');
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    fireEvent.submit(document.querySelector('form')!);
    expect(text()).toContain('اكتب المبلغ اللي بدك تحوّلو');
    type(amountBox(), '100');
    fireEvent.submit(document.querySelector('form')!);
    expect(text()).toContain('اكتب سعر الصرف: ليرة لكل 1 دولار');
    expect(posted).toEqual([]);
  });
});

describe('a currency the table does not know is oriented by the history', () => {
  it('with no history it is read as weaker than the dollar', async () => {
    await draw();
    pick('من محفظة', 'صندوق الجنيه');
    pick('إلى محفظة', 'صندوق الدولار');
    expect(radio('سعر الصرف: GBP لكل 1 دولار')).toBeTruthy();
  });

  it('with a previous transfer between the pair, that says which is the strong one', async () => {
    // 1 GBP bought 1.27 USD: the pound is the stronger of the two.
    history = [{
      id: 'h1', createdAt: '2026-11-01T10:00:00Z', amountOut: 100, amountIn: 127, exchangeRate: 1.27, note: 'سابق', kindLabel: 'بين دولتين',
      from: { id: 'w-gbp', name: 'صندوق الجنيه', currencyCode: 'GBP' }, to: { id: 'w-usd', name: 'صندوق الدولار', currencyCode: 'USD' },
    }];
    render(<TransfersScreen />);
    await screen.findAllByText('سابق');
    pick('من محفظة', 'صندوق الجنيه');
    pick('إلى محفظة', 'صندوق الدولار');
    expect(radio('سعر الصرف: دولار لكل 1 GBP')).toBeTruthy();
  });
});

describe('a second press, and a retry', () => {
  it('while the first press is on the wire a second sends nothing', async () => {
    let finish: (v: unknown) => void = () => {};
    answer = () => new Promise((resolve) => { finish = resolve; });
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    type(noteBox(), 'صرف');
    fireEvent.submit(document.querySelector('form')!);
    fireEvent.submit(document.querySelector('form')!);
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(posted).toHaveLength(1));
    finish({ transfer: {} });
    await waitFor(() => expect(text()).toContain('تم صرف داخل البلد'));
    expect(posted).toHaveLength(1);
  });

  it('after a failure the same attempt is sent again with the same id, and after a success the next is a new one', async () => {
    let first = true;
    answer = async () => {
      if (first) {
        first = false;
        throw new Error('انتهت مهلة الطلب. تحقق من الاتصال وحاول مجدداً.');
      }
      return { transfer: {} };
    };
    await draw();
    pick('من محفظة', 'صندوق الدولار');
    pick('إلى محفظة', 'صندوق الليرة');
    type(amountBox(), '100');
    type(valueBox(), '13000');
    type(noteBox(), 'صرف');
    fireEvent.click(submit());
    await waitFor(() => expect(text()).toContain('انتهت مهلة الطلب'));
    // the answer was lost: the person presses again
    fireEvent.click(submit());
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].transferId).toBe(posted[0].transferId);
    await waitFor(() => expect(text()).toContain('تم صرف داخل البلد'));

    // a new transfer is a new attempt
    type(amountBox(), '50');
    type(valueBox(), '13000');
    type(noteBox(), 'صرف آخر');
    fireEvent.click(submit());
    await waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2].transferId).not.toBe(posted[0].transferId);
  });

  it('a success clears the amounts and the note, keeps the wallets, and says the kind of transfer it was', async () => {
    await draw();
    await transfer({ from: 'صندوق الدولار', to: 'صندوق الليرة', amount: '100', value: '13000' });
    await waitFor(() => expect(text()).toContain('تم صرف داخل البلد — سُجِّلت حركتان'));
    expect(amountBox().value).toBe('');
    expect(valueBox().value).toBe('');
    expect(noteBox().value).toBe('');
    expect(side('من محفظة').getByRole('button', { name: /صندوق الدولار/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a refusal from the door is shown as it was said', async () => {
    answer = async () => {
      throw new Error('تغيّر نوع التحويل — هذا بين متجرين. راجعه وأعد المحاولة.');
    };
    await draw();
    await transfer({ from: 'صندوق الدولار', to: 'صندوق الليرة', amount: '100', value: '13000' });
    await waitFor(() => expect(text()).toContain('تغيّر نوع التحويل'));
  });
});

describe('the button and the history are where they were', () => {
  it('phone: a line of its own, the width of it', async () => {
    await draw();
    expect(submit().parentElement!.className).toBe('flex flex-col gap-2');
    expect(submit().className).toContain('w-full');
  });

  it('desk: right-aligned, and not full width', async () => {
    phone.value = false;
    await draw();
    expect(submit().parentElement!.className).toBe('flex justify-end');
    expect(submit().className).not.toContain('w-full');
  });

  it('the history still lists what was done, with the kind it was recorded as', async () => {
    history = [{
      id: 'h1', createdAt: '2026-11-01T10:00:00Z', amountOut: 100, amountIn: 1_300_000, exchangeRate: 13000, note: 'صرف قديم', kindLabel: 'صرف داخل البلد',
      from: { id: 'w-usd', name: 'صندوق الدولار', currencyCode: 'USD' }, to: { id: 'w-syp', name: 'صندوق الليرة', currencyCode: 'SYP' },
    }];
    render(<TransfersScreen />);
    await screen.findAllByText('صرف قديم');
    expect(text()).toContain('آخر التحويلات');
    expect(text()).toContain('صرف داخل البلد');
  });
});
