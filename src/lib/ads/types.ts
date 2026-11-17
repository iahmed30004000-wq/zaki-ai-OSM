/**
 * ONE SHAPE FOR EVERY AD PLATFORM.
 *
 * Meta, TikTok and Snapchat each answer a different API with a different
 * envelope, a different idea of what an account id looks like, and a
 * different way of expiring a token. What a seller wants from all three is
 * identical: is this connected, what campaigns are in it, and what did each
 * one spend.
 *
 * So the difference lives in an adapter and nowhere else. The routes, the
 * sync and the screen speak this interface and never name a platform — a
 * fourth one is a new file and a row in a list, not an `if` in six places.
 *
 * CREDENTIALS ARE A BAG, not a string, because the platforms disagree about
 * how many secrets a connection needs. Meta takes one long-lived token.
 * TikTok takes a token and the advertiser it belongs to. Snapchat's access
 * tokens die after thirty minutes, so it takes a client id, a secret and a
 * refresh token, and mints a fresh one on every call. A `token: string`
 * column would have forced the third of those into a lie.
 */

export type AdPlatform = 'META' | 'TIKTOK' | 'SNAPCHAT';

/** Whatever secrets one platform needs. Stored encrypted, as one JSON blob. */
export type AdCredentials = Record<string, string>;

export interface AdAccountInfo {
  /** The account as the platform names it, normalised. */
  id: string;
  name: string;
  currency: string;
  /** False for a disabled or suspended account — it connects and reports nothing. */
  active: boolean;
}

export interface RemoteCampaign {
  id: string;
  name: string;
  /** Normalised to ACTIVE / PAUSED / other, so the screen needs no per-platform map. */
  status: string;
  /**
   * WHEN THE PLATFORM SAYS IT STARTED, and it is not decoration.
   *
   * An imported campaign needs a start date because `syncAdSpend` asks the
   * platform for spend over the campaign's OWN WINDOW — so the date decides
   * which money is attributed to it. Importing with «today» would charge a
   * campaign that has been running for a month with nothing, and then with
   * one day's spend, for as long as nobody noticed.
   *
   * All three platforms expose it. `null` is still possible — a draft that
   * was never scheduled — and the importer says what it does then rather
   * than silently picking a day.
   */
  startedAt: Date | null;
}

/**
 * A DATE OUT OF AN API THAT RETURNS TIMES AS TEXT, in several shapes.
 *
 * Meta sends `2026-09-01T10:00:00+0300`, TikTok sends `2026-09-01 10:00:00`
 * (no zone, and `Date` reads that as LOCAL, which is close enough for a
 * day-grained window), Snapchat sends ISO with `Z`. All three sometimes
 * send an empty string or omit the field on a draft.
 *
 * An `Invalid Date` reaching a `DateTime` column is a write that throws
 * halfway through an import — some campaigns created, some not, and nothing
 * to say which without reading the rows. So this returns null instead, the
 * same way `money()` above returns 0 rather than NaN.
 */
export function adTime(v: unknown): Date | null {
  /*
   * THE EMPTY-STRING CHECK WAS HERE AND WAS DEAD CODE.
   *
   * A mutation removed `v.trim() === ''` and every test stayed green — so I
   * checked why rather than tightening the test: `new Date('')` is an
   * Invalid Date, and so is `new Date('   ')`, so the `Number.isNaN` line
   * below already answered both. A branch that can never change the answer
   * reads as live policy, and this repository has a name for that.
   *
   * The TYPE check is not redundant and stays: `new Date(0)` is a VALID
   * date (the epoch), so `adTime(0)` without it would return 1970 for a
   * platform that sent a number where a timestamp was expected.
   */
  if (typeof v !== 'string') return null;
  const d = new Date(v.includes(' ') && !v.includes('T') ? v.replace(' ', 'T') : v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** What one ad spent on one day — the daily grain the media buyer reads (`ads/daily.ts`). `date` is the day in the account's own timezone. */
export interface DailyAdSpendRow {
  date: string;
  adId: string;
  adsetId: string | null;
  campaignId: string | null;
  spend: number;
  currency: string;
  impressions: number | null;
  linkClicks: number | null;
}

export interface SpendRow {
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  clicks: number;
}

/** One field a seller has to fill in to connect this platform. */
export interface CredentialField {
  key: string;
  label: string;
  /** Rendered as a password field and never echoed back. */
  secret: boolean;
  placeholder: string;
  hint?: string;
}

export interface AdsAdapter {
  platform: AdPlatform;
  /** The full name, for a sentence that has room for it. */
  label: string;
  /**
   * One or two words, for a tab, a badge, or a sentence that already has a
   * clause in it. "نتحقق منها مع ميتا — فيسبوك وإنستغرام قبل الحفظ" is a
   * sentence the long name ruins.
   */
  short: string;
  /** What to ask for, in the order it should be asked. */
  fields: CredentialField[];
  /** Which field's value the four-character hint is taken from. */
  hintField: string;
  /** Where the seller goes to make the credentials, and how. */
  help: { url: string; urlLabel: string; steps: string[] };

  /** The account id in the platform's canonical form, or null if it is not one. */
  normalizeAccountId(raw: string): string | null;
  /** Does this open that account? Run BEFORE anything is stored. */
  verifyAccount(creds: AdCredentials, accountId: string): Promise<AdAccountInfo>;
  /**
   * EVERY AD ACCOUNT THIS TOKEN CAN REACH.
   *
   * Needed because signing in does not name an account: a token from an
   * OAuth consent reaches whatever the person administers, which may be
   * one account or fourteen. The paste-a-token form knows the id because
   * the seller typed it; a sign-in has to ask.
   *
   * Returns the inactive ones too, with `active: false`. A disabled
   * account a seller is expecting to see is better named and greyed than
   * silently absent — «my account is missing» is a support call, «your
   * account is disabled» is an answer.
   */
  listAccounts(creds: AdCredentials): Promise<AdAccountInfo[]>;
  /** The campaigns in the account, for the seller to match ours against. */
  listCampaigns(creds: AdCredentials, accountId: string): Promise<RemoteCampaign[]>;
  /** What each campaign spent between two `YYYY-MM-DD` dates. */
  fetchSpend(creds: AdCredentials, accountId: string, since: string, until: string): Promise<SpendRow[]>;
  /**
   * What each AD spent on each day between two `YYYY-MM-DD` dates — optional: only a platform that reports per ad per day implements it
   * (Meta). The sync skips the rest.
   */
  fetchDailyAdSpend?(creds: AdCredentials, accountId: string, since: string, until: string): Promise<DailyAdSpendRow[]>;
  /** The platform's error, turned into something a seller can act on. */
  explainError(e: unknown): string;
}

/**
 * A failure that came from the platform rather than from us.
 *
 * Carries the platform's own code so each adapter can tell an expired token
 * from a missing permission — different fixes, and telling them apart is
 * the difference between a seller solving it and a seller calling you.
 */
export class AdsError extends Error {
  constructor(message: string, readonly code?: number | string) {
    super(message);
    this.name = 'AdsError';
  }
}

/** `YYYY-MM-DD` — the one date shape all three accept. */
export function adDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * A number out of an API that returns money as text.
 *
 * All three do it, and all three sometimes return an empty string. Number('')
 * is 0 but Number(undefined) is NaN, and a NaN reaching a Decimal column is
 * a write that throws halfway through a sync — some campaigns updated, some
 * not, and no way to tell which without reading the rows.
 */
export function money(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
