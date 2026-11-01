// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * THE FIXED-COST BOX ON THE PRODUCT PAGE (the owner, 1/11): «سعر تكلفة المنتج يكون ثابت ولا يتغير ابدا… اللي بيقدر يغيرو الادمنة فقط».
 *
 * The box says which of the two costs the product has — the figure an admin typed, or the batches' average that moves with every
 * delivery — and gives an admin three things: type a figure, take today's average as the figure, clear it. It works out nothing: the
 * average it offers is the one the stock read answered, and the door asks the key again. A person without the key sees the sentence and
 * no control, and a «no» to a question sends nothing.
 */

const { apiJson, confirmMock, toast } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  confirmMock: vi.fn(),
  toast: { done: vi.fn(), warn: vi.fn(), failed: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmMock }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));

import { FixedCostEditor } from './FixedCostEditor';

const money = (n: number) => `${n} JOD`;
let onSaved: Mock<() => void>;

beforeEach(() => {
  apiJson.mockReset();
  apiJson.mockResolvedValue({ success: true });
  confirmMock.mockReset();
  onSaved = vi.fn<() => void>();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function show(over: Partial<React.ComponentProps<typeof FixedCostEditor>> = {}) {
  return render(
    <FixedCostEditor productId="p1" fixedCost={null} batchAverage={8.5} money={money} canChange onSaved={onSaved} {...over} />
  );
}
const typeIn = (value: string) => fireEvent.change(screen.getByLabelText('التكلفة الثابتة'), { target: { value } });
const press = (name: string) =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
const sentBody = () => JSON.parse((apiJson.mock.calls[0][1] as { body: string }).body) as { amount: number | null };

describe('a product with no fixed figure', () => {
  it('says its cost is the batches’ average — with that number — and that it moves', () => {
    show();
    expect(screen.getByText(/بلا تكلفة ثابتة/)).toBeTruthy();
    expect(screen.getByText('8.5 JOD')).toBeTruthy();
    expect(screen.getByText(/بتتغيّر مع كل دفعة/)).toBeTruthy();
  });

  it('offers the box, «احفظ» (off until a figure is typed) and «ثبّت على المتوسط الحالي» — and no «امسح», there is nothing to clear', () => {
    show();
    expect(screen.getByLabelText('التكلفة الثابتة')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'احفظ' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'ثبّت على المتوسط الحالي' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'امسح' })).toBeNull();
  });

  it('typing a figure and pressing «احفظ» PUTs exactly that figure to the product’s door, says so, empties the box and reads again', async () => {
    show();
    typeIn('12.5');
    await press('احفظ');
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(apiJson.mock.calls[0][0]).toBe('/api/products/p1/fixed-cost');
    expect((apiJson.mock.calls[0][1] as { method: string }).method).toBe('PUT');
    expect(sentBody()).toEqual({ amount: 12.5 });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(toast.done).toHaveBeenCalledWith('انحفظت التكلفة الثابتة.');
    expect((screen.getByLabelText('التكلفة الثابتة') as HTMLInputElement).value).toBe('');
    expect(confirmMock).not.toHaveBeenCalled(); // typing a figure needs no question; clearing and taking the average do
  });

  it('a figure the door could not take: the person is told why, nothing is read again, and the box stays as it was', async () => {
    apiJson.mockRejectedValueOnce(new Error('لا تملك صلاحية تغيير التكلفة'));
    show();
    typeIn('9');
    await press('احفظ');
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('لا تملك صلاحية تغيير التكلفة'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(toast.done).not.toHaveBeenCalled();
    expect((screen.getByLabelText('التكلفة الثابتة') as HTMLInputElement).value).toBe('9');
    expect((screen.getByRole('button', { name: 'احفظ' }) as HTMLButtonElement).disabled).toBe(false); // not stuck busy
  });

  it('«ثبّت على المتوسط الحالي» asks first, and names the figure it would fix', async () => {
    confirmMock.mockResolvedValue(false);
    show();
    await press('ثبّت على المتوسط الحالي');
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const asked = confirmMock.mock.calls[0][0] as { title: string; body: string; confirmLabel: string; tone?: string };
    expect(asked.body).toContain('8.5 JOD');
    expect(asked.confirmLabel).toBe('ثبّت');
    expect(asked.tone).toBeUndefined(); // not a danger: nothing is lost
  });

  it('— a «no» sends nothing at all', async () => {
    confirmMock.mockResolvedValue(false);
    show();
    await press('ثبّت على المتوسط الحالي');
    expect(apiJson).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('— a «yes» PUTs the average THE SERVER GAVE the box, not a number worked out here', async () => {
    confirmMock.mockResolvedValue(true);
    show({ batchAverage: 7.3333 });
    await press('ثبّت على المتوسط الحالي');
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ amount: 7.3333 });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});

describe('what «احفظ» accepts', () => {
  it('zero is a cost (a free sample); an empty box and a negative number are not', () => {
    show();
    const save = () => screen.getByRole('button', { name: 'احفظ' }) as HTMLButtonElement;
    typeIn('0');
    expect(save().disabled).toBe(false);
    typeIn('-1');
    expect(save().disabled).toBe(true);
    typeIn('');
    expect(save().disabled).toBe(true);
    typeIn('3.25');
    expect(save().disabled).toBe(false);
  });
});

describe('a product with a fixed figure', () => {
  it('says the figure, that the screens use it, and — truthfully — that orders are not priced from it YET', () => {
    show({ fixedCost: 6.75 });
    expect(screen.getByText('6.75 JOD')).toBeTruthy();
    expect(screen.getByText(/تكلفة الوحدة بشاشات المنتجات والمخزون هي هالرقم/)).toBeTruthy();
    // This release changes no order (the door says so too); the box must not promise what a later release does.
    expect(screen.getByText(/الطلبات لسا بتنحسب من الدفعات/)).toBeTruthy();
    expect(screen.queryByText(/الطلبات الجديدة بتنحسب تكلفتها من هالرقم/)).toBeNull();
    expect(screen.queryByText(/بلا تكلفة ثابتة/)).toBeNull();
  });

  it('with no figure it says the same about orders: typing one changes the screens, not the orders', () => {
    show();
    expect(screen.getByText(/الطلبات ما بتتأثر لسا/)).toBeTruthy();
  });

  it('offers «امسح», and not «ثبّت على المتوسط الحالي» — it already has a figure', () => {
    show({ fixedCost: 6.75 });
    expect(screen.getByRole('button', { name: 'امسح' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ثبّت على المتوسط الحالي' })).toBeNull();
  });

  it('«امسح» asks first, in a danger dialog that says the cost goes back to the average', async () => {
    confirmMock.mockResolvedValue(false);
    show({ fixedCost: 6.75 });
    await press('امسح');
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const asked = confirmMock.mock.calls[0][0] as { body: string; tone: string; confirmLabel: string };
    expect(asked.tone).toBe('danger');
    expect(asked.body).toContain('متوسط المخزون');
    expect(asked.confirmLabel).toBe('امسح');
  });

  it('— a «no» sends nothing; a «yes» PUTs null, says the cost went back to the average, and reads again', async () => {
    confirmMock.mockResolvedValueOnce(false);
    show({ fixedCost: 6.75 });
    await press('امسح');
    expect(apiJson).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    await press('امسح');
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ amount: null });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(toast.done).toHaveBeenCalledWith('انمسحت التكلفة الثابتة — التكلفة رجعت متوسط المخزون.');
  });

  it('a new figure typed over the old one is just another PUT', async () => {
    show({ fixedCost: 6.75 });
    typeIn('7');
    await press('احفظ');
    await waitFor(() => expect(apiJson).toHaveBeenCalledTimes(1));
    expect(sentBody()).toEqual({ amount: 7 });
  });
});

describe('somebody who may not change it', () => {
  it('sees which cost the product has and gets no box and no button', () => {
    show({ fixedCost: 6.75, canChange: false });
    expect(screen.getByText('6.75 JOD')).toBeTruthy();
    expect(screen.queryByLabelText('التكلفة الثابتة')).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('…also when there is no figure: the sentence, the average, nothing to press', () => {
    show({ canChange: false });
    expect(screen.getByText(/بلا تكلفة ثابتة/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
