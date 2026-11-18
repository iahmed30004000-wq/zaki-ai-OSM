// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { stripComments } from '@/lib/guard-source';

/**
 * A PHONE COULD NOT SIGN OUT.
 *
 * The header's logout is `hidden md:block`, and deliberately so — its own
 * comment says «seven controls in a 375px bar is how a bell gets missed
 * and a logout gets hit». What never happened is the other half: nothing
 * took its place. The bottom bar is routes, the «كل الشاشات» sheet was
 * routes, and the command palette opens on Ctrl+K, which a phone has not
 * got.
 *
 * So a person working from a phone had no way out of the session. On a
 * shared warehouse handset that is not an inconvenience — the next person
 * to pick it up is still the last person logged in, with their
 * permissions, and every action they take is recorded as that person.
 *
 * Both halves are pinned here: the header's hiding (so nobody «fixes» it
 * back into the 375px bar) and the sheet's button (so it cannot quietly
 * go again).
 */

vi.mock('@/lib/sign-out', () => ({ signOut: (...a: unknown[]) => signOut(...a) }));
const signOut = vi.fn();

vi.mock('next/navigation', () => ({ usePathname: () => '/orders' }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('./BulkBar', () => ({ useBulkActive: () => false }));
vi.mock('@/lib/mobile-nav', () => ({
  mobileNav: () => ({
    primary: [
      { path: '/orders', label: 'الطلبات', icon: 'orders' },
      { path: '/ops/tracking', label: 'التتبّع', icon: 'tracking' },
    ],
    rest: [
      { key: 'g1', label: 'المال', routes: [{ path: '/finance', label: 'المالية', icon: 'finance' }] },
    ],
  }),
}));

import { MobileNav } from './MobileNav';

const HEADER = 'src/components/shell/Header.tsx';
const read = (p: string) => stripComments(readFileSync(join(process.cwd(), p), 'utf8'));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

/** The sheet is behind «المزيد»; everything below starts by opening it. */
async function openSheet(user: ReturnType<typeof userEvent.setup>) {
  render(<MobileNav groups={[] as never} />);
  await user.click(screen.getByText('المزيد'));
}

describe('the way out of a session, on a phone', () => {
  it('is in the «كل الشاشات» sheet, where the screens are', async () => {
    const user = userEvent.setup();
    await openSheet(user);
    expect(screen.getByRole('button', { name: /تسجيل الخروج/ })).toBeTruthy();
  });

  it('and pressing it actually signs out', async () => {
    const user = userEvent.setup();
    await openSheet(user);
    await user.click(screen.getByRole('button', { name: /تسجيل الخروج/ }));
    // The reason is recorded: a manual sign-out is not an idle timeout.
    expect(signOut).toHaveBeenCalledWith('manual');
  });

  it('and it is a 44px target, like everything else a thumb reaches for', async () => {
    const user = userEvent.setup();
    await openSheet(user);
    const out = screen.getByRole('button', { name: /تسجيل الخروج/ });
    expect(out.className).toContain('min-h-[44px]');
  });

  it('and it is not in the bar itself, which is the mistake it replaces', () => {
    /*
     * The header hid its logout because the button beside it is a
     * notification bell. Putting one back into the bottom bar would be the
     * same hazard, one bar lower: a mis-tap in a warehouse, with a hand
     * full of parcels, ending the session.
     */
    const src = stripComments(readFileSync(join(process.cwd(), 'src/components/shell/MobileNav.tsx'), 'utf8'));
    const bar = src.slice(src.indexOf('<nav'));
    expect(bar, 'الخروج داخل الشريط السفلي — بجانب ما يُضغط كل يوم').not.toContain('signOut');
  });
});

describe('and the header keeps hiding its own', () => {
  it('because seven controls in a 375px bar is the defect it was hidden for', () => {
    const header = read(HEADER);
    /*
     * 18/11 (R17d): the way out is the kit's `IconButton` now, so its name is `label="…"` and not
     * `aria-label="…"`, and it is hidden by its WRAPPER — `hidden` on the kit button itself loses to the
     * kit's `inline-flex` in the sheet. The old pin read `hidden md:block` off the button's own tag; it now
     * reads the wrapper that opens just before it, which says `hidden md:flex`. Same decision, same width.
     * (The rendered half — the button's parent is hidden, the button is not — is in
     * the-frame-controls-wear-the-kit.test.tsx.)
     */
    const at = header.indexOf('label="تسجيل الخروج"');
    expect(at, 'زر الخروج اختفى من الترويسة كلياً').toBeGreaterThan(0);
    const before = header.slice(0, at);
    const wrapper = before.slice(before.lastIndexOf('<span'), before.lastIndexOf('<IconButton'));
    expect(wrapper, 'عاد الخروج يظهر على الهاتف في الترويسة').toContain('hidden md:flex');
  });
});
