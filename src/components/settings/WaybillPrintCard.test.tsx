// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LOCKED_REASON, WAYBILL_ELEMENTS } from '@/lib/waybill-print-settings';

/**
 * «البوليصة المطبوعة» ON SCREEN (25/11, F15): every part as a tick box in print order, the courier's five ticked and
 * locked with the reason, «حفظ» sends exactly what is unticked, the preview is a frame that runs no script, and a
 * person without `geo.manage` sees the choice but cannot change it.
 */

const { apiJson, apiFetch } = vi.hoisted(() => ({ apiJson: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiJson: (...a: unknown[]) => apiJson(...a),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  saidBy: async () => 'تعذّرت المعاينة',
}));

import { WaybillPrintCard } from './WaybillPrintCard';

const STORE = '11111111-1111-4111-8111-111111111111';
const loaded = (over: Record<string, unknown> = {}) => ({
  settings: { hide: ['note'], logo: 'store' },
  ownLogo: null,
  storeLogo: '/api/public/store-logo/x/y.webp',
  elements: WAYBILL_ELEMENTS,
  lockedReason: LOCKED_REASON,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockImplementation(async (url: string, init?: RequestInit) =>
    init?.method === 'PUT' ? { settings: JSON.parse(String(init.body)) } : loaded()
  );
  apiFetch.mockResolvedValue(new Response('<!DOCTYPE html><p>ورقة</p>', { status: 200 }));
});
afterEach(cleanup);

const box = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('the card', () => {
  it('draws every part in print order; the courier’s five are ticked, locked and say why', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    const names = screen.getAllByRole('checkbox').map((c) => (c as HTMLInputElement).labels?.[0]?.textContent?.trim());
    expect(names).toEqual(WAYBILL_ELEMENTS.map((e) => e.ar));
    for (const e of WAYBILL_ELEMENTS.filter((x) => x.locked)) {
      expect(box(e.ar).checked, e.ar).toBe(true);
      expect(box(e.ar).disabled, e.ar).toBe(true);
    }
    expect(screen.getAllByText(LOCKED_REASON)).toHaveLength(5);
    // The saved choice: the note is off, everything else on.
    expect(box('ملاحظة الزبون').checked).toBe(false);
    expect(box('رمز QR لرقم الطلب').checked).toBe(true);
  });

  it('«حفظ» sends exactly the unticked parts and the logo, to this store’s door', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    fireEvent.click(box('رمز QR لرقم الطلب'));
    fireEvent.click(screen.getByRole('radio', { name: 'بلا شعار' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith(`/api/geo/stores/${STORE}/waybill`, expect.objectContaining({ method: 'PUT' })));
    const sent = JSON.parse(apiJson.mock.calls.find((c) => c[1]?.method === 'PUT')![1].body);
    expect(sent).toEqual({ hide: ['note', 'qr'], logo: 'none' });
  });

  it('the preview is the door’s page in a frame with no script, asked again when a part changes', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    const frame = (await screen.findByTitle('معاينة البوليصة')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('ورقة');
    const before = apiFetch.mock.calls.length;
    fireEvent.click(box('اسم المتجر'));
    await waitFor(() => expect(apiFetch.mock.calls.length).toBeGreaterThan(before));
    const last = JSON.parse(apiFetch.mock.calls.at(-1)![1].body);
    expect(last.hide).toEqual(['note', 'storeName']);
    expect(apiFetch.mock.calls.at(-1)![0]).toBe(`/api/geo/stores/${STORE}/waybill/preview`);
  });

  it('NEGATIVE: without geo.manage — every box disabled, no save, no upload', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage={false} />);
    await screen.findByText('البوليصة المطبوعة');
    for (const c of screen.getAllByRole('checkbox')) expect((c as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'حفظ' })).toBeNull();
    expect(screen.queryByText('شعار البوليصة')).toBeNull();
  });

  it('NEGATIVE: «شعار خاص» cannot be picked before one is uploaded', async () => {
    render(<WaybillPrintCard storeId={STORE} mayManage />);
    await screen.findByText('البوليصة المطبوعة');
    expect((screen.getByRole('radio', { name: 'شعار خاص' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
