// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «مساعد الاتصال» ON THE CONTACT STRIP.
 *
 *   · the signed `intent://` link is used ONLY on an Android phone — on a laptop or an iPhone it does nothing at all,
 *     so «اتصال» there is today's `tel:` even when the desk sent `callHref`;
 *   · on Android the press writes the same OPENED line, and when the page is still visible a moment later (the app is
 *     not installed: Chrome ignores a `tel:` fallback and goes nowhere or to the store) the plain dialler is offered;
 *   · the offered dialler writes no second line, and a press that left the page offers nothing.
 */

const { apiJson } = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { ContactButtons } from './ContactButtons';

const LINK =
  'intent://call?order=o1&phone=963952554562&exp=1&sig=' + 'ab'.repeat(32) + '#Intent;scheme=zakicall;package=io.zakiai.callhelper;S.browser_fallback_url=tel%3A%2B963952554562;end';
const CONTEXT = { orderNumber: 'ORD-1', customerName: 'أبو محمد', amount: 25 };
const setAgent = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => ua });
let visibility: 'visible' | 'hidden' = 'visible';

const draw = () => render(<ContactButtons phone="0952554562" countryCode="963" context={CONTEXT} orderId="o1" callHref={LINK} />);
const opened = () => apiJson.mock.calls.filter((c) => String(c[0]).endsWith('/contact-attempts')).length;

beforeEach(() => {
  vi.clearAllMocks();
  apiJson.mockResolvedValue({});
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('not an Android phone', () => {
  it.each([
    ['a laptop', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130'],
    ['an iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'],
  ])('%s: «اتصال» is today’s tel: although the desk sent the helper link', async (_who, ua) => {
    setAgent(ua);
    draw();
    // After the effect that reads the browser, too.
    await act(async () => {});
    expect(screen.getByTitle('اتصال').getAttribute('href')).toBe('tel:0952554562');
    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('اتصال'));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.queryByText('ما فتح المساعد؟ اتصل من التلفون')).toBeNull();
  });
});

describe('an Android phone', () => {
  beforeEach(() => setAgent('Mozilla/5.0 (Linux; Android 14; SM-A515F) Chrome/130'));

  it('«اتصال» opens the helper link, and the press writes the same OPENED line', async () => {
    draw();
    await waitFor(() => expect(screen.getByTitle('اتصال').getAttribute('href')).toBe(LINK));
    fireEvent.click(screen.getByTitle('اتصال'));
    await waitFor(() => expect(opened()).toBe(1));
    expect(JSON.parse(apiJson.mock.calls[0][1].body)).toEqual({ contactMethod: 'PHONE', result: 'OPENED' });
  });

  it('the app did not open (still here a moment later): the plain dialler is offered, and it writes no second line', async () => {
    draw();
    await waitFor(() => expect(screen.getByTitle('اتصال').getAttribute('href')).toBe(LINK));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('اتصال'));
    expect(screen.queryByText('ما فتح المساعد؟ اتصل من التلفون')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    const fallback = screen.getByText('ما فتح المساعد؟ اتصل من التلفون');
    expect(fallback.getAttribute('href')).toBe('tel:0952554562');
    fireEvent.click(fallback);
    expect(screen.queryByText('ما فتح المساعد؟ اتصل من التلفون')).toBeNull();
    vi.useRealTimers();
    await waitFor(() => expect(opened()).toBe(1));
  });

  it('the app opened (the page went away): nothing is offered', async () => {
    draw();
    await waitFor(() => expect(screen.getByTitle('اتصال').getAttribute('href')).toBe(LINK));
    vi.useFakeTimers();
    fireEvent.click(screen.getByTitle('اتصال'));
    visibility = 'hidden';
    act(() => {
      vi.advanceTimersByTime(1_600);
    });
    expect(screen.queryByText('ما فتح المساعد؟ اتصل من التلفون')).toBeNull();
  });

  it('without a helper link it is tel:, as it always was', async () => {
    render(<ContactButtons phone="0952554562" countryCode="963" context={CONTEXT} orderId="o1" />);
    await act(async () => {});
    expect(screen.getByTitle('اتصال').getAttribute('href')).toBe('tel:0952554562');
  });
});
