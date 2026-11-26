// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «قايمة الاسترجاع» (F12): her private list — the server's rows, the 1 ↔ 3 switch as one request carrying ONLY the pieces, the old
 * quantity as information, Arabic words and Western digits.
 */
const { api, failed } = vi.hoisted(() => ({ api: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, done: vi.fn(), warn: vi.fn() }) }));
vi.mock('@/components/orders/OrderRef', () => ({ OrderRef: ({ id, number }: { id: string; number: string }) => <a href={`/orders/${id}`}>{number}</a> }));
vi.mock('@/hooks/useLiveRefresh', () => ({ useLiveRefresh: (fn: () => void) => React.useEffect(() => void fn(), [fn]) }));

import { WinbackListScreen } from './WinbackListScreen';

const ROWS = {
  rows: [
    { id: 'w1', orderNumber: 'WB-1', product: 'كريم', pieces: 3, total: 20, currency: 'USD', touched: false, oldOrderNumber: 'ORD-9', oldPieces: 6, options: { one: 12, three: 20 }, leavesAt: '2026-11-28T10:00:00.000Z' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  api.mockImplementation(async (url: string) => (url === '/api/confirmation/winback/list' ? ROWS : { ok: true }));
});
afterEach(cleanup);

describe('her list', () => {
  it('shows the order, the option, the old quantity and the day it leaves — Arabic, Western digits', async () => {
    const { container } = render(<WinbackListScreen />);
    await screen.findAllByText('WB-1');
    const text = container.textContent ?? '';
    expect(text).toContain('قايمة الاسترجاع');
    expect(text).toContain('ORD-9 — كان 6 قطع');
    expect(text).toContain('2026-11-28');
    expect(text).toContain('3 قطع — 20');
    expect(text).not.toMatch(/[٠-٩]/);
    expect(container.querySelector('a[href="/orders/w1"]')).not.toBeNull();
  });

  it('switching to one piece is ONE request with the pieces and nothing else — never a price', async () => {
    render(<WinbackListScreen />);
    await screen.findAllByText('WB-1');
    fireEvent.click(screen.getAllByRole('radio', { name: /قطعة — 12/ })[0]);
    await waitFor(() => expect(api.mock.calls.some((c) => c[1]?.method === 'PATCH')).toBe(true));
    const call = api.mock.calls.find((c) => c[1]?.method === 'PATCH')!;
    expect(call[0]).toBe('/api/confirmation/winback/list/w1');
    expect(JSON.parse(call[1].body)).toEqual({ pieces: 1 });
  });
});
