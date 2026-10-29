// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';

/**
 * THE PAYSLIP BEFORE ANYBODY PRESSES «اصرف».
 *
 * A «فرق تحصيل» nobody decided is listed apart, in the words «لم يُعتمد تفسيره — سيُخصم», because paying applies it.
 * A deduction in another currency waits for a rate: the payer writes it, the slip is drawn again with it, and the
 * payment carries the same currency and rate to the server (which stores them on the payslip).
 */
const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a) }));

import { UserSalary } from './UserSalary';

const WALLET = { id: 'w1', name: 'الصندوق', currencyCode: 'USD', country: { minorUnit: 2 } };
const slip = (preview: Record<string, unknown>) => ({
  period: { start: '2026-10-01T00:00:00Z', end: '2026-10-31T00:00:00Z', paid: null },
  preview: { salary: 300, currencyCode: 'USD', penaltyTotal: 0, net: 300, carriedOver: 0, penaltyIds: [], undecided: [], otherCurrency: [], converted: null, ...preview },
  commission: [],
  wallets: [WALLET],
});
const posts = () => api.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
const open = async () => {
  render(<UserSalary userId="u1" initial={{ salaryAmount: 300, salaryCurrency: 'USD' }} canEdit={false} canPay />);
  fireEvent.click(screen.getByRole('button', { name: /اصرف الراتب/ }));
  return screen.findByRole('dialog');
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('a shortfall nobody decided', () => {
  it('is listed in the exact words, with its own amount, apart from the total', async () => {
    api.mockResolvedValue(slip({ penaltyTotal: 2, net: 298, penaltyIds: ['s1'], undecided: [{ id: 's1', amount: 2, currencyCode: 'USD' }] }));
    const dialog = await open();
    expect(await within(dialog).findByText('لم يُعتمد تفسيره — سيُخصم')).toBeTruthy();
    expect(within(dialog).getByText('2 USD')).toBeTruthy();
    expect(within(dialog).getByText('298 USD')).toBeTruthy();
  });

  it('is not mentioned when there is none', async () => {
    api.mockResolvedValue(slip({}));
    const dialog = await open();
    await within(dialog).findByText('الراتب');
    expect(within(dialog).queryByText('لم يُعتمد تفسيره — سيُخصم')).toBeNull();
  });
});

describe('a deduction in another currency', () => {
  const waiting = slip({ otherCurrency: [{ currencyCode: 'JOD', amount: 0.5 }] });
  const converted = slip({
    penaltyTotal: 0.71, net: 299.29, penaltyIds: ['j1'], undecided: [{ id: 'j1', amount: 0.5, currencyCode: 'JOD' }],
    converted: { currencyCode: 'JOD', rate: 1.41, amount: 0.5, inSalaryCurrency: 0.71 },
  });

  it('offers a currency and a rate, and «طبّق السعر» stays off until a rate is typed', async () => {
    api.mockResolvedValue(waiting);
    const dialog = await open();
    const apply = (await within(dialog).findByRole('button', { name: 'طبّق السعر' })) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.change(within(dialog).getAllByRole('spinbutton')[0], { target: { value: '1.41' } });
    expect(apply.disabled).toBe(false);
  });

  it('draws the slip again with that currency and rate — through the preview door, not by guessing', async () => {
    api.mockResolvedValueOnce(waiting).mockResolvedValueOnce(converted);
    const dialog = await open();
    fireEvent.change((await within(dialog).findAllByRole('spinbutton'))[0], { target: { value: '1.41' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'طبّق السعر' }));

    await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    expect(api.mock.calls[1][0]).toBe('/api/payroll/payslip?userId=u1&convertCurrency=JOD&convertRate=1.41');
    expect(await within(dialog).findByText('299.29 USD')).toBeTruthy();
    expect(within(dialog).getByText(/حُوّلت بسعر 1.41/)).toBeTruthy();
  });

  it('and the payment carries the same currency and rate', async () => {
    api.mockResolvedValueOnce(waiting).mockResolvedValueOnce(converted).mockResolvedValue({});
    const dialog = await open();
    fireEvent.change((await within(dialog).findAllByRole('spinbutton'))[0], { target: { value: '1.41' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'طبّق السعر' }));
    await within(dialog).findByText('299.29 USD');

    const wallets = within(dialog).getAllByRole('combobox');
    fireEvent.change(wallets[wallets.length - 1], { target: { value: 'w1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اصرف' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({
      userId: 'u1', walletId: 'w1', exchangeRate: 1, convert: { currencyCode: 'JOD', rate: 1.41 },
    });
  });

  it('NEGATIVE: a rate typed but not applied is NOT sent — the slip the payer saw is the slip that is paid', async () => {
    api.mockResolvedValueOnce(waiting).mockResolvedValue({});
    const dialog = await open();
    fireEvent.change((await within(dialog).findAllByRole('spinbutton'))[0], { target: { value: '1.41' } });
    const wallets = within(dialog).getAllByRole('combobox');
    fireEvent.change(wallets[wallets.length - 1], { target: { value: 'w1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'اصرف' }));

    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String((posts()[0][1] as RequestInit).body))).toEqual({ userId: 'u1', walletId: 'w1', exchangeRate: 1 });
  });

  it('a slip with nothing in another currency shows no rate box', async () => {
    api.mockResolvedValue(slip({}));
    const dialog = await open();
    await within(dialog).findByText('الراتب');
    expect(within(dialog).queryByRole('button', { name: 'طبّق السعر' })).toBeNull();
  });
});
