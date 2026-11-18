// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * «الملف الشخصي» IS NOBODY'S MENU LINE — AND EVERYBODY STILL HAS A DOOR TO IT.
 *
 * 18/11 (R6, nine groups and ten lines): the profile sat in «الإدارة», and for a
 * warehouse hand it was the whole of that line. It is `offMenu` now, so its doors
 * are two that every person has whatever they may open: their name in the header
 * (from `sm` up) and a line at the bottom of the phone's «المزيد» sheet (under `md`).
 * Between them every width is covered — the sheet's bar is `md:hidden`, and the
 * name shows from 640px.
 * ═══════════════════════════════════════════════════════════════════════
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/orders' }));
vi.mock('@/lib/sign-out', () => ({ signOut: vi.fn() }));
vi.mock('@/components/shell/NotificationBell', () => ({ NotificationBell: () => <span /> }));
vi.mock('./MyWork', () => ({ MyWork: () => <span /> }));
vi.mock('./InstallApp', () => ({ InstallAppButton: () => <span />, InstallAppLine: () => null }));
vi.mock('@/components/attendance/ShiftChip', () => ({ ShiftChip: () => <span /> }));
vi.mock('./BulkBar', () => ({ useBulkActive: () => false }));

import { Header } from './Header';
import { MobileNav } from './MobileNav';
import { findRoute, menuNav, type NavGroup } from '@/lib/route-registry';
import type { SessionUser } from '@/types/auth';

afterEach(() => cleanup());

const menuOf = (...permissions: string[]): NavGroup[] =>
  menuNav({ id: 'u1', role: 'MODERATOR', status: 'ACTIVE' } as unknown as SessionUser, (_user, p) => permissions.includes(p));

/** Five people, from the owner to one who may open a single station and nothing in «الإدارة». */
const PEOPLE: Record<string, string[]> = {
  owner: ['dashboard.view', 'orders.view', 'settings.view', 'users.view', 'roles.view', 'audit.view', 'finance.view'],
  'confirmation agent': ['confirmation.pull', 'confirmation.work'],
  warehouse: ['ops.prepare', 'inventory.view', 'products.view'],
  accountant: ['finance.cashbox_view', 'finance.view', 'settlement.view'],
  moderator: ['orders.view', 'customers.view', 'confirmation.issues'],
};

describe('the profile', () => {
  it('— is no line of anybody’s menu, and stays a registry route with its guard and title', () => {
    expect(findRoute('/admin/profile')?.offMenu).toBe(true);
    expect(findRoute('/admin/profile')?.permissions).toBeNull();
    for (const [who, keys] of Object.entries(PEOPLE)) {
      const paths = menuOf(...keys).flatMap((g) => g.routes.map((r) => r.path));
      expect(paths, who).not.toContain('/admin/profile');
    }
  });

  it('and the header’s name opens it — the same for every role', () => {
    for (const role of ['SUPER_ADMIN', 'WAREHOUSE', 'CONFIRMATION_AGENT', 'ACCOUNTANT', 'MODERATOR']) {
      render(
        <Header
          onMenuClick={() => undefined}
          onSearchClick={() => undefined}
          userName="موظف تجريبي"
          userRole={role}
          context={{ storeName: 'متجر', storePaused: false, countryName: 'بلد', currencyCode: 'XXX', canSwitch: false }}
        />
      );
      const door = screen.getByRole('link', { name: /موظف تجريبي/ });
      expect(door.getAttribute('href'), role).toBe('/admin/profile');
      expect(door.getAttribute('title')).toBe('الملف الشخصي');
      cleanup();
    }
  });

  it('and the phone’s «المزيد» has its line at the bottom — for every role, including one with no other admin screen', () => {
    for (const [who, keys] of Object.entries(PEOPLE)) {
      render(<MobileNav groups={menuOf(...keys)} />);
      fireEvent.click(screen.getByRole('button', { name: 'المزيد' }));
      const sheet = screen.getByRole('dialog', { name: 'كل الشاشات' });
      const links = within(sheet).getAllByRole('link');
      const last = links[links.length - 1];
      expect(last.textContent, who).toBe('الملف الشخصي');
      expect(last.getAttribute('href'), who).toBe('/admin/profile');
      // And never twice: the menu itself does not carry it.
      expect(links.filter((a) => a.getAttribute('href') === '/admin/profile'), who).toHaveLength(1);
      cleanup();
    }
  });

  it('and the warehouse hand has no «الإدارة» line at all — the profile was all of it', () => {
    const groups = menuOf(...PEOPLE.warehouse);
    expect(groups.map((g) => g.key)).not.toContain('admin');
  });
});
