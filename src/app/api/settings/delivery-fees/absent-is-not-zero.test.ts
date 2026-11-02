import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { repoFile, stripComments } from '@/lib/guard-source';

/**
 * AN ABSENT FIELD IS NOT A ZERO — THE ENDPOINT HALF.
 *
 * The fee form posted `Number(box) || 0` for the late threshold and the
 * return fee, so this endpoint received `0` whether somebody typed a zero or
 * typed nothing. It then wrote that `0` over whatever was stored. The form
 * now OMITS an empty box, and these tests pin what the endpoint does with
 * the absence — which is the half that cannot be seen from a browser:
 *
 *   · UPDATE: the field is left out of `data`, so Prisma does not touch the
 *     column and the stored value survives. An empty box no longer turns a
 *     courier's real 3 into «never late».
 *   · CREATE: the field is left out of `data` too, so the column default in
 *     `prisma/schema.prisma` decides — `lateThresholdDays Int @default(3)`,
 *     `returnFee Decimal @default(0)`. That is the ONE copy of each number.
 *   · A STATED `0` IS STILL WRITTEN, because `0 !== undefined`.
 *
 * NO SCHEMA CHANGE AND NO MIGRATION. `delivery_fees.lateThresholdDays` is
 * `INTEGER NOT NULL DEFAULT 3` and `returnFee` is `numeric NOT NULL DEFAULT
 * 0` (`20260920061500_stage5_delivery_fees_returns`), and they stay that
 * way: «not stated» is answered by NOT WRITING the column, which both a
 * create and an update can express without a nullable column.
 *
 * These tests read the `data` object Prisma was handed. Put `.default(0)` or
 * `.default(3)` back on the zod schema, or write `input.lateThresholdDays`
 * unconditionally, and the keys reappear with the wrong number in them.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => ({
  db: {
    deliveryProvider: { findFirst: vi.fn(), findMany: vi.fn() },
    region: { findFirst: vi.fn(), findMany: vi.fn() },
    deliveryFee: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({
  can: () => true,
  requirePermission: (...a: unknown[]) => requirePermission(...a),
}));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { PUT } from './route';

const COURIER = 'c0000000-0000-4000-8000-000000000001';
const REGION = 'd0000000-0000-4000-8000-00000000000a';

/** The stored row an empty box must not flatten: a real threshold of 3. */
const STORED = {
  id: 'f1',
  fee: '2.5',
  lateThresholdDays: 3,
  returnFee: '1.5',
  isActive: true,
};

const put = (body: unknown) =>
  PUT(
    new Request('http://localhost/api/settings/delivery-fees', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );

/** The `data` object handed to Prisma by whichever write ran. */
const wroteUpdate = () => db.deliveryFee.update.mock.calls[0][0].data as Record<string, unknown>;
const wroteCreate = () => db.deliveryFee.create.mock.calls[0][0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Ops', role: 'ADMIN', status: 'ACTIVE' },
    companyId: 'co1',
    countryId: 'jo',
    storeId: 'st1',
  });
  requirePermission.mockResolvedValue({});
  db.deliveryProvider.findFirst.mockResolvedValue({ id: COURIER, name: 'Basha Delivery' });
  db.region.findFirst.mockResolvedValue({ id: REGION, name: 'عمّان' });
  // The row the write returns: echoed from `data` on top of what was stored,
  // which is what Postgres does for an update that omits a column.
  db.deliveryFee.update.mockImplementation(async ({ data }: any) => ({ ...STORED, ...data }));
  db.deliveryFee.create.mockImplementation(async ({ data }: any) => ({
    id: 'f-new',
    // THE COLUMN DEFAULTS, applied by the database for every key `data`
    // leaves out — the only place these two numbers are written down.
    lateThresholdDays: 3,
    returnFee: '0',
    ...data,
  }));
});

describe('updating a fee row with the two boxes left empty', () => {
  beforeEach(() => db.deliveryFee.findFirst.mockResolvedValue({ ...STORED }));

  it('does not write lateThresholdDays at all, so the stored 3 survives', async () => {
    const res = await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5 });
    expect(res.status).toBe(200);

    const data = wroteUpdate();
    expect(data).not.toHaveProperty('lateThresholdDays');
    // What `|| 0` used to do, spelled out: the column would have become 0.
    expect(data.lateThresholdDays).not.toBe(0);
    expect(Object.keys(data).sort()).toEqual(['fee', 'isActive']);
  });

  it('and does not write returnFee either', async () => {
    await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5 });
    expect(wroteUpdate()).not.toHaveProperty('returnFee');
  });

  it('and the audit trail records the row as it STANDS, not the empty request', async () => {
    await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5 });
    const { newData } = logAudit.mock.calls[0][0] as any;
    // `input.lateThresholdDays` is `undefined` here, and `JSON` would have
    // written `null` into the log for a row that holds 3.
    expect(newData.lateThresholdDays).toBe(3);
    expect(newData.returnFee).toBe(1.5);
  });
});

describe('updating a fee row with a typed zero', () => {
  beforeEach(() => db.deliveryFee.findFirst.mockResolvedValue({ ...STORED }));

  it('writes 0, because a stated zero is a decision', async () => {
    await put({
      deliveryProviderId: COURIER,
      regionId: REGION,
      fee: 2.5,
      lateThresholdDays: 0,
      returnFee: 0,
    });
    const data = wroteUpdate();
    expect(data.lateThresholdDays).toBe(0);
    expect(data.returnFee).toBe(0);
  });

  it('and the audit trail says 0 rather than falling back to the old value', async () => {
    await put({
      deliveryProviderId: COURIER,
      regionId: REGION,
      fee: 2.5,
      lateThresholdDays: 0,
      returnFee: 0,
    });
    const { newData } = logAudit.mock.calls[0][0] as any;
    expect(newData.lateThresholdDays).toBe(0);
    expect(newData.returnFee).toBe(0);
  });
});

describe('creating a fee row for a region that had none', () => {
  beforeEach(() => db.deliveryFee.findFirst.mockResolvedValue(null));

  it('omits both columns so the schema default is the only default there is', async () => {
    const res = await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 4 });
    expect(res.status).toBe(200);

    const data = wroteCreate();
    expect(data).not.toHaveProperty('lateThresholdDays');
    expect(data).not.toHaveProperty('returnFee');
    // THE DEFAULT THAT USED TO BE COPIED INTO THE BROWSER. It is the
    // column's now, and the row comes back holding it.
    const { newData } = logAudit.mock.calls[0][0] as any;
    expect(newData.lateThresholdDays).toBe(3);
    expect(newData.returnFee).toBe(0);
  });

  it('and writes a typed zero when one is typed', async () => {
    await put({
      deliveryProviderId: COURIER,
      regionId: REGION,
      fee: 4,
      lateThresholdDays: 0,
      returnFee: 0,
    });
    const data = wroteCreate();
    expect(data.lateThresholdDays).toBe(0);
    expect(data.returnFee).toBe(0);
  });
});

describe('the range checks did not go away with the default', () => {
  beforeEach(() => db.deliveryFee.findFirst.mockResolvedValue(null));

  it('still refuses a threshold of 91 days and a fractional one', async () => {
    for (const bad of [91, 2.5, -1]) {
      vi.clearAllMocks();
      requireContext.mockResolvedValue({
        user: { id: 'u1', name: 'Ops', role: 'ADMIN', status: 'ACTIVE' },
        companyId: 'co1', countryId: 'jo', storeId: 'st1',
      });
      requirePermission.mockResolvedValue({});
      db.deliveryFee.findFirst.mockResolvedValue(null);
      const res = await put({
        deliveryProviderId: COURIER, regionId: REGION, fee: 4, lateThresholdDays: bad,
      });
      expect(res.status, `${bad} was accepted`).toBe(400);
      expect(db.deliveryFee.create).not.toHaveBeenCalled();
    }
  });
});

/**
 * ONE DEFAULT, IN ONE FILE.
 *
 * The number 3 was written twice: `lateThresholdDays Int @default(3)` in
 * `prisma/schema.prisma`, and `String(current?.lateThresholdDays ?? 3)` in
 * `CourierFees.tsx` — the schema's default hardcoded into a browser,
 * pre-filled into a draft box, and then saved as though a person had typed
 * it. The browser's copy was the one that reached the database.
 *
 * It now lives only in the column, which is also the only copy a `create`
 * that omits the field can consult. These assertions are over SOURCE, so
 * they are the weaker kind — the behavioural half is above. What they catch
 * is the thing behaviour cannot: a second copy reappearing somewhere that
 * happens to agree with the first, until one of them is changed.
 */
describe('the default is written down once', () => {
  it('and that place is the column', () => {
    const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/lateThresholdDays\s+Int\s+@default\(3\)/);
    expect(schema).toMatch(/returnFee\s+Decimal\s+@default\(0\)/);
  });

  it('and not in the endpoint’s schema, which would be a second copy', () => {
    const route = stripComments(repoFile('src/app/api/settings/delivery-fees/route.ts'));
    expect(route).toMatch(/lateThresholdDays: z\.number\(\)\.int\(\)\.min\(0\)\.max\(90\)\.optional\(\)/);
    expect(route).not.toMatch(/lateThresholdDays[^,\n]*\.default\(/);
    expect(route).not.toMatch(/returnFee[^,\n]*\.default\(/);
    // And neither column is written unconditionally any more: both go
    // through one `stated` object that drops an undefined field.
    expect(route).toMatch(
      /input\.lateThresholdDays === undefined \? \{\} : \{ lateThresholdDays: input\.lateThresholdDays \}/
    );
    expect(route).toMatch(
      /input\.returnFee === undefined \? \{\} : \{ returnFee: input\.returnFee \}/
    );
    expect((route.match(/\.\.\.stated,/g) ?? []).length, 'both writes must use it').toBe(2);
  });

  it('and not in the browser, which is where the old copy did the damage', () => {
    const form = stripComments(repoFile('src/components/settings/CourierFees.tsx'));
    expect(form, 'the schema default is back in the draft box').not.toMatch(
      /lateThresholdDays[^\n]*\?\?\s*3/
    );
    expect(form, 'the return fee default is back in the draft box').not.toMatch(
      /returnFee[^\n]*\?\?\s*0/
    );
    // And the read that could not tell «nothing» from «zero» is gone.
    expect(form).not.toMatch(/Number\(d\.lateThresholdDays\)\s*\|\|/);
    expect(form).not.toMatch(/Number\(d\.returnFee\)\s*\|\|/);
    expect(form).not.toMatch(/Number\(days\)\s*\|\|/);
    expect(form).not.toMatch(/Number\(returnFee\)\s*\|\|/);
    // The bulk dialog's boxes start empty rather than pre-filled.
    expect(form).toMatch(/setDays\] = useState\(''\)/);
    expect(form).toMatch(/setReturnFee\] = useState\(''\)/);
  });
});

describe('the courier’s own code for the region — «انا ليش ما بقدر ادخل الرموز؟»', () => {
  beforeEach(() => db.deliveryFee.findFirst.mockResolvedValue({ ...STORED, courierCityId: null }));

  it('a typed code is written, and the audit says what it was and what it became', async () => {
    const res = await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5, courierCityId: 445053 });
    expect(res.status).toBe(200);
    expect(wroteUpdate().courierCityId).toBe(445053);
    const audit = logAudit.mock.calls[0][0];
    expect(audit.previousData.courierCityId).toBeNull();
    expect(audit.newData.courierCityId).toBe(445053);
  });

  it('NEGATIVE: an absent code is not written — the stored one survives', async () => {
    db.deliveryFee.findFirst.mockResolvedValue({ ...STORED, courierCityId: 705991 });
    await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5 });
    expect(Object.keys(wroteUpdate())).not.toContain('courierCityId');
  });

  it('a stated null clears it', async () => {
    db.deliveryFee.findFirst.mockResolvedValue({ ...STORED, courierCityId: 705991 });
    await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5, courierCityId: null });
    expect(wroteUpdate().courierCityId).toBeNull();
  });

  /**
   * THE SCREEN CLEARS A NUMBER THIS WAY (2/11): emptying a box that held one sends `courierCityId: null`, and the courier's
   * own list answers for that governorate again (`couriers/city-id`). So what the endpoint says back matters: no reason is
   * demanded (the fee did not move), the audit records what the number was and that it became nothing, and the answer
   * carries the row as it now stands, so the screen reloads an empty box.
   */
  it('and clearing it asks no reason, is audited as what it was and what it became, and is answered as cleared', async () => {
    db.deliveryFee.findFirst.mockResolvedValue({ ...STORED, courierCityId: 705991 });
    const res = await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5, courierCityId: null });
    expect(res.status).toBe(200);
    const audit = logAudit.mock.calls[0][0];
    expect(audit.action).toBe('DELIVERY_FEE_UPDATED');
    expect(audit.previousData.courierCityId).toBe(705991);
    expect(audit.newData.courierCityId).toBeNull();
    expect((await res.json()).fee.courierCityId).toBeNull();
  });

  it('NEGATIVE: clearing leaves the rest of the row alone — the fee, the threshold and the return fee are not touched', async () => {
    db.deliveryFee.findFirst.mockResolvedValue({ ...STORED, courierCityId: 705991 });
    await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5, courierCityId: null });
    const written = wroteUpdate();
    expect(written.fee).toBe(2.5);
    expect(Object.keys(written)).not.toContain('lateThresholdDays');
    expect(Object.keys(written)).not.toContain('returnFee');
  });

  it('a new row with a stated null stores no code (the column is nullable, and null is its "not told yet")', async () => {
    db.deliveryFee.findFirst.mockResolvedValue(null);
    const res = await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5, courierCityId: null });
    expect(res.status).toBe(200);
    expect(wroteCreate().courierCityId).toBeNull();
  });

  it('NEGATIVE: zero, a negative, a fraction or text is refused and nothing is written', async () => {
    for (const bad of [0, -5, 1.5, '445053']) {
      vi.clearAllMocks();
      requireContext.mockResolvedValue({ user: { id: 'u1', name: 'Ops', role: 'ADMIN', status: 'ACTIVE' }, companyId: 'co1', countryId: 'jo', storeId: 'st1' });
      const res = await put({ deliveryProviderId: COURIER, regionId: REGION, fee: 2.5, courierCityId: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(db.deliveryFee.update).not.toHaveBeenCalled();
    }
  });
});
