// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «ابعت واتساب» on the call sheet: AGENT is exactly today's button; COMPANY is one press from the company's number, and a
 * refusal puts her own WhatsApp back under the reason.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { WhatsAppAfterNoAnswer } from './WhatsAppAfterNoAnswer';
import { ContactButtons } from '@/components/orders/ContactButtons';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const agentButton = (
  <ContactButtons only="WHATSAPP" preferApp phone="0791234567" countryCode="962" context={{ orderNumber: 'ORD-1', customerName: 'سارة' }} orderId="o1" />
);

const sheet = (fromCompany: boolean) =>
  render(
    <WhatsAppAfterNoAnswer fromCompany={fromCompany} orderId="o1">
      {agentButton}
    </WhatsAppAfterNoAnswer>
  );

describe('AGENT — what renders today', () => {
  it('is the contact strip’s own WhatsApp button and nothing else', () => {
    sheet(false);
    expect(screen.getByTitle('واتساب')).toBeTruthy();
    expect(screen.queryByText('ابعت من رقم الشركة')).toBeNull();
    expect(apiJson).not.toHaveBeenCalled();
  });
});

describe('COMPANY', () => {
  it('offers «ابعت من رقم الشركة» and not her own button until it is needed', () => {
    sheet(true);
    expect(screen.getByRole('button', { name: /ابعت من رقم الشركة/ })).toBeTruthy();
    expect(screen.queryByTitle('واتساب')).toBeNull();
  });

  it('a press sends the order id alone, and says it went', async () => {
    apiJson.mockResolvedValueOnce({ ok: true, logged: true });
    sheet(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /ابعت من رقم الشركة/ }));
    });
    expect(apiJson).toHaveBeenCalledWith('/api/confirmation/whatsapp-template', expect.objectContaining({ method: 'POST', body: JSON.stringify({ orderId: 'o1' }) }));
    expect(screen.getByText('انبعت من رقم الشركة')).toBeTruthy();
    expect(screen.queryByText(/ما انسجّلت/)).toBeNull();
  });

  it('a refusal says why in one line and puts her own WhatsApp under it', async () => {
    apiJson.mockRejectedValueOnce(new Error('رقم الشركة مش موصول لهلأ — ابعتي من واتسابك.'));
    sheet(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /ابعت من رقم الشركة/ }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/مش موصول/);
    expect(screen.getByText('ابعت من واتساب')).toBeTruthy();
    expect(screen.getByTitle('واتساب')).toBeTruthy();
  });

  it('an English failure is not shown to her — a plain Arabic line is', async () => {
    apiJson.mockRejectedValueOnce(new Error('HTTP 502'));
    sheet(true);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /ابعت من رقم الشركة/ }));
    });
    expect(screen.getByRole('alert').textContent).not.toMatch(/HTTP/);
    expect(screen.getByTitle('واتساب')).toBeTruthy();
  });
});
