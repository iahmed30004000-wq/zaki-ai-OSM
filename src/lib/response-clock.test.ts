import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «رددت خلال الآن» on every pulled order (the owner, 8/11, looking at an agent's desk of 489 orders).
 *
 * The response clock's «first action» read EVERY `CONFIRMATION` status log of the order — and the pull itself writes one
 * (`IN_PROGRESS`, «سحب من الطابور») at the instant it claims the order. So the first action was the pull, the clock said
 * «رددت خلال الآن» whatever she did, and «بانتظار أول اتصال» (shown only while there is no first action) never appeared.
 * What counts is what a PERSON did after: a logged contact attempt, or a decision. Every row below is invented.
 */
type Attempt = { orderId: string; createdAt: Date };
type StatusLog = { orderId: string; statusType: string; newValue: string; createdAt: Date };
type ValueFilter = { in?: string[]; notIn?: string[] } | undefined;

const fake = vi.hoisted(() => {
  const state = { attempts: [] as Attempt[], logs: [] as StatusLog[] };
  const groupMin = <T extends { orderId: string; createdAt: Date }>(rows: T[]) => {
    const least = new Map<string, Date>();
    for (const r of rows) {
      const known = least.get(r.orderId);
      if (!known || r.createdAt < known) least.set(r.orderId, r.createdAt);
    }
    return [...least].map(([orderId, createdAt]) => ({ orderId, _min: { createdAt } }));
  };
  const matches = (value: string, filter: ValueFilter) =>
    !filter || ((!filter.in || filter.in.includes(value)) && (!filter.notIn || !filter.notIn.includes(value)));
  const db = {
    orderContactAttempt: {
      groupBy: vi.fn(async ({ where }: { where: { orderId: { in: string[] } } }) =>
        groupMin(state.attempts.filter((a) => where.orderId.in.includes(a.orderId)))
      ),
    },
    orderStatusLog: {
      groupBy: vi.fn(async ({ where }: { where: { orderId: { in: string[] }; statusType: string; newValue?: ValueFilter } }) =>
        groupMin(
          state.logs.filter(
            (l) => where.orderId.in.includes(l.orderId) && l.statusType === where.statusType && matches(l.newValue, where.newValue)
          )
        )
      ),
    },
  };
  return { state, db };
});
vi.mock('./db', () => ({ db: fake.db }));

import { firstActionTimes } from './response-clock';

const T0 = new Date('2026-11-08T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const log = (orderId: string, newValue: string, when: Date, statusType = 'CONFIRMATION'): StatusLog => ({ orderId, statusType, newValue, createdAt: when });

beforeEach(() => {
  fake.state.attempts = [];
  fake.state.logs = [];
  vi.clearAllMocks();
});

describe('the first action on an order is something a person did after the pull — never the pull itself', () => {
  it('a pulled order nobody touched has NO first action (so the screen can say «بانتظار أول اتصال»)', async () => {
    fake.state.logs = [log('o1', 'IN_PROGRESS', T0)]; // «سحب من الطابور»
    const out = await firstActionTimes(['o1']);
    expect(out.has('o1')).toBe(false);
  });

  it('neither the order’s creation (`NEW`) nor the pull counts, however early', async () => {
    fake.state.logs = [log('o1', 'NEW', at(-60)), log('o1', 'IN_PROGRESS', T0)];
    expect((await firstActionTimes(['o1'])).has('o1')).toBe(false);
  });

  it('the first logged contact attempt is the first action, however long after the pull it came', async () => {
    fake.state.logs = [log('o1', 'IN_PROGRESS', T0)];
    fake.state.attempts = [{ orderId: 'o1', createdAt: at(10) }, { orderId: 'o1', createdAt: at(90) }];
    expect((await firstActionTimes(['o1'])).get('o1')).toEqual(at(10));
  });

  it('a decision with no attempt is the first action', async () => {
    fake.state.logs = [log('o1', 'IN_PROGRESS', T0), log('o1', 'CONFIRMED', at(5))];
    expect((await firstActionTimes(['o1'])).get('o1')).toEqual(at(5));
  });

  it('whichever of the two came first', async () => {
    fake.state.logs = [log('o1', 'IN_PROGRESS', T0), log('o1', 'NO_ANSWER', at(4)), log('o2', 'IN_PROGRESS', T0), log('o2', 'CONFIRMED', at(9))];
    fake.state.attempts = [{ orderId: 'o1', createdAt: at(7) }, { orderId: 'o2', createdAt: at(3) }];
    const out = await firstActionTimes(['o1', 'o2']);
    expect(out.get('o1')).toEqual(at(4));
    expect(out.get('o2')).toEqual(at(3));
  });

  it.each(['NO_ANSWER', 'FOLLOW_UP_REQUIRED', 'POSTPONED', 'CONFIRMED', 'REJECTED', 'CANCELLED'])(
    'a %s decision is an action',
    async (status) => {
      fake.state.logs = [log('o1', 'IN_PROGRESS', T0), log('o1', status, at(3))];
      expect((await firstActionTimes(['o1'])).get('o1')).toEqual(at(3));
    }
  );

  it('a status log of another kind (shipping) is not an action on the confirmation desk', async () => {
    fake.state.logs = [log('o1', 'SHIPPED', at(2), 'SHIPPING'), log('o1', 'IN_PROGRESS', T0)];
    expect((await firstActionTimes(['o1'])).has('o1')).toBe(false);
  });

  it('answers only for the orders asked about, and asks nothing for none', async () => {
    fake.state.logs = [log('o1', 'CONFIRMED', at(1)), log('o9', 'CONFIRMED', at(1))];
    const out = await firstActionTimes(['o1']);
    expect([...out.keys()]).toEqual(['o1']);
    vi.clearAllMocks();
    expect((await firstActionTimes([])).size).toBe(0);
    expect(fake.db.orderStatusLog.groupBy).not.toHaveBeenCalled();
    expect(fake.db.orderContactAttempt.groupBy).not.toHaveBeenCalled();
  });
});
