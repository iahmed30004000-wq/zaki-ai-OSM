// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE PULL PANEL — «اسحب الطلب التالي», AT THE TOP OF THE AGENT'S DESK.
 *
 * It was a whole screen (`/confirmation/queue`) whose only act sent the agent
 * to «طلباتي» and whose twin, the empty desk, sent her back. These render the
 * panel through the hook the two screens share and press it:
 *
 *   · a desk that pulls draws the counter, the button and the caps; pressing
 *     it pulls ONCE, reloads the pool, and only then tells the caller (so the
 *     desk under it can reload and she stays where she is);
 *   · a desk that does NOT pull (`NOT_YOUR_DESK` — a supervisor) draws no
 *     button and no caps: a button whose every press is refused is a broken
 *     button, and two zeroes over two ceilings read as a failed quota;
 *   · a temporary refusal keeps the button, greyed, with the server's sentence;
 *   · the untouched-order refusal carries a way to the order it means;
 *   · `enabled: false` — somebody who may not pull — asks nothing and draws
 *     nothing (the queue door answers them 403).
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

const POOL: QueueResponse = {
  waiting: 7,
  owned: { total: 3, withoutAttempt: 1 },
  caps: { withoutAttempt: 3, total: 10 },
  leadDays: 2,
  canPull: true,
  refusal: null,
  autoReleased: 0,
  orders: null,
};

let pool: QueueResponse;
let pullFails: Error | null;

beforeEach(() => {
  vi.clearAllMocks();
  pool = structuredClone(POOL);
  pullFails = null;
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (pullFails) throw pullFails;
      return { ok: true };
    }
    if (url === '/api/confirmation/queue') return pool;
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

function Harness({
  enabled = true,
  compact = false,
  onPulled = () => {},
}: {
  enabled?: boolean;
  compact?: boolean;
  onPulled?: () => void;
}) {
  const queue = useQueue(enabled);
  return <PullPanel queue={queue} onPulled={onPulled} compact={compact} />;
}

const pullButton = () => screen.getByRole('button', { name: /اسحب الطلب التالي|جارٍ السحب/ });
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');

describe.each([
  ['the full card', false],
  ['the slim bar on «طلباتي»', true],
])('%s', (_name, compact) => {
  it('shows the pool, the button and both caps for somebody who pulls', async () => {
    render(<Harness compact={compact} />);
    await screen.findByText('7');
    expect(screen.getByText('طلب جاهز للسحب الآن')).toBeTruthy();
    expect((pullButton() as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('لديك بلا محاولة اتصال')).toBeTruthy();
    expect(screen.getByText('1 / 3')).toBeTruthy();
    expect(screen.getByText('3 / 10')).toBeTruthy();
  });

  it('pulls once, reloads the pool, and only then says it is done', async () => {
    const order: string[] = [];
    api.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        order.push('pull');
        return { ok: true };
      }
      order.push('load');
      return pool;
    });
    const onPulled = vi.fn(() => void order.push('done'));
    render(<Harness compact={compact} onPulled={onPulled} />);
    await screen.findByText('7');
    order.length = 0;
    fireEvent.click(pullButton());
    await waitFor(() => expect(onPulled).toHaveBeenCalledTimes(1));
    expect(order).toEqual(['pull', 'load', 'done']);
  });

  it('a refused pull says why and does NOT say it is done', async () => {
    pullFails = new Error('وصلت للحد الأقصى');
    const onPulled = vi.fn();
    render(<Harness compact={compact} onPulled={onPulled} />);
    await screen.findByText('7');
    fireEvent.click(pullButton());
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('وصلت للحد الأقصى'));
    expect(onPulled).not.toHaveBeenCalled();
  });

  it('NEGATIVE: NOT_YOUR_DESK draws no button and no caps — only the plain sentence', async () => {
    pool = {
      ...POOL,
      canPull: false,
      refusal: { code: 'NOT_YOUR_DESK', message: 'السحب من عمل موظّف التأكيد — هذه الشاشة للإشراف على الطابور لا للعمل عليه.' },
    };
    render(<Harness compact={compact} />);
    await screen.findByText(/للإشراف على الطابور/);
    expect(screen.queryByRole('button', { name: /اسحب الطلب التالي/ })).toBeNull();
    expect(screen.queryByText('لديك بلا محاولة اتصال')).toBeNull();
    expect(screen.queryByText('إجمالي ما بيدك')).toBeNull();
  });

  it('a temporary refusal keeps the button, greyed, with the server’s sentence and the caps', async () => {
    pool = { ...POOL, canPull: false, refusal: { code: 'TOTAL_CAP', message: 'بيدك 10 طلبات — اعمل عليها أولاً.' } };
    render(<Harness compact={compact} />);
    await screen.findByText('بيدك 10 طلبات — اعمل عليها أولاً.');
    expect((pullButton() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('لديك بلا محاولة اتصال')).toBeTruthy();
  });

  it('an empty pool greys the button', async () => {
    pool = { ...POOL, waiting: 0 };
    render(<Harness compact={compact} />);
    await screen.findByText('طلب جاهز للسحب الآن');
    expect((pullButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('the untouched-order refusal carries a link to the order it means — on her own desk', async () => {
    pool = {
      ...POOL,
      canPull: false,
      refusal: { code: 'UNTOUCHED_ORDER', message: 'عندك طلب بلا محاولة اتصال.', orderId: 'o-77', orderNumber: 'ORD-77' },
    };
    render(<Harness compact={compact} />);
    const link = await screen.findByRole('link', { name: /افتح الطلب ORD-77/ });
    /*
     * «طلباتي», with the order in its window — not `/orders/o-77`, which is
     * the «الطلبات» screen and asks «عرض الطلبات»: an agent working without
     * that key was sent to a page that refused her, about an order she holds.
     */
    expect(link.getAttribute('href')).toBe('/confirmation/mine?open=o-77');
    expect(link.getAttribute('href'), 'رجع الرابط لشاشة الطلبات').not.toMatch(/^\/orders\//);
  });

  it('and says, separately, how many wait on a date — they are not «for you»', async () => {
    pool = { ...POOL, waitingOnADate: 4 };
    render(<Harness compact={compact} />);
    await screen.findByText(/و4 مؤجَّلة حتى موعدها/);
  });
});

describe('somebody who may not pull', () => {
  it('asks nothing and draws nothing (the queue door answers them 403)', async () => {
    const { container } = render(<Harness enabled={false} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(api).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });
});

describe('a pull is one POST, to the one door', () => {
  it('goes to /api/confirmation/pull and nowhere else', async () => {
    render(<Harness />);
    await screen.findByText('7');
    fireEvent.click(pullButton());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe('/api/confirmation/pull');
  });
});
