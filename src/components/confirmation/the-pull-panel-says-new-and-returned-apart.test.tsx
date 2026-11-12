// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — THE PULL PANEL SAYS «جديد» AND «راجع» APART (the owner, 12/11: «لسا مش مفصولة», over a screenshot of «422 طلب
 * جاهز للسحب الآن»; the day before: «طلب جديد وخانة تانية طلب الراجع … زر اسحب واحد»)
 *
 *  1. Under the one figure, the full card draws two boxes — new (nobody has rung it) and returned (rung before, back in the pool) —
 *     and a third only when a postponed order’s date has come. The slim bar of «طلباتي» says the same as ONE line.
 *  2. The parts on the screen ADD UP to the figure above them (the server sends them so; the screen shows what it was told).
 *  3. There is still ONE pull button: a second one would let somebody take a returned order before a new one, against the owner’s
 *     ruling of 7/11 («الأولوية دائما للطلبات الجديدة»).
 *  4. Nothing is drawn when there is nothing to pull (three zeroes over a greyed button say nothing), and an answer from a server that
 *     does not send the parts yet (a tab left open over a deploy) draws the figure alone, as before.
 *
 * Blockers: no money, no order creation, no migration.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { api, toast } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: { failed: vi.fn(), done: vi.fn(), warn: vi.fn() },
}));
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

/** The owner’s screenshot, in parts: 5 new + 417 returned = 422, with 67 more waiting on a date. */
const POOL: QueueResponse = {
  waiting: 422,
  waitingNew: 5,
  waitingReturned: 417,
  waitingDue: 0,
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
  pool = structuredClone(POOL);
  api.mockImplementation(async (url: string) => {
    if (url === '/api/confirmation/queue') return pool;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

/** The answer of a server that does not send the parts yet — the owner’s pool as it was before them. */
function withoutParts(): QueueResponse {
  const old: Partial<QueueResponse> = structuredClone(POOL);
  delete old.waitingNew;
  delete old.waitingReturned;
  delete old.waitingDue;
  return old as QueueResponse;
}

function Harness({ compact = false }: { compact?: boolean }) {
  const queue = useQueue(true);
  return <PullPanel queue={queue} onPulled={() => {}} compact={compact} />;
}

const GROUP = 'تفصيل الطلبات الجاهزة للسحب';
const group = () => screen.queryByRole('group', { name: GROUP });
const normalised = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('the full card', () => {
  it('draws the figure and, under it, two boxes: «جديد» 5 and «راجع» 417 — and no third while no promise is due', async () => {
    render(<Harness />);
    await screen.findByText('422');
    const parts = group()!;
    expect(parts).toBeTruthy();
    expect(within(parts).getByText('جديد')).toBeTruthy();
    expect(within(parts).getByText('5')).toBeTruthy();
    expect(within(parts).getByText('راجع')).toBeTruthy();
    expect(within(parts).getByText('417')).toBeTruthy();
    expect(within(parts).queryByText('مؤجَّل حان موعده')).toBeNull();
    // The line that says what the boxes mean sits in each of them.
    expect(within(parts).getByText('ما حدا اتصل فيه')).toBeTruthy();
    expect(within(parts).getByText('اتّصلوا فيه ورجع للطابور')).toBeTruthy();
  });

  it('the parts on the screen add up to the figure above them — with and without a due promise', async () => {
    render(<Harness />);
    await screen.findByText('422');
    const sum = (el: HTMLElement) => within(el).getAllByText(/^\d+$/).reduce((n, node) => n + Number(node.textContent), 0);
    expect(sum(group()!)).toBe(422);
    cleanup();

    pool = { ...structuredClone(POOL), waiting: 425, waitingDue: 3 };
    render(<Harness />);
    await screen.findByText('425');
    expect(within(group()!).getByText('مؤجَّل حان موعده')).toBeTruthy();
    expect(sum(group()!)).toBe(425);
  });

  it('the new orders are drawn first (the urgent part), the returned after them', async () => {
    render(<Harness />);
    await screen.findByText('422');
    const text = normalised(group()!);
    expect(text.indexOf('جديد')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('جديد')).toBeLessThan(text.indexOf('راجع'));
  });

  it('there is still ONE pull button, and the rule that says the order it gives is still said', async () => {
    render(<Harness />);
    await screen.findByText('422');
    expect(screen.getAllByRole('button', { name: /اسحب/ })).toHaveLength(1);
    expect(screen.getByText(/الطلب الجديد اللي ما حدا اتصل فيه/)).toBeTruthy();
    // What was already under the figure stays: the promises waiting on their day.
    expect(screen.getByText(/و67 مؤجَّلة حتى موعدها/)).toBeTruthy();
  });

  it('NEGATIVE: an empty pool draws no boxes (three zeroes say nothing), and the button is greyed as ever', async () => {
    pool = { ...structuredClone(POOL), waiting: 0, waitingNew: 0, waitingReturned: 0, waitingDue: 0 };
    render(<Harness />);
    await screen.findByText('0', { selector: 'p.text-4xl' });
    expect(group()).toBeNull();
    expect((screen.getByRole('button', { name: /اسحب/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('NEGATIVE: an answer without the parts (a server older than this) draws the figure alone, as it always did', async () => {
    pool = withoutParts();
    render(<Harness />);
    await screen.findByText('422');
    expect(group()).toBeNull();
    expect(screen.getByText('طلب جاهز للسحب الآن')).toBeTruthy();
  });
});

describe('the slim bar on «طلباتي»', () => {
  it('says it as ONE line: «منها 5 جديد · 417 راجع» — the figure and the button stay where they were', async () => {
    render(<Harness compact />);
    await screen.findByText('422');
    expect(normalised(group()!)).toBe('منها 5 جديد · 417 راجع');
    expect(screen.getAllByRole('button', { name: /اسحب/ })).toHaveLength(1);
  });

  it('a due promise is a third item of the same line', async () => {
    pool = { ...structuredClone(POOL), waiting: 425, waitingDue: 3 };
    render(<Harness compact />);
    await screen.findByText('425');
    expect(normalised(group()!)).toBe('منها 5 جديد · 417 راجع · 3 مؤجَّل حان موعده');
  });

  it('NEGATIVE: an empty pool, or an older server, draws no line', async () => {
    pool = { ...structuredClone(POOL), waiting: 0, waitingNew: 0, waitingReturned: 0, waitingDue: 0 };
    render(<Harness compact />);
    await screen.findByText('0');
    expect(group()).toBeNull();
    cleanup();

    pool = withoutParts();
    render(<Harness compact />);
    await screen.findByText('422');
    expect(group()).toBeNull();
  });
});
