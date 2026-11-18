// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «زر إلغاء الاستيراد لغاية قبل ما أعمل اعتماد أفضل».
 * The row offers «إلغاء الاستيراد» at every step until approval — imported, receipted, matched — asks before
 * it deletes (and says what goes with it), and the button is gone the moment the statement is approved.
 */
const { api, confirm } = vi.hoisted(() => ({ api: vi.fn(), confirm: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/finance/collection',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u1', status: 'ACTIVE', role: 'COMPANY_ADMIN', permissions: ['settlement.upload'] } }),
}));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirm, useAsk: () => async () => null }));

import { CollectionScreen } from './CollectionScreen';

const gap = { claimed: 100, received: 0, gap: 100, needsExplanation: false, explained: false, unconvertible: 0 };
const statement = (over: Record<string, unknown> = {}) => ({
  id: 's1', reference: 'ST-2026-09', fileName: 'x.xlsx', status: 'IMPORTED', approvedAt: null,
  currencyCode: 'USD', totalAmount: 100, createdAt: '2026-10-24T00:00:00Z', periodFrom: null, periodTo: null,
  counts: { lines: 3, receipts: 0, matches: 0 }, receipts: [], gap, ...over,
});

let statements: ReturnType<typeof statement>[];
beforeEach(() => {
  vi.clearAllMocks();
  statements = [statement()];
  confirm.mockResolvedValue(true);
  api.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      statements = [];
      return { ok: true };
    }
    if (url.startsWith('/api/finance/statements')) return { statements };
    if (url.startsWith('/api/ops/references')) return { providers: [] };
    if (url.startsWith('/api/finance/wallets')) return { wallets: [] };
    return {};
  });
});
afterEach(cleanup);

const deletes = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE');
const undoButtons = () => screen.findAllByRole('button', { name: 'إلغاء الاستيراد' });

describe('«إلغاء الاستيراد»', () => {
  it('is on an imported statement, beside the buttons of the next steps', async () => {
    render(<CollectionScreen />);
    expect((await undoButtons()).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'إيصال استلام' }).length).toBeGreaterThan(0);
  });

  it('asks first, and a refusal deletes nothing', async () => {
    confirm.mockResolvedValue(false);
    render(<CollectionScreen />);
    fireEvent.click((await undoButtons())[0]);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].tone).toBe('danger');
    expect(deletes()).toHaveLength(0);
  });

  it('on yes it calls the delete door for THIS statement and says what was undone', async () => {
    render(<CollectionScreen />);
    fireEvent.click((await undoButtons())[0]);
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0][0]).toBe('/api/finance/statements/s1');
    expect((await screen.findAllByText(/أُلغي استيراد الكشف «ST-2026-09»/)).length).toBeGreaterThan(0);
  });

  it('is still there after a receipt and after matching — and the question says what goes with it', async () => {
    const steps = [
      statement({ status: 'RECEIPTED', counts: { lines: 3, receipts: 2, matches: 0 } }),
      statement({ status: 'MATCHED', counts: { lines: 3, receipts: 2, matches: 3 } }),
    ];
    for (const step of steps) {
      statements = [step];
      const { unmount } = render(<CollectionScreen />);
      fireEvent.click((await undoButtons())[0]);
      await waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(confirm.mock.calls.at(-1)?.[0].body).toContain('2 إيصال');
      unmount();
    }
  });

  it('NEGATIVE: gone once approved — by stamp or by status', async () => {
    const approved = [
      statement({ status: 'APPROVED', approvedAt: '2026-10-24T01:00:00Z', counts: { lines: 3, receipts: 1, matches: 3 } }),
      statement({ status: 'APPROVED', counts: { lines: 3, receipts: 1, matches: 3 } }),
    ];
    for (const a of approved) {
      statements = [a];
      const { unmount } = render(<CollectionScreen />);
      await screen.findAllByText('ST-2026-09');
      expect(screen.queryAllByRole('button', { name: 'إلغاء الاستيراد' })).toHaveLength(0);
      unmount();
    }
  });
});
