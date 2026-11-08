import { describe, expect, it } from 'vitest';
import { matchesQuery } from './queue-search';
import { lineEssentials } from './statement-line-reading';

/**
 * «هاتف بأي شكل» (the DoD of the matching queues' search box) — a phone is typed in the shape it ARRIVED in, which is rarely the shape
 * the company wrote: «+963 933 620 102» from a chat, «0933-620-102» from a contacts list, «(0933) 620102», «00963 933 620 102», a
 * number with the invisible direction marks a phone adds when it copies a number, Arabic digits. Every one of them has to find a row
 * whose phone the company wrote in ANY of the other shapes — through the same reading the screen uses (`lineEssentials`), because the
 * search looks in the forms that reading gives a phone, not only in the text the company typed. Every number below is invented.
 *
 * The invisible marks are built from their code points: a literal one in this file would be invisible to whoever reviews it.
 */
const mark = (code: number) => String.fromCharCode(code);
const LRM = mark(0x200e);
const RLM = mark(0x200f);
const LRE = mark(0x202a);
const PDF = mark(0x202c);

/** What the matching screen puts in front of the search box for a line whose phone cell says `cell`. */
function partsForPhoneCell(cell: string) {
  const line = {
    merchantRef: 'MR-1', barcode: '100000000001', status: null,
    rawRow: `100000000001 | ${cell} | كاش`,
    receiverName: null, receiverPhone: cell, receiverAddress: null, receiverCity: null, receiverArea: null,
  };
  const e = lineEssentials(line);
  return { fields: [line.barcode, line.merchantRef, cell, ...(e.phone ? [e.phone.shown, ...e.phone.keys] : [])], text: [line.rawRow] };
}

/** The shapes the company may write ONE number in. */
const ROWS = ['0933620102', '933620102', '00963933620102', '+963 933 620 102', '+963933620102', '٠٩٣٣٦٢٠١٠٢'];

/** The shapes a person may type it in. */
const QUERIES = [
  '0933620102', '933620102', '963933620102', '+963933620102',
  '+963 933 620 102', '0933-620-102', '0933.620.102', '(0933) 620102', '+963-933-620-102', '00963 933 620 102', '933 620 102',
  '٠٩٣٣٦٢٠١٠٢', '٠٩٣٣-٦٢٠-١٠٢',
  `${LRM}+963 933 620 102${RLM}`, `${LRE}0933620102${PDF}`, ` ${LRM}0933620102 `,
];

describe('a phone typed in any shape finds the line whose phone the company wrote in any other', () => {
  for (const row of ROWS) {
    it(`the company wrote «${row}»`, () => {
      const parts = partsForPhoneCell(row);
      const missed = QUERIES.filter((q) => !matchesQuery(parts, q));
      expect(missed, 'queries that found nothing').toEqual([]);
    });
  }

  it('another number finds none of them, in any of the shapes', () => {
    const others = ['0933620103', '+963 933 620 103', '0933-620-103', '(0933) 620103', '00963 933 620 103', `${LRM}+963 933 620 103${RLM}`];
    for (const row of ROWS) {
      const parts = partsForPhoneCell(row);
      for (const q of others) expect(matchesQuery(parts, q), `${row} ← ${q}`).toBe(false);
    }
  });

  it('the plus and the country code alone are not a number: a code of three digits finds nothing by itself', () => {
    // «+963» is three digits — shorter than a phone fragment — and is looked for only as the text it is.
    expect(matchesQuery({ fields: ['0933620102'] }, '+963')).toBe(false);
  });

  it('digits are never read across two cells, however the query is spaced', () => {
    // «100000000001» + «20001» are two cells. Glued they read «…00012 0001»; a query spelling a stretch that exists ONLY across
    // the join («0001-2000» → 00012000) finds neither cell — and the plain words «0001 20001» do find both, as two words of text.
    expect(matchesQuery({ fields: ['100000000001', '20001'] }, '0001-2000')).toBe(false);
    expect(matchesQuery({ fields: ['100000000001', '20001'] }, '1000-0000-0001')).toBe(true); // …but one cell, spaced, is found
  });

  it('a short number is still only a word, with separators or without: it is not looked for among a phone’s digits', () => {
    // «3-9» → 39, which IS in «963900000001» as digits (…63 900…), but two digits are no phone fragment and the text does not hold «3-9».
    expect(matchesQuery({ fields: ['+963 900 000 001'] }, '3-9')).toBe(false);
    expect(matchesQuery({ fields: ['+963 900 000 001'] }, '3 9')).toBe(true); // …while the two words «3» and «9» are each in the text
  });

  it('the invisible marks do not turn a text query into a miss either', () => {
    expect(matchesQuery({ fields: ['إدلب - سلقين'] }, `${RLM}سلقين${LRM}`)).toBe(true);
  });
});
