// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE RETURNS CARD TELLS THE OWNER WHAT HIS SECOND SWITCH CHANGES — AND WHEN IT CANNOT BE TURNED (the owner, 9/11).
 *
 * «الطلب يرجع للطابور فوراً (تجريبي)» is read by one person: the owner, in the settings. Its sentence is the only place the numbers
 * he decided on live in words — three working hours after a «لا يرد», thirty working minutes idle, five orders in a hand — and a
 * sentence nothing reads is a sentence that goes stale when a number moves. So they are held to the constants.
 *
 * And the box: it works only with «نظام الجولات» (the close is the rounds’ counting), so with the rounds off it is DISABLED and says
 * why — except when it is already ticked, which can always be unticked. Turning it on is the owner’s click (the server asks the key).
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));
vi.mock('@/lib/db', () => ({ db: {} }));

import { NoAnswerReturnsCard } from './NoAnswerReturnsCard';
import { RETURNS_MODE } from '@/lib/confirmation-queue';
import { ROUND_GAP_BUSINESS_MINUTES } from '@/lib/no-answer-rounds';

const OFF = { returns: { enabled: false, enabledAt: null }, roundsOn: true };

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue(OFF);
});
afterEach(cleanup);

/** The subtitle, as the owner reads it. */
async function subtitle(): Promise<string> {
  render(<NoAnswerReturnsCard />);
  return (await screen.findByText(/الطلب بيطلع من إيد الموظفة/)).textContent ?? '';
}
const box = () => screen.getByRole('checkbox') as HTMLInputElement;

describe('the sentence of «الطلب يرجع للطابور فوراً (تجريبي)»', () => {
  it('has its title, in Arabic', async () => {
    render(<NoAnswerReturnsCard />);
    expect(await screen.findByText('الطلب يرجع للطابور فوراً (تجريبي)')).toBeTruthy();
  });

  it('names the three numbers of the rule — and they ARE the constants: 3 working hours, 30 working minutes, 5 orders', async () => {
    const text = await subtitle();
    const hours = Number(/بعد (\d+) ساعات دوام/.exec(text)?.[1]);
    const minutes = Number(/(\d+) دقيقة دوام بيرجع للطابور لحاله/.exec(text)?.[1]);
    const orders = Number(/ما بتمسك أكتر من (\d+) طلبات/.exec(text)?.[1]);
    expect(hours * 60, 'ساعات «لا يرد» = فاصل الجولة').toBe(ROUND_GAP_BUSINESS_MINUTES);
    expect(minutes, 'دقائق الخمول').toBe(RETURNS_MODE.idleBusinessMinutes);
    expect(orders, 'حد اليد').toBe(RETURNS_MODE.handLimit);
  });

  it('says what leaves her hand and where it goes: a «لا يرد» or a date, at once, to the shared queue', async () => {
    const text = await subtitle();
    expect(text).toContain('«لا يرد» أو تحديد موعد = الطلب بيطلع من إيد الموظفة فوراً وبيرجع للطابور');
    expect(text).toContain('ومع الموعد بيجهز بموعده');
    expect(text).toContain('مع المحجوز إلها');
  });

  it('warns about the first switch-on: the old piles come back gradually — switch it on after work', async () => {
    const text = await subtitle();
    expect(text).toContain('أول ما تشغّليه بيرجّع الطلبات المتروكة تدريجياً، شغّليه بعد الدوام');
  });

  it('says it works only with «نظام الجولات», and that OFF is the work as it is', async () => {
    const text = await subtitle();
    expect(text).toContain('بيشتغل بس مع «نظام الجولات»');
    expect(text).toContain('مطفي = الشغل زي ما هو');
  });

  it('is three short lines, not one long paragraph', async () => {
    render(<NoAnswerReturnsCard />);
    const sentence = await screen.findByText(/الطلب بيطلع من إيد الموظفة/);
    expect((sentence.innerHTML ?? '').split(/<br\s*\/?>/)).toHaveLength(3);
  });

  it('is spoken Arabic with no English word on the card', async () => {
    const text = await subtitle();
    expect(/[A-Za-z]/.test(text), text).toBe(false);
    expect(/[A-Za-z]/.test(document.body.textContent ?? ''), document.body.textContent ?? '').toBe(false);
  });
});

describe('the box', () => {
  it('rounds on: it can be ticked — and a tick is a PUT of a plain yes, whose answer is what the card then shows', async () => {
    render(<NoAnswerReturnsCard />);
    await screen.findByRole('checkbox');
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(false);
    api.mockResolvedValueOnce({ returns: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' }, roundsOn: true });
    fireEvent.click(box());
    await waitFor(() => expect(box().checked).toBe(true));
    const [url, init] = api.mock.calls.at(-1)!;
    expect(url).toBe('/api/settings/no-answer-returns');
    expect(init).toMatchObject({ method: 'PUT', body: JSON.stringify({ enabled: true }) });
  });

  it('rounds OFF and the box clear: DISABLED, with the reason in a sentence beside it', async () => {
    api.mockResolvedValue({ returns: { enabled: false, enabledAt: null }, roundsOn: false });
    render(<NoAnswerReturnsCard />);
    await screen.findByRole('checkbox');
    expect(box().disabled).toBe(true);
    expect(await screen.findByText('مقفول: لازم «نظام الجولات» يكون شغّال أول، وهالمفتاح ما بيشتغل إلا معه.')).toBeTruthy();
  });

  it('rounds OFF but the box ticked (turned on, then the rounds turned off): it says it is not running, and can be unticked', async () => {
    api.mockResolvedValue({ returns: { enabled: true, enabledAt: '2026-11-09T06:00:00.000Z' }, roundsOn: false });
    render(<NoAnswerReturnsCard />);
    await screen.findByRole('checkbox');
    expect(box().checked).toBe(true);
    expect(box().disabled).toBe(false);
    expect(await screen.findByText('مش شغّال هلأ: «نظام الجولات» مطفي وهالمفتاح ما بيشتغل إلا معه.')).toBeTruthy();
  });

  it('is drawn for somebody who may only read it, too: the sentence is there, the box is disabled, and it says who turns it', async () => {
    can.value = false;
    const text = await subtitle();
    expect(text).toContain('30 دقيقة دوام');
    expect(box().disabled).toBe(true);
    expect(await screen.findByText('بيشغّله بس صاحب صلاحية «إعدادات النظام الحسّاسة».')).toBeTruthy();
  });

  it('a read that fails draws nothing at all (as the rounds’ card does)', async () => {
    api.mockRejectedValue(new Error('down'));
    const { container } = render(<NoAnswerReturnsCard />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
