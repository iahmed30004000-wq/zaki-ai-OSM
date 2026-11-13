import { db as prisma } from './db';
import { foldArabic, stripLeadingGovernorate } from './address';
import { shortMemo } from './short-memo';

/**
 * HOW LONG THIS GOVERNORATE ACTUALLY TAKES.
 *
 * «يتعلم السيستم خلال كم بصير التسليم لكل محافظة وعنوان، بحيث مستقبلاً لما
 * أدخل طلب بالمدينة والعنوان يعطيني خلال كم الفترة المتوقعة للاستلام».
 *
 * The system already had a number for this and it was not measured:
 * `deliveryFee.lateThresholdDays`, typed by hand and defaulting to 3 for
 * everywhere. It answers «when should I worry», which is a different
 * question from «what do I tell the customer», and a default of 3 tells
 * every customer the same thing whether they live in حلب or السويداء.
 *
 * Measured on this company when it was written: 119 delivered orders, every
 * one of them with both timestamps and a governorate. Eight governorates
 * carried 10–28 deliveries each; two carried one and two.
 *
 * WHICH IS WHY THERE IS A MINIMUM. A median of two deliveries is an
 * anecdote, and promising a customer a date computed from an anecdote is
 * worse than promising nothing. Below the minimum this says nothing at all
 * and the screen shows nothing — the same rule the store brief states:
 * «تحت الحد الأدنى للعيّنة بيختفي».
 */

/** Fewer deliveries than this and the median is an anecdote. */
export const MIN_DELIVERIES = 5;

/**
 * THE OTHER HALF OF THE SENTENCE: «لكلّ محافظةٍ وعنوان».
 *
 * The governorate was measured and the address was not, and the two are
 * different questions. عمّان is a governorate of four million people: a
 * parcel to a tower downtown and a parcel to a village on its edge are both
 * «عمّان», and quoting the governorate's median to the second one is how a
 * promise gets broken at a door two days late.
 *
 * So an address that this shop has delivered to enough times answers for
 * itself, and everything else falls back to the governorate exactly as
 * before. More specific first, never the other way round.
 *
 * ── WHAT AN ADDRESS IS, HERE ──
 *
 * Free text on the shared customer row. So it is FOLDED before it is used
 * as a key — `foldArabic` is the same fold `sameArabicName` uses, so «شارع
 * الملك الحسين» written with a stretched letter is one street and not two
 * — and the leading governorate is stripped, because most stored addresses
 * came from a courier's statement that writes «عمّان - عمّان الصويفية» and
 * «الصويفية» is the part that means anything.
 *
 * ── AND WHAT IT HONESTLY IS NOT ──
 *
 * There is no per-order copy of the address: it lives on the customer row
 * and nowhere else (`address.ts` says so, at length, for the same reason).
 * So a customer who MOVES takes their delivery history with them, and the
 * new address inherits the old one's durations. Measured against the floor
 * that is a small distortion — five deliveries to one person who then moves
 * — and the alternative is a column on every order, which is the owner's
 * call and not a side effect of a prediction.
 */
export function addressKey(regionId: string | null | undefined, address: string | null | undefined, governorate?: string | null): string | null {
  if (!regionId) return null;
  const stripped = governorate ? stripLeadingGovernorate(String(address ?? ''), governorate) : String(address ?? '');
  const folded = foldArabic(stripped);
  /*
   * A key of nothing is not a key. An address that is empty, or that was
   * only ever the governorate's own name — Telegram intake stores exactly
   * that when the customer gave none — carries no information past the
   * region, and grouping on it would file every such order together and
   * then answer «this address takes 3 days» for a field nobody filled.
   *
   * Two characters is the floor on the text itself: «ب» is not a street.
   */
  if (folded.length < 3) return null;
  return `@${regionId}|${folded}`;
}

export interface DeliveryWindow {
  /** The usual case. */
  medianDays: number;
  /** Where four out of five land, which is what a promise should use. */
  slowDays: number;
  /** How many real deliveries this is computed from. */
  samples: number;
}

/**
 * The median and the 80th percentile of a set of day-counts.
 *
 * Nearest-rank, not interpolated: these are whole days, and «1.6 days»
 * is not a thing anybody says to a customer. Pure, so the arithmetic can
 * be checked without a database.
 */
export function summariseDays(days: number[]): DeliveryWindow | null {
  const clean = days.filter((d) => Number.isFinite(d) && d >= 0).sort((a, b) => a - b);
  if (clean.length < MIN_DELIVERIES) return null;
  const at = (q: number) => clean[Math.min(clean.length - 1, Math.ceil(q * clean.length) - 1)];
  return {
    medianDays: Math.round(at(0.5)),
    slowDays: Math.round(at(0.8)),
    samples: clean.length,
  };
}

/**
 * What a customer in this governorate has actually waited, per region.
 *
 * Read from delivered orders only, and from the two timestamps rather than
 * from any status: an order whose status was rolled back and forward still
 * left on one day and arrived on another.
 */
async function readDeliveryWindows(scope: {
  companyId: string;
  storeId?: string | null;
  /** Deliveries older than this stop describing how the courier works now. */
  lookbackDays?: number;
}): Promise<Map<string, DeliveryWindow>> {
  const since = new Date(Date.now() - (scope.lookbackDays ?? 180) * 86_400_000);

  const rows = await prisma.order.findMany({
    where: {
      companyId: scope.companyId,
      ...(scope.storeId ? { storeId: scope.storeId } : {}),
      regionId: { not: null },
      shippedAt: { not: null, gte: since },
      deliveredAt: { not: null },
    },
    select: {
      regionId: true,
      shippedAt: true,
      deliveredAt: true,
      // The address, for the finer grain — and the region's NAME with it,
      // because the stored address usually repeats it at the front and the
      // key must be the part that distinguishes one street from another.
      customer: { select: { address: true } },
      region: { select: { name: true } },
    },
  });

  const byRegion = new Map<string, number[]>();
  const byAddress = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.regionId || !r.shippedAt || !r.deliveredAt) continue;
    const days = (r.deliveredAt.getTime() - r.shippedAt.getTime()) / 86_400_000;
    // A negative span is a clock or a correction, not a delivery.
    if (days < 0) continue;
    const list = byRegion.get(r.regionId) ?? [];
    list.push(days);
    byRegion.set(r.regionId, list);
    /*
     * AND THE SAME DAY-COUNT IS FILED TWICE, ON PURPOSE.
     *
     * A delivery to a street in عمّان is evidence about that street AND
     * about عمّان. Taking it out of the governorate's set once the street
     * has its own would shrink the governorate below its floor as the
     * addresses above it fill up — the wider claim getting WEAKER the more
     * the shop learns, which is backwards.
     */
    const key = addressKey(r.regionId, r.customer?.address, r.region?.name);
    if (key) {
      const addr = byAddress.get(key) ?? [];
      addr.push(days);
      byAddress.set(key, addr);
    }
  }

  const out = new Map<string, DeliveryWindow>();
  for (const [regionId, days] of byRegion) {
    const w = summariseDays(days);
    if (w) out.set(regionId, w);
  }
  for (const [key, days] of byAddress) {
    const w = summariseDays(days);
    if (w) out.set(key, w);
  }

  /**
   * AND THE WHOLE COUNTRY, under `EVERYWHERE`.
   *
   * «إذا المحافظة مش معروفة، نطاق البلد». A visitor from a governorate
   * this shop has not delivered to five times yet is still owed an
   * answer, and the honest one is how long it takes in general — which
   * is a wider claim, so it is made only when the whole set clears the
   * same floor a single governorate has to clear.
   *
   * Computed from the rows already in hand: a second query over the same
   * delivered orders would be the same numbers, worked out twice.
   */
  const everywhere = summariseDays([...byRegion.values()].flat());
  if (everywhere) out.set(EVERYWHERE, everywhere);

  return out;
}

/**
 * THE SAME ANSWER FOR TEN MINUTES, AND ONE READ FOR WHOEVER ASKS WHILE IT IS BEING WORKED OUT (13/11, the site's slow-down).
 *
 * What `readDeliveryWindows` does is every delivered order of the last 180 days with each customer's address, and string work
 * per row: 283 ms for 9,922 rows, of which 64–82 ms hold the whole server, measured. It ran on every landing-page view, every
 * product-page view, every public tracking lookup, and every pause in typing in the new-order form's address box — five at once
 * held the process for 189 ms.
 *
 * TEN MINUTES, because the answer describes six months of deliveries: one delivery recorded now moves a median that rests on
 * dozens, and the public sentence «يوصل خلال…» that quotes it may be ten minutes behind. The memory is HERE, inside the library, so
 * every caller has it without a changed line — the storefront's own pages included. The key is the caller's whole scope (company,
 * store and look-back), so no tenant is ever handed another's answer; a read that fails is forgotten at once (`short-memo.ts`).
 *
 * THE MAP HANDED OUT IS NOW SHARED BETWEEN REQUESTS. Nobody writes to it: every caller passes it to `windowFor` /
 * `windowWithLevel` or reads one key — and a test greps for the day somebody does not.
 *
 * Zero under test, so a test that changes its rows is never answered from the previous one.
 */
const WINDOWS_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 10 * 60_000;
const KEPT_WINDOWS = shortMemo<Map<string, DeliveryWindow>>(WINDOWS_TTL_MS, 200);

export function deliveryWindows(scope: {
  companyId: string;
  storeId?: string | null;
  /** Deliveries older than this stop describing how the courier works now. */
  lookbackDays?: number;
}): Promise<Map<string, DeliveryWindow>> {
  return KEPT_WINDOWS.get(`${scope.companyId}|${scope.storeId ?? ''}|${scope.lookbackDays ?? 180}`, () => readDeliveryWindows(scope));
}

/**
 * The key the country-wide window is filed under.
 *
 * A reserved word rather than a second map: every caller already looks a
 * region up in this one, and a fallback that lived somewhere else would be
 * a fallback half the callers forget.
 */
export const EVERYWHERE = '*';

/**
 * The window to quote this visitor: their own governorate, else the
 * country, else nothing.
 *
 * Nothing is a real answer. A shop that has delivered four times has not
 * learned how long it takes, and «يصل خلال يومين» from four deliveries is
 * a promise made out of an anecdote — which the customer meets as a broken
 * one, at their door, four days later.
 */
export function windowFor(
  windows: Map<string, DeliveryWindow>,
  regionId: string | null | undefined,
  /** Their own street, when it is known and has been delivered to enough. */
  address?: { text: string | null | undefined; governorate?: string | null }
): DeliveryWindow | null {
  /*
   * MOST SPECIFIC FIRST. The address, then the governorate, then the
   * country, then nothing — and each step is taken only when the one
   * before it cleared the sample floor, which `deliveryWindows` enforced
   * by not putting it in the map at all.
   */
  const key = address ? addressKey(regionId, address.text, address.governorate) : null;
  return (
    (key ? windows.get(key) : null) ??
    (regionId ? windows.get(regionId) : null) ??
    windows.get(EVERYWHERE) ??
    null
  );
}

/** How specific the answer actually was, for a screen that says so. */
export type EtaLevel = 'address' | 'region' | 'country';

/**
 * The window AND where it came from.
 *
 * «يصل عادةً خلال يومين» means something different when it is this street
 * and when it is the whole country, and a screen that cannot tell them
 * apart cannot say «من ٧ تسليماً لهذا العنوان». Same lookup as
 * `windowFor` — not a second one — so the two can never disagree.
 */
export function windowWithLevel(
  windows: Map<string, DeliveryWindow>,
  regionId: string | null | undefined,
  address?: { text: string | null | undefined; governorate?: string | null }
): { window: DeliveryWindow; level: EtaLevel } | null {
  const key = address ? addressKey(regionId, address.text, address.governorate) : null;
  const atAddress = key ? windows.get(key) : undefined;
  if (atAddress) return { window: atAddress, level: 'address' };
  const atRegion = regionId ? windows.get(regionId) : undefined;
  if (atRegion) return { window: atRegion, level: 'region' };
  const everywhere = windows.get(EVERYWHERE);
  if (everywhere) return { window: everywhere, level: 'country' };
  return null;
}

/** What the level is called where a person reads it. */
export const ETA_LEVEL_AR: Record<EtaLevel, string> = {
  address: 'لهذا العنوان',
  region: 'لهذه المحافظة',
  country: 'لكل المناطق',
};

/**
 * The sentence, in the words a person says.
 *
 * One number when the usual and the slow case agree — «يوصل عادةً خلال يوم»
 * — and a range when they do not. Never a decimal, and never a promise the
 * sample cannot support, because there is no sentence at all below the
 * minimum.
 */
export function deliveryWindowAr(w: DeliveryWindow | null | undefined): string | null {
  if (!w) return null;
  const day = (n: number) => (n === 0 ? 'أقل من يوم' : n === 1 ? 'يوم' : n === 2 ? 'يومين' : `${n} أيام`);
  if (w.slowDays <= w.medianDays) return `يصل عادةً خلال ${day(w.medianDays)}`;
  return `يصل عادةً خلال ${day(w.medianDays)}، وحتى ${day(w.slowDays)} في الأبطأ`;
}
