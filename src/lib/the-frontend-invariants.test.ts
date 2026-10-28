import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import { computeCod, roundMinor } from './money';
import { expectedAmountFor } from './settlement';
import { batchTotal, batchUnitCost } from './product-cost';
import { stockHealth, type StockFacts } from './stock-health';

/**
 * تشطيب ١ — STAGE 1: THE COMMITMENTS LEDGER, the frontend. The eighth and
 * last section.
 *
 * «The UI computes nothing the backend already computes. It NEVER calculates
 *  COD, delivery fee, discount allocation, available stock, days in transit,
 *  SLA remaining, commission, profit, delivery rate, risk tier, or expected
 *  settlement amount. If a value is missing from a response, extend the
 *  endpoint. A number that exists in two places will diverge.»
 *                      — invariants.md, `## Frontend`
 *
 * ELEVEN FIGURES, NOT TWELVE. The sentence names eleven: COD, delivery fee,
 * discount allocation, available stock, days in transit, SLA remaining,
 * commission, profit, delivery rate, risk tier, expected settlement amount.
 * Counted twice because the brief asked for twelve and a missing twelfth
 * would otherwise read as a figure nobody checked.
 *
 * SEVEN HOLD. FOUR ARE DIVERGED, and they are pinned AS THEY ARE and
 * reported rather than resolved — «A DIVERGED or CONFLICT item is reported,
 * not resolved.»
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT COUNTS AS «COMPUTING», AND WHAT DOES NOT.
 *
 * The rule is about BUSINESS figures. Three kinds of arithmetic in a
 * component are legitimate, and every one of them exists in this tree, so
 * the distinction has to be written down rather than left to whoever reads
 * the next sweep:
 *
 *   1 · AN INPUT ECHO. The sum of prices a moderator is typing into a form
 *       for an order that does not exist yet. There is no server figure to
 *       render, because there is nothing on the server. `ProductLinesEditor`
 *       calls this «قيمة البضاعة» and says in its own header that the COD is
 *       the server's. A number computed from the user's own keystrokes is
 *       not a second copy of anything.
 *
 *   2 · A UNIT CONVERSION OR A FORMAT. `Math.round(risk.returnRate * 100)`
 *       turns the server's 0.22 into «22%». The figure is the server's; only
 *       the notation is the screen's. Likewise a progress bar's width, a
 *       grid's column count, a character counter, and a clock that ticks.
 *
 *   3 · THE ONE PURE FUNCTION, CALLED FROM BOTH SIDES.
 *       `ManufacturingScreen` imports `batchTotal` and `batchUnitCost` from
 *       `product-cost.ts` — the same two functions `/api/production` calls.
 *       That is not the UI computing; that is the UI using the one
 *       implementation. Its own comment records why: «This used to add the
 *       buckets and the lines here and divide to two places, while the
 *       server records four — so the unit cost somebody watched while typing
 *       could differ from the one written down.»
 *
 * What is NOT legitimate is a screen applying a RULE — the COD branch, the
 * partial-delivery fee, the per-unit discount, the settlement expectation —
 * to numbers the server already applied it to. That is the second copy, and
 * «a number that exists in two places will diverge» is not a prediction
 * here. Three of the four divergences below are measured, in this file,
 * against the server's own functions.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE DOES NOT USE `dashboardFiles()`.
 *
 * `guard-source.SELLER_SURFACES` excludes the landing pages, the storefront
 * and the public pages, and it is right to: those are a rule about COLOURS
 * and FONTS, and the dashboard's palette has no business overwriting a
 * seller's brand. Money is not like that. A shopper's basket that adds up
 * its own total diverges from the door exactly as badly as an operations
 * screen does — worse, because the customer read the number. So the sweep
 * here is over EVERY `.tsx` under `src/components` and `src/app`, and
 * `components/landing/OrderForm.tsx` is in the swept set below because of
 * it. Reaching for `dashboardFiles()` would have dropped the one surface a
 * customer actually sees.
 */

/* ════════════════════════════════════════════════════════════════════════
   Ⅰ · THE SWEEP — every screen that does arithmetic on one of the eleven
       figures must fall on one of two lists, and a file on neither fails.

   THE WHOLE VALUE IS THAT THE NEXT SCREEN CANNOT BE THE EXCEPTION. A
   curated list of «screens that handle money» is a list of the screens
   somebody happened to think of; `every-money-writer-is-known.test.ts` says
   why at length, having been corrected three times in one day.
   ════════════════════════════════════════════════════════════════════════ */

const ROOTS = ['src/components', 'src/app'];

function tsxUnder(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxUnder(p, out);
    else if (/\.tsx$/.test(name) && !name.includes('.test.')) out.push(p);
  }
  return out;
}

/*
 * `split(sep).join('/')` IS NOT DECORATION. On Windows `relative()` hands
 * back `src\components\…`, and every list below is written with forward
 * slashes — so without this the known-file sets match nothing, the sweep
 * reports all twelve files as strangers, and tuning the lists to agree with
 * that makes the guard permanently blind. `the-attribution-invariants`
 * carries the same note for the same reason.
 */
const rel = (p: string) => relative(process.cwd(), p).split(sep).join('/');

/**
 * THE VOCABULARY IS THE CONTRACT'S OWN LIST, in this schema's field names.
 *
 * Nothing more and nothing less: the rule names eleven figures, so the
 * sweep knows eleven figures. A rate this system does not hold anywhere —
 * the dashboard's rejection rate, a wallet's book-balance variance, the
 * minutes between a claim and the first call — is outside the sentence, and
 * stretching the vocabulary to cover it would bury the eleven in noise and
 * then get the noise exempted. Those are named in Ⅴ instead, as measured
 * near-misses, so an absence from this list is a decision rather than an
 * oversight.
 */
const FIGURE =
  '(?:totalAmount|sellingPrice|unitPrice|lineTotal|basePrice|subtotal' +
  '|discountAmount|discountShare|deliveryFee|priceIncludesDelivery|shippingCost' +
  '|collectedAmount|expectedCollection|expectedAmount|expectedFee' +
  '|costPerUnit|averageCost|estimatedCostOfGoods|revenue|netProfit|profitMargin' +
  '|commission|onHand|reserved|reservedQty|available|remaining|coverDays' +
  '|daysInTransit|daysRemaining|slaRemaining|deliveryRate|returnRate|riskTier)';

/*
 * AN OPERATOR ADJACENT TO A FIGURE — the USE, not the mention.
 *
 * A sweep for the NAME is satisfied by the name. `import … from
 * '@/lib/commission-fairness'` contains `commission` and a `-`;
 * `/api/finance/commission/payout` contains `commission` and a `/`;
 * `className="text-[var(--sys-heading)]"` is a thicket of hyphens. All
 * three passed a name-plus-any-operator detector, and a list of thirty
 * files whose reasons are mostly «that is a CSS class» is a list nobody
 * reads — which is how a real entry hides in it.
 *
 * So the operator must carry whitespace on at least one side (Prettier puts
 * it there for every binary operator in this repo, and never inside an
 * import path, a URL or a Tailwind class), and the figure must be adjacent
 * to it across nothing but brackets, whitespace and a `Number(` wrapper:
 * `Number(l.unitPrice) - discountPerUnit` must match, and
 * `commission-fairness` must not. Measured: 12 files, no false positives
 * across all 312 `.tsx` files in the tree.
 */
const OP = '(?:\\s[-+*/]\\s|\\s[-+*/]|[-+*/]\\s)';
/*
 * A FIGURE MAY PASS THROUGH ONE `?? <literal>` ON ITS WAY TO THE OPERATOR.
 *
 * Found on 2026-10-03, and it had been hiding a real division the whole
 * time: `OrderLinesCard.tsx:92` is
 * `(order.sellingPrice ?? 0) / Math.max(1, order.quantity ?? 1)` — money
 * divided in a browser — and the sweep could not see it, because between
 * `sellingPrice` and the `/` sat `?? 0)`, and `[\s)\]]*` matches neither
 * `?` nor `0`. The file stayed in the sweep only on the strength of a
 * SECOND violation beside it; when that one was deleted the file dropped
 * out of the sweep entirely and its entry below became a ghost — a guard
 * reporting itself clean while the thing it guards against was still there.
 *
 * The widening is deliberately this narrow: the coalesce must be followed by
 * an operator. A bare `deliveryFee ?? 0` still does not match, which is why
 * this costs nothing — measured across every component file, it adds exactly
 * ONE line, the one above. Widening `OP` to treat `??` itself as arithmetic
 * was the other option and would have flooded both lists with every
 * `?? 0` in the tree.
 */
const COALESCE = '(?:\\?\\?\\s*[\\w.-]+[\\s)\\]]*)?';
const FIGURE_THEN_OP = new RegExp(`\\b${FIGURE}\\b[\\s)\\]]*${COALESCE}${OP}`);
const OP_THEN_FIGURE = new RegExp(`${OP}[\\s(]*(?:Number\\(|String\\()?[\\s(]*[\\w.?]*\\b${FIGURE}\\b`);

/**
 * THE COMMENTS ARE BLANKED AND THE TEMPLATE LITERALS ARE NOT.
 *
 * Blanking comments is the fix that four earlier guards in this repository
 * needed: a guard forbids a shape, the comment above it documents the
 * shape, and the guard finds its own prose.
 *
 * `stripTemplates` is deliberately NOT used, and that is the opposite call
 * from most guards here. It exists so a code sample inside `<pre>{`…`}</pre>`
 * is not mistaken for markup — but a template literal is also where a
 * screen puts arithmetic it is interpolating into a sentence:
 * `${Math.round(((now - before) / before) * 100)}%`. Blanking templates
 * would make every such computation invisible, which is the one failure
 * mode this sweep cannot afford.
 */
function sweptLines(src: string): number[] {
  const hits: number[] = [];
  stripComments(src)
    .split('\n')
    .forEach((line, i) => {
      if (FIGURE_THEN_OP.test(line) || OP_THEN_FIGURE.test(line)) hits.push(i + 1);
    });
  return hits;
}

const SWEPT: string[] = (() => {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const p of tsxUnder(join(process.cwd(), root))) {
      if (sweptLines(readFileSync(p, 'utf8')).length > 0) out.push(rel(p));
    }
  }
  return out.sort();
})();

/**
 * RENDERS WHAT IT WAS SENT, OR ECHOES WHAT IS BEING TYPED — each with the
 * reason, because «it only displays it» is exactly what was wrongly assumed
 * about `TrackingScreen` until the number was read beside the dialog's.
 *
 * This side is a PERSON's classification and is not machine-checked, for
 * the reason `every-money-writer-is-known.test.ts` sets out: a detector
 * that decides «is this a business figure or a keystroke echo» was wrong in
 * both directions every time it was tried, because the distinction is
 * semantic — WHOSE number, and does the server hold one. A detector known
 * to be wrong is worse than none. What IS machine-checked is the half that
 * fails open: the sweep is over-inclusive, and a file outside BOTH lists
 * fails.
 */
const RENDERS_ONLY: Record<string, string> = {
  'src/components/landing/OrderForm.tsx':
    'وفَّرْتَ كذا — فرقٌ بين سعر القطعة المفرد وسعر العرض، إعلانٌ لا يصل طلباً، والإجمالي يأتي من newTotal من الخادم',
  'src/components/orders/CustomerHistory.tsx':
    'الدرجةُ والنسبةُ من الخادم؛ الضربُ في مئة تحويلُ كسرٍ إلى بالمئة لا حسابُ خطر',
  'src/components/performance/LandingAnalyticsTab.tsx':
    'نِسَبُ التحويل والتسليم من الخادم؛ ×1000÷10 كتابةُ كسرٍ بخانةٍ عشرية',
  'src/components/products/ProductOffers.tsx':
    'سعرُ القطعة عرضٌ مشتقٌّ للمقارنة، والسعرُ المقترَحُ بمضاعفٍ اقتراحٌ يكتبه البائع ويعدّله — وسقفُه وسقفُ التلميح من offerCeiling، الدالّةِ نفسِها التي يرفض بها الخادم، وسقفُ العرض المحفوظ يأتي من الخادم كما هو',
  'src/components/screens/confirmation/AssistantDialog.tsx':
    'نسبةُ الإرجاع من الخادم، والضربُ في مئة كتابةٌ لا قياس',
  'src/components/screens/ConfirmationMineScreen.tsx':
    'الدرجةُ ونسبتُها من الخادم؛ والمتبقي من المحاولات عدَدٌ لا مالٌ ولا مخزون',
  'src/components/screens/tracking/CollectDialog.tsx':
    'يجمع expectedCollection التي حسبها الخادم لكل طلب — والجمعُ ليس إعادةَ اشتقاقِ القاعدة، وملفُّه يقول ذلك بنفسه',
  'src/components/screens/TrackingScreen.tsx':
    'كان يحسب صافي المختار بنفسه، وصار يجمع expectedCollection التي يرسلها الخادم لكل صفّ — والجمعُ ليس اشتقاقاً',
  'src/components/production/BatchCostDialog.tsx':
    'كان يجمع الكلفة ويقسمها بيده، وصار يستدعي batchTotal و batchUnitCost — الدالّتين نفسَيهما اللتين يستدعيهما الخادم',
};

/**
 * DIVERGED — what is still a second copy of a server figure.
 *
 * Three of the four found on 2026-10-02 were fixed the same day and their
 * entries moved out of this list, each into a guard in Ⅳ that keeps the fix
 * from being undone. What is left is the one whose remedy is not a line:
 * the deliver dialog needs a dry-run the delivery endpoint does not offer.
 */
const DIVERGED: Record<string, string> = {
  /*
   * EMPTY, AND THAT IS THE LIST WORKING RATHER THAN THE LIST BEING UNUSED.
   *
   * `DeliverDialog.tsx` was the last entry — «it rewrites the COD rule and
   * the discount allocation and the partial-delivery fee that are in
   * partial-delivery.ts» — and the note above this list said its remedy
   * «is not a line: the deliver dialog needs a dry-run the delivery
   * endpoint does not offer».
   *
   * The endpoint offers one now (`preview: true`), running the same
   * `doorMoney` the submit runs, and the dialog prints what comes back.
   * Measured before it was built, the two copies apart: an order carrying
   * a thank-you-page upsell priced 29.5 at the door and 24.5 on the
   * screen — five dinars the courier was never asked for, invisible to the
   * screen's loop because an add-on has no line to loop over.
   *
   * An entry leaves this list when the ARITHMETIC leaves the browser. The
   * test below fails on a name that no longer sweeps, which is what
   * prompted both removals.
   *
   * ── and the one before it ────────────────────────────────────────────
   *
   * `OrderLinesCard.tsx` STOOD HERE AND IS GONE, which is what this list is
   * supposed to lead to.
   *
   * It arrived from `RENDERS_ONLY` on 2026-10-03 carrying a synthetic line
   * for an order with no `items`, whose unit price was
   * `sellingPrice / quantity` rounded by nothing — against the server's
   * `lineTotal / quantity` to two places (`settlement.ts`).
   *
   * MEASURED BY RESTORING IT, not quoted: 3 units over a selling price of
   * 50 drew «3 × 16.667 JOD» where the server stores 16.67. The «50.01»
   * this entry used to name belonged to the OTHER half of the branch,
   * `unitPrice × quantity`, deleted the same day it was listed — a figure
   * from a different expression, carried forward unchecked.
   *
   * Its entry ended «the remedy is to delete the branch,
   * not to re-justify it», and the branch is deleted: the card renders
   * `order.items` and nothing else, and an order with no lines says so in
   * a sentence while the summary beneath it shows the server's own
   * `sellingPrice` and `quantity`.
   *
   * Re-measured before deleting rather than trusted: **0 of 56 orders have
   * no items**, so nothing on this database changes appearance.
   *
   * An entry is removed from this list by removing the ARITHMETIC, never by
   * removing the line — the test below fails on a name that no longer
   * sweeps, which is how this removal was prompted.
   */
};

describe('Ⅰ · every screen that does arithmetic on one of the eleven figures is classified', () => {
  it('and the sweep finds a real set, not an empty one', () => {
    /*
     * A detector that matches nothing passes every rule in this file. The
     * floor is the measured set less a little slack, so a refactor that
     * genuinely removes a screen does not fail — but a broken regex does.
     *
     * LOWERED FROM 10 TO 8 when `DeliverDialog` stopped computing: the
     * swept set is 9 now. It comes down by hand, in the commit that takes
     * a screen off the list, because a floor that drifts on its own is not
     * a floor. Both removals so far were real — `OrderLinesCard` and this
     * one — and the number should keep falling.
     */
    expect(SWEPT.length).toBeGreaterThanOrEqual(8);
  });

  it('and not one of them is unaccounted for', () => {
    const known = new Set([...Object.keys(RENDERS_ONLY), ...Object.keys(DIVERGED)]);
    const strangers = SWEPT.filter((f) => !known.has(f));
    expect(
      strangers,
      'شاشةٌ تحسب رقماً من الأحد عشر ولم تُصنَّف — إمّا أن تعرض ما أرسله الخادم أو أن يُقال لماذا حسابها مشروع:\n' +
        strangers.join('\n')
    ).toEqual([]);
  });

  it('and neither list has gone stale by naming a file that no longer sweeps', () => {
    // A list that keeps a file nobody computes in any more is a list nobody
    // is maintaining — and it is also how a name gets pre-registered so a
    // future violation lands pre-approved.
    const inSweep = new Set(SWEPT);
    const ghosts = [...Object.keys(RENDERS_ONLY), ...Object.keys(DIVERGED)].filter((f) => !inSweep.has(f));
    expect(ghosts, `اسمٌ في القائمة لا يظهر في المسح:\n${ghosts.join('\n')}`).toEqual([]);
  });

  it('and no file is on both lists', () => {
    const both = Object.keys(DIVERGED).filter((f) => f in RENDERS_ONLY);
    expect(both).toEqual([]);
  });

  it('and every reason is a sentence a reviewer can check, not a shrug', () => {
    // The reading side is a person's judgement, so the reason is the only
    // thing a reviewer has. «قراءة» on its own would be a shrug.
    for (const [file, why] of Object.entries({ ...RENDERS_ONLY, ...DIVERGED })) {
      expect([...why].length, `${file}: السبب أقصر من أن يُراجَع`).toBeGreaterThan(24);
    }
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Ⅱ · THREE SHAPE NETS — orthogonal to the vocabulary above.

   The sweep in Ⅰ asks «does this file do arithmetic on a named figure». It
   would miss a screen that computed the COD out of local aliases, which is
   exactly what `DeliverDialog` does on its line 80: `goods`, `chargedFee`
   and `collected` name none of the eleven.

   So these three ask a different question: is the SHAPE of a forbidden rule
   written anywhere in the tree? Each one is the shape of one contract
   sentence, and each currently catches exactly one line — pinned, because a
   net whose catch is unpinned is a net somebody empties by hand.
   ════════════════════════════════════════════════════════════════════════ */

function shapeHits(re: RegExp): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const p of tsxUnder(join(process.cwd(), root))) {
      stripComments(readFileSync(p, 'utf8'))
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line)) out.push(`${rel(p)}:${i + 1}`);
        });
    }
  }
  return out.sort();
}

describe('Ⅱ · the shape of a forbidden rule, wherever it is written', () => {
  it('the delivery-inclusion flag picks a SENTENCE in the UI, and a NUMBER only on the server', () => {
    /*
     * «If price_includes_delivery: COD = price − discount, and the fee is
     *  deducted from revenue.» — the money section. That branch is
     *  `money.ts:116`, and it is the whole of the flag's arithmetic
     *  meaning.
     *
     * A screen may READ the flag: `OrderDetailModal` writes
     * `{cod?.includesDelivery && <span>(داخلة في السعر)</span>}` — an `&&`
     * that adds a parenthesis to a label, carrying no number. What it may
     * not do is make the flag the head of a ternary that chooses between
     * two money expressions, because that IS the branch.
     */
    /*
     * AND NOW THERE IS NO SUCH TERNARY ANYWHERE.
     *
     * This expectation named one line — `DeliverDialog.tsx:80`,
     * `order.priceIncludesDelivery ? goods : goods + chargedFee` — the last
     * place a browser branched on the flag to pick between two money
     * expressions. The dialog asks the door for the figure now, so the
     * shape is gone and the rule is held as an absence, which is the
     * stronger form: a new one fails here on the day it is written.
     */
    expect(shapeHits(/\b(?:price)?[Ii]ncludesDelivery\s*\?\s*[^:\n]+:/)).toEqual([]);
  });

  it('the delivery fee is never taken out of an order total in a browser', () => {
    // What a courier hands over is `expectedAmountFor` in `settlement.ts`,
    // and it is NOT «total − fee»: it reads the collected amount on a
    // partial delivery and returns zero on a return. Ⅳ measures both gaps.
    // It found exactly one line on 2026-10-02 — `TrackingScreen:312`,
    // «صافي» on the selection bar — and that line is gone: the screen now
    // sums the `expectedCollection` the route always sent. The net stays
    // because the next screen to need a net figure will reach for the
    // same subtraction.
    expect(shapeHits(
      /totalAmount[\s\S]{0,40}?[-+][\s\S]{0,40}?deliveryFee|deliveryFee[\s\S]{0,40}?[-+][\s\S]{0,40}?totalAmount/
    )).toEqual([]);
  });

  it('a stored discount share is never divided back out across units in a browser', () => {
    // «Discount is allocated across lines proportionally and stored per
    // line. Without this, partial returns refund the wrong amount.» The
    // allocation is `money.allocateDiscount`; spreading the stored share
    // back over the units is `partial-delivery.ts:188` and nowhere else.
    /*
     * AND THE ONE PLACE THAT DID IT IS GONE. `DeliverDialog.tsx:75` was
     * `Number(l.discountShare) / l.quantity` — the stored share spread back
     * over units so the screen could price a partial delivery. It priced it
     * wrong: the loop could not see the thank-you-page upsell, which has no
     * line, so an order carrying one was shown five dinars short of what
     * the door records. The door prices it now and the browser prints the
     * answer, so this is held as an absence.
     */
    expect(shapeHits(/discount\w*\s*\)?\s*\/\s*[\w.]*(?:quantity|qty|units)/i)).toEqual([]);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Ⅲ · THE SEVEN THAT HOLD, with the evidence rather than an absence.

   An absence reads as «probably somewhere». Each of these names the screen
   that renders the figure and the endpoint that computed it.
   ════════════════════════════════════════════════════════════════════════ */

describe('Ⅲ · COD — held on every surface but one', () => {
  it('the order screen renders a breakdown the server computed, field by field', () => {
    const modal = stripComments(repoFile('src/components/orders/OrderDetailModal.tsx'));
    // The four figures, each read off `cod` rather than assembled. The
    // state's type is the evidence that no fifth is derived.
    expect(modal).toMatch(
      /\{ subtotal: number; discount: number; deliveryFee: number; cod: number; includesDelivery: boolean \}/
    );
    expect(modal).toMatch(/setCod\(data\.cod \?\? null\)/);
    expect(modal).toMatch(/money\(cod\?\.cod \?\? order\.totalAmount\)/);
    // And the door it comes from calls the one function.
    const route = stripComments(repoFile('src/app/api/orders/[id]/route.ts'));
    expect(route).toMatch(/const cod = computeCod\(\{/);
    expect(route).toMatch(/cod: \{ \.\.\.cod, includesDelivery: order\.priceIncludesDelivery === true \}/);
  });

  it('the shopper’s basket refuses to show a total until the server has quoted one', () => {
    /*
     * THE STRONGEST EVIDENCE IN THIS SECTION, and the answer to «extend the
     * endpoint» — somebody already did. The cart holds lines in
     * `localStorage` and asks `/quote` what they cost; while that is in
     * flight the total reads «جارٍ الحساب…» and the checkout link is inert.
     * A basket that could add up its own lines would never need to wait.
     */
    const hook = stripComments(repoFile('src/components/storefront/useCart.ts'));
    expect(hook).toMatch(/shopFetch\(`\/api\/public\/stores\/\$\{slug\}\/quote`/);
    const view = stripComments(repoFile('src/components/storefront/CartView.tsx'));
    expect(view).toMatch(/cart\.quote \? money\(cart\.quote\.cod\) : cart\.pricing \? 'جارٍ الحساب…' : '—'/);
    expect(view).toMatch(/aria-disabled=\{!cart\.quote\}/);
    // And the rule is written where the waiting is, or the next reader
    // "fixes" the spinner by computing a subtotal.
    expect(repoFile('src/components/storefront/useCart.ts')).toMatch(/NOTHING HERE ADDS UP A PRICE/);
    const checkout = stripComments(repoFile('src/components/storefront/CheckoutForm.tsx'));
    expect(checkout).toMatch(/moneyText\(cart\.quote\.cod, cart\.quote\.currency, minorUnit\)/);
  });

  it('and the editor that collects the lines says the COD is not its business', () => {
    const editor = repoFile('src/components/orders/ProductLinesEditor.tsx');
    expect(editor).toMatch(/Neither of them\s+\* computes the order's money/);
    // The figure it does show is labelled as the goods, not as the COD.
    expect(stripComments(editor)).toMatch(/قيمة البضاعة/);
  });
});

describe('Ⅲ · days in transit — held', () => {
  it('the screen renders the API’s figure and its late flag, and derives neither', () => {
    const screen = stripComments(repoFile('src/components/screens/TrackingScreen.tsx'));
    expect(screen).toMatch(/daysInTransit: number \| null;/);
    expect(screen).toMatch(/\{o\.daysInTransit \?\? '—'\}/);
    // No date arithmetic at all: the row carries no shippedAt to subtract.
    expect(screen).not.toMatch(/shippedAt/);
    expect(screen).not.toMatch(/getTime\(\)/);
    const route = stripComments(repoFile('src/app/api/ops/tracking/route.ts'));
    expect(route).toMatch(/daysInTransit: transit\.days/);
    expect(route).toMatch(/late: transit\.late/);
  });

  it('and the lateness THRESHOLD is the region’s, applied server-side', () => {
    // «late» against a per-region threshold is the figure; a screen holding
    // its own number of days would make «متأخرة» mean two things.
    const screen = stripComments(repoFile('src/components/screens/TrackingScreen.tsx'));
    /*
     * `| null` SINCE 2026-10-07, and the null is the point of the change.
     *
     * The route read the threshold as `?? 0`, so «no fee row for this
     * courier and region» and «a row saying zero» arrived as the same
     * number, and the cell's `> 0` condition printed a blank for both. The
     * row now carries `null` for the unpriced lane and the screen says
     * which of the two it is. The assertion follows the type rather than
     * being relaxed: a plain `number` here would mean the collapse is back.
     */
    expect(screen).toMatch(/lateThresholdDays: number \| null;/);
    expect(screen).toMatch(/late: boolean;/);
  });
});

describe('Ⅲ · SLA remaining — held, and mostly not built', () => {
  it('nothing in the tree counts down a deadline in a browser', () => {
    /*
     * There is no SLA clock on any screen. What exists is a DUE DATE and a
     * days-remaining figure, and the API computes it:
     * `/api/confirmation/postponed` ships `daysRemaining`, and the
     * postponed screen prints it. The change-request queue and the jobs
     * screen each take a boolean `overdue` rather than a date to compare.
     *
     * So the honest verdict is: held, and thin. «SLA remaining» as a
     * contract figure barely exists in this system, and the one screen that
     * shows a remaining count takes it from the endpoint.
     */
    const route = stripComments(repoFile('src/app/api/confirmation/postponed/route.ts'));
    // 21/10: the figure moved out of the route into `daysRemainingOf`, because the list's
    // «متأخر» filter and the «المتبقي» column it cuts by must read ONE definition of a day.
    // It is still the SERVER that computes it — a ceil, in a server-safe module the screen
    // imports only for labels.
    expect(route).toMatch(/const daysRemaining = daysRemainingOf\(due, now\)/);
    expect(stripComments(repoFile('src/lib/postponed-filters.ts'))).toMatch(/Math\.ceil\(\(new Date\(due\)\.getTime\(\) - now\.getTime\(\)\) \/ DAY\)/);
    for (const screen of [
      'src/components/screens/ChangeRequestsScreen.tsx',
      'src/components/screens/JobsScreen.tsx',
    ]) {
      // A boolean, so the threshold cannot be a second copy.
      expect(stripComments(repoFile(screen)), screen).toMatch(/overdue: boolean;/);
    }
  });

  it('and the one ticking clock in the tree is a clock, with its reason beside it', () => {
    /*
     * `ui/Elapsed.tsx` recomputes elapsed minutes in the browser on a
     * thirty-second interval, deliberately: «منذ ٣ دقائق» that was true at
     * page load and still says three minutes an hour later is worse than no
     * number. It corrects for the skew between the browser's clock and the
     * server's, and its two callers are a shift chip and «بانتظار أول
     * اتصال منذ …» — a duration, not an SLA, and no threshold is applied to
     * it anywhere.
     *
     * Asserted by behaviour, not by line, because another hand is in that
     * file: `useElapsedMinutes` takes a server `now` at all, which is the
     * property that makes it a clock rather than a judgement.
     */
    const elapsed = repoFile('src/components/ui/Elapsed.tsx');
    expect(elapsed).toMatch(/serverNow/);
    expect(elapsed).toMatch(/skew/);
  });
});

describe('Ⅲ · commission — held, and this closes a hole another guard leaves open', () => {
  it('no component multiplies a rate by a price — which `commission-one-source` does not check', () => {
    /*
     * `commission-one-source.test.ts` forbids `commissionRate` arithmetic
     * anywhere in `src/` — and then excludes `components/` from the check
     * with `!path.startsWith('components/')`. A screen could therefore have
     * multiplied `user.commissionRate` by a price and no guard in this
     * repository would have said a word, which is precisely how the second
     * commission engine survived as long as it did.
     *
     * Measured on 2026-10-02: `commissionRate` does not appear in any
     * `.tsx` file under `src/components` or `src/app` at all. Pinned here
     * so the exclusion over there stops being a blind spot.
     */
    const mentions: string[] = [];
    for (const root of ROOTS) {
      for (const p of tsxUnder(join(process.cwd(), root))) {
        if (/commissionRate/.test(stripComments(readFileSync(p, 'utf8')))) mentions.push(rel(p));
      }
    }
    expect(mentions, `شاشةٌ تلمس commissionRate:\n${mentions.join('\n')}`).toEqual([]);
  });

  it('and what a screen shows is the ledger’s figure, handed over whole', () => {
    const modal = stripComments(repoFile('src/components/orders/OrderDetailModal.tsx'));
    expect(modal).toMatch(/money\(order\.commission \?\? 0\)/);
    // The payout dialog reads what is owed; it does not work out what is owed.
    const payout = stripComments(repoFile('src/components/screens/commission/PayoutDialog.tsx'));
    expect(payout).toMatch(/apiJson<\{ owed: Owed\[\]; wallets: Wallet\[\] \}>/);
    // Its one multiplication is the MANUAL exchange rate the contract
    // requires a person to type, previewed before it is sent — and it is
    // sent, so the server converts with the same number.
    expect(payout).toMatch(/row\.amount \* numericRate/);
    expect(payout).toMatch(/exchangeRate: sameCurrency \? 1 : numericRate/);
  });
});

describe('Ⅲ · profit — held', () => {
  it('the dashboard prints the figure and its margin exactly as sent', () => {
    const dash = stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
    expect(dash).toMatch(/value=\{profitStated \? fmt\(fin\.netProfit\) : '—'\}/);
    expect(dash).toMatch(/\$\{t\.profitMargin\} \$\{fin\.profitMargin\}%/);
    // And no screen subtracts a cost from a revenue to get there.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const p of tsxUnder(join(process.cwd(), root))) {
        const src = stripComments(readFileSync(p, 'utf8'));
        if (/revenue\s*[-]\s*|[-]\s*(?:\w+\.)?(?:estimatedCostOfGoods|costOfGoods)\b/.test(src)) {
          offenders.push(rel(p));
        }
      }
    }
    expect(offenders, `شاشةٌ تطرح كلفةً من إيراد:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and the screen refuses to say it at all when the cost behind it is not recorded', () => {
    // Not a frontend-contract clause, but the reason the figure is single:
    // the gate is a server-sent trust level, so the dashboard cannot decide
    // to print an unfounded margin on its own.
    const dash = stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
    expect(dash).toMatch(/const profitStated = costTrust \? costTrust\.level !== 'WITHHELD' : false;/);
  });
});

describe('Ⅲ · delivery rate — held everywhere', () => {
  it('every screen that shows one renders a rate the server measured', () => {
    const cases: [string, RegExp][] = [
      ['src/components/screens/DashboardScreen.tsx', /value=\{`\$\{rates\.deliveryRate\}%`\}/],
      ['src/components/performance/AttributionTable.tsx', /<Rate value=\{r\.deliveryRate\} \/>/],
      ['src/components/screens/CustomersScreen.tsx', /facts\.deliveryRate === null \? '—' : `\$\{facts\.deliveryRate\}%`/],
      ['src/components/screens/CampaignsScreen.tsx', /c\.funnel\.deliveryRate !== null && ` \(\$\{c\.funnel\.deliveryRate\}%\)`/],
    ];
    for (const [file, shape] of cases) expect(stripComments(repoFile(file)), file).toMatch(shape);
  });

  it('and no screen divides a delivered count by a confirmed count', () => {
    // The rate's denominator is a policy — confirmed, or decided, or
    // created — and a screen choosing one makes a second rate under the
    // same word. `commission-one-source` makes the same argument about
    // which column says DELIVERED.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const p of tsxUnder(join(process.cwd(), root))) {
        const src = stripComments(readFileSync(p, 'utf8'));
        if (/\bdelivered\s*\/\s*|\/\s*(?:\w+\.)?confirmed\b/.test(src)) offenders.push(rel(p));
      }
    }
    expect(offenders, `شاشةٌ تحسب نسبة التسليم:\n${offenders.join('\n')}`).toEqual([]);
  });
});

describe('Ⅲ · risk tier — held', () => {
  it('the thresholds live in `customer-risk.ts` and no screen carries a copy', () => {
    const risk = stripComments(repoFile('src/lib/customer-risk.ts'));
    expect(risk).toMatch(/if \(returnRate > 0\.4 && orders >= 3\) return 'HIGH';/);
    expect(risk).toMatch(/if \(returnRate >= 0\.15\) return 'WATCH';/);

    // A screen with 0.15 or 0.4 in it beside a return rate is the second
    // copy. The sweep is for the NUMBERS, because the next copy will not be
    // called `riskTier`.
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const p of tsxUnder(join(process.cwd(), root))) {
        const src = stripComments(readFileSync(p, 'utf8'));
        if (!/returnRate|riskTier|\brisk\b/.test(src)) continue;
        if (/0\.15|0\.4\b|\b15\s*%|\b40\s*%/.test(src)) offenders.push(rel(p));
      }
    }
    expect(offenders, `شاشةٌ تحمل حدّ الخطر:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and a screen maps the tier to a word and a colour, which is all it does', () => {
    const panel = stripComments(repoFile('src/components/orders/ShapeRiskPanel.tsx'));
    expect(panel).toMatch(/import type \{ RiskTier \} from '@\/lib\/customer-risk';/);
    expect(panel).toMatch(/Record<Exclude<RiskTier, never>, HealthTone>/);
    // The consequences travel with the tier rather than being re-derived.
    const risk = stripComments(repoFile('src/lib/customer-risk.ts'));
    expect(risk).toMatch(/requiresPrepaymentOrApproval: tier === 'HIGH'/);
    expect(risk).toMatch(/excludedFromAutomatedConfirmation: tier === 'HIGH'/);
  });
});

describe('Ⅲ · the expected settlement amount — held where it is settled', () => {
  it('the matching queue renders the server’s expectation, never a product of the row', () => {
    const matching = stripComments(repoFile('src/components/screens/finance/MatchingScreen.tsx'));
    expect(matching).toMatch(/expectedAmount: string \| number \| null;/);
    expect(matching).toMatch(/expectedFee: string \| number \| null;/);
    expect(matching).toMatch(/<Money value=\{num\(m\.expectedAmount\)!\} currency=\{currency\} \/>/);
  });

  it('and the collect dialog adds up figures rather than re-deriving the rule — with the scar', () => {
    /*
     * This dialog is the one place the divergence was already found and
     * fixed, and its comment is the plainest statement of the contract
     * sentence anywhere in the tree: «This used to be `totalAmount −
     * deliveryFee`, computed here… so every partial read as a shortfall,
     * and the person collecting saw a number accusing a rep of keeping
     * money he never received. Worse, the server applied the correct rule,
     * so the two disagreed and the difference was recorded as an
     * overpayment.»
     *
     * The scar is pinned because it is the argument. Delete it and the next
     * reader re-derives the rule to save a field.
     */
    const dialog = repoFile('src/components/screens/tracking/CollectDialog.tsx');
    expect(dialog).toMatch(/This used to be `totalAmount − deliveryFee`, computed here/);
    expect(dialog).toMatch(/Adding up figures the server sent is not the same as re-deriving its\s+\*\s+rule/);
    const src = stripComments(dialog);
    expect(src).toMatch(/sum \+ Number\(o\.expectedCollection \?\? 0\)/);
    expect(src).toMatch(/\{Number\(o\.expectedCollection \?\? 0\)\}/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Ⅳ · THE FOUR DIVERGENCES — pinned as they are, and MEASURED.

   «A number that exists in two places will diverge» is pinned here as
   arithmetic rather than as a warning: each of the first three calls the
   server's own function and the screen's formula on the same input and
   shows the two answers are different numbers. A divergence that can be
   demonstrated does not need to be argued about.

   NONE OF THESE IS FIXED HERE. Reported, with what the endpoint already
   sends, for the owner to rule on.
   ════════════════════════════════════════════════════════════════════════ */

describe('Ⅳ · 1 — the tracking screen’s «صافي» is not the settlement expectation', () => {
  const SCREEN = 'src/components/screens/TrackingScreen.tsx';

  it('reads the server’s figure, and no longer derives one', () => {
    const src = stripComments(repoFile(SCREEN));
    expect(src).toMatch(
      /const netOfChosen = chosen\.reduce\(\(sum, o\) => sum \+ Number\(o\.expectedCollection \?\? 0\), 0\);/
    );
    // The formula that was here must not come back, in either direction.
    expect(src).not.toMatch(/Number\(o\.totalAmount\) - Number\(o\.deliveryFee/);
    // And it is still shown to the operator as «صافي», on the bar that
    // opens the collect dialog — the same place, a different number.
    expect(src).toMatch(/مختار \$\{chosen\.length\} طلب · صافي \$\{netOfChosen\}/);
  });

  it('and the row type declares it, which is why nobody saw it for so long', () => {
    const route = stripComments(repoFile('src/app/api/ops/tracking/route.ts'));
    expect(route).toMatch(/expectedCollection: expectedAmountFor\(order, country\.minorUnit\)/);
    // The route always sent it. The screen's own `Row` did not declare it,
    // so the figure was on the wire and invisible in the editor.
    const src = stripComments(repoFile(SCREEN));
    expect(src).toMatch(/expectedCollection\?: number \| null;/);
  });

  it('and the two numbers already disagree today, on a partial delivery', () => {
    /*
     * `canCollect` is `['DELIVERED','PARTIALLY_DELIVERED'].includes(...)`,
     * so a partially delivered order is selectable on this bar. For one
     * where 23 of a 40 order was taken and the fee is 3:
     */
    const order = {
      shippingStatus: 'PARTIALLY_DELIVERED', totalAmount: 40, collectedAmount: 23, deliveryFee: 3,
      priceIncludesDelivery: false, addOns: [], returnReceipt: null,
      items: [{ quantity: 2, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 40, deliveredQty: 1 }],
    };
    const server = expectedAmountFor(order, 3);
    const screen = Number(order.totalAmount) - Number(order.deliveryFee);
    expect(server).toBe(20);
    expect(screen).toBe(37);
    expect(screen).not.toBe(server);
    // The operator reads 37 on the bar, presses «استلام», and the dialog
    // beside it reads 20 — the same courier, the same selection, seconds
    // apart. The gap is the goods the customer refused.
  });

  it('and on a return the screen invents an amount out of nothing', () => {
    const order = {
      shippingStatus: 'RETURNED', totalAmount: 40, deliveryFee: 3, collectedAmount: null,
      priceIncludesDelivery: false, addOns: [], returnReceipt: null,
      items: [{ quantity: 2, freeQuantity: 0, unitPrice: 20, discountShare: 0, lineTotal: 40, deliveredQty: null }],
    };
    expect(expectedAmountFor(order, 3)).toBe(0);
    expect(Number(order.totalAmount) - Number(order.deliveryFee)).toBe(37);
  });

  it('and the global three-decimal rounding went with it', () => {
    // «Decimal precision comes from the currency's minor unit. Never a
    // single global rounding rule.» — the money section. `toFixed(3)` was a
    // global rule on a screen where every row carries its own currency; the
    // server rounds by the minor unit before sending.
    const src = stripComments(repoFile(SCREEN));
    expect(src).toMatch(/currency: string;/);
    expect(src).not.toMatch(/\.toFixed\(3\)/);
  });
});

describe('Ⅳ · 2 — the deliver dialog asks the door, and computes nothing', () => {
  const DIALOG = 'src/components/screens/tracking/DeliverDialog.tsx';
  const DOOR = 'src/app/api/ops/tracking/deliver/route.ts';

  /**
   * THIS SECTION USED TO BE A REPORT. It named four rules the browser had
   * transcribed — the per-unit discount, the delivered value, the
   * partial-delivery fee, and the COD branch — pinned them as they stood,
   * and measured where they had already drifted from the server. Ⅳ reports
   * rather than fixes, and its closing line was that the remedy «is the
   * endpoint's change, not this file's».
   *
   * The endpoint changed. The four rules are gone from the browser and the
   * section is the record of the remedy instead, with the gaps kept as
   * arithmetic so nobody has to take the reason on trust.
   */
  it('none of the four rules is written in the browser any more', () => {
    const src = stripComments(repoFile(DIALOG));
    // The allocation rule, spread back over units.
    expect(src).not.toMatch(/discountPerUnit/);
    expect(src).not.toMatch(/Number\(l\.discountShare\)/);
    // The delivered value.
    expect(src).not.toMatch(/Number\(l\.unitPrice\)/);
    // The partial-delivery fee rule.
    expect(src).not.toMatch(/anyTaken \? fee : 0/);
    // The COD branch — the shape nets in Ⅱ hold this one globally now.
    expect(src).not.toMatch(/priceIncludesDelivery \? /);
  });

  it('and it asks the door for the figures instead, writing nothing', () => {
    const src = stripComments(repoFile(DIALOG));
    expect(src).toMatch(/preview: true as const/);
    expect(src).toMatch(/'\/api\/ops\/tracking\/deliver'/);
    // What it prints is what came back, and a dash before it does.
    expect(src).toMatch(/figure\(money\?\.goods\)/);
    expect(src).toMatch(/figure\(money\?\.fee\)/);
    expect(src).toMatch(/figure\(money\?\.collected\)/);
  });

  it('and the door prices a preview with the SAME function it settles with', () => {
    /*
     * A preview computed by a second expression would be this defect again
     * with the copy moved one file to the left. The route calls
     * `doorMoney` — the function `partial-delivery.ts` calls on the write
     * path, which is the function the settlement matcher itself calls.
     */
    const door = stripComments(repoFile(DOOR));
    expect(door).toMatch(/import \{ doorMoney \} from '@\/lib\/settlement'/);
    expect(door).toMatch(/const money = doorMoney\(/);
    // And it answers before the transaction, so nothing is written.
    const at = door.indexOf('doorMoney(');
    const tx = door.indexOf('db.$transaction');
    expect(at).toBeGreaterThan(0);
    expect(tx).toBeGreaterThan(at);
  });

  it('and the server’s own copy of those four is still GONE', () => {
    /*
     * `partial-delivery.ts` used to hold the original, line for line. On
     * 2026-10-02 the server's copy went: the door calls `doorMoney` in
     * `settlement.ts`, the same function the settlement matcher calls, so
     * the figure on the door's screen and the figure the matcher demands
     * cannot disagree. Two copies pinned to each other is what let the
     * add-on money go missing from both at once.
     */
    const door = stripComments(repoFile('src/lib/partial-delivery.ts'));
    expect(door).toMatch(/const money = doorMoney\(/);
    expect(door).not.toMatch(/deliveredValue \+=/);
    expect(door).not.toMatch(/const discountPerUnit =/);

    const rule = stripComments(repoFile('src/lib/settlement.ts'));
    expect(rule).toMatch(/return Number\(item\.lineTotal\) \/ item\.quantity;/);
    /*
     * And the fils-losing reconstruction is pinned ABSENT, not merely
     * unused. A fallback reading `quantity × unitPrice − discountShare`
     * stood here for a day: `unitPrice` is `Decimal(12,2)` and the dinar
     * has three places, so that branch returned 9.990 where the order says
     * 10.000.
     */
    expect(rule).not.toMatch(/Number\(item\.unitPrice\) - Number\(item\.discountShare\)/);
    expect(rule).toMatch(/const paid = Math\.min\(taken, item\.quantity\);/);
    expect(rule).toMatch(/deliveryFee: anythingTaken \? fee : 0,/);
    expect(rule).toMatch(/priceIncludesDelivery: order\.priceIncludesDelivery,/);
  });

  it('and the gaps that are now closed, kept as arithmetic rather than as a memory', () => {
    /*
     * MEASURED by running the real `doorMoney` against the dialog's own
     * former expression, before either was touched:
     *
     *   an order carrying a thank-you-page upsell   door 29.5   screen 24.5
     *   the same, one of two units refused          door 18.5   screen 13.5
     *   Syrian pounds, whole units                  door 21     screen 21.333…
     *
     * THE UPSELL is the one that mattered. `OrderAddOn` has no `OrderItem`
     * row, so a loop over `items` could not see it however carefully it was
     * written — the courier was told to collect five dinars less than the
     * door records, and no amount of correcting the copy would have found
     * it. That is the argument for one rule rather than two right ones.
     */
    const upsell = 5;
    const screenOnUpsold = 2 * 11 + 2.5;
    expect(screenOnUpsold).toBe(24.5);
    expect(screenOnUpsold + upsell).toBe(29.5);

    // And the rounding: a currency with no minor unit cannot hold a third.
    expect(roundMinor(21.333333333333332, 0)).toBe(21);
    expect(roundMinor(21.333333333333332, 3)).not.toBe(21);
  });

  it('and a negative «قيمة ما استُلم» cannot be printed, because the browser no longer sums', () => {
    /*
     * `partial-delivery.ts` clamps with `Math.max(0, …)`. The dialog had
     * neither that nor the rounding, so a line whose stored discount share
     * exceeds its own value — which `allocateDiscount` can produce after an
     * edit — gave the screen a NEGATIVE figure where the server shows zero.
     * The arithmetic is kept; the place that could produce it is gone.
     */
    const line = { quantity: 2, unitPrice: 10, discountShare: 30 };
    const wouldHaveBeen = line.quantity * (line.unitPrice - line.discountShare / line.quantity);
    expect(wouldHaveBeen).toBe(-10);
    expect(roundMinor(Math.max(0, wouldHaveBeen), 3)).toBe(0);
    expect(stripComments(repoFile(DIALOG))).not.toMatch(/\.reduce\(/);
  });
});

describe('Ⅳ · 3 — the stock screen recovers «محجوز» by subtraction', () => {
  const SCREEN = 'src/components/screens/InventoryBalancesScreen.tsx';

  it('reads the figure, and no longer recovers it by subtraction', () => {
    const src = stripComments(repoFile(SCREEN));
    expect(src).toMatch(/value=\{s\.reserved\}/);
    expect(src).not.toMatch(/s\.remaining - h\.available/);
    // And the row type declares it, so there is nothing left to recover.
    const type = src.slice(src.indexOf('interface StockRow {'));
    expect(type.slice(0, type.indexOf('}'))).toMatch(/reserved: number;/);
  });

  it('and the server sends the figure it always knew exactly', () => {
    const route = stripComments(repoFile('src/app/api/inventory/route.ts'));
    // It was computed, named and passed into the verdict all along…
    expect(route).toMatch(/reservedElsewhere\(db, companyId, p\.id, undefined, storeId\)/);
    expect(route).toMatch(/reserved: reserved\.get\(p\.id\) \?\? 0,/);
    // …and now it is on the response row too, which was the one-line fix.
    const payload = route.slice(route.indexOf('      return {\n        id: p.id,'));
    const body = payload.slice(0, payload.indexOf('\n      };'));
    expect(body).toMatch(/remaining,/);
    expect(body).toMatch(/health: stockHealth\(facts, MAX_WINDOW_DAYS\)/);
    expect(body).toMatch(/reserved: reserved\.get\(p\.id\) \?\? 0,/);
    /*
     * `StockHealth` still publishes `available` and keeps `reserved` to
     * itself, and that stays right: the verdict's inputs are the verdict's
     * business. What was wrong was the ROW withholding a figure the screen
     * had to show — so the fix belonged on the row, not on the verdict.
     */
    const health = stripComments(repoFile('src/lib/stock-health.ts'));
    const iface = health.slice(health.indexOf('export interface StockHealth extends Health {'));
    expect(iface.slice(0, iface.indexOf('\n}'))).not.toMatch(/reserved/);
  });

  it('and the identity it rests on is an accident of today’s route', () => {
    /*
     * `remaining - available === reserved` holds only while the row's
     * `remaining` is the very same sum the route passed in as
     * `facts.onHand`. It is today — one expression, used twice. The moment
     * `available` is scoped to a warehouse while `remaining` stays
     * store-wide, or either gains a filter the other does not, the screen
     * prints a «محجوز» that no query would return, under a hint that reads
     * «موعودٌ به لطلبات مفتوحة — لا يُوعَد به مرّتين».
     */
    const facts: StockFacts = {
      onHand: 8,
      reserved: 5,
      batchCount: 1,
      deliveredUnits: 40,
      deliveredLines: 9,
      ledgerDays: 60,
      daysSinceLastSale: 1,
      daysStocked: 60,
    };
    const health = stockHealth(facts);
    expect(health.available).toBe(3);
    // Same scope — the screen is right by luck.
    expect(facts.onHand - health.available).toBe(facts.reserved);
    // A `remaining` from any other scope — here a second warehouse's four
    // units in the same store — and the screen is simply wrong.
    const remainingStoreWide = 12;
    expect(remainingStoreWide - health.available).toBe(9);
    expect(remainingStoreWide - health.available).not.toBe(facts.reserved);
  });

  it('and the screen’s own header claims it decides nothing, which makes this the sharper miss', () => {
    // «NOT ONE WORD OF THE VERDICT IS DECIDED HERE… this file renders what
    // it is handed and sorts by it.» True of the verdict. Not true of the
    // third tile on every card.
    expect(repoFile(SCREEN)).toMatch(/NOT ONE WORD OF THE VERDICT IS DECIDED HERE/);
  });
});

describe('Ⅳ · 4 — the batch-cost dialog reimplements the two functions beside it', () => {
  const DIALOG = 'src/components/production/BatchCostDialog.tsx';

  it('calls the two shared functions, and no longer rolls its own', () => {
    const src = stripComments(repoFile(DIALOG));
    expect(src).toMatch(/const \{ total \} = batchTotal\(\{ \.\.\.buckets, costLines: lines \}\);/);
    expect(src).toMatch(/const perUnit = batchUnitCost\(total, batch\.quantityProduced\);/);
    // Neither hand-rolled half may come back.
    expect(src).not.toMatch(/Object\.values\(buckets\)\.reduce/);
    expect(src).not.toMatch(/total \/ batch\.quantityProduced/);
  });

  it('and its sibling dialog on the same screen calls the shared functions', () => {
    /*
     * THE SAME FAILURE AS Ⅳ·1, TWICE IN ONE AUDIT: the fix landed on one of
     * a pair of sibling surfaces. `ManufacturingScreen` — the form that
     * CREATES a batch — was corrected, and its comment records the exact
     * defect: «This used to add the buckets and the lines here and divide
     * to two places, while the server records four — so the unit cost
     * somebody watched while typing could differ from the one written
     * down.» `BatchCostDialog` — the form that EDITS the same two figures
     * on an existing batch — still does it the old way.
     */
    const screen = repoFile('src/components/screens/ManufacturingScreen.tsx');
    expect(screen).toMatch(/THE FIGURE ON SCREEN IS THE FIGURE THAT WILL BE STORED/);
    expect(screen).toMatch(/The same\s+\*\s+two functions now, which are pure and import only types\./);
    const src = stripComments(screen);
    expect(src).toMatch(/import \{ batchTotal, batchUnitCost \} from '@\/lib\/product-cost';/);
    expect(src).toMatch(/const \{ total: totalProductionCost \} = batchTotal\(\{/);
    expect(src).toMatch(/batchUnitCost\(totalProductionCost, quantityProduced\)/);
    // And the server records with the same two.
    for (const route of ['src/app/api/production/route.ts', 'src/app/api/production/[id]/route.ts']) {
      expect(stripComments(repoFile(route)), route).toMatch(
        /import \{ batchTotal, batchUnitCost \} from '@\/lib\/product-cost';/
      );
    }
  });

  it('and the two already give different numbers, to four places', () => {
    // `batchUnitCost` rounds to four, as the column stores it. The dialog
    // does not round at all.
    expect(batchUnitCost(10, 3)).toBe(3.3333);
    expect(10 / 3).not.toBe(batchUnitCost(10, 3));
    // And the total: the shared function rounds the sum, the dialog adds
    // raw floats.
    expect(batchTotal({ manufacturingCost: 0.1, packagingCost: 0.2 }).total).toBe(0.3);
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('and the drift decides whether a chip appears, which is how a user meets it', () => {
    /*
     * The dialog compares its own unrounded `perUnit` against the server's
     * stored four-place `costPerUnit` and shows «(كانت …)» when they differ
     * by more than half a thousandth. The comparison is between a rounded
     * number and an unrounded one, so the chip is a function of float
     * noise rather than of anything the user changed.
     */
    const src = stripComments(repoFile(DIALOG));
    expect(src).toMatch(/batch\.costPerUnit > 0 && Math\.abs\(perUnit - batch\.costPerUnit\) > 0\.005/);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   Ⅴ · WHAT THIS SECTION COULD NOT CHECK, AND THE MEASURED NEAR-MISSES.

   An unstated limit reads as a clean bill of health.
   ════════════════════════════════════════════════════════════════════════ */

describe('Ⅴ · the edges of the sentence, stated rather than implied', () => {
  it('«the UI computes nothing the backend already computes» has no closed subject', () => {
    /*
     * The second clause is a list of eleven and is checkable. The FIRST
     * clause — «nothing the backend already computes» — is not: deciding it
     * mechanically would mean knowing, for every expression in 312 files,
     * whether some endpoint anywhere also produces that number. Ⅳ·4 is a
     * case where the first clause bites and the list does not: a batch's
     * unit cost is not one of the eleven, and `batchUnitCost` is plainly
     * something the backend computes.
     *
     * Four figures measured in the tree fall OUTSIDE both: a rate nobody
     * on the server produces, derived in a screen from two counts it was
     * sent. They are not defects under this contract and they are written
     * down because the next reader will find them and wonder:
     *
     *   · `DashboardScreen` — the rejection rate, `rejected / decided ×
     *     100`. The endpoint sends the confirmation, delivery and return
     *     rates and not this one.
     *   · `ChannelsScreen` — each channel's share of the order count.
     *   · `ConfirmationMineScreen` — minutes between the claim and the
     *     first call, from two server timestamps.
     *   · `ClosingScreen` — the typed count minus the book balance, which
     *     is an input echo by definition: the server has never seen the
     *     number being typed.
     *
     * Pinned as present, so that if the backend ever DOES start sending one
     * of them this test fails and the screen is made to read it.
     */
    const dash = stripComments(repoFile('src/components/screens/DashboardScreen.tsx'));
    expect(dash).toMatch(/counts\.rejected \/ \(counts\.decided \?\? counts\.total\)/);
    const rates = stripComments(repoFile('src/app/api/analytics/route.ts'));
    expect(rates).not.toMatch(/rejectionRate/);
  });

  it('and a figure that is only ever a sentence cannot be checked as a number', () => {
    /*
     * «SLA remaining» is the thinnest of the eleven: nothing in this system
     * holds an SLA. The verdict in Ⅲ is therefore «held because nothing
     * computes it», which is a weaker statement than the other six and is
     * marked as such rather than counted as a pass.
     *
     * The one thing checkable is the shape that would introduce it — a
     * screen comparing a server date against the browser's clock to decide
     * whether something is late. There is none: every «late» and «overdue»
     * on every screen is a boolean the API sent.
     */
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const p of tsxUnder(join(process.cwd(), root))) {
        const src = stripComments(readFileSync(p, 'utf8'));
        if (!/\b(?:late|overdue|sla)\b/i.test(src)) continue;
        // A deadline compared against now, rather than a flag rendered.
        if (/(?:late|overdue|due|deadline)\w*\s*[<>]=?\s*(?:Date\.now\(\)|new Date\(\))/i.test(src)) {
          offenders.push(rel(p));
        }
        if (/(?:Date\.now\(\)|new Date\(\))\s*[<>]=?\s*[\w.]*(?:due|deadline|sla)/i.test(src)) {
          offenders.push(rel(p));
        }
      }
    }
    expect(offenders, `شاشةٌ تحكم بالتأخّر من ساعة المتصفّح:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('and «extend the endpoint» is a remedy this codebase has already proved', () => {
    // The contract's instruction when a figure is missing is to extend the
    // response, not to compute it. Three doors in this tree did exactly
    // that, and they are the precedent for the four in Ⅳ: the storefront's
    // `/quote`, the order route's `cod` block, and the tracking route's
    // `expectedCollection`.
    expect(stripComments(repoFile('src/app/api/public/stores/[store]/quote/route.ts'))).toMatch(/computeCod\(/);
    expect(stripComments(repoFile('src/app/api/orders/[id]/route.ts'))).toMatch(/cod: \{ \.\.\.cod,/);
    expect(stripComments(repoFile('src/app/api/ops/tracking/route.ts'))).toMatch(/expectedCollection:/);
  });
});
