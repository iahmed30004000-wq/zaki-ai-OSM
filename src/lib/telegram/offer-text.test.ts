import { describe, expect, it } from 'vitest';
import { currenciesIn, foldOfferText, matchOfferText, offersForQuantity } from './offer-text';

/**
 * «نص العرض مربوط بالعرض» — THE MATCH OF A MESSAGE’S OFFER TEXT TO AN OFFER’S NAME, ON ITS OWN.
 * No database: offers here are just names. The money is the storefront door’s and is tested at the door.
 */

const BUNDLE = { id: 'a', name: 'قطعتين + قطعة هدية ( عدد 3 )' };
const SINGLE = { id: 'b', name: 'قطعة واحدة' };
const TWO = { id: 'c', name: 'قطعتين' };

describe('folding', () => {
  it('drops punctuation and currency symbols, folds the spelling, makes the digits Latin and the spaces single', () => {
    expect(foldOfferText('قطعتين + قطعة هدية ( عدد ٣ ) =25 $ + توصيل مجاني')).toBe('قطعتين قطعه هديه عدد 3 25 توصيل مجاني');
    expect(foldOfferText('  A،B  ')).toBe('a b');
    expect(foldOfferText('')).toBe('');
  });
});

describe('matching', () => {
  it.each([
    ['the name exactly', 'قطعتين + قطعة هدية ( عدد 3 )'],
    ['the name with its brackets and plus gone', 'قطعتين قطعة هدية عدد 3'],
    ['the name inside his whole text', 'قطعتين + قطعة هدية ( عدد 3 ) =25 $ + توصيل مجاني'],
    ['Arabic-Indic digits', 'قطعتين + قطعة هدية ( عدد ٣ )'],
    ['another spelling of the letters', 'قطعتين + قطعه هديه ( عدد 3 )'],
  ])('found — %s', (_what, text) => {
    expect(matchOfferText(text, [SINGLE, BUNDLE])).toEqual({ kind: 'found', offer: BUNDLE });
  });

  it('none — nothing of the offer’s name stands in the text', () => {
    expect(matchOfferText('ثلاث قطع', [SINGLE, BUNDLE])).toEqual({ kind: 'none' });
    expect(matchOfferText('', [SINGLE, BUNDLE])).toEqual({ kind: 'none' });
    expect(matchOfferText('قطعتين + قطعة هدية', [])).toEqual({ kind: 'none' });
  });

  it('none — a name is matched word for word, not letter for letter', () => {
    expect(matchOfferText('قطعتين فقط', [{ id: 'x', name: 'قطع' }])).toEqual({ kind: 'none' });
  });

  it('an offer whose name folds to nothing never matches', () => {
    expect(matchOfferText('!!! ...', [{ id: 'x', name: '!!!' }])).toEqual({ kind: 'none' });
  });

  it('a name equal to the text wins over names inside it', () => {
    expect(matchOfferText('قطعتين', [BUNDLE, TWO])).toEqual({ kind: 'found', offer: TWO });
  });

  it('a name that holds another candidate’s name wins over it', () => {
    expect(matchOfferText('قطعتين + قطعة هدية ( عدد 3 ) =25 $', [TWO, BUNDLE])).toEqual({ kind: 'found', offer: BUNDLE });
  });

  it('ambiguous — two offers with the same name', () => {
    expect(matchOfferText(BUNDLE.name, [BUNDLE, { ...BUNDLE, id: 'z' }])).toEqual({ kind: 'ambiguous' });
    expect(matchOfferText(`${BUNDLE.name} فقط`, [BUNDLE, { ...BUNDLE, id: 'z' }])).toEqual({ kind: 'ambiguous' });
  });

  it('ambiguous — two different names inside the text, neither holding the other', () => {
    expect(matchOfferText('قطعة واحدة قطعتين', [SINGLE, TWO])).toEqual({ kind: 'ambiguous' });
  });
});

describe('the currency written in the text', () => {
  it.each([
    ['25 $', ['USD']],
    ['25 دولار', ['USD']],
    ['25 ل.س', ['SYP']],
    ['25 د.أ', ['JOD']],
    ['25', []],
    ['قطعتين + قطعة هدية', []],
    ['$ 25 د.أ', ['USD', 'JOD']],
  ])('«%s» names %j', (text, codes) => {
    expect(currenciesIn(text).sort()).toEqual([...codes].sort());
  });
});

describe('«الكمية» in offers', () => {
  it.each([
    [1, 2, 1],
    [2, 2, 1],
    [4, 2, 2],
    [6, 2, 3],
    [1, 1, 1],
    [5, 1, 5],
    [3, 3, 1],
    [6, 3, 2],
  ])('quantity %i of an offer paid for %i pieces is %i offer(s)', (quantity, paid, offers) => {
    expect(offersForQuantity(quantity, paid)).toBe(offers);
  });

  it.each([[3, 2], [5, 2], [7, 2], [2, 3], [4, 3], [0, 2], [-1, 2], [1.5, 2]])('quantity %s of an offer paid for %i pieces is not an offer', (quantity, paid) => {
    expect(offersForQuantity(quantity, paid)).toBeNull();
  });
});
