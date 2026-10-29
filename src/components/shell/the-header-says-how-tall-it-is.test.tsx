// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE BAR PUBLISHES ITS HEIGHT, AND THE TWO THINGS THAT WERE GUESSING READ IT.
 *
 * The header grows when its group wraps (the-header-grows-when-it-wraps),
 * which made every «the window minus 72» wrong by the extra row:
 *
 *   • the WhatsApp inbox ran past the bottom of the window and the page
 *     scrolled under it (RV174);
 *   • the side menu's head line stopped meeting the bar's border once the
 *     bar wrapped, because one was 72 and the other was not (RV175).
 *
 * The bar writes `--sys-header-h` on the document; both read it with 72 as
 * the fallback for the moment before it has measured. jsdom draws no layout,
 * so the height is injected and what is checked is that it is PUBLISHED,
 * FOLLOWED and WITHDRAWN.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/lib/sign-out', () => ({ signOut: vi.fn() }));
vi.mock('@/components/shell/NotificationBell', () => ({ NotificationBell: () => <span /> }));
vi.mock('./MyWork', () => ({ MyWork: () => <span /> }));
vi.mock('./InstallApp', () => ({ InstallAppButton: () => <span /> }));
vi.mock('@/components/attendance/ShiftChip', () => ({ ShiftChip: () => <span /> }));

import { Header } from './Header';

const VAR = '--sys-header-h';
let height = 72;
let notify: (() => void) | null = null;
let disconnected = 0;
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

beforeEach(() => {
  height = 72;
  notify = null;
  disconnected = 0;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => height });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        notify = cb;
      }
      observe() {}
      disconnect() {
        disconnected += 1;
      }
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(VAR);
  if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original);
  else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
});

function draw() {
  return render(
    <Header
      onMenuClick={() => {}}
      onSearchClick={() => {}}
      userName="تجربة"
      userRole="SUPER_ADMIN"
      context={{ storeName: 'متجر', storePaused: false, countryName: 'الأردن', currencyCode: 'JOD', canSwitch: false }}
    />
  );
}
const published = () => document.documentElement.style.getPropertyValue(VAR);

describe('the header’s height', () => {
  it('is published on the document as soon as the bar is drawn', () => {
    height = 72;
    draw();
    expect(published()).toBe('72px');
  });

  it('follows the bar when its group wraps to a second row', () => {
    draw();
    height = 112;
    act(() => notify?.());
    expect(published(), 'الارتفاع ما تبع الشريط').toBe('112px');
    height = 72;
    act(() => notify?.());
    expect(published()).toBe('72px');
  });

  it('is withdrawn when the bar goes — no stale height for the next page', () => {
    const view = draw();
    expect(published()).toBe('72px');
    view.unmount();
    expect(published()).toBe('');
    expect(disconnected, 'المراقب بقي شغّالاً').toBe(1);
  });

  it('is still published where the browser has no observer — once, at the size it was drawn', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    height = 96;
    draw();
    expect(published()).toBe('96px');
  });
});

const src = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

describe('and the two that guessed read it', () => {
  it('the WhatsApp inbox is the window minus the bar AS IT IS, in the visible height', () => {
    const inbox = src('src/components/screens/WhatsAppInboxScreen.tsx');
    expect(inbox).toContain('calc(100dvh - var(--sys-header-h, 72px))');
    expect(inbox, 'الرقم الثابت رجع').not.toMatch(/calc\(100vh-72px\)/);
  });

  it('the side menu’s head is at least as tall as the bar, 72 until the bar has said', () => {
    const side = src('src/components/shell/Sidebar.tsx');
    expect(side).toContain("minHeight: 'var(--sys-header-h, 72px)'");
  });
});
