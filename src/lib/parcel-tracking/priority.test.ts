import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '../guard-source';
import {
  MATCHES,
  URGENCIES,
  URGENCY,
  byUrgency,
  canCollect,
  countMatching,
  differenceSorter,
  trackingUrgency,
  urgencySorter,
  type ConditionKey,
  type TrackingFacts,
} from './priority';

const row = (over: Partial<TrackingFacts> = {}): TrackingFacts => ({
  shippingStatus: 'SHIPPED',
  settlementStatus: 'PENDING_COLLECTION',
  trackingNumber: 'AR-99001',
  daysInTransit: 1,
  late: false,
  alert: null,
  ...over,
});

describe('the rank itself', () => {
  it('is a total order with no two conditions sharing a place', () => {
    const ranks = URGENCIES.map((k) => URGENCY[k].rank);
    expect(new Set(ranks).size).toBe(URGENCIES.length);
    // Declared worst-first, so the declared order IS the rank order.
    expect([...ranks]).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('and NONE is last, so nothing quiet ever outranks something wrong', () => {
    expect(URGENCY.NONE.rank).toBe(Math.max(...URGENCIES.map((k) => URGENCY[k].rank)));
  });

  it('every condition says what to do about it, and NONE says nothing is needed', () => {
    for (const k of URGENCIES) {
      expect(URGENCY[k].why.length, k).toBeGreaterThan(20);
      if (k !== 'NONE') expect(URGENCY[k].label.length, k).toBeGreaterThan(0);
    }
    expect(URGENCY.NONE.label).toBe('');
  });

  it('and no label or reason is written in Eastern digits', () => {
    const text = URGENCIES.map((k) => `${URGENCY[k].label} ${URGENCY[k].why}`).join(' ');
    // By code point, not by a character class: a file that forbids Eastern
    // digits should not be the one place in the repo that contains them, and
    // this way the failure names the character it found.
    const eastern = [...text].filter((c) => c.charCodeAt(0) >= 0x660 && c.charCodeAt(0) <= 0x669);
    expect(eastern).toEqual([]);
  });
});

describe('trackingUrgency — one row, one reason', () => {
  it('a parcel in transit and in its window needs nothing', () => {
    expect(trackingUrgency(row())).toBe('NONE');
  });

  it('a live cancellation beats everything, including a failed delivery', () => {
    // Acting on this row at all is wrong, which is worse than acting late.
    expect(
      trackingUrgency(
        row({
          shippingStatus: 'FAILED_DELIVERY',
          late: true,
          trackingNumber: null,
          alert: { kind: 'CANCELLED', acknowledged: false },
        })
      )
    ).toBe('CANCELLED');
  });

  it('a live data change beats a failed delivery too', () => {
    expect(
      trackingUrgency(row({ shippingStatus: 'FAILED_DELIVERY', alert: { kind: 'CHANGED', acknowledged: false } }))
    ).toBe('CHANGED');
  });

  it('but an ACKNOWLEDGED alert sets no urgency at all', () => {
    // It fades, it does not disappear: the row is then ranked on what is
    // physically true of the parcel.
    expect(trackingUrgency(row({ alert: { kind: 'CANCELLED', acknowledged: true } }))).toBe('NONE');
    expect(
      trackingUrgency(row({ late: true, alert: { kind: 'CANCELLED', acknowledged: true } }))
    ).toBe('LATE');
  });

  it('ranks failed, returning, late, no-barcode in that order', () => {
    expect(trackingUrgency(row({ shippingStatus: 'FAILED_DELIVERY', late: true }))).toBe('FAILED');
    expect(trackingUrgency(row({ shippingStatus: 'RETURN_REQUESTED', late: true }))).toBe('RETURNING');
    expect(trackingUrgency(row({ late: true, trackingNumber: null }))).toBe('LATE');
    expect(trackingUrgency(row({ trackingNumber: null }))).toBe('NO_BARCODE');
  });

  it('money waiting to be collected is the last real condition, not a fault', () => {
    expect(trackingUrgency(row({ shippingStatus: 'DELIVERED' }))).toBe('COLLECT');
    expect(URGENCY.COLLECT.tone).toBe('good');
  });
});

describe('MATCHES — every condition on its own, for the chips', () => {
  it('counts a row under every condition it meets, not just the worst', () => {
    // A late parcel with no barcode belongs in both counts; hiding it from
    // one would make that chip lie about how much work it holds.
    const both = row({ late: true, trackingNumber: null });
    expect(MATCHES.LATE(both)).toBe(true);
    expect(MATCHES.NO_BARCODE(both)).toBe(true);
    expect(trackingUrgency(both)).toBe('LATE');
  });

  it('a parcel not yet picked up is not "shipped without a barcode"', () => {
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, shippingStatus: 'READY_FOR_PICKUP' }))).toBe(false);
    expect(MATCHES.NO_BARCODE(row({ trackingNumber: null, shippingStatus: 'SHIPPED' }))).toBe(true);
  });

  it('and countMatching is what a chip shows', () => {
    const rows = [row({ late: true }), row({ late: true, trackingNumber: null }), row()];
    expect(countMatching(rows, 'LATE')).toBe(2);
    expect(countMatching(rows, 'NO_BARCODE')).toBe(1);
  });
});

describe('canCollect — one definition for the button and the checkbox', () => {
  it('is delivered or partly delivered, and not settled yet', () => {
    expect(canCollect(row({ shippingStatus: 'DELIVERED' }))).toBe(true);
    expect(canCollect(row({ shippingStatus: 'PARTIALLY_DELIVERED' }))).toBe(true);
    expect(canCollect(row({ shippingStatus: 'DELIVERED', settlementStatus: 'SETTLED' }))).toBe(false);
    expect(canCollect(row({ shippingStatus: 'RETURNED' }))).toBe(false);
    expect(canCollect(row({ shippingStatus: 'SHIPPED' }))).toBe(false);
  });

  it('and it is literally the same function the rank uses', () => {
    expect(canCollect).toBe(MATCHES.COLLECT);
  });
});

describe('byUrgency — worst first, longest waiting within that', () => {
  it('lifts a cancelled parcel shipped today above a hundred merely-late ones', () => {
    const cancelled = row({ daysInTransit: 0, alert: { kind: 'CANCELLED', acknowledged: false } });
    const veryLate = row({ daysInTransit: 40, late: true });
    expect([veryLate, cancelled].sort(byUrgency)[0]).toBe(cancelled);
  });

  it('keeps the API’s oldest-first order as the tiebreak', () => {
    const old = row({ late: true, daysInTransit: 30 });
    const newer = row({ late: true, daysInTransit: 4 });
    expect([newer, old].sort(byUrgency)).toEqual([old, newer]);
  });

  it('a parcel that never shipped cannot be the one waiting longest', () => {
    const never = row({ late: true, daysInTransit: null });
    const shipped = row({ late: true, daysInTransit: 1 });
    expect([never, shipped].sort(byUrgency)).toEqual([shipped, never]);
  });

  it('and equal rows keep the order they arrived in', () => {
    const a = row({ daysInTransit: 3 });
    const b = row({ daysInTransit: 3 });
    expect([a, b].sort(byUrgency)).toEqual([a, b]);
    expect(byUrgency(a, b)).toBe(0);
  });

  it('sorts a realistic mixed list the way somebody would work it', () => {
    const list = [
      row({ shippingStatus: 'DELIVERED', daysInTransit: 9 }),
      row({ late: true, daysInTransit: 12 }),
      row({ daysInTransit: 2 }),
      row({ shippingStatus: 'FAILED_DELIVERY', daysInTransit: 3 }),
      row({ daysInTransit: 1, alert: { kind: 'CHANGED', acknowledged: false } }),
      row({ daysInTransit: 0, alert: { kind: 'CANCELLED', acknowledged: false } }),
    ];
    expect(list.slice().sort(byUrgency).map(trackingUrgency)).toEqual([
      'CANCELLED', 'CHANGED', 'FAILED', 'LATE', 'COLLECT', 'NONE',
    ]);
  });
});

/**
 * WHAT A PHONE ACTUALLY SHOWS.
 *
 * Measured over the 171 rows the tracking screen can load: the barcode is
 * null on 100% of the default in-flight view, delivery attempts are 0 on 97%
 * and never above 1, and the collection status is the same single value on
 * 91%. Three of the nine labelled lines on every card carried no information
 * at all, and the contact buttons — the screen's main action — were squeezed
 * into the right half of a label/value row.
 *
 * Prose cannot be tested. The flags that put that right can, and without
 * them the next edit quietly puts nine lines back.
 */
describe('the tracking card on a phone', () => {
  const src = stripComments(repoFile('src/components/screens/TrackingScreen.tsx'));

  /**
   * Column literals with their flags, by splitting the `columns` array on
   * each `key:` rather than by matching a shape.
   *
   * A regex expecting `key` then `label` then the flags read 9 of the 11:
   * `customer` is written on one line and `contact` carries a long comment
   * between its label and its flag. A guard that silently sees two thirds of
   * a list is worse than no guard — it reports numbers that are not the
   * screen's.
   */
  const block = src.slice(src.indexOf('columns={['), src.indexOf('actions={(o) => ('));
  const columns = block
    .split(/\bkey:\s*'/)
    .slice(1)
    .map((part) => ({
      key: part.slice(0, part.indexOf("'")),
      hidden: /hideOnPhone:\s*true/.test(part),
      primary: /primary:\s*true/.test(part),
    }));

  it('was read at all — the guard fails loudly rather than passing on nothing', () => {
    expect(block.length).toBeGreaterThan(500);
    expect(columns.length, 'عمودٌ مفقودٌ من القراءة، أو عمودٌ حُذف').toBeGreaterThanOrEqual(11);
    expect(columns.map((c) => c.key)).toContain('customer');
    expect(columns.map((c) => c.key)).toContain('contact');
  });

  it('hides the two fields measured to carry no information', () => {
    // «barcode» was the third until 10/11: the owner wants its small copy button on the card (off when there is none),
    // so it is drawn — see the next test.
    for (const key of ['attempts', 'collection']) {
      const col = columns.find((c) => c.key === key);
      expect(col, `العمود «${key}» اختفى من الشاشة`).toBeTruthy();
      expect(col!.hidden, `«${key}» يظهر على الهاتف بلا معلومة فيه`).toBe(true);
    }
  });

  it('draws the phone and the barcode as lines of the card — the two things the girl chasing a parcel works from (owner, 10/11)', () => {
    // Each carries its own small copy button; the barcode's is OFF when the parcel has none, so the line is always there.
    for (const key of ['phone', 'barcode']) {
      const col = columns.find((c) => c.key === key);
      expect(col, `العمود «${key}» اختفى من الشاشة`).toBeTruthy();
      expect(col!.hidden, `«${key}» اختفى من الكرت — طلب المالك أن يظهر`).toBe(false);
      expect(col!.primary, `«${key}» صار عنواناً`).toBe(false);
    }
  });

  it('and hides the contact column, because the card draws it full width instead', () => {
    expect(columns.find((c) => c.key === 'contact')!.hidden).toBe(true);
    // Which only holds if it is actually drawn there.
    expect(src).toMatch(/w-full md:hidden[\s\S]{0,120}<ContactButtons/);
  });

  it('keeps the card to a heading and a handful of lines', () => {
    const onCard = columns.filter((c) => !c.hidden);
    const details = onCard.filter((c) => !c.primary);
    // It was 2 titles and 9 labelled lines. Nine is the sideways scroll
    // turned vertical, which is the thing `Rows` exists to avoid. The ceiling rose by exactly TWO on 10/11, the two the
    // owner asked for by name: the phone and the barcode (each with its small copy button). Nothing else was added.
    expect(onCard.length, 'الكرت عاد إلى صفٍّ لكلِّ عمود').toBeLessThanOrEqual(9);
    expect(details.length, 'أسطرٌ أكثر من أن تُقرأ بيدٍ واحدة').toBeLessThanOrEqual(7);
    expect(onCard.filter((c) => c.primary).length, 'عنوانُ الكرت أكثر من حقلين').toBeLessThanOrEqual(2);
  });

  it('gives the alert the red channel, not lateness', () => {
    /*
     * 89% of rows are late, so tinting late rows red tinted nine rows in
     * ten. The tint has to mean the thing that is rare and wrong.
     *
     * THIS USED TO PIN THE LAMBDA ITSELF —
     * `/alert=\{\(o\) => !!o\.alert && !o\.alert\.acknowledged\}/`.
     * It fired the day the prop started sending a COLOUR instead of a
     * boolean, although the rewrite tints exactly the same rows; and it
     * would have passed on a lambda that read `o.alert` and then returned
     * a tone chosen by lateness anyway.
     *
     * So the EXPRESSION is read and the rule asserted over it: lateness
     * must not reach the tint, and the alert must. Which rows end up which
     * colour is proved by rendering the screen, in
     * `components/screens/the-cancelled-row-and-the-changed-row.test.tsx`.
     */
    const prop = /alert=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/.exec(src);
    expect(prop, 'الصفُّ لا يَأخذُ تلويناً أصلاً').toBeTruthy();
    expect(prop![1], 'التلوينُ لا يَقرأُ التنبيه').toMatch(/alert/);
    expect(prop![1], 'التلوينُ عادَ يَقرأُ التأخير — تسعةُ صفوفٍ من عشرة').not.toMatch(/late/i);
  });

  it('puts the alert and its button at the top of the card, full width', () => {
    expect(src, 'لا تنبيه في رأس الكرت').toMatch(/notice=\{/);
    expect(src).toContain('أدركتُ الإجراء');
  });

  it('sorts the list worst-first instead of leaving it in arrival order', () => {
    // 21/10 — THE SORT MOVED TO WHERE THE LIST IS READ. A page is cut from a list that is sorted FIRST, and the screen no
    // longer holds the whole list (it asks for a page of 25), so a sort in the browser would only sort those 25. The
    // claim is the same — worst first, never arrival order — and `parcel-tracking/list.test.ts` proves it over a database that
    // holds the parcels; this pins WHERE it is written, and that the screen does not do it a second time.
    // (Worked out once for the whole sort — `urgencySorter` — and the sort is `byUrgency`'s order, held by «the sorter is byUrgency» below.)
    expect(stripComments(repoFile('src/lib/parcel-tracking/list.ts'))).toMatch(/urgencySorter\(l2\)[\s\S]*\.sort\(byRank\)/);
    expect(src, 'عاد الفرزُ إلى المتصفّح — سيفرزُ خمساً وعشرين فقط').not.toMatch(/\.sort\(byUrgency\)/);
    expect(src, 'عاد الفرزُ إلى المتصفّح — سيفرزُ خمساً وعشرين فقط').not.toMatch(/urgencySorter/);
  });

  it('and every action on the card is a target a thumb can hit', () => {
    // The card's action row is where «استلم» and «رفض» sit side by side. At
    // text-link height, next to each other, a mis-tap marks a parcel
    // returned. Every one of them states a phone height.
    const actions = src.slice(src.indexOf('actions={(o) => ('));
    // Braces two deep, not "up to the first `>`": `onClick={() => f(x)}`
    // contains a `>`, so a lazy match ends the tag in the middle of the
    // handler and then reads the next element's classes. This is the same
    // shape `touch-targets.test.ts` had to settle on, for the same reason.
    const buttons = [...actions.matchAll(/<button\b(?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*\/?>/g)];
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    const short = buttons.filter((m) => !/min-h-11/.test(m[0]));
    expect(short.map((m) => m[0].slice(0, 60)), 'زرٌّ في الكرت دون 44 بكسل').toEqual([]);
  });
});

/**
 * THE SORTER IS byUrgency — WORKED OUT ONCE PER ROW INSTEAD OF SEVEN PREDICATES AT EVERY COMPARISON.
 *
 * The list sorts up to 20,000 parcels and byUrgency found each row's reason from scratch on every comparison (up to four
 * times, seven predicates each). urgencySorter reads every row's rank once and compares with the same comparison. The
 * old pair is frozen here as it was written, and the order of the sorter, of the live byUrgency and differenceSorter and of the
 * frozen pair must be the same on random rows — ties and the money chip included — because a stable sort keeps the
 * database's order among equals, and an order that differs by a single row would reach the screen.
 */
describe('the sorter is byUrgency', () => {
  const oldByDelivered = (a: TrackingFacts, b: TrackingFacts) => {
    const time = (v: Date | string | null | undefined) => (v ? new Date(v).getTime() : null);
    const ta = time(a.deliveredAt);
    const tb = time(b.deliveredAt);
    if (ta === tb) return 0;
    if (ta === null) return 1;
    if (tb === null) return -1;
    return ta - tb;
  };
  const oldByUrgency = (a: TrackingFacts, b: TrackingFacts): number => {
    const byRank = URGENCY[trackingUrgency(a)].rank - URGENCY[trackingUrgency(b)].rank;
    if (byRank !== 0) return byRank;
    if (URGENCY[trackingUrgency(a)].rank === URGENCY.COLLECT.rank) return oldByDelivered(a, b);
    const da = a.daysInTransit;
    const db = b.daysInTransit;
    if (da === db) return 0;
    if (da === null) return 1;
    if (db === null) return -1;
    return db - da;
  };
  const oldByDifference = (a: TrackingFacts, b: TrackingFacts) => {
    const waiting = (r: TrackingFacts) => (r.difference && !r.difference.answered ? 0 : 1);
    return waiting(a) - waiting(b) || oldByUrgency(a, b);
  };

  function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Rows that meet every condition, some, and none — with many ties on days, and rows of the money chip with and without dates. */
  function rows(seed: number, size: number): (TrackingFacts & { id: number })[] {
    const r = rng(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
    const statuses = ['SHIPPED', 'SHIPPED', 'OUT_FOR_DELIVERY', 'FAILED_DELIVERY', 'READY_FOR_PICKUP', 'RETURN_REQUESTED', 'DELIVERED', 'DELIVERED', 'PARTIALLY_DELIVERED', 'RETURNED'];
    return Array.from({ length: size }, (_, id) => {
      const status = pick(statuses);
      const ended = r() < 0.7 ? new Date(Date.UTC(2026, 9, 1 + Math.floor(r() * 10))) : null;
      return {
        id,
        shippingStatus: status,
        settlementStatus: pick(['PENDING_COLLECTION', 'SETTLED', 'NOT_APPLICABLE', null]),
        trackingNumber: r() < 0.7 ? 'T-1' : null,
        daysInTransit: r() < 0.15 ? null : Math.floor(r() * 12),
        late: r() < 0.3,
        alert: r() < 0.4 ? { kind: pick(['CANCELLED', 'CHANGED'] as const), acknowledged: r() < 0.4 } : null,
        deliveredAt: status === 'DELIVERED' || status === 'PARTIALLY_DELIVERED' ? ended : null,
        returnedAt: status === 'RETURNED' ? ended : null,
        barcodeExpected: pick([true, false, undefined]),
        difference: r() < 0.3 ? { answered: r() < 0.5 } : null,
      };
    });
  }
  const ids = (list: { id: number }[]) => list.map((x) => x.id);

  for (const seed of [1, 2, 3, 77, 2026]) {
    it('seed ' + seed + ': the sorter, the live byUrgency and the frozen one put every row in the same place', () => {
      const all = rows(seed, 600);
      const frozen = ids([...all].sort(oldByUrgency));
      expect(ids([...all].sort(byUrgency))).toEqual(frozen);
      expect(ids([...all].sort(urgencySorter(all)))).toEqual(frozen);
    });

    it('seed ' + seed + ': inside «فيه فرق» too — the unanswered first, then each group worst first', () => {
      const all = rows(seed, 600);
      const firstPass = [...all].sort(oldByUrgency);
      const frozen = ids([...firstPass].sort(oldByDifference));
      expect(ids([...firstPass].sort(differenceSorter(byUrgency)))).toEqual(frozen);
      const sorter = urgencySorter(firstPass);
      expect(ids([...firstPass].sort(differenceSorter(sorter)))).toEqual(frozen);
    });
  }

  it('and a chip’s rows (a part of the list) are sorted the same way when the sorter is built from that part', () => {
    const all = rows(9, 500);
    const part = all.filter(MATCHES.LATE);
    expect(part.length).toBeGreaterThan(5);
    expect(ids([...part].sort(urgencySorter(part)))).toEqual(ids([...part].sort(oldByUrgency)));
  });

  it('a row the sorter was not built from is still placed correctly — it is worked out on the spot', () => {
    const all = rows(4, 200);
    const outsider = row({ shippingStatus: 'FAILED_DELIVERY', daysInTransit: 4 });
    const sorter = urgencySorter<TrackingFacts>(all);
    for (const other of all.slice(0, 60)) expect(Math.sign(sorter(outsider, other))).toBe(Math.sign(oldByUrgency(outsider, other)));
  });

  it('each row’s reason is worked out ONCE: the sort makes no more predicate calls than rows × conditions, where byUrgency makes many times more', () => {
    const all = rows(5, 400);
    const keys = Object.keys(MATCHES) as ConditionKey[];
    const originals = Object.fromEntries(keys.map((k) => [k, MATCHES[k]])) as typeof MATCHES;
    let calls = 0;
    for (const k of keys) MATCHES[k] = (r) => (calls++, originals[k](r));
    try {
      const sorter = urgencySorter(all);
      const built = calls;
      [...all].sort(sorter);
      expect(calls, 'the comparisons asked for predicates again').toBe(built);
      expect(built).toBeLessThanOrEqual(all.length * keys.length);
      calls = 0;
      [...all].sort(byUrgency);
      expect(calls).toBeGreaterThan(all.length * keys.length * 4);
    } finally {
      for (const k of keys) MATCHES[k] = originals[k];
    }
  });
});
