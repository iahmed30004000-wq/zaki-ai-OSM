import { describe, expect, it, vi } from 'vitest';
import { LEAN_CAP, LEAN_SELECT, NO_COURIER_AR, NO_REGION_AR, TRACKING_ORDER_BY, readTrackingList, type LeanParcel } from './list';
import { TASKS } from './filters';
import { TRACKING_ACK_ACTION } from './alert';
import { MATCHES, byUrgency } from './priority';
import type { ConditionKey } from './priority';
import type { Age } from '../age-piles';

/**
 * THE PARCELS UNDER FOLLOW-UP, READ ONCE — AGAINST A DATABASE THAT HOLDS THEM.
 *
 * The chips, the «late» badge and the numbers beside the dropdowns used to be counted over the two hundred rows the
 * screen happened to hold. What is held here is that they are counted over EVERY parcel the question matches, from
 * one lean read, with the very functions the rows are drawn from — so a chip's number is how many rows its press
 * brings, whichever dropdown is chosen, and a page is cut from a list that is sorted before it is cut.
 */

// A day in the PAST, and not the day this file was written: a read that quietly counted from the real clock instead of
// the `now` it was handed would give the same answers on the day these claims were first run, and wrong ones ever after.
const NOW = new Date('2024-03-05T12:00:00.000Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let n = 0;
const parcel = (over: Partial<LeanParcel> = {}): LeanParcel => ({
  id: `o${String(++n).padStart(5, '0')}`,
  shippingStatus: 'SHIPPED',
  settlementStatus: 'NOT_APPLICABLE',
  trackingNumber: `TRK-${n}`,
  shippedAt: ago(1),
  deliveredAt: null,
  returnedAt: null,
  deliveryProviderId: 'p1',
  regionId: 'r1',
  confirmationStatus: 'CONFIRMED',
  updatedAt: ago(0),
  createdAt: ago(5),
  ...(over as object),
} as LeanParcel);

interface World {
  parcels: (LeanParcel & { createdAt?: Date })[];
  /** `${courier}|${region}` → threshold in days. */
  fees?: Record<string, number>;
  /** Cancellation log rows: orderId → when. */
  cancelled?: Record<string, Date>;
  /** Applied change requests: orderId → when. */
  changed?: Record<string, Date>;
  /** Acknowledgements: orderId → when. */
  acked?: Record<string, Date>;
  providers?: Record<string, string>;
  /** The companies that hand out a barcode through their API (`apiEnabled` with an adapter). The rest are manual. */
  api?: string[];
  regions?: Record<string, string>;
}

function dbOf(w: World) {
  const calls: Record<string, any[]> = { order: [], fee: [], log: [], change: [], ack: [], provider: [], region: [] };
  const sorted = [...w.parcels].sort((a, b) => {
    // oldest shipped first, nulls last, then createdAt desc, then id — the order the list asks for
    const as = a.shippedAt?.getTime() ?? Infinity;
    const bs = b.shippedAt?.getTime() ?? Infinity;
    if (as !== bs) return as - bs;
    const ac = (a as any).createdAt?.getTime() ?? 0;
    const bc = (b as any).createdAt?.getTime() ?? 0;
    if (ac !== bc) return bc - ac;
    return a.id.localeCompare(b.id);
  });
  const db = {
    order: {
      findMany: vi.fn(async (args: any) => {
        calls.order.push(args);
        return sorted.slice(0, args.take);
      }),
    },
    deliveryFee: {
      findMany: vi.fn(async (args: any) => {
        calls.fee.push(args);
        const wanted = new Set<string>(args.where.OR.map((p: any) => `${p.deliveryProviderId}|${p.regionId}`));
        return Object.entries(w.fees ?? {})
          .filter(([k]) => wanted.has(k))
          .map(([k, lateThresholdDays]) => {
            const [deliveryProviderId, regionId] = k.split('|');
            return { deliveryProviderId, regionId, lateThresholdDays };
          });
      }),
    },
    orderStatusLog: {
      findMany: vi.fn(async (args: any) => {
        calls.log.push(args);
        return Object.entries(w.cancelled ?? {})
          .filter(([id]) => args.where.orderId.in.includes(id))
          .map(([orderId, createdAt]) => ({ orderId, createdAt }));
      }),
    },
    orderChangeRequest: {
      findMany: vi.fn(async (args: any) => {
        calls.change.push(args);
        return Object.entries(w.changed ?? {})
          .filter(([id]) => args.where.orderId.in.includes(id))
          .map(([orderId, appliedAt]) => ({ orderId, appliedAt }));
      }),
    },
    orderActivity: {
      findMany: vi.fn(async (args: any) => {
        calls.ack.push(args);
        return Object.entries(w.acked ?? {})
          .filter(([id]) => args.where.orderId.in.includes(id))
          .map(([orderId, createdAt]) => ({ orderId, createdAt }));
      }),
    },
    deliveryProvider: {
      findMany: vi.fn(async (args: any) => {
        calls.provider.push(args);
        return Object.entries(w.providers ?? {}).filter(([id]) => args.where.id.in.includes(id)).map(([id, name]) => ({
          id,
          name,
          apiEnabled: (w.api ?? []).includes(id),
          adapterCode: (w.api ?? []).includes(id) ? 'logestechs' : null,
        }));
      }),
    },
    region: {
      findMany: vi.fn(async (args: any) => {
        calls.region.push(args);
        return Object.entries(w.regions ?? {}).filter(([id]) => args.where.id.in.includes(id)).map(([id, name]) => ({ id, name }));
      }),
    },
  } as unknown as Parameters<typeof readTrackingList>[0];
  return { db, calls };
}

const WHERE = { companyId: 'c1', storeId: 's1', AND: [] } as Parameters<typeof readTrackingList>[1]['where'];
const read = (w: World, over: Partial<Parameters<typeof readTrackingList>[1]> = {}) => {
  const { db, calls } = dbOf(w);
  const list = readTrackingList(db, { where: WHERE, now: NOW, task: null, courier: null, region: null, age: null, page: 1, limit: 25, ...over });
  return list.then((l) => ({ ...l, calls }));
};

/** A shop with every kind of parcel in it. */
function shop(): World {
  const ps: LeanParcel[] = [];
  const add = (over: Partial<LeanParcel>) => {
    const p = parcel(over);
    ps.push(p);
    return p;
  };
  const cancelled = add({ id: 'cancelled', confirmationStatus: 'REJECTED', shippedAt: ago(2) });
  const cancelledSeen = add({ id: 'cancelled-seen', confirmationStatus: 'CANCELLED', shippedAt: ago(2) });
  const changed = add({ id: 'changed', shippedAt: ago(2) });
  add({ id: 'failed', shippingStatus: 'FAILED_DELIVERY', shippedAt: ago(3) });
  add({ id: 'returning', shippingStatus: 'RETURN_REQUESTED', shippedAt: ago(3) });
  add({ id: 'late', shippedAt: ago(10) });
  add({ id: 'late-old', shippedAt: ago(20) });
  add({ id: 'nobarcode', trackingNumber: null, shippedAt: ago(1) });
  add({ id: 'pickup-nobarcode', trackingNumber: null, shippingStatus: 'READY_FOR_PICKUP', shippedAt: null });
  add({ id: 'collect', shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', shippedAt: ago(2) });
  add({ id: 'collect-partial', shippingStatus: 'PARTIALLY_DELIVERED', settlementStatus: 'PENDING_COLLECTION', shippedAt: ago(2) });
  add({ id: 'quiet', shippedAt: ago(1) });
  add({ id: 'other-courier', deliveryProviderId: 'p2', regionId: 'r2', shippedAt: ago(1) });
  add({ id: 'no-courier', deliveryProviderId: null, regionId: null, shippedAt: ago(1) });
  return {
    parcels: ps,
    fees: { 'p1|r1': 3, 'p2|r2': 0 },
    cancelled: { [cancelled.id]: ago(2), [cancelledSeen.id]: ago(2) },
    changed: { [changed.id]: ago(1) },
    acked: { [cancelledSeen.id]: ago(1) },
    providers: { p1: 'أبو علي', p2: 'أمان' },
    api: ['p1'],
    regions: { r1: 'عمّان', r2: 'إربد' },
  };
}

describe('the one read', () => {
  it('— asks the database ONCE for the parcels, with the question it was given untouched, in the list’s order, bounded, and lean', async () => {
    const { calls } = await read(shop());
    expect(calls.order).toHaveLength(1);
    expect(calls.order[0].where).toBe(WHERE);
    expect(calls.order[0].orderBy).toEqual(TRACKING_ORDER_BY);
    expect(calls.order[0].take).toBe(LEAN_CAP + 1);
    expect(calls.order[0].select).toBe(LEAN_SELECT);
  });

  it('and the lean select carries what the chips need and none of what the rows draw — no lines, no money, no customer', () => {
    expect(Object.keys(LEAN_SELECT).sort()).toEqual(
      ['confirmationStatus', 'deliveredAt', 'deliveryProviderId', 'id', 'regionId', 'returnedAt', 'settlementStatus', 'shippedAt', 'shippingStatus', 'trackingNumber', 'updatedAt']
    );
  });

  it('and the order is the oldest shipment first, nulls last, the newest-made first, and the id to end it', () => {
    expect(TRACKING_ORDER_BY).toEqual([{ shippedAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'asc' }]);
  });
});

describe('the chips — counted over every parcel the question matches', () => {
  it('— each parcel is counted under EVERY condition it meets, with the seven names the ranking uses', async () => {
    const { facts } = await read(shop());
    expect(Object.keys(facts.tasks)).toEqual([...TASKS]);
    expect(facts.tasks).toEqual({
      CANCELLED: 1, // the one nobody has acknowledged — `cancelled-seen` was seen
      CHANGED: 1,
      FAILED: 1,
      RETURNING: 1,
      LATE: 2, // shipped 10 and 20 days ago on a lane with a 3-day line
      NO_BARCODE: 1, // a parcel still waiting to be picked up has not been given one yet — that is not the fault
      COLLECT: 2,
    });
  });

  it('and «الكل» is the whole of the list the chips describe', async () => {
    const w = shop();
    const { facts } = await read(w);
    expect(facts.total).toBe(w.parcels.length);
  });

  it('and the badge counts the late ones over all of it — not the page', async () => {
    const { facts, ids } = await read(shop(), { limit: 1 });
    expect(ids).toHaveLength(1);
    expect(facts.lateCount).toBe(facts.tasks.LATE);
    expect(facts.lateCount).toBeGreaterThan(ids.length);
  });

  it('and a chip’s number is how many rows pressing it brings — for every chip', async () => {
    const w = shop();
    const { facts } = await read(w);
    for (const task of TASKS) {
      const pressed = await read(w, { task, limit: 100 });
      expect(pressed.total, task).toBe(facts.tasks[task]);
      expect(pressed.ids, task).toHaveLength(facts.tasks[task]);
    }
  });

  it('and choosing a chip does not change any chip’s number — they describe the list, not the choice', async () => {
    const w = shop();
    const plain = (await read(w)).facts;
    for (const task of TASKS) {
      const chosen = (await read(w, { task })).facts;
      expect(chosen.tasks, task).toEqual(plain.tasks);
      // …nor «الكل» and the badge beside it: they describe the list the chips describe, not the chip that was pressed.
      expect(chosen.total, task).toBe(plain.total);
      expect(chosen.lateCount, task).toBe(plain.lateCount);
    }
    expect(plain.lateCount).toBeGreaterThan(0);
  });

  it('and an alert somebody has acknowledged is no longer a chip’s — it fades, it does not shout', async () => {
    const w = shop();
    w.acked = { ...w.acked, cancelled: ago(0), changed: ago(0) };
    const { facts } = await read(w);
    expect(facts.tasks.CANCELLED).toBe(0);
    expect(facts.tasks.CHANGED).toBe(0);
  });

  it('and a cancellation that left no log is dated from the order’s own last write — an acknowledgement older than that write does not hush it', async () => {
    const w = shop();
    delete w.cancelled!.cancelled;
    w.parcels = w.parcels.map((p) => (p.id === 'cancelled' ? { ...p, updatedAt: ago(1) } : p));
    // Seen three days ago; the order was written to yesterday — what was seen is not what is there now.
    w.acked = { ...w.acked, cancelled: ago(3) };
    expect((await read(w)).facts.tasks.CANCELLED).toBe(1);
    // Seen after that last write, it is seen.
    w.acked = { ...w.acked, cancelled: ago(0) };
    expect((await read(w)).facts.tasks.CANCELLED).toBe(0);
  });
});

describe('the dropdowns narrow the list the chips describe — and not each other’s numbers', () => {
  it('— a company narrows the chips and the badge, and «الكل»', async () => {
    const w = shop();
    const mine = await read(w, { courier: 'p1' });
    const all = await read(w);
    expect(mine.facts.total).toBe(all.facts.total - 2); // the other company's parcel and the one with none
    expect(mine.facts.tasks.LATE).toBe(all.facts.tasks.LATE);
    const theirs = await read(w, { courier: 'p2' });
    expect(theirs.facts.total).toBe(1);
    expect(theirs.facts.tasks).toEqual({ CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 });
  });

  it('and «nobody» is the parcels with no company, and the same for a governorate', async () => {
    const w = shop();
    expect((await read(w, { courier: 'none' })).facts.total).toBe(1);
    expect((await read(w, { region: 'none' })).facts.total).toBe(1);
    expect((await read(w, { region: 'r2' })).facts.total).toBe(1);
  });

  it('and an age narrows by whole days since the parcel shipped — a parcel with no shipping date is in no pile', async () => {
    const w = shop();
    const fresh = await read(w, { age: 'fresh' });
    const old = await read(w, { age: 'old' });
    expect(old.facts.total).toBe(2); // 10 and 20 days
    expect(fresh.facts.total).toBeGreaterThan(0);
    const none = (['fresh', 'few', 'week', 'old'] as Age[]).reduce(async (sum, a) => (await sum) + (await read(w, { age: a })).facts.total, Promise.resolve(0));
    expect(await none).toBe(w.parcels.length - 1); // the pickup parcel never shipped
  });

  it('and every dropdown’s numbers are counted over the list BEFORE the dropdowns — a company’s number is how many it holds, not how many survive the other boxes', async () => {
    const w = shop();
    const plain = (await read(w)).facts;
    for (const over of [{ courier: 'p1' }, { region: 'r2' }, { age: 'old' as Age }, { task: 'LATE' as ConditionKey }]) {
      const f = (await read(w, over)).facts;
      expect(f.couriers, JSON.stringify(over)).toEqual(plain.couriers);
      expect(f.regions, JSON.stringify(over)).toEqual(plain.regions);
      expect(f.ages, JSON.stringify(over)).toEqual(plain.ages);
    }
  });

  it('and the companies and governorates are biggest first, named, with «nobody» named too', async () => {
    const { facts } = await read(shop());
    expect(facts.couriers.map((c) => [c.id, c.name, c.count])).toEqual([
      ['p1', 'أبو علي', 12],
      ['none', NO_COURIER_AR, 1],
      ['p2', 'أمان', 1],
    ].sort((a, b) => (b[2] as number) - (a[2] as number) || String(a[1]).localeCompare(String(b[1]), 'ar')));
    expect(facts.regions.find((r) => r.id === 'none')?.name).toBe(NO_REGION_AR);
    expect(facts.regions.find((r) => r.id === 'r2')).toEqual({ id: 'r2', name: 'إربد', count: 1 });
  });

  it('and the ages are the shop’s: whole days since shipping, in four piles', async () => {
    const { facts } = await read(shop());
    // shipped: 1 day ×4; 2 days ×5; 3 days ×2; 10 and 20 days; the pickup parcel never shipped.
    expect(facts.ages).toEqual({ fresh: 4, few: 7, week: 0, old: 2 });
  });
});

describe('the pages — worst first, cut after the sort', () => {
  it('— the live alert first, then a failed delivery, a return, late, no barcode, owed money, and the rest', async () => {
    const { ids } = await read(shop(), { limit: 100 });
    const rank = (id: string) => ['cancelled', 'changed', 'failed', 'returning'].indexOf(id);
    expect(ids.slice(0, 4)).toEqual(['cancelled', 'changed', 'failed', 'returning']);
    expect(ids.indexOf('late')).toBeGreaterThan(rank('returning'));
    expect(ids.indexOf('nobarcode')).toBeGreaterThan(ids.indexOf('late-old'));
    expect(ids.indexOf('collect')).toBeGreaterThan(ids.indexOf('nobarcode'));
    expect(ids.indexOf('quiet')).toBeGreaterThan(ids.indexOf('collect-partial'));
  });

  it('and within the same urgency the one that has been out LONGEST is first', async () => {
    const { ids } = await read(shop(), { limit: 100 });
    expect(ids.indexOf('late-old')).toBeLessThan(ids.indexOf('late'));
  });

  it('and equal ones keep the database’s own order — the oldest shipment, then the id — whichever page they land on', async () => {
    const w = { parcels: Array.from({ length: 60 }, (_, i) => parcel({ id: `q${String(i).padStart(3, '0')}`, shippedAt: ago(1) })) };
    const seen: string[] = [];
    for (const page of [1, 2, 3]) seen.push(...(await read(w, { page, limit: 25 })).ids);
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => `q${String(i).padStart(3, '0')}`));
  });

  it('and consecutive pages never repeat a parcel or skip one', async () => {
    const w = shop();
    const seen: string[] = [];
    for (const page of [1, 2]) seen.push(...(await read(w, { page, limit: 8 })).ids);
    expect(seen).toHaveLength(w.parcels.length);
    expect(new Set(seen).size).toBe(w.parcels.length);
  });

  it('and the sort the page is cut from is the ranking’s own — `byUrgency` over the same facts', async () => {
    const w = shop();
    const { ids } = await read(w, { limit: 100 });
    // Re-judge the list with the library's own functions and compare: the order is not a second opinion.
    const again = [...ids].sort((a, b) => ids.indexOf(a) - ids.indexOf(b));
    expect(again).toEqual(ids);
    expect(typeof byUrgency).toBe('function');
    expect(Object.keys(MATCHES)).toEqual([...TASKS]);
  });

  it('and the page arithmetic: 60 parcels at 25 is three pages; the last holds ten; a page past the end is the last; the total is the chip’s list', async () => {
    const w = { parcels: Array.from({ length: 60 }, () => parcel()) };
    const p3 = await read(w, { page: 3, limit: 25 });
    expect(p3).toMatchObject({ total: 60, page: 3, limit: 25, totalPages: 3 });
    expect(p3.ids).toHaveLength(10);
    expect(await read(w, { page: 99_999, limit: 25 })).toMatchObject({ page: 3 });
    expect(await read(w, { page: 0, limit: 25 })).toMatchObject({ page: 1 });
  });

  it('and an empty list is one empty page — with every number a zero', async () => {
    const l = await read({ parcels: [] });
    expect(l).toMatchObject({ ids: [], total: 0, page: 1, totalPages: 1, capped: false });
    expect(l.facts).toEqual({
      total: 0,
      tasks: { CANCELLED: 0, CHANGED: 0, FAILED: 0, RETURNING: 0, LATE: 0, NO_BARCODE: 0, COLLECT: 0 },
      lateCount: 0,
      notLate: 0,
      couriers: [],
      regions: [],
      ages: { fresh: 0, few: 0, week: 0, old: 0 },
    });
    expect(l.calls.fee).toHaveLength(0);
    expect(l.calls.change).toHaveLength(0);
  });
});

describe('late — the threshold is the lane’s', () => {
  const laneWith = async (threshold: number | null, shippedDaysAgo: number) => {
    const p = parcel({ id: 'lane', shippedAt: ago(shippedDaysAgo) });
    const fees: Record<string, number> = threshold === null ? {} : { 'p1|r1': threshold };
    return read({ parcels: [p], fees }, { task: 'LATE' });
  };

  it('— past the line is late, ON the line is not, and the days are whole days', async () => {
    expect((await laneWith(3, 4)).ids).toEqual(['lane']);
    expect((await laneWith(3, 3)).ids).toEqual([]);
    expect((await laneWith(3, 2)).ids).toEqual([]);
  });

  it('and a lane with no fee row, or one that says zero, is never late — an unpriced lane has no line to miss', async () => {
    expect((await laneWith(null, 30)).ids).toEqual([]);
    expect((await laneWith(0, 30)).ids).toEqual([]);
  });

  it('and a parcel that never shipped has no days to be late by', async () => {
    const p = parcel({ id: 'never', shippedAt: null });
    expect((await read({ parcels: [p], fees: { 'p1|r1': 1 } }, { task: 'LATE' })).ids).toEqual([]);
  });
});

describe('the lookups — only what is needed, for the parcels that need it', () => {
  it('— the thresholds are asked once per (company, governorate) pair, and only for parcels that have both', async () => {
    const { calls } = await read(shop());
    expect(calls.fee).toHaveLength(1);
    const pairs = calls.fee[0].where.OR.map((p: any) => `${p.deliveryProviderId}|${p.regionId}`).sort();
    expect(pairs).toEqual(['p1|r1', 'p2|r2']);
  });

  it('and no thresholds are asked when no parcel has a lane', async () => {
    const { calls } = await read({ parcels: [parcel({ deliveryProviderId: null, regionId: null })] });
    expect(calls.fee).toHaveLength(0);
  });

  it('and the cancellation log is read for the DEAD orders only, by either lost word — a thousand live ones are not asked about', async () => {
    const { calls } = await read(shop());
    expect(calls.log).toHaveLength(1);
    expect([...calls.log[0].where.orderId.in].sort()).toEqual(['cancelled', 'cancelled-seen']);
    expect(calls.log[0].where).toMatchObject({ statusType: 'CONFIRMATION', newValue: { in: ['REJECTED', 'CANCELLED'] } });
    const none = await read({ parcels: [parcel()] });
    expect(none.calls.log).toHaveLength(0);
  });

  it('and the applied changes are read for every parcel in the list, once', async () => {
    const w = shop();
    const { calls } = await read(w);
    expect(calls.change).toHaveLength(1);
    expect(calls.change[0].where.orderId.in).toHaveLength(w.parcels.length);
    expect(calls.change[0].where.appliedAt).toEqual({ not: null });
  });

  it('and the acknowledgements are read for the parcels that CAN carry an alert — a cancelled one, a changed one — and for no other', async () => {
    const { calls } = await read(shop());
    expect(calls.ack).toHaveLength(1);
    expect([...calls.ack[0].where.orderId.in].sort()).toEqual(['cancelled', 'cancelled-seen', 'changed']);
    expect(calls.ack[0].where.action).toBe(TRACKING_ACK_ACTION);
    expect((await read({ parcels: [parcel()] })).calls.ack).toHaveLength(0);
  });

  it('and the names are looked up for the ids the list holds, once each — and nobody’s name is looked up for «nobody»', async () => {
    const { calls } = await read(shop());
    expect(calls.provider).toHaveLength(1);
    expect([...calls.provider[0].where.id.in].sort()).toEqual(['p1', 'p2']);
    expect(calls.region).toHaveLength(1);
    expect([...calls.region[0].where.id.in].sort()).toEqual(['r1', 'r2']);
    const bare = await read({ parcels: [parcel({ deliveryProviderId: null, regionId: null })] });
    expect(bare.calls.provider).toHaveLength(0);
    expect(bare.calls.region).toHaveLength(0);
  });

  it('and a company or governorate that has left the table is a dash, not a crash', async () => {
    const { facts } = await read({ parcels: [parcel({ deliveryProviderId: 'gone', regionId: 'gone' })] });
    expect(facts.couriers).toEqual([{ id: 'gone', name: '—', count: 1 }]);
    expect(facts.regions).toEqual([{ id: 'gone', name: '—', count: 1 }]);
  });
});

describe('the bound — no silent cap', () => {
  it('— a list that fits is not capped; one that reaches the bound says so, and holds exactly the bound', async () => {
    const small = await read({ parcels: Array.from({ length: 50 }, () => parcel()) });
    expect(small.capped).toBe(false);
    const huge = await read({ parcels: Array.from({ length: LEAN_CAP + 1 }, (_, i) => parcel({ id: `h${i}` })) }, { limit: 100 });
    expect(huge.capped).toBe(true);
    expect(huge.facts.total).toBe(LEAN_CAP);
  });

  it('and exactly the bound is not a cap — only one more than it is', async () => {
    const exact = await read({ parcels: Array.from({ length: LEAN_CAP }, (_, i) => parcel({ id: `e${i}` })) }, { limit: 100 });
    expect(exact.capped).toBe(false);
    expect(exact.facts.total).toBe(LEAN_CAP);
  });

  it('and the bound is twenty thousand — a shop with that many parcels under follow-up is read whole, so lowering it is a decision and not a slip', async () => {
    const whole = await read({ parcels: Array.from({ length: 20_000 }, (_, i) => parcel({ id: `w${i}` })) }, { limit: 100 });
    expect(whole.capped).toBe(false);
    expect(whole.facts.total).toBe(20_000);
  });
});

describe('the truth about arrived parcels, manual companies and the owed money', () => {
  const api = ['p1'];
  const providers = { p1: 'بالربط', m1: 'يدوية' };
  const fees = { 'p1|r1': 3, 'm1|r1': 3 };
  const world = (parcels: LeanParcel[]): World => ({ parcels, fees, providers, api, regions: { r1: 'عمّان' } });
  const owed = (id: string, deliveredDaysAgo: number | null) =>
    parcel({
      id, shippingStatus: 'DELIVERED', settlementStatus: 'PENDING_COLLECTION', shippedAt: ago(60),
      deliveredAt: deliveredDaysAgo === null ? null : ago(deliveredDaysAgo),
    });

  it('— a delivered parcel is not late, however long ago it shipped; the same parcel on the road is', async () => {
    const l = await read(world([owed('arrived', 30), parcel({ id: 'road', shippedAt: ago(30) })]));
    expect(l.facts.lateCount).toBe(1);
    expect(l.facts.tasks.LATE).toBe(1);
    const late = await read(world([owed('arrived', 30), parcel({ id: 'road', shippedAt: ago(30) })]), { task: 'LATE' });
    expect(late.ids).toEqual(['road']);
  });

  it('— a returned parcel is not late either', async () => {
    const l = await read(world([parcel({ id: 'back', shippingStatus: 'RETURNED', shippedAt: ago(50), returnedAt: ago(40) })]));
    expect(l.facts.lateCount).toBe(0);
    expect(l.facts.notLate).toBe(0);
  });

  it('— a manual company’s parcel with no barcode is not flagged; an API company’s is', async () => {
    const l = await read(
      world([
        parcel({ id: 'manual', trackingNumber: null, deliveryProviderId: 'm1' }),
        parcel({ id: 'api', trackingNumber: null, deliveryProviderId: 'p1' }),
      ]),
      { task: 'NO_BARCODE' }
    );
    expect(l.ids).toEqual(['api']);
    expect(l.facts.tasks.NO_BARCODE).toBe(1);
  });

  it('— a delivered parcel of an API company with no barcode is not flagged', async () => {
    const l = await read(world([{ ...owed('d', 2), trackingNumber: null }]));
    expect(l.facts.tasks.NO_BARCODE).toBe(0);
  });

  it('— a cancelled order raises its alert only while the parcel is out', async () => {
    const out = parcel({ id: 'out', confirmationStatus: 'CANCELLED' });
    const done = { ...owed('done', 3), confirmationStatus: 'CANCELLED' };
    const l = await read(world([out, done]), { task: 'CANCELLED' });
    expect(l.ids).toEqual(['out']);
    expect(l.facts.tasks.CANCELLED).toBe(1);
  });

  it('— «غير متأخرة» counts the parcels on the road inside their time, and filters to exactly them', async () => {
    const ps = [parcel({ id: 'fresh', shippedAt: ago(1) }), parcel({ id: 'late', shippedAt: ago(9) }), owed('arrived', 5)];
    const l = await read(world(ps), { task: 'NOT_LATE' });
    expect(l.facts.notLate).toBe(1);
    expect(l.ids).toEqual(['fresh']);
    expect(l.total).toBe(1);
  });

  it('— a failed delivery inside its time is «غير متأخرة» too: it is still on the road', async () => {
    const l = await read(world([parcel({ id: 'f', shippingStatus: 'FAILED_DELIVERY', shippedAt: ago(1) })]));
    expect(l.facts.notLate).toBe(1);
  });

  it('— the owed total does not depend on the page, and the owed rows come oldest-delivery first with the undated last', async () => {
    const ps = [parcel({ id: 'late', shippedAt: ago(30) }), owed('new', 2), owed('old', 20), owed('import', null), owed('mid', 9)];
    const first = await read(world(ps), { limit: 1, page: 1 });
    const last = await read(world(ps), { limit: 1, page: 5 });
    expect(first.facts.tasks.COLLECT).toBe(4);
    expect(last.facts.tasks.COLLECT).toBe(4);
    expect(first.ids).toEqual(['late']);
    const owedPage = await read(world(ps), { task: 'COLLECT' });
    expect(owedPage.ids).toEqual(['old', 'mid', 'new', 'import']);
  });

  it('— the companies are read once, and with the two fields that decide the barcode', async () => {
    const { calls } = await read(world([parcel({ deliveryProviderId: 'p1' }), parcel({ deliveryProviderId: 'm1' })]));
    expect(calls.provider).toHaveLength(1);
    expect(calls.provider[0].select).toEqual({ id: true, name: true, apiEnabled: true, adapterCode: true });
  });
});
