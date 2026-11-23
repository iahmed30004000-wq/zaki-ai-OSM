/**
 * «سعر الصرف التلقائي» (23/11, F8) — THE RULES OF A RATE, WITH NO DATABASE AND NO NETWORK.
 *
 * «إذا بتقدر تحط سعر صرف تلقائي يشيك الإنترنت تمام» · «بدك تحلها بتسعير تلقائي بتبحث بالإنترنت» (the owner). A partner's draw from a
 * wallet in another currency than the store's needs «ما يعادله بعملة المتجر»; this file says what one unit of a currency is worth in
 * dollars, where that came from, and what a draw comes to in the store's currency.
 *
 * A RATE IS «HOW MANY UNITS OF THE CURRENCY BUY ONE DOLLAR» (`perUsd`) — the form the fiat source answers in, and the form a person
 * reads off an exchange shop's board («13,000 ليرة لكل دولار»).
 *
 * THE RULES, IN THE ORDER THEY ARE ASKED:
 *   1. USD is 1, always. Nobody overrides it.
 *   2. A rate the owner typed for the currency («يدوي») wins over everything below.
 *   3. USDT comes from the crypto source (the market price of one USDT in dollars) — NEVER 1: the two are not exactly equal.
 *   4. SYP is NEVER taken from a source, even when the source lists it: the official and the market rates are far apart, and the
 *      official one would write a wrong number in a partner's ledger. Only the owner's typed rate counts; until then «اكتب السعر».
 *   5. Any other code comes from the fiat source when the source lists it.
 *   6. A code that neither source knows behaves like SYP: the owner's rate or nothing.
 *
 * An automatic rate older than `STALE_DAYS` is still used (a failed fetch keeps the last value) but is FLAGGED, and the screens say so.
 * Nothing here is a guess: no rate means no equivalent, never 1:1.
 */
import { roundMinor } from './money';

/** Where an automatic fiat rate is read: ExchangeRate-API's open access (no key; daily; base USD). */
export const FIAT_SOURCE = { name: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD' } as const;
/** Where the price of one USDT in dollars is read: Kraken's public ticker (no key; the USDT/USD market). */
export const USDT_SOURCE = { name: 'api.kraken.com', url: 'https://api.kraken.com/0/public/Ticker?pair=USDTUSD' } as const;

/** A fetch is tried at most once in this long — success or not. */
export const REFRESH_EVERY_MS = 24 * 60 * 60 * 1000;
/** An automatic rate older than this many days is flagged on every screen that shows it. */
export const STALE_DAYS = 3;
/** Codes that a source is never asked for, whatever it lists. */
export const NEVER_FROM_A_SOURCE: readonly string[] = ['SYP'];

/** What the automatic side holds: the last good answer of each source, kept until a newer good one arrives. */
export interface AutoRates {
  /** The last time a fetch was TRIED (success or not) — the once-a-day gate. */
  attemptedAt?: string;
  fiat?: { source: string; asOf: string; fetchedAt: string; perUsd: Record<string, number> };
  usdt?: { source: string; asOf: string; fetchedAt: string; usdPerUnit: number };
  /** The last failure of each source, for the screen. Cleared by that source's next success. */
  failed?: { fiat?: string; usdt?: string };
}

/** What the owner typed, per company: one rate per currency code, as «units for one dollar». */
export interface ManualRates {
  rates: Record<string, { perUsd: number; at: string; byId?: string | null }>;
}

export type RateKind = 'FIXED' | 'AUTO' | 'MANUAL';

export interface EffectiveRate {
  code: string;
  perUsd: number;
  kind: RateKind;
  /** The source's name for AUTO, «يدوي» is the kind itself for MANUAL. */
  source: string | null;
  /** When this rate was true (the source's own update time; the owner's save time). */
  asOf: string | null;
  /** An AUTO rate older than `STALE_DAYS`. */
  stale: boolean;
}

export const normCode = (code: string) => code.trim().toUpperCase();

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** True when `asOf` is more than `STALE_DAYS` days before `now`. */
export function isStale(asOf: string | null | undefined, now: Date): boolean {
  if (!asOf) return true;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return true;
  return now.getTime() - t > STALE_DAYS * 24 * 60 * 60 * 1000;
}

/** The rate a code is worth today, by the six rules above — or null when there is none. */
export function effectiveRate(rawCode: string, auto: AutoRates | undefined, manual: ManualRates | undefined, now: Date): EffectiveRate | null {
  const code = normCode(rawCode);
  if (code === 'USD') return { code, perUsd: 1, kind: 'FIXED', source: null, asOf: null, stale: false };

  const typed = manual?.rates?.[code];
  if (typed && positive(typed.perUsd)) {
    return { code, perUsd: typed.perUsd, kind: 'MANUAL', source: null, asOf: typed.at ?? null, stale: false };
  }

  if (NEVER_FROM_A_SOURCE.includes(code)) return null;

  if (code === 'USDT') {
    const u = auto?.usdt;
    if (!u || !positive(u.usdPerUnit)) return null;
    return { code, perUsd: 1 / u.usdPerUnit, kind: 'AUTO', source: u.source, asOf: u.asOf, stale: isStale(u.asOf, now) };
  }

  const f = auto?.fiat;
  const perUsd = f?.perUsd?.[code];
  if (!f || !positive(perUsd)) return null;
  return { code, perUsd, kind: 'AUTO', source: f.source, asOf: f.asOf, stale: isStale(f.asOf, now) };
}

/** What a draw comes to in the store's currency, at today's rates — or why there is no figure. */
export type Equivalent =
  | {
      ok: true;
      value: number;
      /** Store units for ONE wallet unit — what was multiplied. Frozen on the movement. */
      rate: number;
      /** MANUAL when either side was typed by the owner, AUTO otherwise. */
      kind: 'AUTO' | 'MANUAL';
      /** The older of the two sides' dates — the age of the figure. */
      asOf: string | null;
      stale: boolean;
    }
  | { ok: false; missing: string[]; sentence: string };

/**
 * `amount` of the wallet's currency in the store's currency: amount × (store per dollar ÷ wallet per dollar), rounded to the store's
 * decimals. Both sides need a rate; a side without one names itself in the sentence.
 */
export function equivalentOf(
  amount: number,
  walletCode: string,
  storeCode: string,
  storeMinor: number,
  auto: AutoRates | undefined,
  manual: ManualRates | undefined,
  now: Date
): Equivalent {
  const w = effectiveRate(walletCode, auto, manual, now);
  const s = effectiveRate(storeCode, auto, manual, now);
  const missing = [!w ? normCode(walletCode) : null, !s ? normCode(storeCode) : null].filter((c): c is string => !!c);
  if (!w || !s) return { ok: false, missing, sentence: missingRateSentence(missing) };
  const rate = s.perUsd / w.perUsd;
  const value = roundMinor(amount * rate, storeMinor);
  const dates = [w.asOf, s.asOf].filter((d): d is string => !!d).sort();
  return {
    ok: true,
    value,
    rate,
    kind: w.kind === 'MANUAL' || s.kind === 'MANUAL' ? 'MANUAL' : 'AUTO',
    asOf: dates[0] ?? null,
    stale: w.stale || s.stale,
  };
}

/** «ما في سعر — اكتب سعر الليرة بالإعدادات», or the same sentence for another currency. */
export function missingRateSentence(codes: string[]): string {
  if (codes.length === 1 && codes[0] === 'SYP') return 'ما في سعر — اكتب سعر الليرة بالإعدادات';
  return `ما في سعر — اكتب سعر ${codes.join(' و')} بالإعدادات`;
}

/** The sentence beside an automatic rate older than `STALE_DAYS`. */
export const STALE_SENTENCE = `السعر أقدم من ${STALE_DAYS} أيام — ما قدرنا نجيب سعر جديد من الإنترنت`;

/** «تلقائي» / «يدوي» / «ثابت» — the word a screen prints beside a rate. */
export function kindWord(kind: RateKind | 'AUTO' | 'MANUAL' | null | undefined): string {
  if (kind === 'MANUAL') return 'يدوي';
  if (kind === 'FIXED') return 'ثابت';
  return 'تلقائي';
}

/** May a fetch be tried now? Once in `REFRESH_EVERY_MS`, success or not. */
export function mayTryNow(auto: AutoRates | undefined, now: Date): boolean {
  const t = auto?.attemptedAt ? Date.parse(auto.attemptedAt) : NaN;
  return !Number.isFinite(t) || now.getTime() - t >= REFRESH_EVERY_MS;
}

/* ───────────────────────── the two sources' answers, read strictly ───────────────────────── */

/**
 * ExchangeRate-API's open answer: `{ result: 'success', base_code: 'USD', time_last_update_unix, rates: { JOD: 0.709, … } }`.
 * SYP (and every code of `NEVER_FROM_A_SOURCE`) is dropped HERE, so it is never even stored.
 */
export function readFiatAnswer(body: unknown): { asOf: string; perUsd: Record<string, number> } | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { result?: unknown; base_code?: unknown; time_last_update_unix?: unknown; rates?: unknown };
  if (b.result !== 'success' || b.base_code !== 'USD' || !b.rates || typeof b.rates !== 'object') return null;
  const perUsd: Record<string, number> = {};
  for (const [k, v] of Object.entries(b.rates as Record<string, unknown>)) {
    const code = normCode(k);
    if (!/^[A-Z]{3}$/.test(code) || NEVER_FROM_A_SOURCE.includes(code) || code === 'USD') continue;
    if (positive(v)) perUsd[code] = v;
  }
  if (Object.keys(perUsd).length === 0) return null;
  const unix = typeof b.time_last_update_unix === 'number' ? b.time_last_update_unix : NaN;
  return { asOf: Number.isFinite(unix) ? new Date(unix * 1000).toISOString() : '', perUsd };
}

/**
 * Kraken's public ticker: `{ error: [], result: { USDTZUSD: { c: ['0.99877000', '…'], … } } }` — `c[0]` is the last trade's price.
 * A price outside 0.5–1.5 dollars is not a stable coin's and is refused rather than written into a ledger.
 */
export function readUsdtAnswer(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error?: unknown; result?: unknown };
  if (Array.isArray(b.error) && b.error.length > 0) return null;
  if (!b.result || typeof b.result !== 'object') return null;
  const first = Object.values(b.result as Record<string, unknown>)[0] as { c?: unknown } | undefined;
  const raw = Array.isArray(first?.c) ? first!.c[0] : undefined;
  const price = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(price) || price < 0.5 || price > 1.5) return null;
  return price;
}
