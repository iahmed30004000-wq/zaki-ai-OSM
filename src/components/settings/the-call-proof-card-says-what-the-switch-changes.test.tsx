// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CALL-PROOF CARD TELLS THE OWNER WHAT HIS ONE SWITCH CHANGES — STEP A AND STEP B (the planner's ruling: one switch, 15/11/2026).
 *
 * «إثبات المكالمات وجدول المحاولات (تجريبي)» is read by one person: the owner, in the settings. Its sentence is the only place the numbers he decided on live in words — five attempts,
 * half an hour and two hours (inside the country's work hours and work days), the start of work and 6 in the evening with their 8 h and 3 h floors, and the rest days they skip — and it must also tell him what he cannot see from the switch's name: that it ALSO brings «الطلب يرجع للطابور فوراً»
 * (the hand limit, the idle release, the old piles coming back on the first turn-on). A sentence nothing reads goes stale when a number moves, so the numbers are held to the constants.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));
vi.mock('@/lib/db', () => ({ db: {} }));

import { CallProofCard } from './CallProofCard';
import { CADENCE_EVENING_FROM, CADENCE_FLOORS_MS, CADENCE_GAPS_MS, CADENCE_LIMIT, CADENCE_WORKDAY_END, CADENCE_WORKDAY_START } from '@/lib/no-answer-cadence';
import { RETURNS_MODE } from '@/lib/confirmation-queue';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ callProof: { enabled: false, enabledAt: null } });
});
afterEach(cleanup);

/** The subtitle, as the owner reads it. */
async function subtitle(): Promise<string> {
  render(<CallProofCard />);
  return (await screen.findByText(/ونفس المفتاح بيشغّل جدول المحاولات/)).textContent ?? '';
}

describe('the sentence of «إثبات المكالمات وجدول المحاولات (تجريبي)»', () => {
  it('has its title, in Arabic, and keeps the step-A promises', async () => {
    const text = await subtitle();
    expect(screen.getByText('إثبات المكالمات وجدول المحاولات (تجريبي)')).toBeTruthy();
    expect(text).toContain('30 ثانية');
    expect(text).toContain('شغّله برّا الدوام');
    expect(text).toContain('مطفي = الشغل زي ما هو');
  });

  it('names the five attempts and the times — and they ARE the constants', async () => {
    const text = await subtitle();
    expect(Number(/(\d+) محاولات على يومين/.exec(text)?.[1])).toBe(CADENCE_LIMIT);
    expect(text).toContain('التانية بعد نص ساعة');
    expect(CADENCE_GAPS_MS.afterFirst).toBe(30 * 60_000);
    expect(text).toContain('التالتة بعد ساعتين');
    expect(CADENCE_GAPS_MS.afterSecond).toBe(2 * 3_600_000);
    // #4 is at the COUNTRY's start of work; only when the country has no hours does the plan use the constants 10:00 and 22:00 (said in 12-hour spoken form: «10 الصبح لحد 10 بالليل»), #5 from 18:00
    expect(text).toContain('الرابعة عند بداية دوام البلد');
    expect(Number(/من (\d+) الصبح لحد \d+ بالليل/.exec(text)?.[1])).toBe(Number(CADENCE_WORKDAY_START.slice(0, 2)));
    expect(Number(/من \d+ الصبح لحد (\d+) بالليل/.exec(text)?.[1])).toBe(Number(CADENCE_WORKDAY_END.slice(0, 2)) - 12);
    expect(Number(/الخامسة الساعة (\d+) مسا/.exec(text)?.[1])).toBe(Number(CADENCE_EVENING_FROM.slice(0, 2)) - 12);
  });

  it('says the second and third attempts fall INSIDE the country’s work hours and work days, and move to the next start of work when they would not', async () => {
    const text = await subtitle();
    expect(text).toContain('التانية والتالتة لازم تقع ضمن ساعات دوام البلد وأيام عملو');
    expect(text).toContain('إذا وقعت برّا الدوام أو بيوم عطلة بتصير أول بداية دوام جاية');
    expect(text).toContain('إذا ما في دوام مكتوب للبلد');
  });

  it('names the two floors — 8 hours after the third, 3 hours after the fourth — and they ARE the constants', async () => {
    const text = await subtitle();
    expect(Number(/(\d+) ساعات على الأقل من التالتة/.exec(text)?.[1])).toBe(CADENCE_FLOORS_MS.beforeFourth / 3_600_000);
    expect(Number(/(\d+) ساعات على الأقل من الرابعة/.exec(text)?.[1])).toBe(CADENCE_FLOORS_MS.beforeFifth / 3_600_000);
  });

  it('says every due skips the rest days the Country’s settings name — and skips nothing when none are named', async () => {
    const text = await subtitle();
    expect(text).toContain('أيام العطلة المحددة بإعدادات البلد بتنتخطّى بكل المواعيد');
    expect(text).toContain('وإذا ما في أيام محددة ما بتنتخطّى شي');
  });

  it('says an early press is kept and not counted, that the fifth closes to «ملغاة سابقاً», and that earlier lines do not count', async () => {
    const text = await subtitle();
    expect(text).toContain('ما بتنحسب');
    expect(text).toContain('«ملغاة سابقاً»');
    expect(text).toContain('اللي انسجّل قبل التشغيل ما بينحسب');
  });

  it('tells him the same switch brings «الطلب يرجع للطابور فوراً» — and its numbers ARE the constants: 5 orders, 30 working minutes', async () => {
    const text = await subtitle();
    expect(text).toContain('«الطلب يرجع للطابور فوراً»');
    expect(Number(/ما بتمسك أكتر من (\d+) طلبات/.exec(text)?.[1])).toBe(RETURNS_MODE.handLimit);
    expect(Number(/(\d+) دقيقة دوام بيرجع للطابور لحاله/.exec(text)?.[1])).toBe(RETURNS_MODE.idleBusinessMinutes);
    expect(text).toContain('بيرجّع الطلبات المتروكة تدريجياً');
  });

  it('says there is no automatic WhatsApp (it is not built)', async () => {
    expect(await subtitle()).toContain('ما في واتساب تلقائي');
  });

  it('is spoken Arabic: no Latin letter, no Arabic-Indic digit', async () => {
    const text = await subtitle();
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('the checkbox is still the only control', async () => {
    await subtitle();
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
