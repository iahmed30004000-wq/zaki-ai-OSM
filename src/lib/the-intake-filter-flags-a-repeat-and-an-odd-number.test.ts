import { beforeEach, describe, expect, it, vi } from 'vitest';
import { intakePhoneKeys, sweepIntake } from './intake-filter';
import { INTAKE_DUPLICATE_ACTION, INTAKE_SUSPECT_ACTION, INTAKE_WINDOW_MS } from './intake-flags';
import { forgetIntakeFilterSwitch } from './intake-filter-switch';
import { CONFIRMATION_REFUSED } from './order-state';
import { repoFile, stripComments } from './guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — «فلتر الاستقبال» (Confirmation Center v2, step C1)
 *
 *  1. OFF (the company's own switch) is no order query and no write. A read that fails is OFF.
 *  2. ON writes at most two kinds of flag on a NEW, unclaimed order that arrived after the switch went on and not more than a day ago, by nobody (`userId` null):
 *     a repeat (the same person under ANY spelling of the number, the same product, an earlier order within 24 h, not refused, not a replacement) and a number whose
 *     shape is not the store's country's.
 *  3. A flag is written once: an order that already carries one is not flagged again for that kind.
 *  4. The only write is `orderActivity.create` — nothing is rejected, merged, held, claimed, messaged or counted — and a failure is swallowed (a pull never stops).
 *  5. The dial code written without `+`/`00` matches the national form (the one spelling `canonicalPhone` does not unify), without changing what is stored.
 * ═══════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-11-16T10:00:00.000Z');
const ON_AT = '2026-11-16T06:00:00.000Z';
const SCOPE = { companyId: 'c1', storeId: 's1', countryCode: 'SY' };

interface Cand {
  id: string;
  createdAt: Date;
  customerId: string;
  productId: string;
  items: { productId: string }[];
  customer: { phone: string; rawPhone: string };
  activities: { action: string }[];
}

const cand = (over: Partial<Cand> = {}): Cand => ({
  id: 'o2',
  createdAt: new Date('2026-11-16T09:00:00.000Z'),
  customerId: 'k1',
  productId: 'p1',
  items: [{ productId: 'p1' }],
  customer: { phone: '933620102', rawPhone: '0933620102' },
  activities: [],
  ...over,
});

function world(opts: { settings?: string | null; candidates?: Cand[]; first?: { id: string; orderNumber: string } | null; others?: { id: string }[] } = {}) {
  const settings = opts.settings === undefined ? JSON.stringify({ intakeFilter: { enabled: true, enabledAt: ON_AT } }) : opts.settings;
  return {
    company: { findUnique: vi.fn(async () => ({ settings })) },
    order: {
      findMany: vi.fn(async () => opts.candidates ?? []),
      findFirst: vi.fn(async () => opts.first ?? null),
    },
    customer: { findMany: vi.fn(async () => opts.others ?? []) },
    orderActivity: { create: vi.fn(async () => ({})) },
  };
}

beforeEach(() => forgetIntakeFilterSwitch());

describe('the same number, any spelling', () => {
  it('a Syrian number is found under its national form, its dial-code form and the bare-code form', () => {
    for (const spelling of ['0933620102', '+963933620102', '00963933620102', '933620102', '963933620102']) {
      const keys = intakePhoneKeys(spelling, 'SY');
      expect(keys, spelling).toEqual(expect.arrayContaining(['933620102', '963933620102']));
    }
  });

  it('a mobile that merely starts with a dial code’s digits is not stripped when what is left is not a national number', () => {
    expect(intakePhoneKeys('966793918', 'SY')).not.toContain('793918');
  });

  it('a foreign number kept whole in a Syrian store keeps its own code, and nothing is invented for an unknown country or an empty one', () => {
    expect(intakePhoneKeys('+905321234567', 'SY')).toContain('905321234567');
    expect(intakePhoneKeys('0933620102', 'ZZ')).toContain('933620102');
    expect(intakePhoneKeys('', 'SY')).toEqual([]);
    expect(intakePhoneKeys('abc', 'SY')).toEqual([]);
  });
});

describe('OFF is no query and no write', () => {
  it.each([
    ['no settings', null],
    ['settings that are not JSON', '{oops'],
    ['the key off', JSON.stringify({ intakeFilter: { enabled: false, enabledAt: null } })],
    ['the call-proof key on but not this one', JSON.stringify({ callProofAndCadence: { enabled: true, enabledAt: ON_AT } })],
  ])('%s', async (_n, settings) => {
    const w = world({ settings, candidates: [cand()] });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(0);
    expect(w.order.findMany).not.toHaveBeenCalled();
    expect(w.orderActivity.create).not.toHaveBeenCalled();
  });

  it('a switch read that throws is OFF, and the sweep does not throw', async () => {
    const w = world({ candidates: [cand()] });
    w.company.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(0);
    expect(w.orderActivity.create).not.toHaveBeenCalled();
  });
});

describe('ON', () => {
  it('looks only at a NEW, unclaimed, unshipped order of this store that arrived after the switch went on and within a day, never a replacement', async () => {
    const w = world();
    await sweepIntake(SCOPE, NOW, w as never);
    const where = (w.order.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({
      companyId: 'c1', storeId: 's1', claimedById: null, confirmationStatus: 'NEW', shippingStatus: 'NOT_READY', replacesOrderId: null,
    });
    expect(where.createdAt).toEqual({ gt: new Date(ON_AT) });
  });

  it('never looks further back than a day, whatever the switch’s age', async () => {
    const w = world({ settings: JSON.stringify({ intakeFilter: { enabled: true, enabledAt: '2026-10-01T00:00:00.000Z' } }) });
    await sweepIntake(SCOPE, NOW, w as never);
    const where = (w.order.findMany.mock.calls[0] as unknown as [{ where: { createdAt: { gt: Date } } }])[0].where;
    expect(where.createdAt.gt).toEqual(new Date(NOW.getTime() - INTAKE_WINDOW_MS));
  });

  it('a repeat is flagged with the FIRST order’s number, by nobody', async () => {
    const w = world({ candidates: [cand()], first: { id: 'o1', orderNumber: 'ORD-26-1' } });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(1);
    expect(w.orderActivity.create).toHaveBeenCalledTimes(1);
    const data = (w.orderActivity.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ companyId: 'c1', orderId: 'o2', userId: null, action: INTAKE_DUPLICATE_ACTION });
    expect(JSON.parse(String(data.metadata))).toEqual({ firstOrderId: 'o1', firstOrderNumber: 'ORD-26-1', windowHours: 24 });
  });

  it('the first order is asked for as the OLDEST earlier one of the same person and product, in the window, not refused, not a replacement', async () => {
    const w = world({ candidates: [cand({ items: [{ productId: 'p1' }, { productId: 'p9' }] })], others: [{ id: 'k7' }] });
    await sweepIntake(SCOPE, NOW, w as never);
    const asked = (w.order.findFirst.mock.calls[0] as unknown as [{ where: Record<string, any>; orderBy: unknown }])[0];
    expect(asked.where.customerId).toEqual({ in: ['k1', 'k7'] });
    expect(asked.where.id).toEqual({ not: 'o2' });
    expect(asked.where.createdAt).toEqual({ gte: new Date('2026-11-15T09:00:00.000Z'), lt: new Date('2026-11-16T09:00:00.000Z') });
    expect(asked.where.confirmationStatus).toEqual({ notIn: [...CONFIRMATION_REFUSED] });
    expect(asked.where.replacesOrderId).toBeNull();
    expect(JSON.stringify(asked.where.OR)).toContain('p9');
    expect(asked.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('the customer rows asked for are the store’s own, under every spelling of the number', async () => {
    const w = world({ candidates: [cand()] });
    await sweepIntake(SCOPE, NOW, w as never);
    const asked = (w.customer.findMany.mock.calls[0] as unknown as [{ where: { companyId: string; storeId: string; phone: { in: string[] } } }])[0].where;
    expect(asked).toMatchObject({ companyId: 'c1', storeId: 's1' });
    expect(asked.phone.in).toEqual(expect.arrayContaining(['933620102', '963933620102']));
  });

  it('no earlier order, a valid number: nothing is written', async () => {
    const w = world({ candidates: [cand()], first: null });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(0);
    expect(w.orderActivity.create).not.toHaveBeenCalled();
  });

  it.each([
    ['letters', 'abc 123'],
    ['too short', '09336'],
    ['empty', ''],
    ['a Jordanian shape in a Syrian store', '0791234567'],
  ])('a number of the wrong shape (%s) is flagged once', async (_n, rawPhone) => {
    const w = world({ candidates: [cand({ customer: { phone: '1', rawPhone } })], first: null });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(1);
    const data = (w.orderActivity.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data).toMatchObject({ orderId: 'o2', userId: null, action: INTAKE_SUSPECT_ACTION });
  });

  it('a foreign line written whole is not suspect for a Syrian store (the store takes one)', async () => {
    const w = world({ candidates: [cand({ customer: { phone: '905321234567', rawPhone: '+90 532 123 45 67' } })], first: null });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(0);
  });

  it('a number is judged by the STORE’s country: the same Jordanian number is fine in a Jordanian store', async () => {
    const w = world({ candidates: [cand({ customer: { phone: '791234567', rawPhone: '0791234567' } })], first: null });
    expect(await sweepIntake({ ...SCOPE, countryCode: 'JO' }, NOW, w as never)).toBe(0);
  });

  it('both flags on one order are two rows', async () => {
    const w = world({ candidates: [cand({ customer: { phone: '1', rawPhone: 'abc' } })], first: { id: 'o1', orderNumber: 'ORD-26-1' } });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(2);
  });

  it('an order that already carries a flag is not flagged for that kind again — the second run writes nothing', async () => {
    const both = cand({ customer: { phone: '1', rawPhone: 'abc' }, activities: [{ action: INTAKE_DUPLICATE_ACTION }, { action: INTAKE_SUSPECT_ACTION }] });
    const w = world({ candidates: [both], first: { id: 'o1', orderNumber: 'ORD-26-1' } });
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(0);
    expect(w.orderActivity.create).not.toHaveBeenCalled();
    expect(w.order.findFirst).not.toHaveBeenCalled();

    const onlyOne = cand({ customer: { phone: '1', rawPhone: 'abc' }, activities: [{ action: INTAKE_SUSPECT_ACTION }] });
    const w2 = world({ candidates: [onlyOne], first: { id: 'o1', orderNumber: 'ORD-26-1' } });
    expect(await sweepIntake(SCOPE, NOW, w2 as never)).toBe(1);
  });

  it('a failure in the middle is swallowed and counts nothing it did not write', async () => {
    const w = world({ candidates: [cand()], first: { id: 'o1', orderNumber: 'ORD-26-1' } });
    w.orderActivity.create.mockRejectedValueOnce(new Error('write failed'));
    expect(await sweepIntake(SCOPE, NOW, w as never)).toBe(0);
  });
});

describe('what it is not (the source, with the comments stripped)', () => {
  const src = stripComments(repoFile('src/lib/intake-filter.ts'));

  it('writes exactly one kind of row — an activity — and touches no order, customer, status, claim, money or message', () => {
    expect([...src.matchAll(/\.(create|update|updateMany|upsert|delete|deleteMany|createMany)\(/g)].map((m) => m[0])).toEqual(['.create(', '.create(']);
    expect(src.match(/orderActivity\.create\(/g)?.length).toBe(2);
    for (const forbidden of [/order\.(create|update|updateMany)\(/, /orderContactAttempt/, /aiChat|fetch\(/, /sendTemplateMessage|sendTextMessage/, /emitAppEvent/, /\bendOrder\b/, /rejectionReason/]) {
      expect(src).not.toMatch(forbidden);
    }
  });

  it('reads the company’s own switch and not the call-proof one', () => {
    expect(src).toMatch(/intakeFilterSwitch\(/);
    expect(src).not.toMatch(/callProof|cadenceSince/);
  });

  it('writes no phone, name or address into a flag', () => {
    const writes = src.slice(src.indexOf('INTAKE_SUSPECT_ACTION,'));
    expect(writes).not.toMatch(/metadata:[^\n]*(fullName|phone|address|rawPhone)/);
  });
});
