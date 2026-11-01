// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «شامل التوصيل» ON THE ORDER SHEET — the box from the form, until the parcel leaves (the owner, 1/11)
 *
 *  · the box shows what the order is, and says what each state means;
 *  · pressing it asks the door a `dryRun` first, shows the person BOTH figures, and writes only after her press — no amount is
 *    worked out on the screen;
 *  · «لا» writes nothing and leaves the box as it was; a refusal of the door is said in the door's own words and changes nothing;
 *  · it is offered only while the order can still be told apart from the parcel (`mayTellDelivery`): she may change the fee, the
 *    parcel has not been handed over, no waybill is printed, no courier barcode, and the order is not cancelled or rejected.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { apiJson, confirm, toast } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  confirm: vi.fn(),
  toast: { done: vi.fn(), failed: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a), apiFetch: vi.fn() }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => (...a: unknown[]) => confirm(...a) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => toast }));

import { DeliveryIncludedBox, mayTellDelivery } from './DeliveryIncludedBox';

const USD = { code: 'USD', minorUnit: 2 };
const onChanged = vi.fn();

const mount = (included: boolean) =>
  render(<DeliveryIncludedBox orderId="o1" version={3} included={included} currency={USD} onChanged={onChanged} />);
const box = () => screen.getByRole('checkbox', { name: /شامل التوصيل/ }) as HTMLInputElement;
const posts = () => apiJson.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body) as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (_url: string, init: { body: string }) => {
    const b = JSON.parse(init.body);
    return b.dryRun ? { dryRun: true, totalBefore: 23, totalAfter: 20, delta: -3 } : { changed: true, totalBefore: 23, totalAfter: 20 };
  });
  confirm.mockResolvedValue(true);
});
afterEach(cleanup);

describe('the box', () => {
  it('shows what the order is, and says what that means', () => {
    mount(false);
    expect(box().checked).toBe(false);
    expect(screen.getByText('بينضاف توصيل على الزبون لما تنعمل الشحنة.')).toBeTruthy();
    cleanup();
    mount(true);
    expect(box().checked).toBe(true);
    expect(screen.getByText('الزبون بيدفع سعر الطلب بس، وأجرة التوصيل على المتجر.')).toBeTruthy();
  });

  it('pressing it asks the door a dry run first, shows both figures, and writes only after the press', async () => {
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posts()).toEqual([
      { included: true, expectedVersion: 3, dryRun: true },
      { included: true, expectedVersion: 3 },
    ]);
    expect(apiJson.mock.calls[0][0]).toBe('/api/orders/o1/delivery-included');
    const asked = confirm.mock.calls[0][0] as { title: string; body: string; confirmLabel: string };
    expect(asked.body).toContain('20.00 USD');
    expect(asked.body).toContain('23.00 USD');
    expect(asked.body).toContain('بدل');
    expect(toast.done).toHaveBeenCalledTimes(1);
    // the dry run was asked BEFORE the confirmation, the write AFTER it
    expect(apiJson.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
    expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(apiJson.mock.invocationCallOrder[1]);
  });

  it('«لا»: nothing is written, the page is not reloaded, and the box stays what the order is', async () => {
    confirm.mockResolvedValue(false);
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(posts()).toEqual([{ included: true, expectedVersion: 3, dryRun: true }]);
    expect(onChanged).not.toHaveBeenCalled();
    expect(box().checked).toBe(false);
  });

  it('the door’s refusal is said in its own words, nothing is changed, and the sheet is reloaded so a second try has the new version', async () => {
    apiJson.mockRejectedValue(Object.assign(new Error('بوليصة الطلب طُبعت ولُصقت على الطرد.'), { status: 409 }));
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('بوليصة الطلب طُبعت ولُصقت على الطرد.'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
    // One call only: the refused dry run. Nothing was written.
    expect(posts()).toEqual([{ included: true, expectedVersion: 3, dryRun: true }]);
    expect(box().checked).toBe(false);
  });

  it('a reload that fails too changes nothing more: the box is usable again and no error escapes', async () => {
    apiJson.mockRejectedValue(new Error('الطلب تغيّر من حدا تاني.'));
    onChanged.mockRejectedValueOnce(new Error('offline'));
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(toast.failed).toHaveBeenCalledWith('الطلب تغيّر من حدا تاني.'));
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(toast.failed).toHaveBeenCalledTimes(1);
  });

  it('«لا» at the question does not reload anything (only a refusal does)', async () => {
    confirm.mockResolvedValue(false);
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    await waitFor(() => expect(box().disabled).toBe(false));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('taking it back: unticking asks the other way, and the sentence says the fee is added again', async () => {
    apiJson.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).dryRun ? { dryRun: true, totalBefore: 20, totalAfter: 23, delta: 3 } : { changed: true }
    );
    mount(true);
    fireEvent.click(box());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(posts()[0]).toEqual({ included: false, expectedVersion: 3, dryRun: true });
    const asked = confirm.mock.calls[0][0] as { title: string; body: string; tone?: string };
    expect(asked.title).toContain('يتضاف على الزبون');
    expect(asked.body).toContain('23.00 USD');
    expect(asked.tone).toBe('danger');
  });

  it('when the total does not move yet (no fee priced) and the box is being TICKED: it says the fee will not be added at the shipment', async () => {
    apiJson.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).dryRun ? { dryRun: true, totalBefore: 20, totalAfter: 20, delta: 0 } : { changed: true }
    );
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const body = (confirm.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain('المبلغ ما بيتغيّر هلّق');
    expect(body).toContain('ما رح تنضاف أجرة التوصيل');
  });

  it('and when it is being UNTICKED with no fee priced: it says the fee will be added at the shipment (the other direction, its own sentence)', async () => {
    apiJson.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).dryRun ? { dryRun: true, totalBefore: 20, totalAfter: 20, delta: 0 } : { changed: true }
    );
    mount(true);
    fireEvent.click(box());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const body = (confirm.mock.calls[0][0] as { body: string }).body;
    expect(body).toContain('المبلغ ما بيتغيّر هلّق');
    expect(body).toContain('بتنضاف أجرة التوصيل عليه');
    expect(body).not.toContain('ما رح تنضاف');
  });

  it('an order on a shipping trolley is told to export and print again; one that is not, is not', async () => {
    apiJson.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).dryRun ? { dryRun: true, totalBefore: 23, totalAfter: 20, delta: -3, inBatch: true } : { changed: true }
    );
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect((confirm.mock.calls[0][0] as { body: string }).body).toContain('أعد التصدير والطباعة');

    cleanup();
    vi.clearAllMocks();
    confirm.mockResolvedValue(true);
    apiJson.mockImplementation(async (_u: string, init: { body: string }) =>
      JSON.parse(init.body).dryRun ? { dryRun: true, totalBefore: 23, totalAfter: 20, delta: -3, inBatch: false } : { changed: true }
    );
    mount(false);
    fireEvent.click(box());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect((confirm.mock.calls[0][0] as { body: string }).body).not.toContain('أعد التصدير');
  });
});

describe('who is offered it, and while', () => {
  const open = { confirmationStatus: 'CONFIRMED', labelPrintedAt: null, trackingNumber: null };

  it('an open order, for somebody who may change the fee', () => {
    expect(mayTellDelivery(open, true, false)).toBe(true);
    expect(mayTellDelivery({ ...open, confirmationStatus: 'NEW' }, true, false)).toBe(true);
  });

  it('NEGATIVE: without the fee key, after the hand-over, with a printed waybill, with the courier’s barcode, and for an ended order — never', () => {
    expect(mayTellDelivery(open, false, false)).toBe(false);
    expect(mayTellDelivery(open, true, true)).toBe(false);
    expect(mayTellDelivery({ ...open, labelPrintedAt: '2026-11-01T10:00:00Z' }, true, false)).toBe(false);
    expect(mayTellDelivery({ ...open, trackingNumber: 'KSA100422577363' }, true, false)).toBe(false);
    expect(mayTellDelivery({ ...open, confirmationStatus: 'CANCELLED' }, true, false)).toBe(false);
    expect(mayTellDelivery({ ...open, confirmationStatus: 'REJECTED' }, true, false)).toBe(false);
  });
});
