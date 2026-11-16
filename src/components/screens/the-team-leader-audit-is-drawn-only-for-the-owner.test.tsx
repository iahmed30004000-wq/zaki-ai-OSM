// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE TEAM LEADER'S AUDIT IS DRAWN ONLY FOR THE OWNER (step H2): her figures against the system's with the variance, her action log, the sample of rejected orders with only
 * «valid or doubtful» — and for anyone whose door answers 403 (the team leader herself included), on a failure or an odd answer, NOTHING is drawn, not even the title.
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/orders/OrderRef', () => ({ OrderRef: ({ id, number }: { id: string; number: string }) => <a href={`/orders/${id}`}>{number}</a> }));

import { TeamLeaderAudit } from './TeamLeaderAudit';

const v = (submitted: number, system: number) => ({ submitted, system, percent: system === 0 ? (submitted === 0 ? 0 : null) : Math.round(((submitted - system) / system) * 100) });
const metrics = (over: Record<string, unknown> = {}) => ({ claims: v(12, 10), confirmed: v(6, 6), rejected: v(2, 2), noAnswer: v(8, 8), winback: v(0, 0), stuck: v(3, 0), ...over });
const answer = (over: Record<string, unknown> = {}) => ({
  day: '2026-11-10',
  leaders: [{ id: 'dalia', name: 'داليا' }],
  leader: { id: 'dalia', name: 'داليا' },
  report: { submittedAt: '2026-11-10T20:00:00Z', biggestProblem: 'ازدحام الصبح', tip: 'ابدأوا بالمتأخر', comparison: [{ userId: 'u1', name: 'سارة', metrics: metrics() }] },
  actions: [{ action: 'ORDER_TRANSFERRED', entity: 'Order', entityId: 'o1', createdAt: '2026-11-10T09:00:00Z' }],
  sample: [{ orderId: 'o1', orderNumber: 'ORD-7', reason: 'FAKE_ORDER', reasonAr: 'طلب وهميّ', agent: 'سارة', phoneValid: false }, { orderId: 'o2', orderNumber: 'ORD-8', reason: 'OTHER', reasonAr: 'سبب آخر', agent: 'هدى', phoneValid: true }],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue(answer());
});
afterEach(cleanup);

describe('the owner\'s view', () => {
  it('shows her figures beside the system\'s with the variance, and marks 20% or more', async () => {
    const { container } = render(<TeamLeaderAudit />);
    await screen.findByText('تدقيق قائد الفريق');
    await screen.findAllByText('سارة');
    const text = container.textContent ?? '';
    expect(text).toContain('قالت 12 · النظام 10');
    expect(text).toContain('+20%');
    expect(text).toContain('قالت 3 · النظام 0');
    expect(text).toContain('—'); // her 3 against a system zero has no percent
    expect(text).toContain('ازدحام الصبح');
    expect(text).toContain('ابدأوا بالمتأخر');
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('shows her action log of the day in Arabic words', async () => {
    const { container } = render(<TeamLeaderAudit />);
    await screen.findAllByText('سارة');
    expect(container.textContent).toContain('سجل شغلها بهاليوم');
    expect(container.textContent).not.toContain('ORDER_TRANSFERRED');
  });

  it('shows the sample with the order as a link and only valid or doubtful — never a number', async () => {
    const { container } = render(<TeamLeaderAudit />);
    await screen.findAllByText('ORD-7');
    expect(container.querySelector('a[href="/orders/o1"]')?.textContent).toBe('ORD-7');
    expect(container.textContent).toContain('مشكوك');
    expect(container.textContent).toContain('صالح');
    expect(container.textContent).not.toMatch(/\b0\d{9}\b|\+?963\d{9}/);
  });

  it('says so when she sent no report, and when nobody holds the role', async () => {
    api.mockResolvedValue(answer({ report: null }));
    const a = render(<TeamLeaderAudit />);
    await screen.findByText('ما أرسلت تقرير هاليوم.');
    a.unmount();
    api.mockResolvedValue(answer({ leader: null, leaders: [], report: null, actions: [] }));
    render(<TeamLeaderAudit />);
    await screen.findByText('ما في حدا بدور «قائد الفريق».');
  });

  it('asks for the day and the leader chosen', async () => {
    api.mockResolvedValue(answer({ leaders: [{ id: 'dalia', name: 'داليا' }, { id: 'x', name: 'نور' }] }));
    render(<TeamLeaderAudit />);
    await screen.findAllByText('سارة');
    expect(String(api.mock.calls[0][0])).toMatch(/^\/api\/audit\/team-leader\?day=\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByLabelText('قائد الفريق')).toBeTruthy();
  });
});

describe('for everybody else', () => {
  it('draws NOTHING — not even the title — when the door refuses, fails or answers something odd', async () => {
    api.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const refused = render(<TeamLeaderAudit />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(refused.container.textContent).toBe('');
    refused.unmount();
    api.mockResolvedValue({ rows: [] });
    const odd = render(<TeamLeaderAudit />);
    await new Promise((r) => setTimeout(r, 10));
    expect(odd.container.textContent).toBe('');
  });
});
