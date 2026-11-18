// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { WEEKLY_TARGETS, weeklyMeasuresOf, type WeeklyFigures } from '@/lib/weekly-measures';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «القياس كل أسبوع» (request C3) — THE CARD DRAWS WHAT THE SERVER WROTE: SIX TILES, EACH WITH ITS TARGET AND HOW IT WAS COUNTED, THE TWO
 * CHECKS, «—» FOR A ZERO BASE, AND A PHONE LAYOUT OF TWO COLUMNS. Nothing behind the login can be photographed: this is the proof.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { calls, serve } = vi.hoisted(() => ({ calls: [] as string[], serve: { body: (_week: string): unknown => ({}), status: 200 } }));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.push(url);
    const week = /week=(\w+)/.exec(url)?.[1] ?? '';
    return { ok: serve.status === 200, status: serve.status, json: async () => serve.body(week) };
  }),
  saidBy: async (res: { json: () => Promise<{ errorAr?: string }> }, fallback: string) => (await res.json()).errorAr ?? fallback,
}));

import { WeeklyMeasures } from './WeeklyMeasures';

const FIGURES: WeeklyFigures = {
  firstCall: { medianMinutes: 12, base: 40, noCallYet: 3 },
  uniqueConfirmed: { confirmed: 0, base: 0, duplicates: 2, rate: null }, // a zero base
  retried: { retried: 19, base: 20, rate: 95 },
  backlog: { entered: 7, finished: 5, net: -2 },
  silentPulls: { silent: 1, base: 50, rate: 2 },
  delivered: { delivered: 8, base: 10, onTheRoad: 6, rate: 80 },
  checks: { fifth: { reached: 3, base: 12, rate: 25 }, onTheLine: { part: 9, base: 60, rate: 15 } },
  truncated: false,
};
const answer = (week: string, over: Partial<WeeklyFigures> = {}) => ({
  weekly: weeklyMeasuresOf({ ...FIGURES, ...over }),
  window: {
    week,
    fromDay: week === 'last' ? '2026-11-04' : '2026-11-11',
    toDay: week === 'last' ? '2026-11-10' : '2026-11-17',
    words: week === 'last' ? 'الأسبوع اللي قبلو: من 2026-11-04 لـ 2026-11-10' : 'آخر 7 أيام: من 2026-11-11 لـ 2026-11-17',
  },
});

beforeEach(() => {
  calls.length = 0;
  serve.status = 200;
  serve.body = (week) => answer(week);
});
afterEach(cleanup);

describe('the card', () => {
  it('six tiles, each with its figure, its counts, its target and its definition; the window beside the title', async () => {
    const { container } = render(<WeeklyMeasures />);
    await screen.findByText('سرعة أول اتصال');
    expect(calls).toEqual(['/api/orders/confirmation/no-answer?part=weekly&week=this']);
    expect(screen.getByText('القياس كل أسبوع')).toBeTruthy();
    expect(screen.getByText('آخر 7 أيام: من 2026-11-11 لـ 2026-11-17')).toBeTruthy();
    for (const label of ['سرعة أول اتصال', 'التأكيد من الطلبات الفريدة', 'لا يرد اللي انعاد عليه', 'المتأخر: اللي خلص ناقص اللي دخل', 'سحبات رجعت بلا اتصال', 'تسليم المؤكَّد'])
      expect(screen.getByText(label), label).toBeTruthy();
    expect(container.querySelectorAll('dl')).toHaveLength(6);
    const text = container.textContent ?? '';
    for (const t of [`${WEEKLY_TARGETS.firstCallMinutes} دقيقة عمل أو أقل`, `${WEEKLY_TARGETS.uniqueConfirmedPercent}% أو أكتر`, `${WEEKLY_TARGETS.retriedPercent}% أو أكتر`, 'صفر أو أكتر', `أقل من ${WEEKLY_TARGETS.silentPullsPercent}%`, `${WEEKLY_TARGETS.deliveredPercent}% أو أكتر`])
      expect(text, t).toContain(`الهدف: ${t}`);
    // Every percentage beside its counts, and what is counted apart.
    for (const t of ['19 من 20', '1 من 50', '8 من 10', 'لسا بالطريق: 6', 'لسا بلا اتصال: 3', 'خلص 5 · دخل 7', 'مكرّر برّا الحساب: 2']) expect(text, t).toContain(t);
    for (const v of ['12', '95%', '-2', '2%', '80%']) expect(screen.getAllByText(v).length, v).toBeGreaterThan(0);
    // How each was counted, under it.
    expect(text).toContain('بدقائق الدوام بس');
    expect(text).toContain('برّا الحساب.');
  });

  it('a zero base is «—» with no tone; the tone is said in a word beside the target', async () => {
    const { container } = render(<WeeklyMeasures />);
    await screen.findByText('سرعة أول اتصال');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    const unique = screen.getByText('التأكيد من الطلبات الفريدة').closest('dl')!;
    expect(unique.textContent).not.toMatch(/ماشي|انتباه|0%/);
    expect(screen.getByText('سرعة أول اتصال').closest('dl')!.textContent).toContain('— ماشي');
    expect(screen.getByText('المتأخر: اللي خلص ناقص اللي دخل').closest('dl')!.textContent).toContain('— انتباه');
    expect(container.textContent).not.toMatch(/[A-Za-z]{3,}/);
  });

  it('the two checks, as sentences under the tiles', async () => {
    render(<WeeklyMeasures />);
    await screen.findByText('سرعة أول اتصال');
    expect(screen.getByText(/^نسبة الرد بالمحاولة الخامسة 25% \(من 12\) — العيّنة صغيرة/)).toBeTruthy();
    expect(screen.getByText(/^دخول من «الزبون على الخط»: 9 من 60 \(15%\) — أكتر من 10%/)).toBeTruthy();
  });

  it('the week choice asks again with THAT week, and the window words follow the answer', async () => {
    render(<WeeklyMeasures />);
    await screen.findByText('سرعة أول اتصال');
    const button = screen.getByRole('radio', { name: 'الأسبوع اللي قبلو' });
    fireEvent.click(button);
    await screen.findByText('الأسبوع اللي قبلو: من 2026-11-04 لـ 2026-11-10');
    expect(calls).toEqual(['/api/orders/confirmation/no-answer?part=weekly&week=this', '/api/orders/confirmation/no-answer?part=weekly&week=last']);
  });

  it('a reader that hit its bound: «حد أدنى» is said', async () => {
    serve.body = (week) => answer(week, { truncated: true });
    render(<WeeklyMeasures />);
    await screen.findByText(/حد أدنى/);
  });

  it('NEGATIVE: an older server that does not know the part draws nothing; a refusal is said in its words', async () => {
    serve.body = () => ({ board: {}, report: {} });
    const { container } = render(<WeeklyMeasures />);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).toBe('');
    cleanup();
    serve.status = 403;
    serve.body = () => ({ errorAr: 'أداء الفريق للمشرف وحده.' });
    render(<WeeklyMeasures />);
    expect(await screen.findByText('أداء الفريق للمشرف وحده.')).toBeTruthy();
  });

  it('at 375 px: two columns of tiles, and no fixed width wider than the screen', async () => {
    const { container } = render(<WeeklyMeasures />);
    await screen.findByText('سرعة أول اتصال');
    const grid = container.querySelector('dl')!.closest('.grid')!;
    expect(grid.className.split(' ')).toContain('grid-cols-2');
    const fixed = new RegExp(['w', '-\\[(\\d+)px\\]'].join(''));
    for (const el of Array.from(container.querySelectorAll('[class]'))) {
      for (const c of el.getAttribute('class')!.split(/\s+/)) {
        const m = fixed.exec(c);
        if (m) expect(Number(m[1]), c).toBeLessThanOrEqual(375);
        // Built from pieces: a class-like word written whole in a test would grow the stylesheet.
        expect(c, c).not.toMatch(new RegExp(`^(${['min', 'w', '\\['].join('-')}|${['w', 'screen'].join('-')}$)`));
      }
    }
  });
});
