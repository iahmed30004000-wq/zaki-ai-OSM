import { describe, expect, it, vi } from 'vitest';
import { DIFFERENCE_RESULT, currentDifference, readDifferences, type DifferenceRow } from './difference';
import { CHIPS, TASKS, isChip, trackingFilters } from './filters';
import { DIFFERENCE_CHIP, DIFFERENCE_FACTS, NOT_LATE, URGENCIES, byUrgency, differenceSorter, hasDifference, matchesChip, trackingUrgency, type TrackingFacts } from './priority';
import { MONEY_FIELDS, unseenKey, withoutMoney, FULL_SIGHT, NO_SIGHT } from './sight';

/**
 * «فيه فرق» — WHICH ROW IS A PARCEL'S DIFFERENCE, READ FROM THE MATCH ROWS IT HAS.
 *
 *   «واذا المطابقة رجعت في فرق حط جنبو علامة انو في فرق عشان بنت المتابعة تشيك»
 *
 * The rule (`parcel-tracking/difference.ts`) is held in two halves. The PURE half is every shape of a parcel's match rows the
 * brief names — two statements (the newest open and the newest closed), an answered difference, a clean match after a
 * mismatch, a parcel no line names — plus the ones the code found on the way (a sweep row newer than the question, a tie in
 * time, rows handed in any order). The READ half asks a database that EVALUATES what it is asked, so a scope that is only
 * in the question's words and not in its effect is caught: another company's rows and another store's statements are in
 * the table, and the read must not see them.
 */

const T = (day: number, hour = 12) => new Date(Date.UTC(2026, 10, day, hour));
let n = 0;
const row = (over: Partial<DifferenceRow> = {}): DifferenceRow => ({
  id: `m${String(++n).padStart(3, '0')}`,
  orderId: 'o1',
  result: DIFFERENCE_RESULT,
  resolution: null,
  createdAt: T(1),
  closed: false,
  ...over,
});
const ids = (r: DifferenceRow | null) => r?.id ?? null;

describe('the rule — which row, if any, is the parcel’s difference', () => {
  it('a parcel with no match row at all has none', () => {
    expect(currentDifference([])).toBeNull();
  });

  it('a single disagreement nobody has answered is the difference — open, unanswered', () => {
    const a = row();
    expect(currentDifference([a])).toBe(a);
  });

  it('a single answered disagreement is still the difference: the order stays marked («بس بضل الطلب معلّم»)', () => {
    for (const resolution of ['ACCEPTED_COURIER', 'OURS_STANDS', 'UNDER_REVIEW']) {
      const a = row({ resolution });
      expect(currentDifference([a]), resolution).toBe(a);
    }
  });

  it('a clean match is not a difference', () => {
    expect(currentDifference([row({ result: 'MATCHED' })])).toBeNull();
  });

  it('a clean match AFTER a disagreement ends it — the company’s later, right line settled what the earlier one disagreed about', () => {
    expect(currentDifference([row({ createdAt: T(1) }), row({ result: 'MATCHED', createdAt: T(2) })])).toBeNull();
    // answered or not, and closed or not: a later clean line ends all of them
    expect(currentDifference([row({ createdAt: T(1), resolution: 'OURS_STANDS', closed: true }), row({ result: 'MATCHED', createdAt: T(3) })])).toBeNull();
  });

  it('a clean match BEFORE a disagreement does not: the later line is the question', () => {
    const later = row({ createdAt: T(5) });
    expect(currentDifference([row({ result: 'MATCHED', createdAt: T(2) }), later])).toBe(later);
  });

  it('at the very same moment a disagreement is never hidden behind a clean line (a file that names a parcel twice writes both together)', () => {
    const bad = row({ createdAt: T(2) });
    const good = row({ result: 'MATCHED', createdAt: T(2) });
    expect(currentDifference([good, bad])).toBe(bad);
    expect(currentDifference([bad, good])).toBe(bad);
  });

  it('a disagreement newer than a clean line, with an older disagreement beyond it: the older one is superseded, never the answer', () => {
    const newest = row({ createdAt: T(9) });
    const old = row({ createdAt: T(1) });
    expect(ids(currentDifference([old, row({ result: 'MATCHED', createdAt: T(5) }), newest]))).toBe(newest.id);
    // and the old one is not picked even when it is the only question still open
    const answeredNewest = row({ createdAt: T(9), resolution: 'ACCEPTED_COURIER' });
    expect(ids(currentDifference([old, row({ result: 'MATCHED', createdAt: T(5) }), answeredNewest]))).toBe(answeredNewest.id);
  });

  describe('rows that are not a figure that agrees or disagrees with ours never count — and never supersede', () => {
    it.each(['MISSING_IN_STATEMENT', 'MISSING_IN_SYSTEM', 'EXCLUDED', 'SOMETHING_NEW'])('%s', (result) => {
      expect(currentDifference([row({ result })])).toBeNull();
      // a NEWER such row (a later statement that does not list a still-unsettled parcel) does not hide the difference waiting for an answer
      const waiting = row({ createdAt: T(1) });
      expect(currentDifference([waiting, row({ result, createdAt: T(8) })])).toBe(waiting);
    });
  });

  describe('two statements', () => {
    it('the newest is open and unanswered, the older one closed and answered → the newest: that is where the answer is still to be written', () => {
      const open = row({ createdAt: T(9) });
      const closed = row({ createdAt: T(2), closed: true, resolution: 'ACCEPTED_COURIER' });
      expect(currentDifference([closed, open])).toBe(open);
    });

    it('the newest is closed (answered) and an OLDER one is open and unanswered → the older one: it holds that statement’s close and can still take an answer', () => {
      const closed = row({ createdAt: T(9), closed: true, resolution: 'ACCEPTED_COURIER' });
      const open = row({ createdAt: T(2) });
      expect(currentDifference([closed, open])).toBe(open);
    });

    it('the newest is closed and the older one open but ANSWERED → the newest, read-only: nothing is waiting for an answer', () => {
      const closed = row({ createdAt: T(9), closed: true, resolution: 'ACCEPTED_COURIER' });
      const answered = row({ createdAt: T(2), resolution: 'UNDER_REVIEW' });
      expect(currentDifference([answered, closed])).toBe(closed);
    });

    it('both open and unanswered → the newest', () => {
      const newest = row({ createdAt: T(9) });
      const older = row({ createdAt: T(2) });
      expect(currentDifference([older, newest])).toBe(newest);
    });

    it('the newest is answered on an open statement and an older one is unanswered on another open statement → the unanswered one: still a question', () => {
      const answered = row({ createdAt: T(9), resolution: 'OURS_STANDS' });
      const waiting = row({ createdAt: T(2) });
      expect(currentDifference([answered, waiting])).toBe(waiting);
    });

    it('a closed statement that was closed with the line unanswered (an old statement) is not a question: the older open one is', () => {
      const legacy = row({ createdAt: T(9), closed: true });
      const open = row({ createdAt: T(2) });
      expect(currentDifference([legacy, open])).toBe(open);
      // …and with no open one it is the difference, read-only
      expect(currentDifference([legacy])).toBe(legacy);
    });

    it('two unanswered open lines of the same statement (the company wrote the parcel twice) → the newest', () => {
      const a = row({ createdAt: T(3) });
      const b = row({ createdAt: T(4) });
      expect(currentDifference([a, b])).toBe(b);
    });
  });

  it('is the same whatever order the rows are handed in — every permutation of a four-row parcel gives one answer', () => {
    const rows = [
      row({ createdAt: T(8), closed: true, resolution: 'ACCEPTED_COURIER' }),
      row({ createdAt: T(6), result: 'MATCHED' }),
      row({ createdAt: T(4) }),
      row({ createdAt: T(2), result: 'MISSING_IN_STATEMENT' }),
    ];
    const permutations = (xs: DifferenceRow[]): DifferenceRow[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
    const answers = new Set(permutations(rows).map((p) => ids(currentDifference(p))));
    expect(answers.size).toBe(1);
    // the closed answered line is the newest and nothing older is waiting for an answer (the clean line ends the one beyond it)
    expect([...answers][0]).toBe(rows[0].id);
  });

  it('does not reorder the caller’s array', () => {
    const rows = [row({ createdAt: T(1) }), row({ createdAt: T(5) }), row({ createdAt: T(3) })];
    const before = rows.map((r) => r.id);
    currentDifference(rows);
    expect(rows.map((r) => r.id)).toEqual(before);
  });
});

/* ───────────────────────────── the read, against a table that answers ───────────────────────────── */

interface MatchRow {
  id: string;
  companyId: string;
  orderId: string | null;
  result: string;
  resolution: string | null;
  createdAt: Date;
  statement: { storeId: string; matchingClosedAt: Date | null };
  /** A column the read never selects — if it comes back, the read selected more than it said. */
  secret: string;
}

type Any = Record<string, any>;

/** The table: it EVALUATES the `where` it is handed and returns only what `select` names. */
function tableOf(rows: MatchRow[], opts: { fails?: unknown } = {}) {
  const calls: Any[] = [];
  const findMany = vi.fn(async (args: Any) => {
    calls.push(args);
    if (opts.fails) throw opts.fails;
    const w = args.where as Any;
    const hit = rows.filter(
      (r) =>
        r.companyId === w.companyId &&
        (!w.orderId?.in || (r.orderId !== null && w.orderId.in.includes(r.orderId))) &&
        (w.result === undefined || r.result === w.result) &&
        (w.statement?.storeId === undefined || r.statement.storeId === w.statement.storeId)
    );
    return hit.map((r) => {
      const out: Any = {};
      for (const [k, v] of Object.entries(args.select as Any)) {
        out[k] = k === 'statement' ? { matchingClosedAt: r.statement.matchingClosedAt } : (r as Any)[k];
        void v;
      }
      return out;
    });
  });
  return { db: { settlementMatch: { findMany } } as unknown as Parameters<typeof readDifferences>[0], calls, findMany };
}

const COMPANY = 'c1';
const STORE = 's1';
let m = 0;
const match = (over: Partial<Omit<MatchRow, 'statement'>> & { statement?: Partial<MatchRow['statement']> } = {}): MatchRow => {
  const { statement, ...rest } = over;
  return {
    id: `r${String(++m).padStart(4, '0')}`,
    companyId: COMPANY,
    orderId: 'o1',
    result: 'MISMATCHED',
    resolution: null,
    createdAt: T(1),
    secret: 'must-not-come-back',
    ...rest,
    statement: { storeId: STORE, matchingClosedAt: null, ...(statement ?? {}) },
  };
};
const ask = (rows: MatchRow[], orderIds: string[], opts: { fails?: unknown } = {}) => {
  const t = tableOf(rows, opts);
  return readDifferences(t.db, { companyId: COMPANY, storeId: STORE, orderIds }).then((map) => ({ map, ...t }));
};

describe('the read — two questions however many parcels, scoped, and nothing more than it says', () => {
  it('a parcel that no line disagreed about costs ONE read and is not in the answer', async () => {
    const { map, calls } = await ask([match({ result: 'MATCHED' })], ['o1', 'o2']);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('with a disagreement it costs TWO — the second asks for the clean lines of the parcels that have one, and of nobody else', async () => {
    const rows = [match({ orderId: 'o1' }), match({ orderId: 'o3', result: 'MATCHED' }), match({ orderId: 'o3' })];
    const { map, calls } = await ask(rows, ['o1', 'o2', 'o3', 'o4']);
    expect(calls).toHaveLength(2);
    expect(calls[0].where.result).toBe(DIFFERENCE_RESULT);
    expect(calls[0].where.orderId.in).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(calls[1].where.result).toBe('MATCHED');
    expect(calls[1].where.orderId.in.sort()).toEqual(['o1', 'o3']);
    expect([...map.keys()].sort()).toEqual(['o1', 'o3']);
  });

  it('asks for no parcel at all → no read', async () => {
    const { map, calls } = await ask([match()], []);
    expect(map.size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('is two reads for five thousand parcels as for five — never one per row', async () => {
    const orderIds = Array.from({ length: 5000 }, (_, i) => `o${i}`);
    const rows = orderIds.filter((_, i) => i % 7 === 0).map((orderId) => match({ orderId }));
    const { map, calls } = await ask(rows, orderIds);
    expect(calls).toHaveLength(2);
    expect(map.size).toBe(rows.length);
  });

  it('both reads name the company and the statement’s own store — in the question, and in its effect on a table that holds the others', async () => {
    const rows = [
      match({ orderId: 'o1' }),
      match({ orderId: 'o2', companyId: 'someone-else' }),
      match({ orderId: 'o3', statement: { storeId: 'another-store' } }),
    ];
    const { map, calls } = await ask(rows, ['o1', 'o2', 'o3']);
    expect([...map.keys()]).toEqual(['o1']);
    for (const c of calls) {
      expect(c.where.companyId).toBe(COMPANY);
      expect(c.where.statement).toEqual({ storeId: STORE });
    }
  });

  it('a clean line of ANOTHER company or store never ends a difference', async () => {
    const rows = [
      match({ orderId: 'o1', createdAt: T(1) }),
      match({ orderId: 'o1', result: 'MATCHED', createdAt: T(5), companyId: 'someone-else' }),
      match({ orderId: 'o1', result: 'MATCHED', createdAt: T(6), statement: { storeId: 'another-store' } }),
    ];
    const { map } = await ask(rows, ['o1']);
    expect([...map.keys()]).toEqual(['o1']);
  });

  it('selects only what it needs: no column it did not name comes back, so a widening of the select is a change somebody made', async () => {
    const { calls, findMany } = await ask([match()], ['o1']);
    expect(Object.keys(calls[0].select).sort()).toEqual(['createdAt', 'id', 'orderId', 'resolution', 'result', 'statement']);
    expect(calls[0].select.statement).toEqual({ select: { matchingClosedAt: true } });
    const returned = (await findMany.mock.results[0].value) as Any[];
    expect(JSON.stringify(returned)).not.toContain('must-not-come-back');
  });

  it('says for each parcel WHICH row, whether it is answered, and whether its statement is closed', async () => {
    const rows = [
      match({ orderId: 'a', resolution: null }),
      match({ orderId: 'b', resolution: 'OURS_STANDS' }),
      match({ orderId: 'c', resolution: 'ACCEPTED_COURIER', statement: { matchingClosedAt: T(7) } }),
      match({ orderId: 'd', statement: { matchingClosedAt: T(7) } }),
    ];
    const { map } = await ask(rows, ['a', 'b', 'c', 'd']);
    expect(map.get('a')).toEqual({ matchId: rows[0].id, answered: false, closed: false });
    expect(map.get('b')).toEqual({ matchId: rows[1].id, answered: true, closed: false });
    expect(map.get('c')).toEqual({ matchId: rows[2].id, answered: true, closed: true });
    expect(map.get('d')).toEqual({ matchId: rows[3].id, answered: false, closed: true });
  });

  it('a row with no order (a line nobody carries) is not any parcel’s difference', async () => {
    const { map } = await ask([match({ orderId: null })], ['o1']);
    expect(map.size).toBe(0);
  });

  it('a failed read is NOT swallowed: a mark that vanishes quietly reads as «no difference»', async () => {
    await expect(ask([match()], ['o1'], { fails: new Error('connection lost') })).rejects.toThrow('connection lost');
  });

  it('applies the rule per parcel: the same two statements give each parcel its own answer', async () => {
    const rows = [
      // o1: a later clean line ends the disagreement
      match({ orderId: 'o1', createdAt: T(1) }),
      match({ orderId: 'o1', result: 'MATCHED', createdAt: T(4) }),
      // o2: the newest statement is closed and answered; an older one still waits → the older
      match({ orderId: 'o2', createdAt: T(8), resolution: 'ACCEPTED_COURIER', statement: { matchingClosedAt: T(9) } }),
      match({ orderId: 'o2', createdAt: T(2) }),
    ];
    const { map } = await ask(rows, ['o1', 'o2']);
    expect(map.has('o1')).toBe(false);
    expect(map.get('o2')).toEqual({ matchId: rows[3].id, answered: false, closed: false });
  });
});

/* ───────────────────────────── the chip, the order inside it, and the sight ───────────────────────────── */

const facts = (over: Partial<TrackingFacts> = {}): TrackingFacts => ({
  shippingStatus: 'DELIVERED',
  settlementStatus: 'PENDING_COLLECTION',
  daysInTransit: 3,
  late: false,
  ...over,
});

describe('the chip «فيه فرق»', () => {
  it('is a chip and never a reason: the seven conditions, the ranking and the order of the list do not know it', () => {
    expect(URGENCIES as readonly string[]).not.toContain(DIFFERENCE_CHIP);
    expect(TASKS as readonly string[]).not.toContain(DIFFERENCE_CHIP);
    // a parcel that carries a difference and nothing else is not «in front of you» by it
    expect(trackingUrgency(facts({ difference: { answered: false }, settlementStatus: 'SETTLED' }))).toBe('NONE');
    expect(CHIPS).toContain(DIFFERENCE_CHIP);
    expect(CHIPS).toContain(NOT_LATE);
  });

  it('`?task=DIFFERENCE` is a known word; a near miss is still a 400 in Arabic, never a quiet «everything»', () => {
    expect(isChip('DIFFERENCE')).toBe(true);
    expect(trackingFilters(new URLSearchParams('task=DIFFERENCE'))).toMatchObject({ ok: true, applied: { task: 'DIFFERENCE' } });
    for (const bad of ['DIFFERENC', 'difference', 'DIFFERENCES', 'DIFF']) {
      expect(trackingFilters(new URLSearchParams(`task=${bad}`)), bad).toMatchObject({ ok: false, errorAr: `المهمة غير معروف: ${bad}` });
    }
  });

  it('matches exactly the parcels that carry a difference — answered or not, delivered or on the road', () => {
    expect(hasDifference(facts({ difference: { answered: false } }))).toBe(true);
    expect(hasDifference(facts({ difference: { answered: true } }))).toBe(true);
    expect(hasDifference(facts({ difference: null }))).toBe(false);
    expect(hasDifference(facts())).toBe(false);
    expect(matchesChip(DIFFERENCE_CHIP)(facts({ shippingStatus: 'SHIPPED', difference: { answered: false } }))).toBe(true);
    expect(matchesChip(DIFFERENCE_CHIP)(facts())).toBe(false);
  });

  it('is worded in Arabic, with a reason that says what to do, in the red tone', () => {
    expect(DIFFERENCE_FACTS.label).toBe('فيه فرق');
    expect(DIFFERENCE_FACTS.why).toMatch(/ابتّ فيه/);
    expect(DIFFERENCE_FACTS.tone).toBe('bad');
    expect(`${DIFFERENCE_FACTS.label}${DIFFERENCE_FACTS.why}`).not.toMatch(/[A-Za-z]/);
  });

  it('inside it the unanswered come first, then the answered — each group in the list’s own order (the longest on the road first)', () => {
    const onTheRoad = (over: Partial<TrackingFacts>) => facts({ shippingStatus: 'SHIPPED', settlementStatus: 'NOT_APPLICABLE', late: true, ...over });
    const open1 = onTheRoad({ difference: { answered: false }, daysInTransit: 9 });
    const open2 = onTheRoad({ difference: { answered: false }, daysInTransit: 2 });
    const done1 = onTheRoad({ difference: { answered: true }, daysInTransit: 30 });
    const done2 = onTheRoad({ difference: { answered: true }, daysInTransit: 4 });
    // «done1» has waited longest of all, and still comes after both unanswered ones
    expect([done2, open2, done1, open1].sort(differenceSorter(byUrgency))).toEqual([open1, open2, done1, done2]);
    // the second key is the list’s own: with no answers anywhere it is exactly `byUrgency`
    const all = [open2, onTheRoad({ difference: { answered: false }, daysInTransit: 5 }), open1];
    expect([...all].sort(differenceSorter(byUrgency))).toEqual([...all].sort(byUrgency));
    expect(all.some((r) => byUrgency(r, open1) !== 0)).toBe(true);
  });
});

describe('the sight: «فيه فرق» is the courier’s money', () => {
  it('a person without the money sight is refused the chip in the door’s own key — as for the delivered rows', () => {
    expect(unseenKey({ status: 'default', task: DIFFERENCE_CHIP }, NO_SIGHT)).toBe('settlement.view');
    expect(unseenKey({ status: 'default', task: DIFFERENCE_CHIP }, { ...NO_SIGHT, returns: true, collect: true })).toBe('settlement.view');
    expect(unseenKey({ status: 'default', task: DIFFERENCE_CHIP }, FULL_SIGHT)).toBeNull();
    expect(unseenKey({ status: 'default', task: DIFFERENCE_CHIP }, { ...NO_SIGHT, money: true })).toBeNull();
  });

  it('the field leaves with the permission: it is one of the courier’s figures a row loses', () => {
    expect(MONEY_FIELDS as readonly string[]).toContain('difference');
    const out = withoutMoney({ id: 'x', difference: { matchId: 'm' }, courierSaid: null });
    expect(out).not.toHaveProperty('difference');
    expect(out).toHaveProperty('courierSaid');
  });
});
