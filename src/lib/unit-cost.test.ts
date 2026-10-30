import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import {
  MIN_ZERO_COST_REASON,
  NO_COST_CODE,
  resolveUnitCost,
  ZERO_COST_CODE,
} from './unit-cost';

/**
 * A BLANK PRICE IS NOT A PRICE OF ZERO.
 *
 * For a purchased product the batch's `costPerUnit` is the ONLY place its
 * cost is recorded — the product row carries `basePrice`, which is what we
 * sell it for. And the cost of a sold unit is read at the moment it sells,
 * so a batch that enters at zero reports every unit out of it as pure
 * profit, for ever, with no later correction possible.
 *
 * Three doors open a batch and they did not agree. The opening count refused
 * a bare zero. The recount carried the previous cost forward — and wrote
 * zero when there was none. Receiving purchased goods called the field
 * «(اختياري)», and both the screen and the schema turned an empty box into a
 * zero without a word.
 *
 * Measured before changing anything: zero of 108 batches actually carry a
 * zero unit cost, so nobody has fallen in yet. The hole is real; the damage
 * is not, and saying otherwise would be inventing evidence for a fix that
 * does not need it.
 */

const inventory = () => stripComments(repoFile('src/app/api/inventory/route.ts'));
const screen = () => stripComments(repoFile('src/components/inventory/ReceiveDialog.tsx'));
const opening = () => stripComments(repoFile('src/lib/stock-opening-count.ts'));

describe('what a batch enters at', () => {
  it('a typed price is the price', () => {
    const v = resolveUnitCost({ given: 7.5, previous: 3 });
    expect(v.ok && v.unitCost).toBe(7.5);
    expect(v.ok && v.source).toBe('TYPED');
  });

  /**
   * A delivery of the same thing at an unstated price is far likelier to have
   * cost what the last one cost than to have been free. This is what the
   * recount door already did, and it is right.
   */
  it('a blank carries the previous cost forward, and says so', () => {
    const v = resolveUnitCost({ given: undefined, previous: 4.25 });
    expect(v.ok && v.unitCost).toBe(4.25);
    expect(v.ok && v.source).toBe('CARRIED');
    expect(resolveUnitCost({ given: null, previous: 4.25 }).ok).toBe(true);
  });

  /** Nothing to carry, nothing to guess — and a zero here is the silent one. */
  it('a blank with no previous cost is refused, not defaulted to zero', () => {
    const v = resolveUnitCost({ given: undefined, previous: null });
    expect(v.ok, 'الفراغ صار صفراً بصمت').toBe(false);
    if (!v.ok) expect(v.code).toBe(NO_COST_CODE);
    // A previous batch that itself cost zero is no basis either.
    expect(resolveUnitCost({ given: undefined, previous: 0 }).ok).toBe(false);
  });

  /** A free sample is real, so the door is not shut: it asks for a sentence. */
  it('a typed zero needs a reason, and a keystroke is not one', () => {
    expect(resolveUnitCost({ given: 0, previous: 5 }).ok, 'صفرٌ بلا سبب').toBe(false);
    expect(resolveUnitCost({ given: 0, previous: 5, zeroCostReason: 'ok' }).ok).toBe(false);
    const v = resolveUnitCost({ given: 0, previous: 5, zeroCostReason: 'عيّنة مجّانية' });
    expect(v.ok).toBe(true);
    expect(v.ok && v.source).toBe('EXPLAINED_ZERO');
    expect(MIN_ZERO_COST_REASON).toBe(5);
  });

  it('and an explained zero does NOT silently become the previous cost', () => {
    const v = resolveUnitCost({ given: 0, previous: 9, zeroCostReason: 'هديّة من المورّد' });
    expect(v.ok && v.unitCost, 'تجاهل صفراً مقصوداً').toBe(0);
  });

  it('refuses a negative or a nonsense number', () => {
    expect(resolveUnitCost({ given: -1, previous: 5 }).ok).toBe(false);
    expect(resolveUnitCost({ given: NaN, previous: 5 }).ok).toBe(false);
  });
});

describe('and all three doors use it', () => {
  /**
   * `.default(0)` is what made an empty field a price. The schema is where
   * that happened, before any rule could see it.
   */
  it('receiving no longer turns an empty field into a zero', () => {
    const src = inventory();
    // The rule, not the mechanism: the field may be ABSENT, and an absent
    // field must not arrive as a zero. (It reads through the strict
    // numeric helper now — which also refuses `null` and `""`, the other
    // two ways a blank used to become nothing.)
    expect(src, 'المخطّط ما زال يُحوّل الفراغ إلى صفر').not.toMatch(
      /unitCost:[^\n]*\.default\(0\)/
    );
    expect(src).toMatch(/unitCost:[^\n]*\.optional\(\)/);
    expect(src).toContain('zeroCostReason');
  });

  it('and prices the delivery through the shared rule before writing it', () => {
    const src = inventory();
    expect(src).toMatch(/const priced = resolveUnitCost\(\{/);
    expect(src, 'يكتب ما أُرسل دون المرور بالقاعدة').toMatch(/if \(!priced\.ok\) \{/);
    expect(src).toContain('unitCost: priced.unitCost');
  });

  /** A surplus of something never costed is a delivery nobody recorded. */
  it('the recount stops instead of entering a surplus at zero', () => {
    const src = inventory();
    expect(src, 'ما زال يسقط إلى صفر').not.toContain('unitCost: existing?.costPerUnit ?? 0');
    expect(src).toMatch(/if \(!carried\.ok\) \{/);
    expect(src).toContain('UncostedSurplus');
    // And it answers rather than five-hundreding.
    expect(src).toMatch(/if \(error instanceof UncostedSurplus\) \{/);
  });

  it('the opening count reads the same rule rather than its own copy', () => {
    const src = opening();
    expect(src).toContain('resolveUnitCost({');
    expect(src, 'نسخةٌ ثانيةٌ من القاعدة').not.toMatch(
      /line\.zeroCostReason\?\.trim\(\)\.length \?\? 0\) < 5/
    );
  });

  /** One rule, one wording — two spellings of it is two rules again. */
  it('and the sentence is written once', () => {
    const lib = stripComments(repoFile('src/lib/unit-cost.ts'));
    expect(lib).toContain('ربحاً صافياً إلى الأبد');
    expect(opening(), 'الجملة منسوخة').not.toContain('ربحاً صافياً إلى الأبد');
  });
});

describe('and the screen tells the truth about the field', () => {
  it('stops calling it optional', () => {
    expect(screen(), 'ما زالت تقول «اختياري»').not.toContain('تكلفة الوحدة في هذه الدفعة (اختياري)');
  });

  /** The screen used to do the same substitution the schema did. */
  it('sends an empty field as empty, not as zero', () => {
    expect(screen(), 'الشاشة تُرسل صفراً عن خانةٍ فارغة').not.toContain("unitCost: unitCost ? Number(unitCost) : 0");
    expect(screen()).toContain("unitCost: unitCost === '' ? undefined : Number(unitCost)");
  });

  it('says which of the two a blank will do, from the product in hand', () => {
    const src = screen();
    expect(src).toMatch(/product\.lastUnitCost === null/);
    expect(src).toContain('لتدخل بكلفة آخر دفعة');
    expect(src).toContain('(مطلوبة)');
    // IN THE ROW, not merely computed above it. `lastUnitCost` is also the
    // name of the local that derives it, so looking for the word passed with
    // the property deleted from the object the screen actually reads.
    expect(inventory(), 'القائمة لا ترسل الكلفة السابقة في الصفّ').toMatch(
      /batchesCount: p\.batches\.length,[\s\S]{0,400}\.\.\.\(showCost\s*\?\s*\{\s*lastUnitCost,/
    );
  });

  it('and asks for the sentence when the price really is zero', () => {
    const src = screen();
    expect(src).toMatch(/unitCost\.trim\(\) === '0' &&/);
    expect(src).toContain('كلفتُها صفر — لماذا؟');
  });
});

/**
 * AND THE OTHER END OF THE SAME RULE: WHAT AN ORDER SAYS ITS GOODS COST.
 *
 * Cost is captured when stock arrives (above) and read when it sells (here),
 * and the reading was not one reading. Four doors raise an order:
 *
 *   `POST /orders` averaged the stock on hand — the policy `product-cost.ts`
 *     was written to settle on;
 *   the storefront wrote a literal `0`, with a comment promising that finance
 *     would finalise it later;
 *   the AI intake took the oldest batch still holding units — a different
 *     policy, quietly;
 *   the win-back and the region transfer copy the order they replace, which
 *     is right and is left alone.
 *
 * Measured before the change: 115 delivered orders, every one of them at zero
 * cost of goods, and `productCost` null on all 166 — finance finalised
 * nothing. Six of the zero-cost orders came through the storefront rather
 * than the import, and the storefront is the channel the launch runs on.
 */
describe('and every door that raises an order costs it the same way', () => {
  const publicOrder = () => stripComments(repoFile('src/lib/public-order.ts'));
  const aiIntake = () => stripComments(repoFile('src/app/api/orders/ai-intake/route.ts'));
  const direct = () => stripComments(repoFile('src/app/api/orders/route.ts'));

  it('the storefront no longer writes a literal zero', () => {
    const src = publicOrder();
    expect(src, 'واجهة المتجر ما زالت تكتب صفراً').not.toMatch(/const unitCost = 0;/);
    expect(src).toContain('productCost(db, companyId, line.product.id)).average');
  });

  /**
   * AND IT COSTS EVERY LINE, not the one the row happens to show.
   *
   * A basket's head is a display choice — the largest line, because an order
   * row has one cell for a product. Costing the head alone would understate
   * the goods on every order with more than one thing in it, which is every
   * order the cart exists to make possible.
   */
  it('and it costs the whole basket, not the head of it', () => {
    const src = publicOrder();
    expect(src).toMatch(/costOfGoods = lines\.reduce/);
    // THE VARIABLE, NOT THE EXPRESSION AROUND IT. This line used to pin
    // `Number(costOfGoods.toFixed(2))` whole, so changing the ROUNDING — a
    // different question, and one this test has no opinion on — broke a guard
    // about which LINES are costed. What it means is that the figure written
    // comes from the basket total.
    expect(src).toMatch(/estimatedCostOfGoods:[^\n]*costOfGoods/);
    expect(src, 'الكلفة تُقرأ من سطر واحد').not.toMatch(/estimatedCostOfGoods:[^\n]*head\./);
  });

  it('the AI intake stops picking a batch of its own', () => {
    const src = aiIntake();
    expect(src, 'ما زال يقرأ دفعةً بعينها').not.toContain('product.batches[0]?.costPerUnit');
    expect(src).toContain('productCost(db, companyId, product.id)).average');
  });

  it('and the direct door reads the same helper it always did', () => {
    expect(direct()).toContain('productCosts(');
    expect(direct()).toContain('.average');
  });

  /**
   * ONE POLICY. `average` is the blend; `nextOut` is the other honest number
   * and belongs to the draw-down, not to an estimate. A door reaching past
   * the helper into raw batch costs is the drift starting again.
   */
  it('and none of them reads a raw batch cost to estimate with', () => {
    for (const [name, src] of [['storefront', publicOrder()], ['ai-intake', aiIntake()], ['direct', direct()]] as const) {
      expect(src, `${name} يقرأ كلفة دفعةٍ خاماً`).not.toMatch(/batches\[0\]\??\.costPerUnit/);
    }
  });
});
