// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * «جرّب الشكل الجديد» (R5, 18/11): the new look is OFFERED to whoever is not
 * on it, once per device, and only their own press writes it — through the
 * one door the profile's picker already uses.
 */

const { refresh, app } = vi.hoisted(() => ({
  refresh: vi.fn(),
  app: { current: null as null | { currentUser: { preview?: unknown } | null } },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/context/AppContext', () => ({ useAppOptional: () => app.current }));

import { TryTheNewLook } from './TryTheNewLook';

const YES = 'جرّب الشكل الجديد';
const NO = 'لا، شكراً';
const KEY = 'zaki.newlook.answered';

let fetchMock: ReturnType<typeof vi.fn>;

/** The frame as the server paints it: one attribute naming the look. */
function paint(theme: string | null) {
  document.body.innerHTML = '';
  const frame = document.createElement('div');
  if (theme !== null) frame.setAttribute('data-sys-theme', theme);
  document.body.appendChild(frame);
  return frame;
}

function mount(theme: string | null = 'ops') {
  const frame = paint(theme);
  return render(<TryTheNewLook />, { container: frame });
}

beforeEach(() => {
  localStorage.clear();
  refresh.mockReset();
  app.current = null;
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ theme: 'clean' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who sees it', () => {
  it('— somebody on another look (the default, «ليل», «تلقائي») sees it', () => {
    for (const theme of ['ops', 'layl', 'auto']) {
      mount(theme);
      expect(screen.getByRole('button', { name: YES }), theme).toBeTruthy();
      cleanup();
    }
  });

  it('— somebody already on «نظيف» does not', () => {
    mount('clean');
    expect(screen.queryByRole('button', { name: YES })).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('— no frame attribute at all (not a system page): nothing', () => {
    mount(null);
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('— never while the owner previews somebody («عاين كـ»): a preview is read-only', () => {
    app.current = { currentUser: { preview: { ownerId: 'o', ownerName: 'المالك', roleName: 'موظفة', expiresAt: '' } } };
    mount('ops');
    expect(screen.queryByRole('region')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('— a signed-in person who is not previewing sees it', () => {
    app.current = { currentUser: { preview: null } };
    mount('ops');
    expect(screen.getByRole('button', { name: YES })).toBeTruthy();
  });
});

describe('the two answers', () => {
  it('— «جرّب» sends exactly one PATCH to /api/profile/theme with the new look, then refreshes and hides', async () => {
    mount('ops');
    await userEvent.click(screen.getByRole('button', { name: YES }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/profile/theme');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(String(init.body))).toEqual({ theme: 'clean' });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('— «لا، شكراً» sends nothing, and hides', async () => {
    mount('ops');
    await userEvent.click(screen.getByRole('button', { name: NO }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('— and it stays hidden on the next page (a fresh mount on the same device)', async () => {
    mount('ops');
    await userEvent.click(screen.getByRole('button', { name: NO }));
    cleanup();
    mount('ops');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('— a save that fails keeps the old look, says so in Arabic, and the line stays for another try', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 500 }));
    const view = mount('ops');
    await userEvent.click(screen.getByRole('button', { name: YES }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/ما قدرنا نحفظ/);
    expect(alert.textContent).not.toMatch(/[A-Za-z]/);
    expect(refresh).not.toHaveBeenCalled();
    expect(view.container.getAttribute('data-sys-theme')).toBe('ops');
    expect(screen.getByRole('button', { name: YES })).toBeTruthy();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('— a network that throws is the same failure, not a crash', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('offline');
    });
    mount('ops');
    await userEvent.click(screen.getByRole('button', { name: YES }));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('storage that refuses', () => {
  it('— a throwing localStorage neither crashes the read nor the press: it simply asks again next time', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    mount('ops');
    expect(screen.getByRole('button', { name: YES })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: NO }));
    expect(screen.queryByRole('region')).toBeNull();
    cleanup();
    mount('ops');
    expect(screen.getByRole('button', { name: YES })).toBeTruthy();
  });
});

describe('its place on the page', () => {
  it('— in the flow (never laid over the page) and nothing in it forces a width wider than a phone', () => {
    mount('ops');
    const region = screen.getByRole('region');
    const tokens = [region, ...Array.from(region.querySelectorAll('*'))].flatMap((el) =>
      (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean),
    );
    const laidOver = new Set(['fixed', 'absolute', 'sticky']);
    expect(tokens.filter((t) => laidOver.has(t))).toEqual([]);
    // A fixed or minimum width, or text that refuses to wrap, is what overflows 375 px.
    expect(tokens.filter((t) => /^(min-)?w-\[|^w-(\d|screen)|nowrap/.test(t))).toEqual([]);
    // The buttons are allowed to go to a second line.
    expect(tokens.filter((t) => /wrap$/.test(t)).length).toBeGreaterThan(0);
  });

  it('— every word on it is Arabic', () => {
    mount('ops');
    expect(screen.getByRole('region').textContent).not.toMatch(/[A-Za-z]/);
  });
});

describe('it writes no row itself', () => {
  const ROOT = process.cwd();
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('— the line, the shell and the themes file reach no database: the only write is the PATCH the person presses', () => {
    for (const f of ['src/components/shell/TryTheNewLook.tsx', 'src/components/shell/Shell.tsx', 'src/lib/system-themes.ts']) {
      const body = read(f);
      expect(body, f).not.toMatch(/\b(user|role|company|companySetting)\.(create|createMany|update|updateMany|upsert|delete)\(/);
      expect(body, f).not.toMatch(/from '@\/lib\/db'|\$executeRaw|\$queryRaw/);
    }
  });

  it('— the shell mounts it, once', () => {
    const shell = read('src/components/shell/Shell.tsx');
    expect(shell.match(/<TryTheNewLook\b/g)?.length).toBe(1);
  });
});

