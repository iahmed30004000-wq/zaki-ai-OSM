import { describe, expect, it, vi } from 'vitest';
import { stripComments, repoFile } from './guard-source';
import { OFF_THE_LIST, expireLists, notOnAPrivateList, offTheListIf, offeredBeforeWhere } from './winback-private-list';
import { duePostponedWhere, readyToPullWhere } from './confirmation-queue';
import { returnablePileWhere } from './return-no-answer-pile';

/**
 * F12, the review of 25/11 — WHERE A LIST ROW GOES WHEN IT LEAVES, AND WHO MAY NOT READ IT WHILE IT IS ON THE LIST.
 *
 *   · Every way a row leaves a private list (or «انعرض من قبل») by somebody's hand clears ALL THREE marks, so it rejoins the normal flow
 *     for its status: a postponed row handed back is pulled on its date; a stood-down row comes back. Only the 3-day expiry keeps
 *     `winbackListAt`.
 *   · A transferred row carries a name (`assignedToId`): the expiry clears it and the pool asks for none, so the re-hand can take it.
 *   · Every hand reader (the 90-minute release, the rounds, the manager's «لا يرد» pile, work-first, the supervisor's pool view, a date on
 *     the confirmation door) leaves a list row alone.
 */

/** A small reader of the where-objects these predicates are made of — enough to say whether ONE row is in. */
type Row = Record<string, unknown>;
function matches(row: Row, where: Record<string, any>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as any[]).some((w) => matches(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      if (!(v as any[]).every((w) => matches(row, w))) return false;
      continue;
    }
    const value = row[k];
    if (v === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !(v.in as unknown[]).includes(value)) return false;
      if ('lte' in v && !(value instanceof Date && value.getTime() <= (v.lte as Date).getTime())) return false;
      if ('not' in v && v.not === null && (value === null || value === undefined)) return false;
    } else if (value !== v) return false;
  }
  return true;
}

const SCOPE = { companyId: 'c1', storeId: 's1' };
const NOW = new Date('2026-11-30T10:00:00Z');

const listRow = (over: Row = {}): Row => ({
  ...SCOPE,
  claimedById: 'sara',
  assignedToId: null,
  confirmationStatus: 'POSTPONED',
  shippingStatus: 'NOT_READY',
  postponedUntil: new Date('2026-11-30T08:00:00Z'),
  nextFollowUpAt: null,
  winbackListUserId: 'sara',
  winbackListAt: new Date('2026-11-27T10:00:00Z'),
  winbackListSince: new Date('2026-11-27T10:00:00Z'),
  ...over,
});

describe('BLOCKER 1 — a row that leaves a list rejoins the normal flow for its status', () => {
  it('the helper clears all three marks of a list row and of a «انعرض من قبل» row; an ordinary order writes nothing new', () => {
    expect(OFF_THE_LIST).toEqual({ winbackListUserId: null, winbackListAt: null, winbackListSince: null });
    expect(offTheListIf({ winbackListUserId: 'sara', winbackListAt: new Date() })).toEqual(OFF_THE_LIST);
    expect(offTheListIf({ winbackListUserId: null, winbackListAt: new Date() })).toEqual(OFF_THE_LIST);
    expect(offTheListIf({ winbackListUserId: null, winbackListAt: null })).toEqual({});
    expect(offTheListIf({})).toEqual({});
  });

  it('a postponed list row handed back (claim and marks cleared) is pulled on its date — and kept out while it is on the list', () => {
    const due = duePostponedWhere(SCOPE, NOW);
    const onTheList = listRow();
    // on her list: held, so never in the pool
    expect(matches(onTheList, due)).toBe(false);
    // handed back the way the doors write it now
    const back = { ...onTheList, claimedById: null, ...offTheListIf(onTheList) };
    expect(matches(back, due)).toBe(true);
    // the old write (claim cleared, `winbackListAt` kept) is what lost it from every queue
    const lost = { ...onTheList, claimedById: null, winbackListUserId: null, winbackListSince: null };
    expect(matches(lost, due)).toBe(false);
    expect(matches(lost, offeredBeforeWhere(SCOPE))).toBe(false);
  });

  it('a stood-down list row (POSTPONED, nobody holds it) comes back on its date', () => {
    const stood = listRow({ confirmationStatus: 'CONFIRMED', shippingStatus: 'NOT_READY' });
    const after = { ...stood, confirmationStatus: 'POSTPONED', claimedById: null, ...offTheListIf(stood) };
    expect(matches(after, duePostponedWhere(SCOPE, NOW))).toBe(true);
  });

  it('a NEW list row released by hand is in the general pull again', () => {
    const row = listRow({ confirmationStatus: 'NEW', postponedUntil: null });
    expect(matches({ ...row, claimedById: null, ...offTheListIf(row) }, readyToPullWhere(SCOPE))).toBe(true);
  });

  it('every exit calls the one helper — the claim release and the forced take, the hand-back, the issue, the stand-down, the customer on the line', () => {
    for (const [file, times] of [
      ['src/app/api/orders/[id]/claim/route.ts', 2],
      ['src/app/api/confirmation/postponed/route.ts', 1],
      ['src/app/api/confirmation/issues/route.ts', 1],
      ['src/app/api/ops/shipments/stand-down/route.ts', 1],
      ['src/lib/customer-on-the-line.ts', 1],
    ] as const) {
      const src = stripComments(repoFile(file));
      expect((src.match(/\.\.\.offTheListIf\((order|row)\)/g) ?? []).length, file).toBe(times);
    }
  });

  it('B15/B16 — a transfer MOVES a list row to the target’s list and keeps the 3-day clock; a «انعرض من قبل» row leaves the pool whole', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/transfer/route.ts'));
    expect(src).toContain('...(order.winbackListUserId ? { winbackListUserId: target.id, winbackListSince: now } : offTheListIf(order)),');
    const write = src.slice(src.indexOf('const won = await db.order.updateMany('), src.indexOf('if (won.count !== 1)'));
    expect(write).not.toMatch(/winbackListAt\s*:/);
  });
});

describe('BLOCKER 2 — the pool and the re-hand agree on a transferred row', () => {
  it('the 3-day expiry clears the name a transfer wrote; the pool asks for nobody’s name — so a transfer → expiry → re-hand succeeds', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await expireLists({ order: { updateMany } } as never, SCOPE, NOW);
    const { data, where } = (updateMany.mock.calls[0] as unknown as [{ data: Row; where: Record<string, any> }])[0];
    expect(data).toMatchObject({ assignedToId: null, assignedAt: null, claimedById: null, winbackListUserId: null });
    expect('winbackListAt' in data).toBe(false);
    // B18: never a row that has left for the warehouse
    expect(where.shippingStatus).toBe('NOT_READY');
    // the row after the expiry is in the pool the re-hand reads, and the re-hand's own guard asks the same
    const transferred = listRow({ confirmationStatus: 'NEW', assignedToId: 'huda', claimedById: 'huda', winbackListUserId: 'huda' });
    const expired = { ...transferred, ...data };
    expect(matches(expired, offeredBeforeWhere(SCOPE))).toBe(true);
    // a row still carrying a name is NOT offered before — the pool and the re-hand both refuse it
    expect(matches({ ...expired, assignedToId: 'huda' }, offeredBeforeWhere(SCOPE))).toBe(false);
  });
});

describe('the hand readers leave a list row alone (each pinned where it reads)', () => {
  const body = (file: string, from: string, to: string) => {
    const src = stripComments(repoFile(file));
    const at = src.indexOf(from);
    expect(at, `${file}: ${from}`).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf(to, at + from.length));
  };

  it('B4 — the 90-minute release', () => {
    expect(body('src/lib/confirmation-queue.ts', 'export async function releaseStaleClaims(', 'const expired =')).toContain('...notOnAPrivateList');
  });

  it('B5 — the rounds release', () => {
    expect(body('src/lib/confirmation-queue.ts', 'async function releaseByRounds(', 'take:')).toContain('...notOnAPrivateList');
  });

  it('B7 — the manager’s «رجّع كومة لا يرد»', () => {
    const where = returnablePileWhere(SCOPE, 'sara', NOW, { quiet: NOW, held: NOW } as never);
    expect(where).toMatchObject(notOnAPrivateList);
  });

  it('B8 — work-first', () => {
    expect(body('src/lib/work-first.ts', 'claimedById: args.userId,', 'orderBy')).toContain('...notOnAPrivateList');
  });

  it('B10 — the supervisor’s pool view', () => {
    expect(stripComments(repoFile('src/app/api/confirmation/queue/route.ts'))).toContain(
      "where: { ...scope, claimedById: null, confirmationStatus: { in: OPEN_CONFIRMATION }, shippingStatus: 'NOT_READY', ...notAWinbackListOrder },"
    );
  });

  it('B11 — a date on the confirmation door never sends a list row to the pool', () => {
    expect(stripComments(repoFile('src/app/api/orders/[id]/confirmation/route.ts'))).toContain(
      'const releasesOnDate = writesADate && order.claimedById === user.id && !order.winbackListUserId && (await returnsModeOn(db, companyId));'
    );
  });
});
