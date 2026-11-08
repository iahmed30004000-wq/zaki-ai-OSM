// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE ROUNDS CARD TELLS THE OWNER WHAT HIS SWITCH CHANGES — AND WHAT IT DOES NOT (review of PR #217).
 *
 * The card's subtitle is the only place the owner reads the numbers he decided on 7/11: a «لا يرد» press within THREE working hours
 * is one round, an order nobody answered for TWELVE working hours (it was six until 8/11) goes back to the queue, a postponed or called-back order with
 * nothing logged on it THREE working hours after its date goes back too, and the third round closes an order only on a second
 * day. Changing the six to a three in the sentence passed every test — nothing read it. And «مطفي = القواعد الحالية تماماً» became
 * half a truth the day the pull's order and the cap stopped depending on the switch.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));

import { NoAnswerRoundsCard } from './NoAnswerRoundsCard';
import { ROUND_RELEASE_BUSINESS_MINUTES } from '@/lib/no-answer-rounds';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ rounds: { enabled: false, enabledAt: null } });
});
afterEach(cleanup);

/** The subtitle, as the owner reads it. */
async function subtitle(): Promise<string> {
  render(<NoAnswerRoundsCard />);
  return (await screen.findByText(/جولة وحدة/)).textContent ?? '';
}

describe('the subtitle of «نظام الجولات (تجريبي)»', () => {
  it('names the three numbers of the rules: 3 hours a round, 12 hours to go back (8/11 — it was 6), 3 hours after a date', async () => {
    const text = await subtitle();
    expect(text).toContain('«لا يرد» خلال 3 ساعات عمل = جولة وحدة');
    expect(text, 'يبقى 12 ساعة عمل').toContain('الطلب اللي ما حدا ردّ عليه 12 ساعة عمل بيرجع للطابور');
    expect(text, 'الموعد: 3 ساعات عمل').toContain('بعد موعده بـ3 ساعات عمل بيرجع كمان');
    expect(text).toContain('وما بينلغى إلا بعد 3 جولات بيومين مختلفين');
    // The sentence and the constant say the same number (RV1425): changing the one alone fails here.
    const hours = Number(/ردّ عليه (\d+) ساعة عمل/.exec(text)?.[1]);
    expect(hours * 60).toBe(ROUND_RELEASE_BUSINESS_MINUTES);
  });

  it('says the new rule in a second line of its own: «الشغل أول» — a call she owes comes before a new pull', async () => {
    render(<NoAnswerRoundsCard />);
    const sentence = await screen.findByText(/جولة وحدة/);
    const lines = (sentence.innerHTML ?? '').split(/<br\s*\/?>/);
    expect(lines, 'two lines, not one long one').toHaveLength(2);
    expect(lines[1]).toContain('الشغل أول: الطلب اللي لازم ترني عليه هلّق');
    expect(lines[1]).toContain('جديد، أو لا يرد حان وقت جولته، أو موعد وصل');
    expect(lines[1]).toContain('بيمنع سحب طلب جديد لحد ما تسجّل عليه محاولة');
  });

  it('says what the date rule measures — an attempt LOGGED after the date, not a card that was opened', async () => {
    const text = await subtitle();
    expect(text).toContain('ما انسجّلت عليه محاولة بعد موعده');
    expect(text).not.toContain('فتحه');
  });

  it('tells the truth about OFF: the old rotation and rounds — and the pull order and the cap do not depend on the switch', async () => {
    const text = await subtitle();
    expect(text).toContain('مطفي = قواعد التدوير والجولات القديمة');
    expect(text).toContain('ترتيب السحب والحد ما بيتأثروا بالمفتاح');
    // The old half-truth is gone: with the switch off the pull's order and the cap are NOT the "current rules exactly".
    expect(text).not.toContain('القواعد الحالية تماماً');
  });

  it('is spoken Arabic with no English word on it', async () => {
    const text = await subtitle();
    expect(/[A-Za-z]/.test(text), text).toBe(false);
  });

  it('is drawn for somebody who may only read it, too — the box is disabled, the sentence is there', async () => {
    can.value = false;
    const text = await subtitle();
    expect(text).toContain('12 ساعة عمل');
    expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  });
});
