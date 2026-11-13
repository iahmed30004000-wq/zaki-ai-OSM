import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { z } from 'zod';
import { COMMISSION_RATE_MAX, readCommissionRate } from './user-commission-rate';
import { readBasePrice } from './product-base-price';
import { count, money, numeric } from './numeric-input';

/**
 * ONE COLUMN, ONE RULE — AND THE DOORS MAY NOT BRING THEIR OWN.
 *
 * `User.commissionRate` had two doors. `/api/users` validated it and wrote
 * the column's own default; `/api/moderators` validated nothing and wrote
 * `parseFloat(commissionRate) || 5.0`, a number declared in no schema, no
 * migration and no other door. `Product.basePrice` had two doors as well,
 * both writing `parseFloat(basePrice) || 0`, so a typo priced a product at
 * nothing and answered 200.
 *
 * The rules are values now, in one file each. This test checks the reading
 * BEHAVIOUR and then checks that no door has quietly grown a second rule
 * next to the shared one — a fallback re-added at a write site is how the
 * first divergence happened, and it reads as policy while bypassing it.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE NO LONGER GUARDS WITH A LIST OF HOSTILE STRINGS
 *
 * It used to. The price rule was guarded by twelve named strings — `'abc'`,
 * `'3,5'`, `'12abc'`, `''`, `'   '`, `null`, `undefined`, `true`, `{}`,
 * `NaN`, `Infinity`, `-0.01` — and the rate rule by eleven. Both lists were
 * written by someone who had just measured `parseFloat`, so both named the
 * notations `parseFloat` mis-reads and neither named `'0x10'`.
 * `readBasePrice('0x10')` returned **16** for as long as those lists stood,
 * and nothing failed, because a list guards the notations its author
 * happened to think of. That is not a gap in the list. It is what a list is.
 *
 * So the notations are GENERATED here, three ways, and each one states its
 * own limits so that what it does not cover is visible rather than assumed:
 *
 *   1. EXHAUSTIVELY — every string of length 1…4 over a declared alphabet of
 *      the characters that mean something to `Number()`. 4 is the length of
 *      `'0x10'`, which is the point. This is the sweep that finds a notation
 *      nobody named: a prefix, a separator or a sign arrangement that
 *      `Number()` reads and the rule should not, can only hide here by being
 *      longer than four characters or by using a character outside the
 *      alphabet. Both limits are one line of code away from the reader.
 *   2. BY CROSS PRODUCT — sign × base prefix × digit alphabet × shape ×
 *      whitespace wrapper, for the notations too long for the sweep:
 *      `'Infinity'`, `'١٢٣'` (this product is Arabic-facing), `'2,500'`,
 *      `'1e400'`, a no-break space, a byte-order mark. Adding a notation
 *      means adding it to ONE family and getting it crossed with every
 *      other, rather than writing out N strings and forgetting the N+1st.
 *   3. BY VALUE KIND — the non-strings a JSON body can carry, each named for
 *      what `Number()` does with it rather than for what it is.
 *
 * And the law applied to all three is not «these strings are refused». It is
 * the DIFFERENCE between `Number()` and the rule, stated once:
 *
 *      a string is a price if and only if it is written the way a decimal
 *      number is written — and `Number()` agreeing is not enough.
 *
 * «written the way a decimal number is written» is decided by `isDecimal`
 * below, scanned character by character with no regular expression, so it
 * cannot be the same mistake twice as the regular expression in
 * `numeric-input.ts` that the rule actually uses. The two are independent
 * statements of one grammar; the sweep is where they are made to agree.
 */

/* ───────────────────────── the independent oracle ───────────────────────── */

/**
 * Written the way a decimal number is written: an optional sign, digits with
 * an optional decimal point, an optional decimal exponent, and nothing else.
 *
 * Hand-scanned on purpose. `numeric-input.ts` decides this with a regular
 * expression; if this function were a regular expression too, a mistake in
 * the character class would be made twice and the sweep would agree with
 * itself. `s[i] >= '0' && s[i] <= '9'` is ASCII by construction, which is
 * why `'١٢٣'` fails it — U+0660 is past U+0039.
 */
function isDecimal(s: string): boolean {
  let i = 0;
  if (s[i] === '+' || s[i] === '-') i++;
  let digits = 0;
  while (i < s.length && s[i]! >= '0' && s[i]! <= '9') {
    i++;
    digits++;
  }
  if (s[i] === '.') {
    i++;
    while (i < s.length && s[i]! >= '0' && s[i]! <= '9') {
      i++;
      digits++;
    }
  }
  if (digits === 0) return false;
  if (s[i] === 'e' || s[i] === 'E') {
    i++;
    if (s[i] === '+' || s[i] === '-') i++;
    let exponent = 0;
    while (i < s.length && s[i]! >= '0' && s[i]! <= '9') {
      i++;
      exponent++;
    }
    if (exponent === 0) return false;
  }
  return i === s.length;
}

/**
 * What `readBasePrice` must answer for a given input, derived from the rule
 * in words rather than from the implementation:
 *
 *   · a number is taken as it is, if it is finite and not negative;
 *   · a string is trimmed, must be written the way a decimal number is
 *     written, must not overflow to Infinity, and must not be negative;
 *   · everything else is a refusal.
 *
 * Zero is a price (`82ecac3`: a sample or a gift, and the column's own
 * default is `0.0`). A negative number is a typo with a minus in front.
 */
function priceShouldBe(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!isDecimal(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/* ───────────────── 1. the exhaustive sweep, length 1 … 4 ───────────────── */

/**
 * The characters that mean something to `Number()`: the digits that bound a
 * run, the two radix points a person might type, the exponent letters, the
 * three base-prefix letters in both cases, the signs, the two thousands
 * separators, a space, and one Arabic-Indic digit to carry the non-ASCII
 * case into the sweep. Sixteen characters, strings up to four long: every
 * notation expressible that way is tested, `'0x10'` among them.
 */
const SWEEP_ALPHABET = ['0', '1', '9', '.', ',', 'e', 'E', 'x', 'b', 'o', 'X', '+', '-', '_', ' ', '٠'];
const SWEEP_MAX_LENGTH = 4;

function sweep(): string[] {
  let level = [''];
  const all: string[] = [];
  for (let length = 1; length <= SWEEP_MAX_LENGTH; length++) {
    const next: string[] = [];
    for (const prefix of level) for (const ch of SWEEP_ALPHABET) next.push(prefix + ch);
    all.push(...next);
    level = next;
  }
  return all;
}

const SWEPT = sweep();

/* ──────────────── 2. the cross product, for the long forms ─────────────── */

/** A sign, or none. */
const SIGNS = { unsigned: '', plus: '+', minus: '-' };

/** The base prefixes `Number()` honours — and the absence of one. */
const BASES = {
  decimal: '',
  'hex lower': '0x',
  'hex upper': '0X',
  'binary lower': '0b',
  'binary upper': '0B',
  'octal lower': '0o',
  'octal upper': '0O',
};

/**
 * The digit alphabets a keyboard in this product's market can produce. The
 * Arabic-Indic set is the one that matters: this is an Arabic-facing system
 * and `١٢٣` is what an Arabic keypad in some layouts actually emits.
 */
const ALPHABETS = {
  ascii: '0123456789',
  'arabic-indic': '٠١٢٣٤٥٦٧٨٩',
  'extended arabic-indic': '۰۱۲۳۴۵۶۷۸۹',
  devanagari: '०१२३४५६७८९',
  fullwidth: '０１２３４５６７８９',
};

/** How the digits are arranged, written in ASCII and then transliterated. */
const SHAPES = {
  whole: '17',
  zero: '0',
  'leading zeros': '017',
  fraction: '12.5',
  'leading point': '.5',
  'trailing point': '5.',
  exponent: '1e3',
  'exponent upper': '1E3',
  'exponent signed': '1e+3',
  'exponent negative': '1e-3',
  'exponent overflowing to Infinity': '1e400',
  'exponent large but finite': '1e308',
  'thousands comma': '2,500',
  'thousands space': '2 500',
  'numeric separator': '1_000',
  'two decimal points': '1.2.3',
  'trailing letters': '12abc',
  percent: '15%',
  currency: '12$',
  'the word Infinity': 'Infinity',
  'the word infinity lowercased': 'infinity',
  'the word NaN': 'NaN',
  'nothing at all': '',
};

/**
 * Whitespace forms. `String.prototype.trim` strips every one of these — the
 * no-break space and the byte-order mark included — so they are expected to
 * be harmless, and that expectation is measured below rather than assumed.
 */
const WRAPPERS = {
  bare: (t: string) => t,
  'ascii spaces': (t: string) => ` ${t} `,
  'tab, newline, carriage return': (t: string) => `\t\n ${t} \r\n`,
  'no-break space': (t: string) => ` ${t} `,
  'ideographic space': (t: string) => `　${t}`,
  'byte-order mark': (t: string) => `﻿${t}`,
};

const ASCII_DIGITS = ALPHABETS.ascii;

/** The shape, written in another alphabet's digits. */
function transliterate(shape: string, alphabet: string): string {
  let out = '';
  for (const ch of shape) {
    const d = ASCII_DIGITS.indexOf(ch);
    out += d === -1 ? ch : alphabet[d];
  }
  return out;
}

type Notation = { readonly name: string; readonly value: string };

function crossProduct(): Notation[] {
  const out: Notation[] = [];
  for (const [signName, sign] of Object.entries(SIGNS))
    for (const [baseName, base] of Object.entries(BASES))
      for (const [alphabetName, alphabet] of Object.entries(ALPHABETS))
        for (const [shapeName, shape] of Object.entries(SHAPES))
          for (const [wrapperName, wrap] of Object.entries(WRAPPERS))
            out.push({
              name: `${signName} / ${baseName} / ${alphabetName} / ${shapeName} / ${wrapperName}`,
              value: wrap(sign + base + transliterate(shape, alphabet)),
            });
  return out;
}

const CROSSED = crossProduct();

/* ───────────────────── 3. the value kinds a body carries ──────────────── */

const VALUE_KINDS: ReadonlyArray<readonly [string, unknown]> = [
  ['absent', undefined],
  ['null — Number() reads it as 0', null],
  ['true — Number() reads it as 1', true],
  ['false — Number() reads it as 0', false],
  ['empty array — Number() reads it as 0', []],
  ["array of one numeric string — Number(['5']) is 5", ['5']],
  ['array of one number', [5]],
  ['array of two numbers', [1, 2]],
  ['plain object', {}],
  ['object with a valueOf — Number() calls it', { valueOf: () => 7 }],
  ['object whose toString is a hex literal', { toString: () => '0x10' }],
  ['a Date — Number() reads its epoch milliseconds', new Date(0)],
  ['a bigint — Number() converts it', BigInt(7)],
  ['NaN', NaN],
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['a negative price', -0.01],
  ['a typed zero', 0],
  ['a typed price', 12.5],
  ['the largest finite double', Number.MAX_VALUE],
];

/* ──────────────────────────── the laws ─────────────────────────────────── */

describe('the price a person types is the price that is read', () => {
  it('reads a typed zero as zero — a sample has a real price', () => {
    expect(readBasePrice(0)).toBe(0);
    expect(readBasePrice('0')).toBe(0);
  });

  it('reads the number that was typed, from a number or from a form string', () => {
    expect(readBasePrice(12.5)).toBe(12.5);
    expect(readBasePrice(' 12.5 ')).toBe(12.5);
  });

  /**
   * THE DEFECT THIS FILE WAS REWRITTEN FOR, named once so the number is on
   * the record: these are the values `Number()` really answers, measured —
   * not remembered. If a JavaScript engine ever stops reading base prefixes
   * this test says so, and the reasoning in `product-base-price.ts` can be
   * revisited instead of being inherited.
   */
  it('Number() reads base prefixes as figures — and the price rule must not', () => {
    expect(Number('0x10')).toBe(16);
    expect(Number('0b11')).toBe(3);
    expect(Number('0o17')).toBe(15);
    expect(Number('0X10')).toBe(16);

    expect(readBasePrice('0x10'), '0x10 would be stored as 16').toBeNull();
    expect(readBasePrice('0b11'), '0b11 would be stored as 3').toBeNull();
    expect(readBasePrice('0o17'), '0o17 would be stored as 15').toBeNull();
    expect(readBasePrice('0X10'), '0X10 would be stored as 16').toBeNull();
  });

  /**
   * THE LAW, over every string of length 1…4 over the declared alphabet.
   * Not «these are refused»: the reader and an independently written grammar
   * must answer the same thing for all of them.
   */
  it(`agrees with the grammar for all ${SWEPT.length} strings of length 1…${SWEEP_MAX_LENGTH}`, () => {
    const wrong: string[] = [];
    for (const value of SWEPT) {
      const got = readBasePrice(value);
      const want = priceShouldBe(value);
      if (!Object.is(got, want)) {
        wrong.push(`${JSON.stringify(value)} → ${String(got)}, should be ${String(want)}`);
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${SWEPT.length} swept strings read wrongly`).toEqual([]);
  });

  it(`agrees with the grammar for all ${CROSSED.length} notations in the cross product`, () => {
    const wrong: string[] = [];
    for (const { name, value } of CROSSED) {
      const got = readBasePrice(value);
      const want = priceShouldBe(value);
      if (!Object.is(got, want)) {
        wrong.push(`${name}: ${JSON.stringify(value)} → ${String(got)}, should be ${String(want)}`);
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} of ${CROSSED.length} notations read wrongly`).toEqual([]);
  });

  it('agrees with the grammar for every value kind a JSON body can carry', () => {
    for (const [name, value] of VALUE_KINDS) {
      expect(readBasePrice(value), `${name}: ${String(Number(value as never))} from Number()`).toBe(
        priceShouldBe(value)
      );
    }
  });

  /**
   * BOTH GENERATORS MUST BITE — SEPARATELY.
   *
   * A generator that happens to produce nothing dangerous is a vacuous guard
   * with more lines, and an aggregate count hides one generator going quiet
   * behind the other still working. So the hazard is counted per generator:
   * the strings `Number()` turns into a figure while the grammar refuses
   * them — the `'0x10'` → 16 class.
   *
   * MEASURED when this was written: 128 from the sweep and 144 from the
   * cross product, 272 in all. The floors are set at 50 each, low enough
   * that a harmless change to an alphabet does not fail and high enough that
   * gutting either generator does. Both were measured by gutting them.
   */
  const misreadBy = (values: readonly string[]) =>
    values.filter((value) => {
      const trimmed = value.trim();
      return trimmed !== '' && !isDecimal(trimmed) && Number.isFinite(Number(trimmed));
    });

  it('both generators really do contain the hazard, and name it', () => {
    const fromSweep = misreadBy(SWEPT);
    const fromCross = misreadBy(CROSSED.map((n) => n.value));

    expect(fromSweep.length, 'the exhaustive sweep produced nothing Number() mis-reads').toBeGreaterThan(50);
    expect(fromCross.length, 'the cross product produced nothing Number() mis-reads').toBeGreaterThan(50);

    // Named witnesses, each one checked against the generator that can
    // actually produce it: `'0o17'` needs a 7, which the sweep alphabet does
    // not carry, and `'0x10'` is four characters, which is the sweep's limit.
    for (const witness of ['0x10', '0b11', '0o11']) {
      expect(fromSweep, `${witness} is not in the swept corpus`).toContain(witness);
    }
    for (const witness of ['0x17', '0X17', '0o17', '0O17']) {
      expect(fromCross, `${witness} is not in the cross product`).toContain(witness);
    }

    // And not one of them may be read as a price.
    const accepted = [...fromSweep, ...fromCross].filter((value) => readBasePrice(value) !== null);
    expect(accepted.slice(0, 20), `${accepted.length} mis-readable notations were accepted`).toEqual([]);
  });

  /**
   * WHAT THIS GUARD DOES NOT COVER, stated rather than left to be found:
   *
   *   · strings longer than four characters that are not in a cross-product
   *     family — a notation needs a family here to be swept;
   *   · characters outside `SWEEP_ALPHABET` and the five digit alphabets;
   *   · THE ABSENCE OF A CEILING. `'1e308'` is a plain decimal, is finite,
   *     is not negative, and is therefore STORED — a product priced at
   *     1e308. `Product.basePrice` declares no maximum, and the two money
   *     doors in this repository that do (`finance`, `campaigns`) declare
   *     one in the door rather than in the column. That is a policy decision
   *     and not this file's to make, so it is asserted as the CURRENT
   *     behaviour, not as the right one: when a ceiling is chosen, this test
   *     fails and says where to put it.
   */
  it('has no ceiling — the current behaviour, recorded so that changing it is deliberate', () => {
    expect(readBasePrice('1e308')).toBe(1e308);
    expect(readBasePrice(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    // The overflow above it is refused, which is the only bound there is.
    expect(readBasePrice('1e400')).toBeNull();
  });

  /**
   * THE DEPENDENCY, PINNED. `readBasePrice` no longer checks finiteness
   * itself: `numeric()` does it, through zod 4's `z.number()`, which is
   * finite. A re-added `Number.isFinite` there would be a guard that cannot
   * fire — and ten of those have been caught in this audit. This is the
   * assertion that takes its place.
   */
  it('the shared strict reader refuses what overflows, which the price rule relies on', () => {
    const strict = numeric();
    expect(strict.safeParse('1e400').success, "numeric() accepted '1e400'").toBe(false);
    expect(strict.safeParse(Infinity).success, 'numeric() accepted Infinity').toBe(false);
    expect(strict.safeParse(-Infinity).success, 'numeric() accepted -Infinity').toBe(false);
    expect(strict.safeParse(NaN).success, 'numeric() accepted NaN').toBe(false);
    expect(strict.safeParse('0x10').success, "numeric() accepted '0x10'").toBe(false);
  });

  /** Whitespace is trimmed, and which whitespace is measured, not assumed. */
  it('trims every whitespace form a form or a paste can carry', () => {
    expect(readBasePrice(' 250.5 ')).toBe(250.5);
    expect(readBasePrice('\t\n 7 \r\n')).toBe(7);
    expect(readBasePrice(' 7 ')).toBe(7);
    expect(readBasePrice('　7')).toBe(7);
    expect(readBasePrice('﻿7')).toBe(7);
    // …and whitespace alone is not a zero, which is what `Number('  ')` is.
    expect(Number('  ')).toBe(0);
    expect(readBasePrice('  ')).toBeNull();
    expect(readBasePrice('')).toBeNull();
  });
});

describe('the rate a person types is the rate that is read', () => {
  it('reads a typed zero as zero, not as nothing', () => {
    expect(readCommissionRate(0)).toBe(0);
  });

  it('reads an absent rate as the column default', () => {
    expect(readCommissionRate(undefined)).toBe(0);
  });

  it('reads the number that was typed', () => {
    expect(readCommissionRate(7.5)).toBe(7.5);
    expect(readCommissionRate(COMMISSION_RATE_MAX)).toBe(COMMISSION_RATE_MAX);
  });

  /**
   * The rate rule takes NO string — `commissionRateField` is `z.number()`
   * with no coercion, deliberately (`82ecac3`: a door that accepts `"5"`
   * also accepts `"5%"` and `"٥"` and has to guess). So the whole generated
   * corpus is one assertion here, and `'0x10'` cannot reach this column by
   * any notation. Swept rather than listed for the same reason as above: the
   * eleven-string list this replaced did not name `'0x10'` either.
   */
  it('refuses every string notation, whatever it is written in', () => {
    const accepted = [...SWEPT, ...CROSSED.map((n) => n.value)].filter(
      (value) => readCommissionRate(value) !== null
    );
    expect(accepted.slice(0, 20), `${accepted.length} string notations were read as a rate`).toEqual([]);
  });

  it('refuses a number outside the declared range, and every non-number', () => {
    for (const [name, value] of VALUE_KINDS) {
      const want =
        value === undefined
          ? 0
          : typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= COMMISSION_RATE_MAX
            ? value
            : null;
      expect(readCommissionRate(value), `rate from ${name}`).toBe(want);
    }
    expect(readCommissionRate(COMMISSION_RATE_MAX + 1)).toBeNull();
    expect(readCommissionRate(-1)).toBeNull();
  });
});

/**
 * COMMENTS BLANKED, so a docblock NAMING the old defect is not read as the
 * defect. Both doors explain what they used to write, in the words the
 * sweep below looks for.
 */
const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// One door: `/api/moderators` POST is closed (410) and writes no rate.
const RATE_DOORS = ['src/app/api/users/route.ts'];
const PRICE_DOORS = ['src/app/api/products/route.ts', 'src/app/api/products/[id]/route.ts'];

describe('no door carries a second rule for a column it shares', () => {
  it('neither rate door declares a rate of its own', () => {
    for (const door of RATE_DOORS) {
      const src = read(door);
      expect(src, `${door}: لا يستورد قاعدة النسبة المشتركة`).toContain('@/lib/user-commission-rate');
      // The 5.0 nobody declared, and the `||` that let a typed zero become it.
      expect(src, `${door}: نسبة مكتوبة في الباب`).not.toMatch(/commissionRate[^\n]*\|\|/);
      expect(src.match(/commissionRate:\s*parseFloat/), `${door}: parseFloat على النسبة`).toBeNull();
    }
  });

  it('neither price door declares a price rule of its own', () => {
    for (const door of PRICE_DOORS) {
      const src = read(door);
      expect(src, `${door}: لا يستورد قارئ السعر المشترك`).toContain('@/lib/product-base-price');
      expect(src.match(/parseFloat\(basePrice\)/), `${door}: parseFloat على السعر`).toBeNull();
      expect(src, `${door}: سعر بـfallback`).not.toMatch(/basePrice[^\n]*\|\|\s*0/);
    }
  });

  /**
   * And the shared reader may not grow a notation of its own either: the
   * whole point of the rewrite is that `product-base-price.ts` decides the
   * BOUND and `numeric-input.ts` decides the NOTATION. A `Number(` or a
   * `parseFloat(` reappearing in the reader is the twelfth variant starting.
   */
  it('the price reader borrows the notation instead of deciding one', () => {
    const src = read('src/lib/product-base-price.ts');
    expect(src, 'product-base-price.ts: لا يستورد القارئ الصارم').toContain('./numeric-input');
    expect(src.match(/parseFloat\(/), 'product-base-price.ts: parseFloat').toBeNull();
    expect(src.match(/\bNumber\(/), 'product-base-price.ts: Number() بيدها').toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 *  THE DIVERGENCE MADE IMPOSSIBLE, NOT MERELY ABSENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything above this line is about TWO COLUMNS that had two rules each,
 * and it guards them BY NAME. That is the right shape for a rule living in a
 * file of its own (`product-base-price.ts`, `user-commission-rate.ts`) — and
 * it is the wrong shape for the question underneath it, which is not «does
 * `basePrice` have one rule» but «CAN a column have two».
 *
 * It could, and nine more sites did. `PATCH /api/orders/[id]` read
 * `quantity`, `unitPrice`, `sellingPrice`, `discountAmount` and
 * `shippingCost` with `z.coerce.number()` while `POST /api/orders` read the
 * same columns with `count()`/`money()`. `Campaign.spend`, the public cart's
 * `quantity`, and the AI-intake confirm payload's `quantity` and
 * `finalPrice` were the same. Nothing in the suite objected — because
 * nothing in the suite was asking the general question.
 *
 * `z.coerce.number()` IS `Number(value)` (zod 4 calls it), and `Number()` is
 * this, measured:
 *
 *     '0x10' → 16      '0b11' → 3      '0o17' → 15      '1e400' → Infinity
 *     ''     → 0       '   '  → 0      null   → 0       []      → 0
 *     ['5']  → 5       true   → 1      {valueOf:()=>7} → 7   new Date(0) → 0
 *
 * So the law below is not «these doors read strictly». It is:
 *
 *      NO FIELD THAT IS MONEY OR A COUNT MAY BE READ WITH
 *      `z.coerce.number()`, ANYWHERE IN THE TREE.
 *
 * WHAT MAKES IT NOT A LIST — four things, each of which is what would have
 * failed if it were missing:
 *
 *   1. THE COLUMN NAMES ARE DERIVED FROM `prisma/schema.prisma`. Every
 *      `Decimal` and `Float` field is money; every `Int` field whose name
 *      contains «quantity» is a count. A money column added tomorrow joins
 *      the law the moment it is in the schema, with nobody remembering to
 *      add it — which is the half a named list cannot have.
 *   2. AND THE SCHEMA IS NOT ENOUGH, which was MEASURED rather than
 *      assumed: the first draft of this law derived its vocabulary from the
 *      schema alone and DID NOT CATCH `finalPrice` — the AI-intake confirm
 *      payload's price, which is written to `Order.sellingPrice` under a
 *      different name. A request field does not have to be spelled like the
 *      column it lands in. So a second rule reads the NAME'S MORPHOLOGY:
 *      anything ending in price / cost / amount / fee / total / spend /
 *      discount / revenue / profit / balance / salary / quantity / qty is
 *      money or a count whatever the schema calls it. Both rules are
 *      general; neither is a list of fields.
 *   3. THE SWEEP IS THE WHOLE TREE AND HAS NO EXEMPTION LIST for law one.
 *      Not «these five doors»: every non-test `.ts` and `.tsx` under `src/`.
 *      A tenth door written next year is in it the day it is written.
 *   4. THE DETECTORS ARE PURE FUNCTIONS RUN AGAINST THE EXACT TEXT THAT WAS
 *      DELETED. A guard whose detector has quietly stopped matching
 *      anything passes forever and says nothing — ten vacuous guards have
 *      been caught in this audit. So each detector is first shown to FIND
 *      the real sites in a fixture, and only then shown to find none in the
 *      tree.
 *
 * AND THE BROADENING IN (2) IMMEDIATELY EARNED ITSELF: it found
 * `src/lib/order-import.ts`, a tenth site nobody had named, where the
 * spreadsheet importer reads `Number(rawQty)` and
 * `Number(String(rawPrice).replace(/[^\d.-]/g, ''))`. That file is not this
 * change's to write, so it is recorded below as open, with the figures it
 * really produces, rather than classified as acceptable.
 */

/* ──────────────────── what counts as money or a count ──────────────────── */

interface Vocabulary {
  readonly money: ReadonlySet<string>;
  readonly counts: ReadonlySet<string>;
  readonly all: ReadonlySet<string>;
}

/**
 * The money and quantity COLUMNS this system has, taken from the schema
 * rather than from anybody's memory of it.
 *
 * `Decimal` and `Float` are both money here: the order's own figures are
 * `Float` (`sellingPrice`, `totalAmount`, `discountAmount`, `shippingCost`)
 * and the finance snapshot and the wallets are `Decimal(12,2)`/`(14,3)`.
 * `Int` is NOT money, and most `Int` columns are not counts either —
 * `version`, `sortOrder` and `postponeCount` are integers no `money()`
 * reader has business touching — so the count side takes only the ones
 * NAMED for a quantity.
 */
function columnVocabulary(): Vocabulary {
  const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const money = new Set<string>();
  const counts = new Set<string>();
  for (const line of schema.split('\n')) {
    const field = /^\s{2,}([A-Za-z_][A-Za-z0-9_]*)\s+(Decimal|Float|Int)(\?)?(\s|$)/.exec(line);
    if (!field) continue;
    const name = field[1]!;
    const type = field[2]!;
    if (type === 'Decimal' || type === 'Float') money.add(name);
    else if (/quantity/i.test(name)) counts.add(name);
  }
  return { money, counts, all: new Set([...money, ...counts]) };
}

const VOCAB = columnVocabulary();

/**
 * A name that is money or a count whatever the schema calls it.
 *
 * This is the rule that catches `finalPrice`, `rawQty` and `unitCost` —
 * fields that carry money or a count into a column spelled differently. It
 * is morphology, not a list: the word a developer puts at the end of such a
 * field is one of a small, closed set of English nouns, and a field ending
 * in `Id`, `Order`, `Count`-of-events, `page` or `limit` is deliberately
 * outside it. Both halves of that claim are asserted below.
 */
const MONEY_OR_COUNT_NAME =
  /(?:^|[a-z])(?:price|cost|amount|fee|total|spend|discount|revenue|profit|balance|salary|quantity|qty)s?$/i;

const isMoneyOrCount = (name: string) => VOCAB.all.has(name) || MONEY_OR_COUNT_NAME.test(name);

/* ───────────────────────────── the two detectors ────────────────────────── */

type Finding = { readonly field: string; readonly text: string };

/**
 * Comments are blanked before either scan, because the docblocks this audit
 * writes QUOTE the deleted line — and a guard that reads its own prose as
 * the defect is a failure this repository has hit four times.
 */
function blankComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every money-or-count field read with `z.coerce.number()`. */
function coercedFields(source: string): Finding[] {
  const src = blankComments(source);
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\s*\.\s*coerce\s*\.\s*number/g;
  return [...src.matchAll(re)]
    .filter((m) => isMoneyOrCount(m[1]!))
    .map((m) => ({ field: m[1]!, text: m[0]! }));
}

/**
 * Every money-or-count value handed, BY NAME AND BARE, to `Number()`,
 * `parseFloat()` or `parseInt()`.
 *
 * «Bare» is the whole distinction and it is one character wide:
 * `Number(refundAmount)` is a value that came off a request body, and
 * `Number(order.totalAmount)` is a stored Decimal turned into a JavaScript
 * number to show somebody. The second is everywhere and correct. So the
 * pattern refuses a preceding dot and takes only a bare identifier inside
 * the brackets, and the property reads fall out.
 *
 * WHAT IT THEREFORE DOES NOT SEE is a read whose argument is an EXPRESSION,
 * and that gap is no longer left for a person to walk into.
 * `order-import.ts`'s `Number(String(rawPrice).replace(…))` was invisible to
 * this pattern — it was the worse of that file's two defects and it was
 * found by hand. The objection to closing it was that a pattern matching
 * arbitrary expressions would match every arithmetic line in the tree, and
 * that objection is answered by `rewrittenNumberReads` below: not «any
 * expression», but the one SHAPE that turns a refusal into a rewrite.
 */
function bareNumberReads(source: string): Finding[] {
  const src = blankComments(source);
  const re = /(?<![.\w])(?:Number|parseFloat|parseInt)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g;
  return [...src.matchAll(re)]
    .filter((m) => isMoneyOrCount(m[1]!))
    .map((m) => ({ field: m[1]!, text: m[0]! }));
}

/**
 * A MONEY-OR-COUNT VALUE THAT IS REWRITTEN ON ITS WAY INTO A NUMBER.
 *
 * `order-import.ts` read a price out of a spreadsheet as
 *
 *     Number(String(rawPrice).replace(/[^\d.-]/g, ''))
 *
 * and no detector in this file could see it, because the argument is an
 * expression rather than an identifier. The reason it mattered is not that
 * `Number` is loose. It is that **a strip does not refuse — it REWRITES**.
 * `/[^\d.-]/` deletes what it does not recognise and reads what is left, and
 * what is left always passes a finiteness check, so there is no value of the
 * cell that produces an error. Measured on that file before it was fixed:
 * «٣٥٠٠» became a price of ZERO and «3,5» became 35.
 *
 * SO THE DETECTOR IS NOT «ANY EXPRESSION», which would match every
 * arithmetic line in the tree and force an exemption list. It is one shape:
 *
 *     a reader — `Number`, `parseFloat`, `parseInt` —
 *     whose argument contains a REWRITING call — `.replace`, `.replaceAll`,
 *       `.normalize` —
 *     and whose argument or assignment target NAMES money or a count.
 *
 * All three legs generate rather than list. The readers are the same three
 * the law already names; the rewriters are the three methods in JavaScript
 * that return a different string; and «names money or a count» is the schema
 * plus the morphology above, so a column added to `schema.prisma` tomorrow
 * is in this law the moment it is added.
 *
 * THE ASSIGNMENT TARGET IS READ AS WELL AS THE ARGUMENT, and it is not
 * decoration: `const price = parseFloat(value.replace(',', '.'))` names
 * money on the LEFT and nothing on the right, and it is a real site in this
 * tree. Scanned by hand with balanced brackets, because a regular
 * expression cannot count parentheses and the argument here is precisely
 * the thing that has them.
 */
const REWRITERS = ['.replace(', '.replaceAll(', '.normalize('];
const READERS = ['Number', 'parseFloat', 'parseInt'];

function rewrittenNumberReads(source: string): Finding[] {
  const src = blankComments(source);
  const out: Finding[] = [];

  for (let i = 0; i < src.length; i++) {
    const name = READERS.find((r) => src.startsWith(r, i));
    if (!name) continue;
    // The same one-character distinction law two makes: `x.Number(` and
    // `myNumber(` are not this.
    const before = i === 0 ? '' : src[i - 1]!;
    if (before && /[.\w$]/.test(before)) continue;

    const start = i;
    let open = start + name.length;
    while (open < src.length && /\s/.test(src[open]!)) open++;
    if (src[open] !== '(') continue;

    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '(') depth++;
      else if (src[close] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    i = close;

    const argument = src.slice(open + 1, close);
    if (!REWRITERS.some((r) => argument.includes(r))) continue;

    // The head is what stands before the READER, which is where an
    // assignment target can be — not before the closing bracket.
    const target = /([A-Za-z_][A-Za-z0-9_]*)\s*(?::|=)\s*$/.exec(
      src.slice(Math.max(0, start - 120), start)
    );
    const names = [
      ...[...argument.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]!),
      ...(target ? [target[1]!] : []),
    ];
    const field = names.find(isMoneyOrCount);
    if (field) out.push({ field, text: `${name}(${argument.replace(/\s+/g, ' ')})` });
  }

  return out;
}

/**
 * THE SAME STRIP, IN TWO STEPS — a local assigned from a rewrite, read as a
 * number later.
 *
 * The detector above only sees the rewrite when it is INSIDE the reader's
 * brackets, and the identical defect written over two lines is invisible to
 * it:
 *
 *     const cleaned = String(value ?? '').replace(/[^\d.-]/g, '');
 *     const n = Number(cleaned);
 *
 * That is `settlement.ts`, the courier statement reader — the file that
 * writes what a courier says it collected — and it was found by a grep after
 * the one-step law was already written and passing. A law whose own author
 * then finds a second instance by hand has not finished generating.
 *
 * AND THIS ONE CARRIES NO MONEY-NAME FILTER, which is a measurement and not
 * a preference. `cleaned` is not money, `value` is not money, and the
 * money-ness of that function lives entirely in its CALLERS (`net`,
 * `collected`, `fee`). Filtering by name here would have hidden the one site
 * that matters. It can go unfiltered because the shape is rare: TWO in the
 * whole tree, so every one of them can be named with a reason, which is the
 * one thing a list may be used for.
 */
function strippedThenReadNumbers(source: string): Finding[] {
  const src = blankComments(source);
  const stripped = new Set<string>();
  for (const m of src.matchAll(
    /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\n]*(?:\.replace\(|\.replaceAll\(|\.normalize\()[^;\n]*)/g
  )) {
    stripped.add(m[1]!);
  }
  if (stripped.size === 0) return [];
  return [...src.matchAll(/(?<![.\w])(?:Number|parseFloat|parseInt)\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g)]
    .filter((m) => stripped.has(m[1]!))
    .map((m) => ({ field: m[1]!, text: m[0]! }));
}

/* ─────────────────────────────── the sweep ──────────────────────────────── */

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const SWEPT_FILES = filesUnder(join(process.cwd(), 'src')).map((p) =>
  relative(process.cwd(), p).split(sep).join('/')
);

const sourceOf = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8');

/** A door, not a screen: the directories that can write a column. */
const isServerSide = (rel: string) => rel.startsWith('src/app/api/') || rel.startsWith('src/lib/');

/* ───────────────────────── the detectors must bite ──────────────────────── */

/**
 * THE NINE COERCED SITES, AS THEY WERE WRITTEN, in one fixture.
 *
 * Copied from the four files at `9f15044` — the commit that found them and
 * did not fix them. This is what keeps the law from going vacuous: if
 * `coercedFields` is ever broken, narrowed, or quietly satisfied by a change
 * in zod's spelling, THIS fails and says which of the nine it stopped
 * seeing. Without it the law over the tree would pass because the tree is
 * clean, and would go on passing after the detector died.
 */
const AS_IT_WAS = [
  '  items: z.array(z.object({',
  '    productId: z.string().min(10).max(64),',
  '    quantity: z.coerce.number().int().min(1).max(999),',
  '    unitPrice: z.coerce.number().min(0).max(100000),',
  '  })),',
  '  sellingPrice: z.coerce.number().finite().min(0).max(100000).optional(),',
  '  quantity: z.coerce.number().int().finite().min(1).max(10000).optional(),',
  '  discountAmount: z.coerce.number().finite().min(0).max(100000).optional(),',
  '  shippingCost: z.coerce.number().finite().min(0).max(1000).optional(),',
  '  spend: z.coerce.number().min(0).max(100_000_000).default(0),',
  '  quantity: z.coerce.number().int().min(1).max(MAX_LINE_QUANTITY),',
  '  finalPrice: z.coerce.number().min(0).max(100000),',
].join('\n');

/** The finance door's bare reads, beside the reads that are NOT the hazard. */
const FINANCE_AS_IT_WAS = [
  '  refundNum = Number(refundAmount);',
  '  if (!isFinite(refundNum) || refundNum < 0) { return bad(); }',
  '  const amt = Number(amount);',
  '  const fee = parseFloat(deliveryFee);',
  '  const units = parseInt(quantity, 10);',
  '  const total = Number(order.totalAmount);',
  '  const already = Number(order.refundAmount ?? 0);',
  '  const shown = Number(row.sellingPrice);',
].join('\n');

describe('the detectors that carry the law find the law’s own history', () => {
  it('the column names really come from the schema, and are not a handful', () => {
    expect(VOCAB.all.size, 'المفردات لم تُقرأ من المخطَّط').toBeGreaterThan(50);
    for (const column of [
      'sellingPrice', 'unitPrice', 'discountAmount', 'shippingCost', 'totalAmount',
      'basePrice', 'spend', 'deliveryFee', 'refundAmount',
      'productCost', 'packagingCost', 'advertisingCost', 'otherCost', 'discount', 'shippingRevenue',
    ]) {
      expect(VOCAB.money, column + ' ليست في مفردات المال').toContain(column);
    }
    for (const column of ['quantity', 'freeQuantity', 'quantityRemaining']) {
      expect(VOCAB.counts, column + ' ليست في مفردات الكمّيات').toContain(column);
    }
  });

  /**
   * AND THE SCHEMA ALONE IS NOT ENOUGH — the measurement that produced the
   * second rule. `finalPrice` is a field on the AI-intake confirm payload
   * and a column on no model, and it was one of the nine.
   */
  it('and the schema alone would have missed finalPrice, which is why morphology exists', () => {
    expect(VOCAB.all, 'finalPrice صار عموداً — فالقاعدة الثانية قد تكون زائدة الآن').not.toContain(
      'finalPrice'
    );
    expect(isMoneyOrCount('finalPrice'), 'finalPrice ليست مالاً عند القاعدة').toBe(true);
    // The other two the broadening catches, both real sites in the tree.
    expect(isMoneyOrCount('rawQty')).toBe(true);
    expect(isMoneyOrCount('unitCost')).toBe(true);
  });

  /**
   * AND IT MUST NOT SWALLOW EVERY INTEGER. A law that swept `sortOrder`, a
   * delivery provider's `companyId` or a page number would fail on doors
   * that are not about money at all, and the pressure would then be to add
   * exemptions — which is how a law becomes a list.
   */
  it('and neither rule swallows what is not money', () => {
    for (const notMoney of [
      'sortOrder', 'version', 'postponeCount', 'totalOrders', 'minorUnit',
      'companyId', 'originCityId', 'serviceTypeId', 'page', 'limit', 'productId',
    ]) {
      expect(isMoneyOrCount(notMoney), notMoney + ' صُنِّفَت مالاً أو كمّيةً').toBe(false);
    }
  });

  it('finds all nine coerced fields in the text that was deleted', () => {
    const found = coercedFields(AS_IT_WAS);
    expect(found.map((h) => h.field).sort()).toEqual(
      [
        'discountAmount', 'finalPrice', 'quantity', 'quantity', 'quantity',
        'sellingPrice', 'shippingCost', 'spend', 'unitPrice',
      ].sort()
    );
  });

  it('and leaves a field that is neither money nor a count alone', () => {
    expect(coercedFields('sortOrder: z.coerce.number().int().min(0).max(999)')).toEqual([]);
    expect(coercedFields('companyId: z.coerce.number().int().min(1)')).toEqual([]);
  });

  /**
   * THE IMPORTER'S PRICE READER, AS IT WAS WRITTEN, in one fixture.
   *
   * `order-import.ts` is fixed, so the tree no longer contains this line —
   * and a detector written for a defect that is gone is a detector nobody
   * can tell apart from one that sees nothing. These are the two lines the
   * importer carried at `1774a43`, beside the shapes that are NOT this
   * hazard, so the third law cannot quietly die.
   */
  const IMPORT_AS_IT_WAS = [
    '  const quantity = rawQty ? Number(rawQty) : 1;',
    "  const sellingPrice = rawPrice ? Number(String(rawPrice).replace(/[^\\d.-]/g, '')) : null;",
    "  result.price = parseFloat(value.replace(',', '.')) || null;",
    // And the shapes that are not the hazard: a rewrite with no reader, a
    // reader with no rewrite, and a rewrite on something that is not money.
    "  const label = name.replace(/\\s+/g, ' ');",
    '  const total = Number(order.totalAmount);',
    "  const slug = Number(title.replace(/[^0-9]/g, ''));",
  ].join('\n');

  it('finds a price read through a strip, which no identifier pattern could see', () => {
    const found = rewrittenNumberReads(IMPORT_AS_IT_WAS);
    // `value` and not `price` on the second: `CommissionRule.value` is a
    // `Decimal` column, so the schema leg names that one before the
    // assignment target is reached. Which name is reported hardly matters —
    // that the site is SEEN is the law. The target leg has its own test
    // below, on an argument that names nothing.
    expect(found.map((h) => h.field)).toEqual(['rawPrice', 'value']);
    // Law two is blind to exactly this, which is why law three exists.
    expect(
      bareNumberReads(IMPORT_AS_IT_WAS).map((h) => h.text),
      'النمطُ المُعرَّفُ بالاسمِ رأى تعبيراً — فقد تغيّر معناه'
    ).toEqual(['Number(rawQty)']);
  });

  it('and it is the REWRITE it keys on, not the brackets', () => {
    // A reader whose argument is an expression but rewrites nothing is
    // arithmetic, and arithmetic is not this law's business.
    expect(rewrittenNumberReads('const amount = Number(a.price * b.quantity);')).toEqual([]);
    expect(rewrittenNumberReads("const label = sku.replace('-', '');")).toEqual([]);
    expect(rewrittenNumberReads("const slug = Number(title.replace('x', ''));")).toEqual([]);
  });

  it('and it reads the assignment target as well as the argument', () => {
    // Nothing on the right names money; `price` on the left does. This is a
    // real site in the tree and a pattern that only looked right misses it.
    expect(rewrittenNumberReads("price = parseFloat(v.replace(',', '.'))").map((h) => h.field)).toEqual([
      'price',
    ]);
    expect(rewrittenNumberReads("unitCost: Number(c.replace('x',''))").map((h) => h.field)).toEqual([
      'unitCost',
    ]);
  });

  it('and all three of its legs are generated, not listed', () => {
    // A column invented here is in the law at once, because the vocabulary
    // is the schema — this one is a real column and not a name chosen to
    // suit the test.
    expect(VOCAB.money, 'العمودُ لم يُقرأْ من المخطَّط').toContain('shippingCost');
    expect(rewrittenNumberReads("x = Number(shippingCost.replace('a',''))")).toHaveLength(1);
    // Morphology, for a field that is money and is no column at all.
    expect(VOCAB.all).not.toContain('finalPrice');
    expect(rewrittenNumberReads("x = Number(finalPrice.replace('a',''))")).toHaveLength(1);
    // And each of the three rewriters, so none of them is a dead string.
    for (const rewriter of ['replace', 'replaceAll', 'normalize']) {
      expect(
        rewrittenNumberReads(`x = Number(sellingPrice.${rewriter}('a',''))`),
        rewriter + ' لا يُرى'
      ).toHaveLength(1);
    }
  });

  it('and it is not fooled by a docblock quoting the line it was written for', () => {
    const quoted = [
      '/**',
      " * It read Number(String(rawPrice).replace(/[^d.-]/g, '')) and that",
      ' * is the defect being described, not committed.',
      ' */',
      "// const price = parseFloat(amount.replace(',', '.'));",
      'const clean = 1;',
    ].join('\n');
    expect(rewrittenNumberReads(quoted)).toEqual([]);
  });

  it('finds the finance door’s bare reads, and none of its property reads', () => {
    const found = bareNumberReads(FINANCE_AS_IT_WAS).map((h) => h.text);
    expect(found).toEqual([
      'Number(refundAmount)',
      'Number(amount)',
      'parseFloat(deliveryFee)',
      'parseInt(quantity,',
    ]);
    // The dot is the whole difference, so these three must be absent.
    expect(found.join(' ')).not.toContain('order.');
    expect(found.join(' ')).not.toContain('row.');
  });

  it('and neither detector is fooled by a docblock that quotes the defect', () => {
    const quoted = [
      '/**',
      ' * This used to read quantity: z.coerce.number().int() and',
      ' * Number(refundAmount), which is the defect being described.',
      ' */',
      '// spend: z.coerce.number() — and this line is a comment too',
      'const clean = 1;',
    ].join('\n');
    expect(coercedFields(quoted)).toEqual([]);
    expect(bareNumberReads(quoted)).toEqual([]);
  });

  it('and the sweep really walks the tree', () => {
    expect(SWEPT_FILES.length, 'المسح لم يجد ملفّات').toBeGreaterThan(200);
    expect(SWEPT_FILES).toContain('src/app/api/orders/route.ts');
    expect(SWEPT_FILES).toContain('src/app/api/orders/[id]/route.ts');
    expect(SWEPT_FILES).toContain('src/lib/campaigns.ts');
    expect(SWEPT_FILES.filter(isServerSide).length).toBeGreaterThan(100);
  });
});

/* ──────────────────────────────── law one ───────────────────────────────── */

describe('no money or quantity field is read with z.coerce.number(), anywhere', () => {
  /**
   * This law has NO exemption list, because `z.coerce.number()` has no safe
   * use on money or a count. A door wanting an unbounded number has
   * `numeric()`; one wanting no coercion at all has `z.number()`, which is
   * what the commission rate uses on purpose. Both remain available. What is
   * gone is `Number()` wearing a schema.
   */
  it('and the sweep over the whole tree is empty', () => {
    const offenders: string[] = [];
    for (const rel of SWEPT_FILES) {
      for (const hit of coercedFields(sourceOf(rel))) offenders.push(rel + ': ' + hit.text);
    }
    expect(
      offenders,
      'حقلُ مالٍ أو كمّيةٍ يُقرَأُ بـz.coerce.number() — وهي Number() بعينها'
    ).toEqual([]);
  });

  /** And `z.coerce.number()` really is `Number()` — measured, not assumed. */
  it('because z.coerce.number() is Number(), which is the premise of the law', () => {
    const coerce = z.coerce.number();
    expect(coerce.safeParse('0x10')).toMatchObject({ success: true, data: 16 });
    expect(coerce.safeParse('0b11')).toMatchObject({ success: true, data: 3 });
    expect(coerce.safeParse('0o17')).toMatchObject({ success: true, data: 15 });
    expect(coerce.safeParse(null)).toMatchObject({ success: true, data: 0 });
    expect(coerce.safeParse([])).toMatchObject({ success: true, data: 0 });
    expect(coerce.safeParse(['5'])).toMatchObject({ success: true, data: 5 });
    expect(coerce.safeParse(true)).toMatchObject({ success: true, data: 1 });
    expect(coerce.safeParse(new Date(0))).toMatchObject({ success: true, data: 0 });
    expect(coerce.safeParse({ valueOf: () => 7 })).toMatchObject({ success: true, data: 7 });
    // And the one it refuses, so the difference from the rule is exact.
    expect(coerce.safeParse('abc').success).toBe(false);
  });

  /** While the strict readers refuse the whole table. */
  it('while count() and money() refuse every value in it', () => {
    const table: unknown[] = [
      '0x10', '0b11', '0o17', '1e400', '', '   ', null, [], ['5'], true,
      new Date(0), { valueOf: () => 7 },
    ];
    for (const reader of [count(999, 1), money(100_000)]) {
      for (const value of table) {
        expect(reader.safeParse(value).success, 'القارئُ الصارمُ قَبِلَ «' + String(value) + '»').toBe(
          false
        );
      }
    }
  });
});

/* ──────────────────────────────── law two ───────────────────────────────── */

/**
 * A MONEY-OR-COUNT VALUE HANDED BARE TO `Number()` IN SERVER CODE —
 * CLASSIFIED, WITH THE REASON WRITTEN OUT.
 *
 * This side is partitioned rather than emptied, for the reason
 * `every-money-writer-is-known.test.ts` gives: whether an identifier is a
 * request field or a local that happens to share a column's name is
 * semantic, and the syntax does not carry it. A detector known to be wrong
 * in both directions is worse than a human classification with a reason a
 * reviewer can check. What IS machine-checked is the part that fails open —
 * a NEW bare read, in any server file, is an unclassified stranger.
 *
 * AND THERE ARE TWO SIDES TO THE CLASSIFICATION, NOT ONE. A reading-side
 * list where every entry means «this is fine» is a list that can quietly
 * absorb a defect — `every-money-writer-is-known.test.ts` carried a reason
 * that was not true for weeks. So a site this law FINDS and that is NOT fine
 * goes on a separate list that says so, with the figures it produces.
 *
 * COMPONENTS ARE OUT OF THIS SWEEP, as a directory rule and not a list of
 * files. `src/components/**` holds ten of these (`Number(amount)` in the
 * wallet screens, `Number(quantity)` in receiving) and not one can write a
 * column: each posts to a door, and the door is in this sweep. A screen
 * computing a display figure from its own input is doing arithmetic, not
 * validation.
 */
const BARE_READS_WITH_A_REASON: Record<string, string> = {
  'src/lib/partner-statement-core.ts':
    'يقرأ نسبة شريك من خانةٍ بالمتصفّح أو من طلب: النصّ يُفحَص أولاً بتعبيرٍ نمطيٍّ لعددٍ عشريٍّ عاديٍّ بحت (فلا «0x10» ولا «1e1» ولا «2,5» ولا فراغ) ثم يُقرأ، والنتيجة تُحكَم بنطاق (0، 100] وبمنزلتين عشريتين على الأكثر — هو القارئُ الصارمُ نفسُه مكتوباً لحزمة متصفّح لا تستورد zod، وبابُ الحفظ يمرّ بـnumeric-input قبله أصلاً. وليست نسبةً مالاً: لا تُكتَب بعمود مبلغ',
  'src/app/api/users/[id]/profile/route.ts':
    'يُحوِّلُ Decimal مخزَّناً إلى رقمٍ ليُرسِلَه في JSON — قراءةُ عمودٍ لا كتابتُه، والقيمةُ لم تأتِ من طلبٍ أصلاً',
  'src/lib/campaigns.ts':
    'المعامِلُ مُعلَنٌ number سلفاً، وNumber()||0 هنا حارسُ NaN: عمودُ numeric في بوستغرس يَقبَلُ NaN وإن كان بريزما يَرفُضُ كتابتَها',
  'src/lib/order-parser.ts':
    'value هنا التقاطُ تعبيرٍ نمطيٍّ من نصٍّ مكتوبٍ بيدٍ لا حقلُ طلبٍ، والاسمُ يَتصادَمُ مع عمودِ CommissionRule.value؛ وما يُنتِجُه يَمُرُّ بمخطَّطِ باب ai-intake قبل أن يُكتَب',
};

/**
 * FOUND BY THIS LAW, MEASURED, AND STILL OPEN — not «acceptable».
 *
 * EMPTY, AND THE MECHANISM STAYS. It held one entry:
 * `src/lib/order-import.ts`, whose quantity read `Number(rawQty)` so «0x10»
 * imported as sixteen units, and whose price read
 * `Number(String(rawPrice).replace(…))` so «3,5» imported as 35 and «٣٥٠٠»
 * — three thousand five hundred typed on an Arabic keypad — imported as a
 * price of ZERO. The create door could not help, because the screen posts
 * the figure the importer already produced.
 *
 * It reads through `readTypedFigure` now, a cell it cannot read refuses its
 * own row with the cell quoted back, and an Arabic-Indic figure is ACCEPTED
 * rather than stripped. The entry is gone because the site is fixed, which
 * is the only reason an entry may leave this list — the two tests below
 * enforce that in both directions, so a name cannot linger after a fix and a
 * fix cannot be claimed while the read is still there.
 *
 * The figures and the whole import path are measured in
 * `an-unreadable-cell-is-not-a-price-of-zero.test.ts` and
 * `an-import-row-reaches-the-door.test.ts`.
 */
const FOUND_AND_STILL_OPEN: Record<string, string> = {};

describe('every bare Number() on money or a count is accounted for', () => {
  const swept = SWEPT_FILES.filter(isServerSide).filter(
    (rel) => bareNumberReads(sourceOf(rel)).length > 0
  );

  it('and not one of them is an unclassified stranger', () => {
    const known = new Set([
      ...Object.keys(BARE_READS_WITH_A_REASON),
      ...Object.keys(FOUND_AND_STILL_OPEN),
    ]);
    const strangers = swept.filter((rel) => !known.has(rel));
    expect(
      strangers,
      'بابٌ يَقرأُ مالاً أو كمّيةً بـNumber() عاريةً ولم يُصنَّف — إمّا أن يَقرأَ بـnumeric-input، أو أن يُقالَ لماذا لا يحتاجُه، أو أن يُسمّى عطباً مفتوحاً'
    ).toEqual([]);
  });

  it('and neither list has gone stale by naming a file that no longer reads one', () => {
    const live = new Set(swept);
    const ghosts = [
      ...Object.keys(BARE_READS_WITH_A_REASON),
      ...Object.keys(FOUND_AND_STILL_OPEN),
    ].filter((rel) => !live.has(rel));
    expect(ghosts, 'اسمٌ في القائمة لا يَظهَرُ في المسح').toEqual([]);
  });

  it('and every reason is a sentence a reviewer can check, not a shrug', () => {
    for (const [rel, why] of Object.entries({
      ...BARE_READS_WITH_A_REASON,
      ...FOUND_AND_STILL_OPEN,
    })) {
      expect([...why].length, rel + ': السببُ أقصرُ من أن يُراجَع').toBeGreaterThan(40);
    }
  });

  /** And a file cannot be on both lists, which would be a reason both ways. */
  it('and no file is both classified as fine and recorded as open', () => {
    const both = Object.keys(FOUND_AND_STILL_OPEN).filter((rel) => rel in BARE_READS_WITH_A_REASON);
    expect(both, 'ملفٌّ مُصنَّفٌ سليماً ومعطوباً في الوقت نفسِه').toEqual([]);
  });

  /**
   * AND THE ONE ENTRY THIS LIST EVER HELD IS GONE BECAUSE THE SITE IS.
   *
   * This test used to measure the importer's figures so the entry was a fact
   * and not a recollection, and it was written so that the day somebody
   * fixed that file it would fail and force the entry out. That day came.
   * What stands in its place is the same demand pointed the other way: the
   * two reads are not in the file, and the file reaches the shared reader —
   * asserted on the CALL and not on the import line, because an import line
   * has satisfied a guard in this repository four times while the thing it
   * named was gone.
   */
  it('and the importer, the one entry it ever held, reads through numeric-input now', () => {
    const rel = 'src/lib/order-import.ts';
    const src = blankComments(sourceOf(rel));
    expect(src, 'الكميّةُ عادت إلى Number() عارية').not.toMatch(/Number\(rawQty\)/);
    expect(src, 'الحشوُ عاد').not.toMatch(/Number\(String\(rawPrice\)\.replace\(/);
    expect(bareNumberReads(src).map((h) => h.text), rel).toEqual([]);
    expect(rewrittenNumberReads(src).map((h) => h.text), rel).toEqual([]);
    expect(src, rel + ': لا يَصِلُ القارئَ المشترك').toMatch(/readTypedFigure\(\s*raw/);
  });

  /**
   * AND THE DOORS THIS LAW WAS WRITTEN FOR CARRY NO BARE READ AT ALL — the
   * finance door had three of them and is the reason the law exists.
   */
  it('and the finance door, which had three, has none', () => {
    const rel = 'src/app/api/orders/[id]/finance/route.ts';
    expect(bareNumberReads(sourceOf(rel)).map((h) => h.text), rel).toEqual([]);
    // And it reaches the shared reader instead — the CALL, not the import,
    // because an import line has satisfied a guard here four times while the
    // thing it named was gone.
    expect(blankComments(sourceOf(rel))).toMatch(/moneyInput\(\s*[0-9_]/);
  });

  /* ─────────────────────────── law three ──────────────────────────────── */

  /**
   * NO MONEY OR COUNT IS REWRITTEN ON ITS WAY INTO A NUMBER.
   *
   * The whole tree, components included — and components are IN this sweep
   * although law two excludes them, because the hazard is a different one. A
   * screen doing arithmetic on its own input cannot write a column, which is
   * why law two lets it be; a screen that STRIPS a cell and posts the result
   * hands the door a well-formed number and the door has nothing to refuse.
   * That is precisely how the importer's defect reached Prisma, and the
   * directory a file sits in does not change it.
   */
  const rewritten = SWEPT_FILES.flatMap((rel) =>
    rewrittenNumberReads(sourceOf(rel)).map((hit) => `${rel}: ${hit.text}`)
  );

  /**
   * THE ONE SITE THE SWEEP FINDS, CLASSIFIED WITH ITS REASON — and
   * classified on the LINE, not the file, so a second rewrite added to the
   * same file is a stranger.
   *
   * `order-parser.ts` reads a price out of a pasted order message with
   * `parseFloat(value.replace(',', '.'))`, and `value` is the capture of
   * `/([0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?)/` AFTER `latinFigure` has
   * translated it digit for digit (and «٫» to «.») — 22/10, when the owner
   * asked for the digits of an AI entry to be made Latin in code. The replace
   * therefore CANNOT delete anything: the only characters in the string are
   * digits and one separator, and swapping that separator for a point is a
   * translation of an already-checked shape rather than a strip of an unknown
   * one. Which is the exact difference from the importer: there the class
   * deleted characters nobody had checked for, and Arabic-Indic digits were
   * among them — here they are translated, never dropped.
   */
  const REWRITES_WITH_A_REASON: Record<string, string> = {
    "src/lib/order-parser.ts: parseFloat(value.replace(',', '.'))":
      'الخليّةُ فُحِصَت قبلَ الاستبدال: value هو التقاطُ ‎/([0-9٠-٩۰-۹]+(?:[.,٫][0-9٠-٩۰-۹]+)?)/‎ تُرجِمَت أرقامُه إلى اللاتينيّة رقماً برقمٍ وفاصلُه العربيُّ إلى نقطةٍ (`latinFigure`) فلا يحوي إلّا أرقاماً لاتينيّةً وفاصلاً واحداً، واستبدالُ الفاصلِ بنقطةٍ ترجمةُ شكلٍ مُتحقَّقٍ منه لا حشوُ شكلٍ مجهول — ولا يمكنه حذفَ محرفٍ واحدٍ لأنّ ما عداه لم يُلتَقَطْ أصلاً',
  };

  it('and the sweep over the whole tree holds no unclassified rewrite', () => {
    const strangers = rewritten.filter((hit) => !(hit in REWRITES_WITH_A_REASON));
    expect(
      strangers,
      'مالٌ أو كمّيةٌ تُعادُ كتابتُها قبلَ قراءتِها رقماً — والحشوُ لا يَرفُضُ بل يُنتِجُ رقماً آخرَ يَمُرُّ بكلِّ فحصٍ بعدَه. اقرأْ بـnumeric-input، أو قُلْ لماذا الشكلُ مُتحقَّقٌ منه سلفاً'
    ).toEqual([]);
  });

  it('and the reason given has not gone stale on a line that no longer exists', () => {
    const live = new Set(rewritten);
    const ghosts = Object.keys(REWRITES_WITH_A_REASON).filter((hit) => !live.has(hit));
    expect(ghosts, 'سببٌ لسطرٍ لم يَعُدْ موجوداً').toEqual([]);
  });

  it('and the importer is not on it, under any spelling', () => {
    expect(rewritten.filter((h) => h.startsWith('src/lib/order-import.ts'))).toEqual([]);
    expect(Object.keys(REWRITES_WITH_A_REASON).join(' ')).not.toContain('order-import');
  });

  /* ───────────── law three, second leg: the strip over two lines ───────── */

  const twoStep = SWEPT_FILES.flatMap((rel) =>
    strippedThenReadNumbers(sourceOf(rel)).map((hit) => `${rel}: ${hit.text}`)
  );

  /**
   * ONE SITE LEFT, CLASSIFIED — AND THE SECOND ONE IS FIXED, NOT EXCUSED.
   *
   * This list held two entries, and the second was the sharp one:
   * `src/lib/settlement.ts: Number(cleaned)`, the courier-statement reader.
   * `toNumber` there turned the `net`, `collected` and `fee` columns of a
   * courier's own CSV into the money this system settles against, by the
   * identical strip the order importer carried. MEASURED on it, the day it
   * was recorded here:
   *
   *     '٣٥٠٠'    -> null    REFUSED — the empty result was caught, which is
   *                          the one guard the order importer did not have.
   *                          And the caller then did `continue`, so the
   *                          parcel left the statement in SILENCE.
   *     '3,5'     -> 35      ten times, exactly as the importer did
   *     '3,500'   -> 3500    right, by accident of the same strip
   *     '1e400'   -> 1400       '0x10' -> 10       '12abc' -> 12
   *     '(50)'    -> 50      AN ACCOUNTING NEGATIVE LOST ITS SIGN — a
   *                          deduction on a statement became a credit
   *     '50-'     -> null       '12 345' -> 12345
   *
   * It read through `readStatementFigure` now — `readTypedFigure`'s grammar
   * plus the one notation a courier's accounting export adds — and an
   * unreadable cell refuses the whole file with the row named and the cell
   * quoted. The entry is gone because the site is, which is the only reason
   * an entry may leave a list in this file; the test below is the same
   * demand pointed the other way, and the stale-name test above makes
   * leaving it here a failure too. The figures and the sign are measured in
   * `a-bracketed-negative-is-a-deduction.test.ts`.
   */
  const TWO_STEP_CLASSIFIED: Record<string, string> = {
    'src/lib/order-parser.ts: parseInt(value,':
      'الاستبدالُ هنا يُزيلُ قوسين محيطين فقط من التقاطِ أرقامٍ (‎/([0-9٠-٩۰-۹]+)/‎ — تُترجَمُ إلى اللاتينيّة رقماً برقمٍ قبل الاستبدال) — شكلٌ فُحِصَ قبلَه فلا يُحذَفُ منه محرفٌ ذو معنى، وما يُنتِجُه يَمُرُّ بمخطَّطِ باب ai-intake قبل الكتابة',
  };

  it('and every two-step strip in the tree is named, with its reason', () => {
    const strangers = twoStep.filter((hit) => !(hit in TWO_STEP_CLASSIFIED));
    expect(
      strangers,
      'نصٌّ يُحشى في سطرٍ ويُقرَأُ رقماً في سطرٍ آخرَ ولم يُصنَّف — وهو الحشوُ نفسُه موزَّعاً على سطرين'
    ).toEqual([]);
  });

  it('and neither name has gone stale', () => {
    const live = new Set(twoStep);
    expect(
      Object.keys(TWO_STEP_CLASSIFIED).filter((hit) => !live.has(hit)),
      'سببٌ لسطرٍ لم يَعُدْ موجوداً'
    ).toEqual([]);
  });

  /** And the detector bites: the deleted line, and the shapes that are not it. */
  it('and the two-step detector finds the statement reader as it stands', () => {
    const fixture = [
      "  const cleaned = String(value ?? '').replace(/[^\\d.-]/g, '');",
      '  const n = Number(cleaned);',
      // Not this: a rewrite whose result is never read as a number.
      "  const label = name.replace('-', ' ');",
      // Nor this: a read of a local that was never rewritten.
      '  const plain = Number(raw);',
    ].join('\n');
    expect(strippedThenReadNumbers(fixture).map((h) => h.text)).toEqual(['Number(cleaned)']);
    expect(strippedThenReadNumbers('const n = Number(raw);')).toEqual([]);
    expect(strippedThenReadNumbers("const c = s.replace('a','');")).toEqual([]);
  });

  /**
   * AND THE ENTRY THAT LEFT IS MEASURED BOTH WAYS.
   *
   * The figures the old code produced are still computed here, from a copy
   * of that function, so the record above stays a fact rather than a
   * recollection — and the file is then checked to no longer contain it, and
   * to reach the shared reader instead. Asserted on the CALL and not on the
   * import line, because an import line has satisfied a guard in this
   * repository four times while the thing it named was gone.
   */
  it('and the entry that left did so because the strip is gone from that file', () => {
    const asItWas = (value: unknown) => {
      const cleaned = String(value ?? '').replace(/[^\d.-]/g, '');
      if (!cleaned) return null;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : null;
    };
    expect(asItWas('3,5'), 'فاصلةٌ عشريّةٌ في كشفِ مندوبٍ كانت تُصبِحُ عشرةَ أضعاف').toBe(35);
    expect(asItWas('(50)'), 'خصمٌ بين قوسين كان يُصبِحُ دائناً').toBe(50);
    expect(asItWas('1e400')).toBe(1400);
    expect(asItWas('0x10')).toBe(10);
    expect(asItWas('12abc')).toBe(12);
    expect(asItWas('٣٥٠٠'), 'الأرقامُ العربيّةُ كانت مرفوضةً هنا لا مُصفَّرة').toBeNull();

    const rel = 'src/lib/settlement.ts';
    const src = blankComments(sourceOf(rel));
    expect(src, 'الحشوُ عاد').not.toMatch(/replace\(\/\[\^\\d\.-\]\/g, ''\)/);
    expect(src, 'اسمُ الدالّةِ المحشوَّةِ عاد').not.toMatch(/function toNumber\(/);
    expect(strippedThenReadNumbers(src).map((h) => h.text), rel).toEqual([]);
    expect(rewrittenNumberReads(src).map((h) => h.text), rel).toEqual([]);
    expect(src, rel + ': لا يَصِلُ القارئَ المشترك').toMatch(/readStatementFigure\(text\)/);
  });

  it('and so do the other four doors on these columns', () => {
    for (const rel of [
      'src/app/api/orders/[id]/route.ts',
      'src/app/api/orders/ai-intake/route.ts',
      'src/lib/landing-order-schema.ts',
      'src/app/api/orders/route.ts',
    ]) {
      expect(bareNumberReads(sourceOf(rel)).map((h) => h.text), rel).toEqual([]);
      expect(blankComments(sourceOf(rel)), rel + ': لا يستورد القارئ المشترك').toMatch(
        /from '@\/lib\/numeric-input'/
      );
    }
  });
});

/* ───────────────── and the bounds, where the doors can be compared ─────── */

/**
 * ONE COLUMN, ONE BOUND — EXCEPT WHERE THE DISAGREEMENT IS DECLARED.
 *
 * A shared reader fixes the NOTATION. It does not fix the CEILING, and two
 * doors can read one column strictly and still disagree about how large it
 * may be — which is what `quantity` did: `count(999, 1)` on the create door
 * and `max(10000)` on the edit door, eleven times higher and declared
 * nowhere else.
 *
 * So the ceilings the two order doors declare are compared here directly.
 * The one deliberate disagreement is `shippingCost`, and it is asserted AS a
 * disagreement, so that closing it in either direction fails this test and
 * makes somebody say which way.
 */
describe('the two order doors, bound by bound', () => {
  const create = blankComments(sourceOf('src/app/api/orders/route.ts'));
  const edit = blankComments(sourceOf('src/app/api/orders/[id]/route.ts'));

  const boundOn = (src: string, field: string): string | null => {
    const m = new RegExp('\\b' + field + ':\\s*(count|amount|money|moneyInput)\\(([^)]*)\\)').exec(src);
    return m ? m[1] + '(' + m[2]!.replace(/\s+/g, '') + ')' : null;
  };

  it('agree exactly on a quantity and on a price', () => {
    expect(boundOn(create, 'quantity'), 'create: quantity').toBe('count(999,1)');
    expect(boundOn(edit, 'quantity'), 'edit: quantity').toBe('count(999,1)');
    expect(boundOn(create, 'unitPrice')).toBe('amount(100000)');
    expect(boundOn(edit, 'unitPrice')).toBe('amount(100000)');
    expect(boundOn(create, 'sellingPrice')).toBe('amount(100000)');
    expect(boundOn(edit, 'sellingPrice')).toBe('amount(100000)');
  });

  it('and disagree on the shipping fee, on purpose and on the record', () => {
    expect(boundOn(create, 'shippingCost'), 'create: shippingCost').toBe('amount(1000)');
    expect(boundOn(edit, 'shippingCost'), 'edit: shippingCost').toBe('amount(1_000_000)');
    // The edit door's figure is borrowed, not invented: it is what the door
    // that owns the courier fee declares for the same economic quantity.
    expect(blankComments(sourceOf('src/app/api/orders/[id]/shipping/route.ts'))).toMatch(
      /deliveryFee:\s*moneyInput\(1_000_000\)/
    );
    // And a Syrian shipping fee of 25,000 is the case that splits them.
    expect(money(1000).safeParse(25_000).success, 'the create door takes 25000').toBe(false);
    expect(money(1_000_000).safeParse(25_000).success, 'the edit door refuses 25000').toBe(true);
  });
});
