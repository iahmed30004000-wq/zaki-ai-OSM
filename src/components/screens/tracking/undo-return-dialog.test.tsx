// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «تراجع عن المرتجع» (25/11) — THE SAME DIALOG, ASKED ABOUT THE OTHER MISTAKE.
 *
 * `UndoDeliveryDialog kind="return"`: it measures at the RETURN's door (never the delivery's), draws the server's sentences, needs the
 * reason and the tick, and sends back exactly the fingerprint it was shown. Without `kind` it is the delivery dialog, as it always was.
 */

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => api(...a), apiFetch: vi.fn() }));

import { UndoDeliveryDialog } from './UndoDeliveryDialog';
import { RETURN_UNDO_LINE_AR, RETURN_UNDO_STAYS_AR, RETURN_UNDO_WHY_AR, type ReturnUndoMeasure } from '@/lib/return-undo-words';

const ID = '11111111-1111-4111-8111-111111111111';
const ORDER = { id: ID, orderNumber: 'ORD-2026-0001', merchantRef: null };
const REASON = 'انسجّل مرتجع بالغلط — الشركة بتقول تم توصيلها';

const measureOf = (over: Partial<ReturnUndoMeasure> = {}): ReturnUndoMeasure => ({
  orderNumber: 'ORD-2026-0001',
  courier: 'الباشا',
  allowed: true,
  refusal: null,
  fingerprint: 'b'.repeat(24),
  from: 'RETURNED',
  to: 'SHIPPED',
  lines: [
    { key: 'STATUS', text: RETURN_UNDO_LINE_AR.status('مرتجع', 'مشحون', true) },
    { key: 'CUSTOMER', text: RETURN_UNDO_LINE_AR.customer(1, 2) },
  ],
  stays: [
    { key: 'STOCK', text: RETURN_UNDO_STAYS_AR.stock },
    { key: 'STATEMENT', text: RETURN_UNDO_STAYS_AR.statement },
  ],
  ...over,
});

let onDone: (m: string) => void;
beforeEach(() => {
  vi.clearAllMocks();
  onDone = vi.fn();
  api.mockImplementation(async (_url: string, init?: { body: string }) => {
    const body = JSON.parse(init?.body ?? '{}') as { action: string };
    if (body.action === 'undo') return { undone: true, message: 'اتراجع عن مرتجع الطلب ORD-2026-0001 — رجع «مشحون»' };
    return measureOf();
  });
});
afterEach(() => cleanup());

const open = async () => {
  render(<UndoDeliveryDialog kind="return" order={ORDER} onClose={() => {}} onDone={onDone} />);
  await screen.findByText('اللي رح يرجع:');
};

describe('the return’s dialog', () => {
  it('asks the RETURN’s door, and draws its title and the server’s sentences', async () => {
    await open();
    expect(api.mock.calls[0][0]).toBe('/api/ops/tracking/undo-return');
    expect(screen.getAllByText('تراجع عن المرتجع').length).toBeGreaterThan(0);
    expect(screen.getByText(RETURN_UNDO_LINE_AR.status('مرتجع', 'مشحون', true))).toBeTruthy();
    expect(screen.getByText(RETURN_UNDO_STAYS_AR.statement)).toBeTruthy();
  });

  it('the press needs the reason AND the tick, and sends back exactly what was shown — to the return’s door', async () => {
    await open();
    const press = () => screen.getByRole('button', { name: 'تراجع عن المرتجع' }) as HTMLButtonElement;
    expect(press().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('سبب التراجع *'), { target: { value: REASON } });
    expect(press().disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(press().disabled).toBe(false);
    fireEvent.click(press());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('اتراجع عن مرتجع الطلب ORD-2026-0001 — رجع «مشحون»'));
    const undo = api.mock.calls.find((c) => JSON.parse((c[1] as { body: string }).body).action === 'undo')!;
    expect(undo[0]).toBe('/api/ops/tracking/undo-return');
    expect(JSON.parse((undo[1] as { body: string }).body)).toEqual({ action: 'undo', orderId: ID, reason: REASON, fingerprint: 'b'.repeat(24), acknowledged: true });
  });

  it('a refusal is drawn in the door’s words, with nothing to press', async () => {
    api.mockResolvedValue(measureOf({ allowed: false, refusal: { code: 'RETURN_COUNTED', text: RETURN_UNDO_WHY_AR.returnCounted }, fingerprint: null, to: null, lines: [], stays: [] }));
    render(<UndoDeliveryDialog kind="return" order={ORDER} onClose={() => {}} onDone={onDone} />);
    expect(await screen.findByText(RETURN_UNDO_WHY_AR.returnCounted)).toBeTruthy();
    expect(screen.getByText('ما بيتراجع عن هالمرتجع:')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'تراجع عن المرتجع' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('without `kind` it is the delivery dialog, at the delivery’s door', async () => {
    render(<UndoDeliveryDialog order={ORDER} onClose={() => {}} onDone={onDone} />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(api.mock.calls[0][0]).toBe('/api/ops/tracking/undo-delivery');
    expect(screen.getAllByText('تراجع عن التسليم').length).toBeGreaterThan(0);
  });
});
