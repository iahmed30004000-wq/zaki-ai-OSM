/**
 * MONEY — the single COD/discount authority (contract PART 5).
 *
 * COD = price - discount + delivery fee.
 * If the price includes delivery: COD = price - discount, and the fee is
 * deducted from revenue instead of added to the customer's total. If ANY
 * line includes delivery, the whole order does.
 *
 * ONE function computes this, used by every screen and service. Precision
 * comes from the country's currency minor unit — never a global rounding
 * rule. The frontend renders these values; it never recomputes them.
 */

export interface MoneyLine {
  quantity: number;
  unitPrice: number;
  /** Gift units: real stock, zero price — never part of the money maths. */
  freeQuantity?: number;
}

export interface CodInput {
  lines: MoneyLine[];
  /** Order-level discount, allocated across lines proportionally. */
  discount?: number;
  deliveryFee?: number;
  priceIncludesDelivery?: boolean;
  /** Decimal places of the country's currency (JOD 3, SYP 2, ...). */
  minorUnit: number;
  /**
   * Products the customer added after ordering — the upsell on the thank-you
   * page (OrderAddOn). They are money the courier must collect.
   *
   * Kept apart from `lines` on purpose, for two reasons. The order's discount
   * was agreed on the original order, before any add-on existed, so it is
   * not spread over them; and `subtotal` stays the price of the order's own
   * lines, which is what `sellingPrice` records and what a discount may not
   * exceed. An add-on changes what is collected, not what was discounted.
   *
   * Before this existed, the add-on raised the order's total when it was
   * accepted, and the next recompute — creating the shipment — rebuilt the
   * total from the lines alone and wrote it back. The courier collected the
   * order without the add-on.
   */
  addOns?: MoneyLine[];
}

export interface CodBreakdown {
  /** Sum of quantity * unitPrice before discount. */
  subtotal: number;
  discount: number;
  deliveryFee: number;
  /** What the courier collects from the customer. */
  cod: number;
  /** What the business earns from the sale (fee deducted when included). */
  revenue: number;
  /** The add-ons' value, included in cod and revenue, never discounted. */
  addOns: number;
  /** Discount share per line, same order as the input lines. */
  discountShares: number[];
  /** quantity * unitPrice - discountShare per line. */
  lineTotals: number[];
}

/** Round to the currency's minor unit (half away from zero, no float drift). */
export function roundMinor(value: number, minorUnit: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, Math.min(6, Math.trunc(minorUnit)));
  const scaled = value * factor;
  // Nudge away from binary-representation edges before rounding (2.675 * 100).
  const rounded = Math.round(Math.abs(scaled) + Number.EPSILON * Math.abs(scaled));
  return (scaled < 0 ? -rounded : rounded) / factor;
}

/**
 * Allocate an order discount across lines proportionally to their value.
 * Stored per line: without it a partial return refunds the wrong amount.
 * Rounding remainders land on the largest line so the shares always sum to
 * the discount exactly.
 */
export function allocateDiscount(lines: MoneyLine[], discount: number, minorUnit: number): number[] {
  const values = lines.map((l) => Math.max(0, l.quantity) * Math.max(0, l.unitPrice));
  const subtotal = values.reduce((a, b) => a + b, 0);
  const total = roundMinor(Math.max(0, Math.min(discount, subtotal)), minorUnit);
  if (total === 0 || subtotal === 0) return lines.map(() => 0);

  const shares = values.map((v) => roundMinor((v / subtotal) * total, minorUnit));
  const drift = roundMinor(total - shares.reduce((a, b) => a + b, 0), minorUnit);
  if (drift !== 0) {
    let largest = 0;
    for (let i = 1; i < values.length; i++) if (values[i] > values[largest]) largest = i;
    shares[largest] = roundMinor(shares[largest] + drift, minorUnit);
  }
  return shares;
}

/**
 * WHAT EACH LINE COST BEFORE THE ORDER'S OWN DISCOUNT — the figure the lines
 * editor opens its price box on.
 *
 * `PATCH /api/orders/[id]` reads `items[].unitPrice` as a line's total
 * BEFORE the discount and spreads `discountAmount` over the lines again. The
 * editor opened on the stored `lineTotal`, which is AFTER it, so every press
 * of «حفظ» with nothing touched took the discount off once more: 64.200,
 * then 57.400, then 50.600.
 *
 * `lineTotal + discountShare` is exact, not a reconstruction: `computeCod`
 * writes `lineTotal` as `roundMinor(value − share)` with both in the
 * currency's minor unit, so adding the share back returns the value it was
 * cut from.
 *
 * ONLY WHEN THE SHARES ARE THE ORDER'S OWN DISCOUNT — when they add up to
 * `discountAmount`, which is how every lines save and the win-back write
 * them. `POST /api/orders`, the storefront and `/api/v1`
 * spread an OFFER's reduction into the shares and leave `discountAmount` at
 * 0; adding those back would ask the customer for the reduction she was
 * quoted. There the line total stands — the price she agreed to — and the
 * discount box beside it opens on 0. Shares that are neither are lines the
 * single-field edit left behind when it moved the discount without
 * rewriting them; no figure is exact for those, and they stand as stored.
 */
export function totalsBeforeDiscount(
  lines: ReadonlyArray<{ lineTotal: unknown; discountShare: unknown }>,
  orderDiscount: number,
  minorUnit: number
): number[] {
  const shares = lines.map((l) => roundMinor(Number(l.discountShare), minorUnit));
  const spread = roundMinor(shares.reduce((sum, s) => sum + s, 0), minorUnit);
  const theOrdersOwn = spread === roundMinor(Math.max(0, orderDiscount), minorUnit);
  return lines.map((l, i) => roundMinor(Number(l.lineTotal) + (theOrdersOwn ? shares[i] : 0), minorUnit));
}

/** The COD contract. Every screen and service calls this one function. */
export function computeCod(input: CodInput): CodBreakdown {
  const { lines, minorUnit } = input;
  const deliveryFee = roundMinor(Math.max(0, input.deliveryFee ?? 0), minorUnit);
  const values = lines.map((l) => roundMinor(Math.max(0, l.quantity) * Math.max(0, l.unitPrice), minorUnit));
  const subtotal = roundMinor(values.reduce((a, b) => a + b, 0), minorUnit);

  const discountShares = allocateDiscount(lines, input.discount ?? 0, minorUnit);
  const discount = roundMinor(discountShares.reduce((a, b) => a + b, 0), minorUnit);
  const lineTotals = values.map((v, i) => roundMinor(v - discountShares[i], minorUnit));
  const addOns = roundMinor(
    (input.addOns ?? []).reduce(
      (sum, a) => sum + roundMinor(Math.max(0, a.quantity) * Math.max(0, a.unitPrice), minorUnit),
      0
    ),
    minorUnit
  );
  const net = roundMinor(subtotal - discount + addOns, minorUnit);

  const includesDelivery = input.priceIncludesDelivery === true;
  const cod = includesDelivery ? net : roundMinor(net + deliveryFee, minorUnit);
  const revenue = includesDelivery ? roundMinor(net - deliveryFee, minorUnit) : net;

  return { subtotal, discount, deliveryFee, cod, revenue, addOns, discountShares, lineTotals };
}

/**
 * EXACT, AND MACHINE-SAFE. Do not add separators to this one.
 *
 * It fills waybill fields and a CSV column a courier imports: «37500.000».
 * A thousands separator inside a CSV cell is a broken column, and inside a
 * courier's amount field it is a number that fails to parse. This is the
 * figure as a MACHINE must read it.
 */
export function formatMoney(value: number, currencyCode: string, minorUnit: number): string {
  return `${roundMinor(value, minorUnit).toFixed(minorUnit)} ${currencyCode}`;
}

/**
 * AND THE SAME FIGURE AS A PERSON READS IT: «37,500.000 JOD».
 *
 * Three things, all of which were missing on the ninety-one places that
 * printed money with a bare `.toFixed(2)`:
 *
 *   SEPARATORS. «1500000.00» and «150000.00» are the same shape at a
 *   glance. Somebody approving a payout reads the shape, not the digits.
 *
 *   WESTERN DIGITS, GUARANTEED. The grouping is done by hand rather than by
 *   `toLocaleString`, so no locale is consulted and «١٬٥٠٠» cannot happen —
 *   `ar-EG` renders Arabic-Indic digits, and a figure that changes numeral
 *   system between two screens is a figure nobody trusts.
 *
 *   A FIXED POSITION FOR THE CODE. Always after the number. The caller
 *   renders it inside an LTR box, so a right-to-left paragraph cannot move
 *   «JOD» to the front of «37,500» on one screen and not on another.
 */
/**
 * HOW MANY DECIMALS A FIGURE GETS.
 *
 * This lived inside `Money` as one ternary, and it read «a code was passed
 * → two». Every row that carries its own `currencyCode` passes one, so on a
 * Jordanian store a fils was lost: 1.234 JOD printed «1.23 JOD» with the
 * code and «1.234 JOD» without it.
 *
 * Out here because a rule that cannot be called cannot be tested: the guard
 * that was supposed to hold it could only read the source text, and passed a
 * mutation that disabled the check while leaving the words in place.
 */
export function moneyDigits(opts: {
  minorUnit?: number;
  /** `undefined` = this store's currency; `null` = print it bare. */
  currency?: string | null;
  store?: { code: string; minorUnit: number } | null;
}): number {
  if (opts.minorUnit !== undefined) return opts.minorUnit;
  const code = opts.currency !== undefined ? opts.currency : opts.store?.code ?? null;
  // A code that IS this store's currency knows its own decimals.
  if (code && opts.store?.code === code) return opts.store.minorUnit;
  // A genuinely foreign code has to be guessed at, and two is the common case.
  if (opts.currency !== undefined) return 2;
  return opts.store?.minorUnit ?? 2;
}

export function moneyText(value: number, currencyCode: string | null | undefined, minorUnit: number): string {
  const n = Number.isFinite(value) ? roundMinor(value, minorUnit) : 0;
  const fixed = Math.abs(n).toFixed(minorUnit);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = n < 0 ? '-' : '';
  const number = fraction ? `${sign}${grouped}.${fraction}` : `${sign}${grouped}`;
  // Without a currency the amount is printed bare rather than dressed in a
  // code that might be wrong; a missing currency is a loading state, not a
  // licence to assume dollars.
  return currencyCode ? `${number} ${currencyCode}` : number;
}
