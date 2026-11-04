import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Structure gate: every contract route resolves to a page, nothing outside
 * the contract does, and the guard answers 404 / 403 / redirect correctly.
 */

const { getCurrentUser, cookies, redirect, forbidden, notFound, db } = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  cookies: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
  forbidden: vi.fn(() => {
    throw new Error('FORBIDDEN');
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  db: {
    store: { findFirst: vi.fn(), findMany: vi.fn() },
    company: { findFirst: vi.fn() },
    country: { findFirst: vi.fn() },
    userStoreAccess: { findMany: vi.fn() },
  },
}));

/*
 * Ruling 4/11: two devices. The guard now asks the VERDICT — who, and if nobody, why — so a device a newer sign-in
 * ended can be told so. Here it is drawn from `getCurrentUser`'s mock, with the reason in `ended.reason`.
 */
const ended = vi.hoisted(() => ({ reason: 'NONE' as 'NONE' | 'REPLACED' }));
vi.mock('./auth', () => ({
  getCurrentUser: (...a: unknown[]) => getCurrentUser(...a),
  getSessionVerdict: async (...a: unknown[]) => {
    const user = await getCurrentUser(...a);
    return user ? { user } : { user: null, reason: ended.reason };
  },
}));
vi.mock('./db', () => ({ db }));
vi.mock('next/headers', () => ({ cookies: (...a: unknown[]) => cookies(...a) }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  forbidden: () => forbidden(),
  notFound: () => notFound(),
}));

import { guardRoute } from './page-guard';
import { ALL_ROUTES } from './route-registry';
import { attachGrants } from './authorization';
import { signSelection } from './geo-context';

const APP = path.join(process.cwd(), 'src', 'app', '(system)', '(shell)');

function pageFileFor(routePath: string) {
  return path.join(APP, routePath, 'page.tsx');
}

describe('every contract route has a page', () => {
  it.each(ALL_ROUTES.map((r) => r.path))('%s', (routePath) => {
    expect(fs.existsSync(pageFileFor(routePath)), `missing page for ${routePath}`).toBe(true);
  });

  it('no page exists outside the contract (detail sub-routes aside)', () => {
    const pages: string[] = [];
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}/${entry.name}`);
        else if (entry.name === 'page.tsx') pages.push(prefix || '/');
      }
    };
    walk(APP, '');
    const contract = new Set(ALL_ROUTES.map((r) => r.path));
    const extras = pages.filter((p) => !contract.has(p));
    // Only detail screens of a listed route may exist beside it.
    expect(extras.sort()).toEqual([
      '/admin/users/[id]',
      // An order's address: a door to the panel the list already opens.
      '/orders/[id]',
      '/products/[id]',
      '/store/landing-pages/[id]',
      '/store/landing-pages/[id]/editor',
      // «مكتبة القوالب» — the second tab of the landing pages' own entry,
      // under its gate; the menu group stays at two entries by ruling.
      '/store/landing-pages/library',
    ]);
  });

  it('the deleted CRM screens are gone', () => {
    expect(fs.existsSync(path.join(process.cwd(), 'src', 'app', 'dashboards'))).toBe(false);
    expect(fs.existsSync(path.join(process.cwd(), 'src', 'lib', 'crm.ts'))).toBe(false);
  });
});

describe('guardRoute', () => {
  const COMPANY = 'c1';
  const COUNTRY = '11111111-1111-4111-8111-111111111111';
  const STORE = '33333333-3333-4333-8333-333333333333';

  const moderator = attachGrants(
    { id: 'u1', name: 'Sara', role: 'MODERATOR', status: 'ACTIVE', companyId: COMPANY, permissions: [] } as any,
    { fullAccess: false, grants: { 'orders.view': { scope: 'OWN' }, 'confirmation.issues': { scope: 'ALL_COMPANY' } } }
  );

  beforeEach(async () => {
    vi.clearAllMocks();
    getCurrentUser.mockResolvedValue(moderator);
    const token = await signSelection(moderator.id, { countryId: COUNTRY, storeId: STORE });
    cookies.mockResolvedValue({ get: () => ({ value: token }) });
    db.country.findFirst.mockResolvedValue({ id: COUNTRY });
    db.store.findMany.mockResolvedValue([{ id: STORE }]);
    db.userStoreAccess.findMany.mockResolvedValue([]); // no narrowing: every store of the country
    db.store.findFirst.mockResolvedValue({
      id: STORE, name: 'Main', logo: null, status: 'ACTIVE',
      country: { id: COUNTRY, name: 'الأردن', code: 'JO', currencyCode: 'JOD' },
    });
  });

  it('404s a path outside the contract without even loading the session', async () => {
    await expect(guardRoute('/dashboards/crm')).rejects.toThrow('NOT_FOUND');
    expect(getCurrentUser).not.toHaveBeenCalled();
  });

  it('403s a moderator on /confirmation/queue', async () => {
    await expect(guardRoute('/confirmation/queue')).rejects.toThrow('FORBIDDEN');
  });

  it('allows the moderator on /confirmation/issues', async () => {
    const { route } = await guardRoute('/confirmation/issues');
    expect(route.path).toBe('/confirmation/issues');
    expect(forbidden).not.toHaveBeenCalled();
  });

  it('sends a user without a selected store to the picker', async () => {
    cookies.mockResolvedValue({ get: () => undefined });
    await expect(guardRoute('/orders')).rejects.toThrow('REDIRECT:/entry');
  });

  it('sends a signed-out visitor to login', async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(guardRoute('/orders')).rejects.toThrow('REDIRECT:/login');
  });

  /*
   * THE OWNER'S RULING 4/11 — the two answers that used to be one «signed out».
   */
  it('tells a device a third sign-in ended why it is on the login page', async () => {
    getCurrentUser.mockResolvedValue(null);
    ended.reason = 'REPLACED';
    try {
      await expect(guardRoute('/orders')).rejects.toThrow('REDIRECT:/login?replaced=1');
    } finally {
      ended.reason = 'NONE';
    }
  });

  it('a database that did not answer is the error screen, never the login page', async () => {
    const { AuthBackendDown } = await import('./auth-errors');
    getCurrentUser.mockRejectedValue(new AuthBackendDown());
    await expect(guardRoute('/orders')).rejects.toBeInstanceOf(AuthBackendDown);
    expect(redirect, 'خطأ بالقاعدة صار تسجيل خروج').not.toHaveBeenCalled();
  });
});
