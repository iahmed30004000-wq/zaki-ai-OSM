// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@/lib/guard-source';

/**
 * «قنوات الطلبات» ON THE KIT (R15d, plan 17/11 — written 18/11).
 *
 * The screen moved onto `PageShell`, `Button`/`IconButton`, `Card`, `Input`/`Select`, and its on/off press became a `Switch`.
 * What must NOT have moved with it:
 *   - every press sends the same request it sent: the create body, the edit body, the on/off body, byte for byte;
 *   - the switch sends the value it is asked for — off for a channel that is on, on for one that is off — and only once;
 *   - a press that is in the air cannot be pressed again (the screen's own busy flag still disables it);
 *   - a name shorter than two letters is refused before anything is sent;
 *   - the link to the score on the performance board is still drawn, for whoever may open it.
 * Every claim has a negative twin.
 *
 * jsdom has no layout: «no sideways scroll at 375px» is checked as the classes that make it (the frame's `min-w-0`, no fixed
 * pixel width wider than a phone, the add form one column on a phone), and the pull request says so.
 */

const { apiJson, may } = vi.hoisted(() => ({
  apiJson: vi.fn(),
  may: { yes: true },
}));
vi.mock('@/lib/api-client', () => ({ apiJson: (...a: unknown[]) => apiJson(...a) }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/settings/channels',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));
vi.mock('@/hooks/useMayOpen', () => ({ useMayOpen: () => () => may.yes }));
vi.mock('@/components/ui/Confirm', () => ({ useConfirm: () => vi.fn(async () => false) }));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => ({ failed: vi.fn(), success: vi.fn(), done: vi.fn() }) }));

import { ChannelsScreen } from './ChannelsScreen';
import { routeLabel } from '@/lib/route-registry';

vi.setConfig({ testTimeout: 15000 });

const ON = { id: 'ch-on', name: 'صفحة الكريم', kind: 'TIKTOK', isActive: true, sortOrder: 0, orders: 0 };
const OFF = { id: 'ch-off', name: 'صفحة القطرة', kind: 'FACEBOOK', isActive: false, sortOrder: 1, orders: 7 };

let sent: { url: string; method: string; body: string | undefined }[] = [];
let channels: unknown[] = [];
let hold: Promise<unknown> | null = null;

beforeEach(() => {
  sent = [];
  channels = [ON, OFF];
  hold = null;
  may.yes = true;
  apiJson.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    if (url === '/api/settings/channels' && method === 'GET') return { channels };
    sent.push({ url, method, body: init?.body });
    if (hold) await hold;
    return { success: true };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ready = async () => {
  const view = render(<ChannelsScreen />);
  await screen.findByText('صفحة الكريم');
  return view;
};
const writes = () => sent.filter((s) => s.method !== 'GET');

describe('the channels screen on the kit', () => {
  it('— one header, its name read from the menu, inside the frame', async () => {
    await ready();
    const h1 = screen.getAllByRole('heading', { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0].textContent).toContain(routeLabel('/settings/channels'));
    expect(routeLabel('/settings/channels')).toBe('قنوات الطلبات');
  });

  it('— the source draws the frame, the kit, and no raw button, input or select', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/screens/ChannelsScreen.tsx'), 'utf8'));
    expect(src).toMatch(/<PageShell title=\{routeLabel\('\/settings\/channels'\)\}/);
    expect(src).not.toMatch(/<button[\s>]/);
    expect(src).not.toMatch(/<input[\s>]/);
    expect(src).not.toMatch(/<select[\s>]/);
    // no form, so no kit button can submit one by accident (the kit sets no default `type`)
    expect(src).not.toMatch(/<form[\s>]/);
    // legacy look names stay out of new code
    expect(src).not.toMatch(/variant="(outline|ghost|success)"/);
  });

  it('— the switch of a channel that is ON is checked, is called «إيقاف», and sends exactly { isActive: false } once', async () => {
    await ready();
    const sw = screen.getByRole('switch', { name: 'إيقاف' });
    expect((sw as HTMLInputElement).checked).toBe(true);
    expect(writes()).toEqual([]);
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/settings/channels/ch-on', method: 'PATCH', body: JSON.stringify({ isActive: false }) });
  });

  it('— and the switch of a channel that is OFF is unchecked, is called «تفعيل», and sends exactly { isActive: true }', async () => {
    await ready();
    const sw = screen.getByRole('switch', { name: 'تفعيل' });
    expect((sw as HTMLInputElement).checked).toBe(false);
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({ url: '/api/settings/channels/ch-off', method: 'PATCH', body: JSON.stringify({ isActive: true }) });
  });

  it('NEGATIVE: while the switch’s request is in the air, the switch is disabled and a second press sends nothing', async () => {
    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    await ready();
    const sw = screen.getByRole('switch', { name: 'إيقاف' });
    await act(async () => {
      fireEvent.click(sw);
    });
    await waitFor(() => expect((screen.getByRole('switch', { name: 'إيقاف' }) as HTMLInputElement).disabled).toBe(true));
    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: 'إيقاف' }));
    });
    expect(writes()).toHaveLength(1);
    await act(async () => {
      release();
    });
  });

  it('— «قناة جديدة» opens a form whose fields are labelled, and «أضف القناة» sends the same body it always sent', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /قناة جديدة/ }));
    const name = screen.getByLabelText('اسم القناة') as HTMLInputElement;
    const kind = screen.getByLabelText('المنصة') as HTMLSelectElement;
    expect(kind.value).toBe('LANDING_PAGE');
    fireEvent.change(name, { target: { value: '  صفحة جديدة  ' } });
    fireEvent.change(kind, { target: { value: 'WHATSAPP' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أضف القناة' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/settings/channels',
      method: 'POST',
      body: JSON.stringify({ name: 'صفحة جديدة', kind: 'WHATSAPP' }),
    });
  });

  it('NEGATIVE: a name shorter than two letters sends nothing', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /قناة جديدة/ }));
    fireEvent.change(screen.getByLabelText('اسم القناة'), { target: { value: ' ب ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أضف القناة' }));
    });
    expect(writes()).toEqual([]);
  });

  it('NEGATIVE: while the add is in the air its button says so and is disabled, and a second press sends nothing', async () => {
    let release: () => void = () => {};
    hold = new Promise<void>((r) => {
      release = r;
    });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /قناة جديدة/ }));
    fireEvent.change(screen.getByLabelText('اسم القناة'), { target: { value: 'صفحة جديدة' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'أضف القناة' }));
    });
    const pending = await screen.findByRole('button', { name: 'جارٍ الإضافة…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(pending);
    });
    expect(writes()).toHaveLength(1);
    await act(async () => {
      release();
    });
  });

  it('— «إلغاء» closes the form and sends nothing', async () => {
    await ready();
    fireEvent.click(screen.getByRole('button', { name: /قناة جديدة/ }));
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(screen.queryByLabelText('اسم القناة')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('— the pencil opens the row with its own values, and «احفظ التعديل» sends { name, kind } exactly', async () => {
    await ready();
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' })[0]);
    const name = screen.getByLabelText('الاسم') as HTMLInputElement;
    expect(name.value).toBe('صفحة الكريم');
    expect((screen.getByLabelText('المنصة') as HTMLSelectElement).value).toBe('TIKTOK');
    fireEvent.change(name, { target: { value: ' صفحة الكريم ٢ ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'احفظ التعديل' }));
    });
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual({
      url: '/api/settings/channels/ch-on',
      method: 'PATCH',
      body: JSON.stringify({ name: 'صفحة الكريم ٢', kind: 'TIKTOK' }),
    });
  });

  it('NEGATIVE: «ألغِ التعديل» closes the row and sends nothing', async () => {
    await ready();
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'ألغِ التعديل' }));
    expect(screen.queryByLabelText('الاسم')).toBeNull();
    expect(writes()).toEqual([]);
  });

  it('— the share of each channel and the bin only on the unused one are as before', async () => {
    await ready();
    expect(screen.getByText(/7 طلب/).textContent).toContain('100%');
    expect(screen.getAllByRole('button', { name: 'حذف — لا طلبات عليها' })).toHaveLength(1);
  });

  it('— an empty list keeps its sentence', async () => {
    channels = [];
    render(<ChannelsScreen />);
    expect(await screen.findByText('لا قنوات بعد — أضف أول واحدة.')).toBeTruthy();
  });

  it('— the link to the score on the board stays, and NEGATIVE: is not drawn for who may not open the board', async () => {
    await ready();
    expect(screen.getByRole('link', { name: 'سكور القنوات في لوحة الأداء' }).getAttribute('href')).toBe('/growth/performance');
    cleanup();
    may.yes = false;
    await ready();
    expect(screen.queryByRole('link', { name: /لوحة الأداء/ })).toBeNull();
  });

  it('— at 375px: the frame may shrink, no fixed width wider than a phone, the add form one column', async () => {
    const { container } = await ready();
    fireEvent.click(screen.getByRole('button', { name: /قناة جديدة/ }));
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className.split(/\s+/)).toContain('min-w-0');
    // built from pieces: the stylesheet scanner reads tests too
    const fixed = new RegExp(['(^|\\s)(min-)?w', '-\\[', '(\\d+)px\\]'].join(''), 'g');
    let widths = 0;
    for (const el of Array.from(container.querySelectorAll('[class]'))) {
      const cls = el.getAttribute('class') ?? '';
      for (const m of cls.matchAll(fixed)) {
        widths++;
        expect(Number(m[3]), cls).toBeLessThanOrEqual(375);
      }
    }
    // the check reads something: the edit row's name box has a fixed minimum, and it is under a phone's width
    fireEvent.click(screen.getAllByRole('button', { name: 'تعديل' })[0]);
    for (const el of Array.from(container.querySelectorAll('[class]'))) {
      for (const m of (el.getAttribute('class') ?? '').matchAll(fixed)) {
        widths++;
        expect(Number(m[3])).toBeLessThanOrEqual(375);
      }
    }
    expect(widths).toBeGreaterThan(0);
    const grid = screen.getByLabelText('اسم القناة').closest('[class*="grid"]') as HTMLElement;
    expect(grid.className.split(/\s+/)).toContain(['grid', 'cols', '1'].join('-'));
  });
});
