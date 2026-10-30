// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';

/**
 * A1 — THE BUTTON THAT ADDS A FINGERPRINT ASKS FOR THE PASSWORD FIRST.
 *
 * Pressing it opens a password box and sends nothing. Only the confirmation sends the start request, with
 * the password in it; a refusal is shown in Arabic and registers nothing; «رجوع» closes the box and clears
 * what was typed.
 */

vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn() }));
const createPasskey = vi.fn();
vi.mock('@/lib/passkey-browser', () => ({ createPasskey: (...a: unknown[]) => createPasskey(...a), passkeySupported: async () => true }));

import { PasskeySection } from './PasskeySection';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let startAnswer: { ok: boolean; body: unknown };

beforeEach(() => {
  calls = [];
  startAnswer = { ok: true, body: { challenge: 'c', rp: { id: 'x', name: 'x' }, user: {}, excludeCredentials: [] } };
  createPasskey.mockReset().mockResolvedValue({ credentialId: 'a', publicKey: 'b', algorithm: -7, clientDataJSON: 'd' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === '/api/auth/passkey' && method === 'POST') return { ok: startAnswer.ok, status: startAnswer.ok ? 200 : 401, json: async () => startAnswer.body };
      if (url === '/api/auth/passkey/register') return { ok: true, status: 200, json: async () => ({ key: {} }) };
      return { ok: true, status: 200, json: async () => ({ keys: [] }) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const starts = () => calls.filter((c) => c.url === '/api/auth/passkey' && c.method === 'POST');
const ready = async () => {
  render(<PasskeySection />);
  await screen.findByText('سجّل بصمةَ هذا الجهاز');
};

describe('adding a fingerprint', () => {
  it('pressing the button asks for the password and sends NOTHING yet', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    expect(screen.getByLabelText('كلمة المرور الحالية')).toBeTruthy();
    expect(starts()).toEqual([]);
    expect((screen.getByText('أكّد وسجّل البصمة').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the confirmation sends the start request WITH the password, then registers the key', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور الحالية'), { target: { value: 'Right-Password1' } });
    await act(async () => {
      fireEvent.click(screen.getByText('أكّد وسجّل البصمة'));
    });
    await waitFor(() => expect(calls.some((c) => c.url === '/api/auth/passkey/register')).toBe(true));
    expect(starts()).toHaveLength(1);
    expect(starts()[0].body).toEqual({ password: 'Right-Password1' });
  });

  it('a refused password is shown in Arabic and no key is registered', async () => {
    startAnswer = { ok: false, body: { error: 'كلمة المرور غير صحيحة', code: 'STEP_UP' } };
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور الحالية'), { target: { value: 'nope' } });
    await act(async () => {
      fireEvent.click(screen.getByText('أكّد وسجّل البصمة'));
    });
    expect(await screen.findByText('كلمة المرور غير صحيحة')).toBeTruthy();
    expect(createPasskey).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url === '/api/auth/passkey/register')).toBe(false);
  });

  it('«رجوع» closes the box and what was typed is gone when it opens again', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    fireEvent.change(screen.getByLabelText('كلمة المرور الحالية'), { target: { value: 'typed' } });
    await act(async () => {
      fireEvent.click(screen.getByText('رجوع'));
    });
    expect(screen.queryByLabelText('كلمة المرور الحالية')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    expect((screen.getByLabelText('كلمة المرور الحالية') as HTMLInputElement).value).toBe('');
  });
});
