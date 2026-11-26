import { describe, expect, it, vi } from 'vitest';
import { stripComments, repoFile } from './guard-source';
import { OFF_THE_LIST, expireLists, handToList, notAWinbackListOrder, notOnAPrivateList, offTheListIf, offeredBeforeWhere } from './winback-private-list';
import { duePostponedWhere, readyToPullWhere } from './confirmation-queue';
import { returnablePileWhere } from './return-no-answer-pile';

/**
 * F12, the reviews of 25/11 — WHERE A LIST ROW GOES WHEN IT LEAVES, AND WHO MAY NOT READ IT WHILE IT IS ON THE LIST.
 *
 *   · THE MARK SPEAKS ONLY WHILE THE ORDER IS NEW. A NEW order with the win-back mark and nobody holding it is «انعرض من قبل»: never
 *     pulled, handed out by a manager (not while an issue is open). Any other status makes the mark inert: the normal flow for its status.
 *   · Every exit takes the row off the LIST (no holder, no list clock) and keeps the mark — so a NEW release lands in the pool, a dated or
 *     «لا يرد» one is pulled in the normal flow, and no exit (a claim by id then a release included) leaves a row in no queue.
 *   · A transfer or a claim leaves a name (`assignedToId`): the pool does not ask it, and the hand-out clears it.
 *   · Every hand reader leaves a list row alone.
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
    if (k === 'NOT') {
      if (matches(row, v)) return false;
      continue;
    }
    if (k === 'issues') {
      // { none: { status: 'OPEN' } }
      if (row.openIssue === true) return false;
      continue;
    }
    const value = row[k];
    if (v === null) {
      if (value !== null && value !== undefined) return false;
    } else if (typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v && !(v.in as unknown[]).includes(value)) return false;
      if ('lte' in v && !(value instanceof Date && value.getTime() <= (v.lte as Date).getTime())) return false;
      if ('not' in v && v.not === null && (value === null || value === undefined)) return false;
      if ('not' in v && v.not !== null && value === v.not) return false;
    } else if (value !== v) return false;
  }
  return true;
}

const SCOPE = { companyId: 'c1', storeId: 's1' };
const NOW = new Date('2026-11-30T10:00:00Z');
const MARK = new Date('2026-11-27T10:00:00Z');

const listRow = (over: Row = {}): Row => ({
  ...SCOPE,
  claimedById: 'sara',
  assignedToId: null,
  confirmationStatus: 'NEW',
  shippingStatus: 'NOT_READY',
  postponedUntil: null,
  nextFollowUpAt: null,
  winbackListUserId: 'sara',
  winbackListAt: MARK,
  winbackListSince: MARK,
  openIssue: false,
  ...over,
});
/** What a door that lets the row go writes: the claim cleared, and the helper. */
const letGo = (row: Row, over: Row = {}): Row => ({ ...row, claimedById: null, ...offTheListIf(row as never), ...over });
const inPool = (row: Row) => matches(row, offeredBeforeWhere(SCOPE));
const pulled = (row: Row) => matches(row, readyToPullWhere(SCOPE)) || matches(row, duePostponedWhere(SCOPE, NOW));

describe('BLOCKER 1 — a NEW exit keeps the mark and lands in «انعرض من قبل»; a dated or non-NEW exit is the normal flow', () => {
  it('the helper takes the row off the LIST and keeps the mark; an order on no list writes nothing new', () => {
    expect(OFF_THE_LIST).toEqual({ winbackListUserId: null, winbackListSince: null });
    expect(offTheListIf({ winbackListUserId: 'sara' })).toEqual(OFF_THE_LIST);
    expect(offTheListIf({ winbackListUserId: null })).toEqual({});
    expect(offTheListIf(null)).toEqual({});
    expect('winbackListAt' in OFF_THE_LIST).toBe(false);
  });

  it('the pool predicate is «not a NEW order with the mark» — an OR of two plain clauses', () => {
    expect(notAWinbackListOrder).toEqual({ OR: [{ winbackListAt: null }, { confirmationStatus: { not: 'NEW' } }] });
  });

  it('a NEW list row released (her release, the manager’s pull-back, an issue) lands in the pool, never in a pull', () => {
    const back = letGo(listRow());
    expect(inPool(back)).toBe(true);
    expect(pulled(back)).toBe(false);
  });

  it('a postponed list row handed back is pulled on its date — never stuck', () => {
    const back = letGo(listRow({ confirmationStatus: 'POSTPONED', postponedUntil: new Date('2026-11-30T08:00:00Z') }));
    expect(pulled(back)).toBe(true);
    expect(inPool(back)).toBe(false);
  });

  it('a stood-down list row (POSTPONED again, nobody holds it) comes back on its date', () => {
    const back = letGo(listRow({ confirmationStatus: 'CONFIRMED' }), { confirmationStatus: 'POSTPONED', postponedUntil: new Date('2026-11-30T08:00:00Z') });
    expect(pulled(back)).toBe(true);
  });

  it('a «لا يرد» list row let go by any path is in the normal pull — the mark is inert', () => {
    const back = letGo(listRow({ confirmationStatus: 'NO_ANSWER' }));
    expect(matches(back, readyToPullWhere(SCOPE))).toBe(true);
    expect(inPool(back)).toBe(false);
  });

  it('a pool row with an OPEN issue is not handed out until the moderator corrects it — and the hand-out asks the same', async () => {
    const issue = letGo(listRow(), { openIssue: true });
    expect(inPool(issue)).toBe(false);
    expect(pulled(issue)).toBe(false);
    expect(inPool({ ...issue, openIssue: false })).toBe(true);
    const updateMany = vi.fn(async () => ({ count: 0 }));
    await handToList({ order: { updateMany }, orderActivity: { create: vi.fn() } } as never, { ...SCOPE, orderId: 'o1', agentId: 'huda', byUserId: 'm', now: NOW, rehand: true });
    expect((updateMany.mock.calls[0] as unknown as [{ where: Row }])[0].where).toMatchObject({ issues: { none: { status: 'OPEN' } } });
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

  it('B15/B16 — a transfer MOVES a list row to the target’s list and keeps the clock', () => {
    const src = stripComments(repoFile('src/app/api/orders/[id]/transfer/route.ts'));
    expect(src).toContain('...(order.winbackListUserId ? { winbackListUserId: target.id, winbackListSince: now } : offTheListIf(order)),');
    const write = src.slice(src.indexOf('const won = await db.order.updateMany('), src.indexOf('if (won.count !== 1)'));
    expect(write).not.toMatch(/winbackListAt\s*:/);
  });
});

describe('BLOCKER 2 (round 3) — a claim by id, then a release: never lost', () => {
  it('the claim by id takes the row off a list (the same rule), and the claim door passes it', () => {
    const locks = stripComments(repoFile('src/lib/order-locks.ts'));
    expect(locks).toContain('...(params.offList ? { winbackListUserId: null, winbackListSince: null } : {}),');
    expect(stripComments(repoFile('src/app/api/orders/[id]/claim/route.ts'))).toContain('offList: !!order.winbackListUserId,');
  });

  it('a pool row claimed by id and released while still NEW (with the claim’s name left on it) lands back in the pool', () => {
    const pool = letGo(listRow());
    // the claim by id: a holder and her name (atomicClaim writes assignedToId); then a release that leaves the name (the 90-minute one does)
    const claimed = { ...pool, claimedById: 'mona', assignedToId: 'mona' };
    expect(pulled(claimed)).toBe(false);
    const released = { ...claimed, claimedById: null };
    expect(inPool(released)).toBe(true);
    expect(pulled(released)).toBe(false);
  });

  it('the same row claimed, pressed «لا يرد», and released — the normal flow, never lost', () => {
    const pool = letGo(listRow());
    const released = { ...pool, claimedById: null, assignedToId: 'mona', confirmationStatus: 'NO_ANSWER' };
    expect(matches(released, readyToPullWhere(SCOPE))).toBe(true);
  });

  it('the hand-out clears whatever name a transfer or a claim left, and the pool never asked it', async () => {
    expect(offeredBeforeWhere(SCOPE)).not.toHaveProperty('assignedToId');
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await handToList({ order: { updateMany }, orderActivity: { create: vi.fn() } } as never, { ...SCOPE, orderId: 'o1', agentId: 'huda', byUserId: 'm', now: NOW, rehand: true });
    const { where, data } = (updateMany.mock.calls[0] as unknown as [{ where: Row; data: Row }])[0];
    expect(where).not.toHaveProperty('assignedToId');
    expect(data).toMatchObject({ assignedToId: null, assignedAt: null, claimedById: 'huda', winbackListUserId: 'huda' });
  });

  it('a transferred row that expires (3 days) is in the pool and can be handed out again', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    await expireLists({ order: { updateMany } } as never, SCOPE, NOW);
    const { data, where } = (updateMany.mock.calls[0] as unknown as [{ data: Row; where: Record<string, any> }])[0];
    expect('winbackListAt' in data).toBe(false);
    expect(where.shippingStatus).toBe('NOT_READY');
    const transferred = listRow({ assignedToId: 'huda', claimedById: 'huda', winbackListUserId: 'huda' });
    expect(inPool({ ...transferred, ...data })).toBe(true);
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
