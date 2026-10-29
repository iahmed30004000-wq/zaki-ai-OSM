import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from './guard-source';

/**
 * تشطيب ٢ — PASS 2: «If the same figure is computed in two different places
 * in the code, that is a defect even when the two agree today.»
 *
 * THE LIST OF MONEY WRITERS USED TO BE HAND-MADE, AND THAT IS WHY IT MISSED.
 *
 * `money-written-once.test.ts` holds a curated list of the files that write
 * an order's money, and I corrected it three times in one day as I stumbled
 * on entries — `stock-consumption` by reading a ruling, the winback by
 * reading a route for an unrelated reason. A hand-made list of dangerous
 * places is a list of the dangerous places somebody happened to think of.
 *
 * So this file does not curate. It sweeps BROADLY — every file that names an
 * order money field anywhere and writes a row anywhere — and demands that
 * each one fall on one of two sides, both of which are then CHECKED rather
 * than trusted:
 *
 *   · a WRITER must reach a money function — machine-checked;
 *   · everything else is classified by a PERSON, with the reason written out.
 *
 * AND THE SECOND SIDE IS NOT MACHINE-CHECKED, DELIBERATELY.
 *
 * I tried three times to write a detector that decides «does this file write
 * an order's money», and it was wrong in both directions every time: it
 * missed `public-order` and the winback (their `data` blocks are long, and
 * the money arrives as a shorthand property), and it accused the statements
 * route and the offers routes (whose `sellingPrice` belongs to an OFFER, and
 * whose `totalAmount: true` is a select). The distinction is semantic —
 * WHOSE money, and read or written — and the syntax does not carry it.
 *
 * A detector I know to be wrong is worse than no detector: it is the one
 * that taught me `Math.round(x * 100) / 100` was fine because it was looking
 * for `.toFixed(2)`. So the reading side says plainly that a person did it,
 * and carries the reason for each, which is the thing a reader can check.
 *
 * What IS machine-checked is the part that actually fails open: the sweep is
 * over-inclusive, and a file outside BOTH lists fails. A new money path
 * cannot appear without somebody naming it.
 */

const SRC = join(process.cwd(), 'src');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/');

/** The four figures an ORDER carries. Not a wallet's, not a report's. */
const MONEY_FIELD = /\b(totalAmount|sellingPrice|discountAmount|estimatedCostOfGoods)\b/;
const WRITES_A_ROW = /\.(create|update|updateMany|upsert|createMany)\(/;
/*
 * THE CALL, NOT THE NAME — and this is the FOURTH time in one day that a
 * guard in this repository has been satisfied by an import line while the
 * thing it names was gone. `computeCod` alone matches
 * `import { computeCod } from …`, so a file that stopped calling it still
 * passed. Every alternative here therefore ends in an open bracket and a
 * character that cannot start a closing one.
 *
 * `money.cod` was an alternative here too, and it is a property READ — the
 * mutation that replaced `computeCod({…})` with a literal `{ cod: 0 }` left
 * `const totalAmount = money.cod;` behind, and the pattern matched it. Every
 * writer calls one of these three anyway, so the weaker alternatives bought
 * nothing and cost two missed mutations.
 */
const A_MONEY_FUNCTION = /(?:computeCod|codForOrder|roundMinor)\(\s*[A-Za-z{[]/;

/**
 * THE FILES THAT WRITE AN ORDER'S MONEY. Every one must reach a money
 * function — `computeCod` for what a customer pays, `roundMinor` for a
 * figure rounded on its own, `Prisma.Decimal` for profit arithmetic that
 * must not round at all.
 */
const WRITERS = [
  'src/lib/public-order.ts',
  'src/lib/telegram/order-creation.ts',
  'src/lib/replacement-order.ts',
  'src/lib/stock-consumption.ts',
  'src/app/api/orders/route.ts',
  'src/app/api/orders/[id]/route.ts',
  'src/app/api/orders/ai-intake/route.ts',
  /*
   * O7 — THE SYSTEMS DOOR, AND IT PRICES NOTHING ITSELF.
   *
   * The replies system sends `unit_price`, `line_total` and a whole
   * `totals` object, and this file writes NONE of them: it re-prices from
   * the catalogue through `activeOffersFor` and `computeCod`, exactly as
   * `public-order.ts` does, and reports `price_adjusted` when the two
   * disagree. It is on this list so that the day somebody «simplifies» it
   * by trusting the caller's figure, the guard says so.
   */
  'src/lib/v1/order-intake.ts',
  'src/app/api/ops/shipments/route.ts',
  'src/app/api/confirmation/winback/route.ts',
  'src/app/api/public/landing-pages/[slug]/orders/[orderNumber]/add-product/route.ts',
  /*
   * «العرض بعد الطلب». It writes `totalAmount` and nothing else of the
   * four, and it writes it as an INCREMENT of the add-on's own value —
   * never a recompute, because a recompute here would re-decide the first
   * order's discount, fee policy and rounding from today's configuration.
   * The value itself comes from `computeCod`, which is what puts this file
   * on THIS list rather than the one below: the figure written here and the
   * figure every later recompute of the order contributes are the same
   * number by construction.
   */
  'src/lib/post-order-offer.ts',
];

/**
 * NAMES A MONEY FIELD AND DOES NOT WRITE ONE — each with the reason, because
 * «it only reads it» is exactly what was wrongly assumed about the winback.
 */
const READS_ONLY: Record<string, string> = {
  'src/app/api/confirmation/postponed/route.ts': 'يعرض إجمالي الطلب في قائمة',
  /*
   * THE ONE HELPER THAT ENDS AN ORDER. It READS `totalAmount` to put it in the
   * `order.cancelled` event and writes no figure of any order: its update sets a
   * status, takes the parcel off its trolley and clears the waybill — the COD
   * snapshot (`totalAmount`, `deliveryFee`) is left exactly as it was.
   */
  'src/lib/order-cancel.ts': 'يقرأ إجمالي الطلب ليعلنه في حدث الإلغاء، ولا يكتب مالاً',
  /*
   * `src/app/api/customers/route.ts` was here. It left the sweep on
   * 2026-10-02: it no longer writes a customer itself — the create went
   * through `findOrCreateCustomer`, where it belonged — so nothing in it looks
   * like a write any more. The name went with the reason, which is the half of
   * this guard that stops a list outliving what put it there.
   */
  'src/app/api/finance/route.ts': 'مصاريف وتقارير — لا يلمس مال طلب',
  'src/app/api/finance/statements/route.ts': 'إجمالي كشف المندوب، لا إجمالي طلب',
  'src/app/api/finance/statements/[id]/route.ts': 'إجمالي كشف المندوب في سجلّ إلغاء الاستيراد، لا إجمالي طلب',
  'src/app/api/growth/storefronts/route.ts': 'إيراد كل واجهة — قراءة',
  'src/app/api/offers/route.ts': 'سعر العرض نفسه، وهو إدخال البائع لا حساب',
  /*
   * `src/app/api/offers/[id]/route.ts` was here, for the same reason as the
   * POST door above it. It left the sweep on 2026-10-02: the PATCH used to
   * name each column it writes — `input.sellingPrice !== undefined ? …` —
   * and it now spreads the fields the request actually carried, so nothing
   * in it spells a money field any more. It never wrote an ORDER's money,
   * so the sweep loses no coverage of that; and if a money field is ever
   * named in it again it reappears as an unclassified stranger, which is
   * the net doing its work. The name went with the reason.
   */
  /*
   * `ops/tracking/collect/route.ts` STOOD HERE AND NEVER BELONGED.
   *
   * Its reason read «collects cash to a wallet, and does not change the
   * order's total» — true, and the giveaway. The only occurrence of any
   * of the four names in that file is inside a COMMENT at its line 125;
   * its code touches none of them. It was swept because the sweep read
   * prose, and it was excused because somebody then had to explain why a
   * file that writes no order money appeared in a list of files that do.
   *
   * The name goes with the reason, following the dated precedent above.
   */
  'src/app/api/ops/tracking/write-off/route.ts': 'يقرأ الإجمالي ليعرضه ويشطب الشحنة',
  'src/app/api/orders/[id]/change-requests/route.ts': 'يسجّل طلب تعديل؛ التطبيق يمرّ بمسار الطلب',
  'src/app/api/orders/[id]/confirmation/route.ts': 'حالة التأكيد وسببها — لا مال فيها',
  'src/app/api/orders/[id]/finance/route.ts': 'أرباح بـPrisma.Decimal — دالّة مالٍ أخرى ولا تدوير',
  'src/app/api/orders/[id]/reorder/route.ts': 'يمرّر تعديلات إلى createReplacementOrder',
  /*
   * THE REASON WAS NOT TRUE, AND THE VOCABULARY IS WHY NOBODY NOTICED.
   *
   * It read «حالة الشحن ومواعيدها — لا يلمس رقماً من أرقام الطلب», and this
   * route DOES write one of the order's money columns: `update_tracking`
   * writes `deliveryFee`, which `settlement.ts` deducts from what the
   * courier owes and `commission.ts` subtracts before commission. It
   * escaped notice because `MONEY_FIELD` above knows four names and
   * `deliveryFee` is not among them — so the file is in this sweep on the
   * strength of a different name entirely, and its reason was describing a
   * file that does not exist.
   *
   * The name stays on this list, because the figure it writes is NOT one a
   * money function computes: a delivery fee is a number a person types,
   * like a price. What it needed was the door, and `e6…` gave it one —
   * `money()` from `numeric-input`, refusing what is not a fee instead of
   * storing `Number(deliveryFee) || 0`, which was free delivery. Widening
   * `MONEY_FIELD` to include `deliveryFee` is the owner's call and not a
   * side effect of this correction: it would pull in every reader of the
   * column across the tree and both lists would have to be re-partitioned.
   */
  'src/app/api/orders/[id]/shipping/route.ts':
    'حالة الشحن ومواعيدها، ويكتب deliveryFee وحدَه — رقمٌ يكتبه شخصٌ لا تحسبه دالّة، وبابُه يرفض ما ليس رقماً',
  'src/app/api/products/route.ts': 'سعر المنتج في الكتالوج، لا سعر سطرٍ في طلب',
  'src/app/api/shipping-batches/[id]/route.ts': 'حالة دفعة الشحن وأعضاؤها — لا مال',
  'src/app/api/whatsapp/conversations/[id]/route.ts': 'يعرض إجمالاً داخل محادثة',
  'src/lib/commission.ts': 'العمولة، ولها دالّتها وجدولها المنفصل عن الطلب',
  'src/lib/conversions/emit.ts': 'يرسل قيمة إلى منصّة إعلانات — صادر، قراءة',
  'src/lib/courier-dispatch.ts': 'يقرأ الإجمالي المخزّن ليبلّغه للمندوب',
  'src/lib/offers.ts': 'تسعير العروض نفسها — سعر العرض إدخال البائع',
  'src/lib/settlement.ts': 'تسوية — مالها مالُ كشفٍ لا طلب',
  'src/lib/manual-statement.ts': 'الكشف اليدوي: يكتب إجمالي الكشف (مجموع أسطره) وأسطره، لا إجمالي طلب ولا حركة محفظة — المال يتحرك عند الاعتماد',
  /*
   * ترحيل طلبات قديمة (قرار المالك، الخيار B): يكتب مبلغ الملف كما هو لطلبٍ انشحن وانقبض فعلاً خارج النظام، ولا يحسب
   * شيئاً — حسابه اليوم من جدول أجور اليوم كان سيغيّر مبلغاً دفعه زبون. ليس باب طلبات يومي: للمالك وحده، ويكتب من ملف.
   */
  'src/lib/order-migration.ts': 'ترحيل: يكتب مبلغ الملف كما هو، لا حساب — طلبات قديمة انقبضت',
};

describe('every file that could write an order’s money is on one of two lists', () => {
  /*
   * THE SWEEP READS CODE, NOT PROSE.
   *
   * It used to read the file whole, so a COMMENT naming a money column put
   * its file in the sweep. Found the honest way: a comment added to
   * `finance/statements/[id]/route.ts` explaining that revenue sums
   * `collectedAmount` beside `totalAmount` dragged that file in, and the
   * suite reported a money writer that had not gained one.
   *
   * The far worse direction is the same bug reversed — a file could be kept
   * OUT by nothing more than how its code was spelled, while a comment above
   * it talked about the column it writes. `stripComments` is what eight
   * other guards in this repository already use for exactly this.
   */
  const swept = filesUnder(SRC)
    .filter((p) => {
      const src = stripComments(readFileSync(p, 'utf8'));
      return MONEY_FIELD.test(src) && WRITES_A_ROW.test(src);
    })
    .map(rel);

  it('sweeps a real number of files, not an empty set', () => {
    expect(swept.length).toBeGreaterThanOrEqual(25);
  });

  it('and not one of them is unaccounted for', () => {
    const known = new Set([...WRITERS, ...Object.keys(READS_ONLY)]);
    const strangers = swept.filter((f) => !known.has(f));
    expect(
      strangers,
      'ملفٌّ يمسّ مال الطلب ولم يُصنَّف — إمّا أن يمرّ بدالّة المال أو أن يُقال لماذا لا يحتاجها'
    ).toEqual([]);
  });

  it('and neither list has gone stale by naming a file that no longer sweeps', () => {
    // A list that keeps a deleted file is a list nobody is maintaining.
    const inSweep = new Set(swept);
    const ghosts = [...WRITERS, ...Object.keys(READS_ONLY)].filter((f) => !inSweep.has(f));
    expect(ghosts, 'اسمٌ في القائمة لا يظهر في المسح').toEqual([]);
  });
});

describe('and each side of the partition is checked, not merely asserted', () => {
  /*
   * WHAT THIS CHECKS, AND WHAT IT DOES NOT.
   *
   * It catches a writer that reaches NO money function at all — the shape
   * the winback had, where a total was arithmetic in the middle of a route.
   * It does NOT catch a file that stopped using one of two: `public-order`
   * calls `computeCod` for the COD and `roundMinor` for the cost of goods,
   * so removing the first leaves the second and this still passes.
   *
   * That finer rule — which FIELD went through which function — is checked
   * per file in `money-written-once.test.ts`, where it can be written
   * exactly. Said here so the two are not mistaken for one.
   */
  it.each(WRITERS)('%s reaches a money function', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    expect(src).toMatch(A_MONEY_FUNCTION);
  });

  it('and every reason on the reading side is a sentence, not a shrug', () => {
    // The reading side is a person's classification, so the reason is the
    // only thing a reviewer has. «قراءة» on its own would be a shrug.
    for (const [file, why] of Object.entries(READS_ONLY)) {
      expect([...why].length, `${file}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(12);
    }
  });
});
