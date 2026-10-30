import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * «+ أنشئ» — THE DOOR DRAWS THE ROWS FOR THE ACCOUNT THAT ASKED (22/10).
 *
 * The box carries no list of forms; `GET /api/palette` sends the rows that survive `creatablesFor` (the screen must be openable AND
 * the form's own permission held), inside the same `may` that already says whether «اسحب» is offered. Three things must hold at THIS
 * door, whatever the list says:
 *
 *   1. what arrives is the account's own list, not the company's — an owner is told seven, a desk two, a pending account none;
 *   2. it arrives on BOTH paths: an account with no orders grant takes the early return (five honest zeroes), and a product manager
 *      is exactly that account — a form row that only the long path carried would be missing for the people who most need it;
 *   3. a row says what it is for, and nothing about who may have it: no permission key, no registry path, nothing the browser could
 *      learn about the shape of the system from an answer it was always going to receive.
 */

const { db, requireContext } = vi.hoisted(() => ({
  db: {
    order: { count: vi.fn() },
    product: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
  requireContext: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: (u: { __perms?: string[] }, p: string) => (u.__perms ?? []).includes(p),
  requirePermission: vi.fn(),
  getPermissionScope: (u: { __scope?: string }) => (u.__scope ? { scope: u.__scope } : null),
}));
vi.mock('@/lib/api-error', () => ({
  apiErrorResponse: (e: unknown) =>
    new Response(JSON.stringify({ error: `UNEXPECTED: ${(e as Error)?.message}` }), { status: 500 }),
}));

import { GET } from './route';

const account = (perms: string[], over: Record<string, unknown> = {}) => ({
  id: 'u1',
  status: 'ACTIVE',
  role: 'CONFIRMATION_AGENT',
  companyId: 'c1',
  __scope: 'ASSIGNED',
  __perms: perms,
  ...over,
});

const asUser = (user: unknown) =>
  requireContext.mockResolvedValue({ user, companyId: 'c1', storeId: 's1' });

const told = async () => {
  const res = await GET();
  expect(res.status).toBe(200);
  return (await res.json()) as { may: { create: { key: string; href: string }[] } };
};

beforeEach(() => {
  vi.clearAllMocks();
  db.order.count.mockResolvedValue(0);
  db.product.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
});

describe('the account is told its own list', () => {
  it('an owner of every screen is told all seven forms', async () => {
    asUser(
      account(
        [
          'orders.view', 'orders.create', 'orders.import',
          'products.view', 'products.create',
          'customers.view', 'customers.create',
          'users.view', 'users.create',
          // was: 'reports.view' — the campaigns left the reports key (PR-11): the screen opens on campaigns.view, the form is campaigns.manage.
          'campaigns.view', 'campaigns.manage',
        ],
        { role: 'COMPANY_ADMIN', __scope: 'ALL_COMPANY' }
      )
    );
    const { may } = await told();
    expect(may.create.map((r) => r.key)).toEqual([
      'order', 'ai-order', 'import-orders', 'product', 'customer', 'user', 'campaign',
    ]);
  });

  it('NEGATIVE: without campaigns.manage the campaign form is not offered — the old reports key, or the view alone, is not enough', async () => {
    for (const perms of [['reports.view'], ['campaigns.view'], ['campaigns.manage']]) {
      asUser(account(perms, { role: 'COMPANY_ADMIN', __scope: 'ALL_COMPANY' }));
      const { may } = await told();
      expect(may.create.map((r) => r.key), perms.join()).not.toContain('campaign');
    }
  });

  it('a desk that creates orders is told the two order forms, with their addresses', async () => {
    asUser(account(['orders.view', 'orders.create']));
    const { may } = await told();
    expect(may.create.map((r) => [r.key, r.href])).toEqual([
      ['order', '/orders?new=order'],
      ['ai-order', '/orders?new=ai-order'],
    ]);
  });

  it('an account that holds nothing is told none — and the door still answers 200, because the box is also the way to a screen', async () => {
    asUser(account([], { __scope: undefined }));
    const { may } = await told();
    expect(may.create).toEqual([]);
  });

  it('and one that is not active is told none, whatever it holds', async () => {
    asUser(account(['orders.view', 'orders.create'], { status: 'SUSPENDED' }));
    const { may } = await told();
    expect(may.create).toEqual([]);
  });
});

describe('it arrives on the short path too', () => {
  it('— a product manager has no orders grant, so the summary returns early, and the form is in it', async () => {
    asUser(account(['products.view', 'products.create'], { __scope: undefined }));
    const body = (await (await GET()).json()) as { facts: unknown[]; may: { create: { key: string }[] } };
    expect(body.facts, 'مش الطريق القصير').toEqual([]);
    expect(db.order.count, 'سُئلت قاعدة البيانات').not.toHaveBeenCalled();
    expect(body.may.create.map((r) => r.key)).toEqual(['product']);
  });
});

describe('a row says what it is for and nothing about who may have it', () => {
  it('— six fields, none of them a permission key or a registry path', async () => {
    asUser(account(['products.view', 'products.create'], { __scope: undefined }));
    const { may } = await told();
    const row = may.create[0];
    expect(Object.keys(row).sort()).toEqual(['hint', 'href', 'icon', 'key', 'label', 'words']);
    const printed = JSON.stringify(row);
    expect(printed).not.toContain('products.create');
    expect(printed).not.toContain('needs');
  });

  it('— and the door takes no parameter that could ask for somebody else’s list', () => {
    const src = stripComments(repoFile('src/app/api/palette/route.ts'));
    expect(src).toMatch(/export async function GET\(\)/);
    expect(src).toContain('create: creatablesFor(user, can)');
  });
});
