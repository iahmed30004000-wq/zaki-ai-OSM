import { describe, expect, it } from 'vitest';
import { cleanReply, explicitYes, mentionsAmount, said } from './words';

/**
 * THE CUSTOMER'S OWN WORDS, READ BY CODE — the two things the order bot may never take from the model: that the customer
 * said a clear yes, and that the amount they agreed to was written to them.
 */
describe('a clear yes', () => {
  it.each(['إي أكدولي الطلب', 'تمام ابعتوه', 'موافق، كل التفاصيل صحيحة', 'اكيد', 'ok', 'أيوه ثبّتو'])('«%s» is a yes', (t) => {
    expect(explicitYes(t)).toBe(true);
  });

  it.each(['يمكن', 'خليني فكر', 'بعدين', 'إن شاء الله', 'إي بس بدي غيّر العنوان', 'لا', 'مش متأكد', 'تمام لكن مو هلق', 'شو السعر؟'])(
    'NEGATIVE: «%s» is not a yes',
    (t) => {
      expect(explicitYes(t)).toBe(false);
    }
  );
});

describe('the quoted words were really written', () => {
  it('finds them through spelling, diacritics and punctuation', () => {
    expect(said('إي، أكّدولي الطلب!', 'اي اكدولي الطلب')).toBe(true);
  });
  it('NEGATIVE: words the customer never wrote', () => {
    expect(said('شو السعر؟', 'اي اكدولي')).toBe(false);
    expect(said('اي', '')).toBe(false);
  });
});

describe('the amount was written', () => {
  it('in Latin or Arabic digits, with or without separators', () => {
    expect(mentionsAmount('المبلغ عند الاستلام 25.5 دينار', 25.5)).toBe(true);
    expect(mentionsAmount('بتدفع ١٥٠٠٠ ليرة', 15000)).toBe(true);
    expect(mentionsAmount('بتدفع 15,000 ليرة', 15000)).toBe(true);
  });
  it('NEGATIVE: another figure is not this one', () => {
    expect(mentionsAmount('المبلغ 25 دينار', 25.5)).toBe(false);
    expect(mentionsAmount('بدون أرقام', 10)).toBe(false);
  });
});

describe('what leaves for WhatsApp', () => {
  it('drops a reasoning block and button markup, and fits Meta’s limit', () => {
    expect(cleanReply('<think>secret plan</think>أهلين فيك [[أزرار: إي | لا]]')).toBe('أهلين فيك');
    expect(cleanReply('x'.repeat(5000)).length).toBe(4096);
  });
});
