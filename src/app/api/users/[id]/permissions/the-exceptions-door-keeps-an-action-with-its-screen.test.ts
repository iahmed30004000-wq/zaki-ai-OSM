import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE EXCEPTIONS DOOR READS WHAT THE PERSON WOULD END UP HOLDING.
 *
 * An exception is laid over the role's keys, and the door judges the RESULT:
 * a «منع» on «عرض الطلبات» while the role still gives «تعديل الطلبات» leaves
 * an action without its screen — refused (`ORPHAN_ACTION`) unless the
 * exceptions deny the action with it. Only what the save ADDS is refused: a
 * pair the person already holds through their role (the shipped templates'
 * «عرض العملاء») keeps working, and the owner keeps saving their exceptions.
 *
 * The one-row removal is the same door by another handle: lifting an ALLOW on
 * a view, or a «منع» on an action, can create the same pair, so it asks too.
 *
 * And the list REPLACES the stored one, so it is saved only over the version
 * the screen read (RV171): `permissionsVersion`, claimed in the transaction
 * that writes.
 * ═══════════════════════════════════════════════════════════════════════
 */

const h = vi.hoisted(() => ({
  db: {
    user: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    role: { findUnique: vi.fn() },
    rolePermission: { findMany: vi.fn() },
    userPermission: { findMany: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    $transaction: vi.fn(),
  },
  actor: { id: 'owner', name: 'المالك', role: 'COMPANY_ADMIN', companyId: 'c1', status: 'ACTIVE' } as Record<string, unknown>,
  /** What the role of the person under edit gives, as keys. */
  roleKeys: [] as string[],
}));

vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/authorization', () => ({
  requirePermission: async () => h.actor,
  can: () => true,
  // The editor holds every key at full scope: who MAY grant is not what this file is about.
  getPermissionScope: () => ({ scope: 'ALL_COMPANY' }),
}));
vi.mock('@/lib/user-permissions', async (orig) => ({
  ...(await orig<typeof import('@/lib/user-permissions')>()),
  canActOnUser: async () => ({ ok: true }),
}));

import { PUT as replaceOverrides } from './route';
import { DELETE as removeOverride } from './[permission]/route';
import { keyLabel } from '@/lib/user-permissions';

const refusal = (view: string, action: string) => `لازم «${keyLabel(view)}» مع «${keyLabel(action)}»`;
const rowsOf = (keys: string[]) => keys.map((permission) => ({ permission, scope: 'ALL_COMPANY', scopeIds: null }));
const DENY = (permission: string) => ({ permission, effect: 'DENY', scope: null, scopeIds: null });
const ALLOW = (permission: string) => ({ permission, effect: 'ALLOW', scope: 'ALL_COMPANY', scopeIds: null });

beforeEach(() => {
  vi.clearAllMocks();
  h.roleKeys = [];
  h.db.user.findUnique.mockResolvedValue({
    id: 'agent', companyId: 'c1', role: 'CONFIRMATION_AGENT', name: 'ليلى', email: 'l@x', roleId: 'r-agent', permissionsVersion: 3,
  });
  h.db.user.updateMany.mockResolvedValue({ count: 1 });
  h.db.role.findUnique.mockResolvedValue({ id: 'r-agent', name: 'موظف تأكيد' });
  h.db.rolePermission.findMany.mockImplementation(async () => rowsOf(h.roleKeys));
  h.db.userPermission.findMany.mockResolvedValue([]);
  h.db.user.update.mockResolvedValue({});
  // Both shapes the doors use: a callback (the list) and an array of operations (the single removal).
  h.db.$transaction.mockImplementation(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(h.db) : arg));
});

describe('replacing the exceptions', () => {
  // `extra` is the rest of the body: the version, or nothing at all.
  const replace = (overrides: unknown[], extra: Record<string, unknown> = { version: 3 }) =>
    replaceOverrides(new Request('http://x', { method: 'PUT', body: JSON.stringify({ overrides, ...extra }) }), {
      params: Promise.resolve({ id: 'agent' }),
    });

  it('a «منع» on the screen key while the role still gives its action is refused — and nothing is written', async () => {
    h.roleKeys = ['orders.view', 'orders.edit'];
    const res = await replace([{ permission: 'orders.view', effect: 'DENY' }]);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.code).toBe('ORPHAN_ACTION');
    expect(body.error).toBe(refusal('orders.view', 'orders.edit'));
    expect(h.db.userPermission.deleteMany).not.toHaveBeenCalled();
    expect(h.db.user.updateMany).not.toHaveBeenCalled();
  });

  it('the same «منع» with the action denied beside it is saved', async () => {
    h.roleKeys = ['orders.view', 'orders.edit'];
    const res = await replace([
      { permission: 'orders.view', effect: 'DENY' },
      { permission: 'orders.edit', effect: 'DENY' },
    ]);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(h.db.userPermission.createMany).toHaveBeenCalledTimes(1);
  });

  it('a «منح» on an action when neither the role nor the list gives its screen key is refused', async () => {
    h.roleKeys = ['dashboard.view'];
    const res = await replace([{ permission: 'orders.edit', effect: 'ALLOW', scope: 'ALL_COMPANY' }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(refusal('orders.view', 'orders.edit'));
  });

  it('and is saved with its screen key beside it', async () => {
    h.roleKeys = ['dashboard.view'];
    const res = await replace([
      { permission: 'orders.view', effect: 'ALLOW', scope: 'ALL_COMPANY' },
      { permission: 'orders.edit', effect: 'ALLOW', scope: 'ALL_COMPANY' },
    ]);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('an old pair the person already holds through the role is left alone: an unrelated exception saves', async () => {
    // «عرض العملاء» without the basic tier — five shipped templates, nine people.
    h.roleKeys = ['customers.view', 'orders.view'];
    const res = await replace([{ permission: 'finance.view', effect: 'DENY' }]);
    expect(res.status, await res.clone().text()).toBe(200);
  });

  it('but a NEW pair beside the old one is refused, naming it', async () => {
    h.roleKeys = ['customers.view', 'orders.view', 'orders.edit'];
    const res = await replace([{ permission: 'orders.view', effect: 'DENY' }]);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(refusal('orders.view', 'orders.edit'));
  });

  describe('over the version it was read at', () => {
    beforeEach(() => {
      h.roleKeys = ['orders.view'];
    });

    it('the current version is saved, claimed on exactly that version in the transaction that writes', async () => {
      const res = await replace([{ permission: 'finance.view', effect: 'DENY' }], { version: 3 });
      expect(res.status, await res.clone().text()).toBe(200);
      expect(h.db.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'agent', permissionsVersion: 3 },
        data: { permissionsVersion: { increment: 1 } },
      });
    });

    it.each([[{ version: 2 }], [{ version: 4 }], [{}], [{ version: null }], [{ version: '3' }], [{ version: 3.5 }]])('body %o is refused with 409 and writes nothing', async (extra) => {
      const res = await replace([{ permission: 'finance.view', effect: 'DENY' }], extra);
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('STALE_VERSION');
      expect(body.error).toContain('حدّث الصفحة');
      expect(h.db.userPermission.deleteMany).not.toHaveBeenCalled();
      expect(h.db.userPermission.createMany).not.toHaveBeenCalled();
    });

    it('two saves of one version cannot both win: the loser of the claim is refused before it deletes anything', async () => {
      h.db.user.updateMany.mockResolvedValue({ count: 0 });
      const res = await replace([{ permission: 'finance.view', effect: 'DENY' }], { version: 3 });
      expect(res.status).toBe(409);
      expect(h.db.userPermission.deleteMany).not.toHaveBeenCalled();
      expect(h.db.userPermission.createMany).not.toHaveBeenCalled();
    });
  });
});

describe('removing one exception', () => {
  const remove = (permission: string) =>
    removeOverride(new Request('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'agent', permission }) });

  it('lifting the «منح» of a screen key from under an action that is still granted is refused', async () => {
    h.roleKeys = [];
    h.db.userPermission.findUnique.mockResolvedValue(ALLOW('orders.view'));
    h.db.userPermission.findMany.mockResolvedValue([ALLOW('orders.view'), ALLOW('orders.edit')]);
    const res = await remove('orders.view');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('ORPHAN_ACTION');
    expect(h.db.userPermission.delete).not.toHaveBeenCalled();
  });

  it('lifting the «منع» of an action while its screen key stays denied is refused: the action would come back without it', async () => {
    h.roleKeys = ['orders.view', 'orders.edit'];
    h.db.userPermission.findUnique.mockResolvedValue(DENY('orders.edit'));
    h.db.userPermission.findMany.mockResolvedValue([DENY('orders.view'), DENY('orders.edit')]);
    const res = await remove('orders.edit');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(refusal('orders.view', 'orders.edit'));
    expect(h.db.userPermission.delete).not.toHaveBeenCalled();
  });

  it('NEGATIVE: lifting a «منح» nothing depends on, and a «منع» whose screen key is held, are removed', async () => {
    h.roleKeys = ['orders.view', 'orders.edit'];
    h.db.userPermission.findUnique.mockResolvedValue(DENY('orders.edit'));
    h.db.userPermission.findMany.mockResolvedValue([DENY('orders.edit')]);
    expect((await remove('orders.edit')).status).toBeLessThan(300);

    h.db.userPermission.findUnique.mockResolvedValue(ALLOW('finance.create'));
    h.db.userPermission.findMany.mockResolvedValue([ALLOW('finance.create'), ALLOW('finance.view')]);
    expect((await remove('finance.create')).status).toBeLessThan(300);
  });

  it('a «منح» with nothing that needs it never even reads the other rows', async () => {
    h.db.userPermission.findUnique.mockResolvedValue(ALLOW('audit.view'));
    expect((await remove('audit.view')).status).toBeLessThan(300);
    expect(h.db.userPermission.findMany).not.toHaveBeenCalled();
  });
});
