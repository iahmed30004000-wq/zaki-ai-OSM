// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A COURIER'S ACCOUNT IS DELETED ONLY AFTER THE QUESTION (22/10).
 *
 * «حذف الحساب» nulled the stored credentials at once. They are never shown back (the password goes in and never comes out), so they can
 * never be restored either: somebody has to type the account in again, and until then the company falls back to entering waybills by
 * hand. The bin asks first, names the company, and says what stops.
 */

const { apiJson, confirmMock } = vi.hoisted(() => ({ apiJson: vi.fn(), confirmMock: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmMock }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));
// The buttons ask «الإعدادات الحسّاسة» (RV168): these tests are about what they DO, so the person holds the key.
vi.mock('@/context/AppContext', () => ({
  useApp: () => ({ currentUser: { id: 'u0', role: 'COMPANY_ADMIN', permissions: ['settings.manage'], status: 'ACTIVE' } }),
}));

import { CourierCredentials } from './CourierCredentials';

const STATUS = {
  providerId: 'prov-1',
  name: 'شركة النور للتوصيل',
  adapterCode: 'nour',
  apiEnabled: true,
  encryptionAvailable: true,
  hasCredentials: true,
  readable: true,
  savedAt: '2026-10-01T00:00:00.000Z',
  savedBy: 'سارة',
  emailHint: 'a***@x.com',
  accountCompanyId: 12,
  senderName: 'متجرنا',
  originCityId: 1,
};

let sent: Array<{ url: string; method: string }>;

beforeEach(() => {
  sent = [];
  confirmMock.mockReset();
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    sent.push({ url, method: init?.method ?? 'GET' });
    if ((init?.method ?? 'GET') === 'GET') return STATUS;
    return { success: true };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const deletes = () => sent.filter((s) => s.method === 'DELETE');
const ready = async () => {
  render(<CourierCredentials providerId="prov-1" />);
  await screen.findByLabelText('حذف الحساب');
};
const press = () =>
  act(async () => {
    fireEvent.click(screen.getByLabelText('حذف الحساب'));
  });

describe('«حذف الحساب» asks before it deletes', () => {
  it('— once, in a danger dialog that names the courier and says it cannot be got back', async () => {
    confirmMock.mockResolvedValue(false);
    await ready();
    await press();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const asked = confirmMock.mock.calls[0][0] as { title: string; body: string; tone: string };
    expect(asked.tone).toBe('danger');
    expect(asked.title).toContain('شركة النور للتوصيل');
    expect(asked.body).toContain('يدويّة');
    expect(asked.body).toContain('لا يُسترجَع');
  });

  it('— and a «no» sends nothing at all', async () => {
    confirmMock.mockResolvedValue(false);
    await ready();
    await press();
    expect(deletes()).toEqual([]);
  });

  it('— and a «yes» sends the same DELETE it always sent, once', async () => {
    confirmMock.mockResolvedValue(true);
    await ready();
    await press();
    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(deletes()[0]).toEqual({ url: '/api/delivery-providers/prov-1/credentials', method: 'DELETE' });
  });
});
