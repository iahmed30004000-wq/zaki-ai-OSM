// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { CARD_CLASS } from '@/lib/theme-shape';
import { routeLabel } from '@/lib/route-registry';

/**
 * R16d (18/11) — «الملف الشخصي» ON THE KIT, AND NOTHING ELSE MOVED.
 *
 * The frame is `PageShell` (narrow, as the page always was), the theme box is a `Card`, the fingerprint section's
 * buttons are the kit's, and the decoration level is a `Segmented`. What must NOT have moved, and is held here:
 *   · the profile save sends the same PATCH /api/profile bodies (name only · password trio · nothing on a mismatch);
 *   · the three password boxes open empty and come back empty after a save, and no typed secret is printed anywhere;
 *   · a theme press paints at once, saves through the same door with the same body, then asks for the new palette;
 *   · the decoration level writes the same cookie and asks for the same refresh;
 *   · a fingerprint is added only after the password, and «رجوع» inside that form submits nothing;
 *   · a fingerprint is removed only after the question, through the same DELETE;
 *   · the page asks no key: whoever opens it gets every press on it (the menu card's `roles.edit` part is R7's, not here).
 */

const user = vi.hoisted(() => ({
  current: {
    id: 'u1',
    name: 'موظف تجربة',
    email: 'staff@example.test',
    avatar: '',
    role: 'AGENT',
    status: 'ACTIVE',
    systemTheme: 'ops',
    permissions: [] as string[],
  },
}));
const refreshUser = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/context/AppContext', () => ({ useApp: () => ({ currentUser: user.current, refreshUser }) }));

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

const apiFetch = vi.hoisted(() => vi.fn(async (_url: string, _init: { method: string; body: string }) => ({ ok: true })));
vi.mock('@/lib/api-client', () => ({ apiFetch }));

const decor = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('@/lib/theme-decoration', async (orig) => {
  const real = await orig<typeof import('@/lib/theme-decoration')>();
  return { ...real, readDecor: () => 'light', setDecor: (l: string) => decor.set(l) };
});

const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn() }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => confirmMock }));
const support = vi.hoisted(() => ({ ok: true }));
const createPasskey = vi.hoisted(() => vi.fn());
vi.mock('@/lib/passkey-browser', () => ({
  createPasskey: (...a: unknown[]) => createPasskey(...a),
  passkeySupported: async () => support.ok,
}));

// Not this slice's: drawn as they are, stubbed here so the test reads only the profile.
vi.mock('@/components/performance/ScoreCard', () => ({ ScoreCard: () => <div data-stub="score" /> }));
vi.mock('@/components/settings/MenuOrderCard', () => ({ MenuOrderCard: () => <div data-stub="menu-order" /> }));

import { ProfileScreen } from './ProfileScreen';

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let keys: Array<{ id: string; label: string | null; createdAt: string; lastUsedAt: string | null }>;
let profileAnswer: { ok: boolean; body: unknown };

beforeEach(() => {
  calls = [];
  keys = [];
  support.ok = true;
  profileAnswer = { ok: true, body: { ok: true } };
  user.current = { ...user.current, name: 'موظف تجربة', avatar: '' };
  confirmMock.mockReset();
  createPasskey.mockReset().mockResolvedValue({ credentialId: 'a', publicKey: 'b', algorithm: -7, clientDataJSON: 'd' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url === '/api/profile') return { ok: profileAnswer.ok, status: profileAnswer.ok ? 200 : 400, json: async () => profileAnswer.body };
      if (url === '/api/auth/passkey' && method === 'POST') return { ok: true, status: 200, json: async () => ({ challenge: 'c' }) };
      if (url === '/api/auth/passkey/register') return { ok: true, status: 200, json: async () => ({ key: {} }) };
      return { ok: true, status: 200, json: async () => ({ keys }) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  apiFetch.mockClear();
  routerRefresh.mockClear();
  decor.set.mockClear();
  refreshUser.mockClear();
  document.querySelectorAll('[data-sys-theme]').forEach((n) => n.remove());
});

const ready = async () => {
  render(<ProfileScreen />);
  await screen.findByText('سجّل بصمةَ هذا الجهاز');
};
const sent = (url: string, method: string) => calls.filter((c) => c.url === url && c.method === method);
const passwordBoxes = () => [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')];
const save = () =>
  act(async () => {
    fireEvent.click(screen.getByText('حفظ التغييرات').closest('button')!);
  });

describe('the frame', () => {
  it('is PageShell: one h1, the registry name, the narrow width the page always had', async () => {
    await ready();
    const h1s = document.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0].textContent).toContain(routeLabel('/admin/profile'));
    const root = document.body.firstElementChild!.firstElementChild as HTMLElement;
    expect(root.className).toContain('min-w-0');
    expect(root.className).toContain('max-w-' + '3xl');
  });

  it('a phone at 375: no width fixed in pixels anywhere on the page', async () => {
    keys = [{ id: 'k1', label: 'مفتاح طويل الاسم جداً على هاتف صغير', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }];
    await ready();
    await screen.findByText('مفتاح طويل الاسم جداً على هاتف صغير');
    const fixed = [...document.querySelectorAll<HTMLElement>('[class]')]
      .flatMap((el) => el.className.toString().split(/\s+/))
      .filter((c) => /^(?:min-)?w-\[\d+px\]$/.test(c));
    expect(fixed).toEqual([]);
  });

  it('the theme box is a page Card (it wears the theme), and the read-only facts are where they were', async () => {
    await ready();
    const picker = screen.getByText('مظهر النظام').closest('section')!;
    expect(picker.parentElement!.className).toContain(CARD_CLASS);
    expect(screen.getByText('معلومات الحساب')).toBeTruthy();
    expect(screen.getByText('staff@example.test')).toBeTruthy();
    expect(document.querySelector('[data-stub="score"]')).toBeTruthy();
    expect(document.querySelector('[data-stub="menu-order"]')).toBeTruthy();
  });

  it('asks no key: a user holding none gets every press of the page', async () => {
    user.current = { ...user.current, permissions: [] };
    await ready();
    expect(screen.getByText('حفظ التغييرات')).toBeTruthy();
    expect(screen.getByText('سجّل بصمةَ هذا الجهاز')).toBeTruthy();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(document.querySelectorAll('section > div > button')).toHaveLength(15);
  });
});

describe('the profile save — the same bodies, the same door', () => {
  it('a name change alone sends { name } and nothing about a password', async () => {
    await ready();
    fireEvent.change(screen.getByLabelText('الاسم الكامل'), { target: { value: 'اسم جديد' } });
    await save();
    await waitFor(() => expect(sent('/api/profile', 'PATCH')).toHaveLength(1));
    expect(sent('/api/profile', 'PATCH')[0].body).toEqual({ name: 'اسم جديد' });
    expect(await screen.findByText('تم حفظ التغييرات بنجاح')).toBeTruthy();
  });

  it('a password change sends the current and the new one, never the confirmation', async () => {
    await ready();
    const [now, next, again] = passwordBoxes();
    fireEvent.change(now, { target: { value: 'Old-Secret-1' } });
    fireEvent.change(next, { target: { value: 'New-Secret-22' } });
    fireEvent.change(again, { target: { value: 'New-Secret-22' } });
    await save();
    await waitFor(() => expect(sent('/api/profile', 'PATCH')).toHaveLength(1));
    expect(sent('/api/profile', 'PATCH')[0].body).toEqual({ currentPassword: 'Old-Secret-1', newPassword: 'New-Secret-22' });
  });

  it('two passwords that differ send NOTHING and say so', async () => {
    await ready();
    const [, next, again] = passwordBoxes();
    fireEvent.change(next, { target: { value: 'New-Secret-22' } });
    fireEvent.change(again, { target: { value: 'Other-Secret-33' } });
    await save();
    expect(await screen.findByText('كلمتا المرور غير متطابقتين')).toBeTruthy();
    expect(sent('/api/profile', 'PATCH')).toEqual([]);
  });

  it('a refusal from the server is shown and nothing is cleared as if saved', async () => {
    profileAnswer = { ok: false, body: { error: 'كلمة المرور الحالية غير صحيحة' } };
    await ready();
    fireEvent.change(screen.getByLabelText('الاسم الكامل'), { target: { value: 'اسم جديد' } });
    await save();
    expect(await screen.findByText('كلمة المرور الحالية غير صحيحة')).toBeTruthy();
    expect(refreshUser).not.toHaveBeenCalled();
  });
});

describe('the secrets (decision 3)', () => {
  it('the three password boxes open empty', async () => {
    await ready();
    const boxes = passwordBoxes();
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect(b.value).toBe('');
  });

  it('after a save they are empty again, and no typed secret is printed in text or in any attribute', async () => {
    await ready();
    const [now, next, again] = passwordBoxes();
    fireEvent.change(now, { target: { value: 'Old-Secret-1' } });
    fireEvent.change(next, { target: { value: 'New-Secret-22' } });
    fireEvent.change(again, { target: { value: 'New-Secret-22' } });
    await save();
    await screen.findByText('تم حفظ التغييرات بنجاح');
    for (const b of passwordBoxes()) expect(b.value).toBe('');
    const html = document.body.innerHTML;
    expect(html).not.toContain('Old-Secret-1');
    expect(html).not.toContain('New-Secret-22');
  });

  it('the fingerprint password box opens empty, is never printed, and is empty after a refused try', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    expect(passwordBoxes()).toHaveLength(4);
    const box = passwordBoxes()[3];
    expect(box.value).toBe('');
    fireEvent.change(box, { target: { value: 'Finger-Secret-9' } });
    createPasskey.mockRejectedValueOnce(new Error('تعذّر'));
    await act(async () => {
      fireEvent.click(screen.getByText('أكّد وسجّل البصمة'));
    });
    await waitFor(() => expect(passwordBoxes()[3].value).toBe(''));
    expect(document.body.textContent).not.toContain('Finger-Secret-9');
    expect(sent('/api/auth/passkey', 'POST')[0].body).toEqual({ password: 'Finger-Secret-9' });
  });
});

describe('the theme — paints at once, saves through the same door, then asks for the palette', () => {
  it('a swatch press', async () => {
    const frame = document.createElement('div');
    frame.setAttribute('data-sys-theme', 'ops');
    document.body.appendChild(frame);
    await ready();
    fireEvent.click(screen.getByText('نظيف').closest('button')!);
    expect(frame.getAttribute('data-sys-theme')).toBe('clean');
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0];
    expect(url).toBe('/api/profile/theme');
    expect(init.method).toBe('PATCH');
    expect(init.body).toBe(JSON.stringify({ theme: 'clean' }));
  });

  it('a failed save keeps the colour and says so — no refresh', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false });
    await ready();
    fireEvent.click(screen.getByText('نظيف').closest('button')!);
    expect(await screen.findByText('طُبِّق المظهر هنا، لكن تعذّر حفظه — سيعود إلى السابق على جهاز آخر.')).toBeTruthy();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});

describe('the decoration level — a Segmented, the same cookie, the same refresh', () => {
  it('three radios named by the heading, the cookie level chosen, and the three notes all still written', async () => {
    await ready();
    const group = screen.getByRole('radiogroup');
    expect(group.getAttribute('aria-labelledby')).toBe(screen.getByText('زخرفةُ المظهر').id);
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['بلا', 'خفيفة', 'كاملة']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(screen.getByText(/ألوانُ المظهر وحدها/)).toBeTruthy();
    expect(screen.getByText(/لمسةٌ ساكنة/)).toBeTruthy();
    expect(screen.getByText(/ومعها حركةٌ بطيئة/)).toBeTruthy();
    // All three written at once, not only the chosen one's.
    const notes = [...document.querySelectorAll('li')].filter((li) => /ألوانُ المظهر وحدها|لمسةٌ ساكنة|ومعها حركةٌ بطيئة/.test(li.textContent ?? ''));
    expect(notes.map((li) => li.hidden || li.closest('[hidden]') !== null)).toEqual([false, false, false]);
  });

  it('«كاملة» writes full and asks the server for the page again', async () => {
    await ready();
    fireEvent.click(screen.getByRole('radio', { name: 'كاملة' }));
    expect(decor.set).toHaveBeenCalledWith('full');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: 'كاملة' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('the fingerprints — the same requests, and nothing submits by accident', () => {
  it('«رجوع» is type="button": it closes the box and sends nothing', async () => {
    await ready();
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    fireEvent.change(passwordBoxes()[3], { target: { value: 'typed' } });
    const back = screen.getByText('رجوع').closest('button')!;
    expect(back.getAttribute('type')).toBe('button');
    await act(async () => {
      fireEvent.click(back);
    });
    expect(sent('/api/auth/passkey', 'POST')).toEqual([]);
    expect(passwordBoxes()).toHaveLength(3);
  });

  it('every kit button of the section states its type; the confirm is the only submit', async () => {
    await ready();
    expect(screen.getByText('سجّل بصمةَ هذا الجهاز').closest('button')!.getAttribute('type')).toBe('button');
    await act(async () => {
      fireEvent.click(screen.getByText('سجّل بصمةَ هذا الجهاز'));
    });
    const form = passwordBoxes()[3].closest('form')!;
    const types = [...form.querySelectorAll('button')].map((b) => b.getAttribute('type'));
    // The password box carries its own «show» button (type="button", the Input's); then the confirm and «رجوع».
    expect(types.filter((t) => t === 'submit')).toHaveLength(1);
    expect(types.every((t) => t === 'submit' || t === 'button')).toBe(true);
    expect(screen.getByText('أكّد وسجّل البصمة').closest('button')!.getAttribute('type')).toBe('submit');
  });

  it('the bin is an IconButton named for its key; it asks, and a yes sends the same DELETE', async () => {
    keys = [{ id: 'k9', label: 'مفتاح الحاسوب', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }];
    confirmMock.mockResolvedValue(true);
    await ready();
    const bin = await screen.findByLabelText('احذف مفتاح الحاسوب');
    expect(bin.getAttribute('title')).toBe('احذف مفتاح الحاسوب');
    expect(bin.getAttribute('type')).toBe('button');
    await act(async () => {
      fireEvent.click(bin);
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(sent('/api/auth/passkey?id=k9', 'DELETE')).toHaveLength(1));
  });

  it('a «no» to the question sends no DELETE at all', async () => {
    keys = [{ id: 'k9', label: 'مفتاح الحاسوب', createdAt: '2026-09-01T00:00:00.000Z', lastUsedAt: null }];
    confirmMock.mockResolvedValue(false);
    await ready();
    const bin = await screen.findByLabelText('احذف مفتاح الحاسوب');
    await act(async () => {
      fireEvent.click(bin);
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });

  it('a device without a sensor gets the sentence in a plain Card and no add button', async () => {
    support.ok = false;
    render(<ProfileScreen />);
    const note = await screen.findByText(/هذا الجهاز لا يوفّر بصمةً/);
    expect(note.className).toContain('bg-[var(--sys-card)]');
    expect(note.className).not.toContain(CARD_CLASS);
    expect(screen.queryByText('سجّل بصمةَ هذا الجهاز')).toBeNull();
  });
});
