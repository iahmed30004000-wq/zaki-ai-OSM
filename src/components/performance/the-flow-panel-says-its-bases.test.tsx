// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HeldFlow } from '@/lib/held-flow';
import { stripComments } from '@/lib/guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «حركة الطلبات» — THE PANEL DRAWS WHAT THE SERVER SAID, EVERY SHARE BESIDE ITS BASE, AND NEVER TAKES THE BOARD DOWN WITH IT.
 *
 * The server's answer is one object (`HeldFlow`); this file holds the screen to it: each tile carries its figure and its base, a
 * base of zero is a dash, the window choice asks AGAIN and only the flow (the board is not re-asked), a failure of the panel is its
 * own small line and the board still draws, and an older server that answers the board for `part=flow` is said, not drawn as zeros.
 * ═══════════════════════════════════════════════════════════════════════
 */

type Reply = { status: number; body: unknown } | Promise<{ status: number; body: unknown }> | 'throw';
const { calls, serve } = vi.hoisted(() => ({
  calls: [] as string[],
  serve: {} as { board: Reply; report: Reply; flow: (window: string) => Reply },
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.push(url);
    const part = /part=(\w+)/.exec(url)?.[1];
    const window = /window=(\w+)/.exec(url)?.[1] ?? '';
    const reply = part === 'flow' ? serve.flow(window) : part === 'board' ? serve.board : serve.report;
    if (reply === 'throw') throw new Error('offline');
    const { status, body } = await reply;
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }),
  saidBy: async (res: { json: () => Promise<{ errorAr?: string }> }, fallback: string) => (await res.json()).errorAr ?? fallback,
}));

import { HeldFlowPanel } from './HeldFlowPanel';
import { NoAnswerWatch } from './NoAnswerWatch';

const flowOf = (over: Partial<HeldFlow> = {}): HeldFlow => ({
  window: { key: '24h', label: 'آخر 24 ساعة', start: '2026-11-12T12:00:00.000Z', end: '2026-11-13T12:00:00.000Z' },
  created: 540,
  entered: { pulled: 312, typed: 0, onTheLine: 0, total: 312 },
  exits: { confirmed: 210, returned: 80, cancelled: 15, total: 305 },
  net: 7,
  moved: 0,
  unknown: 0,
  held: { total: 1342, under6h: 200, from6hTo24h: 300, from1dTo3d: 500, over3d: 342, unknownAge: 0, oldestMs: 9 * 86_400_000 },
  speed: { judged: 300, withAttempt: 280, fast: 250, medianMinutes: 7 },
  bounced: { orders: 12, of: 290 },
  workMinutes: 480,
  truncated: { ledger: false, decisions: false, attempts: false, held: false },
  reading: { tone: 'CALM', label: 'ماشية', sentences: ['الحركة ماشية: سحبوا 312 وطلع من أيديهم 305.'] },
  rules: { fastMinutes: 30 },
  ...over,
});

const EMPTY: Partial<HeldFlow> = {
  created: 0,
  entered: { pulled: 0, typed: 0, onTheLine: 0, total: 0 },
  exits: { confirmed: 0, returned: 0, cancelled: 0, total: 0 },
  net: 0,
  held: { total: 0, under6h: 0, from6hTo24h: 0, from1dTo3d: 0, over3d: 0, unknownAge: 0, oldestMs: null },
  speed: { judged: 0, withAttempt: 0, fast: 0, medianMinutes: null },
  bounced: { orders: 0, of: 0 },
  reading: { tone: 'CALM', label: 'ماشية', sentences: ['ما في حركة بهالمدة، ولا في طلبات محجوزة عند الموظفات.'] },
};

const BOARD = {
  board: {
    agents: [{ id: 'u1', name: 'سارة', held: 131, onlyNoAnswer: 87, promisesDue: 6, stuck: 42, confirmedToday: 9 }],
    totals: { held: 1342, onlyNoAnswer: 87, promisesDue: 6, stuck: 42, confirmedToday: 9 },
    team: { freshUnclaimed: 17, unclaimedWithNoAnswer: 23 },
    truncated: false,
  },
  rules: { stuckBusinessDays: 2, freshNewHours: 2 },
};
const REPORT = {
  report: {
    byHour: [{ key: '9', reached: 1, notReached: 3, base: 4, notACall: 0, rate: 25 }],
    byAttempt: [{ key: '1', reached: 1, notReached: 7, base: 8, notACall: 2, rate: 13 }],
    total: { key: 'الكل', reached: 3, notReached: 11, base: 14, notACall: 3, rate: 21 },
    truncated: false,
  },
};

beforeEach(() => {
  calls.length = 0;
  serve.board = { status: 200, body: BOARD };
  serve.report = { status: 200, body: REPORT };
  serve.flow = () => ({ status: 200, body: { flow: flowOf() } });
});
afterEach(cleanup);

const tile = (label: string) => screen.getByText(label).closest('div') as HTMLElement;
const flowCalls = () => calls.filter((u) => u.includes('part=flow'));
const panel = () => screen.getByRole('region', { name: 'حركة الطلبات' });

describe('what it draws', () => {
  it('the sentence first, with its tone in a word; then the four tiles of the flow, each with its second line', async () => {
    render(<HeldFlowPanel />);
    expect(await screen.findByText('الحركة ماشية: سحبوا 312 وطلع من أيديهم 305.')).toBeTruthy();
    expect(within(panel()).getByText('ماشية')).toBeTruthy();

    expect(within(tile('دخل النظام')).getByText('540')).toBeTruthy();
    expect(within(tile('انسحب')).getByText('312')).toBeTruthy();
    expect(within(tile('انسحب')).getByText('سحبة من الطابور')).toBeTruthy();
    expect(within(tile('طلع من الأيدي')).getByText('305')).toBeTruthy();
    expect(within(tile('طلع من الأيدي')).getByText('أُكِّد 210 · رجع للطابور 80 · انلغى 15')).toBeTruthy();
    expect(within(tile('الصافي')).getByText('+7')).toBeTruthy();
    expect(within(tile('الصافي')).getByText('دخل الأيدي 312 − طلع 305 = المحجوز زاد')).toBeTruthy();
  });

  it('the held pile by age, each count beside its base, the total and the oldest in the heading', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText('من قديش محجوزة — المحجوز هلّق 1342', { exact: false });
    expect(screen.getByText(/أقدمها من 9 أيام/)).toBeTruthy();
    for (const [label, n] of [
      ['أقل من 6 ساعات', '200'],
      ['من 6 لـ 24 ساعة', '300'],
      ['من يوم لـ 3 أيام', '500'],
      ['أكتر من 3 أيام', '342'],
    ]) {
      expect(within(tile(label)).getByText(n), label).toBeTruthy();
      expect(within(tile(label)).getByText('من 1342'), label).toBeTruthy();
    }
  });

  it('how smooth: the median beside the pulls it was made from, the share beside «X من Y», the bounce beside its base', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('7 دقائق')).toBeTruthy();
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('من 280 سحبة عليها محاولة — بدقائق الدوام')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('83%')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('250 من 300 سحبة')).toBeTruthy();
    expect(within(tile('طلبات تنقّلت بين موظفتين أو أكتر')).getByText('12')).toBeTruthy();
    expect(within(tile('طلبات تنقّلت بين موظفتين أو أكتر')).getByText('من 290 طلب انسحب')).toBeTruthy();
  });

  it('says how it is counted, in words: wall clock for the pile, working minutes for the speed, and what the ledger does not see', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText(/أعمار المحجوز بالساعات الفعلية/);
    expect(screen.getByText(/سرعة الاتصال بدقائق الدوام/)).toBeTruthy();
    expect(screen.getByText(/إرجاع إشكال الإدخال وإرجاع المؤجَّل بدري وإيقاف الشحنة ما بينكتبوا بالسجل/)).toBeTruthy();
  });

  it('is Arabic only — no Latin letter anywhere on it, and no NaN', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    const text = panel().textContent ?? '';
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(/NaN|undefined|null|Infinity/);
  });

  it('draws two sentences when the server sent two', async () => {
    serve.flow = () => ({
      status: 200,
      body: {
        flow: flowOf({
          reading: {
            tone: 'WATCH',
            label: 'انتباه',
            sentences: ['المحجوز عم يزيد: سحبوا 340 وطلع من أيديهم 260.', '342 طلب محجوز من أكتر من 3 أيام — أقدمهم من 9 أيام.'],
          },
        }),
      },
    });
    render(<HeldFlowPanel />);
    expect(await screen.findByText('المحجوز عم يزيد: سحبوا 340 وطلع من أيديهم 260.')).toBeTruthy();
    expect(screen.getByText('342 طلب محجوز من أكتر من 3 أيام — أقدمهم من 9 أيام.')).toBeTruthy();
    expect(within(panel()).getByText('انتباه')).toBeTruthy();
  });
});

describe('the sign of the net', () => {
  const netOf = async (net: number) => {
    cleanup();
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ net }) } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    return within(tile('الصافي'));
  };

  it('plus when the pile grew, a real minus when it shrank, a bare zero when it did not move — each read left to right', async () => {
    expect((await netOf(27)).getByText('+27')).toBeTruthy();
    expect((await netOf(-12)).getByText('−12')).toBeTruthy();
    const zero = await netOf(0);
    expect(zero.getByText('0')).toBeTruthy();
    expect(zero.getByText(/= متعادل/)).toBeTruthy();
    for (const n of [27, -12, 0]) {
      const el = (await netOf(n)).getByText(n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
      expect(el.getAttribute('dir')).toBe('ltr');
    }
  });

  it('says in words which way: «المحجوز زاد» · «المحجوز نقص» · «متعادل»', async () => {
    expect((await netOf(5)).getByText(/= المحجوز زاد/)).toBeTruthy();
    expect((await netOf(-5)).getByText(/= المحجوز نقص/)).toBeTruthy();
  });
});

describe('what is counted apart is SAID, never folded in', () => {
  it('orders the agents typed or took on the line are named under «انسحب», and the pulls stay the pulls', async () => {
    serve.flow = () => ({
      status: 200,
      body: { flow: flowOf({ entered: { pulled: 312, typed: 38, onTheLine: 4, total: 354 }, net: 49 }) },
    });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(within(tile('انسحب')).getByText('312')).toBeTruthy();
    expect(within(tile('انسحب')).getByText('سحبة من الطابور · 38 أدخلتها الموظفات بنفسهن · 4 أخدوها على الخط')).toBeTruthy();
    expect(within(tile('الصافي')).getByText('دخل الأيدي 354 − طلع 305 = المحجوز زاد')).toBeTruthy();
    expect(screen.getByText(/«بغير السحب» = طلب كتبته الموظفة بنفسها أو أخدته على الخط/)).toBeTruthy();
  });

  it('a hand-over line and a line nobody can name are each said with their count — and absent when there are none', async () => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ moved: 6, unknown: 3, held: { ...flowOf().held, unknownAge: 2 } }) } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(screen.getByText('حوّل المشرف أو أخد المالك 6 طلب بين الأيدي — ما دخل بالصافي.')).toBeTruthy();
    expect(screen.getByText('وفي 3 سجل بسبب أو نوع ما بنعرفو — ما دخل بأي رقم.')).toBeTruthy();
    expect(screen.getByText('وفي 2 طلب ما انسجّل وقت استلامه — ما دخل بأي خانة.')).toBeTruthy();
    cleanup();
    serve.flow = () => ({ status: 200, body: { flow: flowOf() } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(screen.queryByText(/ما دخل بالصافي/)).toBeNull();
    expect(screen.queryByText(/ما بنعرفو/)).toBeNull();
    expect(screen.queryByText(/ما انسجّل وقت استلامه/)).toBeNull();
    expect(screen.queryByText(/«بغير السحب»/)).toBeNull();
  });
});

describe('a base of zero is a dash — never «0%», never a made-up median', () => {
  it('an empty store: counts are zeros, every rate and median is a dash, the sentence is calm', async () => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf(EMPTY) } });
    render(<HeldFlowPanel />);
    expect(await screen.findByText('ما في حركة بهالمدة، ولا في طلبات محجوزة عند الموظفات.')).toBeTruthy();
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('—')).toBeTruthy();
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('ما في سحبة عليها محاولة بهالمدة')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('—')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('ما في سحبة تنحكم عليها')).toBeTruthy();
    expect(within(tile('طلبات تنقّلت بين موظفتين أو أكتر')).getByText('—')).toBeTruthy();
    expect(within(tile('طلبات تنقّلت بين موظفتين أو أكتر')).getByText('ما انسحب طلب بهالمدة')).toBeTruthy();
    expect(within(tile('دخل النظام')).getByText('0')).toBeTruthy();
    expect(within(tile('الصافي')).getByText('0')).toBeTruthy();
    // No percentage anywhere without a base, and no «من 0».
    expect(panel().textContent).not.toMatch(/\d+%/);
    expect(panel().textContent).not.toMatch(/من 0/);
    // And with nothing held, no oldest and no base under the four ages.
    expect(screen.queryByText(/أقدمها من/)).toBeNull();
    expect(within(tile('أكتر من 3 أيام')).queryByText(/^من /)).toBeNull();
  });

  it('a median of zero is «أقل من دقيقة», not a dash — somebody did answer at once', async () => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ speed: { judged: 4, withAttempt: 4, fast: 4, medianMinutes: 0 } }) } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('أقل من دقيقة')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('100%')).toBeTruthy();
  });

  it('pulls nobody attempted yet: the share is judged on its own base, the median has none', async () => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ speed: { judged: 9, withAttempt: 0, fast: 0, medianMinutes: null } }) } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('—')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('0%')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('0 من 9 سحبة')).toBeTruthy();
  });

  it('a bounce count of zero with a base is «0», with its base beside it', async () => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ bounced: { orders: 0, of: 40 } }) } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(within(tile('طلبات تنقّلت بين موظفتين أو أكتر')).getByText('0')).toBeTruthy();
    expect(within(tile('طلبات تنقّلت بين موظفتين أو أكتر')).getByText('من 40 طلب انسحب')).toBeTruthy();
  });
});

describe('a read that hit its bound is said where it matters', () => {
  const cut = (truncated: Partial<HeldFlow['truncated']>, over: Partial<HeldFlow> = {}) => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ truncated: { ledger: false, decisions: false, attempts: false, held: false, ...truncated }, ...over }) } });
  };

  it('a cut claim ledger or cut decisions: «الأرقام حد أدنى», and the speed is not drawn', async () => {
    cut({ ledger: true }, { speed: null });
    render(<HeldFlowPanel />);
    expect(await screen.findByText('قراءة السجل وصلت حدها — الأرقام حد أدنى. اختر مدة أقصر.')).toBeTruthy();
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('—')).toBeTruthy();
    expect(within(tile('وسيط الوقت لأول اتصال')).getByText('ما انحسب — القراءة وصلت حدها')).toBeTruthy();
    expect(within(tile('سحبات وصلها اتصال خلال 30 دقيقة')).getByText('—')).toBeTruthy();
    cleanup();
    cut({ decisions: true });
    render(<HeldFlowPanel />);
    expect(await screen.findByText('قراءة السجل وصلت حدها — الأرقام حد أدنى. اختر مدة أقصر.')).toBeTruthy();
  });

  it('a cut attempts list and a cut held list say theirs', async () => {
    cut({ attempts: true, held: true }, { speed: null });
    render(<HeldFlowPanel />);
    expect(await screen.findByText('قراءة محاولات الاتصال وصلت حدها — اختر مدة أقصر.')).toBeTruthy();
    expect(screen.getByText('قائمة المحجوز أطول من حد القراءة — الأرقام حد أدنى.')).toBeTruthy();
    // The flow itself was not cut: no «الأرقام حد أدنى» for the ledger.
    expect(screen.queryByText('قراءة السجل وصلت حدها — الأرقام حد أدنى. اختر مدة أقصر.')).toBeNull();
  });

  it('nothing cut says nothing', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(screen.queryByText(/وصلت حدها/)).toBeNull();
    expect(screen.queryByText(/أطول من حد القراءة/)).toBeNull();
  });
});

describe('the tone is on the card and in a word', () => {
  const surfaceOf = () => panel().className;

  it.each([
    ['CALM', 'ماشية', 'bg-[var(--sys-card)] border-[var(--sys-border)]', 'text-[var(--sys-success)]'],
    ['WATCH', 'انتباه', 'bg-[var(--sys-warning-soft)] border-[var(--sys-warning)]/40', 'text-[var(--sys-warning)]'],
    ['PROBLEM', 'مشكلة', 'bg-[var(--sys-destructive-soft)] border-[var(--sys-destructive-border)]', 'text-[var(--sys-destructive)]'],
  ] as const)('%s wears its own surface, and its chip says «%s» in the same tone', async (tone, word, classes, chip) => {
    serve.flow = () => ({ status: 200, body: { flow: flowOf({ reading: { tone, label: word, sentences: ['س'] } }) } });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    for (const c of classes.split(' ')) expect(surfaceOf(), c).toContain(c);
    expect(within(panel()).getByText(word)).toBeTruthy();
    // The chip is the board's own verdict chip: good · ok · bad for calm · watch · problem.
    expect(within(panel()).getByText(word).className).toContain(chip);
  });

  it('while it loads and when it failed, the card is the calm one', async () => {
    serve.flow = () => new Promise(() => undefined);
    render(<HeldFlowPanel />);
    expect(surfaceOf()).toContain('bg-[var(--sys-card)]');
    expect(panel().getAttribute('aria-busy')).toBe('true');
  });
});

describe('the window choice — three real buttons', () => {
  it('opens on a day, asks for the flow and only the flow, and the pressed one is the one on screen', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(flowCalls()).toEqual(['/api/orders/confirmation/no-answer?part=flow&window=24h']);
    expect(calls).toHaveLength(1);
    const pressed = (name: string) => (screen.getByRole('button', { name }) as HTMLButtonElement).getAttribute('aria-pressed');
    expect(pressed('آخر 24 ساعة')).toBe('true');
    expect(pressed('آخر 6 ساعات')).toBe('false');
    expect(pressed('آخر 7 أيام')).toBe('false');
    expect(screen.getAllByRole('button')).toHaveLength(3);
    for (const b of screen.getAllByRole('button')) expect(b.tagName).toBe('BUTTON');
    // The three are one choice, named, so a screen reader hears «مدة القراءة» and then which one is on.
    const group = screen.getByRole('group', { name: 'مدة القراءة' });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['آخر 6 ساعات', 'آخر 24 ساعة', 'آخر 7 أيام']);
  });

  it('is a phone-sized target: every button is 44 px tall on a phone and back to its size on a desk', async () => {
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toContain('min-h-11');
      expect(b.className).toContain('md:min-h-0');
      expect(b.getAttribute('type')).toBe('button');
    }
    // The tiles keep two columns on a phone.
    expect(panel().innerHTML).toContain('grid-cols-2');
  });

  it('pressing another window asks again with THAT window and nothing else; the figures change to the answer', async () => {
    serve.flow = (w) => ({
      status: 200,
      body: {
        flow: flowOf({
          window: { key: w as '6h', label: w, start: '', end: '' },
          entered: { pulled: w === '7d' ? 2000 : 312, typed: 0, onTheLine: 0, total: w === '7d' ? 2000 : 312 },
        }),
      },
    });
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    fireEvent.click(screen.getByRole('button', { name: 'آخر 7 أيام' }));
    await waitFor(() => expect(within(tile('انسحب')).getByText('2000')).toBeTruthy());
    expect(flowCalls()).toEqual([
      '/api/orders/confirmation/no-answer?part=flow&window=24h',
      '/api/orders/confirmation/no-answer?part=flow&window=7d',
    ]);
    expect(calls).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'آخر 7 أيام' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'آخر 24 ساعة' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'آخر 6 ساعات' }));
    await waitFor(() => expect(flowCalls()).toHaveLength(3));
    expect(flowCalls()[2]).toContain('window=6h');
  });

  it('while the new answer is on its way the old figures are not left standing under the new choice', async () => {
    let release: (v: { status: number; body: unknown }) => void = () => undefined;
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    serve.flow = () => new Promise((resolve) => (release = resolve));
    fireEvent.click(screen.getByRole('button', { name: 'آخر 6 ساعات' }));
    await waitFor(() => expect(panel().getAttribute('aria-busy')).toBe('true'));
    expect(screen.queryByText('سلاسة الشغل')).toBeNull();
    release({ status: 200, body: { flow: flowOf() } });
    await screen.findByText('سلاسة الشغل');
    expect(panel().getAttribute('aria-busy')).toBe('false');
  });

  it('an answer that arrives AFTER a newer choice never lands over it', async () => {
    const late: ((v: { status: number; body: unknown }) => void)[] = [];
    serve.flow = (w) =>
      w === '24h'
        ? { status: 200, body: { flow: flowOf() } }
        : new Promise((resolve) => late.push((v) => resolve({ status: v.status, body: { flow: flowOf({ created: w === '7d' ? 7777 : 6666 }) } })));
    render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    fireEvent.click(screen.getByRole('button', { name: 'آخر 7 أيام' }));
    fireEvent.click(screen.getByRole('button', { name: 'آخر 6 ساعات' }));
    await waitFor(() => expect(late).toHaveLength(2));
    // The 6-hour answer first, then the 7-day one limping in behind it.
    late[1]({ status: 200, body: {} });
    await screen.findByText('6666');
    late[0]({ status: 200, body: {} });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('7777')).toBeNull();
    expect(screen.getByText('6666')).toBeTruthy();
  });
});

describe('when the panel cannot be read', () => {
  it('a refusal is said in the server’s words, as its own small line — the choice stays, and nothing is drawn as zeros', async () => {
    serve.flow = () => ({ status: 403, body: { errorAr: 'أداء الفريق للمشرف وحده.' } });
    render(<HeldFlowPanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('أداء الفريق للمشرف وحده.');
    expect(screen.queryByText('سلاسة الشغل')).toBeNull();
    expect(screen.queryByText('دخل النظام')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(panel().getAttribute('aria-busy')).toBe('false');
  });

  it('a failure with no words of its own says the panel’s', async () => {
    serve.flow = () => ({ status: 500, body: {} });
    render(<HeldFlowPanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('تعذّر تحميل حركة الطلبات. غيّر المدة أو أعد المحاولة بعد قليل.');
  });

  it('no network says so', async () => {
    serve.flow = () => 'throw';
    render(<HeldFlowPanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('تعذّر الاتصال. تحقق من الشبكة وأعد المحاولة.');
  });

  it('an OLDER server answers the board and the report for `part=flow`: said, not drawn as zeros', async () => {
    serve.flow = () => ({ status: 200, body: { ...BOARD, ...REPORT } });
    render(<HeldFlowPanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('حركة الطلبات مش متوفرة بنسخة الخادم الحالية — حدّث الصفحة بعد التحديث.');
    expect(screen.queryByText('سلاسة الشغل')).toBeNull();
  });

  it('a failure clears when the next window answers', async () => {
    serve.flow = (w) => (w === '24h' ? { status: 500, body: {} } : { status: 200, body: { flow: flowOf() } });
    render(<HeldFlowPanel />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'آخر 6 ساعات' }));
    await screen.findByText('سلاسة الشغل');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('on the tab — the board never waits for it, never fails with it, and is not asked again', () => {
  it('the panel is the first thing on the tab, above the board’s four tiles', async () => {
    const { container } = render(<NoAnswerWatch />);
    await screen.findByText('سلاسة الشغل');
    await screen.findByText('بيد الموظفات الآن');
    const heading = screen.getByText('حركة الطلبات');
    const boardTile = screen.getByText('بيد الموظفات الآن');
    expect(container.contains(heading)).toBe(true);
    // Document order: the panel's heading comes before the board's first tile.
    expect(heading.compareDocumentPosition(boardTile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('asks three things, once each: the board, the report, the flow — and a new window asks for the flow alone', async () => {
    render(<NoAnswerWatch />);
    await screen.findByText('سلاسة الشغل');
    await screen.findAllByText('سارة');
    const kinds = (u: string) => (u.includes('part=flow') ? 'flow' : u.includes('part=board') ? 'board' : 'report');
    expect(calls.map(kinds).sort()).toEqual(['board', 'flow', 'report']);
    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'آخر 7 أيام' }));
    await waitFor(() => expect(flowCalls()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map(kinds)).toEqual(['flow']);
    expect(calls[0]).toContain('window=7d');
  });

  it('a panel that fails leaves the board and the report drawn', async () => {
    serve.flow = () => ({ status: 500, body: {} });
    render(<NoAnswerWatch />);
    expect((await screen.findAllByText('سارة')).length).toBeGreaterThan(0);
    expect(await screen.findByText('بيد الموظفات الآن')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('تعذّر تحميل حركة الطلبات');
    expect(screen.getByText('متى يرد الزبون')).toBeTruthy();
  });

  it('a panel that never answers does not hold the board back', async () => {
    serve.flow = () => new Promise(() => undefined);
    render(<NoAnswerWatch />);
    expect((await screen.findAllByText('سارة')).length).toBeGreaterThan(0);
    expect(screen.getByText('بيد الموظفات الآن')).toBeTruthy();
    expect(panel().getAttribute('aria-busy')).toBe('true');
  });

  it('an older server that does not know the part: the panel says so, the board still draws', async () => {
    serve.flow = () => ({ status: 200, body: { ...BOARD, ...REPORT } });
    render(<NoAnswerWatch />);
    expect(await screen.findByText('حركة الطلبات مش متوفرة بنسخة الخادم الحالية — حدّث الصفحة بعد التحديث.')).toBeTruthy();
    expect((await screen.findAllByText('سارة')).length).toBeGreaterThan(0);
    expect(screen.getByText('بيد الموظفات الآن')).toBeTruthy();
  });

  it('a person the team table refuses is refused once, as the tab said it before — the panel does not draw over the refusal', async () => {
    serve.board = { status: 403, body: { errorAr: 'أداء الفريق للمشرف وحده.' } };
    serve.report = { status: 403, body: { errorAr: 'أداء الفريق للمشرف وحده.' } };
    serve.flow = () => ({ status: 403, body: { errorAr: 'أداء الفريق للمشرف وحده.' } });
    render(<NoAnswerWatch />);
    expect(await screen.findByText('أداء الفريق للمشرف وحده.')).toBeTruthy();
    expect(screen.queryByText('حركة الطلبات')).toBeNull();
    expect(screen.queryByText('دخل النظام')).toBeNull();
  });
});

describe('no customer field, no order list, no navigation', () => {
  it('draws no link and no input — counts only', async () => {
    const { container } = render(<HeldFlowPanel />);
    await screen.findByText('سلاسة الشغل');
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('the component names no customer field in its source', () => {
    // Comments are prose, not fields: only what the component renders and reads counts.
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/performance/HeldFlowPanel.tsx'), 'utf8'));
    for (const field of ['phone', 'fullName', 'address', 'customer', 'orderNumber', 'href=']) expect(src, field).not.toContain(field);
  });
});

describe('NO NEW CSS — every class the panel uses is one the product already ships', () => {
  /*
   * The dashboard's first-load stylesheet is under a ratchet (`quality-gates.test.ts`, measured only on CI's build): a class nobody
   * else ships grows it. So the panel is written from the board's own tile, the delay dialog's own choice buttons and the other
   * cards' own tones, and this holds it to that. «Shipped» is read the way the style generator reads it: a token in another
   * product file (a test does not count — a class that only a test mentions would still grow the sheet, but is not a use).
   */
  const root = join(process.cwd(), 'src');
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(name) && !/\.test\./.test(name)) files.push(p);
    }
  })(root);

  const classesOf = (src: string) => {
    const found: string[] = [];
    const add = (s: string) => s.split(/\s+/).filter(Boolean).forEach((t) => found.push(t));
    for (const m of src.matchAll(/className="([^"]*)"/g)) add(m[1]);
    for (const m of src.matchAll(/className=\{`([\s\S]*?)`\}/g)) {
      for (const q of m[1].matchAll(/'([^']*)'/g)) add(q[1]);
      add(m[1].replace(/\$\{[\s\S]*?\}/g, ' '));
    }
    const tones = /const TONE_CLASS[^{]*\{([\s\S]*?)\};/.exec(src);
    if (tones) for (const q of tones[1].matchAll(/'([^']*)'/g)) add(q[1]);
    // `'CALM'` and the like are the indexes of a map, not classes.
    return found.filter((t) => !/^[A-Z_]+$/.test(t));
  };

  it('`HeldFlowPanel`’s classes all appear in another source file', () => {
    const own = join(root, 'components/performance/HeldFlowPanel.tsx');
    const used = new Set(classesOf(readFileSync(own, 'utf8')));
    expect(used.size, 'the panel has classes').toBeGreaterThan(30);
    const elsewhere = new Set(
      files
        .filter((f) => f !== own)
        .flatMap((f) => readFileSync(f, 'utf8').split(/[\s"'`{}]+/))
        .filter(Boolean)
    );
    const brandNew = [...used].filter((c) => !elsewhere.has(c));
    expect(brandNew, `classes nobody else ships: ${brandNew.join(' ')}`).toEqual([]);
  });

  it('the panel’s tiles wear the very classes of the board’s own four tiles beside them', () => {
    const board = readFileSync(join(root, 'components/performance/NoAnswerWatch.tsx'), 'utf8');
    const panelSrc = readFileSync(join(root, 'components/performance/HeldFlowPanel.tsx'), 'utf8');
    const tileClass = 'bg-[var(--sys-card)] border border-[var(--sys-border)] p-4 rounded-lg';
    const labelClass = 'text-xs font-bold text-[var(--sys-muted-foreground)]';
    const valueClass = 'text-lg font-black tabular-nums text-[var(--sys-heading)] mt-1.5';
    for (const c of [tileClass, labelClass, valueClass]) {
      expect(board, c).toContain(`className="${c}"`);
      expect(panelSrc, c).toContain(`className="${c}"`);
    }
  });

  it('the choice buttons wear the very classes of the delay dialog’s choices', () => {
    const dialog = readFileSync(join(root, 'components/ops/DelayShipmentDialog.tsx'), 'utf8');
    const panelSrc = readFileSync(join(root, 'components/performance/HeldFlowPanel.tsx'), 'utf8');
    for (const c of [
      'min-h-11 md:min-h-0 rounded-lg border px-3 py-1 text-xs font-semibold transition-colors',
      "'border-[var(--sys-primary)] bg-[var(--sys-primary-soft)] text-[var(--sys-primary)]'",
      "'border-[var(--sys-border)] text-[var(--sys-muted-foreground)] hover:border-[var(--sys-primary)] hover:text-[var(--sys-primary)]'",
    ]) {
      expect(dialog, c).toContain(c);
      expect(panelSrc, c).toContain(c);
    }
  });
});
