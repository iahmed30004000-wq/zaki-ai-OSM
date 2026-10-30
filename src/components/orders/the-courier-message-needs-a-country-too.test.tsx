// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';

/**
 * THE MESSAGE TO THE COURIER'S OFFICE NEEDS THE COUNTRY AS WELL.
 *
 * The dialog got no calling code, so a local office number gave an empty link: a blank tab opened and the message was
 * marked «sent». Now the button is shut with its reason written beside it, and «sent» is claimed only when a link opened.
 */

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { CourierNotifyDialog, type CourierAsk } from './CourierNotifyDialog';

const ask = (phone: string | null): CourierAsk => ({
  action: 'CONTACT_CHANGE',
  reason: 'الطرد عند الشركة',
  message: 'نرجو تعديل العنوان',
  courier: { name: 'شركة الأمل', phone },
});

let opened: ReturnType<typeof vi.fn<(url?: string | URL, target?: string, features?: string) => null>>;

beforeEach(() => {
  opened = vi.fn<(url?: string | URL, target?: string, features?: string) => null>(() => null);
  vi.stubGlobal('open', opened);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const draw = (phone: string | null, countryCode?: string | null) =>
  render(<CourierNotifyDialog orderNumber="SY-1" ask={ask(phone)} busy={false} countryCode={countryCode} onClose={vi.fn()} onNotified={vi.fn()} />);

const notifiedButton = () => screen.getByText(/أبلغتُهم/) as HTMLButtonElement;

describe('with the country', () => {
  it('opens the full number with the message, and only then lets «أبلغتُهم» be pressed', () => {
    draw('0791234567', '962');
    expect(notifiedButton().disabled).toBe(true);
    fireEvent.click(screen.getByText('أرسِلها واتساب'));
    expect(opened).toHaveBeenCalledTimes(1);
    const first = opened.mock.calls[0];
    expect(first).toBeTruthy();
    expect(new URL(String(first![0])).pathname).toBe('/962791234567');
    expect(notifiedButton().disabled).toBe(false);
  });
});

describe('without the country', () => {
  it('a local number: the button is shut, the reason is written, no blank tab, nothing marked sent', () => {
    draw('0791234567', null);
    const wa = screen.getByText('أرسِلها واتساب').closest('button') as HTMLButtonElement;
    expect(wa.disabled).toBe(true);
    expect(screen.getByText(/رمز الدولة ناقص/)).toBeTruthy();
    fireEvent.click(wa);
    expect(opened).not.toHaveBeenCalled();
    expect(notifiedButton().disabled, 'اتعلّمت «أُرسلت» وما انفتح شي').toBe(true);
  });

  it('a full international number still opens', () => {
    draw('00905321234567');
    fireEvent.click(screen.getByText('أرسِلها واتساب'));
    expect(new URL(String(opened.mock.calls[0]![0])).pathname).toBe('/905321234567');
  });

  it('no number on file keeps its own reason, and copy stays the way out', () => {
    draw(null, '962');
    expect((screen.getByText('أرسِلها واتساب').closest('button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/رمز الدولة ناقص/)).toBeNull();
    expect(screen.getByText('انسخ الرسالة')).toBeTruthy();
  });
});
