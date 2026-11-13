import { describe, expect, it, vi } from 'vitest';
import { LEAN_CAP, readTrackingList, type LeanParcel } from './list';
import { TASKS } from './filters';
import { DIFFERENCE_CHIP, MATCHES } from './priority';

/**
 * «فيه فرق» ON THE LIST — THE CHIP'S NUMBER IS THE ROWS IT BRINGS, FROM A DATABASE THAT HOLDS THE MATCH ROWS.
 *
 *   «او اعمل قائمة ع محصل فيه فرق عشان بنت المتابعة تبث فيه» (the owner, 13/11)
 *
 * The chip is counted over EVERY parcel the question matches, like the others, with the very rule the mark is drawn from.
 * What is held here is the oracle the returns list is held to: the number beside the chip is the number of parcels its press
 * brings, whichever dropdown is chosen — and both agree with a plain reading of the match rows written apart from the code
 * under test. The table EVALUATES what it is asked, so another company's rows and another store's statements are really in it.
 */

const NOW = new Date('2026-11-13T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const COMPANY = 'c1';
const STORE = 's1';

type Any = Record<string, any>;

interface MatchRow {
  id: string;
  companyId: string;
  orderId: string | null;
  result: string;
  resolution: string | null;
  createdAt: Date;
  statement: { storeId: string; matchingClosedAt: Date | null };
}

const parcel = (id: string, over: Partial<LeanParcel> = {}): LeanParcel =>
  ({
    id,
    shippingStatus: 'DELIVERED',
    settlementStatus: 'PENDING_COLLECTION',
    trackingNumber: `TRK-${id}`,
    shippedAt: ago(5),
    deliveredAt: ago(2),
    returnedAt: null,
    deliveryProviderId: 'p1',
    regionId: 'r1',
    confirmationStatus: 'CONFIRMED',
    updatedAt: ago(0),
    createdAt: ago(9),
    ...over,
  }) as LeanParcel;

let m = 0;
const match = (orderId: string | null, over: Partial<Omit<MatchRow, 'statement'>> & { statement?: Partial<MatchRow['statement']> } = {}): MatchRow => {
  const { statement, ...rest } = over;
  return {
    id: `m${String(++m).padStart(4, '0')}`,
    companyId: COMPANY,
    orderId,
    result: 'MISMATCHED',
    resolution: null,
    createdAt: ago(3),
    ...rest,
    statement: { storeId: STORE, matchingClosedAt: null, ...(statement ?? {}) },
  };
};

interface World {
  parcels: LeanParcel[];
  matches: MatchRow[];
  /** Make the match table fail. */
  fails?: unknown;
}

function dbOf(w: World) {
  const matchCalls: Any[] = [];
  const db = {
    order: { findMany: vi.fn(async (args: Any) => w.parcels.slice(0, args.take)) },
    deliveryFee: { findMany: vi.fn(async () => []) },
    orderStatusLog: { findMany: vi.fn(async () => []) },
    orderChangeRequest: { findMany: vi.fn(async () => []) },
    orderActivity: { findMany: vi.fn(async () => []) },
    deliveryProvider: { findMany: vi.fn(async () => [{ id: 'p1', name: 'أبو علي', apiEnabled: false, adapterCode: null }, { id: 'p2', name: 'أمان', apiEnabled: false, adapterCode: null }]) },
    region: { findMany: vi.fn(async () => [{ id: 'r1', name: 'دمشق' }, { id: 'r2', name: 'حلب' }]) },
    settlementMatch: {
      findMany: vi.fn(async (args: Any) => {
        matchCalls.push(args);
        if (w.fails) throw w.fails;
        const wh = args.where as Any;
        return w.matches
          .filter(
            (r) =>
              r.companyId === wh.companyId &&
              r.orderId !== null &&
              wh.orderId.in.includes(r.orderId) &&
              r.result === wh.result &&
              r.statement.storeId === wh.statement.storeId
          )
          .map((r) => ({ id: r.id, orderId: r.orderId, result: r.result, resolution: r.resolution, createdAt: r.createdAt, statement: { matchingClosedAt: r.statement.matchingClosedAt } }));
      }),
    },
  } as unknown as Parameters<typeof readTrackingList>[0];
  return { db, matchCalls };
}

const WHERE = { companyId: COMPANY, storeId: STORE, AND: [] } as Parameters<typeof readTrackingList>[1]['where'];
const read = (w: World, over: Partial<Parameters<typeof readTrackingList>[1]> = {}) => {
  const { db, matchCalls } = dbOf(w);
  return readTrackingList(db, {
    companyId: COMPANY,
    where: WHERE,
    now: NOW,
    task: null,
    courier: null,
    region: null,
    age: null,
    differences: { storeId: STORE },
    page: 1,
    limit: 100,
    ...over,
  }).then((l) => ({ ...l, matchCalls, db }));
};

/** A shop with every shape of difference in it. */
function shop(): World {
  const ps = [
    // — the ones that carry a difference —
    parcel('unanswered', { shippedAt: ago(8) }),
    parcel('unanswered-road', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', deliveredAt: null, shippedAt: ago(12), deliveryProviderId: 'p2', regionId: 'r2' }),
    parcel('answered', { shippedAt: ago(20) }),
    parcel('closed-answered', { shippedAt: ago(15), deliveryProviderId: 'p2', regionId: 'r2' }),
    parcel('closed-and-open', { shippedAt: ago(6) }),
    // — the ones that do not —
    parcel('clean-after', { shippedAt: ago(7) }),
    parcel('no-match', { shippedAt: ago(4) }),
    parcel('only-swept', { shippedAt: ago(5) }),
    parcel('other-company', { shippedAt: ago(9) }),
    parcel('other-store', { shippedAt: ago(10) }),
    parcel('quiet', { shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', deliveredAt: null, shippedAt: ago(1), deliveryProviderId: null, regionId: null }),
  ];
  const matches = [
    match('unanswered'),
    match('unanswered-road'),
    match('answered', { resolution: 'ACCEPTED_COURIER' }),
    match('closed-answered', { resolution: 'OURS_STANDS', statement: { matchingClosedAt: ago(1) } }),
    // the newest statement closed and answered; an older one still waits for an answer → the parcel's difference is the waiting one
    match('closed-and-open', { createdAt: ago(1), resolution: 'ACCEPTED_COURIER', statement: { matchingClosedAt: ago(0.5) } }),
    match('closed-and-open', { createdAt: ago(6) }),
    match('clean-after', { createdAt: ago(6) }),
    match('clean-after', { result: 'MATCHED', createdAt: ago(2) }),
    match('only-swept', { result: 'MISSING_IN_STATEMENT' }),
    match('other-company', { companyId: 'c2' }),
    match('other-store', { statement: { storeId: 's2' } }),
    // a row no order carries
    match(null),
  ];
  return { parcels: ps, matches };
}

/** The same question answered by plain reading of the table — written apart from the rule under test. */
function reference(w: World, parcelId: string): { has: boolean; answered: boolean } {
  const lines = w.matches
    .filter((r) => r.orderId === parcelId && r.companyId === COMPANY && r.statement.storeId === STORE && (r.result === 'MATCHED' || r.result === 'MISMATCHED'))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.result === 'MISMATCHED' ? -1 : 1));
  const standing: MatchRow[] = [];
  for (const l of lines) {
    if (l.result === 'MATCHED') break;
    standing.push(l);
  }
  if (standing.length === 0) return { has: false, answered: false };
  const waiting = standing.find((l) => !l.resolution && l.statement.matchingClosedAt === null);
  return { has: true, answered: waiting ? false : !!standing[0].resolution };
}

describe('which parcels carry a difference — the shop, read whole', () => {
  it('exactly those the rule says: answered or not, on the road or delivered, and none of another company’s or store’s', async () => {
    const w = shop();
    const l = await read(w, { task: DIFFERENCE_CHIP });
    expect([...l.ids].sort()).toEqual(['answered', 'closed-and-open', 'closed-answered', 'unanswered', 'unanswered-road']);
    expect(l.ids.sort()).toEqual(w.parcels.filter((p) => reference(w, p.id).has).map((p) => p.id).sort());
  });

  it('inside the chip the unanswered come first — in the list’s own order among themselves — then the answered', async () => {
    const l = await read(shop(), { task: DIFFERENCE_CHIP });
    // The unanswered: two parcels waiting for their money (the list ranks those above a parcel that is only on the road) and
    // the one on the road. The answered follow, in the list's own order.
    expect(l.ids).toEqual(['unanswered', 'closed-and-open', 'unanswered-road', 'answered', 'closed-answered']);
    for (const id of l.ids.slice(0, 3)) expect(reference(shop(), id).answered).toBe(false);
    for (const id of l.ids.slice(3)) expect(reference(shop(), id).answered).toBe(true);
  });

  it('and an unanswered difference comes before an answered one even when the answered parcel is the more urgent one on the ordinary list', async () => {
    const w = shop();
    const plain = (await read(w)).ids;
    // on the ordinary list the answered «answered» (money waiting) is ranked above «unanswered-road» (only on the road)…
    expect(plain.indexOf('answered')).toBeLessThan(plain.indexOf('unanswered-road'));
    // …and inside the chip it is the other way round: the question nobody has answered is the work
    const chip = (await read(w, { task: DIFFERENCE_CHIP })).ids;
    expect(chip.indexOf('unanswered-road')).toBeLessThan(chip.indexOf('answered'));
  });

  it('the parcel with a closed answered statement newest and an older open one waiting is NOT answered: the waiting one is its difference', async () => {
    const l = await read(shop(), { task: DIFFERENCE_CHIP, limit: 100 });
    expect(l.differences.get('closed-and-open')).toMatchObject({ answered: false, closed: false });
    expect(l.differences.get('closed-answered')).toMatchObject({ answered: true, closed: true });
    expect(l.differences.get('answered')).toMatchObject({ answered: true, closed: false });
  });
});

describe('the number beside the chip is the number of rows its press brings', () => {
  const choices = (): Partial<Parameters<typeof readTrackingList>[1]>[] => [
    {},
    { courier: 'p1' },
    { courier: 'p2' },
    { courier: 'none' },
    { region: 'r1' },
    { region: 'r2' },
    { region: 'none' },
    { age: 'few' },
    { age: 'week' },
    { age: 'old' },
    { courier: 'p2', region: 'r2' },
    { courier: 'p1', age: 'week' },
  ];

  it.each(choices().map((c) => [JSON.stringify(c), c] as const))('under %s: facts.difference === the rows of ?task=DIFFERENCE === a plain reading of the table', async (_name, choice) => {
    const w = shop();
    const all = await read(w, choice);
    const chip = await read(w, { ...choice, task: DIFFERENCE_CHIP });
    expect(chip.total).toBe(all.facts.difference);
    expect(chip.ids).toHaveLength(all.facts.difference!);
    // the plain reading, over the parcels L1 holds (those the other choices leave)
    const l1 = new Set((await read(w, { ...choice, limit: 100 })).ids);
    expect(all.facts.difference).toBe(w.parcels.filter((p) => l1.has(p.id) && reference(w, p.id).has).length);
    // and the chip’s own page is exactly those parcels
    expect(new Set(chip.ids)).toEqual(new Set(w.parcels.filter((p) => l1.has(p.id) && reference(w, p.id).has).map((p) => p.id)));
  });

  it('the whole shop: five parcels carry a difference, and «الكل» still counts every parcel', async () => {
    const l = await read(shop());
    expect(l.facts.difference).toBe(5);
    expect(l.facts.total).toBe(11);
    expect(l.total).toBe(11);
  });

  it('the chip narrows the page and nothing else: the other chips, the badge and the dropdowns still describe the whole list', async () => {
    const w = shop();
    const all = await read(w);
    const chip = await read(w, { task: DIFFERENCE_CHIP });
    expect(chip.facts).toEqual(all.facts);
    expect(chip.facts.tasks).toEqual(all.facts.tasks);
  });

  it('pages: the chip is cut after it is sorted — page one holds the unanswered, the last page the answered; the numbers do not move', async () => {
    const w = shop();
    const p1 = await read(w, { task: DIFFERENCE_CHIP, page: 1, limit: 2 });
    const p2 = await read(w, { task: DIFFERENCE_CHIP, page: 2, limit: 2 });
    const p3 = await read(w, { task: DIFFERENCE_CHIP, page: 3, limit: 2 });
    expect([p1.total, p1.totalPages, p3.ids.length]).toEqual([5, 3, 1]);
    expect([...p1.ids, ...p2.ids, ...p3.ids]).toEqual((await read(w, { task: DIFFERENCE_CHIP })).ids);
    for (const p of [p1, p2, p3]) expect(p.facts.difference).toBe(5);
    // the unanswered three fill page one and the start of page two; the answered are what is left
    expect(p1.ids).toEqual(['unanswered', 'closed-and-open']);
    expect(p2.ids).toEqual(['unanswered-road', 'answered']);
    expect(p3.ids).toEqual(['closed-answered']);
  });

  it('the page’s `differences` holds the parcels ON THIS PAGE that carry one — never the others', async () => {
    const w = shop();
    const p1 = await read(w, { task: DIFFERENCE_CHIP, page: 1, limit: 2 });
    expect([...p1.differences.keys()].sort()).toEqual([...p1.ids].sort());
    // an ordinary page: only the parcels of that page that carry one
    const page = await read(w, { page: 1, limit: 3 });
    expect([...page.differences.keys()].every((id) => page.ids.includes(id))).toBe(true);
    expect([...page.differences.keys()].every((id) => reference(w, id).has)).toBe(true);
  });
});

describe('the mark is not a rank — the order of the list is what it was', () => {
  it('the same parcels in the same order whether the differences were asked for or not', async () => {
    const w = shop();
    const without = await read(w, { differences: null });
    const withThem = await read(w);
    expect(withThem.ids).toEqual(without.ids);
    expect(withThem.facts.tasks).toEqual(without.facts.tasks);
    expect(withThem.facts.lateCount).toBe(without.facts.lateCount);
  });

  it('and the seven chips are counted by their own conditions only (a difference adds to none of them)', async () => {
    const l = await read(shop());
    const own = Object.fromEntries(TASKS.map((k) => [k, 0])) as Record<string, number>;
    for (const p of shop().parcels) {
      for (const k of TASKS) {
        const facts = { shippingStatus: p.shippingStatus, settlementStatus: p.settlementStatus, trackingNumber: p.trackingNumber, daysInTransit: 0, late: false, deliveredAt: p.deliveredAt, returnedAt: p.returnedAt };
        if (MATCHES[k](facts)) own[k] += 1;
      }
    }
    expect(l.facts.tasks.COLLECT).toBe(own.COLLECT);
    expect(l.facts.tasks.FAILED).toBe(own.FAILED);
  });
});

describe('nothing is read, counted or carried unless the door asked — it asks only for a person who holds the money sight', () => {
  it('not asked: no read of the match table at all, no number, no parcel carries one, and the chip brings nothing', async () => {
    const w = shop();
    const l = await read(w, { differences: null });
    expect(l.matchCalls).toHaveLength(0);
    expect(l.facts).not.toHaveProperty('difference');
    expect(l.differences.size).toBe(0);
    expect((await read(w, { differences: undefined, task: DIFFERENCE_CHIP })).ids).toEqual([]);
    expect((await read(w, { differences: null, task: DIFFERENCE_CHIP })).total).toBe(0);
  });

  it('asked: two reads of the match table for the whole shop (one when nobody disagrees), each naming the company and the statement’s store', async () => {
    const l = await read(shop());
    expect(l.matchCalls).toHaveLength(2);
    for (const c of l.matchCalls) {
      expect(c.where.companyId).toBe(COMPANY);
      expect(c.where.statement).toEqual({ storeId: STORE });
    }
    const calm = await read({ parcels: [parcel('a'), parcel('b')], matches: [match('a', { result: 'MATCHED' })] });
    expect(calm.matchCalls).toHaveLength(1);
    expect(calm.facts.difference).toBe(0);
  });

  it('asked for the store the door names — a statement of another store is not a difference of this one', async () => {
    const w = shop();
    const here = await read(w, { task: DIFFERENCE_CHIP });
    expect(here.ids).not.toContain('other-store');
    const there = await read(w, { task: DIFFERENCE_CHIP, differences: { storeId: 's2' } });
    expect(there.ids).toEqual(['other-store']);
  });

  it('an empty shop asks nothing of the match table', async () => {
    const l = await read({ parcels: [], matches: [] });
    expect(l.matchCalls).toHaveLength(0);
    expect(l.facts.difference).toBe(0);
  });

  it('the read is not soft: a failure of the match table fails the list — a mark that vanishes quietly reads as «no difference»', async () => {
    await expect(read({ ...shop(), fails: new Error('connection lost') })).rejects.toThrow('connection lost');
  });

  it('five thousand parcels are still two reads of the match table', async () => {
    const parcels = Array.from({ length: 5000 }, (_, i) => parcel(`p${i}`, { shippedAt: ago(1 + (i % 30)) }));
    const matches = parcels.filter((_, i) => i % 11 === 0).map((p) => match(p.id));
    const l = await read({ parcels, matches }, { limit: 25 });
    expect(l.matchCalls).toHaveLength(2);
    expect(l.facts.difference).toBe(matches.length);
    expect(LEAN_CAP).toBeGreaterThan(5000);
  });
});
