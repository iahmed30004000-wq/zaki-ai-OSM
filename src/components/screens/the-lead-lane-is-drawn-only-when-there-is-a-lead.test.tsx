// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE LEAD LANE IS DRAWN ONLY WHEN THERE IS A LEAD (step E2): off, empty, on a failure or on an odd answer it draws NOTHING (the follow-up tabs below are untouched); on, it lists the leads with
 * the product's live offers, and «حوّل لطلب» stays shut until an offer is chosen and an address written. A conversion sends the lead, the OFFER ID and the address — no price field exists — and
 * «ما بحتاج» is one request.
 */
const { api, failed, done } = vi.hoisted(() => ({ api: vi.fn(), failed: vi.fn(), done: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed, done }) }));

import { LeadsLane } from './LeadsLane';

const lead = (over: Record<string, unknown> = {}) => ({
  id: 'L1', fullName: 'سارة الحلبي', phone: '0933620102', city: 'دمشق', productName: 'كريم', receivedAt: new Date(Date.now() - 5 * 60_000).toISOString(), recentOrder: false,
  offers: [{ id: 'o1', name: 'علبتين', price: 40 }, { id: 'o2', name: 'ثلاث علب', price: 55 }], ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue({ enabled: true, leads: [lead(), lead({ id: 'L2', fullName: 'هدى', recentOrder: true, offers: [] })] });
});
afterEach(cleanup);

describe('when there is nothing to draw', () => {
  it('draws nothing when off, empty, failed or odd', async () => {
    for (const reply of [{ enabled: false }, { enabled: true, leads: [] }, new Error('403'), { rows: [] }]) {
      if (reply instanceof Error) api.mockRejectedValue(reply);
      else api.mockResolvedValue(reply);
      const { container, unmount } = render(<LeadsLane />);
      await waitFor(() => expect(api).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 10));
      expect(container.textContent).toBe('');
      unmount();
      api.mockClear();
    }
  });
});

describe('when there are leads', () => {
  it('lists them with their city, product and wait, marks the 24-hour repeat, and says «ما في عرض متاح» for a product with no live offer', async () => {
    const { container } = render(<LeadsLane />);
    await screen.findAllByText('سارة الحلبي');
    const text = container.textContent ?? '';
    expect(text).toContain('ليدز الصفحات');
    expect(text).toContain('دمشق');
    expect(text).toContain('كريم');
    expect(text).toContain('5 دقيقة');
    expect(text).toContain('طلب نفس المنتج من آخر 24 ساعة');
    expect(text).toContain('ما في عرض متاح');
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('the convert button is shut until an offer is chosen and an address is written; then ONE request with the offer id and the address, and no price', async () => {
    render(<LeadsLane />);
    await screen.findAllByText('سارة الحلبي');
    const convert = screen.getAllByText('حوّل لطلب')[0] as HTMLButtonElement;
    expect(convert.disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText('العرض — سارة الحلبي')[0], { target: { value: 'o2' } });
    expect(convert.disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText('العنوان — سارة الحلبي')[0], { target: { value: 'المزة، شارع 5' } });
    expect(convert.disabled).toBe(false);
    api.mockResolvedValueOnce({ ok: true, orderNumber: 'LP-1' });
    fireEvent.click(convert);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/confirmation/leads', expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse((api.mock.calls.find((c) => c[1])![1] as { body: string }).body);
    expect(sent).toEqual({ action: 'convert', leadId: 'L1', offerId: 'o2', address: 'المزة، شارع 5' });
    expect(done).toHaveBeenCalled();
  });

  it('dismissing is one request', async () => {
    render(<LeadsLane />);
    await screen.findAllByText('سارة الحلبي');
    api.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getAllByText('ما بحتاج')[0]);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/confirmation/leads', expect.objectContaining({ method: 'POST' })));
    expect(JSON.parse((api.mock.calls.find((c) => c[1])![1] as { body: string }).body)).toEqual({ action: 'dismiss', leadId: 'L1' });
  });
});
