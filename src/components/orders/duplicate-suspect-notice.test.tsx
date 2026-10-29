// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const apiJson = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { DuplicateSuspectNotice } from './DuplicateSuspectNotice';

afterEach(() => {
  cleanup();
  apiJson.mockReset();
});

describe('the repeat-order notice above the confirmation buttons', () => {
  it('names the earlier orders and asks the question, in Arabic', async () => {
    apiJson.mockResolvedValue({ suspect: true, twins: [{ orderNumber: 'SY-1' }, { orderNumber: 'SY-2' }], windowMinutes: 10 });
    render(<DuplicateSuspectNotice orderId="o1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('طلب مشابه قبل دقائق');
    expect(alert.textContent).toContain('#SY-1');
    expect(alert.textContent).toContain('#SY-2');
    expect(alert.textContent).toContain('10 دقائق');
    expect(alert.textContent).toContain('اسأله قبل التأكيد');
    expect(apiJson).toHaveBeenCalledWith('/api/orders/o1/duplicate-suspect');
  });

  it('draws nothing when the order was not flagged', async () => {
    apiJson.mockResolvedValue({ suspect: false, twins: [], windowMinutes: 10 });
    const { container } = render(<DuplicateSuspectNotice orderId="o1" />);
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('draws nothing, and no error, when the reader may not open the answer', async () => {
    apiJson.mockRejectedValue(new Error('403'));
    const { container } = render(<DuplicateSuspectNotice orderId="o1" />);
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('asks again for the next order when the window moves to another one', async () => {
    apiJson.mockResolvedValue({ suspect: false, twins: [], windowMinutes: 10 });
    const { rerender } = render(<DuplicateSuspectNotice orderId="o1" />);
    rerender(<DuplicateSuspectNotice orderId="o2" />);
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/orders/o2/duplicate-suspect'));
  });
});
