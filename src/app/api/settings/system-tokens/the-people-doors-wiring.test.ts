import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THREE DOORS, ASKED THE RULES BEFORE THEY WRITE.
 *
 * The rules are tested in src/lib/people-act-within-their-reach. Here, that
 * the doors actually ask them:
 *
 *   · minting an API key wider than the minter holds is refused, and no key exists;
 *   · the audit log takes the amounts out of pay rows for a reader without
 *     «عرض الرواتب», and leaves them for one with it;
 *   · creating an account by role NAME checks the system template the engine
 *     will grant — not the in-code matrix, empty for the supervisor and the
 *     warehouse, which let the check pass with nothing to check.
 */

const h = vi.hoisted(() => ({
  db: {
    systemToken: { findMany: vi.fn(), create: vi.fn() },
    auditLog: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
    user: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), count: vi.fn() },
    role: { findFirst: vi.fn(), findUnique: vi.fn() },
    rolePermission: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
  held: { keys: {} as Record<string, string> },
  actor: { id: 'u1', role: 'COMPANY_ADMIN', companyId: 'c1', status: 'ACTIVE', name: 'أ' } as Record<string, unknown>,
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/auth', () => ({
  requireCompanyTenant: async () => ({ user: h.actor, companyId: 'c1' }),
  hashPassword: async () => 'hashed',
  resolveSingleCompanyId: async () => 'c1',
}));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => h.actor,
  can: (_u: unknown, k: string) => k in h.held.keys,
  getPermissionScope: (_u: unknown, k: string) => (k in h.held.keys ? { scope: h.held.keys[k] } : null),
}));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(), redactCustomerForAudit: (c: unknown) => c }));
vi.mock('@/lib/geo-access', () => ({ geoAccessError: async () => null, replaceGeoAccess: vi.fn() }));
vi.mock('@/lib/role-names', async (orig) => ({
  ...(await orig<typeof import('@/lib/role-names')>()),
  isPrivilegedRoleName: () => false,
  isReservedRoleName: () => false,
}));

import { POST as mint } from './route';
import { GET as auditLogs } from '@/app/api/audit-logs/route';
import { POST as createUser } from '@/app/api/users/route';
import { GET as tokenShelf } from './route';
import { PATCH as editRole, DELETE as deleteRole } from '@/app/api/roles/[id]/route';

beforeEach(() => {
  vi.clearAllMocks();
  h.held.keys = { 'apps.manage': 'ALL_COMPANY', 'products.view': 'ALL_COMPANY', 'geo.manage': 'ALL_COMPANY' };
  h.db.systemToken.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({ id: 't1', createdAt: new Date(), ...data }));
});

describe('minting an API key', () => {
  const asks = (scopes: string[]) =>
    mint(new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'الميديا باير', system: 'mediabuyer', scopes, days: 90 }) }));

  it('a key to the cost of goods, minted without «عرض المالية»: refused, and no key exists', async () => {
    const res = await asks(['products.read', 'products.costs.read']);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.code).toBe('SCOPE_BEYOND_MINTER');
    expect(body.errorAr).toContain('قراءة تكلفة المنتج');
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });

  it('the same key, minted by somebody who holds both', async () => {
    h.held.keys['finance.view'] = 'ALL_COMPANY';
    h.held.keys['costs.view'] = 'ALL_COMPANY'; // PR-10: whoever mints the cost key must see the cost
    const res = await asks(['products.read', 'products.costs.read']);
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect(h.db.systemToken.create).toHaveBeenCalled();
  });
});

describe('the audit log', () => {
  beforeEach(() => {
    h.db.auditLog.count.mockResolvedValue(1);
    h.db.auditLog.groupBy.mockResolvedValue([]);
    h.db.user.findMany.mockResolvedValue([]);
    h.db.auditLog.findMany.mockResolvedValue([
      { id: 'a1', action: 'SALARY_PAID', entity: 'Payslip', entityId: 'p1', previousData: null, newData: JSON.stringify({ month: '2026-10', net: 380, paid: 380 }), createdAt: new Date(), user: null },
    ]);
  });
  const read = async () => (await (await auditLogs(new Request('http://x/api/audit-logs'))).json()).logs[0];

  it('a payslip row without «عرض الرواتب»: the row, without its amounts', async () => {
    h.held.keys = { 'audit.view': 'ALL_COMPANY' };
    const row = await read();
    expect(row.action).toBe('SALARY_PAID');
    expect(row.payWithheld).toBe(true);
    expect(JSON.parse(row.newData)).toEqual({ month: '2026-10' });
  });

  it('with it: the amounts', async () => {
    h.held.keys = { 'audit.view': 'ALL_COMPANY', 'payroll.view': 'ALL_COMPANY' };
    expect(JSON.parse((await read()).newData).net).toBe(380);
  });
});

describe('creating an account by role name', () => {
  const create = (role: string) =>
    createUser(new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'موظف جديد', email: 'n@x.test', password: 'Passw0rdOk', role }) }));

  beforeEach(() => {
    h.db.user.findUnique.mockResolvedValue(null);
    h.db.user.create.mockResolvedValue({ id: 'u-new', role: 'CONFIRMATION_SUPERVISOR', status: 'ACTIVE' });
    h.db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(h.db));
    h.db.role.findFirst.mockResolvedValue({ id: 'sys-supervisor', _count: { permissions: 2 } });
  });

  it('checks the system template the engine will grant: refused when it carries what the creator lacks', async () => {
    h.held.keys = { 'users.create': 'ALL_COMPANY' };
    h.db.rolePermission.findMany.mockResolvedValue([
      { permission: 'confirmation.supervise', scope: 'ALL_COMPANY', scopeIds: null },
      { permission: 'control.change_requests', scope: 'ALL_COMPANY', scopeIds: null },
    ]);
    const res = await create('CONFIRMATION_SUPERVISOR');
    expect(res.status).toBe(403);
    expect(h.db.role.findFirst.mock.calls[0][0].where).toEqual({ companyId: null, name: 'CONFIRMATION_SUPERVISOR' });
    expect(h.db.rolePermission.findMany.mock.calls[0][0].where).toEqual({ roleId: 'sys-supervisor' });
    expect(h.db.user.create).not.toHaveBeenCalled();
  });

  it('and lets the creator through who holds it all', async () => {
    h.held.keys = { 'users.create': 'ALL_COMPANY', 'confirmation.supervise': 'ALL_COMPANY', 'control.change_requests': 'ALL_COMPANY' };
    h.db.rolePermission.findMany.mockResolvedValue([
      { permission: 'confirmation.supervise', scope: 'ALL_COMPANY', scopeIds: null },
      { permission: 'control.change_requests', scope: 'ALL_COMPANY', scopeIds: null },
    ]);
    const res = await create('CONFIRMATION_SUPERVISOR');
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  });
});

describe('minting needs every store', () => {
  it('a minter confined to some stores is refused — a key reads them all', async () => {
    h.held.keys = { 'apps.manage': 'ALL_COMPANY', 'products.view': 'ALL_COMPANY' };
    const res = await mint(new Request('http://x', { method: 'POST', body: JSON.stringify({ name: 'الردود', system: 'replies', scopes: ['products.read'], days: 90 }) }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('MINTER_NOT_ALL_STORES');
    expect(h.db.systemToken.create).not.toHaveBeenCalled();
  });

  it('the shelf says, per scope, what this person may put on a key — before «أنشئ»', async () => {
    h.db.systemToken.findMany.mockResolvedValue([]);
    const shelf = await (await tokenShelf()).json();
    const costs = shelf.scopeCatalog.find((s: { key: string }) => s.key === 'products.costs.read');
    expect(costs.mintable).toBe(false);
    expect(costs.needsAr).toBeTruthy();
    expect(shelf.scopeCatalog.find((s: { key: string }) => s.key === 'products.read').mintable).toBe(true);
    expect(shelf.mayMint).toBe(true);
  });
});

describe('a role as it stands, before it is rewritten or emptied', () => {
  const ROLE = {
    id: 'r-admins', name: 'مدراء الفروع', companyId: 'c1', isSystem: false,
    permissions: [
      { permission: 'orders.view', scope: 'ALL_COMPANY', scopeIds: null },
      { permission: 'finance.view', scope: 'ALL_COMPANY', scopeIds: null },
    ],
  };
  beforeEach(() => {
    h.db.role.findUnique.mockResolvedValue(ROLE);
    h.db.rolePermission.findMany.mockResolvedValue(ROLE.permissions);
  });

  it('saving it without «عرض المالية» — the one key the editor lacks — is refused: it would strip it from everyone on the role', async () => {
    h.held.keys = { 'roles.edit': 'ALL_COMPANY', 'orders.view': 'ALL_COMPANY' };
    const res = await editRole(
      new Request('http://x', { method: 'PATCH', body: JSON.stringify({ permissions: [{ permission: 'orders.view', scope: 'ALL_COMPANY' }] }) }),
      { params: Promise.resolve({ id: 'r-admins' }) },
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('عرض المالية');
  });

  it('moving everybody off it, by someone who could not have given it: refused', async () => {
    h.held.keys = { 'roles.delete': 'ALL_COMPANY', 'orders.view': 'ALL_COMPANY' };
    h.db.user.count.mockResolvedValue(3);
    h.db.role.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'r-admins' ? ROLE : { id: 'r-weak', name: 'ضعيف', companyId: 'c1', isSystem: false, permissions: [] },
    );
    const res = await deleteRole(new Request('http://x/api/roles/r-admins?replacementRoleId=r-weak', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'r-admins' }),
    });
    expect(res.status).toBe(403);
  });
});
