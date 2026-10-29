import { describe, expect, it } from 'vitest';
import { REJECTION_REASONS } from './confirmation-workflow';
import { DELIVERY_FAILURE_REASONS, RETURN_REASONS } from './shipping-workflow';
import { repoFile, stripComments } from './guard-source';
import {
  FAULT_AR,
  FAULTS,
  faultOf,
  isKnownCode,
  OUR_FAULTS,
  UNCLASSIFIED,
  UNCLASSIFIED_AR,
  reasonLabel,
  stageOf,
  summariseLoss,
  type LossRow,
} from './loss-analysis';

/**
 * THE DASHBOARD COUNTED REJECTIONS AND NEVER ASKED WHY.
 *
 * `rejected: 41`, and beside it which product was rejected most. The three
 * fields that hold the answer — `rejectionReason`, `deliveryFailureReason`,
 * `returnReason` — were written on every order and read by no report at all.
 *
 * What this file guards is the two things such a report gets wrong: putting a
 * money figure on a loss that cost no money, and quietly folding values it
 * does not recognise into «أخرى».
 */

const route = () => stripComments(repoFile('src/app/api/analytics/loss/route.ts'));
const panel = () => stripComments(repoFile('src/components/dashboard/LossPanel.tsx'));

describe('every stored reason has a fault and a word', () => {
  /**
   * A code with no entry falls to UNKNOWN, which reads as «غير محدَّد» — so a
   * reason somebody added to a vocabulary would silently become unclassified
   * on the report instead of failing here.
   */
  it('for all three vocabularies, with nothing left to fall through', () => {
    for (const r of REJECTION_REASONS) {
      const fault = faultOf('rejectionReason', r);
      if (r === 'OTHER') expect(fault).toBe('UNKNOWN');
      else expect(fault, `${r} سقط إلى «غير محدَّد»`).not.toBe('UNKNOWN');
      expect(FAULTS, `${r} صُنِّف بما ليس في القائمة`).toContain(fault);
    }
    for (const r of DELIVERY_FAILURE_REASONS) {
      if (r !== 'OTHER') expect(faultOf('deliveryFailureReason', r), `${r} سقط إلى «غير محدَّد»`).not.toBe('UNKNOWN');
    }
    for (const r of RETURN_REASONS) {
      if (r !== 'OTHER') expect(faultOf('returnReason', r), `${r} سقط إلى «غير محدَّد»`).not.toBe('UNKNOWN');
    }
  });

  it('and every fault is readable in Arabic', () => {
    for (const f of FAULTS) expect(FAULT_AR[f], `${f} بلا ترجمة`).toBeTruthy();
  });

  /**
   * AND EVERY CODE READS AS A SENTENCE, not as an English constant.
   *
   * The reason `REJECTION_REASON_AR` exists at all, and the divergence the
   * delivery-attempt vocabulary already cost this codebase once.
   */
  it('and every code has words, in every vocabulary', () => {
    for (const r of REJECTION_REASONS) expect(reasonLabel('rejectionReason', r), r).not.toBe(r);
    for (const r of DELIVERY_FAILURE_REASONS) expect(reasonLabel('deliveryFailureReason', r), r).not.toBe(r);
    for (const r of RETURN_REASONS) expect(reasonLabel('returnReason', r), r).not.toBe(r);
  });

  it('the two halves are the two fields they should be', () => {
    expect(stageOf('rejectionReason')).toBe('BEFORE_CONFIRMATION');
    expect(stageOf('deliveryFailureReason')).toBe('AFTER_SHIPPING');
    expect(stageOf('returnReason')).toBe('AFTER_SHIPPING');
  });

  /** Only what we can fix enters the «كان يمكن تفاديه» sum. */
  it('and only our own failures are counted as preventable', () => {
    expect(OUR_FAULTS).toEqual(['OUR_DATA', 'OUR_REACH']);
    expect(OUR_FAULTS).not.toContain('CUSTOMER');
    expect(OUR_FAULTS).not.toContain('OUTSIDE');
  });
});

describe('before confirmation, nothing was spent', () => {
  /**
   * The one number on this half that could be wrong is a money number — an
   * order that never shipped paid no fee and moved no stock, and calling the
   * revenue it never earned a loss would put the biggest figure on the screen
   * on the row nobody can defend. So the caller does not get to decide it.
   */
  it('so a money figure on that half is refused, not trusted', () => {
    const report = summariseLoss([
      { field: 'rejectionReason', reason: 'PRICE_TOO_HIGH', count: 3, money: 999 },
    ]);
    expect(report.before.money, 'نسب كلفةً إلى طلبٍ لم يُشحن').toBe(0);
    expect(report.before.lines[0].money).toBe(0);
    expect(report.before.count).toBe(3);
  });

  it('and after shipping the money is kept as given', () => {
    const report = summariseLoss([
      { field: 'returnReason', reason: 'WRONG_PRODUCT', count: 2, money: 9 },
    ]);
    expect(report.after.money).toBe(9);
  });
});

describe('the reading itself', () => {
  const rows: readonly LossRow[] = [
    // Cheap and common.
    { field: 'rejectionReason', reason: 'CUSTOMER_CHANGED_MIND', count: 12, money: 0 },
    { field: 'rejectionReason', reason: 'WRONG_NUMBER', count: 4, money: 0 },
    // Expensive and rare.
    { field: 'returnReason', reason: 'CUSTOMER_REFUSED', count: 2, money: 9 },
    { field: 'deliveryFailureReason', reason: 'WRONG_ADDRESS', count: 3, money: 21 },
    { field: 'returnReason', reason: 'حوّلناه إلى دير الزور', count: 1, money: 4.5 },
    // COMMONEST AND FREE — the row the whole sort exists for. A first version
    // of these fixtures had the dearest row also the commonest, so ranking by
    // count and ranking by cost produced the same list and the assertion
    // below passed against either.
    { field: 'deliveryFailureReason', reason: 'CUSTOMER_REQUESTED_DELAY', count: 9, money: 0 },
  ];

  /**
   * RANKED BY COST, and that is the point of the whole panel.
   *
   * Twelve customers changing their minds cost nothing; three parcels sent to
   * an address nobody could find cost seven fees each way. A list sorted by
   * count puts the free row at the top and gets read top-down.
   */
  it('puts the expensive row first, not the commonest', () => {
    const { after } = summariseLoss(rows);
    expect(after.lines[0].reason, 'مرتَّبٌ بالعدد لا بالكلفة').toBe('WRONG_ADDRESS');
    expect(after.lines[0].money).toBe(21);
    // The commonest row is the free one, and it is last.
    expect(after.lines.at(-1)?.reason).toBe('CUSTOMER_REQUESTED_DELAY');
    expect(after.lines.at(-1)?.count).toBe(9);
  });

  it('and says what share of its half each reason is', () => {
    const { before } = summariseLoss(rows);
    const mind = before.lines.find((l) => l.reason === 'CUSTOMER_CHANGED_MIND');
    expect(mind?.share).toBe(75);
    expect(before.count).toBe(16);
  });

  /**
   * THE UNRECOGNISED VALUE IS COUNTED, NEVER FOLDED IN.
   *
   * `returnReason` measured 31 distinct values across 31 orders on this
   * database — courier prose with the waybill number stuck to the front. All
   * of it arrived with the import, and the launch is a clean start, but two
   * live writers still put sentences in that field. A report that folds those
   * into «أخرى» claims to have read them.
   */
  it('counts the free text it cannot classify, under its own name', () => {
    const { after } = summariseLoss(rows);
    expect(after.unclassified.count, 'النصّ الحرّ ذُوِّب في «أخرى»').toBe(1);
    expect(after.unclassified.money).toBe(4.5);
    const line = after.lines.find((l) => !l.known);
    expect(line?.label).toBe(UNCLASSIFIED_AR);
    expect(line?.reason).toBe(UNCLASSIFIED);
    expect(line?.fault).toBe('UNKNOWN');
    expect(isKnownCode('returnReason', 'حوّلناه إلى دير الزور')).toBe(false);
  });

  /**
   * AND THEY ARE ONE LINE, NOT THIRTY-ONE.
   *
   * Measured on the real database: 31 distinct courier sentences across 31
   * orders. One row each is a panel nobody reads, saying nothing the bucket's
   * total does not already say — and the sentences themselves are on the
   * order and on the returns screen, where somebody can act on them.
   */
  it('and collapses all of them onto a single readable row', () => {
    const { after } = summariseLoss([
      { field: 'returnReason', reason: '14561 - تم الرفض قبل الوصول', count: 1, money: 4 },
      { field: 'returnReason', reason: '14926 - غير محافظة', count: 1, money: 4 },
      { field: 'returnReason', reason: 'رفض الاستلام بالكامل', count: 1, money: 6 },
    ]);
    expect(after.lines, 'سطرٌ لكلّ جملةٍ من المندوب').toHaveLength(1);
    expect(after.lines[0].count).toBe(3);
    expect(after.lines[0].money).toBe(14);
    expect(after.unclassified.count).toBe(3);
  });

  /**
   * ONE SPELLING, TWO EVENTS.
   *
   * `CUSTOMER_REFUSED` is in both after-shipping vocabularies: refused at the
   * door before handover, and refused so the parcel came back. Merging them
   * because the word matches would invent a number neither field holds.
   */
  it('keeps the same code in two fields as two lines', () => {
    const { after } = summariseLoss([
      { field: 'deliveryFailureReason', reason: 'CUSTOMER_REFUSED', count: 1, money: 3 },
      { field: 'returnReason', reason: 'CUSTOMER_REFUSED', count: 1, money: 4 },
    ]);
    expect(after.lines).toHaveLength(2);
    expect(after.money).toBe(7);
  });

  /** The one line anybody can act on this week. */
  it('adds up what our own failures cost after shipping', () => {
    const { preventable, after } = summariseLoss(rows);
    // WRONG_ADDRESS (21) is ours. CUSTOMER_REFUSED (9) is not. The courier
    // prose is UNKNOWN and is not claimed either way.
    expect(preventable.money).toBe(21);
    expect(preventable.count).toBe(3);
    expect(after.money).toBe(34.5);
    expect(preventable.shareOfAfterMoney).toBe(60.87);
  });

  it('and is empty rather than wrong when there is nothing', () => {
    const empty = summariseLoss([]);
    expect(empty.before.count).toBe(0);
    expect(empty.after.money).toBe(0);
    expect(empty.preventable.shareOfAfterMoney, 'قسمةٌ على صفر').toBe(0);
    // A row that says nothing happened must not create a line.
    expect(summariseLoss([{ field: 'returnReason', reason: 'OTHER', count: 0, money: 5 }]).after.lines).toHaveLength(0);
  });
});

describe('the money on the report is an invoice, not an estimate', () => {
  /** A failed attempt that ends in a return is one parcel and one bill. */
  it('charges the fees once, to the return and not also to the attempt', () => {
    const src = route();
    expect(src, 'الأجرة محمولةٌ على الحقلَين فتُحسب مرّتين').toMatch(
      /if \(o\.returnReason\) \{[\s\S]*?money: outbound \+ back \+ goods[\s\S]*?deliveryFailureReason[\s\S]*?money: 0/
    );
  });

  /**
   * THE ROW'S RETURN FEE AS WRITTEN — the same reading the returns desk
   * uses since `2aa703a`, which deleted `returnFee || fee` there.
   *
   * `delivery_fees.returnFee` is `numeric NOT NULL DEFAULT 0`, so a falsy
   * value is a configured 0 and not an unset field; `||` billed those rows
   * the whole OUTBOUND fee twice — once as `outbound` and again as the cost
   * of carrying the parcel back. Measured 2026-10-03: 13 of 25 active rows
   * hold 0 against a fee of 3, 4 or 5.
   *
   * The arithmetic itself is guarded by number in
   * `src/app/api/analytics/loss/loss-return-fee.test.ts`; this pins the
   * shape so the fallback cannot come back in either operator.
   */
  it('reads the return fee the way the returns desk reads it — as written', () => {
    expect(route()).toContain('Number(f.returnFee)');
    expect(route(), 'عاد الاحتياطُ إلى أجرةِ الإرجاع').not.toMatch(/Number\(f\.returnFee\)\s*(\|\||\?\?)/);
    // Per courier per region — the key the row itself means.
    expect(route()).toContain('${f.deliveryProviderId}:${f.regionId}');
  });

  it('takes the fee from the order, not from today\'s table', () => {
    expect(route()).toContain('Number(o.deliveryFee ?? 0)');
  });

  it('and charges the goods only when they came back damaged', () => {
    expect(route()).toMatch(/o\.returnReason === 'DAMAGED_PRODUCT'/);
  });

  /** An order rejected on the phone never met a courier. */
  it('never lets one order count in both halves', () => {
    expect(route(), 'طلبٌ مرفوضٌ يُحسب في النصفَين').toMatch(
      /if \(o\.rejectionReason\) \{[\s\S]{0,200}continue;\s*\}/
    );
  });

  /** A report that quietly dropped rows reads like one that found nothing. */
  it('says when it could not read everything', () => {
    expect(route()).toContain('truncated: total > orders.length');
    expect(panel()).toMatch(/data\.truncated &&/);
  });

  it('and is gated like every other figure on that screen', () => {
    // «عرض التقارير» (29/10) — the same key as the numbers above it; «analytics.view» is retired,
    // and «dashboard.view» (held by nearly every role) would widen who reads the company's figures.
    expect(route()).toContain("requirePermission('reports.view')");
    expect(route()).not.toContain('dashboard.view');
    expect(route()).not.toContain('analytics.view');
  });
});

describe('and it is on the screen people already open', () => {
  it('on the dashboard, beside the card that names the product', () => {
    const dash = stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
    expect(dash, 'اللوحةُ لا تعرض التحليل').toContain('<LossPanel period={period} />');
    // The rankings card names «الأكثر رفضاً»; the panel follows it.
    expect(dash.indexOf('<LossPanel')).toBeGreaterThan(dash.indexOf('highestRejection'));
  });

  it('with no money column on the half that spent none', () => {
    expect(panel()).toMatch(/title="قبل التأكيد"[\s\S]{0,200}withMoney=\{false\}/);
    expect(panel()).toMatch(/title="بعد الشحن"[\s\S]{0,200}withMoney/);
  });

  /** Empty is a state, not a blank card. */
  it('and says why it is empty when it is', () => {
    expect(panel()).toContain('<EmptyState');
    expect(panel()).toContain('لا طلبَ خسرناه في هذه الفترة');
  });
});
