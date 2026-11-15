// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE CALL-PROOF CARD TELLS THE OWNER WHAT HIS ONE SWITCH CHANGES — STEP A AND STEP B (the planner's ruling: one switch, 15/11/2026).
 *
 * «إثبات المكالمات وجدول المحاولات (تجريبي)» is read by one person: the owner, in the settings. Its sentence is the only place the numbers he decided on live in words — five attempts,
 * half an hour, two hours, 9–12, 6–10 in the evening — and it must also tell him what he cannot see from the switch's name: that it ALSO brings «الطلب يرجع للطابور فوراً»
 * (the hand limit, the idle release, the old piles coming back on the first turn-on). A sentence nothing reads goes stale when a number moves, so the numbers are held to the constants.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, can } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn() }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));
vi.mock('@/lib/db', () => ({ db: {} }));

import { CallProofCard } from './CallProofCard';
import { CADENCE_EVENING, CADENCE_GAPS_MS, CADENCE_LIMIT, CADENCE_MORNING } from '@/lib/no-answer-cadence';
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
    const windows = [...text.matchAll(/بين (\d+) و(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(windows[0]).toEqual([CADENCE_MORNING.from, CADENCE_MORNING.to]);
    expect(windows[1]).toEqual([CADENCE_EVENING.from - 12, CADENCE_EVENING.to - 12]);
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
