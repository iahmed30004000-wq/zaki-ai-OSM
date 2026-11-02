import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «عنوان الانطلاق» IS REQUIRED ON A LOGESTECHS ACCOUNT.
 *
 * It was optional here (and unstarred on the form), and the courier refuses every parcel without it: BATCH-2026-0006
 * (2/11) came back «فشل 131», each «Invalid Parameter 'model.addressLine1' null». The save refuses a blank or
 * spaces-only one in Arabic and stores a typed one trimmed; an account for another platform is read as before.
 * The REAL adapter factory is used, so the account that is accepted is one that builds a working adapter.
 */

const { db, logAudit, encryptJson } = vi.hoisted(() => ({
  db: { deliveryProvider: { findFirst: vi.fn(), update: vi.fn() }, user: { findUnique: vi.fn() } },
  logAudit: vi.fn(),
  encryptJson: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/geo-context', () => ({
  requireContext: async () => ({ user: { id: 'admin', name: 'مدير' }, companyId: 'c1', storeId: 's1' }),
}));
vi.mock('@/lib/authorization', () => ({ requirePermission: async () => undefined }));
vi.mock('@/lib/couriers/scope', () => ({ courierScope: () => ({ companyId: 'c1' }) }));
vi.mock('@/lib/secrets', () => ({
  encryptJson: (...a: unknown[]) => encryptJson(...a),
  decryptJson: () => null,
  encryptionAvailable: () => true,
  secretHint: (s: string) => s.slice(-3),
}));

import { PUT } from './route';

const ACCOUNT = {
  email: 'shop@example.com',
  password: 'p'.repeat(10),
  companyId: 412,
  originCityId: 7,
  senderName: 'متجر صحة',
  senderPhone: '+962791234567',
};

const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'dp1' }),
  });

const sealed = () => encryptJson.mock.calls.map((c) => c[0] as Record<string, unknown>);

const provider = (over: Record<string, unknown> = {}) => ({
  id: 'dp1', name: 'Basha Delivery', adapterCode: 'LOGESTECHS', code: 'BASHA', apiEnabled: true,
  apiCredentials: null, credentialsUpdatedAt: null, credentialsUpdatedById: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryProvider.findFirst.mockResolvedValue(provider());
  db.deliveryProvider.update.mockResolvedValue({ id: 'dp1' });
  encryptJson.mockReturnValue('sealed');
});

describe('a LogesTechs account', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['spaces only', '    '],
  ])('origin address %s → 400, in Arabic, and nothing is stored', async (_label, originAddress) => {
    const res = await put({ ...ACCOUNT, ...(originAddress === undefined ? {} : { originAddress }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('عنوان الانطلاق مطلوب — الشركة بترفض كل طرد بدونه');
    expect(body.code).toBe('ORIGIN_ADDRESS_REQUIRED');
    expect(sealed()).toEqual([]);
    expect(db.deliveryProvider.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('a typed one is stored, trimmed', async () => {
    const res = await put({ ...ACCOUNT, originAddress: '  دمشق — المستودع  ' });
    expect(res.status).toBe(200);
    expect(sealed()).toHaveLength(1);
    expect(sealed()[0].originAddress).toBe('دمشق — المستودع');
  });

  it('is recognised by its own code too, when the platform is not named separately', async () => {
    db.deliveryProvider.findFirst.mockResolvedValue(provider({ adapterCode: null, code: 'logestechs' }));
    const res = await put(ACCOUNT);
    expect(res.status).toBe(400);
    expect(sealed()).toEqual([]);
  });
});

describe('NEGATIVE: an account on another platform is read as it always was', () => {
  it.each([
    ['a manual courier', { adapterCode: 'MANUAL', code: 'HALA' }],
    ['a courier with no platform named', { adapterCode: null, code: 'HALA' }],
  ])('%s: a blank origin is accepted', async (_label, over) => {
    db.deliveryProvider.findFirst.mockResolvedValue(provider(over));
    const res = await put(ACCOUNT);
    expect(res.status).toBe(200);
    expect(sealed()).toHaveLength(1);
    expect(sealed()[0].originAddress).toBeUndefined();
  });
});
