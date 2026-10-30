import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «رابط الـAPI (اتركه فارغاً للافتراضي)» — and the box left empty was stored as `''`, which sent every parcel of a
 * batch to a bare path. Asserted on THE ACCOUNT HANDED TO `encryptJson`, i.e. what would be stored.
 */

const { db, logAudit, encryptJson, logesTechsFromCredentials } = vi.hoisted(() => ({
  db: { deliveryProvider: { findFirst: vi.fn(), update: vi.fn() }, user: { findUnique: vi.fn() } },
  logAudit: vi.fn(),
  encryptJson: vi.fn(),
  logesTechsFromCredentials: vi.fn(),
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
vi.mock('@/lib/couriers/logestechs', () => ({
  logesTechsFromCredentials: (...a: unknown[]) => logesTechsFromCredentials(...a),
}));

import { PUT } from './route';

const SOUND = {
  email: 'shop@example.com',
  password: 'p'.repeat(10),
  companyId: 412,
  originCityId: 7,
  senderName: 'متجر صحة',
  senderPhone: '+962791234567',
};
const put = (body: unknown) =>
  PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'dp1' }) });
const stored = () => encryptJson.mock.calls[0]?.[0] as Record<string, unknown> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryProvider.findFirst.mockResolvedValue({
    id: 'dp1', name: 'Basha Delivery', adapterCode: 'LOGESTECHS', code: 'BASHA', apiEnabled: true,
    apiCredentials: null, credentialsUpdatedAt: null, credentialsUpdatedById: null,
  });
  db.deliveryProvider.update.mockResolvedValue({ id: 'dp1' });
  encryptJson.mockReturnValue('sealed');
  logesTechsFromCredentials.mockReturnValue({ code: 'LOGESTECHS' });
});

describe('the API address box', () => {
  it('left empty, is stored as nothing — the official address is used', async () => {
    await put({ ...SOUND, baseUrl: '   ' });
    expect(stored()).toBeTruthy();
    expect(stored()!.baseUrl).toBeUndefined();
  });

  it('a real address is kept', async () => {
    await put({ ...SOUND, baseUrl: 'https://staging.logestechs.com/api' });
    expect(stored()!.baseUrl).toBe('https://staging.logestechs.com/api');
  });

  it('NEGATIVE: an address that is not one is refused, in Arabic, and nothing is stored', async () => {
    const res = await put({ ...SOUND, baseUrl: '/ship' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('https://');
    expect(encryptJson).not.toHaveBeenCalled();
  });
});
