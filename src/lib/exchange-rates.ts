import { db } from './db';
import { readSystemSetting, updateSystemSetting } from './system-settings';
import { updateCompanySettings } from './company-settings';
import {
  FIAT_SOURCE,
  USDT_SOURCE,
  equivalentOf,
  mayTryNow,
  normCode,
  readFiatAnswer,
  readUsdtAnswer,
  type AutoRates,
  type Equivalent,
  type ManualRates,
} from './exchange-rates-core';

/**
 * «سعر الصرف التلقائي» (23/11, F8) — WHERE THE RATES ARE KEPT, AND THE ONE OUTBOUND CALL.
 *
 * THE AUTOMATIC RATES belong to the installation, not to a company — a dollar is worth the same dinars to everybody — so they are one
 * row of `system_settings` (key `exchange-rates`), written only by `refreshExchangeRates` (the daily job `refresh-exchange-rates`).
 * No secret is in it: the two sources need no key.
 *
 * THE OWNER'S RATES (the Syrian pound, any code no source knows, and an override of any other) are the company's own choice, so they
 * are one key of `Company.settings` (`exchangeRates`), saved by the settings card «أسعار الصرف» behind `finance.partners`.
 *
 * THE OUTBOUND CALL carries nothing of the business: two fixed GET addresses (the base «USD» and the pair «USDTUSD» are written in
 * them), no body, no header but `accept`, a 5 s timeout each. It is tried at most once a day, success or not (`mayTryNow`); a source
 * that fails keeps its last good answer, and its failure is noted for the screen. Tests inject `fetchImpl` and never reach the network.
 */

export const AUTO_KEY = 'exchange-rates';
export const MANUAL_KEY = 'exchangeRates';
export const FETCH_TIMEOUT_MS = 5_000;

type FetchLike = (url: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/** One source's try: its read answer, or why it failed (an answer the reader refuses is a failure too). */
async function attempt<T>(go: () => Promise<T | null>): Promise<{ ok: true; r: T } | { ok: false; e: string }> {
  try {
    const r = await go();
    return r === null ? { ok: false, e: 'جواب غير مفهوم' } : { ok: true, r };
  } catch (e) {
    return { ok: false, e: why(e) };
  }
}

export interface RefreshOutcome {
  tried: boolean;
  fiat: 'ok' | 'failed' | 'skipped';
  usdt: 'ok' | 'failed' | 'skipped';
}

/** Try both sources once (if a day has passed since the last try), keep what succeeds, keep the last value of what fails. */
export async function refreshExchangeRates(opts: { now?: Date; fetchImpl?: FetchLike } = {}): Promise<RefreshOutcome> {
  const now = opts.now ?? new Date();
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));

  // THE GATE, CLAIMED UNDER THE ROW'S LOCK: two workers at once — only one stamps the attempt and goes out.
  let claimed = false;
  await updateSystemSetting<AutoRates>(AUTO_KEY, (current) => {
    if (!mayTryNow(current, now)) return current ?? { attemptedAt: now.toISOString() };
    claimed = true;
    return { ...(current ?? {}), attemptedAt: now.toISOString() };
  });
  if (!claimed) return { tried: false, fiat: 'skipped', usdt: 'skipped' };

  // OUTSIDE ANY TRANSACTION: a slow source holds no lock.
  const stamp = now.toISOString();
  const [fiat, usdt] = await Promise.all([
    attempt(async () => readFiatAnswer(await getJson(fetchImpl, FIAT_SOURCE.url))),
    attempt(async () => readUsdtAnswer(await getJson(fetchImpl, USDT_SOURCE.url))),
  ]);

  await updateSystemSetting<AutoRates>(AUTO_KEY, (current) => {
    const next: AutoRates = { ...(current ?? {}), attemptedAt: current?.attemptedAt ?? stamp };
    const failed = { ...(current?.failed ?? {}) };
    if (fiat.ok) {
      next.fiat = { source: FIAT_SOURCE.name, asOf: fiat.r.asOf || stamp, fetchedAt: stamp, perUsd: fiat.r.perUsd };
      delete failed.fiat;
    } else failed.fiat = fiat.e;
    if (usdt.ok) {
      next.usdt = { source: USDT_SOURCE.name, asOf: stamp, fetchedAt: stamp, usdPerUnit: usdt.r };
      delete failed.usdt;
    } else failed.usdt = usdt.e;
    next.failed = failed;
    return next;
  });
  return { tried: true, fiat: fiat.ok ? 'ok' : 'failed', usdt: usdt.ok ? 'ok' : 'failed' };
}

export async function readAutoRates(): Promise<AutoRates | undefined> {
  return readSystemSetting<AutoRates>(AUTO_KEY);
}

export async function readManualRates(companyId: string): Promise<ManualRates> {
  const row = await db.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  try {
    const all = row?.settings ? (JSON.parse(row.settings) as Record<string, unknown>) : {};
    const m = all[MANUAL_KEY] as ManualRates | undefined;
    return m && typeof m === 'object' && m.rates && typeof m.rates === 'object' ? m : { rates: {} };
  } catch {
    return { rates: {} };
  }
}

/** Both sides, for one company. */
export async function readRateTable(companyId: string): Promise<{ auto: AutoRates | undefined; manual: ManualRates }> {
  const [auto, manual] = await Promise.all([readAutoRates(), readManualRates(companyId)]);
  return { auto, manual };
}

/**
 * Save the owner's rates: `perUsd` null removes that code's typed rate (back to the automatic one, or to «اكتب السعر»).
 * Only the codes sent are touched.
 */
export async function saveManualRates(
  companyId: string,
  changes: { code: string; perUsd: number | null }[],
  actorId: string,
  now: Date = new Date()
): Promise<ManualRates> {
  const saved = await updateCompanySettings<ManualRates>(companyId, MANUAL_KEY, (current) => {
    const rates = { ...(current?.rates ?? {}) };
    for (const c of changes) {
      const code = normCode(c.code);
      if (c.perUsd === null) delete rates[code];
      else rates[code] = { perUsd: c.perUsd, at: now.toISOString(), byId: actorId };
    }
    return { rates };
  });
  return saved ?? { rates: {} };
}

/** The currency codes this company really uses: its wallets' and its countries'. */
export async function companyCurrencyCodes(companyId: string): Promise<string[]> {
  const [wallets, countries] = await Promise.all([
    db.wallet.findMany({ where: { companyId }, select: { currencyCode: true }, distinct: ['currencyCode'] }),
    db.country.findMany({ where: { companyId }, select: { currencyCode: true }, distinct: ['currencyCode'] }),
  ]);
  return [...new Set([...wallets, ...countries].map((r) => normCode(r.currencyCode)))].sort();
}

/**
 * WHAT A DRAW FROM A WALLET IN ANOTHER CURRENCY COMES TO IN THE STORE'S, AT TODAY'S RATE — for the draws door, when the person left
 * «ما يعادله» empty. Today's rate is the rate of the day the draw is WRITTEN, also for a draw dated in the past: no history is looked up.
 */
export async function drawEquivalent(input: {
  companyId: string;
  amount: number;
  walletCode: string;
  storeCode: string;
  storeMinor: number;
  now?: Date;
}): Promise<Equivalent> {
  const { auto, manual } = await readRateTable(input.companyId);
  return equivalentOf(input.amount, input.walletCode, input.storeCode, input.storeMinor, auto, manual, input.now ?? new Date());
}
