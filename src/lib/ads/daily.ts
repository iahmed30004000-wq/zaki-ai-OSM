import { db } from '../db';
import { inStore } from '../store-filter';
import { adapterFor, readCredentials, adDate } from './index';
import { WITH_A_PLATFORM } from './manual';

/**
 * THE DAILY GRAIN OF AD SPEND — one row per ad per day (PR-A of the media buyer's doors).
 *
 * `syncAdSpend` keeps what a CAMPAIGN has cost in total, and the screens read that. The media buyer decides per AD and per day, so it
 * needs the finer view of the same Meta numbers: this pulls it into `AdSpendDay`, and `GET /api/v1/ad-spend` reads it from there. Meta is
 * asked here, once a day by the `pull-ad-spend` job, and NEVER at the moment the media buyer calls — an endpoint rated at 30 a minute must
 * not turn into 30 calls a minute to a platform that rate-limits the whole account.
 *
 * ── HOW FAR BACK ──
 *
 * The first time an account is seen: 31 days (the most the door can be asked for). Afterwards: the last 7, because Meta restates recent
 * days (late conversions, invalid-traffic credits) and older ones do not move. A window is REPLACED for the account only when Meta
 * answered with rows — an empty answer never wipes what is stored, so a bad minute cannot erase a month.
 *
 * ── WHAT IS NEVER DONE ──
 *
 * It writes nothing on a campaign, an order or an account's status: `syncAdSpend` owns those. A platform that does not report per ad per
 * day is skipped; a row whose currency is not three capital letters is skipped (the contract cannot carry a figure with no currency). One
 * account failing does not stop the others, and the failure is a line in the report, not an exception — the campaign sync that ran just
 * before it must not look failed because this one did.
 */

export interface DailySyncResult {
  rows: number;
  errors: string[];
}

/** The first pull of an account, and the usual one — see the header. */
export const BACKFILL_DAYS = 31;
export const REFRESH_DAYS = 7;

const DAY_MS = 86_400_000;

export async function syncDailyAdSpend(scope: { companyId: string; storeId: string | null }, now: Date = new Date()): Promise<DailySyncResult> {
  const accounts = await db.adAccount.findMany({
    where: { ...inStore(scope.companyId, scope.storeId), ...WITH_A_PLATFORM },
    select: { id: true, storeId: true, platform: true, accountId: true, accountName: true, tokenEncrypted: true },
  });

  const errors: string[] = [];
  let rows = 0;

  for (const account of accounts) {
    const adapter = adapterFor(account.platform);
    if (!adapter?.fetchDailyAdSpend || !account.tokenEncrypted) continue;
    const label = account.accountName ?? account.accountId;
    try {
      const have = await db.adSpendDay.count({ where: { companyId: scope.companyId, adAccountId: account.id } });
      const days = have === 0 ? BACKFILL_DAYS : REFRESH_DAYS;
      const since = adDate(new Date(now.getTime() - days * DAY_MS));
      const until = adDate(now);

      const got = await adapter.fetchDailyAdSpend(readCredentials(account.tokenEncrypted), account.accountId, since, until);
      const data = got
        .filter((r) => /^[A-Z]{3}$/.test(r.currency) && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.spend))
        // One row per (day, ad): Meta does not repeat one, but the unique key would turn a repeat into a failed sync.
        .filter((r, i, all) => all.findIndex((x) => x.date === r.date && x.adId === r.adId) === i)
        .map((r) => ({
          companyId: scope.companyId,
          storeId: account.storeId,
          adAccountId: account.id,
          date: new Date(`${r.date}T00:00:00.000Z`),
          adId: r.adId,
          adsetId: r.adsetId,
          campaignId: r.campaignId,
          spend: Number(r.spend.toFixed(3)),
          currency: r.currency,
          impressions: r.impressions,
          linkClicks: r.linkClicks,
          pulledAt: now,
        }));
      if (data.length === 0) continue;

      await db.$transaction([
        db.adSpendDay.deleteMany({
          where: {
            companyId: scope.companyId,
            adAccountId: account.id,
            date: { gte: new Date(`${since}T00:00:00.000Z`), lte: new Date(`${until}T00:00:00.000Z`) },
          },
        }),
        db.adSpendDay.createMany({ data, skipDuplicates: true }),
      ]);
      rows += data.length;
    } catch (e) {
      errors.push(`${label}: ${adapter.explainError(e)}`);
    }
  }

  return { rows, errors };
}
