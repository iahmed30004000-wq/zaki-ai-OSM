// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PULL PANEL'S SENTENCE UNDER «الطلب يرجع للطابور فوراً» (C1, 18/11 — finding #10 of the rules map)
 *
 *  1. With the legacy mode on and the plan off, the server sends `waitingRule` and the panel prints IT: a postponed order «وصل موعده» (it is pulled at its date) and the mode's own idle limit —
 *     never the old «المؤجّل اللي موعده خلال 2 يوم» and «بعد 90 دقيقة عمل», which are the mode-OFF rules.
 *  2. The plan's own sentence (`waitingPlan.rule`) still wins when the plan is on.
 *  3. THE OFF PIN: with neither, the old sentence is word for word what it was, with the lead days the server sent (a tab open over a deploy, or the mode off).
 * ═══════════════════════════════════════════════════════════════════════
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/hooks/useLiveRefresh', () => ({
  useLiveRefresh: (load: () => Promise<void>) => {
    React.useEffect(() => {
      void load();
    }, [load]);
  },
}));

import { PullPanel, useQueue, type QueueResponse } from './PullPanel';
import { planRule, returnsModeRule } from '@/lib/pull-plan-words';
import { QUEUE_PRIORITY_LIMITS, RETURNS_MODE } from '@/lib/queue-priority';

const BASE: QueueResponse = {
  waiting: 10,
  waitingNew: 4,
  waitingReturned: 5,
  waitingDue: 1,
  owned: { total: 0, withoutAttempt: 0 },
  caps: { withoutAttempt: 40, total: 5 },
  leadDays: 2,
  canPull: true,
  refusal: null,
  autoReleased: 0,
  orders: null,
};
let pool: QueueResponse;
const OLD_SENTENCE = 'طلب الزبون الراجع اللي تابع إلك بيجيك أول، وبعده الطلب الجديد اللي ما حدا اتصل فيه، وبعده المؤجّل اللي موعده خلال 2 يوم، وبعده الأقدم. أي طلب بلا محاولة اتصال بيرجع للطابور بعد 90 دقيقة عمل.';

beforeEach(() => {
  vi.clearAllMocks();
  pool = structuredClone(BASE);
  api.mockImplementation(async (url: string) => {
    if (url === '/api/confirmation/queue') return pool;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

function Harness() {
  const queue = useQueue(true);
  return <PullPanel queue={queue} onPulled={() => {}} />;
}

describe('the sentence under the card', () => {
  it('the legacy mode on: the server\'s sentence — the date, and the mode\'s own idle limit', async () => {
    pool.waitingRule = returnsModeRule(RETURNS_MODE.idleBusinessMinutes);
    render(<Harness />);
    expect(await screen.findByText(returnsModeRule(30))).toBeTruthy();
    expect(screen.queryByText(OLD_SENTENCE)).toBeNull();
    expect(document.body.textContent).not.toContain('90 دقيقة');
    expect(document.body.textContent).not.toContain('خلال 2 يوم');
  });

  it('with the queue-priority key on the mode\'s limit is 20, and the sentence says 20 (never a typed 30)', async () => {
    pool.waitingRule = returnsModeRule(QUEUE_PRIORITY_LIMITS.idleBusinessMinutes);
    render(<Harness />);
    const node = await screen.findByText(/بعد 20 دقيقة دوام/);
    expect(node.textContent).not.toContain('30');
  });

  it('the plan\'s sentence wins over the legacy one when both arrive (the plan is on)', async () => {
    pool.waitingRule = returnsModeRule(30);
    pool.waitingPlan = { parts: [{ label: 'جديد', hint: 'ما حدا اتصل فيه', value: 4 }], rule: planRule(30) };
    render(<Harness />);
    expect(await screen.findByText(planRule(30))).toBeTruthy();
    expect(screen.queryByText(returnsModeRule(30))).toBeNull();
  });

  it('THE OFF PIN: no `waitingRule` — the old sentence, word for word, with the lead days the server sent', async () => {
    render(<Harness />);
    expect(await screen.findByText(OLD_SENTENCE)).toBeTruthy();
  });
});

describe('the words themselves', () => {
  it('say «وصل موعده» and the figure handed in — and nothing typed', () => {
    for (const n of [20, 30, 45]) {
      const text = returnsModeRule(n);
      expect(text).toContain(`${n} دقيقة دوام`);
      expect(text).toContain('المؤجّل اللي وصل موعده');
      expect(text).not.toContain('90');
      expect(text).not.toMatch(/خلال \d+ يوم/);
    }
  });
});
