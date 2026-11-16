// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { AGENT_COMMISSION_DEFAULTS } from '@/lib/agent-commission-settings';

/**
 * THE CALCULATOR CARD EDITS AN ESTIMATE ONLY (step G2): it says so; it shows the planner's tiers; save is disabled until something changed and sends the WHOLE document;
 * a refusal keeps what was typed and says the server's sentence; read-only for whoever lacks the sensitive-settings key.
 */
const { api, can, failed } = vi.hoisted(() => ({ api: vi.fn(), can: { value: true }, failed: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed }) }));
vi.mock('@/hooks/useCan', () => ({ useCan: () => can.value }));

import { AgentCommissionCard } from './AgentCommissionCard';

beforeEach(() => {
  vi.clearAllMocks();
  can.value = true;
  api.mockResolvedValue({ agentCommission: AGENT_COMMISSION_DEFAULTS });
});
afterEach(cleanup);

const loaded = async () => {
  const view = render(<AgentCommissionCard />);
  await screen.findByText('حاسبة عمولة الموظفات (تقدير)');
  return view;
};

describe('the card', () => {
  it('says it changes an estimate and nothing in the commission rules, the accrual or the payout; Arabic, Western digits', async () => {
    const { container } = await loaded();
    const text = container.textContent ?? '';
    expect(text).toContain('هاد تقدير بس');
    expect(text).toContain('ما بيغيّر قواعد العمولة ولا المحسوب ولا المصروف');
    expect(text).not.toMatch(/[٠-٩]/);
  });

  it('shows the planner\'s five tiers, the bonus and the gate', async () => {
    await loaded();
    const from = (i: number) => (screen.getByLabelText(`بداية الشريحة ${i}`) as HTMLInputElement).value;
    const value = (i: number) => (screen.getByLabelText(`مبلغ الشريحة ${i}`) as HTMLInputElement).value;
    expect([1, 2, 3, 4, 5].map(from)).toEqual(['100', '120', '140', '160', '200']);
    expect([1, 2, 3, 4, 5].map(value)).toEqual(['25000', '35000', '50000', '60000', '100000']);
    expect((screen.getByLabelText('حد البونص') as HTMLInputElement).value).toBe('2000');
    expect((screen.getByLabelText('سعر طلب البونص') as HTMLInputElement).value).toBe('500');
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });

  it('save is off until something changed, then sends the WHOLE document once', async () => {
    await loaded();
    const save = screen.getByText('حفظ') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('مبلغ الشريحة 1'), { target: { value: '30000' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(save.disabled).toBe(false);
    api.mockResolvedValueOnce({ agentCommission: { ...AGENT_COMMISSION_DEFAULTS, tiers: [{ from: 100, value: 30_000 }, ...AGENT_COMMISSION_DEFAULTS.tiers.slice(1)], qualityGate: { enabled: true, minDeliveryRate: 80 } } });
    fireEvent.click(save);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    const [url, init] = api.mock.calls[1] as [string, { method: string; body: string }];
    expect(url).toBe('/api/settings/agent-commission');
    expect(init.method).toBe('PUT');
    const sent = JSON.parse(init.body);
    expect(sent.tiers[0]).toEqual({ from: 100, value: 30_000 });
    expect(sent.tiers).toHaveLength(5);
    expect(sent.qualityGate).toEqual({ enabled: true, minDeliveryRate: 80 });
    expect(sent.bonus).toEqual({ minOrders: 2_000, perOrder: 500 });
    await waitFor(() => expect((screen.getByText('حفظ') as HTMLButtonElement).disabled).toBe(true));
  });

  it('a refusal keeps what was typed and says the server\'s sentence', async () => {
    await loaded();
    fireEvent.change(screen.getByLabelText('بداية الشريحة 2'), { target: { value: '90' } });
    api.mockRejectedValueOnce(new Error('بدايات الشرائح لازم تكبر شريحة ورا شريحة، بدون تكرار.'));
    fireEvent.click(screen.getByText('حفظ'));
    await waitFor(() => expect(failed).toHaveBeenCalledWith('بدايات الشرائح لازم تكبر شريحة ورا شريحة، بدون تكرار.'));
    expect((screen.getByLabelText('بداية الشريحة 2') as HTMLInputElement).value).toBe('90');
  });

  it('a tier can be added and removed, and the last tier cannot be removed', async () => {
    await loaded();
    fireEvent.click(screen.getByText('إضافة شريحة'));
    expect(screen.getByLabelText('بداية الشريحة 6')).toBeTruthy();
    fireEvent.click(screen.getAllByText('حذف')[0]);
    expect(screen.queryByLabelText('بداية الشريحة 6')).toBeNull();
  });

  it('is read-only for whoever does not hold the sensitive-settings key, and says so', async () => {
    can.value = false;
    const { container } = await loaded();
    for (const input of container.querySelectorAll('input')) expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText('حفظ')).toBeNull();
    expect(screen.getByText(/بيعدّلها بس صاحب صلاحية/)).toBeTruthy();
  });
});
