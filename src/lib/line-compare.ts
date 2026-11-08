import { normalizePhrase } from './couriers/words';
import { canonicalPhone, phoneKeys, phoneKeysAnyStore } from './phone-rules';

/**
 * «كيف بدي أقارن بين الطلب الموجود والطلب اللي عنا عشان أعرف إنو هو ولا لأ» — the owner, 8/11, in the dialog that ties a
 * company's line to an order.
 *
 * The dialog showed an order's number, phone, name and what we expect, and nothing of what the company WROTE, so there was
 * nothing to hold the one against the other. It now shows both, field by field, and says for the three fields that CAN be
 * compared without guessing whether they agree:
 *
 *   · the phone      — the same number in any form a customer may be stored in (national, with its code, as typed);
 *   · the governorate — the same name once hamza, ة/ه and ى/ي are folded and a leading «محافظة» is dropped;
 *   · the net         — the figure the company hands over for the line against the one we expect for the order, which is
 *                       what the link would be judged by (`judgeLine`), measured by the server and only compared here.
 *
 * A name and an address are NOT compared: one is written in Arabic and the other in Latin letters, one says «حي الوسط» and
 * the other «بجانب الفرن», and a verdict that is right most days is the one that settles the wrong order. They are laid side
 * by side for a person to read. Nothing here decides a link — the person presses it, and the matcher's own rule judges it.
 *
 * Pure: no database, no clock, no arithmetic on money beyond «is the distance below half a minor unit».
 */

export type Agreement = 'SAME' | 'DIFFERENT' | 'UNKNOWN';

/** Does the order's customer hold the phone the company wrote? UNKNOWN when either side has none. */
export function comparePhones(
  lineKeys: readonly string[] | null | undefined,
  customer: { phone?: string | null; rawPhone?: string | null } | null | undefined,
  storeCountry?: string | null
): Agreement {
  if (!lineKeys || lineKeys.length === 0) return 'UNKNOWN';
  const ours = new Set<string>();
  for (const raw of [customer?.phone, customer?.rawPhone]) {
    if (!raw) continue;
    for (const key of phoneKeysAnyStore(raw)) ours.add(key);
    const canonical = canonicalPhone(raw, storeCountry);
    if (canonical) for (const key of phoneKeys(canonical)) ours.add(key);
  }
  if (ours.size === 0) return 'UNKNOWN';
  return lineKeys.some((key) => ours.has(key)) ? 'SAME' : 'DIFFERENT';
}

const governorateKey = (name: string) => normalizePhrase(name).replace(/^محافظه\s+/, '');

/** Is it the same governorate? A governorate is a name, not a prefix: «دمشق» and «ريف دمشق» are two. */
export function compareGovernorates(line: string | null | undefined, order: string | null | undefined): Agreement {
  const a = line?.trim();
  const b = order?.trim();
  if (!a || !b) return 'UNKNOWN';
  return governorateKey(a) === governorateKey(b) ? 'SAME' : 'DIFFERENT';
}

/**
 * Is the net the company states for the line the net we expect for the order? `distance` is the absolute gap the server
 * already measured (`candidatesOf`); the two agree when it is below half of the currency's smallest unit.
 */
export function compareAmounts(distance: number | null | undefined, minorUnit: number): Agreement {
  if (distance === null || distance === undefined || !Number.isFinite(distance)) return 'UNKNOWN';
  const decimals = Math.max(0, Math.min(6, Math.trunc(minorUnit)));
  return distance < 0.5 / 10 ** decimals ? 'SAME' : 'DIFFERENT';
}
