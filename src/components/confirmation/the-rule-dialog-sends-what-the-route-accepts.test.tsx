// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';
import { DEFAULT_WINBACK_RULE, validateWinbackRule, type WinbackRule } from '@/lib/winback';

/**
 * «عدّل القاعدة» — THE FORM THE OWNER TURNS HIS RULE WITH.
 *
 * «شو القاعدة تبعو لاني ممكن اعدلها». What the form owes him, beyond drawing:
 *
 *   • it opens on what is stored NOW, with the discount as the percent he thinks
 *     in, and the limit written under every number;
 *   • it offers seven reasons and not eleven — the four nobody may be rung for
 *     are not boxes to tick, and a sentence says so;
 *   • it refuses what the route would refuse, in the route's words, BEFORE
 *     sending — an empty box is not a zero, «500%» is not clamped to fifty;
 *   • it sends the numbers as numbers, the percent as a percent, and tells the
 *     screen what the route answered;
 *   • and it does not lose what he typed because the window behind it woke up.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));

import { WinbackRuleDialog } from './WinbackRuleDialog';

const STORED: WinbackRule = {
  reasons: ['PRICE_TOO_HIGH', 'FOUND_CHEAPER_ELSEWHERE', 'CUSTOMER_CHANGED_MIND', 'NO_ANSWER_3_ATTEMPTS'],
  afterShipping: true,
  coolingDays: 14,
  lookbackDays: 120,
  maxDiscountShare: 0.25,
};

const COOLING = 'المهلة بعد الإلغاء (أيام)';
const LOOKBACK = 'أبعد طلب نقرؤه (أيام)';
const PERCENT = 'أقصى خصم (٪ من السعر)';
/** The owner's switch, 28/10: «قبل الشحن وبعد». */
const AFTER = 'يشمل المرتجع بعد الشحن';

let onClose: Mock<() => void>;
let onSaved: Mock<(rule: WinbackRule) => Promise<void>>;
const order: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  onClose = vi.fn<() => void>(() => void order.push('closed'));
  onSaved = vi.fn<(rule: WinbackRule) => Promise<void>>(async () => void order.push('saved'));
  api.mockImplementation(async (_url: string, init?: RequestInit) => {
    const sent = JSON.parse(String(init?.body));
    return {
      rule: {
        reasons: sent.reasons,
        afterShipping: sent.afterShipping,
        coolingDays: sent.coolingDays,
        lookbackDays: sent.lookbackDays,
        maxDiscountShare: sent.maxDiscountPercent / 100,
      },
    };
  });
});
afterEach(() => cleanup());

const open = (rule: WinbackRule = STORED, isOpen = true) =>
  render(<WinbackRuleDialog rule={rule} isOpen={isOpen} onClose={onClose} onSaved={onSaved} />);

const box = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(box(label), { target: { value } });
const reason = (label: string) => screen.getByRole('checkbox', { name: label }) as HTMLInputElement;
const save = () => fireEvent.click(screen.getByRole('button', { name: 'احفظ القاعدة' }));
const sent = () => JSON.parse(String((api.mock.calls[0][1] as RequestInit).body));
const refusal = () => screen.getByRole('alert').textContent;

describe('opening it', () => {
  it('— is drawn only while it is open', () => {
    open(STORED, false);
    expect(screen.queryByText('قاعدة استرجاع الملغى')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    cleanup();
    open();
    expect(screen.getByText('قاعدة استرجاع الملغى')).toBeTruthy();
  });

  it('and shows what is stored: the three numbers, the four reasons ticked, the three optional ones not', () => {
    open();
    expect(box(COOLING).value).toBe('14');
    expect(box(LOOKBACK).value).toBe('120');
    expect(box(PERCENT).value).toBe('25');
    for (const on of ['السعر مرتفع', 'وجدها أرخص عند غيرنا', 'غيّر رأيه', 'أُغلق بعد ثلاث محاولات بلا ردّ']) {
      expect(reason(on).checked, on).toBe(true);
    }
    for (const off of ['لا يريد المنتج', 'خارج نطاق التغطية', 'سبب آخر']) {
      expect(reason(off).checked, off).toBe(false);
    }
  });

  it('and writes the limit of every number under it, from the bounds the route judges by', () => {
    open();
    expect(screen.getByText('من 1 إلى 90')).toBeTruthy();
    expect(screen.getByText('من 30 إلى 365')).toBeTruthy();
    expect(screen.getByText('من 0 إلى 50')).toBeTruthy();
  });

  it.each([
    [0.25, '25'],
    [0.125, '12.5'],
    [0.07, '7'],
    [0.29, '29'],
    [0.5, '50'],
    [0, '0'],
  ])('and the discount is the percent he thinks in — a stored %s reads %s, without float dust', (share, text) => {
    open({ ...STORED, maxDiscountShare: share });
    expect(box(PERCENT).value).toBe(text);
  });

  it('and a stored rule that is not the default opens as itself', () => {
    open({ reasons: ['OTHER', 'PRICE_TOO_HIGH'], afterShipping: true, coolingDays: 3, lookbackDays: 45, maxDiscountShare: 0.1 });
    expect(box(COOLING).value).toBe('3');
    expect(box(LOOKBACK).value).toBe('45');
    expect(box(PERCENT).value).toBe('10');
    expect(reason('سبب آخر').checked).toBe(true);
    expect(reason('السعر مرتفع').checked).toBe(true);
    expect(reason('غيّر رأيه').checked).toBe(false);
  });
});

describe('what it offers, and what it will not', () => {
  /**
   * REWRITTEN ON 28/10: this counted EVERY tick in the form as a reason. The form has one more now, the
   * owner's switch «يشمل المرتجع بعد الشحن» — outside the reasons, before them — so the reasons are counted
   * where they live, in their own group, and the switch is the only tick outside it.
   */
  it('— seven reasons to tick, exactly: the four, and the three at his own risk — and the switch, outside them', () => {
    open();
    const names = within(screen.getByRole('group')).getAllByRole('checkbox').map((c) => c.closest('label')?.textContent);
    expect(names).toEqual([
      'السعر مرتفع',
      'وجدها أرخص عند غيرنا',
      'غيّر رأيه',
      'أُغلق بعد ثلاث محاولات بلا ردّ',
      'لا يريد المنتج',
      'خارج نطاق التغطية',
      'سبب آخر',
    ]);
    const outside = screen.getAllByRole('checkbox').filter((c) => !c.closest('fieldset'));
    expect(outside.map((c) => c.closest('label')?.textContent)).toEqual([AFTER]);
  });

  it('and the four nobody may be rung for have no box — a duplicate, a wrong number, a fake order, an entry error', () => {
    open();
    for (const never of ['طلب مكرّر', 'رقم خاطئ', 'طلب وهميّ', 'خطأ إدخال من المُعدِّل']) {
      expect(screen.queryByRole('checkbox', { name: never }), never).toBeNull();
    }
  });

  /**
   * REWRITTEN ON 28/10, DELIBERATELY. The first refusal this sentence named was «الطلب الذي شُحن (إرجاعٌ له
   * حسابه)» — any shipped parcel, which the owner's ruling took out of «never». What no setting reaches now is
   * a parcel that left and is NOT back, or is back and nobody received it.
   */
  it('and says so in a sentence, with the structural refusals beside them — so «why is there no tick» has an answer', () => {
    open();
    const sentence = screen.getByText(/لا يتغيّر بأيّ إعداد/).textContent!;
    for (const part of ['ما شُحن ولم يرجع', 'رجع ولم يستلمه المستودع', 'ما عُرض عليه من قبل', 'محاولةُ الاسترجاع نفسُها']) expect(sentence, part).toContain(part);
    for (const never of ['طلب مكرّر', 'رقم خاطئ', 'طلب وهميّ', 'خطأ إدخال من المُعدِّل']) expect(sentence, never).toContain(never);
    expect(sentence, 'ما زال يقول إنّ كلّ ما شُحن ممنوع').not.toContain('الطلب الذي شُحن');
  });

  it('and the three at his own risk are introduced as his responsibility', () => {
    open();
    expect(screen.getByText(/على مسؤوليتك/)).toBeTruthy();
  });
});

describe('saving a rule', () => {
  it('— sends one PUT to the rule’s door, with the numbers as numbers and the discount as a percent', async () => {
    open();
    type(COOLING, '10');
    type(LOOKBACK, '90');
    type(PERCENT, '12.5');
    fireEvent.click(reason('وجدها أرخص عند غيرنا'));
    fireEvent.click(reason('سبب آخر'));
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe('/api/confirmation/winback/rule');
    const init = api.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = sent();
    // REWRITTEN ON 28/10: one more key, the switch, sent every time — on or off, never left to a default.
    expect(Object.keys(body).sort()).toEqual(['afterShipping', 'coolingDays', 'lookbackDays', 'maxDiscountPercent', 'reasons']);
    expect(body.afterShipping).toBe(true);
    expect(body.coolingDays).toBe(10);
    expect(body.lookbackDays).toBe(90);
    expect(body.maxDiscountPercent).toBe(12.5);
    expect([...body.reasons].sort()).toEqual(['CUSTOMER_CHANGED_MIND', 'NO_ANSWER_3_ATTEMPTS', 'OTHER', 'PRICE_TOO_HIGH']);
  });

  it('and tells the screen what the ROUTE answered — not what was typed — and only then closes', async () => {
    api.mockResolvedValue({ rule: { ...STORED, coolingDays: 11 } });
    open();
    type(COOLING, '10');
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalledWith({ ...STORED, coolingDays: 11 });
    expect(order).toEqual(['saved', 'closed']);
  });

  it('and Enter in a box saves WITHOUT the browser going to another address — the submit event is cancelled', async () => {
    open();
    const form = box(COOLING).closest('form')!;
    const notCancelled = fireEvent.submit(form);
    expect(notCancelled).toBe(false);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('and saving what is already stored is allowed — nothing was typed, nothing is refused', async () => {
    open();
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent()).toEqual({
      reasons: STORED.reasons,
      afterShipping: true,
      coolingDays: 14,
      lookbackDays: 120,
      maxDiscountPercent: 25,
    });
  });

  it('and a number typed on an Arabic keyboard is a number — ١٠ is 10', async () => {
    open();
    type(COOLING, '١٠');
    type(LOOKBACK, '۹۰');
    type(PERCENT, '١٢.٥');
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent()).toMatchObject({ coolingDays: 10, lookbackDays: 90, maxDiscountPercent: 12.5 });
  });

  it('and spaces around a number are nothing', async () => {
    open();
    type(COOLING, '  7 ');
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent().coolingDays).toBe(7);
  });

  it.each([
    ['the smallest cooling and look-back', '1', '30', '25'],
    ['the largest cooling and look-back', '90', '365', '25'],
    ['no discount at all', '14', '120', '0'],
    ['the largest discount', '14', '120', '50'],
  ])('and the edges of every bound are accepted — %s', async (_what, cooling, lookback, percent) => {
    open();
    type(COOLING, cooling);
    type(LOOKBACK, lookback);
    type(PERCENT, percent);
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent()).toMatchObject({ coolingDays: Number(cooling), lookbackDays: Number(lookback), maxDiscountPercent: Number(percent) });
  });
});

describe('what it refuses before it sends', () => {
  const none = async () => {
    // A refusal is synchronous; give a stray request the time a real one would need.
    await new Promise((r) => setTimeout(r, 20));
    expect(api).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  };

  it('— no reason ticked: «اختر سبباً واحداً على الأقلّ»', async () => {
    open();
    for (const ticked of ['السعر مرتفع', 'وجدها أرخص عند غيرنا', 'غيّر رأيه', 'أُغلق بعد ثلاث محاولات بلا ردّ']) fireEvent.click(reason(ticked));
    save();
    expect(refusal()).toBe('اختر سبباً واحداً على الأقلّ');
    await none();
  });

  it.each([
    ['a cooling of zero', COOLING, '0', 'المهلة بالأيام: رقمٌ صحيحٌ من 1 إلى 90'],
    ['a cooling past the ceiling', COOLING, '91', 'المهلة بالأيام: رقمٌ صحيحٌ من 1 إلى 90'],
    ['a cooling in fractions', COOLING, '1.5', 'المهلة بالأيام: رقمٌ صحيحٌ من 1 إلى 90'],
    ['a cooling that is a word', COOLING, 'أسبوع', 'المهلة بالأيام: رقمٌ صحيحٌ من 1 إلى 90'],
    ['an EMPTY cooling — which is not zero, and not fourteen', COOLING, '', 'المهلة بالأيام: رقمٌ صحيحٌ من 1 إلى 90'],
    ['a blank cooling', COOLING, '   ', 'المهلة بالأيام: رقمٌ صحيحٌ من 1 إلى 90'],
    ['a look-back under a month', LOOKBACK, '29', 'أبعد طلب بالأيام: رقمٌ صحيحٌ من 30 إلى 365'],
    ['a look-back past a year', LOOKBACK, '366', 'أبعد طلب بالأيام: رقمٌ صحيحٌ من 30 إلى 365'],
    ['an empty look-back', LOOKBACK, '', 'أبعد طلب بالأيام: رقمٌ صحيحٌ من 30 إلى 365'],
    ['«500%»', PERCENT, '500', 'أقصى خصم: من 0 إلى 50٪'],
    ['51%', PERCENT, '51', 'أقصى خصم: من 0 إلى 50٪'],
    ['a negative discount', PERCENT, '-1', 'أقصى خصم: من 0 إلى 50٪'],
    ['an EMPTY discount — which is not «no discount»', PERCENT, '', 'أقصى خصم: من 0 إلى 50٪'],
    ['a discount that is a word', PERCENT, 'نصف', 'أقصى خصم: من 0 إلى 50٪'],
  ])('and %s: the sentence names the field and the limit, and nothing is sent', async (_what, label, value, sentence) => {
    open();
    type(label, value);
    save();
    expect(refusal()).toContain(sentence);
    await none();
  });

  it.each([
    ['equal to', '60', '60'],
    ['shorter than', '60', '45'],
  ])('and a look-back %s the cooling — no order would ever qualify — is refused, and nothing is sent', async (_how, cooling, lookback) => {
    open();
    type(COOLING, cooling);
    type(LOOKBACK, lookback);
    save();
    expect(refusal()).toBe('أبعد طلبٍ يجب أن يكون أكبر من المهلة — وإلا لا يدخل أيُّ طلب');
    await none();
  });

  it('and one day longer than the cooling is enough', async () => {
    open();
    type(COOLING, '60');
    type(LOOKBACK, '61');
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(sent()).toMatchObject({ coolingDays: 60, lookbackDays: 61 });
  });

  it('and a refusal goes away when the form is filled from the stored values again', () => {
    open();
    type(COOLING, '0');
    save();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'القيم الأصلية' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('when the route refuses what the form let through', () => {
  it('— the route’s sentence is shown inside the form, the form stays open, and nothing is told to the screen', async () => {
    api.mockRejectedValue(new Error('ليس لديك صلاحية لهذا الإجراء'));
    open();
    type(COOLING, '10');
    save();
    expect(await screen.findByText('ليس لديك صلاحية لهذا الإجراء')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('ليس لديك صلاحية لهذا الإجراء');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // What he typed is still there to be corrected.
    expect(box(COOLING).value).toBe('10');
  });

  it('and something that is not an Error still says something', async () => {
    api.mockRejectedValue('boom');
    open();
    save();
    expect(await screen.findByText('تعذّر الحفظ')).toBeTruthy();
  });

  it('and the button is pressable again, to try once more', async () => {
    api.mockRejectedValueOnce(new Error('انقطع الاتصال'));
    open();
    save();
    await screen.findByText('انقطع الاتصال');
    expect((screen.getByRole('button', { name: 'احفظ القاعدة' }) as HTMLButtonElement).disabled).toBe(false);
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('انقطع الاتصال')).toBeNull();
  });
});

describe('while it is saving', () => {
  it('— the three buttons are held, and pressing save again sends nothing more', async () => {
    let finish!: (v: unknown) => void;
    api.mockReturnValue(new Promise((r) => (finish = r)));
    open();
    save();
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    for (const name of ['احفظ القاعدة', 'القيم الأصلية', 'إلغاء']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled, name).toBe(true);
    }
    save();
    expect(api).toHaveBeenCalledTimes(1);
    finish({ rule: STORED });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

/**
 * «يشمل المرتجع بعد الشحن» — THE OWNER'S SWITCH (28/10). A real tick, beside its sentence, sent every time,
 * and the route's own judge accepts what it sends: «the checkbox is sent and accepted».
 */
describe('the switch for a parcel that came back', () => {
  const tick = () => screen.getByRole('checkbox', { name: AFTER }) as HTMLInputElement;

  it('— opens as stored: on, and off', () => {
    open();
    expect(tick().checked).toBe(true);
    cleanup();
    open({ ...STORED, afterShipping: false });
    expect(tick().checked).toBe(false);
  });

  it('and says what it lets in — a parcel received back, not held to the reasons below, cooling from the receipt', () => {
    open();
    expect(screen.getByText(/ما شُحن ثمّ رجع واستلمه المستودع/).textContent).toContain('من يوم الاستلام');
  });

  it('and unticked, it is sent as false — and the route’s judge accepts exactly that body, as a rule that is off', async () => {
    open();
    fireEvent.click(tick());
    expect(tick().checked).toBe(false);
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    const body = sent();
    expect(body.afterShipping).toBe(false);
    const judged = validateWinbackRule(body);
    expect(judged.ok).toBe(true);
    expect(judged.ok && judged.rule.afterShipping).toBe(false);
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ afterShipping: false }));
  });

  it('and ticked again, true — accepted as on', async () => {
    open({ ...STORED, afterShipping: false });
    fireEvent.click(tick());
    save();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(sent().afterShipping).toBe(true);
    const judged = validateWinbackRule(sent());
    expect(judged.ok && judged.rule.afterShipping).toBe(true);
  });

  it('and «القيم الأصلية» puts it back on — the owner asked for both', () => {
    open({ ...STORED, afterShipping: false });
    fireEvent.click(screen.getByRole('button', { name: 'القيم الأصلية' }));
    expect(tick().checked).toBe(true);
  });

  it('and reopened, it shows what is stored, not a tick that was changed and abandoned', () => {
    const view = open();
    fireEvent.click(tick());
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen={false} onClose={onClose} onSaved={onSaved} />);
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen onClose={onClose} onSaved={onSaved} />);
    expect(tick().checked).toBe(true);
  });
});

describe('the two other buttons', () => {
  it('— «القيم الأصلية» fills the form with the shop’s original rule and sends nothing', () => {
    open({ reasons: ['OTHER'], afterShipping: true, coolingDays: 3, lookbackDays: 45, maxDiscountShare: 0.1 });
    fireEvent.click(screen.getByRole('button', { name: 'القيم الأصلية' }));
    expect(box(COOLING).value).toBe(String(DEFAULT_WINBACK_RULE.coolingDays));
    expect(box(LOOKBACK).value).toBe(String(DEFAULT_WINBACK_RULE.lookbackDays));
    expect(box(PERCENT).value).toBe('25');
    expect(reason('سبب آخر').checked).toBe(false);
    expect(reason('السعر مرتفع').checked).toBe(true);
    expect(reason('غيّر رأيه').checked).toBe(true);
    expect(api).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('and «إلغاء» is not a second «احفظ» — it is a button that does nothing but close', () => {
    open();
    expect(screen.getByRole('button', { name: 'إلغاء' }).getAttribute('type')).toBe('button');
    expect(screen.getByRole('button', { name: 'القيم الأصلية' }).getAttribute('type')).toBe('button');
  });

  it('and «إلغاء» closes it without sending', () => {
    open();
    type(COOLING, '10');
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('opening it again, and the window behind it waking up', () => {
  it('— opened a second time it shows what is stored, not what was typed and abandoned', () => {
    const view = open();
    type(COOLING, '55');
    fireEvent.click(reason('سبب آخر'));
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen={false} onClose={onClose} onSaved={onSaved} />);
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen onClose={onClose} onSaved={onSaved} />);
    expect(box(COOLING).value).toBe('14');
    expect(reason('سبب آخر').checked).toBe(false);
  });

  it('and opened after the stored rule changed, it shows the NEW one', () => {
    const view = open();
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen={false} onClose={onClose} onSaved={onSaved} />);
    const changed = { ...STORED, coolingDays: 21, maxDiscountShare: 0.2 };
    view.rerender(<WinbackRuleDialog rule={changed} isOpen onClose={onClose} onSaved={onSaved} />);
    expect(box(COOLING).value).toBe('21');
    expect(box(PERCENT).value).toBe('20');
  });

  it('and an error left over from last time is gone when it opens', () => {
    const view = open();
    type(COOLING, '0');
    save();
    expect(screen.getByRole('alert')).toBeTruthy();
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen={false} onClose={onClose} onSaved={onSaved} />);
    view.rerender(<WinbackRuleDialog rule={STORED} isOpen onClose={onClose} onSaved={onSaved} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('and the screen re-reading the list while he types — coming back to the window — does not put his boxes back', () => {
    const view = open();
    type(COOLING, '55');
    type(PERCENT, '9');
    fireEvent.click(reason('سبب آخر'));
    // A new object with the same values: exactly what the list hands over each time it is read again.
    view.rerender(<WinbackRuleDialog rule={{ ...STORED, reasons: [...STORED.reasons] }} isOpen onClose={onClose} onSaved={onSaved} />);
    expect(box(COOLING).value).toBe('55');
    expect(box(PERCENT).value).toBe('9');
    expect(reason('سبب آخر').checked).toBe(true);
  });

  it('and even a rule that CHANGED underneath him leaves his boxes alone until he opens it again', () => {
    const view = open();
    type(COOLING, '55');
    view.rerender(<WinbackRuleDialog rule={{ ...STORED, coolingDays: 21 }} isOpen onClose={onClose} onSaved={onSaved} />);
    expect(box(COOLING).value).toBe('55');
  });
});

describe('how it is built', () => {
  const src = () => stripComments(readFileSync(join(process.cwd(), 'src/components/confirmation/WinbackRuleDialog.tsx'), 'utf8'));

  it('— it judges with the route’s own judge, and writes no bound of its own', () => {
    expect(src()).toContain('validateWinbackRule(');
    expect(src(), 'عادت حدودٌ مكتوبة بيد').not.toMatch(/\b(?:90|365)\b/);
  });

  it('and the reasons it offers are the lists the library names, not a copy', () => {
    expect(src()).toContain('WINBACK_REASONS.map(');
    expect(src()).toContain('OPTIONAL_WINBACK_REASONS.map(');
    expect(src()).toContain('NEVER_WINBACK_REASONS.map(');
  });

  it('and the form is a real form: a submit button and a field set, not a div with click handlers', () => {
    open();
    expect(screen.getByRole('button', { name: 'احفظ القاعدة' }).getAttribute('type')).toBe('submit');
    expect(within(screen.getByRole('group')).getAllByRole('checkbox')).toHaveLength(7);
  });
});
