import { REPULL_RELEASE_REASON, ROUND_RELEASE_REASON } from './no-answer-rounds';

/**
 * AN ORDER THE SYSTEM TAKES BACK IS TAKEN BY THE SYSTEM — AND SHE IS TOLD (the owner's ruling 4/11).
 *
 * Three releases let a held order go without anybody pressing anything: the ninety-minute release (nothing logged on it),
 * and the two of «نظام الجولات» (a round nobody answered, a re-pull nobody touched). Each wrote its claim-history line with
 * `userId` = the agent who held it, and an English code for a reason. So the order's history read «تحرير الطلب — <her name>»
 * — she had released it, as far as anybody reading could tell — and she herself heard nothing: the card left «طلباتي»,
 * and her next press on it was refused «اسحب الطلب أولاً».
 *
 * ── WHY `userId` STAYS HERS ──
 *
 * `order_claim_history.userId` is NOT NULL with a foreign key to a user, and there is no system user to point it at. So the
 * row keeps whose order it was (the reports that read releases per agent read it that way), and says that nobody pressed
 * anything in `metadata` — `{ automatic: true, holder }` — which the timeline reads to write «النظام» as the actor. A row
 * written before this rule carries no metadata, so the reason is read too: every `AUTO_RELEASE…` reason is the system's.
 *
 * ── AND SHE IS TOLD, IN THE SAME TRANSACTION ──
 *
 * One notification per release, to the holder, written beside the release itself — a release that is rolled back tells
 * nobody, and one that commits is never silent. The bell polls, so it reaches her shell within the minute.
 */

/** The ninety-minute release's reason, exactly as `releaseStaleClaims` writes it (`AUTO_RELEASE_${90}_BUSINESS_MINUTES`). */
export const NINETY_MINUTE_RELEASE_REASON = 'AUTO_RELEASE_90_BUSINESS_MINUTES';

/** Why the order went back, in her words — the notification's sentence after «رجع ORD-… للطابور:». */
export const AUTO_RELEASE_WHY: Record<string, string> = {
  [NINETY_MINUTE_RELEASE_REASON]: 'ما انسجّلت عليه محاولة خلال 90 دقيقة عمل',
  [ROUND_RELEASE_REASON]: 'مرّت 3 ساعات عمل على جولة بلا ردّ',
  [REPULL_RELEASE_REASON]: 'انسحب من جديد وما انسجّلت عليه محاولة خلال 90 دقيقة عمل',
};

/** The actor the timeline writes for a release nobody pressed. */
export const SYSTEM_ACTOR_AR = 'النظام';

/** Where the notification leads: her own desk, where the order was. */
export const RELEASE_NOTICE_LINK = '/confirmation/mine';

/** The claim-history metadata of an automatic release: nobody pressed it, and whose order it was. */
export function automaticReleaseMetadata(holderId: string): string {
  return JSON.stringify({ automatic: true, holder: holderId });
}

/** Was this claim-history line written by the system rather than by the person in `userId`? */
export function isAutomaticRelease(row: { action: string; reason?: string | null; metadata?: string | null }): boolean {
  if (row.action !== 'RELEASED') return false;
  if (typeof row.reason === 'string' && row.reason.startsWith('AUTO_RELEASE')) return true;
  if (!row.metadata) return false;
  try {
    const m = JSON.parse(row.metadata) as { automatic?: unknown } | null;
    return !!m && m.automatic === true;
  } catch {
    return false;
  }
}

/** The one notification a release writes to the agent who held the order. */
export function releaseNotice(v: {
  companyId: string;
  storeId: string;
  holderId: string;
  orderNumber: string;
  reason: string;
}) {
  const why = AUTO_RELEASE_WHY[v.reason] ?? 'تحرير تلقائي';
  return {
    companyId: v.companyId,
    storeId: v.storeId,
    userId: v.holderId,
    title: `رجع ${v.orderNumber} للطابور`,
    message: `رجع ${v.orderNumber} للطابور: ${why}`,
    type: 'SYSTEM_ALERT',
    link: RELEASE_NOTICE_LINK,
  };
}
