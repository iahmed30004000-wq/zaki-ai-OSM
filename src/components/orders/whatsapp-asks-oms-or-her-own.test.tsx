// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * «واتساب OMS» OR «واتساب الخارجي» (the owner, 27/11): on the orders list, the confirmation desk and «طلباتي», the WhatsApp
 * press asks which one. The OMS one opens the inbox on the order's conversation; the outside one is her own app with the
 * ready messages, exactly as before. Somebody who may not open the inbox — and any strip with no order behind it — gets
 * today's button with no question.
 */

const { apiJson, may } = vi.hoisted(() => ({ apiJson: vi.fn(), may: { inbox: true, send: false } }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('@/context/signed-in-user', () => ({ useSignedInUser: () => ({ id: 'u1' }) }));
vi.mock('@/lib/can', () => ({ userCan: (_u: unknown, p: string) => (p === 'whatsapp.view' ? may.inbox : p === 'whatsapp.send' ? may.send : false) }));

import { ContactButtons } from './ContactButtons';

const TEMPLATE = { id: 't1', name: 'تأكيد العنوان', channel: 'BOTH', active: true, body: 'مرحباً {اسم_الزبون}' };
const CONTEXT = { orderNumber: 'SY-2026-0002', customerName: 'أبو محمد', region: 'دمشق' };

let went: ReturnType<typeof vi.fn>;
let opened: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  may.inbox = true;
  may.send = false;
  apiJson.mockImplementation(async (url: string) =>
    url === '/api/whatsapp/conversations/for-order' || url === '/api/whatsapp/conversations/start' ? { id: 'conv-9' } : { templates: [TEMPLATE] }
  );
  went = vi.fn();
  opened = vi.fn(() => null);
  vi.stubGlobal('open', opened);
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign: went } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the WhatsApp press asks which WhatsApp', () => {
  it('«واتساب OMS» opens the inbox on the order’s conversation, and sends nothing itself', async () => {
    render(<ContactButtons phone="0952554562" countryCode="963" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    fireEvent.click(await screen.findByText('واتساب OMS'));
    await vi.waitFor(() => expect(went).toHaveBeenCalledWith('/growth/whatsapp/inbox?c=conv-9'));
    const call = apiJson.mock.calls.find(([u]) => u === '/api/whatsapp/conversations/for-order')!;
    expect(JSON.parse(String(call[1].body))).toEqual({ orderId: 'o1' });
    expect(opened).not.toHaveBeenCalled();
    // no contact line: the message she sends in the inbox is the contact
    expect(apiJson.mock.calls.some(([u]) => String(u).includes('contact-attempts'))).toBe(false);
  });

  it('«واتساب الخارجي» is her own app with the ready messages, as before', async () => {
    render(<ContactButtons phone="0952554562" countryCode="963" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    fireEvent.click(await screen.findByText('واتساب الخارجي'));
    fireEvent.click(await screen.findByText('تأكيد العنوان'));
    expect(new URL(String(opened.mock.calls[0][0])).pathname).toBe('/963952554562');
    expect(went).not.toHaveBeenCalled();
  });

  it('a refusal (the OMS number not connected) is said in the menu, and her own app is still there', async () => {
    apiJson.mockImplementation(async (url: string) => {
      if (url === '/api/whatsapp/conversations/for-order') throw new Error('واتساب الـOMS مش موصول لهلأ — استعملي واتسابك الخارجي.');
      return { templates: [TEMPLATE] };
    });
    render(<ContactButtons phone="0952554562" countryCode="963" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    fireEvent.click(await screen.findByText('واتساب OMS'));
    expect((await screen.findByRole('alert')).textContent).toContain('مش موصول');
    expect(screen.getByText('واتساب الخارجي')).toBeTruthy();
    expect(went).not.toHaveBeenCalled();
  });
});

describe('a customer’s own number, with no order (the customers screen, 27/11)', () => {
  it('asks too; «واتساب OMS» opens the thread of that number; «واتساب الخارجي» is her app on it, with no ready messages', async () => {
    may.send = true;
    render(<ContactButtons phone="0952554562" countryCode="963" plain omsChat context={{}} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    fireEvent.click(await screen.findByText('واتساب OMS'));
    await vi.waitFor(() => expect(went).toHaveBeenCalledWith('/growth/whatsapp/inbox?c=conv-9'));
    const call = apiJson.mock.calls.find(([u]) => u === '/api/whatsapp/conversations/start')!;
    expect(JSON.parse(String(call[1].body))).toEqual({ phone: '0952554562' });
  });

  it('«واتساب الخارجي» opens her WhatsApp on the number at once', async () => {
    may.send = true;
    render(<ContactButtons phone="0952554562" countryCode="963" plain omsChat context={{}} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    fireEvent.click(await screen.findByText('واتساب الخارجي'));
    expect(new URL(String(opened.mock.calls[0][0])).pathname).toBe('/963952554562');
  });

  it('without the send key, or on a courier’s number (no `omsChat`), it is her app at once, as before', async () => {
    may.send = false;
    render(<ContactButtons phone="0952554562" countryCode="963" plain omsChat context={{}} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    expect(opened).toHaveBeenCalledTimes(1);
    cleanup();
    may.send = true;
    render(<ContactButtons phone="0952554562" countryCode="963" plain context={{}} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    expect(opened).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('واتساب OMS')).toBeNull();
  });
});

describe('no question where there is no OMS to offer', () => {
  it('somebody who may not open the inbox goes straight to her own app', async () => {
    may.inbox = false;
    render(<ContactButtons phone="0952554562" countryCode="963" orderId="o1" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    expect(await screen.findByText('تأكيد العنوان')).toBeTruthy();
    expect(screen.queryByText('واتساب OMS')).toBeNull();
  });

  it('a strip with no order behind it goes straight to her own app', async () => {
    render(<ContactButtons phone="0952554562" countryCode="963" context={CONTEXT} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    expect(await screen.findByText('تأكيد العنوان')).toBeTruthy();
    expect(screen.queryByText('واتساب OMS')).toBeNull();
  });
});
