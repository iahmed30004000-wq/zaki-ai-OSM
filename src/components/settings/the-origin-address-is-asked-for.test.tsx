// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * THE SCREENS SAY WHAT THE COURIER WILL REFUSE, BEFORE AND AFTER THE PRESS.
 *
 * Before: the account form asks for «عنوان الانطلاق» as a required box on a LogesTechs courier — it was unstarred and
 * optional, and the courier refused all 131 parcels of BATCH-2026-0006 without it (2/11). After: the dispatch answer
 * shows the account sentence once for the whole batch, and the order sentence for an order with no address — through
 * the one component both dispatch screens draw.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u0', role: 'COMPANY_ADMIN', permissions: ['settings.manage'], status: 'ACTIVE' } }),
}));

import { CourierCredentials } from './CourierCredentials';
import { DispatchResult } from '@/components/ops/DispatchResult';
import type { DispatchSummary } from '@/lib/couriers/dispatch';

const STATUS = {
  providerId: 'prov-1', name: 'الباشا', adapterCode: 'LOGESTECHS', apiEnabled: true, encryptionAvailable: true,
  hasCredentials: true, readable: true, savedAt: '2026-10-01T00:00:00.000Z', savedBy: 'سارة', emailHint: 'a***@x.com',
  accountCompanyId: 744, senderName: 'متجرنا', originCityId: 445053,
};

let status: typeof STATUS;

beforeEach(() => {
  status = { ...STATUS };
  apiJson.mockImplementation(async () => status);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const openForm = async () => {
  render(<CourierCredentials providerId="prov-1" />);
  await screen.findByText(/حساب الباشا على/);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /تغيير الحساب/ }));
  });
};

describe('the account form', () => {
  it('on LogesTechs, «عنوان الانطلاق *» is a required box that refuses spaces only', async () => {
    await openForm();
    const box = screen.getByLabelText('عنوان الانطلاق *') as HTMLInputElement;
    expect(box.required).toBe(true);
    expect(new RegExp(`^(?:${box.pattern})$`).test('   ')).toBe(false);
    expect(new RegExp(`^(?:${box.pattern})$`).test(' دمشق ')).toBe(true);
    expect(box.title).toBe('عنوان الانطلاق مطلوب — الشركة بترفض كل طرد بدونه');
  });

  it('NEGATIVE: on another platform the box stays optional, as before', async () => {
    status = { ...STATUS, adapterCode: 'MANUAL' };
    await openForm();
    const box = screen.getByLabelText('عنوان الانطلاق') as HTMLInputElement;
    expect(box.required).toBe(false);
    expect(screen.queryByLabelText('عنوان الانطلاق *')).toBeNull();
  });
});

describe('the dispatch answer', () => {
  const outcome = (n: number, skipped: 'NO_ORIGIN_ADDRESS' | 'NO_ADDRESS') => ({
    orderId: `o${n}`, orderNumber: `ORD-2026-${String(n).padStart(4, '0')}`, ok: false, skipped,
  });

  it('a batch stopped for the account shows ONE line with the account sentence and the count', () => {
    const outcomes = Array.from({ length: 131 }, (_, i) => outcome(i + 1, 'NO_ORIGIN_ADDRESS'));
    const summary: DispatchSummary = { sent: 0, skipped: 131, failed: 0, outcomes };
    render(<DispatchResult summary={summary} savedNote="" />);
    expect(document.body.textContent).toContain('رُحّل 0 · تُخطّي 131');
    const lines = screen.getAllByText(/عنوان الانطلاق فاضي بحساب الشركة/);
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe('131 طلب — عنوان الانطلاق فاضي بحساب الشركة — اضغط «تغيير الحساب» واكتبه، الشركة بترفض الطرد بدونه');
    expect(document.body.textContent).not.toContain('addressLine1');
  });

  it('an order with no address says so by itself, beside the ones that went', () => {
    const summary: DispatchSummary = {
      sent: 1, skipped: 1, failed: 0,
      outcomes: [outcome(1, 'NO_ADDRESS'), { orderId: 'o2', orderNumber: 'ORD-2026-0002', ok: true, trackingNumber: 'BC-1' }],
    };
    render(<DispatchResult summary={summary} savedNote="حُفظ" />);
    expect(screen.getByText('1 طلب — الطلب بلا عنوان — اكتب العنوان بالطلب وأعد الترحيل')).toBeTruthy();
  });
});
