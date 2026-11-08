// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — the pace refusal reaches the agent the way the caps do (the owner, 8/11)
 *
 * The server refuses a pull that is too fast with a 409, `{ error, code: 'PULL_TOO_FAST' }`. Every screen that pulls (the panel on
 * «طلباتي», the call sheet's «التالي», the palette) goes through `useQueue.pull` or the same door, and says what the server said. So:
 *
 *  1. Pressing «اسحب الطلب التالي» when the server answers `PULL_TOO_FAST` shows the server's sentence, whole, as a refusal (a toast
 *     that waits to be closed), and does NOT say the pull is done.
 *  2. The pool is read again afterwards and the button is usable again (the agent is not left with «جارٍ السحب…»).
 *  3. No code-specific branch is needed — the message is carried by the error, exactly as `CAP_TOTAL`'s is.
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

const SENTENCE = 'سحبت 40 طلباً خلال آخر 60 دقيقة — الحد 40. اشتغل على اللي بإيدك، والسحب بيفتح بعد 7 دقائق.';

/** What `apiJson` throws for the server's 409: the sentence as the message, the whole body beside it. */
const tooFast = () =>
  Object.assign(new Error(SENTENCE), { status: 409, data: { error: SENTENCE, code: 'PULL_TOO_FAST', autoReleased: 0 } });

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw tooFast();
    if (url === '/api/confirmation/queue') return structuredClone(POOL);
    throw new Error(`unexpected ${url}`);
  });
});
afterEach(cleanup);

function Harness({ onPulled = () => {}, compact = false }: { onPulled?: () => void; compact?: boolean }) {
  const queue = useQueue(true);
  return <PullPanel queue={queue} onPulled={onPulled} compact={compact} />;
}

const pullButton = () => screen.getByRole('button', { name: /اسحب الطلب التالي|جارٍ السحب/ });
const reads = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method !== 'POST').length;

describe.each([
  ['the full card', false],
  ['the slim bar on «طلباتي»', true],
])('%s', (_name, compact) => {
  it('shows the server\'s sentence whole, as a refusal, and does not say the pull is done', async () => {
    const onPulled = vi.fn();
    render(<Harness compact={compact} onPulled={onPulled} />);
    await screen.findByText('7');
    fireEvent.click(pullButton());
    await waitFor(() => expect(toast.failed).toHaveBeenCalledTimes(1));
    expect(toast.failed).toHaveBeenCalledWith(SENTENCE);
    expect(toast.done).not.toHaveBeenCalled();
    expect(onPulled).not.toHaveBeenCalled();
  });

  it('reads the pool again, and the button is usable again', async () => {
    render(<Harness compact={compact} />);
    await screen.findByText('7');
    const before = reads();
    fireEvent.click(pullButton());
    await waitFor(() => expect(toast.failed).toHaveBeenCalled());
    await waitFor(() => expect(reads()).toBe(before + 1));
    await waitFor(() => expect((pullButton() as HTMLButtonElement).disabled).toBe(false));
    expect(pullButton().textContent).toContain('اسحب الطلب التالي');
  });
});
