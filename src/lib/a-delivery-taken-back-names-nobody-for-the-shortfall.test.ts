import { describe, expect, it } from 'vitest';
import { DELIVERY_UNDO_ACTION } from './delivery-undo-words';
import {
  DOOR_RESULTS,
  NEVER_CHARGED_ROLES,
  ON_THE_COMPANY,
  SHORTFALL_KIND,
  dayOf,
  mayCarryShortfall,
  proposeShortfalls,
  shortfallNote,
  shortfallOf,
  type ShortfallCandidate,
  type ShortfallResult,
  type ShortfallScope,
  type UnnamedLine,
} from './shortfall';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * AFTER «تراجع عن التسليم», THE ONE WHO PRESSED «استلم» BY MISTAKE IS NOT THE ONE WHO CARRIES THE SHORTFALL (13/11).
 *
 * The money reviewer's case, with the real functions: A presses «استلم» on a parcel that was not delivered; the owner takes the delivery back;
 * later the company's statement delivers the order and pays 38 + 2 against our 43 + 2 — 5.000 dinars short. The engine took "the latest delivered
 * attempt before the import" as the door, which was A's mistaken press, and proposed 5.000 on A — a PROPOSED row payday applies when nobody decides.
 *
 * The rule now: an attempt only names somebody if it came AFTER the order's latest `DELIVERY_UNDONE` (the order's own, not another's; a tie is not
 * after). Nothing else moved, and this file holds both halves of that sentence:
 *
 *   1 · the case, and what follows from it — no charge on A, the approval asks who (as for an order nobody pressed), a NEW press after the undo
 *       names its own person, an undo twice, two orders with one undone, a tie, and only an undo cuts (no other activity row does);
 *   2 · DIFFERENTIAL — the engine as it stood before (copied below, verbatim) against the engine now, on seeded random worlds:
 *         P1  with no `DELIVERY_UNDONE` row anywhere, they give the SAME answer and write the SAME rows;
 *         P2  with undo rows, the new answer is the OLD engine's answer on the same world with the dead attempts taken out — and the undo
 *             really changes the answer in a good share of those worlds, so the property is not vacuous.
 *
 * The fake database KEEPS rows, honours `where` (an unknown filter throws), `orderBy`, `take` AND `select` — a column the engine forgot to ask for
 * comes back missing, as it would from Prisma.
 * ═══════════════════════════════════════════════════════════════════
 */

type Row = Record<string, any>;

/* ═════════════════════════ a database that remembers ═════════════════════════ */

interface Shelf {
  orders: Row[];
  activities: Row[];
  attempts: Row[];
  users: Row[];
  penalties: Row[];
}

/** The columns each table may be filtered on in this fake: a filter it does not know is a mistake in the query, not a pass. */
const FILTERABLE: Record<string, string[]> = {
  order: ['id', 'companyId'],
  deliveryAttempt: ['companyId', 'orderId', 'result', 'createdAt'],
  user: ['id', 'companyId', 'status', 'role'],
  penalty: ['settlementMatchId', 'status'],
  activity: ['action'],
};

function matches(table: string, row: Row, where: Row = {}): boolean {
  for (const [key, want] of Object.entries(where)) {
    if (!FILTERABLE[table].includes(key)) throw new Error(`the fake does not know the filter ${table}.${key}`);
    const have = row[key];
    if (want !== null && typeof want === 'object' && !(want instanceof Date)) {
      const ops = Object.keys(want);
      for (const op of ops) {
        if (!['in', 'notIn', 'not', 'lt'].includes(op)) throw new Error(`the fake does not know the operator ${table}.${key}.${op}`);
      }
      if ('in' in want && !want.in.includes(have)) return false;
      if ('notIn' in want && want.notIn.includes(have)) return false;
      if ('not' in want && have === want.not) return false;
      if ('lt' in want && !(have < want.lt)) return false;
    } else if (have !== want) return false;
  }
  return true;
}

/** `orderBy` with one key; ties keep the order the rows were stored in. */
function sortBy(rows: Row[], orderBy: Row): Row[] {
  const [[key, dir]] = Object.entries(orderBy);
  return rows
    .map((r, i) => [r, i] as const)
    .sort(([a, i], [b, j]) => {
      const c = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
      return (dir === 'desc' ? -c : c) || i - j;
    })
    .map(([r]) => r);
}

/** `select`: only the columns asked for come back, and the one relation the engine reads (`activities`, with its own where / orderBy / take / select). */
function project(row: Row, select: Row, shelf: Shelf): Row {
  const out: Row = {};
  for (const [key, spec] of Object.entries(select)) {
    if (spec === true) {
      out[key] = row[key];
      continue;
    }
    if (key !== 'activities') throw new Error(`the fake does not know the relation ${key}`);
    let rows = shelf.activities.filter((a) => a.orderId === row.id && matches('activity', a, spec.where));
    if (spec.orderBy) rows = sortBy(rows, spec.orderBy);
    if (spec.take !== undefined) rows = rows.slice(0, spec.take);
    out[key] = rows.map((a) => project(a, spec.select, shelf));
  }
  return out;
}

/** The engine's own client over the shelf: only the tables `proposeShortfalls` touches, and a record of what it wrote. */
function engineTx(shelf: Shelf) {
  const written = { penalties: [] as Row[], activities: [] as Row[] };
  let n = 0;
  const tx = {
    order: {
      findMany: async ({ where, select }: Row) => shelf.orders.filter((o) => matches('order', o, where)).map((o) => project(o, select, shelf)),
    },
    deliveryAttempt: {
      findMany: async ({ where, orderBy, select }: Row) =>
        sortBy(shelf.attempts.filter((a) => matches('deliveryAttempt', a, where)), orderBy).map((a) => project(a, select, shelf)),
    },
    user: {
      findMany: async ({ where, orderBy, select }: Row) => {
        const rows = shelf.users.filter((u) => matches('user', u, where));
        return (orderBy ? sortBy(rows, orderBy) : rows).map((u) => project(u, select, shelf));
      },
    },
    penalty: {
      findMany: async ({ where, select }: Row) =>
        [...shelf.penalties, ...written.penalties].filter((p) => matches('penalty', p, where)).map((p) => project(p, select, shelf)),
      create: async ({ data }: Row) => {
        const row = { id: `pen-${++n}`, ...data };
        written.penalties.push(row);
        return { id: row.id };
      },
    },
    orderActivity: {
      create: async ({ data }: Row) => {
        written.activities.push(data);
        return {};
      },
    },
  };
  return { tx, written };
}

/* ═════════════════════════ the world of the case ═════════════════════════ */

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 13, 8, 0, seconds));

const PEOPLE: Row[] = [
  { id: 'u-A', companyId: 'c1', name: 'سارة', role: 'FOLLOW_UP_AGENT', status: 'ACTIVE' },
  { id: 'u-B', companyId: 'c1', name: 'منى', role: 'FOLLOW_UP_AGENT', status: 'ACTIVE' },
  { id: 'u-C', companyId: 'c1', name: 'ليلى', role: 'FOLLOW_UP_AGENT', status: 'ACTIVE' },
  { id: 'u-owner', companyId: 'c1', name: 'المالك', role: 'SUPER_ADMIN', status: 'ACTIVE' },
  { id: 'u-approver', companyId: 'c1', name: 'المحاسب', role: 'ACCOUNTANT', status: 'ACTIVE' },
  { id: 'u-conf', companyId: 'c1', name: 'مؤكد', role: 'CONFIRMATION_AGENT', status: 'ACTIVE' },
  { id: 'u-mod', companyId: 'c1', name: 'مودريتر', role: 'MODERATOR', status: 'ACTIVE' },
];

/** The company's statement came in at second 100 — everything in the cases below happens before it. */
const SCOPE: ShortfallScope = {
  companyId: 'c1',
  storeId: 's1',
  approverId: 'u-approver',
  statement: { id: 'st1', reference: 'JO-ST-7', currencyCode: 'JOD', importedAt: at(100) },
  fallbackDeliveredAt: at(0),
  minorUnit: 3,
};

/** Expected 43 + a fee of 2; the company's line says 38 + 2: five dinars short. */
const short = (n: string, over: Partial<ShortfallCandidate> = {}): ShortfallCandidate => ({
  matchId: `m-${n}`,
  orderId: `o-${n}`,
  orderNumber: `ORD-${n}`,
  expectedAmount: 43,
  expectedFee: 2,
  statementAmount: 38,
  statementFee: 2,
  explanation: 'الشركة دفعت أقل',
  ...over,
});

let rowSeq = 0;
const order = (n: string, over: Row = {}): Row => ({
  id: `o-${n}`,
  companyId: 'c1',
  shippingStatus: 'DELIVERED',
  deliveredAt: at(15),
  moderatorId: 'u-mod',
  confirmedById: 'u-conf',
  ...over,
});
const press = (n: string, agent: string | null, s: number, result = 'DELIVERED'): Row => ({
  id: `d-${++rowSeq}`,
  companyId: 'c1',
  orderId: `o-${n}`,
  attemptNumber: rowSeq,
  result,
  deliveryAgentId: agent,
  createdAt: at(s),
});
const activity = (n: string, action: string, s: number): Row => ({ id: `a-${++rowSeq}`, companyId: 'c1', orderId: `o-${n}`, action, createdAt: at(s) });
const undone = (n: string, s: number) => activity(n, DELIVERY_UNDO_ACTION, s);

const shelfOf = (over: Partial<Shelf> = {}): Shelf => ({ orders: [], activities: [], attempts: [], users: PEOPLE, penalties: [], ...over });

type Engine = (tx: never, scope: ShortfallScope, candidates: ShortfallCandidate[]) => Promise<ShortfallResult>;
/** One approval against a shelf: the answer AND everything it wrote. */
async function run(shelf: Shelf, candidates: ShortfallCandidate[], naming?: Record<string, string>, engine: Engine = proposeShortfalls) {
  const { tx, written } = engineTx(shelf);
  const result = await engine(tx as never, { ...SCOPE, naming }, candidates);
  return { result, penalties: written.penalties, activities: written.activities };
}
const chargedTo = (r: ShortfallResult) => r.charges.map((c) => [c.matchId, c.userId, c.amount]);

/* ═════════════════════════ 1 · THE CASE, AND WHAT FOLLOWS FROM IT ═════════════════════════ */

describe('the reviewer’s case, in dinars: A pressed «استلم» by mistake, the owner took the delivery back, the company then paid 38 + 2 against 43 + 2', () => {
  const afterTheUndo = () => shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10)], activities: [undone('1', 20)] });

  it('A is charged NOTHING — the approval stops and asks who, for the five dinars', async () => {
    const out = await run(afterTheUndo(), [short('1')]);
    expect(out.result.charges).toEqual([]);
    expect(out.result.stop).toMatchObject({
      code: 'SHORTFALL_UNNAMED',
      lines: [{ matchId: 'm-1', orderNumber: 'ORD-1', amount: 5, currencyCode: 'JOD' }],
    });
    expect(out.penalties).toEqual([]);
    expect(out.activities).toEqual([]);
  });

  it('and everything else comes out exactly as for an order nobody ever pressed — the same stop, the same person named, the same «على الشركة»', async () => {
    const neverPressed = shelfOf({ orders: [order('1')] });
    for (const naming of [undefined, { 'm-1': 'u-B' }, { 'm-1': ON_THE_COMPANY }, { 'm-1': 'u-owner' }, { 'm-1': 'u-approver' }, { 'm-1': 'u-conf' }]) {
      expect(await run(afterTheUndo(), [short('1')], naming), JSON.stringify(naming)).toEqual(await run(neverPressed, [short('1')], naming));
    }
  });

  it('the approver names B: B carries 5.000 as a PROPOSED row, with the words and the day the engine always wrote', async () => {
    const out = await run(afterTheUndo(), [short('1')], { 'm-1': 'u-B' });
    expect(chargedTo(out.result)).toEqual([['m-1', 'u-B', 5]]);
    expect(out.penalties).toHaveLength(1);
    expect(out.penalties[0]).toMatchObject({
      companyId: 'c1',
      storeId: 's1',
      userId: 'u-B',
      ruleId: null,
      kind: SHORTFALL_KIND,
      units: 1,
      chargedUnits: 1,
      amount: 5,
      currencyCode: 'JOD',
      status: 'PROPOSED',
      note: shortfallNote({ orderNumber: 'ORD-1', reference: 'JO-ST-7', explanation: 'الشركة دفعت أقل' }),
      settlementMatchId: 'm-1',
    });
    expect(out.penalties[0].occurredOn).toEqual(dayOf(at(15)));
    expect(out.activities.map((a) => [a.action, a.orderId, a.userId])).toEqual([['SHORTFALL_PROPOSED', 'o-1', 'u-approver']]);
  });

  it('CONTROL — the same press WITHOUT the undo still names A, as it always did: the engine did not stop charging the one who stood at the door', async () => {
    const stands = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10)] });
    const out = await run(stands, [short('1')]);
    expect(chargedTo(out.result)).toEqual([['m-1', 'u-A', 5]]);
    expect(out.penalties[0]).toMatchObject({ userId: 'u-A', amount: 5, status: 'PROPOSED' });
  });
});

describe('a NEW press after the undo names its own person — and only what came after the undo counts', () => {
  it('A (mistake) → undone → B presses it again: B carries it, not A', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-B', 30)], activities: [undone('1', 20)] });
    const out = await run(shelf, [short('1')]);
    expect(chargedTo(out.result)).toEqual([['m-1', 'u-B', 5]]);
    expect(out.result.stop).toBeNull();
  });

  it('the same person pressing again after the undo is charged for the NEW press', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-A', 30)], activities: [undone('1', 20)] });
    expect(chargedTo((await run(shelf, [short('1')])).result)).toEqual([['m-1', 'u-A', 5]]);
  });

  it('the window is between the undo and the import: a press after the import is still no door, and a press before the undo is no door either', async () => {
    const shelf = shelfOf({
      orders: [order('1')],
      attempts: [press('1', 'u-A', 10), press('1', 'u-B', 30), press('1', 'u-C', 150)],
      activities: [undone('1', 20)],
    });
    expect(chargedTo((await run(shelf, [short('1')])).result)).toEqual([['m-1', 'u-B', 5]]);
  });

  it('a partly delivered press after the undo names its person too (the door’s two results both count)', async () => {
    expect([...DOOR_RESULTS]).toEqual(['DELIVERED', 'PARTIALLY_DELIVERED']);
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-B', 30, 'PARTIALLY_DELIVERED')], activities: [undone('1', 20)] });
    expect(chargedTo((await run(shelf, [short('1')])).result)).toEqual([['m-1', 'u-B', 5]]);
  });

  it('the owner presses after the undo: he is not charged — and A, from before the undo, does not take his place; the approver names someone', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-owner', 30)], activities: [undone('1', 20)] });
    const out = await run(shelf, [short('1')]);
    expect(out.result.charges).toEqual([]);
    expect(out.result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
    expect(out.penalties).toEqual([]);
  });

  it('only the owner’s press from BEFORE the undo and nobody after: the same stop — a dead press names nobody, a manager’s or an employee’s alike', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-owner', 10)], activities: [undone('1', 20)] });
    expect((await run(shelf, [short('1')])).result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
  });
});

describe('an undo twice, a tie, and what is NOT an undo', () => {
  it('undone twice: what lies between the two undos is as dead as what lies before the first — only a press after the LAST undo counts', async () => {
    const attempts = [press('1', 'u-A', 10), press('1', 'u-B', 30), press('1', 'u-C', 50)];
    const activities = [undone('1', 20), undone('1', 40)];
    const shelf = shelfOf({ orders: [order('1')], attempts, activities });
    expect(chargedTo((await run(shelf, [short('1')])).result)).toEqual([['m-1', 'u-C', 5]]);

    // …and when nobody presses after the last one, nobody is named
    const last = shelfOf({ orders: [order('1')], attempts: attempts.slice(0, 2), activities });
    expect((await run(last, [short('1')])).result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
  });

  it('the order the undo rows are stored in does not matter: the LATEST one cuts', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-B', 30)], activities: [undone('1', 40), undone('1', 20)] });
    expect((await run(shelf, [short('1')])).result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
  });

  it('a press stamped at the very instant of the undo is not after it: it names nobody (when in doubt, nobody is charged on a guess)', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 20)], activities: [undone('1', 20)] });
    expect((await run(shelf, [short('1')])).result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED' });
    // one second later it does
    const later = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 21)], activities: [undone('1', 20)] });
    expect(chargedTo((await run(later, [short('1')])).result)).toEqual([['m-1', 'u-A', 5]]);
  });

  it('NOTHING ELSE cuts: a shipping move, a door recording, a status change or a shortfall row on the order — however new — leaves the door where it was', async () => {
    const shelf = shelfOf({
      orders: [order('1')],
      attempts: [press('1', 'u-A', 10)],
      activities: [
        activity('1', 'SHIPPING_STATUS_CHANGED', 50),
        activity('1', 'PARTIAL_DELIVERY_RECORDED', 60),
        activity('1', 'STATUS_CHANGED', 70),
        activity('1', 'SHORTFALL_PROPOSED', 80),
        activity('1', 'DELIVERY_UNDO', 90),
      ],
    });
    expect(chargedTo((await run(shelf, [short('1')])).result)).toEqual([['m-1', 'u-A', 5]]);
  });
});

describe('two orders, ONE of them undone', () => {
  const both = () =>
    shelfOf({
      orders: [order('1'), order('2')],
      attempts: [press('1', 'u-A', 10), press('2', 'u-A', 12)],
      // the undo of order 1 is NEWER than both presses — a cut that was not per order would take order 2's press too
      activities: [undone('1', 50)],
    });

  it('the undone order loses its door and is asked about; the other keeps A, whatever the undo’s time', async () => {
    const out = await run(both(), [short('1'), short('2')]);
    expect(out.result.charges).toEqual([]);
    expect(out.result.stop).toMatchObject({ code: 'SHORTFALL_UNNAMED', lines: [{ matchId: 'm-1', amount: 5 }] });
    expect((out.result.stop as { lines: UnnamedLine[] }).lines).toHaveLength(1);
  });

  it('once the approver names the undone one, A still carries the order that was never undone — and the named person carries the other', async () => {
    const out = await run(both(), [short('1'), short('2')], { 'm-1': 'u-B' });
    expect(chargedTo(out.result)).toEqual([
      ['m-1', 'u-B', 5],
      ['m-2', 'u-A', 5],
    ]);
  });

  it('the same two orders with the undo on the OTHER one: the answer swaps with it', async () => {
    const swapped = shelfOf({ orders: [order('1'), order('2')], attempts: [press('1', 'u-A', 10), press('2', 'u-A', 12)], activities: [undone('2', 50)] });
    const out = await run(swapped, [short('1'), short('2')], { 'm-2': 'u-B' });
    expect(chargedTo(out.result)).toEqual([
      ['m-1', 'u-A', 5],
      ['m-2', 'u-B', 5],
    ]);
  });
});

describe('what it does not change in the approval’s other rules', () => {
  it('a parcel coming back, a line already charged, and a line that is not short are left as they were — undone or not', async () => {
    const coming = shelfOf({ orders: [order('1', { shippingStatus: 'RETURN_REQUESTED' })], attempts: [press('1', 'u-A', 30)], activities: [undone('1', 20)] });
    expect((await run(coming, [short('1')])).result).toEqual({ charges: [], onCompany: [], stop: null });

    const held = shelfOf({
      orders: [order('1')],
      attempts: [press('1', 'u-A', 30)],
      activities: [undone('1', 20)],
      penalties: [{ id: 'p0', settlementMatchId: 'm-1', status: 'PROPOSED' }],
    });
    expect((await run(held, [short('1')])).result.charges).toEqual([]);

    const paidEnough = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 30)], activities: [undone('1', 20)] });
    expect((await run(paidEnough, [short('1', { statementAmount: 43 })])).result).toEqual({ charges: [], onCompany: [], stop: null });
  });

  it('an approval with no shortfall still reads and writes nothing at all', async () => {
    const shelf = shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 30)], activities: [undone('1', 20)] });
    const { tx, written } = engineTx(shelf);
    const reads: string[] = [];
    const watched = new Proxy(tx, { get: (t, table: string) => (reads.push(table), (t as Row)[table]) });
    const r = await proposeShortfalls(watched as never, SCOPE, [short('1', { statementAmount: 43 })]);
    expect(r).toEqual({ charges: [], onCompany: [], stop: null });
    expect(reads).toEqual([]);
    expect(written).toEqual({ penalties: [], activities: [] });
  });

  it('the people and the roles it may charge are the ones it always had', () => {
    expect([...NEVER_CHARGED_ROLES].sort()).toEqual(['COMPANY_ADMIN', 'DELIVERY_MANAGER', 'MANAGER', 'SUPER_ADMIN']);
    expect(mayCarryShortfall('FOLLOW_UP_AGENT')).toBe(true);
    expect(shortfallOf({ expectedAmount: 43, expectedFee: 2, statementAmount: 38, statementFee: 2 }, 3)).toBe(5);
  });
});

/* ═════════════════════════ 2 · DIFFERENTIAL — THE ENGINE AS IT WAS, AGAINST THE ENGINE NOW ═════════════════════════ */

/*
 * THE ENGINE BEFORE THIS CHANGE, COPIED VERBATIM from `src/lib/shortfall.ts` at b9fdab5b (the main this change was last merged with): the function from
 * `export async function proposeShortfalls(` to the end of the file, with only its name changed (`proposeShortfallsBefore`). To check the copy:
 *
 *     git show b9fdab5b:src/lib/shortfall.ts | tr -d '\r' | sed -n '/^export async function proposeShortfalls(/,$p'
 *
 * must equal the block below from `async function proposeShortfallsBefore(` on, except for that first line's name (186 lines).
 */
type Tx = {
  order: { findMany: (a: Row) => Promise<{ id: string; shippingStatus: string; deliveredAt: Date | null; moderatorId: string | null; confirmedById: string | null }[]> };
  deliveryAttempt: { findMany: (a: Row) => Promise<{ orderId: string; deliveryAgentId: string | null }[]> };
  user: { findMany: (a: Row) => Promise<{ id: string; name: string; role: string }[]> };
  penalty: { findMany: (a: Row) => Promise<{ settlementMatchId: string | null }[]>; create: (a: Row) => Promise<{ id: string }> };
  orderActivity: { create: (a: Row) => Promise<unknown> };
};
const COMING_BACK = ['RETURN_REQUESTED', 'RETURNED'];

async function proposeShortfallsBefore(
  tx: Tx,
  scope: ShortfallScope,
  candidates: ShortfallCandidate[]
): Promise<ShortfallResult> {
  const result: ShortfallResult = { charges: [], onCompany: [], stop: null };

  const owing = candidates
    .filter((c) => !c.exchange)
    .map((c) => ({ c, amount: shortfallOf(c, scope.minorUnit) }))
    .filter((x) => x.amount > 0);
  if (owing.length === 0) return result;

  const orderIds = owing.map((x) => x.c.orderId);
  const orders = await tx.order.findMany({
    where: { id: { in: orderIds }, companyId: scope.companyId },
    select: { id: true, shippingStatus: true, deliveredAt: true, moderatorId: true, confirmedById: true },
  });
  const orderOf = new Map(orders.map((o) => [o.id, o]));

  // A parcel coming back is paid nothing because it was not delivered, not because somebody kept the money.
  const collected = owing.filter((x) => {
    const o = orderOf.get(x.c.orderId);
    return !!o && !COMING_BACK.includes(o.shippingStatus);
  });
  if (collected.length === 0) return result;

  // The door: the latest delivered attempt made BEFORE the import, by whoever pressed it.
  const attempts = await tx.deliveryAttempt.findMany({
    where: {
      companyId: scope.companyId,
      orderId: { in: collected.map((x) => x.c.orderId) },
      result: { in: [...DOOR_RESULTS] },
      createdAt: { lt: scope.statement.importedAt },
    },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, deliveryAgentId: true },
  });
  const doorOf = new Map<string, string | null>();
  for (const a of attempts) if (!doorOf.has(a.orderId)) doorOf.set(a.orderId, a.deliveryAgentId);

  // Everybody who could carry a line: the door's people and the ones the approver named.
  const naming = scope.naming ?? {};
  const wantedIds = new Set<string>();
  for (const x of collected) {
    const door = doorOf.get(x.c.orderId);
    if (door) wantedIds.add(door);
    const named = naming[x.c.matchId];
    if (named && named !== ON_THE_COMPANY) wantedIds.add(named);
  }
  const users = wantedIds.size
    ? await tx.user.findMany({
        where: { id: { in: [...wantedIds] }, companyId: scope.companyId, status: 'ACTIVE' },
        select: { id: true, name: true, role: true },
      })
    : [];
  const userOf = new Map(users.map((u) => [u.id, u]));

  // One live charge per line: a line that already carries one is never charged again.
  const already = await tx.penalty.findMany({
    where: {
      settlementMatchId: { in: collected.map((x) => x.c.matchId) },
      status: { in: ['PROPOSED', 'APPLIED'] },
    },
    select: { settlementMatchId: true },
  });
  const held = new Set(already.map((p) => p.settlementMatchId));

  const unnamed: UnnamedLine[] = [];
  const bad: { matchId: string; orderNumber: string; why: string }[] = [];
  const toCharge: { x: (typeof collected)[number]; user: { id: string; name: string } }[] = [];

  for (const x of collected) {
    if (held.has(x.c.matchId)) continue;
    const order = orderOf.get(x.c.orderId)!;

    // The door names the person. An owner or a manager on the door is not charged, and not replaced by the
    // attempt before it either: the line is then the approver's to name.
    const door = doorOf.get(x.c.orderId);
    const doorUser = door ? userOf.get(door) : undefined;
    if (doorUser && mayCarryShortfall(doorUser.role)) {
      toCharge.push({ x, user: doorUser });
      continue;
    }

    const named = naming[x.c.matchId];
    if (named === ON_THE_COMPANY) {
      result.onCompany.push({ matchId: x.c.matchId, orderNumber: x.c.orderNumber, amount: x.amount });
      continue;
    }
    if (!named) {
      unnamed.push({ matchId: x.c.matchId, orderNumber: x.c.orderNumber, amount: x.amount, currencyCode: scope.statement.currencyCode });
      continue;
    }

    const person = userOf.get(named);
    const why = !person
      ? 'الموظف غير موجود أو غير فعّال'
      : !mayCarryShortfall(person.role)
        ? 'المالك والمدراء لا يتحمّلون فرق التحصيل'
        : person.id === scope.approverId
          ? 'لا تسمِّ نفسك'
          : person.id === order.moderatorId || person.id === order.confirmedById
            ? 'مؤكّد الطلب أو مودريتره لا يتحمّل فرق التحصيل — هو باع ولم يتابع الطرد'
            : null;
    if (why) {
      bad.push({ matchId: x.c.matchId, orderNumber: x.c.orderNumber, why });
      continue;
    }
    toCharge.push({ x, user: person! });
  }

  if (bad.length > 0) {
    result.stop = { code: 'SHORTFALL_BAD_PERSON', lines: bad };
    return result;
  }
  if (unnamed.length > 0) {
    const candidatesList = await tx.user.findMany({
      where: { companyId: scope.companyId, status: 'ACTIVE', role: { notIn: [...NEVER_CHARGED_ROLES] }, id: { not: scope.approverId } },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
    result.stop = { code: 'SHORTFALL_UNNAMED', lines: unnamed, candidates: candidatesList };
    return result;
  }

  for (const { x, user } of toCharge) {
    const order = orderOf.get(x.c.orderId)!;
    const penalty = await tx.penalty.create({
      data: {
        companyId: scope.companyId,
        storeId: scope.storeId,
        userId: user.id,
        ruleId: null,
        kind: SHORTFALL_KIND,
        occurredOn: dayOf(order.deliveredAt ?? scope.fallbackDeliveredAt),
        units: 1,
        chargedUnits: 1,
        amount: x.amount,
        currencyCode: scope.statement.currencyCode,
        status: 'PROPOSED',
        note: shortfallNote({ orderNumber: x.c.orderNumber, reference: scope.statement.reference, explanation: x.c.explanation }),
        settlementMatchId: x.c.matchId,
      },
      select: { id: true },
    });
    result.charges.push({
      penaltyId: penalty.id,
      userId: user.id,
      userName: user.name,
      matchId: x.c.matchId,
      orderNumber: x.c.orderNumber,
      amount: x.amount,
      currencyCode: scope.statement.currencyCode,
    });
    await tx.orderActivity.create({
      data: {
        companyId: scope.companyId,
        orderId: x.c.orderId,
        userId: scope.approverId,
        action: 'SHORTFALL_PROPOSED',
        metadata: JSON.stringify({
          statement: scope.statement.reference,
          amount: x.amount,
          currency: scope.statement.currencyCode,
          employee: user.id,
        }),
      },
    });
  }

  for (const c of result.onCompany) {
    const x = collected.find((y) => y.c.matchId === c.matchId)!;
    await tx.orderActivity.create({
      data: {
        companyId: scope.companyId,
        orderId: x.c.orderId,
        userId: scope.approverId,
        action: 'SHORTFALL_ON_COMPANY',
        metadata: JSON.stringify({ statement: scope.statement.reference, amount: c.amount, currency: scope.statement.currencyCode }),
      },
    });
  }

  return result;
}

/* ─────────── the seeded worlds ─────────── */

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES = ['FOLLOW_UP_AGENT', 'FOLLOW_UP_AGENT', 'ACCOUNTANT', 'WAREHOUSE', 'SETTLEMENT_OFFICER', 'MANAGER', 'SUPER_ADMIN', 'DELIVERY_MANAGER', 'CONFIRMATION_AGENT', 'MODERATOR'];
const STATUSES = ['DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'SHIPPED', 'RETURN_REQUESTED', 'RETURNED'];
const RESULTS = ['DELIVERED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'FAILED', 'CUSTOMER_UNAVAILABLE', 'RESCHEDULED'];
const OTHER_ACTIONS = ['SHIPPING_STATUS_CHANGED', 'PARTIAL_DELIVERY_RECORDED', 'STATUS_CHANGED', 'SHORTFALL_PROPOSED', 'NOTE_ADDED'];

interface Case {
  shelf: Shelf;
  candidates: ShortfallCandidate[];
  naming: Record<string, string>;
  minorUnit: number;
}

/** A coarse clock (a step of 50 seconds over 2000) so that presses and undos DO land on the same instant now and then. The import is at second 1000. */
const IMPORT_AT = 1000;
function randomCase(seed: number, withUndo: boolean): Case {
  const rnd = prng(seed);
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T,>(xs: readonly T[]): T => xs[int(xs.length)];
  const chance = (p: number) => rnd() < p;
  const tick = () => at(int(41) * 50);

  const users: Row[] = Array.from({ length: 6 }, (_, i) => ({
    id: `u${i + 1}`,
    companyId: 'c1',
    name: `موظف ${i + 1}`,
    role: pick(ROLES),
    status: chance(0.85) ? 'ACTIVE' : 'SUSPENDED',
  }));
  users.push({ id: 'u-approver', companyId: 'c1', name: 'المحاسب', role: 'ACCOUNTANT', status: 'ACTIVE' });
  const ids = [...users.map((u) => u.id as string)];

  const shelf: Shelf = { orders: [], activities: [], attempts: [], users, penalties: [] };
  const candidates: ShortfallCandidate[] = [];
  const naming: Record<string, string> = {};
  const minorUnit = pick([2, 3]);
  // how the approver answers the lines no door names: not at all · at random (a stranger, the owner, himself, «على الشركة»…) · an ordinary employee who may carry it
  const answers = pick(['none', 'random', 'valid', 'valid']);
  let n = 0;

  const orders = 1 + int(4);
  for (let i = 1; i <= orders; i++) {
    const orderId = `o${i}`;
    const moderatorId = chance(0.4) ? pick(ids) : null;
    const confirmedById = chance(0.4) ? pick(ids) : null;
    shelf.orders.push({ id: orderId, companyId: 'c1', shippingStatus: pick(STATUSES), deliveredAt: chance(0.7) ? tick() : null, moderatorId, confirmedById });

    // a world with undos is dense with presses (one to four per order), so the undo has something to cut
    for (let k = withUndo ? 1 + int(4) : int(5); k > 0; k--) {
      shelf.attempts.push({
        id: `d${++n}`,
        companyId: chance(0.95) ? 'c1' : 'c2',
        orderId,
        attemptNumber: n,
        result: pick(RESULTS),
        deliveryAgentId: chance(0.12) ? null : chance(0.1) ? 'ghost' : pick(ids),
        createdAt: tick(),
      });
    }
    for (let k = int(4); k > 0; k--) shelf.activities.push({ id: `a${++n}`, companyId: 'c1', orderId, action: pick(OTHER_ACTIONS), createdAt: tick() });
    if (withUndo && chance(0.65)) {
      for (let k = 1 + int(2); k > 0; k--) shelf.activities.push({ id: `a${++n}`, companyId: 'c1', orderId, action: DELIVERY_UNDO_ACTION, createdAt: tick() });
    }

    const expected = 20 + int(30);
    const fee = int(4);
    candidates.push({
      matchId: `m${i}`,
      orderId,
      orderNumber: `ORD-${i}`,
      expectedAmount: chance(0.1) ? String(expected) : expected,
      expectedFee: chance(0.1) ? null : fee,
      statementAmount: expected - 6 + int(9),
      statementFee: chance(0.1) ? null : chance(0.6) ? fee : Math.max(0, fee - 1 + int(3)),
      claimPayment: chance(0.1),
      // «طلب تبديل» (#267): a line answered so is no candidate at all — it rides along in the worlds so that rule is compared too
      exchange: chance(0.08),
      explanation: chance(0.5) ? 'خصم' : null,
    });
    if (chance(0.1)) shelf.penalties.push({ id: `p${i}`, settlementMatchId: `m${i}`, status: pick(['PROPOSED', 'APPLIED', 'WAIVED', 'REVERSED']) });
    if (answers === 'random' && chance(0.7)) naming[`m${i}`] = pick([ON_THE_COMPANY, ...ids, 'ghost']);
    if (answers === 'valid') {
      const fit = users.filter((u) => u.status === 'ACTIVE' && mayCarryShortfall(u.role) && u.id !== 'u-approver' && u.id !== moderatorId && u.id !== confirmedById);
      naming[`m${i}`] = fit.length && chance(0.9) ? pick(fit).id : ON_THE_COMPANY;
    }
  }
  return { shelf, candidates, naming, minorUnit };
}

async function runCase(c: Case, engine: Engine, shelf = c.shelf) {
  const { tx, written } = engineTx(shelf);
  const scope: ShortfallScope = { ...SCOPE, minorUnit: c.minorUnit, statement: { ...SCOPE.statement, importedAt: at(IMPORT_AT) }, naming: c.naming };
  let result: ShortfallResult | { threw: string };
  try {
    result = await engine(tx as never, scope, c.candidates);
  } catch (e) {
    result = { threw: String(e) };
  }
  return { result, penalties: written.penalties, activities: written.activities };
}

const before: Engine = (tx, scope, candidates) => proposeShortfallsBefore(tx as unknown as Tx, scope, candidates);

describe('DIFFERENTIAL — the engine before (verbatim above) against the engine now', () => {
  const CASES = 3000;

  it('P1 · with NO undo row anywhere, the two give the same answer and write the same rows — on 3000 seeded worlds', async () => {
    const seen = { charged: 0, unnamed: 0, bad: 0, company: 0, written: 0, threw: 0, someDoor: 0, exchange: 0 };
    for (let seed = 1; seed <= CASES; seed++) {
      const c = randomCase(seed, false);
      expect(c.shelf.activities.some((a) => a.action === DELIVERY_UNDO_ACTION)).toBe(false);
      const was = await runCase(c, before);
      const now = await runCase(c, proposeShortfalls);
      expect(now, `seed ${seed}`).toEqual(was);

      const r = now.result as ShortfallResult;
      if ('threw' in now.result) seen.threw++;
      else {
        if (r.charges.length) seen.charged++;
        if (r.stop?.code === 'SHORTFALL_UNNAMED') seen.unnamed++;
        if (r.stop?.code === 'SHORTFALL_BAD_PERSON') seen.bad++;
        if (r.onCompany.length) seen.company++;
      }
      if (now.penalties.length) seen.written++;
      if (c.shelf.attempts.some((a) => a.companyId === 'c1' && (DOOR_RESULTS as readonly string[]).includes(a.result))) seen.someDoor++;
      if (c.candidates.some((x) => x.exchange)) seen.exchange++;
    }
    // not a vacuous comparison: every road of the engine was walked many times (measured: 1255 charged · 598 unnamed · 241 bad person · 181 «على الشركة» · 551 worlds with an «طلب تبديل» line), and nothing threw
    const said = JSON.stringify(seen);
    expect(seen.threw, said).toBe(0);
    expect(seen.charged, said).toBeGreaterThan(800);
    expect(seen.unnamed, said).toBeGreaterThan(400);
    expect(seen.bad, said).toBeGreaterThan(150);
    expect(seen.company, said).toBeGreaterThan(120);
    expect(seen.written, said).toBeGreaterThan(800);
    expect(seen.someDoor, said).toBeGreaterThan(2000);
    expect(seen.exchange, said).toBeGreaterThan(300);
  });

  it('P2 · with undo rows, the answer is the OLD engine’s answer on the same world with the dead attempts taken out — on 3000 seeded worlds, and the undo changes the answer in many of them', async () => {
    const seen = { withUndo: 0, mattered: 0, charged: 0, unnamed: 0, ties: 0 };
    for (let seed = 1; seed <= CASES; seed++) {
      const c = randomCase(seed + 100_000, true);

      // the dead attempts, by the rule in words: an attempt is dead when its order has an undo at or after its own time
      const latestUndo = new Map<string, Date>();
      for (const a of c.shelf.activities) {
        if (a.action !== DELIVERY_UNDO_ACTION) continue;
        const have = latestUndo.get(a.orderId);
        if (!have || a.createdAt > have) latestUndo.set(a.orderId, a.createdAt);
      }
      const dead = (a: Row) => latestUndo.has(a.orderId) && a.createdAt <= latestUndo.get(a.orderId)!;
      const erased: Shelf = { ...c.shelf, attempts: c.shelf.attempts.filter((a) => !dead(a)) };

      const now = await runCase(c, proposeShortfalls);
      const expected = await runCase(c, before, erased);
      expect(now, `seed ${seed}`).toEqual(expected);

      if (latestUndo.size > 0) seen.withUndo++;
      if (c.shelf.attempts.some((a) => dead(a) && a.createdAt.getTime() === latestUndo.get(a.orderId)!.getTime())) seen.ties++;
      const untouched = await runCase(c, before);
      if (JSON.stringify(untouched) !== JSON.stringify(now)) seen.mattered++;
      const r = now.result as ShortfallResult;
      if (r.charges?.length) seen.charged++;
      if (r.stop?.code === 'SHORTFALL_UNNAMED') seen.unnamed++;
    }
    // not vacuous: the undo is present in most worlds, it really changed the engine's answer in hundreds, and the tie rule was exercised
    // (measured: 2593 with an undo · 345 where the old engine's answer differs · 282 ties · 1196 charged · 661 unnamed)
    const said = JSON.stringify(seen);
    expect(seen.withUndo, said).toBeGreaterThan(2000);
    expect(seen.mattered, said).toBeGreaterThan(200);
    expect(seen.ties, said).toBeGreaterThan(150);
    expect(seen.charged, said).toBeGreaterThan(700);
    expect(seen.unnamed, said).toBeGreaterThan(400);
  });

  it('the verbatim copy behaves as the engine always did on four plain cases — one door, the newest door, an owner on the door, no door — and so does the engine now', async () => {
    const cases: [string, Shelf, Record<string, string> | undefined][] = [
      ['one door', shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10)] }), undefined],
      ['the newest door', shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-B', 20)] }), undefined],
      ['an owner on the door', shelfOf({ orders: [order('1')], attempts: [press('1', 'u-A', 10), press('1', 'u-owner', 20)] }), undefined],
      ['no door', shelfOf({ orders: [order('1')] }), { 'm-1': 'u-B' }],
    ];
    const expected = [['m-1', 'u-A', 5]];
    const newest = [['m-1', 'u-B', 5]];
    const got: Record<string, unknown> = {};
    for (const [name, shelf, naming] of cases) {
      const c: Case = { shelf, candidates: [short('1')], naming: naming ?? {}, minorUnit: 3 };
      const was = await runCase(c, before);
      got[name] = chargedTo(was.result as ShortfallResult);
      expect(await runCase(c, proposeShortfalls), name).toEqual(was);
    }
    expect(got['one door']).toEqual(expected);
    expect(got['the newest door']).toEqual(newest);
    expect(got['an owner on the door']).toEqual([]);
    expect(got['no door']).toEqual(newest);
  });
});
