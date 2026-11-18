// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE AGENT SCORECARD SAYS ITS BASES (step G1): every rate stands beside its counts, a base of zero is a dash and never «0%», the rules are one tap away, the buttons only choose
 * the grain — and an odd or failed answer draws nothing, so the score board it sits under is never dragged down by it.
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));

import { AgentScorecard } from './AgentScorecard';

const ratio = (of: number, base: number) => ({ of, base, rate: base > 0 ? Math.round((of / base) * 100) : null });
const row = (over: Record<string, unknown> = {}) => ({
  bucket: '2026-11-10', userId: 'u1', name: 'سارة', claims: 6, confirmed: 3, rejected: 1, confirmationRate: ratio(3, 4),
  medianFirstAttemptMinutes: 2.5, firstAttempts: 5, quickNoAnswer: ratio(1, 6), attempts: 9, upsell: ratio(0, 0),
  delivery: { ...ratio(3, 4), delivered: 3, returned: 1 }, winback: ratio(1, 3), ...over,
});
const answer = (rows: unknown[]) => ({ grain: 'day', deliveryMaturityDays: 7, rows, rules: { claims: 'قاعدة السحب', winback: 'بيتفعّل مع الخطوة F' } });

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue(answer([row()]));
});
afterEach(cleanup);

describe('the scorecard', () => {
  it('prints each rate beside its counts, and a zero base as a dash', async () => {
    const { container } = render(<AgentScorecard />);
    await screen.findAllByText('سارة');
    const text = container.textContent ?? '';
    expect(text).toContain('75%');
    expect(text).toContain('3 من 4');
    expect(text).toContain('17%');
    expect(text).toContain('1 من 6');
    expect(text).toContain('3 مسلَّم و1 مرتجع');
    expect(text).toContain('2.5 د');
    expect(text).not.toContain('0%');
    expect(text).toContain('1 من 3'); // the winback: one of three offers became a confirmed order
    expect(text).toContain('—'); // the upsell with no confirmed base
  });

  it('a row with no decisions and no deliveries shows dashes, never zeros as rates', async () => {
    api.mockResolvedValue(answer([row({ confirmed: 0, rejected: 0, confirmationRate: ratio(0, 0), quickNoAnswer: ratio(0, 0), delivery: { ...ratio(0, 0), delivered: 0, returned: 0 }, winback: ratio(0, 0), medianFirstAttemptMinutes: null })]));
    const { container } = render(<AgentScorecard />);
    await screen.findAllByText('سارة');
    expect(container.textContent).not.toMatch(/\d+%/);
  });

  it('keeps «قاعدة الاحتساب» one tap away, with the rules the server sent', async () => {
    const { container } = render(<AgentScorecard />);
    await screen.findAllByText('سارة');
    expect(container.querySelector('details summary')?.textContent).toBe('قاعدة الاحتساب');
    expect(container.textContent).toContain('قاعدة السحب');
  });

  it('the only buttons choose the grain, and asking for the week asks the door for it', async () => {
    render(<AgentScorecard />);
    await screen.findAllByText('سارة');
    // UPDATED 2026-11-18 (R14a1, the shape): it read «the only BUTTONS are يومي and أسبوعي» — the pair is now the kit's `Segmented`, so the
    // two are radios of one group. Still the only controls: no button at all, and exactly these two choices.
    expect(screen.queryAllByRole('button')).toEqual([]);
    expect(screen.getAllByRole('radio').map((b) => b.textContent)).toEqual(['يومي', 'أسبوعي']);
    expect(api).toHaveBeenLastCalledWith('/api/performance/scorecard?grain=day');
    fireEvent.click(screen.getByText('أسبوعي'));
    await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/performance/scorecard?grain=week'));
  });

  it('draws nothing when the door fails or answers something odd — never a table of zeros', async () => {
    api.mockRejectedValue(new Error('boom'));
    const failed = render(<AgentScorecard />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await waitFor(() => expect(failed.container.textContent).toBe(''));
    cleanup();
    api.mockResolvedValue({ roles: [] }); // the score board's own answer, as a test double may hand it
    const odd = render(<AgentScorecard />);
    await waitFor(() => expect(odd.container.textContent).toBe(''));
  });

  it('is Arabic with Western digits and has no ranking control', async () => {
    const { container } = render(<AgentScorecard />);
    await screen.findAllByText('سارة');
    expect(container.textContent).not.toMatch(/[٠-٩]/);
    expect(container.textContent).not.toMatch(/الأسوأ|الأفضل|ترتيب تنازلي/);
  });
});
