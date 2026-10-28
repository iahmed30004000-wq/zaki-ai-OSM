// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * THE COURIER'S ACCOUNT CARD SAYS ONLY WHAT IS KNOWN.
 *
 * «الحساب سليم — الشحنات تُنشأ آلياً» was shown whenever the account was saved and could be decrypted. It never asked the
 * courier. The card now says what is known (saved, encrypted, not yet tried), and once «اختبر الاتصال» has answered it shows
 * that answer and nothing sweeter.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn() }) }));

import { CourierCredentials } from './CourierCredentials';

const STATUS = {
  providerId: 'prov-1', name: 'الباشا', adapterCode: 'LOGESTECHS', apiEnabled: true, encryptionAvailable: true,
  hasCredentials: true, readable: true, savedAt: '2026-10-01T00:00:00.000Z', savedBy: 'سارة', emailHint: 'a***@x.com',
  accountCompanyId: 744, senderName: 'متجرنا', originCityId: 445053,
};

let testAnswer: { ok: boolean; message: string };

beforeEach(() => {
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) =>
    String(url).endsWith('/credentials/test') && init?.method === 'POST' ? testAnswer : STATUS,
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const open = async () => {
  render(<CourierCredentials providerId="prov-1" />);
  await screen.findByText(/حساب الباشا على/);
};

describe('the card before any test', () => {
  it('says the account is saved and encrypted, and that it has not been tried — never that it is sound', async () => {
    await open();
    expect(screen.getByText('الحساب محفوظ ومشفّر — لم يُفحص مع الشركة بعد.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('الحساب سليم');
    expect(document.body.textContent).not.toContain('تُنشأ آلياً');
  });

  it('NEGATIVE: an account that cannot be read back says so, and offers no comfort line', async () => {
    apiJson.mockImplementation(async () => ({ ...STATUS, readable: false }));
    await open();
    expect(screen.queryByText('الحساب محفوظ ومشفّر — لم يُفحص مع الشركة بعد.')).toBeNull();
    expect(screen.getByText(/لا يمكن فكّ تشفيره/)).toBeTruthy();
  });
});

describe('the card after «اختبر الاتصال»', () => {
  const press = () =>
    act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /اختبر الاتصال/ }));
    });

  it('shows the test’s answer, which says what it proved, and drops the “not tried” line', async () => {
    testAnswer = { ok: true, message: 'وصلنا للشركة خلال 120ms ورقم الشركة مقبول. كلمة المرور تُفحص عند أول ترحيل.' };
    await open();
    await press();
    expect(screen.getByText(testAnswer.message)).toBeTruthy();
    expect(screen.queryByText('الحساب محفوظ ومشفّر — لم يُفحص مع الشركة بعد.')).toBeNull();
    expect(document.body.textContent).not.toContain('الحساب سليم');
  });

  it('shows the courier’s own words when it refused', async () => {
    testAnswer = { ok: false, message: 'ردّت الشركة برفض (400): رقم تعريف الشركة غير صحيح' };
    await open();
    await press();
    expect(screen.getByText(testAnswer.message)).toBeTruthy();
    expect(document.body.textContent).not.toContain('الحساب سليم');
  });
});
