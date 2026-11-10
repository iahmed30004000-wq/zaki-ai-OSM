/**
 * THE RATE A PERSON THINKS IN, AND THE AMOUNT THE BOOKS KEEP.
 *
 * A transfer between two currencies is one deal with three faces: what left
 * («المحوَّل»), what arrived («المستلم»), and the rate between them. The
 * owner holds a different one of the three each time — an exchange shop's
 * board says «13,000 ليرة لكل دولار», a bank slip says «استلمت 1,290,000», a
 * friend says «الدولار بـ12,900». Making him turn the one he holds into the
 * one the screen wants («أروح للحاسبة وأقسم وأضرب») is how a rate gets typed
 * upside down and a thousand dollars becomes a thousandth of one.
 *
 * So the screen takes any of the three, and this file is the ONE place that
 * turns them into the other two. The screen draws it, the route judges it,
 * and both call the same functions — which is what makes «the number on the
 * card» and «the number that was written» the same number by construction.
 *
 * ── THE AMOUNT IS THE RECORD; THE RATE IS ABOUT IT ──
 *
 * `WalletTransfer.exchangeRate` is `Decimal(14,6)`. SYP→USD in the form the
 * column holds (units of the destination per one of the source) is
 * 1/13000 = 0.0000769230…, which the column keeps as 0.000077 — a 0.1 %
 * error if ANYTHING multiplied that stored figure back into money. Nothing
 * does, and nothing may: `amountIn` is the authoritative number, it is what
 * the arriving movement carries, and the stored rate is derived from the two
 * amounts and is only there to be read.
 *
 * Nothing in here touches the database or the screen. Every function takes
 * numbers and says what it makes of them, so every figure can be checked by
 * hand.
 */
import { roundMinor } from './money';
import { CURRENCIES } from './currencies';
import { toLatinDigits } from './latin-digits';

/* ───────────────────────── which of two currencies is «the strong one» ───────────────────────── */

/**
 * HOW MANY UNITS OF EACH BUY ONE US DOLLAR — only so the screen can decide
 * which of two currencies a person calls «the strong one».
 *
 * Only the ORDER matters, never the value: the strong one is the one with
 * fewer units per dollar, and the rate is always said as «units of the weak
 * one for one of the strong one» («13,000 ليرة لكل دولار», never «0.000077
 * دولار لكل ليرة»). These are not rates anybody trades at and nothing
 * converts money with them.
 */
export const UNITS_PER_USD: Readonly<Record<string, number>> = {
  USD: 1,
  JOD: 0.71,
  EUR: 0.93,
  SAR: 3.75,
  AED: 3.67,
  TRY: 32,
  EGP: 48,
  IQD: 1310,
  SYP: 13000,
  // The rest of the list in `currencies.ts`, so a country added there has an orientation too.
  KWD: 0.31,
  BHD: 0.38,
  OMR: 0.38,
  QAR: 3.64,
  LBP: 89500,
  LYD: 4.8,
  TND: 3.1,
  MAD: 10,
  DZD: 135,
};

/** A code nobody listed is read as «weaker than the dollar» — the brief's rule — and above nothing else. */
const UNKNOWN_UNITS = 2;

const code = (c: string) => c.trim().toUpperCase();

/** A transfer already made between a pair, as the history carries it: `rate` is units of `to` per one of `from`. */
export interface PreviousRate {
  from: string;
  to: string;
  rate: number;
}

export interface Orientation {
  /** The currency with fewer units per dollar: the one the rate is said «per one of». */
  strong: string;
  /** The other. */
  weak: string;
}

/**
 * WHICH OF THE TWO IS STRONG.
 *
 * Both known: fewer units per dollar wins, and a tie goes to the earlier
 * code, so the answer is the same whichever way round the question is asked
 * — swapping the two wallets must not turn a screen's «ليرة لكل دولار» into
 * «دولار لكل ليرة».
 *
 * A code that is not in the table: the latest previous transfer between this
 * very pair says it (a rate above 1 means the destination counts in more
 * units, so the destination is the weaker); with none, the unknown one is
 * read as weaker than the dollar. A wrong guess costs one press of the A/B
 * switch, never money: the card says what the deal is before it is saved.
 */
export function orientation(a: string, b: string, previous: readonly PreviousRate[] = []): Orientation {
  const x = code(a);
  const y = code(b);
  const ux = UNITS_PER_USD[x];
  const uy = UNITS_PER_USD[y];

  if ((ux === undefined || uy === undefined) && x !== y) {
    for (const p of previous) {
      const pf = code(p.from);
      const pt = code(p.to);
      const samePair = (pf === x && pt === y) || (pf === y && pt === x);
      if (!samePair || !Number.isFinite(p.rate) || !(p.rate > 0) || p.rate === 1) continue;
      const fromIsStrong = p.rate > 1;
      const strongCode = fromIsStrong ? pf : pt;
      return strongCode === x ? { strong: a, weak: b } : { strong: b, weak: a };
    }
  }

  const vx = ux ?? UNKNOWN_UNITS;
  const vy = uy ?? UNKNOWN_UNITS;
  const xIsStrong = vx < vy || (vx === vy && x <= y);
  return xIsStrong ? { strong: a, weak: b } : { strong: b, weak: a };
}

/**
 * THE SHORT WORD FOR A CURRENCY IN A QUOTE — «دولار», «ليرة», «دينار».
 *
 * Read from the names `currencies.ts` already holds (first word of «دولار
 * أمريكي»), so there is no second table of names to drift. Two currencies
 * that share a first word («ليرة سورية» and «ليرة لبنانية») are told apart
 * by the whole name, because «ليرة لكل ليرة» is a sentence nobody can use.
 * A code that is not on the list is its own name.
 */
export function currencyWord(currencyCode: string, other?: string): string {
  const c = CURRENCIES.find((x) => x.code === code(currencyCode));
  if (!c) return currencyCode;
  const first = c.ar.split(' ')[0];
  const o = other ? CURRENCIES.find((x) => x.code === code(other)) : undefined;
  return o && o.ar.split(' ')[0] === first ? c.ar : first;
}

/* ───────────────────────── a figure typed in a box ───────────────────────── */

/**
 * WHAT A BOX SHOWS WHILE IT IS TYPED INTO: the digits, the decimal point and the thousands separator an Arabic
 * keyboard types (٣٫٥ · ١٬٢٩٠٬٠٠٠) as the ASCII the rest of the product reads. Nothing else changes.
 */
export function latinFigure(text: string): string {
  return toLatinDigits(text).replace(/٫/g, '.').replace(/٬/g, ',');
}

/**
 * WHAT A BOX HOLDS, AS A NUMBER — or `null` for «nothing», or «not a figure».
 *
 * An Arabic keyboard types ٣٫٥ and a bank slip prints 1,290,000. Both are
 * read; «3,5» is not (a comma with no thousands behind it could be either
 * a decimal or a typo, and a rate is no place to guess). Never a thousands
 * separator that is not in groups of three, never two points, never a sign.
 */
export function parseTyped(text: string): number | null {
  const s = latinFigure(text).replace(/\s/g, '');
  if (s === '') return null;
  const grouped = /^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s);
  const plain = /^(\d+(\.\d*)?|\.\d+)$/.test(s);
  if (!grouped && !plain) return null;
  const n = Number(grouped ? s.replace(/,/g, '') : s);
  return Number.isFinite(n) ? n : null;
}

/* ───────────────────────── a deal, from whichever face the person holds ───────────────────────── */

/**
 * A QUOTE: `value` units of the OTHER currency for ONE unit of `per`.
 *
 * It is tied to a currency, never to a direction. «13,000 ليرة لكل دولار» is
 * `{ per: 'USD', value: 13000 }` whether the dollars are leaving or arriving —
 * which is the point: the same board number is typed once and the system
 * decides whether to multiply or divide.
 */
export interface Quote {
  per: string;
  value: number;
}

export interface DealEnds {
  /** The currency that leaves. */
  from: string;
  /** The currency that arrives. */
  to: string;
}

/**
 * WHAT ARRIVES, FROM WHAT LEFT AND A QUOTE — rounded once, to the arriving currency's own decimals.
 *
 * `per` is the currency that leaves: one of it is worth `value` of the other,
 * so the amount is multiplied. `per` is the one that arrives: one of THAT is
 * worth `value` of what left, so the amount is DIVIDED by it. Division and not
 * «multiply by the inverse»: two roundings (the inverse, then the product)
 * drift by a unit in the last place and decide a half-way case the wrong way.
 *
 * `null` when it cannot be said (no amount, no quote, a quote of a currency
 * that is in neither wallet); `0` when the figure is real but rounds to
 * nothing — the caller names that case, because it is a refusal and not a blank.
 */
export function amountInFromQuote(
  ends: DealEnds,
  amountOut: number,
  quote: Quote,
  toMinorUnit: number
): number | null {
  if (!Number.isFinite(amountOut) || !(amountOut > 0)) return null;
  if (!Number.isFinite(quote.value) || !(quote.value > 0)) return null;
  const per = code(quote.per);
  let raw: number;
  if (per === code(ends.from)) raw = amountOut * quote.value;
  else if (per === code(ends.to)) raw = amountOut / quote.value;
  else return null;
  if (!Number.isFinite(raw)) return null;
  return roundMinor(raw, toMinorUnit);
}

/**
 * THE QUOTE FOR THE TWO FACES A PERSON TYPES A RATE IN.
 *
 * `A` — «ليرة لكل 1 دولار»: units of the weak one per one of the strong one.
 * `B` — «دولار لكل 1 ليرة»: the inverse, units of the strong one per one of the weak.
 */
export function quoteOf(face: 'A' | 'B', value: number, o: Orientation): Quote {
  return { per: face === 'A' ? o.strong : o.weak, value };
}

/**
 * THE ONE RATE THE CARD SAYS, FROM THE TWO AMOUNTS — always «weak per one strong».
 *
 * Worked from what actually left and what actually arrived, so it is true of
 * the money whichever face the person typed. `strongPerWeak` is the inverse,
 * for the small line under it.
 */
export function displayRate(
  ends: DealEnds,
  amountOut: number,
  amountIn: number,
  o: Orientation
): { weakPerStrong: number; strongPerWeak: number } | null {
  if (!(amountOut > 0) || !(amountIn > 0) || !Number.isFinite(amountOut) || !Number.isFinite(amountIn)) return null;
  const fromIsStrong = code(ends.from) === code(o.strong);
  const weakPerStrong = fromIsStrong ? amountIn / amountOut : amountOut / amountIn;
  return { weakPerStrong, strongPerWeak: 1 / weakPerStrong };
}

/**
 * A RATE AS A PERSON READS IT: grouped, and no more digits than it needs.
 *
 * 13000 → «13,000» · 12900.5 → «12,900.5» · 1.4085 → «1.4085» ·
 * 0.00007692307 → «0.00007692». Four significant digits for a figure under
 * one, up to four decimals from one, up to two from a thousand. Never an
 * exponent, never an Arabic digit.
 */
export function formatRate(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return '—';
  let fixed: string;
  if (x >= 1000) fixed = x.toFixed(2);
  else if (x >= 1) fixed = x.toFixed(4);
  else {
    // Decimals to reach the first significant digit, and three more after it: four significant digits.
    const lead = -Math.floor(Math.log10(x));
    fixed = x.toFixed(Math.min(12, lead + 3));
  }
  const trimmed = fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
  const [whole, fraction] = trimmed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/**
 * A RATE AS A BOX HOLDS IT — plain digits, no separators, enough of them
 * that retyping it is the same deal: up to eight significant digits.
 */
export function rateForBox(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return '';
  const s = Number(x.toPrecision(8));
  // `toString` goes to an exponent below 1e-6; a box must not show «7.69e-7».
  return s.toString().includes('e') ? s.toFixed(12).replace(/\.?0+$/, '') : s.toString();
}

/* ───────────────────────── what the books can hold ───────────────────────── */

/** The largest figure `Decimal(14,3)` keeps — what a wallet movement and a transfer's two amounts are. */
export const MAX_AMOUNT = 99_999_999_999.999;
/** `Decimal(14,6)`: the largest and the smallest rate the column keeps. */
export const MAX_STORED_RATE = 99_999_999.999999;
export const MIN_STORED_RATE = 0.000001;

/**
 * DOES A FIGURE HAVE NO MORE DECIMALS THAN THE CURRENCY COUNTS IN?
 *
 * Asked with the same rounding every amount in the product goes through, so
 * a figure that survives it unchanged is a figure a person could have typed
 * in that currency, and one that does not — 10.005 dollars, 0.0004 dinars —
 * is refused by name instead of being quietly moved to the nearest unit.
 */
export function fitsMinorUnit(value: number, minorUnit: number): boolean {
  return Number.isFinite(value) && roundMinor(value, minorUnit) === value;
}

/**
 * THE RATE THAT IS STORED NEXT TO A TRANSFER, WHEN THE AMOUNT WAS WHAT WAS ENTERED.
 *
 * Units of the destination per one of the source — the same meaning the
 * column has always had — worked from the two amounts and rounded to its six
 * decimals. INFORMATION ABOUT THE DEAL, NEVER AN INPUT TO IT: SYP→USD at
 * 13,000 is 0.0000769…, stored 0.000077, and the arriving amount is not
 * recomputed from it.
 *
 * `null` when the column cannot hold it (it would round to zero, or overflow
 * the eight digits before the point): a rate that cannot be stored is a pair
 * of amounts nobody meant.
 */
export function storedRate(amountOut: number, amountIn: number): number | null {
  if (!(amountOut > 0) || !(amountIn > 0)) return null;
  const r = roundMinor(amountIn / amountOut, 6);
  return r >= MIN_STORED_RATE && r <= MAX_STORED_RATE ? r : null;
}

/* ───────────────────────── the judge: what the route makes of a request ───────────────────────── */

export interface ResolveInput {
  fromCode: string;
  toCode: string;
  fromName: string;
  toName: string;
  /** As typed: what leaves, in the source currency. */
  amountOut: number;
  /** To-per-from, as the screen has always sent it. Exclusive with `amountIn`. */
  exchangeRate?: number;
  /** The final amount that arrives, in the destination currency. Exclusive with `exchangeRate`. */
  amountIn?: number;
  /** `Country.minorUnit` of each wallet — the rounding every other money door uses. */
  fromMinor: number;
  toMinor: number;
}

export type Refusal = { ok: false; code: string; error: string };

const refuse = (c: string, error: string): Refusal => ({ ok: false, code: c, error });

export interface Resolved {
  ok: true;
  /** What leaves, rounded to the source's decimals (it was already there: a figure with more is refused). */
  amountOut: number;
  /** What arrives — the authoritative number the arriving movement carries. */
  amountIn: number;
  /** What is stored in `exchangeRate`: as typed for a rate, derived for an amount, 1 for one currency. */
  rate: number;
  /** What the person entered: a rate, the amount that arrived, or nothing (one currency). */
  entered: 'RATE' | 'AMOUNT_IN' | 'NONE';
}

const places = (n: number) =>
  n <= 0 ? 'أرقاماً صحيحة بلا كسور' : n === 1 ? 'أكثر من خانة عشرية واحدة' : n === 2 ? 'أكثر من خانتين عشريتين' : `أكثر من ${n} خانات عشرية`;

/**
 * WHAT A TRANSFER REQUEST MEANS IN MONEY — or the sentence that refuses it.
 *
 * One currency: neither a rate nor an amount may come, and the same figure
 * arrives. Two currencies: EXACTLY ONE of the rate and the arriving amount.
 *
 * THE RATE PATH IS THE OLD ARITHMETIC, UNTOUCHED: `amountIn =
 * roundMinor(amountOut × rate, destination decimals)`, the rate stored as
 * typed. Every request the route has ever answered well gets, here, the same
 * number to the last digit (a differential test holds that over a grid).
 * The AMOUNT PATH stores what was typed, once it has been checked to be a
 * figure the destination can hold.
 */
export function resolveTransferAmounts(i: ResolveInput): Resolved | Refusal {
  // What leaves must be a figure the source currency can hold. It used to be moved to the nearest unit in silence
  // (the arriving side was worked from the unrounded figure and the leaving movement from the rounded one).
  if (!fitsMinorUnit(i.amountOut, i.fromMinor)) {
    return refuse(
      'AMOUNT_OUT_DECIMALS',
      i.fromMinor <= 0
        ? `المبلغ المحوَّل من ${i.fromName} (${i.fromCode}) يُكتب ${places(i.fromMinor)}`
        : `المبلغ المحوَّل من ${i.fromName} (${i.fromCode}) لا يقبل ${places(i.fromMinor)}`
    );
  }
  const amountOut = roundMinor(i.amountOut, i.fromMinor);

  const sameCurrency = code(i.fromCode) === code(i.toCode);
  const gaveRate = i.exchangeRate !== undefined;
  const gaveAmount = i.amountIn !== undefined;

  if (sameCurrency) {
    if (gaveRate || gaveAmount) {
      return refuse(
        'RATE_NOT_ALLOWED',
        `عملة المحفظتين واحدة (${i.fromCode}) — لا حاجة لسعر صرف ولا لمبلغ مستلم`
      );
    }
    // × 1 is the old door's own line (it multiplied by a rate of 1 here): the product is the same figure, to the last digit.
    return { ok: true, amountOut, amountIn: roundMinor(i.amountOut * 1, i.toMinor), rate: 1, entered: 'NONE' };
  }

  if (gaveRate && gaveAmount) {
    return refuse('RATE_AND_AMOUNT_BOTH', 'اكتب سعر الصرف أو المبلغ المستلم — واحداً منهما فقط، لا الاثنين');
  }
  if (!gaveRate && !gaveAmount) {
    return refuse(
      'EXCHANGE_RATE_REQUIRED',
      `التحويل من ${i.fromCode} إلى ${i.toCode} يتطلب سعر صرف أو المبلغ المستلم`
    );
  }

  if (gaveRate) {
    const rate = i.exchangeRate as number;
    const amountIn = roundMinor(i.amountOut * rate, i.toMinor);
    /*
     * A RATE SMALL ENOUGH TO ROUND THE ARRIVING AMOUNT TO NOTHING IS REFUSED WITH A 400 — because
     * `recordMovement`'s own guard fires inside the transaction and comes back as the generic 500, which tells the
     * person to call the administrator about a rate they can fix themselves. (Measured: `.positive()` admits
     * 0.000001, and 100 at that rate into a 3-decimal currency is `roundMinor(0.0001, 3) === 0`.)
     */
    if (amountIn <= 0) {
      return refuse(
        'EXCHANGE_RATE_TOO_SMALL',
        `سعر الصرف ${rate} يجعل المبلغ الواصل إلى ${i.toName} صفراً. راجع سعر الصرف.`
      );
    }
    if (amountIn > MAX_AMOUNT) return tooBig(i);
    return { ok: true, amountOut, amountIn, rate, entered: 'RATE' };
  }

  // The arriving amount was typed.
  const amountIn = i.amountIn as number;
  if (!Number.isFinite(amountIn) || !(amountIn > 0)) {
    return refuse('AMOUNT_IN_INVALID', 'المبلغ المستلم لازم يكون أكبر من صفر');
  }
  if (!fitsMinorUnit(amountIn, i.toMinor)) {
    return refuse(
      'AMOUNT_IN_DECIMALS',
      i.toMinor <= 0
        ? `المبلغ المستلم في ${i.toName} (${i.toCode}) يُكتب ${places(i.toMinor)}`
        : `المبلغ المستلم في ${i.toName} (${i.toCode}) لا يقبل ${places(i.toMinor)}`
    );
  }
  if (amountIn > MAX_AMOUNT) return tooBig(i);

  const rate = storedRate(amountOut, amountIn);
  if (rate === null) {
    return refuse(
      'RATE_OUT_OF_RANGE',
      `المبلغ المستلم (${amountIn} ${i.toCode}) بعيد جداً عن المبلغ المحوَّل (${amountOut} ${i.fromCode}) — راجع الرقمين`
    );
  }
  return { ok: true, amountOut, amountIn, rate, entered: 'AMOUNT_IN' };
}

function tooBig(i: ResolveInput): Refusal {
  return refuse('AMOUNT_IN_TOO_BIG', `المبلغ الواصل إلى ${i.toName} أكبر مما يحتمله السجل — راجع المبلغ أو سعر الصرف`);
}

/* ───────────────────────── the screen's side: one deal, from whatever is typed ───────────────────────── */

/** `A` rate in «weak per one strong» · `B` the inverse · `C` the amount that arrived. */
export type Face = 'A' | 'B' | 'C';

export interface DealInput extends DealEnds {
  fromName: string;
  toName: string;
  fromMinor: number;
  toMinor: number;
  /** The box «المبلغ اللي بدك تحوّلو», as typed. */
  amountOutText: string;
  /** What was typed to say the exchange, and which of the three faces it is in. */
  face: Face;
  text: string;
  orientation: Orientation;
}

export interface Deal {
  /** What leaves, when the box holds a figure. */
  amountOut: number | null;
  /** What arrives — the number the card shows and the screen sends. `null` while it cannot be said. */
  amountIn: number | null;
  /** What the ROUTE would answer to this: the amounts and the stored rate, or its sentence. `null` while incomplete. */
  verdict: Resolved | Refusal | null;
  /** The rate the card says, from the two amounts; `null` for one currency or while incomplete. */
  rate: { weakPerStrong: number; strongPerWeak: number } | null;
}

/**
 * THE DEAL, WORKED FROM WHAT IS TYPED — and judged by the very function the route judges with.
 *
 * The three faces end in the same place: an arriving amount. A rate is turned
 * into it by `amountInFromQuote`; the amount that arrived IS it. Then the
 * route's own `resolveTransferAmounts` is asked about the pair, so the card
 * shows the sentence the route would have refused with before anybody presses.
 * And the screen sends THIS `amountIn`, so what the card says, what the
 * arriving movement carries and what the row stores are one number.
 */
export function dealOf(i: DealInput): Deal {
  const nothing: Deal = { amountOut: null, amountIn: null, verdict: null, rate: null };
  const amountOut = parseTyped(i.amountOutText);
  if (amountOut === null || !(amountOut > 0)) return nothing;

  const cross = code(i.from) !== code(i.to);
  const judged = (amountIn: number | undefined): Deal => {
    const verdict = resolveTransferAmounts({
      fromCode: i.from,
      toCode: i.to,
      fromName: i.fromName,
      toName: i.toName,
      amountOut,
      amountIn,
      fromMinor: i.fromMinor,
      toMinor: i.toMinor,
    });
    const arrives = verdict.ok ? verdict.amountIn : (amountIn ?? null);
    return {
      amountOut,
      amountIn: arrives,
      verdict,
      rate: cross && arrives !== null ? displayRate(i, amountOut, arrives, i.orientation) : null,
    };
  };

  if (!cross) return judged(undefined);

  const typed = parseTyped(i.text);
  if (typed === null) return { ...nothing, amountOut };
  if (i.face === 'C') return judged(typed);

  const arrives = amountInFromQuote(i, amountOut, quoteOf(i.face, typed, i.orientation), i.toMinor);
  if (arrives === null) return { ...nothing, amountOut };
  if (arrives === 0) {
    // A real rate that leaves nothing at the other end: the route's own refusal, in its own words.
    return {
      amountOut,
      amountIn: 0,
      verdict: refuse('EXCHANGE_RATE_TOO_SMALL', `سعر الصرف يجعل المبلغ الواصل إلى ${i.toName} صفراً. راجع سعر الصرف.`),
      rate: null,
    };
  }
  return judged(arrives);
}

/**
 * WHAT THE BOX OF A FACE SHOWS WHEN THE PERSON TYPED IN ANOTHER.
 *
 * Flipping A/B is the whole point of the switch — no calculator — and it must
 * not drift: a rate typed as 13,000 and flipped to B and back to A must still
 * be 13,000, not 12,999.99 because 0.0000769231 was multiplied back. So the
 * box shows the inverse of what was TYPED, while the deal keeps being worked
 * from what was typed; only editing the box makes its new text the truth.
 */
export function boxTextFor(view: Face, i: DealInput, deal: Deal): string {
  if (view === i.face) return i.text;
  const typed = parseTyped(i.text);

  if (i.face !== 'C') {
    if (typed === null) return '';
    if (view === 'C') return deal.amountIn !== null ? String(deal.amountIn) : '';
    // A ↔ B: the inverse of the figure that was typed.
    return rateForBox(1 / typed);
  }

  // The amount that arrived was typed: the rates are read off the two amounts.
  if (!deal.rate) return '';
  return rateForBox(view === 'A' ? deal.rate.weakPerStrong : deal.rate.strongPerWeak);
}
