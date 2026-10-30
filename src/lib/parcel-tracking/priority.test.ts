import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from '../guard-source';
import {
  MATCHES,
  URGENCIES,
  URGENCY,
  byUrgency,
  canCollect,
  countMatching,
  trackingUrgency,
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

  it('hides the three fields measured to carry no information', () => {
    for (const key of ['barcode', 'attempts', 'collection']) {
      const col = columns.find((c) => c.key === key);
      expect(col, `العمود «${key}» اختفى من الشاشة`).toBeTruthy();
      expect(col!.hidden, `«${key}» يظهر على الهاتف بلا معلومة فيه`).toBe(true);
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
    // turned vertical, which is the thing `Rows` exists to avoid.
    expect(onCard.length, 'الكرت عاد إلى صفٍّ لكلِّ عمود').toBeLessThanOrEqual(7);
    expect(details.length, 'أسطرٌ أكثر من أن تُقرأ بيدٍ واحدة').toBeLessThanOrEqual(5);
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
    expect(stripComments(repoFile('src/lib/parcel-tracking/list.ts'))).toMatch(/\.sort\(byUrgency\)/);
    expect(src, 'عاد الفرزُ إلى المتصفّح — سيفرزُ خمساً وعشرين فقط').not.toMatch(/\.sort\(byUrgency\)/);
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
