// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PULL PANEL SAYS THE PLAN'S FOUR (the planner 15/11 22:30, ruling 24)
 *
 *  1. When the server sends `waitingPlan` (the plan is on), the full card draws its parts as they come — جديد / وعد وصل / إعادة حان موعدها / الباقي — the slim bar says them as ONE line,
 *     and the sentence under the card is the server's own (the order of the plan), not the static one that names the two-day lead.
 *  2. The screen adds no logic: it prints the server's words and numbers (they add up to the figure above, as the server sends them).
 *  3. A part with nothing in it is not drawn — except the first (the urgent one), as «جديد» always was.
 *  4. THE OFF PIN: without `waitingPlan` the three old parts, the old line and the old sentence are exactly what they were (also pinned by
 *     `the-pull-panel-says-new-and-returned-apart.test.tsx`, which this change leaves untouched and green).
 *
 * Blockers: no money, no order creation, no migration; the bundle ceiling is `staff-confirmation-first-load.test.ts`.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, toast } = vi.hoisted(() => ({ api: vi.fn(), toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));

import { PullPanel, useQueue, type QueueResponse } from './PullPanel';
import { planWords } from '@/lib/pull-plan-words';

const FOUR = { fresh: 5, promise: 4, retry: 100, rest: 313 };
const BASE: QueueResponse = {
  waiting: 422,
  waitingNew: 5,
  waitingReturned: 417,
  waitingPlan: planWords(FOUR, 30),
  waitingOnADate: 67,
  owned: { total: 0, withoutAttempt: 0 },
  caps: { withoutAttempt: 40, total: 5 },
  leadDays: 2,
  canPull: true,
  refusal: null,
  autoReleased: 0,
  orders: null,
};
let pool: QueueResponse;

beforeEach(() => {
  vi.clearAllMocks();
  pool = structuredClone(BASE);
  api.mockImplementation(async (url: string) => {
    if (url === '/api/confirmation/queue') return pool;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

function Harness({ compact = false }: { compact?: boolean }) {
  const queue = useQueue(true);
  return <PullPanel queue={queue} onPulled={() => {}} compact={compact} />;
}
const GROUP = 'تفصيل الطلبات الجاهزة للسحب';
const group = () => screen.queryByRole('group', { name: GROUP });
const normalised = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the plan is on: the server’s four, in the pull’s order', () => {
  it('the full card draws four boxes with the server’s labels, hints and numbers — and they add up to the figure above', async () => {
    render(<Harness />);
    await screen.findByText('422');
    const parts = group()!;
    for (const label of ['جديد', 'وعد وصل', 'إعادة حان موعدها', 'الباقي']) expect(within(parts).getByText(label)).toBeTruthy();
    const text = normalised(parts);
    const at = ['جديد', 'وعد وصل', 'إعادة حان موعدها', 'الباقي'].map((l) => text.indexOf(l));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(within(parts).getByText('الزبون طلب نكلمو وحان موعده')).toBeTruthy();
    const sum = within(parts).getAllByText(/^\d+$/).reduce((n, node) => n + Number(node.textContent), 0);
    expect(sum).toBe(422);
    // None of the old three words is said.
    expect(within(parts).queryByText('راجع')).toBeNull();
    expect(within(parts).queryByText('مؤجَّل حان موعده')).toBeNull();
    expect(parts.className).toContain('grid-cols-4');
  });

  it('the slim bar says them as ONE line', async () => {
    render(<Harness compact />);
    await screen.findByText('422');
    expect(normalised(group()!)).toBe('منها 5 جديد · 4 وعد وصل · 100 إعادة حان موعدها · 313 الباقي');
  });

  it('the sentence under the card is the server’s: the plan’s order, and not the old two-day lead', async () => {
    render(<Harness />);
    await screen.findByText('422');
    const rule = screen.getByText(/وبعده الوعد اللي وصل موعده/);
    expect(rule.textContent).toBe(pool.waitingPlan!.rule);
    expect(screen.queryByText(/المؤجّل اللي موعده خلال/)).toBeNull();
    expect(screen.queryByText(/وبعده الأقدم\./)).toBeNull();
  });

  it('a part with nothing in it is not drawn — but the first is, as «جديد» always was', async () => {
    pool.waitingPlan = planWords({ fresh: 0, promise: 0, retry: 3, rest: 0 }, 30);
    pool.waiting = 3;
    render(<Harness />);
    await screen.findByText('3', { selector: 'p.text-4xl' });
    const parts = group()!;
    expect(within(parts).getByText('جديد')).toBeTruthy();
    expect(within(parts).getByText('إعادة حان موعدها')).toBeTruthy();
    expect(within(parts).queryByText('وعد وصل')).toBeNull();
    expect(within(parts).queryByText('الباقي')).toBeNull();
    expect(parts.className).toContain('grid-cols-2');
  });

  it('NEGATIVE: an empty pool draws no boxes, plan or not', async () => {
    pool.waiting = 0;
    pool.waitingPlan = planWords({ fresh: 0, promise: 0, retry: 0, rest: 0 }, 30);
    render(<Harness />);
    await screen.findByText('0', { selector: 'p.text-4xl' });
    expect(group()).toBeNull();
  });
});

describe('the plan is off (no `waitingPlan`): exactly the old words — the pin', () => {
  beforeEach(() => {
    delete pool.waitingPlan;
    pool.waitingDue = 3;
    pool.waiting = 425;
  });

  it('the three parts, the old line and the old sentence with the lead days', async () => {
    render(<Harness />);
    await screen.findByText('425');
    const parts = group()!;
    expect(within(parts).getByText('جديد')).toBeTruthy();
    expect(within(parts).getByText('راجع')).toBeTruthy();
    expect(within(parts).getByText('مؤجَّل حان موعده')).toBeTruthy();
    expect(parts.className).toContain('grid-cols-3');
    expect(within(parts).queryByText('وعد وصل')).toBeNull();
    expect(
      screen.getByText(
        'طلب الزبون الراجع اللي تابع إلك بيجيك أول، وبعده الطلب الجديد اللي ما حدا اتصل فيه، وبعده المؤجّل اللي موعده خلال 2 يوم، وبعده الأقدم. أي طلب بلا محاولة اتصال بيرجع للطابور بعد 90 دقيقة عمل.'
      )
    ).toBeTruthy();
  });

  it('the slim bar keeps its old line', async () => {
    render(<Harness compact />);
    await screen.findByText('425');
    expect(normalised(group()!)).toBe('منها 5 جديد · 417 راجع · 3 مؤجَّل حان موعده');
  });
});
