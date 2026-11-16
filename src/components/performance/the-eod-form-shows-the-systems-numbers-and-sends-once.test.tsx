// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE END-OF-DAY FORM SHOWS THE SYSTEM'S NUMBERS BESIDE HERS AND SENDS ONCE (step H2): six boxes per agent with the system's figure beside each, the biggest problem and the tip, one
 * send; after it the form is replaced by what she sent and says it does not change; never a verdict on her figures; nothing is drawn on a refusal or an odd answer.
 */
const { api, failed } = vi.hoisted(() => ({ api: vi.fn(), failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed }) }));

import { EodReportForm } from './EodReportForm';

const sys = (over: Record<string, unknown> = {}) => ({ userId: 'u1', name: 'سارة', claims: 10, confirmed: 6, rejected: 2, noAnswer: 8, winback: 1, stuck: 3, rejectedByReason: { PRICE_TOO_HIGH: 2 }, winbackConverted: 1, ...over });
const answer = (over: Record<string, unknown> = {}) => ({ day: '2026-11-10', mayReport: true, reasons: { PRICE_TOO_HIGH: 'السعر مرتفع' }, system: [sys()], submitted: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  api.mockResolvedValue(answer());
});
afterEach(cleanup);

describe('the form', () => {
  it('shows each agent with the system\'s six figures, the reasons in the desk\'s words and the winback result', async () => {
    const { container } = render(<EodReportForm />);
    await screen.findByText('سارة');
    const text = container.textContent ?? '';
    for (const label of ['سحب', 'تأكيد', 'رفض', 'محاولات لا يرد', 'اتصالات استرجاع', 'عالق أكتر من 48 ساعة']) expect(text).toContain(label);
    expect(text).toContain('النظام: 10');
    expect(text).toContain('السعر مرتفع 2');
    expect(text).toContain('1 عرض، 1 صار طلب مؤكَّد');
    expect(text).not.toMatch(/[٠-٩]/);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(6);
  });

  it('says it is once a day and cannot be edited, before she sends', async () => {
    const { container } = render(<EodReportForm />);
    await screen.findByText('سارة');
    expect(container.textContent).toContain('مرة وحدة باليوم وما بيتعدّل');
  });

  it('sends hers as whole numbers with the day and the texts, then reloads', async () => {
    render(<EodReportForm />);
    await screen.findByText('سارة');
    for (const [label, value] of [['سحب', '9'], ['تأكيد', '6'], ['رفض', '2'], ['محاولات لا يرد', '8'], ['اتصالات استرجاع', '1'], ['عالق أكتر من 48 ساعة', '3']]) {
      fireEvent.change(screen.getByLabelText(`سارة — ${label}`), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText('أكبر مشكلة اليوم'), { target: { value: 'ازدحام' } });
    fireEvent.change(screen.getByLabelText('نصيحة لبكرا'), { target: { value: 'ابدأوا بالمتأخر' } });
    api.mockResolvedValueOnce({ ok: true });
    api.mockResolvedValueOnce(answer({ submitted: { at: '2026-11-10T20:00:00Z', payload: { agents: [{ userId: 'u1', claims: 9, confirmed: 6, rejected: 2, noAnswer: 8, winback: 1, stuck: 3 }], biggestProblem: 'ازدحام', tip: 'ابدأوا بالمتأخر' } } }));
    fireEvent.click(screen.getByText('إرسال التقرير (مرة وحدة)'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/confirmation/eod-report', expect.objectContaining({ method: 'POST' })));
    const sent = JSON.parse((api.mock.calls.find((c) => c[0] === '/api/confirmation/eod-report' && c[1])![1] as { body: string }).body);
    expect(sent.day).toBe('2026-11-10');
    expect(sent.agents).toEqual([{ userId: 'u1', claims: 9, confirmed: 6, rejected: 2, noAnswer: 8, winback: 1, stuck: 3 }]);
    expect(sent.biggestProblem).toBe('ازدحام');
    await screen.findByText(/أرسلتي تقرير 2026-11-10 وما بيتعدّل/);
    expect(screen.queryByText('إرسال التقرير (مرة وحدة)')).toBeNull();
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('after it is sent, shows what she sent beside the system\'s figure — and no verdict on the difference', async () => {
    api.mockResolvedValue(answer({ submitted: { at: 'x', payload: { agents: [{ userId: 'u1', claims: 14, confirmed: 6, rejected: 2, noAnswer: 8, winback: 1, stuck: 3 }], biggestProblem: 'ازدحام', tip: '' } } }));
    const { container } = render(<EodReportForm />);
    await screen.findByText('سارة');
    const text = container.textContent ?? '';
    expect(text).toContain('أرقامك: 14');
    expect(text).toContain('النظام: 10');
    expect(text).not.toMatch(/\d+%|انحراف|فرق|مخالف|كذب/);
  });

  it('a failed send says the server\'s sentence and keeps what she typed', async () => {
    render(<EodReportForm />);
    await screen.findByText('سارة');
    fireEvent.change(screen.getByLabelText('سارة — سحب'), { target: { value: '9' } });
    api.mockRejectedValueOnce(new Error('أرسلتي تقرير هاليوم أصلاً، وما بيتعدّل.'));
    fireEvent.click(screen.getByText('إرسال التقرير (مرة وحدة)'));
    await waitFor(() => expect(failed).toHaveBeenCalledWith('أرسلتي تقرير هاليوم أصلاً، وما بيتعدّل.'));
    expect((screen.getByLabelText('سارة — سحب') as HTMLInputElement).value).toBe('9');
  });

  it('a day she may no longer report is read-only', async () => {
    api.mockResolvedValue(answer({ mayReport: false }));
    render(<EodReportForm />);
    await screen.findByText('سارة');
    for (const input of screen.getAllByRole('spinbutton')) expect((input as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByText('إرسال التقرير (مرة وحدة)') as HTMLButtonElement).disabled).toBe(true);
  });

  it('draws nothing on a refusal or an odd answer', async () => {
    api.mockRejectedValue(new Error('403'));
    const refused = render(<EodReportForm />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(refused.container.textContent).toBe('');
    cleanup();
    api.mockResolvedValue({ roles: [] });
    const odd = render(<EodReportForm />);
    await new Promise((r) => setTimeout(r, 10));
    expect(odd.container.textContent).toBe('');
  });

  it('with no activity that day says so and offers no form', async () => {
    api.mockResolvedValue(answer({ system: [] }));
    const { container } = render(<EodReportForm />);
    await screen.findByText('ما في نشاط للموظفات بهاليوم.');
    expect(container.textContent).not.toContain('إرسال التقرير');
  });

  it('asks yesterday on demand', async () => {
    render(<EodReportForm />);
    await screen.findByText('سارة');
    fireEvent.click(screen.getByText('أمس'));
    await waitFor(() => expect(String(api.mock.calls.at(-1)![0])).toMatch(/\/api\/confirmation\/eod-report\?day=\d{4}-\d{2}-\d{2}/));
  });
});
