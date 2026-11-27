import { describe, expect, it } from 'vitest';
import { cartPhoneIsLocal, cartPhoneKey, cartQualifiesForOrder } from './abandoned-cart-rules';

/** The owner, 27/11: a cart with no name becomes an order only when its number is its country's own. */
describe('a phone-only cart needs a local number', () => {
  const open = { status: 'NEW', productId: 'p1', orderId: null };
  const key = (raw: string, cc: string) => cartPhoneKey(raw, cc);

  it('Syria and Jordan: the national number is local, a foreign or made-up one is not', () => {
    expect(cartPhoneIsLocal(key('0952349466', 'SY'), 'SY')).toBe(true);
    expect(cartPhoneIsLocal(key('+963952349466', 'SY'), 'SY')).toBe(true);
    expect(cartPhoneIsLocal(key('0791234567', 'JO'), 'JO')).toBe(true);
    for (const far of ['+888888888888888', '+900123456789', '+96178899346']) expect(cartPhoneIsLocal(key(far, 'SY'), 'SY')).toBe(false);
    expect(cartPhoneIsLocal('', 'SY')).toBe(false);
  });

  it('no name: qualifies only with a local number; a name keeps the old rule', () => {
    expect(cartQualifiesForOrder({ ...open, customerName: null, phoneNormalized: key('0952349466', 'SY'), country: 'SY' })).toBe(true);
    expect(cartQualifiesForOrder({ ...open, customerName: '', phoneNormalized: key('+888888888888888', 'SY'), country: 'SY' })).toBe(false);
    expect(cartQualifiesForOrder({ ...open, customerName: 'م', phoneNormalized: key('+900123456789', 'SY'), country: 'SY' })).toBe(false);
    expect(cartQualifiesForOrder({ ...open, customerName: 'سامي', phoneNormalized: key('+96178899346', 'SY'), country: 'SY' })).toBe(true);
  });
});
