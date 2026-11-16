// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE DAILY WINBACK LIST IS DRAWN ONLY WHEN IT IS ON (step F1): off, on a failure or on an odd answer it draws NOTHING (the winback list below is untouched); on, it lists the orders with their
 * kind and reason, lets the holder of the reassign key name who calls and the holder of the winback key record what a call came to — each press one request — and carries no customer field.
 */
const { api, failed } = vi.hoisted(() => ({ api: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed }) }));
vi.mock('@/components/orders/OrderRef', () => ({ OrderRef: ({ id, number }: { id: string; number: string }) => <a href={`/orders/${id}`}>{number}</a> }));

import { WinbackDaily } from './WinbackDaily';

const item = (over: Record<string, unknown> = {}) => ({ orderId: 'o1', orderNumber: 'ORD-1', kind: 'LOST', reason: 'PRICE_TOO_HIGH', reasonAr: 'السعر مرتفع', happenedAt: '2026-11-18T00:00:00Z', assignee: null, lastCall: null, ...over });
const answer = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  window: { fromHours: 24, toHours: 72 },
  canAssign: true,
  canCall: true,
  assignees: [{ id: 'u1', name: 'سارة' }, { id: 'u2', name: 'هدى' }],
  items: [item(), item({ orderId: 'o2', orderNumber: 'ORD-2', kind: 'MISSED_POSTPONED', reason: 'MISSED_DATE', reasonAr: 'فات موعد الاتصال المتفق عليه', assignee: { id: 'u2', name: 'هدى' }, lastCall: { result: 'NO_ANSWER', note: null, by: 'هدى', at: '2026-11-19T00:00:00Z' } })],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue(answer());
});
afterEach(cleanup);

describe('when it is off, or cannot be read', () => {
  it('draws nothing — not even the title — when the switch is off, the door fails or the answer is odd', async () => {
    api.mockResolvedValue({ enabled: false });
    const off = render(<WinbackDaily />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(off.container.textContent).toBe('');
    off.unmount();
    api.mockRejectedValue(new Error('403'));
    const failedRender = render(<WinbackDaily />);
    await new Promise((r) => setTimeout(r, 10));
    expect(failedRender.container.textContent).toBe('');
    failedRender.unmount();
    api.mockResolvedValue({ rows: [] });
    const odd = render(<WinbackDaily />);
    await new Promise((r) => setTimeout(r, 10));
    expect(odd.container.textContent).toBe('');
  });
});

describe('when it is on', () => {
  it('lists the orders with their kind, their reason and the window in the subtitle; the order is a link', async () => {
    const { container } = render(<WinbackDaily />);
    await screen.findAllByText('ORD-1');
    const text = container.textContent ?? '';
    expect(text).toContain('اتصالات اليوم');
    expect(text).toContain('من 24 لحد 72 ساعة');
    expect(text).toContain('طلب ملغى');
    expect(text).toContain('مؤجّل فات موعدو');
    expect(text).toContain('السعر مرتفع');
    expect(text).toContain('آخر اتصال: ما ردّ — هدى');
    expect(container.querySelector('a[href="/orders/o1"]')?.textContent).toBe('ORD-1');
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('naming who calls is one request, with the order and the person', async () => {
    render(<WinbackDaily />);
    await screen.findAllByText('ORD-1');
    api.mockResolvedValueOnce({ ok: true });
    fireEvent.change(screen.getAllByLabelText('مين بيتصل — ORD-1')[0], { target: { value: 'u1' } });
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/confirmation/winback/daily', expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse((api.mock.calls.find((c) => c[1])![1] as { body: string }).body);
    expect(sent).toEqual({ action: 'assign', orderId: 'o1', userId: 'u1' });
  });

  it('recording a call needs a result first, then is one request', async () => {
    render(<WinbackDaily />);
    await screen.findAllByText('ORD-1');
    const row = screen.getAllByLabelText('نتيجة الاتصال — ORD-1')[0];
    const save = row.parentElement!.querySelector('button')!;
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(row, { target: { value: 'AGREED' } });
    expect((save as HTMLButtonElement).disabled).toBe(false);
    api.mockResolvedValueOnce({ ok: true });
    fireEvent.click(save);
    await waitFor(() => expect(api.mock.calls.some((c) => c[1])).toBe(true));
    expect(JSON.parse((api.mock.calls.find((c) => c[1])![1] as { body: string }).body)).toEqual({ action: 'call', orderId: 'o1', result: 'AGREED' });
  });

  it('without the reassign key the assignee is a word, not a box; without the winback key there is no call box', async () => {
    api.mockResolvedValue(answer({ canAssign: false, canCall: false }));
    const { container } = render(<WinbackDaily />);
    await screen.findAllByText('ORD-1');
    expect(screen.queryAllByLabelText(/مين بيتصل/)).toHaveLength(0);
    expect(screen.queryAllByLabelText(/نتيجة الاتصال/)).toHaveLength(0);
    expect(container.textContent).toContain('هدى');
  });

  it('a failed press says the server\'s sentence', async () => {
    render(<WinbackDaily />);
    await screen.findAllByText('ORD-1');
    api.mockRejectedValueOnce(new Error('الطلب مش بقايمة اليوم.'));
    fireEvent.change(screen.getAllByLabelText('مين بيتصل — ORD-1')[0], { target: { value: 'u1' } });
    await waitFor(() => expect(failed).toHaveBeenCalledWith('الطلب مش بقايمة اليوم.'));
  });

  it('says so when the list is empty, and shows no customer field', async () => {
    api.mockResolvedValue(answer({ items: [] }));
    const { container } = render(<WinbackDaily />);
    await screen.findByText('ما في طلبات لاتصال اليوم.');
    expect(container.textContent).not.toMatch(/\b0\d{9}\b|هاتف|عنوان/);
  });
});
