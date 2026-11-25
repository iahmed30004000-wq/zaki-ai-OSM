// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «تراجع عن إقفال القديمة» (25/11) — THE SAME DIALOG, ASKED ABOUT THE NO-MONEY CLOSE.
 *
 * `UndoDeliveryDialog kind="legacy"`: it measures at the close's take-back door (never the delivery's or the return's), draws the
 * server's sentences, needs the reason and the tick, and sends back exactly the fingerprint it was shown.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { UndoDeliveryDialog } from './UndoDeliveryDialog';
import { TAKE_BACK_LINE_AR, TAKE_BACK_STAYS_AR, TAKE_BACK_WHY_AR, type TakeBackMeasure } from '@/lib/legacy-take-back-words';

const ID = '11111111-1111-4111-8111-111111111111';
const ORDER = { id: ID, orderNumber: 'ORD-2026-0001', merchantRef: null };
const REASON = 'الشركة بتقول الطرد رجع — سطرو بالكشف بصفر';
const DOOR = '/api/ops/tracking/undo-legacy-close';

const measureOf = (over: Partial<TakeBackMeasure> = {}): TakeBackMeasure => ({
  orderNumber: 'ORD-2026-0001',
  courier: 'الباشا',
  allowed: true,
  refusal: null,
  fingerprint: 'c'.repeat(24),
  from: 'SETTLED',
  to: 'PENDING_COLLECTION',
  lines: [
    { key: 'SETTLEMENT', text: TAKE_BACK_LINE_AR.settlement('مسوّى', 'لم يُحصَّل') },
    { key: 'MARK', text: TAKE_BACK_LINE_AR.mark },
    { key: 'NEXT', text: TAKE_BACK_LINE_AR.next },
  ],
  stays: [
    { key: 'MONEY', text: TAKE_BACK_STAYS_AR.money },
    { key: 'STOCK', text: TAKE_BACK_STAYS_AR.stock },
  ],
  ...over,
});

let onDone: (m: string) => void;
beforeEach(() => {
  vi.clearAllMocks();
  onDone = vi.fn();
  api.mockImplementation(async (_url: string, init?: { body: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { action: string };
    if (body.action === 'undo') return { undone: true, message: 'رجعت تسوية الطلب ORD-2026-0001 لـ«لم يُحصَّل»' };
    return measureOf();
  });
});
afterEach(() => cleanup());

const open = async () => {
  render(<UndoDeliveryDialog kind="legacy" order={ORDER} onClose={() => {}} onDone={onDone} />);
  await screen.findByText('اللي رح يرجع:');
};

describe('the close’s dialog', () => {
  it('asks the take-back’s door, and draws its title and the server’s sentences', async () => {
    await open();
    expect(api.mock.calls[0][0]).toBe(DOOR);
    expect(screen.getAllByText('تراجع عن الإقفال').length).toBeGreaterThan(0);
    expect(screen.getByText(TAKE_BACK_LINE_AR.settlement('مسوّى', 'لم يُحصَّل'))).toBeTruthy();
    expect(screen.getByText(TAKE_BACK_LINE_AR.next)).toBeTruthy();
    expect(screen.getByText(TAKE_BACK_STAYS_AR.money)).toBeTruthy();
  });

  it('the press needs the reason AND the tick, and sends back exactly what was shown — to the take-back’s door', async () => {
    await open();
    const press = () => screen.getByRole('button', { name: 'تراجع عن الإقفال' }) as HTMLButtonElement;
    expect(press().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('سبب التراجع *'), { target: { value: REASON } });
    expect(press().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(press().disabled).toBe(false);
    fireEvent.click(press());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('رجعت تسوية الطلب ORD-2026-0001 لـ«لم يُحصَّل»'));
    const undo = api.mock.calls.find((c) => JSON.parse((c[1] as { body: string }).body).action === 'undo')!;
    expect(undo[0]).toBe(DOOR);
    expect(JSON.parse((undo[1] as { body: string }).body)).toEqual({ action: 'undo', orderId: ID, reason: REASON, fingerprint: 'c'.repeat(24), acknowledged: true });
  });

  it('a refusal is drawn in the door’s words, with nothing to press', async () => {
    api.mockResolvedValue(measureOf({ allowed: false, refusal: { code: 'MONEY_RECORDED', text: TAKE_BACK_WHY_AR.manualCollection }, fingerprint: null, to: null, lines: [], stays: [] }));
    render(<UndoDeliveryDialog kind="legacy" order={ORDER} onClose={() => {}} onDone={onDone} />);
    expect(await screen.findByText(TAKE_BACK_WHY_AR.manualCollection)).toBeTruthy();
    expect(screen.getByText('ما بيرجع هالإقفال:')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'تراجع عن الإقفال' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refusal to the press is said, and the measure is read again', async () => {
    await open();
    api.mockImplementation(async (_url: string, init?: { body: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { action: string };
      if (body.action === 'undo') throw new Error(TAKE_BACK_WHY_AR.alreadyTakenBack('لم يُحصَّل'));
      return measureOf();
    });
    fireEvent.change(screen.getByLabelText('سبب التراجع *'), { target: { value: REASON } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'تراجع عن الإقفال' }));
    expect(await screen.findByText(TAKE_BACK_WHY_AR.alreadyTakenBack('لم يُحصَّل'))).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
    await waitFor(() => expect(api.mock.calls.filter((c) => JSON.parse((c[1] as { body: string }).body).action === 'measure').length).toBe(2));
  });
});
