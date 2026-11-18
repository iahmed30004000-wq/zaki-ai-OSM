// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «لا رد والطلبات المحجوزة» DRAWS WHAT THE SERVER SENT — EVERY RATE BESIDE ITS BASE, AND A REFUSAL AS A REFUSAL.
 */

const { reply } = vi.hoisted(() => ({ reply: { status: 200, body: {} as unknown } }));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: reply.status === 200, status: reply.status, json: async () => reply.body })),
  saidBy: async (res: { json: () => Promise<{ errorAr?: string }> }, fallback: string) => (await res.json()).errorAr ?? fallback,
}));

import { NoAnswerWatch } from './NoAnswerWatch';

const rate = (key: string, reached: number, notReached: number, notACall: number) => {
  const base = reached + notReached;
  return { key, reached, notReached, base, notACall, rate: base ? Math.round((reached / base) * 100) : null };
};

afterEach(cleanup);

describe('the tab', () => {
  it('draws each agent’s five counts, the team’s two, and every rate with its counts', async () => {
    reply.status = 200;
    reply.body = {
      board: {
        agents: [{ id: 'u1', name: 'سارة', held: 131, onlyNoAnswer: 87, promisesDue: 6, stuck: 42, confirmedToday: 9 }],
        totals: { held: 131, onlyNoAnswer: 87, promisesDue: 6, stuck: 42, confirmedToday: 9 },
        team: { freshUnclaimed: 17, unclaimedWithNoAnswer: 23 },
        truncated: false,
      },
      report: {
        byHour: [rate('9', 1, 3, 0), rate('13', 0, 0, 5)],
        // UPDATED 2026-11-18 (request C3): the buckets were «1 · 2 · 3 · 4+» («الرابعة فما فوق»); they are «1 … 5 · 6+» («المحاولة N», «أكثر من 5»).
        byAttempt: [rate('1', 1, 7, 2), rate('2', 0, 0, 0), rate('3', 0, 0, 0), rate('4', 0, 0, 0), rate('5', 2, 6, 0), rate('6+', 0, 0, 0)],
        total: rate('الكل', 3, 11, 3),
        numbering: { mode: 'SPLIT', fromDay: '2026-11-18' },
        truncated: false,
      },
      rules: { stuckBusinessDays: 2, freshNewHours: 2 },
    };
    render(<NoAnswerWatch />);
    expect((await screen.findAllByText('سارة')).length).toBeGreaterThan(0);
    for (const n of ['131', '87', '42', '17', '23']) expect(screen.getAllByText(n).length, n).toBeGreaterThan(0);
    expect(screen.getAllByText('25%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('09:00').length).toBeGreaterThan(0);
    // A base of zero is a dash, never «0%».
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/3 من 14 \(21%\)/)).toBeTruthy();
    // The attempts are numbered 1 to 5 and «أكثر من 5» — the old «الرابعة فما فوق» is gone — and the plan's floor is said under them.
    for (const n of [1, 2, 3, 4, 5]) expect(screen.getAllByText(`المحاولة ${n}`).length, String(n)).toBeGreaterThan(0);
    expect(screen.getAllByText('أكثر من 5').length).toBeGreaterThan(0);
    expect(screen.queryByText('الرابعة فما فوق')).toBeNull();
    expect(screen.getByText(/من يوم 2026-11-18 الرقم هو المحاولة اللي انحسبت/)).toBeTruthy();
  });

  it('a refusal is said in the server’s words — never drawn as zeros', async () => {
    reply.status = 403;
    reply.body = { errorAr: 'أداء الفريق للمشرف وحده.' };
    render(<NoAnswerWatch />);
    expect(await screen.findByText('أداء الفريق للمشرف وحده.')).toBeTruthy();
    expect(screen.queryByText('ما بيد كل موظفة الآن')).toBeNull();
  });
});
