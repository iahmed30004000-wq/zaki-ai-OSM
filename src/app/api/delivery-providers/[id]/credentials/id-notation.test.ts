import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE COURIER ACCOUNT'S IDS — AND WHY THE AUDIT'S VERDICT WAS WRONG.
 *
 * `PUT /api/delivery-providers/:id/credentials` read five numeric ids with
 * `z.coerce.number()`, which IS `Number()`: `'0x10'` → 16, `'0b11'` → 3,
 * `'0o17'` → 15, `['5']` → 5, `true` → 1 (all measured here before the
 * refusal is asserted).
 *
 * The audit filed it as «real but low — fails at the courier, not in our
 * books». TWO of the five do not fail at the courier at all:
 *
 *   `originCityId` is sent as `originAddress.cityId` on every shipment
 *   (`couriers/logestechs.ts`, `createShipment`). A valid-but-wrong city id
 *   produces a SUCCESSFUL shipment, with a barcode, for collection from a
 *   city we are not in. Nothing fails; a pickup simply never happens, and
 *   it looks like the courier's fault days later.
 *
 *   `companyId` is the key of our OWN outbound rate-limit bucket,
 *   `paced('logestechs:' + companyId)` — whose own comment says crossing
 *   the courier's limit suspends the account for a working day. That is
 *   wrong on this side of the wire, before their server has an opinion. It
 *   is also a path segment on `/guests/{companyId}/packages/pdf` and on the
 *   `…/packages/cancel` WRITE; what their server does with another
 *   merchant's id is NOT established here and this guard does not need it.
 *
 * The three type ids had NO MINIMUM at all, so a negative stored, and NONE
 * of the five had a ceiling, so `'1e15'` stored. Both are closed.
 *
 * Every case asserts THE ROW HANDED TO PRISMA before the status code.
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
  PUT(new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'dp1' }),
  });

/** What was handed to `encryptJson` — i.e. what would have been stored. */
const sealed = () => encryptJson.mock.calls.map((c) => c[0] as Record<string, unknown>);

beforeEach(() => {
  vi.clearAllMocks();
  db.deliveryProvider.findFirst.mockResolvedValue({
    id: 'dp1',
    name: 'Basha Delivery',
    adapterCode: 'LOGESTECHS',
    code: 'BASHA',
    apiEnabled: true,
    apiCredentials: null,
    credentialsUpdatedAt: null,
    credentialsUpdatedById: null,
  });
  db.deliveryProvider.update.mockResolvedValue({ id: 'dp1' });
  encryptJson.mockReturnValue('sealed');
  logesTechsFromCredentials.mockReturnValue({ code: 'LOGESTECHS' });
});

const PREFIXED = [
  ['0x10', 16],
  ['0X10', 16],
  ['0b11', 3],
  ['0o17', 15],
] as const;

describe('the courier company id — the rate-limit bucket key and a URL path segment', () => {
  it.each(PREFIXED)('refuses «%s», which Number() reads as %i', async (typed, wouldStore) => {
    expect(Number(typed), 'the hazard is measured at the door, not remembered').toBe(wouldStore);
    const res = await put({ ...SOUND, companyId: typed });
    expect(
      sealed().map((c) => c.companyId),
      `«${typed}» would have been sealed into the credentials as ${wouldStore}, then interpolated into /guests/${wouldStore}/packages/cancel and used as the paced() bucket key`
    ).toEqual([]);
    expect(db.deliveryProvider.update).not.toHaveBeenCalled();
    expect(res.status).toBe(400);
  });

  it("refuses a one-element array, though Number(['412']) is 412", async () => {
    expect(Number(['412'])).toBe(412);
    const res = await put({ ...SOUND, companyId: ['412'] });
    expect(sealed()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('refuses true, though Number(true) is 1 and account 1 is somebody', async () => {
    expect(Number(true)).toBe(1);
    const res = await put({ ...SOUND, companyId: true });
    expect(sealed()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('keeps the minimum of one it always had — account zero is not an account', async () => {
    const res = await put({ ...SOUND, companyId: 0 });
    expect(sealed()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('closes the ceiling that was missing: 1e15 no longer seals', async () => {
    expect(Number('1e15'), 'written in digits, so notation alone would not catch it').toBe(1e15);
    const res = await put({ ...SOUND, companyId: '1e15' });
    expect(sealed()).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('seals a real id, and a numeric string from a form', async () => {
    expect((await put(SOUND)).status).toBe(200);
    expect(sealed()[0]).toMatchObject({ companyId: 412, originCityId: 7 });
    encryptJson.mockClear();
    expect((await put({ ...SOUND, companyId: '412' })).status).toBe(200);
    expect(sealed()[0]).toMatchObject({ companyId: 412 });
  });
});

describe('the origin city id — a wrong one succeeds at the courier and never gets collected', () => {
  it.each(PREFIXED)('refuses «%s», which Number() reads as %i', async (typed, wouldStore) => {
    expect(Number(typed)).toBe(wouldStore);
    const res = await put({ ...SOUND, originCityId: typed });
    expect(
      sealed().map((c) => c.originCityId),
      `city ${wouldStore} would have been sealed and sent as originAddress.cityId on every shipment — created successfully, collected from nowhere`
    ).toEqual([]);
    expect(res.status).toBe(400);
  });

  it('keeps the minimum of one it always had', async () => {
    const res = await put({ ...SOUND, originCityId: 0 });
    expect(sealed()).toEqual([]);
    expect(res.status).toBe(400);
  });
});

describe('the three type ids, which had no minimum at all', () => {
  const OPTIONAL = ['serviceTypeId', 'vehicleTypeId', 'parcelTypeId'] as const;

  it.each(OPTIONAL)('%s: refuses a negative, which used to seal', async (field) => {
    const res = await put({ ...SOUND, [field]: -1 });
    expect(
      sealed().map((c) => c[field]),
      `${field}: -1 would have been sealed and sent to the courier as-is`
    ).toEqual([]);
    expect(res.status).toBe(400);
  });

  it.each(OPTIONAL)('%s: refuses «0x10», which Number() reads as 16', async (field) => {
    expect(Number('0x10')).toBe(16);
    const res = await put({ ...SOUND, [field]: '0x10' });
    expect(sealed().map((c) => c[field])).toEqual([]);
    expect(res.status).toBe(400);
  });

  it.each(OPTIONAL)('%s: still seals zero, which the courier may well define', async (field) => {
    const res = await put({ ...SOUND, [field]: 0 });
    expect(res.status).toBe(200);
    expect(sealed()[0]).toMatchObject({ [field]: 0 });
  });

  it.each(OPTIONAL)('%s: stays absent when it is not sent', async (field) => {
    const res = await put(SOUND);
    expect(res.status).toBe(200);
    expect(sealed()[0]).not.toHaveProperty(field);
  });
});

describe('nothing leaks from a refused request', () => {
  it('a refused id never reaches the provider row, the audit trail, or the encryptor', async () => {
    const res = await put({ ...SOUND, companyId: '0x10' });
    expect(res.status).toBe(400);
    expect(encryptJson).not.toHaveBeenCalled();
    expect(db.deliveryProvider.update).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('and never reaches the adapter-completeness check either', async () => {
    await put({ ...SOUND, originCityId: '0b11' });
    expect(logesTechsFromCredentials).not.toHaveBeenCalled();
  });
});
