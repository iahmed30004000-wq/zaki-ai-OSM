import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readQueueHealth } from './queue-health';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE QUEUE'S HEALTH ASKS «WHAT ENTERED / CLOSED TODAY» FROM TODAY, NOT FROM EVERY ORDER OF THE STORE (H2, cause 7 of the hang, 18/11).
 *
 * `enteredToday` (an order whose first «لا يرد» is today) and `closedToday` (an order closed today that had a «لا يرد» before today) used to be one
 * count each over EVERY order of the store with two correlated checks on its attempts and no date to start from. Now:
 *
 *   · `enteredToday` starts from TODAY'S no-answer lines (`order_contact_attempts` by company and `createdAt >= dayStart` — the 14/11 index), and only
 *     the orders those lines name are counted;
 *   · `closedToday` starts from the store's orders CLOSED and touched today (`orders (companyId, updatedAt)`), and only those are checked for an
 *     earlier «لا يرد».
 *
 * THE COUNTS ARE THE SAME. `queue-health-counts-start-from-todays-attempts.golden.json` was written by THIS test against `osm/main`'s
 * `readQueueHealth` (before the change, `WRITE_GOLDEN=1`), on the in-memory database below — a real filter over the `where` each read sends, so a
 * question asked differently is answered by the same rows. Midnight in the store's clock, an order with a «لا يرد» yesterday AND today, a BUSY line,
 * a line exactly at midnight, another store and another company are all in it.
 * ═══════════════════════════════════════════════════════════════════════
 */

// ───────────── a tiny in-memory reading of a Prisma `where` (only what these reads send) ─────────────
type Rec = Record<string, unknown>;
const OPS = new Set(['in', 'notIn', 'gte', 'gt', 'lte', 'lt', 'not', 'equals', 'mode']);
const isPlain = (v: unknown): v is Rec => !!v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const val = (v: unknown) => (v instanceof Date ? v.getTime() : v);
function opMatch(actual: unknown, cond: unknown): boolean {
  if (!isPlain(cond)) return cond === null ? actual == null : val(actual) === val(cond);
  return Object.entries(cond).every(([op, c]) => {
    const a = val(actual);
    const b = val(c);
    switch (op) {
      case 'in': return (c as unknown[]).map(val).includes(a);
      case 'notIn': return !(c as unknown[]).map(val).includes(a);
      case 'equals': return a === b;
      case 'gte': return a != null && (a as number) >= (b as number);
      case 'gt': return a != null && (a as number) > (b as number);
      case 'lte': return a != null && (a as number) <= (b as number);
      case 'lt': return a != null && (a as number) < (b as number);
      case 'not': return !opMatch(actual, c);
      case 'mode': return true;
      default: throw new Error(`the fake does not read «${op}»`);
    }
  });
}
function matches(rec: Rec, where: Rec | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (cond === undefined) return true;
    if (k === 'AND') return (Array.isArray(cond) ? cond : [cond]).every((w) => matches(rec, w as Rec));
    if (k === 'OR') return (cond as Rec[]).some((w) => matches(rec, w));
    if (k === 'NOT') return !(Array.isArray(cond) ? cond : [cond]).some((w) => matches(rec, w as Rec));
    const actual = rec[k];
    if (Array.isArray(actual)) {
      const c = cond as Rec;
      return Object.entries(c).every(([q, w]) =>
        q === 'some' ? actual.some((x) => matches(x, w as Rec)) : q === 'none' ? !actual.some((x) => matches(x, w as Rec)) : q === 'every' ? actual.every((x) => matches(x, w as Rec)) : (() => { throw new Error(`relation filter ${q}`); })()
      );
    }
    if (isPlain(cond) && !Object.keys(cond).every((q) => OPS.has(q))) return isPlain(actual) && matches(actual, cond);
    return opMatch(actual, cond);
  });
}
function sortBy<T extends Rec>(rows: T[], orderBy: unknown): T[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Rec[];
  return [...rows].sort((x, y) => {
    for (const o of keys) {
      const [k, dir] = Object.entries(o)[0] as [string, string];
      const a = val(x[k]) as number;
      const b = val(y[k]) as number;
      if (a !== b) return (a < b ? -1 : 1) * (dir === 'desc' ? -1 : 1);
    }
    return 0;
  });
}
function project(rec: Rec, select: Rec | undefined): Rec {
  if (!select) return { ...rec };
  const out: Rec = {};
  for (const [k, s] of Object.entries(select)) {
    if (s === true) out[k] = rec[k];
    else if (isPlain(s) && Array.isArray(rec[k])) {
      let list = (rec[k] as Rec[]).filter((x) => matches(x, s.where as Rec));
      list = sortBy(list, s.orderBy);
      if (typeof s.take === 'number') list = list.slice(0, s.take);
      out[k] = list.map((x) => project(x, s.select as Rec));
    }
  }
  return out;
}
// ─────────────────────────────────────────────────────────────────────────

const NOW = new Date('2026-11-18T09:00:00.000Z'); // 12:00 in Damascus (UTC+3)
const MIDNIGHT = new Date('2026-11-17T21:00:00.000Z'); // the store's day starts here
const CAL = { workHoursStart: '09:00', workHoursEnd: '21:00', weekendDays: [5], timezone: 'Asia/Damascus' };
const h = (hours: number) => new Date(MIDNIGHT.getTime() + hours * 3_600_000);

interface Line { id: string; companyId: string; orderId: string; result: string; createdAt: Date; nextFollowUpAt: Date | null }
function world() {
  const lines: Line[] = [];
  const orders: Rec[] = [];
  const claims: Rec[] = [];
  const order = (id: string, o: Partial<Rec> & { at?: Array<[string, number]> } = {}) => {
    const { at = [], ...rest } = o;
    const rec: Rec = {
      id, companyId: 'c1', storeId: 's1', confirmationStatus: 'NO_ANSWER', claimedById: null, shippingStatus: 'NOT_READY',
      createdAt: h(-72), updatedAt: h(-1), postponedUntil: null, nextFollowUpAt: null, ...rest,
    };
    Object.defineProperty(rec, 'contactAttempts', { get: () => lines.filter((l) => l.orderId === id), enumerable: false });
    orders.push(rec);
    at.forEach(([result, hours], k) => {
      const line: Line & Rec = { id: `${id}-${k}`, companyId: rec.companyId as string, orderId: id, result, createdAt: h(hours), nextFollowUpAt: null };
      Object.defineProperty(line, 'order', { get: () => rec, enumerable: false });
      lines.push(line);
    });
  };
  // ── store s1 of company c1 ──
  order('first-today', { at: [['NO_ANSWER', 2]] }); // entered
  order('yesterday-and-today', { at: [['NO_ANSWER', -5], ['NO_ANSWER', 3]] }); // not entered (it entered yesterday)
  order('one-ms-before-midnight', { at: [['NO_ANSWER', -1 / 3_600_000]], confirmationStatus: 'CONFIRMED', updatedAt: h(4) }); // yesterday's, closed today
  order('at-midnight', { at: [['NO_ANSWER', 0]] }); // today's (gte)
  order('busy-today', { at: [['BUSY', 1]] }); // BUSY is a no-answer: entered
  order('unreachable-today', { at: [['UNREACHABLE', 1.5], ['ANSWERED', -20]] }); // entered: an ANSWERED before is not a no-answer
  order('answered-today', { at: [['ANSWERED', 2]] }); // not a no-answer
  order('opened-only', { at: [['OPENED', 2]] });
  order('never-rung'); // no attempt at all
  order('closed-yesterday', { at: [['NO_ANSWER', -30]], confirmationStatus: 'CANCELLED', updatedAt: h(-2) }); // not today
  order('rejected-no-noanswer-before', { at: [['ANSWERED', -10]], confirmationStatus: 'REJECTED', updatedAt: h(1) }); // no «لا يرد» before
  order('confirmed-after-noanswer', { at: [['NO_ANSWER', -26], ['ANSWERED', 2]], confirmationStatus: 'CONFIRMED', updatedAt: h(2) }); // closed
  order('closed-today-noanswer-today-only', { at: [['NO_ANSWER', 1]], confirmationStatus: 'REJECTED', updatedAt: h(3) }); // entered, not «closed after»
  order('still-open-old', { at: [['NO_ANSWER', -50]], confirmationStatus: 'NO_ANSWER', updatedAt: h(5) }); // open: not closed
  order('cancelled-today-old-busy', { at: [['BUSY', -100]], confirmationStatus: 'CANCELLED', updatedAt: h(0) }); // closed (at midnight exactly)
  order('new-waiting', { confirmationStatus: 'NEW', createdAt: h(-3) });
  order('new-older', { confirmationStatus: 'NEW', createdAt: h(-30) });
  // ── store s2 of the same company ──
  order('s2-first-today', { storeId: 's2', at: [['NO_ANSWER', 2]] });
  order('s2-closed', { storeId: 's2', at: [['NO_ANSWER', -8]], confirmationStatus: 'CONFIRMED', updatedAt: h(6) });
  // ── another company ──
  order('c2-first-today', { companyId: 'c2', storeId: 'x1', at: [['NO_ANSWER', 2]] });
  order('c2-closed', { companyId: 'c2', storeId: 'x1', at: [['NO_ANSWER', -8]], confirmationStatus: 'CONFIRMED', updatedAt: h(6) });

  const lastPull: Rec = { companyId: 'c1', action: 'CLAIMED', reason: 'PULL_NEXT', createdAt: h(10) };
  Object.defineProperty(lastPull, 'order', { get: () => orders[0], enumerable: false });
  claims.push(lastPull);

  const calls: Array<{ model: string; op: string; args: Rec }> = [];
  const rowsRead = { attempts: 0, orders: 0 };
  const on = (model: string, op: string, args: Rec) => calls.push({ model, op, args });
  const client = {
    order: {
      count: async (args: Rec) => (on('order', 'count', args), orders.filter((o) => matches(o, args.where as Rec)).length),
      findMany: async (args: Rec) => {
        on('order', 'findMany', args);
        let rows = sortBy(orders.filter((o) => matches(o, args.where as Rec)), args.orderBy);
        if (typeof args.take === 'number') rows = rows.slice(0, args.take);
        rowsRead.orders += rows.length;
        return rows.map((r) => project(r, args.select as Rec));
      },
      findFirst: async (args: Rec) => {
        on('order', 'findFirst', args);
        const rows = sortBy(orders.filter((o) => matches(o, args.where as Rec)), args.orderBy);
        return rows[0] ? project(rows[0], args.select as Rec) : null;
      },
    },
    orderContactAttempt: {
      findMany: async (args: Rec) => {
        on('orderContactAttempt', 'findMany', args);
        let rows = sortBy(lines.filter((l) => matches(l as unknown as Rec, args.where as Rec)) as unknown as Rec[], args.orderBy);
        if (Array.isArray(args.distinct)) {
          const seen = new Set<string>();
          rows = rows.filter((r) => {
            const k = (args.distinct as string[]).map((d) => String(r[d])).join('|');
            return seen.has(k) ? false : (seen.add(k), true);
          });
        }
        rowsRead.attempts += rows.length;
        return rows.map((r) => project(r, args.select as Rec));
      },
    },
    orderClaimHistory: {
      findFirst: async (args: Rec) => {
        on('orderClaimHistory', 'findFirst', args);
        const rows = sortBy(claims.filter((c) => matches(c, args.where as Rec)), args.orderBy);
        return rows[0] ? project(rows[0], args.select as Rec) : null;
      },
    },
  };
  return { client: client as unknown as Parameters<typeof readQueueHealth>[0], calls, rowsRead, lines };
}

const SCOPES = [
  { companyId: 'c1', storeId: 's1' },
  { companyId: 'c1', storeId: 's2' },
  { companyId: 'c2', storeId: 'x1' },
  { companyId: 'c1', storeId: 'nobody' },
];
const GOLDEN = 'src/lib/queue-health-counts-start-from-todays-attempts.golden.json';

async function readAll() {
  const out: Record<string, unknown> = {};
  for (const scope of SCOPES) out[`${scope.companyId}/${scope.storeId}`] = await readQueueHealth(world().client, scope, CAL, NOW);
  return out;
}

describe('the queue health counts are the same, asked from today', () => {
  it('every count and age equals what osm/main answered on the same rows (golden)', async () => {
    const now = await readAll();
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, `${JSON.stringify(now, null, 2)}\n`);
    expect(JSON.parse(JSON.stringify(now))).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });

  it('the world is the one the golden pins: four entered and three closed in store s1', async () => {
    const h1 = await readQueueHealth(world().client, SCOPES[0], CAL, NOW);
    expect([h1.enteredToday, h1.closedToday]).toEqual([5, 3]);
  });
});

describe('…and it no longer starts from every order of the store', () => {
  it('«entered today» starts from today\'s no-answer lines of the company (createdAt ≥ the store\'s midnight), and counts only the orders they name', async () => {
    const w = world();
    await readQueueHealth(w.client, SCOPES[0], CAL, NOW);
    const read = w.calls.find((c) => c.model === 'orderContactAttempt');
    expect(read, 'today\'s lines are read').toBeTruthy();
    const where = read!.args.where as Rec;
    expect(where.companyId).toBe('c1');
    expect((where.createdAt as Rec).gte).toEqual(MIDNIGHT);
    expect((where.result as Rec).in).toEqual(['NO_ANSWER', 'BUSY', 'UNREACHABLE']);
  });

  it('no order question asks «some/none no-answer by date» over the store without a list of ids to start from', async () => {
    const w = world();
    await readQueueHealth(w.client, SCOPES[0], CAL, NOW);
    const dated = w.calls.filter((c) => {
      if (c.model !== 'order') return false;
      const ca = (c.args.where as Rec).contactAttempts as Rec | undefined;
      return !!ca && JSON.stringify(ca).includes('createdAt');
    });
    expect(dated.length).toBeGreaterThan(0);
    for (const c of dated) expect(((c.args.where as Rec).id as Rec | undefined)?.in, JSON.stringify(c.args.where)).toBeInstanceOf(Array);
  });

  it('«closed today» starts from the store\'s orders closed and touched today', async () => {
    const w = world();
    await readQueueHealth(w.client, SCOPES[0], CAL, NOW);
    const start = w.calls.find((c) => c.model === 'order' && c.op === 'findMany' && ((c.args.where as Rec).updatedAt as Rec | undefined)?.gte);
    expect(start, 'closed orders are found by updatedAt first').toBeTruthy();
    const where = start!.args.where as Rec;
    expect(where).toMatchObject({ companyId: 'c1', storeId: 's1', confirmationStatus: { in: ['CONFIRMED', 'REJECTED', 'CANCELLED'] }, updatedAt: { gte: MIDNIGHT } });
  });

  it('a day with no «لا يرد» at all asks no order question for «entered today»', async () => {
    const w = world();
    w.lines.length = 0;
    const r = await readQueueHealth(w.client, SCOPES[0], CAL, NOW);
    expect(r.enteredToday).toBe(0);
    expect(w.calls.filter((c) => c.model === 'order' && JSON.stringify(c.args.where).includes('"none"') && JSON.stringify(c.args.where).includes('createdAt')).length).toBe(0);
  });
});
