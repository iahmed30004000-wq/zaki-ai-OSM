// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the pull button knows she owes calls («الشغل أول», the owner, 8/11)
 *
 *  1. While she owes calls the button stays pressable (no dead buttons: the server is the enforcement) and says
 *     «اسحب طلب جديد — خلّصي اللي فوق أول»; a press OPENS the oldest owed order and asks the server for nothing.
 *  2. It does that even when the pool says she cannot pull or is empty: the press is a way to the work, not a pull.
 *  3. With nothing owed — or on a page that cannot take her to an order — it is the pull it always was.
 *  4. A pull the server refuses with WORK_FIRST anyway (a stale tab) hands the order it names to the screen, exactly as the
 *     untouched-order link does; any other refusal hands nothing.
 *
 * Blockers: no money, no permission, no order creation.
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

const POOL: QueueResponse = {
  waiting: 7,
  owned: { total: 3, withoutAttempt: 0 },
  caps: { withoutAttempt: 40, total: 500 },
  leadDays: 2,
  canPull: true,
  refusal: null,
  autoReleased: 0,
  orders: null,
};

let pool: QueueResponse;
let pullFails: Error | null;
const OWED = { count: 3, first: { id: 'o-1' }, button: 'اسحب طلب جديد — خلّصي اللي فوق أول' };

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

function Harness(props: {
  compact?: boolean;
  workFirst?: { count: number; first: { id: string } | null; button?: string | null } | null;
  onShowOrder?: (id: string) => void;
  onWorkFirst?: (id: string) => void;
  onPulled?: () => void;
  onQueue?: (q: ReturnType<typeof useQueue>) => void;
}) {
  const queue = useQueue(true);
  props.onQueue?.(queue);
  return (
    <PullPanel
      queue={queue}
      compact={props.compact}
      workFirst={props.workFirst}
      onShowOrder={props.onShowOrder}
      onWorkFirst={props.onWorkFirst}
      onPulled={props.onPulled ?? (() => {})}
    />
  );
}

const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
const OWED_BUTTON = 'اسحب طلب جديد — خلّصي اللي فوق أول';

describe.each([
  ['the full card', false],
  ['the slim bar on «طلباتي»', true],
])('%s', (_name, compact) => {
  it('while she owes calls: says so, stays pressable, and a press opens the oldest owed order — it asks the server for nothing', async () => {
    const onShowOrder = vi.fn();
    const onPulled = vi.fn();
    render(<Harness compact={compact} workFirst={OWED} onShowOrder={onShowOrder} onPulled={onPulled} />);
    const button = (await screen.findByRole('button', { name: OWED_BUTTON })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'اسحب الطلب التالي' })).toBeNull();

    fireEvent.click(button);
    expect(onShowOrder).toHaveBeenCalledWith('o-1');
    expect(posts()).toHaveLength(0);
    expect(onPulled).not.toHaveBeenCalled();
  });

  it('even when the pool says she cannot pull and is empty: it is a way to the work, not a pull', async () => {
    pool = { ...POOL, waiting: 0, canPull: false, refusal: { code: 'UNTOUCHED_ORDER', message: 'سجّل محاولة اتصال.', orderId: 'o-9', orderNumber: 'JO-9' } };
    const onShowOrder = vi.fn();
    render(<Harness compact={compact} workFirst={OWED} onShowOrder={onShowOrder} />);
    const button = (await screen.findByRole('button', { name: OWED_BUTTON })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(onShowOrder).toHaveBeenCalledWith('o-1');
  });

  it('with nothing owed it is the pull it was: the old label, the old greying, one POST', async () => {
    const onShowOrder = vi.fn();
    const onPulled = vi.fn();
    render(<Harness compact={compact} workFirst={{ count: 0, first: null, button: null }} onShowOrder={onShowOrder} onPulled={onPulled} />);
    const button = (await screen.findByRole('button', { name: 'اسحب الطلب التالي' })) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onPulled).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    expect(onShowOrder).not.toHaveBeenCalled();
  });

  it('and with nothing owed an empty pool still greys it', async () => {
    pool = { ...POOL, waiting: 0 };
    render(<Harness compact={compact} workFirst={null} onShowOrder={vi.fn()} />);
    expect(((await screen.findByRole('button', { name: 'اسحب الطلب التالي' })) as HTMLButtonElement).disabled).toBe(true);
  });

  it('NEGATIVE: an older server that sends no label for the button leaves the pull as it was — never an empty button', async () => {
    render(<Harness compact={compact} workFirst={{ count: 2, first: { id: 'o-1' } }} onShowOrder={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'اسحب الطلب التالي' })).toBeTruthy();
  });

  it('NEGATIVE: on a page that cannot take her to an order (no way to show one) the button is the pull, owed or not', async () => {
    render(<Harness compact={compact} workFirst={OWED} />);
    expect(await screen.findByRole('button', { name: 'اسحب الطلب التالي' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: OWED_BUTTON })).toBeNull();
  });
});

describe('a pull the server refuses «الشغل أول» (a stale tab)', () => {
  const refusal = () =>
    Object.assign(new Error('عندك 2 طلبين لازم ترني عليهم.'), {
      status: 409,
      data: { code: 'WORK_FIRST', error: 'x', orderId: 'o-9', orderNumber: 'JO-9', count: 2 },
    });

  it('says why, hands the order it names to the screen, and does NOT say it is done', async () => {
    pullFails = refusal();
    const onWorkFirst = vi.fn();
    const onPulled = vi.fn();
    render(<Harness onWorkFirst={onWorkFirst} onPulled={onPulled} />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(onWorkFirst).toHaveBeenCalledWith('o-9'));
    expect(toast.failed).toHaveBeenCalledWith('عندك 2 طلبين لازم ترني عليهم.');
    expect(onPulled).not.toHaveBeenCalled();
  });

  it('the hook keeps what the server said, for whoever pressed — its code and the order it names', async () => {
    pullFails = refusal();
    let queue: ReturnType<typeof useQueue> | null = null;
    render(<Harness onQueue={(q) => (queue = q)} />);
    await screen.findByRole('button', { name: 'اسحب الطلب التالي' });
    await expect(queue!.pull()).resolves.toBe(false);
    expect(queue!.lastRefusal.current).toEqual({ code: 'WORK_FIRST', orderId: 'o-9' });
    // The next pull that goes through forgets it.
    pullFails = null;
    await expect(queue!.pull()).resolves.toBe(true);
    expect(queue!.lastRefusal.current).toBeNull();
  });

  it('NEGATIVE: any other refusal hands the screen nothing to open', async () => {
    pullFails = Object.assign(new Error('بلغت الحد الأقصى (500 طلب لديك).'), { status: 409, data: { code: 'CAP_TOTAL' } });
    const onWorkFirst = vi.fn();
    render(<Harness onWorkFirst={onWorkFirst} />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('بلغت الحد الأقصى (500 طلب لديك).'));
    expect(onWorkFirst).not.toHaveBeenCalled();
  });

  it('NEGATIVE: an error that is not the server’s (no body at all) does not break the press', async () => {
    pullFails = new Error('انتهت مهلة الطلب.');
    const onWorkFirst = vi.fn();
    render(<Harness onWorkFirst={onWorkFirst} />);
    fireEvent.click(await screen.findByRole('button', { name: 'اسحب الطلب التالي' }));
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('انتهت مهلة الطلب.'));
    expect(onWorkFirst).not.toHaveBeenCalled();
  });
});
