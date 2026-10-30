// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * WHATSAPP NEVER OPENS A STRANGER'S CHAT.
 *
 * «0952554562» with no country code was handed to wa.me as it was; WhatsApp dropped the zero and read «95…» as
 * Myanmar. The strip now opens the chat only for a number it can make international, and otherwise shuts the
 * button and says why. The message (name, product, address) is not changed by any of this.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { ContactButtons } from './ContactButtons';

const TEMPLATE = { id: 't1', name: 'تأكيد العنوان', channel: 'BOTH', active: true, body: 'مرحباً {اسم_الزبون}، نريد تأكيد العنوان {المحافظة}' };
const CONTEXT = { orderNumber: 'SY-2026-0002', customerName: 'أبو محمد', region: 'دمشق' };

let opened: ReturnType<typeof vi.fn<(url?: string | URL, target?: string, features?: string) => null>>;

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockResolvedValue({ templates: [TEMPLATE] });
  opened = vi.fn<(url?: string | URL, target?: string, features?: string) => null>(() => null);
  vi.stubGlobal('open', opened);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The link WhatsApp was sent to after picking the template, or null if nothing opened. */
async function pressWhatsappAndPickTemplate(): Promise<string | null> {
  fireEvent.click(screen.getByTitle('واتساب'));
  fireEvent.click(await screen.findByText('تأكيد العنوان'));
  const first = opened.mock.calls[0];
  return first ? String(first[0]) : null;
}

describe('with the country', () => {
  it('Syria 963: the chat opens on +963 952 554 562, with the message', async () => {
    render(<ContactButtons phone="0952554562" countryCode="963" orderId="o1" context={CONTEXT} />);
    const url = await pressWhatsappAndPickTemplate();
    expect(url).toBeTruthy();
    const link = new URL(url!);
    expect(link.pathname).toBe('/963952554562');
    expect(link.searchParams.get('text')).toBe('مرحباً أبو محمد، نريد تأكيد العنوان دمشق');
  });

  it('Jordan 962: 0791234567 opens on 962791234567', async () => {
    render(<ContactButtons phone="0791234567" countryCode="962" orderId="o1" context={CONTEXT} />);
    const url = await pressWhatsappAndPickTemplate();
    expect(new URL(url!).pathname).toBe('/962791234567');
  });

  it('a full international number opens as it is, with or without a country', async () => {
    render(<ContactButtons phone="905321234567" orderId="o1" context={CONTEXT} />);
    const url = await pressWhatsappAndPickTemplate();
    expect(new URL(url!).pathname).toBe('/905321234567');
  });

  it('«00…» opens too, with no country', async () => {
    render(<ContactButtons phone="00905321234567" orderId="o1" context={CONTEXT} />);
    const url = await pressWhatsappAndPickTemplate();
    expect(new URL(url!).pathname).toBe('/905321234567');
  });

  it('a number that already starts with the country is not doubled', async () => {
    render(<ContactButtons phone="963952554562" countryCode="963" orderId="o1" context={CONTEXT} />);
    const url = await pressWhatsappAndPickTemplate();
    expect(new URL(url!).pathname).toBe('/963952554562');
  });

  it('the plain strip (a courier) opens on the full number', () => {
    render(<ContactButtons phone="0952554562" countryCode="963" plain context={{}} />);
    fireEvent.click(screen.getByTitle('واتساب'));
    expect(opened).toHaveBeenCalledWith('https://wa.me/963952554562', '_blank', 'noopener');
  });
});

describe('without the country', () => {
  it('a local number: the button is shut, says why, and opens nothing', () => {
    render(<ContactButtons phone="0952554562" orderId="o1" context={CONTEXT} />);
    const shut = screen.getByTitle('رمز الدولة ناقص') as HTMLButtonElement;
    expect(shut.disabled).toBe(true);
    expect(screen.getByText('رمز الدولة ناقص'), 'السبب مكتوب بجانب الزر').toBeTruthy();
    expect(screen.queryByTitle('واتساب'), 'زر واتساب الشغّال ما لازم يظهر').toBeNull();
    fireEvent.click(shut);
    expect(opened).not.toHaveBeenCalled();
  });

  it('and the call is still open — the number can be rung', () => {
    render(<ContactButtons phone="0952554562" orderId="o1" context={CONTEXT} />);
    expect(screen.getByTitle('اتصال').getAttribute('href')).toBe('tel:0952554562');
  });

  it('the plain strip shuts it too', () => {
    render(<ContactButtons phone="0952554562" plain context={{}} />);
    fireEvent.click(screen.getByTitle('رمز الدولة ناقص'));
    expect(opened).not.toHaveBeenCalled();
  });

  it('the compact strip shuts it without a sentence (no room), and keeps the reason as its name', () => {
    render(<ContactButtons phone="0952554562" compact orderId="o1" context={CONTEXT} />);
    const shut = screen.getByLabelText('رمز الدولة ناقص') as HTMLButtonElement;
    expect(shut.disabled).toBe(true);
    expect(screen.queryByText('رمز الدولة ناقص')).toBeNull();
  });

  it('a null country is the same as none', () => {
    render(<ContactButtons phone="0791234567" countryCode={null} orderId="o1" context={CONTEXT} />);
    expect((screen.getByTitle('رمز الدولة ناقص') as HTMLButtonElement).disabled).toBe(true);
  });
});
