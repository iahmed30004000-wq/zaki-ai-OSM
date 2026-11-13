/**
 * THE SHAPES `/api/v1` PROMISES, WRITTEN ONCE.
 *
 * A screen may render a number however it likes; another SYSTEM parses it.
 * `OMS-DOOR-V1.md` fixes two of them for the whole door — «المبالغ: نص عشري
 * بخانتين» and «التواريخ: ISO 8601 بإزاحة المنطقة» — and a second place that
 * formatted either would be a second answer to one question, which is how
 * the replies system ends up reading `15` from one endpoint and `"15.00"`
 * from the next.
 */

/**
 * MONEY AS A STRING, AT THE CURRENCY'S OWN NUMBER OF PLACES.
 *
 * ── WHERE THIS DEPARTS FROM THE WRITTEN CONTRACT, AND WHY ──
 *
 * The contract says two places. The product serves Jordan, whose dinar has
 * a `minorUnit` of 3, and `a-fils-is-not-a-rounding-error.test.ts` exists
 * because twenty-six money COLUMNS were `Decimal(12,2)` while the dinar has
 * three — «`2.555::numeric(12,2)` is `2.56`, so five fils were lost on the
 * way INTO the column, every time, silently».
 *
 * Printing a JOD total as `"2.56"` at this door would reinvent exactly that
 * defect, one layer out: the replies system would quote a customer a figure
 * five fils below the one the courier collects, and the difference would
 * surface as a settlement mismatch nobody could trace to a string format.
 *
 * So the places come from the ORDER'S OWN CURRENCY, and never fall below
 * two. For USD and SYP that is `"15.00"` — byte-identical to the contract's
 * examples, which are all dollars. For JOD it is `"15.000"`, which is still
 * a decimal string any parser reads as the same number.
 *
 * It is a DEPARTURE and it is flagged as one in the PR for the owner, under
 * «قرار مؤقت»: the alternative is losing fils, and that is money, which is
 * his to rule on and not this function's.
 */
export function amountString(value: number, minorUnit: number): string {
  const places = Math.max(2, Number.isFinite(minorUnit) ? Math.trunc(minorUnit) : 2);
  // A non-finite figure would print «NaN» into a signed contract body. It
  // cannot arrive from a money column — they are all `Float`/`Decimal` NOT
  // NULL — but a caller may hand this a computed figure, and a quiet zero
  // is a lie a parser cannot see. `toFixed` on NaN gives «NaN», so the
  // guard is here rather than in every caller.
  if (!Number.isFinite(value)) throw new Error('amountString: not a finite amount');
  return value.toFixed(places);
}

/** One formatter per zone, kept: building one costs ten times what using one does (`business-calendar.ts` says why). */
const OFFSET_FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function offsetFormatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = OFFSET_FORMATTERS.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    OFFSET_FORMATTERS.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * A MOMENT, WITH ITS OFFSET — never a bare `Z` and never a local string.
 *
 * `toISOString()` gives UTC with a `Z`, which is a correct instant and a
 * useless one to a human reading a log in Amman: «2026-10-09T17:14:00Z» is
 * the same moment as «20:14 +03:00» and reads three hours earlier. The
 * contract asks for the offset, so the offset is written.
 *
 * The zone is the COUNTRY'S, because that is the zone the order happened in
 * — the same source `one-clock.test.ts` holds the rest of the product to.
 */
export function isoWithOffset(at: Date, timeZone: string): string {
  if (Number.isNaN(at.getTime())) throw new Error('isoWithOffset: not a date');

  /*
   * THE OFFSET IS COMPUTED, NOT TABULATED.
   *
   * A table of «Asia/Amman is +03:00» is wrong twice a year wherever
   * daylight saving still moves, and Jordan abolished it in 2022 while
   * Syria did not. `Intl` knows the rules for the date in hand; a constant
   * knows the rules of the day somebody typed it.
   *
   * `formatToParts` in the zone gives the wall-clock reading there. The
   * difference between that reading taken as UTC and the real instant IS
   * the offset, to the minute — which covers the half-hour and
   * three-quarter-hour zones a `+HH:00` assumption would mangle.
   */
  const fmt = offsetFormatterFor(timeZone);
  const part: Record<string, string> = {};
  for (const p of fmt.formatToParts(at)) part[p.type] = p.value;
  // `hour12: false` gives «24» for midnight in some ICU builds.
  const hour = part.hour === '24' ? '00' : part.hour;

  const asUtc = Date.UTC(
    Number(part.year),
    Number(part.month) - 1,
    Number(part.day),
    Number(hour),
    Number(part.minute),
    Number(part.second)
  );
  const offsetMinutes = Math.round((asUtc - at.getTime()) / 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `${part.year}-${part.month}-${part.day}` +
    `T${hour}:${part.minute}:${part.second}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
