import { DUE_RELEASE_REASON, REPULL_RELEASE_REASON, ROUND_RELEASE_REASON } from './no-answer-rounds';

/**
 * AN ORDER THE SYSTEM TAKES BACK IS TAKEN BY THE SYSTEM — AND SHE IS TOLD (the owner's ruling 4/11).
 *
 * Four releases let a held order go without anybody pressing anything: the ninety-minute release (nothing logged on it),
 * and the three of «نظام الجولات» (a round nobody answered, a re-pull nobody touched, and — since 7/11 — a dated order
 * with no attempt logged after its date). Each wrote its claim-history line with
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
 *
 * ── A THIRD KIND: A SUPERVISOR RETURNED HER PILE (the owner, 8/11) ──
 *
 * «أرجِع «لا يرد» للطابور» on a watched desk (`return-no-answer-pile.ts`) lets go of a pile of her «لا يرد» orders by a
 * PERSON's press: not the system's, and not hers. The line keeps `userId` = the holder (the column cannot be empty, and the
 * per-agent reports read a release that way) and says in `metadata` who pressed: `{ pulledBack: true, from, by: { id, name } }`.
 * The timeline writes THAT person as the actor («أرجعها <name>»), never «النظام» and never her; attendance does not read it as
 * work of hers (`isReleaseSheDidNotPress`); and she gets ONE notification for the whole press (`managerReturnNotice`), not one
 * per order. `releaseNotice` above is one order's sentence by the system's clock, so it is not reused: a summary names the
 * person and the count — and borrows its shape, its type and its link.
 */

/** The ninety-minute release's reason, exactly as `releaseStaleClaims` writes it (`AUTO_RELEASE_${90}_BUSINESS_MINUTES`). */
export const NINETY_MINUTE_RELEASE_REASON = 'AUTO_RELEASE_90_BUSINESS_MINUTES';

/** Why the order went back, in her words — the notification's sentence after «رجع ORD-… للطابور:». */
export const AUTO_RELEASE_WHY: Record<string, string> = {
  [NINETY_MINUTE_RELEASE_REASON]: 'ما انسجّلت عليه محاولة خلال 90 دقيقة عمل',
  [ROUND_RELEASE_REASON]: 'مرّت 12 ساعة عمل على جولة بلا ردّ',
  [REPULL_RELEASE_REASON]: 'انسحب من جديد وما انسجّلت عليه محاولة خلال 90 دقيقة عمل',
  [DUE_RELEASE_REASON]: 'مرّت 3 ساعات عمل على موعد الطلب وما انسجّلت عليه محاولة بعد الموعد',
};

/** The actor the timeline writes for a release nobody pressed. */
export const SYSTEM_ACTOR_AR = 'النظام';

/** The claim-history reason of a supervisor's return of her pile — named in Arabic on the timeline (`order-timeline.ts`). */
export const MANAGER_RETURNED_REASON = 'MANAGER_RETURNED';

/** The claim-history metadata of a supervisor's return: not the system's (`automatic`), and who pressed it — and whose order it was. */
export function managerReturnMetadata(holderId: string, by: { id: string; name: string }): string {
  return JSON.stringify({ pulledBack: true, from: holderId, by: { id: by.id, name: by.name } });
}

/**
 * Who returned the pile, when this claim-history line is a supervisor's return that says who: `{ id, name }` (the name is what
 * the line was written with — empty when it carried none), else null. Read inside a try: a line that is not JSON is not a return
 * we can name, and breaks nothing.
 */
export function managerReturnedBy(row: { action: string; reason?: string | null; metadata?: string | null }): { id: string; name: string | null } | null {
  if (row.action !== 'RELEASED' || row.reason !== MANAGER_RETURNED_REASON || !row.metadata) return null;
  try {
    const m = JSON.parse(row.metadata) as { by?: { id?: unknown; name?: unknown } | null } | null;
    const id = m?.by?.id;
    if (typeof id !== 'string' || id === '') return null;
    const name = m?.by?.name;
    return { id, name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null };
  } catch {
    return null;
  }
}

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

/**
 * A release that carries her name and that she did NOT press — so it is not work anybody saw her do.
 *
 * Two kinds: the system's (`isAutomaticRelease`, above), and a colleague's take «على الخط»
 * (`{ automatic: false, takenBy }`, written in the HOLDER's name because the line says whose order it was). Attendance
 * reads the claim history as «what the system SAW her do»; counting these made a day she never came look like a day she
 * was there — her held orders going back by the clock wrote lines in her name — and pulled an arrival she had marked
 * back to the line's moment, so she read as less late than she was (or on time, when the line fell before the shift).
 *
 * A release she pressed herself (the button, or a supervisor pulling an order back — written in the presser's name)
 * carries neither mark and still counts.
 *
 * A third kind (8/11): a supervisor's return of her «لا يرد» pile (`MANAGER_RETURNED_REASON`) is written in HER name too —
 * and she did not press it. Read by its reason alone, as the automatic ones are: a line whose metadata cannot be read is
 * still a supervisor's.
 */
export function isReleaseSheDidNotPress(row: { action: string; reason?: string | null; metadata?: string | null }): boolean {
  if (isAutomaticRelease(row)) return true;
  if (row.action === 'RELEASED' && row.reason === MANAGER_RETURNED_REASON) return true;
  if (row.action !== 'RELEASED' || !row.metadata) return false;
  try {
    const m = JSON.parse(row.metadata) as { takenBy?: unknown } | null;
    return !!m && typeof m.takenBy === 'string' && m.takenBy !== '';
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

/**
 * The ONE notification a supervisor's return writes to the agent whose pile it was — for the whole press, not per order.
 * `releaseNotice` names one order and a clock-written reason, so it cannot say who pressed or how many; this has its shape
 * (store, recipient, `SYSTEM_ALERT`, a link to her own desk) and a sentence of its own.
 */
export function managerReturnNotice(v: {
  companyId: string;
  storeId: string;
  holderId: string;
  by: { name: string };
  returned: number;
}) {
  const who = v.by.name.trim() || 'المشرف';
  return {
    companyId: v.companyId,
    storeId: v.storeId,
    userId: v.holderId,
    title: `${who} أرجع ${v.returned} طلب «لا يرد» للطابور`,
    message: `${who} أرجع ${v.returned} طلب «لا يرد» من طلباتك للطابور. بتضل بإيدك اللي عليهم موعد أو اللي ردّ زبونهم.`,
    type: 'SYSTEM_ALERT',
    link: RELEASE_NOTICE_LINK,
  };
}
