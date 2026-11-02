import { describe, expect, it } from 'vitest';
import { repoFile, stripComments } from './guard-source';
import {
  CUSTOMER_GRADES,
  DORMANT_DAYS,
  GRADE_AR,
  GRADE_RANK,
  GRADE_TONE,
  MIN_HISTORY,
  scoreCustomer,
  type CustomerHistory,
} from './customer-score';
import { HEALTH_TONES } from './health';

/**
 * IS THIS CUSTOMER WORTH SHIPPING TO?
 *
 * In a cash-on-delivery shop that is not a soft question: every parcel that
 * goes out and comes back costs the fee out, the fee back, and a fortnight
 * of a product in a van instead of on a shelf. A customer who refused four
 * of five and one who took eight of eight looked identical on every screen
 * in this product, and the agent ringing them had no way to tell.
 */

const DAY = 86_400_000;
const NOW = new Date('2026-09-27T09:00:00.000Z');
const ago = (d: number) => new Date(NOW.getTime() - d * DAY);

const who = (over: Partial<CustomerHistory> = {}): CustomerHistory => ({
  totalOrders: 10,
  deliveredOrders: 8,
  cancelledOrders: 2,
  totalPurchaseValue: 400,
  lastOrderDate: ago(10),
  ...over,
});

describe('what the grade is', () => {
  it('loyal when they take delivery and keep coming back', () => {
    const s = scoreCustomer(who(), NOW);
    expect(s.grade).toBe('loyal');
    expect(s.deliveryRate).toBe(80);
    expect(s.why, 'لا يقول كم استلم من كم').toContain('8');
  });

  it('good when the record is clean but short', () => {
    expect(scoreCustomer(who({ deliveredOrders: 3, cancelledOrders: 1 }), NOW).grade).toBe('good');
  });

  it('watch when a real share comes back', () => {
    const s = scoreCustomer(who({ deliveredOrders: 5, cancelledOrders: 4 }), NOW);
    expect(s.grade).toBe('watch');
    expect(s.why).toContain('4');
  });

  /** Every returned parcel is two fees and a fortnight of stock in a van. */
  it('risky when most of them come back, and says what that costs', () => {
    const s = scoreCustomer(who({ deliveredOrders: 2, cancelledOrders: 6 }), NOW);
    expect(s.grade).toBe('risky');
    expect(s.tone).toBe('bad');
    expect(s.why).toContain('أجرتَي');
  });

  /**
   * THREE ORDERS IS NOT A PATTERN.
   *
   * And «عميل جديد» is said plainly rather than dressed as a middling
   * grade: a reader who cannot tell «average» from «we do not know yet»
   * acts on the first and refuses a good customer their first parcel.
   */
  it('refuses to grade a customer with too little history', () => {
    const s = scoreCustomer(who({ deliveredOrders: 1, cancelledOrders: 1 }), NOW);
    expect(s.grade).toBe('new');
    expect(s.tone).toBe('unknown');
    expect(s.deliveryRate, 'أعطى نسبةً على طلبَين').toBeNull();
    expect(s.why).toContain(String(MIN_HISTORY));
  });

  it('and says so differently when they have ordered nothing at all', () => {
    const s = scoreCustomer(who({ totalOrders: 0, deliveredOrders: 0, cancelledOrders: 0, lastOrderDate: null }), NOW);
    expect(s.grade).toBe('new');
    expect(s.why).toContain('لا طلبَ محسوماً');
    expect(s.daysQuiet).toBeNull();
  });

  /**
   * AN ORDER STILL BEING CALLED IS NOT EVIDENCE.
   *
   * Counting it as «not delivered» would grade a customer down for the
   * length of our own queue.
   */
  it('judges decided orders, not everything in the pipeline', () => {
    const s = scoreCustomer(who({ totalOrders: 50, deliveredOrders: 8, cancelledOrders: 2 }), NOW);
    expect(s.deliveryRate, 'حُسبت على الطلبات كلّها لا على المحسومة').toBe(80);
    expect(s.grade).toBe('loyal');
  });
});

describe('and «وفيّ» is present tense', () => {
  /** An agent who reads «وفيّ» beside a name nobody has heard from in a year learns not to trust the word. */
  it('a good record gone quiet becomes one to look at, not one to rely on', () => {
    const s = scoreCustomer(who({ lastOrderDate: ago(DORMANT_DAYS + 1) }), NOW);
    expect(s.grade, 'ما زال «وفيّاً» بعد سنةٍ من الصمت').toBe('watch');
    expect(s.dormant).toBe(true);
    expect(s.why).toContain('آخر طلب');
    expect(s.daysQuiet).toBe(DORMANT_DAYS + 1);
  });

  it('but silence never rescues a bad record', () => {
    const s = scoreCustomer(
      who({ deliveredOrders: 1, cancelledOrders: 7, lastOrderDate: ago(DORMANT_DAYS + 1) }),
      NOW
    );
    expect(s.grade, 'الصمت رفَّع المخاطرة إلى «انتباه»').toBe('risky');
  });

  it('and a customer who ordered yesterday is not dormant', () => {
    expect(scoreCustomer(who({ lastOrderDate: ago(1) }), NOW).dormant).toBe(false);
  });
});

describe('the vocabulary is the one the rest of the product paints with', () => {
  it('every grade has a word and a tone from the shared set', () => {
    for (const g of CUSTOMER_GRADES) {
      expect(GRADE_AR[g], `${g} بلا ترجمة`).toBeTruthy();
      expect(HEALTH_TONES as readonly string[], `${g} بلون خارج المجموعة`).toContain(GRADE_TONE[g]);
      expect(GRADE_RANK[g], `${g} بلا ترتيب`).toBeTypeOf('number');
    }
  });

  it('and the risk sorts first, the unjudged last', () => {
    const order = [...CUSTOMER_GRADES].sort((a, b) => GRADE_RANK[a] - GRADE_RANK[b]);
    expect(order[0]).toBe('risky');
    expect(order.at(-1)).toBe('new');
  });
});

describe('nothing is stored, and the screen shows it', () => {
  /** A stored score was true in March; it goes stale the moment an order moves. */
  it('there is no score column to go stale', () => {
    const schema = stripComments(repoFile('prisma/schema.prisma'));
    const model = schema.slice(schema.indexOf('model Customer '), schema.indexOf('model Customer ') + 1400);
    expect(model, 'سكورٌ مخزَّنٌ على العميل').not.toMatch(/\n\s+(score|grade|rating)\s+/i);
    // The counters it is derived from are there instead.
    for (const f of ['deliveredOrders', 'cancelledOrders', 'totalPurchaseValue', 'lastOrderDate']) {
      expect(model, `${f} غير موجود`).toContain(f);
    }
  });

  it('and the list sends those counters so the screen can derive it', () => {
    const api = stripComments(repoFile('src/app/api/customers/route.ts'));
    const full = api.slice(api.indexOf('const FULL_CUSTOMER_SELECT'), api.indexOf('const BASIC_CUSTOMER_SELECT'));
    for (const f of ['deliveredOrders', 'cancelledOrders', 'totalPurchaseValue', 'lastOrderDate']) {
      expect(full, `${f} لا يُرسَل`).toContain(`${f}: true`);
    }
  });

  it('the card wears the grade, through the one chip', () => {
    const src = stripComments(repoFile('src/components/screens/CustomersScreen.tsx'));
    expect(src).toContain('<HealthChip');
    expect(src).toMatch(/scoreCustomer\(c, now\)/);
  });

  /** Two cards on one screen must not land on different sides of the dormancy line. */
  it('reading the clock once, not once per row', () => {
    const src = stripComments(repoFile('src/components/screens/CustomersScreen.tsx'));
    expect((src.match(/new Date\(\)/g) ?? []).length, 'الساعة تُقرأ داخل الصفوف').toBeLessThanOrEqual(1);
    expect(src).toContain('const now = new Date();');
  });

  /** What somebody opens this screen for is the customer who is a problem. */
  it('and the risk is at the top of the list', () => {
    const src = stripComments(repoFile('src/components/screens/CustomersScreen.tsx'));
    expect(src).toMatch(/GRADE_RANK\[a\.score\.grade\] - GRADE_RANK\[b\.score\.grade\]/);
  });
});

/**
 * AND THE COUNTER IT READS IS MAINTAINED BY EVERY DOOR.
 *
 * Measured while building the grade: 111 counted against 115 actually
 * delivered. `Customer.deliveredOrders` was incremented by exactly one
 * path — the manual status change — while the door settlement and the
 * courier's statement, which is how most orders actually complete, touched
 * nothing. A grade built on that counter describes the exceptions.
 */
describe('every door that delivers a parcel counts it', () => {
  const doors: [string, string][] = [
    ['التغيير اليدويّ', 'src/app/api/orders/[id]/route.ts'],
    ['التسوية عند الباب', 'src/lib/partial-delivery.ts'],
    // The statement's count moved with the rest of what it does to orders, into the close of the matching (2/11).
    ['كشف شركة الشحن', 'src/lib/statement-close.ts'],
  ];

  it('on the customer, not only on the order', () => {
    for (const [name, path] of doors) {
      const src = stripComments(repoFile(path));
      expect(src, `${name} لا يَعُدّ التسليم على العميل`).toMatch(
        /customer\.update\(\{[\s\S]{0,240}deliveredOrders: \{ increment: 1 \}/
      );
    }
  });

  /** A refusal at the door is the other half of the same record. */
  it('and a refusal at the door is counted as one', () => {
    const src = stripComments(repoFile('src/lib/partial-delivery.ts'));
    expect(src).toMatch(/nothingTaken[\s\S]{0,120}cancelledOrders: \{ increment: 1 \}/);
  });

  /**
   * A partial is a customer who opened the door and paid. Grading them
   * beside somebody who refused the lot would be the wrong sentence about
   * the wrong person.
   */
  it('counting a partial delivery as a delivery', () => {
    const src = stripComments(repoFile('src/lib/partial-delivery.ts'));
    expect(src).toMatch(
      /data: nothingTaken[\s\S]{0,60}\? \{ cancelledOrders[\s\S]{0,80}: \{ deliveredOrders: \{ increment: 1 \}/
    );
  });
});
