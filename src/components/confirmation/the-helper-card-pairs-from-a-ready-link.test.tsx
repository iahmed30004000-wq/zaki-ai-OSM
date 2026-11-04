// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * «مساعد الاتصال» — THE CARD ON «طلباتي».
 *
 *   · on an Android phone that is not paired, «اربط هذا التلفون» is a plain link to an intent fetched BEFORE the press
 *     (Chrome may refuse an intent opened after an await);
 *   · anywhere else, one line: «من تلفون أندرويد بس», and no code is made;
 *   · paired: «مربوط: <name>» and «افصل», which revokes it;
 *   · back on the page with the pairing changed, the desk is told (its call links appear or go);
 *   · Chrome's fallback (#call-helper-install) says to install the app first.
 */

const { apiJson, state } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  state: { paired: false, codes: 0 },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));

import { CallHelperCard } from './CallHelperCard';

const INTENT = 'intent://pair?base=https%3A%2F%2Fcrm.example.test&code=' + 'C'.repeat(32) + '#Intent;scheme=zakicall;package=io.zakiai.callhelper;S.browser_fallback_url=x;end';
const setAgent = (ua: string) => Object.defineProperty(window.navigator, 'userAgent', { configurable: true, get: () => ua });

beforeEach(() => {
  vi.clearAllMocks();
  state.paired = false;
  state.codes = 0;
  window.location.hash = '';
  apiJson.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/call-helper/device' && method === 'GET') {
      return state.paired ? { paired: true, deviceName: 'Samsung SM-A515F', pairedAt: '2026-11-04T00:00:00.000Z' } : { paired: false, deviceName: null, pairedAt: null };
    }
    if (url === '/api/call-helper/device' && method === 'DELETE') {
      state.paired = false;
      return { ok: true };
    }
    if (url === '/api/call-helper/pair-code') {
      state.codes += 1;
      return { pairLink: 'zakicall://pair', intentUrl: INTENT, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
});
afterEach(() => cleanup());

describe('not paired', () => {
  it('on Android: the button is a link to the intent fetched before the press', async () => {
    setAgent('Mozilla/5.0 (Linux; Android 14; SM-A515F) Chrome/130');
    render(<CallHelperCard />);
    const link = await screen.findByRole('link', { name: 'اربط هذا التلفون' });
    expect(link.getAttribute('href')).toBe(INTENT);
    expect(state.codes).toBe(1);
  });

  it('elsewhere: one line, and no code is made', async () => {
    setAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130');
    render(<CallHelperCard />);
    expect(await screen.findByText('من تلفون أندرويد بس')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'اربط هذا التلفون' })).toBeNull();
    expect(state.codes).toBe(0);
  });

  it('back from Chrome’s fallback: it says to install the app first', async () => {
    setAgent('Mozilla/5.0 (Linux; Android 14) Chrome/130');
    window.location.hash = '#call-helper-install';
    render(<CallHelperCard />);
    expect(await screen.findByText(/التطبيق مش منزّل على هالتلفون/)).toBeTruthy();
  });
});

describe('paired', () => {
  it('names the phone, and «افصل» revokes it', async () => {
    setAgent('Mozilla/5.0 (Linux; Android 14) Chrome/130');
    state.paired = true;
    const onChange = vi.fn();
    render(<CallHelperCard onChange={onChange} />);
    expect(await screen.findByText('Samsung SM-A515F')).toBeTruthy();
    expect(state.codes).toBe(0);
    // It asks first (a-delete-asks-first); a «no» changes nothing.
    const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button', { name: 'افصل' }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(apiJson).not.toHaveBeenCalledWith('/api/call-helper/device', { method: 'DELETE' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'افصل' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'افصل' }));
    await waitFor(() => expect(apiJson).toHaveBeenCalledWith('/api/call-helper/device', { method: 'DELETE' }));
    expect(await screen.findByRole('link', { name: 'اربط هذا التلفون' })).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
    ask.mockRestore();
  });

  it('back on the page after pairing in the app: the desk is told', async () => {
    setAgent('Mozilla/5.0 (Linux; Android 14) Chrome/130');
    const onChange = vi.fn();
    render(<CallHelperCard onChange={onChange} />);
    await screen.findByRole('link', { name: 'اربط هذا التلفون' });
    state.paired = true;
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await screen.findByText('Samsung SM-A515F')).toBeTruthy();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
