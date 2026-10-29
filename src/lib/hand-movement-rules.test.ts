import { describe, expect, it } from 'vitest';
import { MOVEMENT_CATEGORIES } from './wallets';
import {
  COURIER_MONEY_HINT,
  OWN_LEDGER_HINT,
  handCategoriesFor,
  handMovementRefusal,
  ownLedgerCategories,
  type HandDirection,
} from './hand-movement-rules';

/**
 * WHAT A PERSON MAY TYPE INTO A WALLET.
 *
 * Every category in both directions, with the answer written out — so the table below is the rule, and a
 * pair added or dropped by accident changes a line somebody has to read.
 */

const DIRECTIONS: HandDirection[] = ['IN', 'OUT'];

/** The pairs a person may type. Everything else is refused. */
const ACCEPTED = new Set([
  'ADJUSTMENT:IN',
  'ADJUSTMENT:OUT',
  'OTHER:IN',
  'OTHER:OUT',
]);

describe('the pairs the hand door accepts', () => {
  for (const category of MOVEMENT_CATEGORIES) {
    for (const direction of DIRECTIONS) {
      const pair = `${category}:${direction}`;
      it(`${pair} is ${ACCEPTED.has(pair) ? 'accepted' : 'refused'}`, () => {
        expect(handMovementRefusal(category, direction) === null).toBe(ACCEPTED.has(pair));
      });
    }
  }
});

describe('each refusal says what to do instead', () => {
  it('a courier collection is not typed — either direction', () => {
    for (const d of DIRECTIONS) {
      const r = handMovementRefusal('COURIER_SETTLEMENT', d)!;
      expect(r.code).toBe('COURIER_NOT_BY_HAND');
      expect(r.error).toContain('تحصيل شركة الشحن ما بينكتب باليد');
      // Both real doors, and the way to record a difference the company paid on an approved statement.
      expect(r.error).toContain('ينعتمد الكشف');
      expect(r.error).toContain('استلمت منه');
      expect(r.error).toContain('اكتبها «تسوية» ورقم الكشف بالملاحظة');
    }
  });

  it('a transfer is made from «تحويل»', () => {
    for (const c of ['TRANSFER_IN', 'TRANSFER_OUT']) {
      for (const d of DIRECTIONS) {
        expect(handMovementRefusal(c, d)).toEqual({
          code: 'TRANSFER_NOT_BY_HAND',
          error: 'التحويل بين المحافظ من «تحويل»، مش من هون',
        });
      }
    }
  });

  /*
   * OLD → NEW (29/10, P19a): «an expense runs out only — and so does a commission» is gone. Both have a ledger of
   * their own, so a typed one is refused in EITHER direction and names the door that writes it.
   */
  it('an expense and a commission have their own doors — refused both ways, each naming its door', () => {
    for (const d of DIRECTIONS) {
      const e = handMovementRefusal('EXPENSE', d)!;
      expect(e.code).toBe('EXPENSE_NOT_BY_HAND');
      expect(e.error).toContain('سجّل مصروفاً');
      const c = handMovementRefusal('COMMISSION', d)!;
      expect(c.code).toBe('COMMISSION_NOT_BY_HAND');
      expect(c.error).toContain('صرف');
    }
  });

  it('an inherited name is not a category: toString is refused as unknown, not read off the prototype', () => {
    expect(handMovementRefusal('toString', 'IN')!.code).toBe('UNKNOWN_CATEGORY');
    expect(handMovementRefusal('constructor', 'OUT')!.code).toBe('UNKNOWN_CATEGORY');
  });

  it('a category nobody knows is refused, not guessed', () => {
    expect(handMovementRefusal('GIFT', 'IN')!.code).toBe('UNKNOWN_CATEGORY');
  });
});

describe('what the dialog may offer', () => {
  it('is exactly what the door accepts, in each direction', () => {
    for (const d of DIRECTIONS) {
      const offered = handCategoriesFor(d);
      const accepted = MOVEMENT_CATEGORIES.filter((c) => ACCEPTED.has(`${c}:${d}`));
      expect([...offered].sort()).toEqual([...accepted].sort());
    }
  });

  it('never offers a courier collection, a transfer, an expense or a commission', () => {
    for (const d of DIRECTIONS) {
      for (const c of handCategoriesFor(d)) {
        expect(['COURIER_SETTLEMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'EXPENSE', 'COMMISSION']).not.toContain(c);
      }
    }
  });

  it('says in one line where courier money is recorded', () => {
    expect(COURIER_MONEY_HINT).toContain('اعتماد الكشف');
    expect(COURIER_MONEY_HINT).toContain('استلمت منه');
  });

  it('and where the expense, the commission and the salary are recorded', () => {
    expect(OWN_LEDGER_HINT).toContain('سجّل مصروفاً');
    expect(OWN_LEDGER_HINT).toContain('صرف');
    expect(OWN_LEDGER_HINT).toContain('صفحة الموظف');
    expect(ownLedgerCategories().sort()).toEqual(['COMMISSION', 'EXPENSE']);
  });
});
