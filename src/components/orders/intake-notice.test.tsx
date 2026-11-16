// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

const apiJson = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { IntakeNotice } from './IntakeNotice';

afterEach(() => {
  cleanup();
  apiJson.mockReset();
});

describe('the intake notice above the confirmation buttons', () => {
  it('names the first order and asks the question, in Arabic', async () => {
    apiJson.mockResolvedValue({ duplicateOf: 'SY-1', suspectNumber: false, windowHours: 24 });
    render(<IntakeNotice orderId="o1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('طلب مكرر محتمل');
    expect(alert.textContent).toContain('#SY-1');
    expect(alert.textContent).toContain('24 ساعة');
    expect(alert.textContent).not.toContain('رقم مشكوك');
    expect(apiJson).toHaveBeenCalledWith('/api/orders/o1/intake-flags');
  });

  it('says the number is suspect, and says both when both were flagged', async () => {
    apiJson.mockResolvedValue({ duplicateOf: 'SY-1', suspectNumber: true, windowHours: 24 });
    render(<IntakeNotice orderId="o1" />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('رقم مشكوك');
    expect(alert.textContent).toContain('طلب مكرر محتمل');
  });

  it('refuses nothing and hides nothing: it draws no button and no link', async () => {
    apiJson.mockResolvedValue({ duplicateOf: 'SY-1', suspectNumber: true, windowHours: 24 });
    const { container } = render(<IntakeNotice orderId="o1" />);
    await screen.findByRole('alert');
    expect(container.querySelector('button, a, input')).toBeNull();
  });

  it('draws nothing when there is nothing to say, and nothing — no error — when the reader may not open the answer', async () => {
    apiJson.mockResolvedValue({ duplicateOf: null, suspectNumber: false, windowHours: 24 });
    const first = render(<IntakeNotice orderId="o1" />);
    await waitFor(() => expect(apiJson).toHaveBeenCalled());
    expect(first.container.innerHTML).toBe('');
    cleanup();
    apiJson.mockRejectedValue(new Error('403'));
    const second = render(<IntakeNotice orderId="o1" />);
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(2));
    expect(second.container.innerHTML).toBe('');
  });
});
