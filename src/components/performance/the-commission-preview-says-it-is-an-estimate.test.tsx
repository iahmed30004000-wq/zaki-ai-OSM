// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE COMMISSION PREVIEW SAYS IT IS AN ESTIMATE (step G2): the figure stands beside the confirmed count it rests on, a month under the first tier is a dash (never «0»), «قاعدة الاحتساب»
 * is one tap away — and for anyone without the payroll's key, on a failure or on an odd answer, nothing is drawn at all.
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));

import { CommissionPreview } from './CommissionPreview';

const est = (over: Record<string, unknown> = {}) => ({ amount: 60_000, confirmed: 165, tier: 4, kind: 'TIER', gate: { enabled: false, applied: false, deliveryRate: null, minDeliveryRate: 80 }, steps: ['المؤكَّد بالشهر: 165 طلب.', 'وصلت الشريحة 4: 60,000.'], ...over });
const answer = (rows: unknown[]) => ({ window: { start: '2026-11-01T00:00:00Z', end: '2026-11-16T00:00:00Z' }, rows });

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue(answer([{ userId: 'u1', name: 'سارة', estimate: est() }, { userId: 'u2', name: 'هدى', estimate: est({ amount: 0, confirmed: 40, tier: 0, kind: 'NONE', steps: ['أقل من أول شريحة (100 طلب): ما في عمولة بهالتقدير.'] }) }]));
});
afterEach(cleanup);

describe('the preview', () => {
  it('says it is an estimate, not what is accrued or paid', async () => {
    const { container } = render(<CommissionPreview />);
    await screen.findAllByText('سارة');
    expect(container.textContent).toContain('تقدير بس، مش المحسوب ولا المصروف');
  });

  it('shows the amount beside its confirmed count, in Western digits', async () => {
    const { container } = render(<CommissionPreview />);
    await screen.findAllByText('سارة');
    const text = container.textContent ?? '';
    expect(text).toContain('60,000');
    expect(text).toContain('165');
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('a month under the first tier is a dash for the amount and the tier, never «0»', async () => {
    const { container } = render(<CommissionPreview />);
    await screen.findAllByText('هدى');
    const row = [...container.querySelectorAll('tr')].find((tr) => tr.textContent?.includes('هدى'));
    expect(row?.textContent).toContain('—');
    expect(row?.textContent).not.toMatch(/(^|\D)0(\D|$)/);
  });

  it('keeps the steps one tap away', async () => {
    const { container } = render(<CommissionPreview />);
    await screen.findAllByText('سارة');
    expect(container.querySelector('details summary')?.textContent).toBe('كيف انحسب');
    expect(container.textContent).toContain('وصلت الشريحة 4: 60,000.');
  });

  it('a bonus month says «بونص» for the tier', async () => {
    api.mockResolvedValue(answer([{ userId: 'u1', name: 'سارة', estimate: est({ amount: 1_000_000, confirmed: 2_000, tier: 0, kind: 'BONUS' }) }]));
    const { container } = render(<CommissionPreview />);
    await screen.findAllByText('سارة');
    expect(container.textContent).toContain('بونص');
    expect(container.textContent).toContain('1,000,000');
  });

  it('draws NOTHING for anyone refused (no payroll key), on a failure, or on an odd answer', async () => {
    api.mockRejectedValue(new Error('403'));
    const refused = render(<CommissionPreview />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(refused.container.textContent).toBe('');
    cleanup();
    api.mockResolvedValue({ roles: [] });
    const odd = render(<CommissionPreview />);
    await new Promise((r) => setTimeout(r, 10));
    expect(odd.container.textContent).toBe('');
  });

  it('asks its own door and has no controls', async () => {
    render(<CommissionPreview />);
    await screen.findAllByText('سارة');
    expect(api).toHaveBeenCalledWith('/api/performance/commission-preview');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
