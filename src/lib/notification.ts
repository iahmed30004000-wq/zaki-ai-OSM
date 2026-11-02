import { db } from './db';
import { resolveAudience, type Audience } from './notification-audience';
import { canAccessRoute, findRoute } from './route-registry';
import type { SessionUser } from '@/types/auth';
import { can } from './authorization';

/**
 * ANNOUNCING SOMETHING TO THE PEOPLE IT CONCERNS.
 *
 * One row per recipient. The read flag belongs to a person, so a row shared
 * by many cannot carry it: when ten places wrote a single row for the whole
 * company, the first person to open it marked it read for everybody, and
 * a moderator's bell carried every confirmation in every store.
 *
 * The audience is resolved by notification-audience.ts — named people
 * and/or holders of a permission, who can enter the store — and the actor
 * is never told about their own action.
 *
 * NEVER THROWS. Every caller announces something that has already happened
 * (an order saved, a status committed); a notification that fails must not
 * turn a done thing into an error response, and must not undo it. Failures
 * are logged and the call answers 0.
 */

export type NotificationType =
  | 'ORDER_NEW'
  | 'FOLLOW_UP'
  | 'LOW_STOCK'
  | 'HIGH_REJECTION'
  | 'SYSTEM_ALERT'
  | 'PERFORMANCE'
  | 'POSTPONED_DUE'
  | 'RETURNS_NOT_RECEIVED'
  | 'CLOSING_DUE';

/**
 * The first of these screens the recipient may open, or null.
 *
 * A link is a promise that clicking leads somewhere. The change-request
 * alert sent the holding agent to a queue her role cannot open, and the
 * shared rows sent everyone to finance and returns screens most of them
 * are refused at. So each recipient gets the first link that the same
 * guard the page uses (route-registry) would let them through, and none
 * rather than a 403 or a 404. The query string does not change the guard.
 */
export function linkFor(user: SessionUser, links: readonly string[]): string | null {
  for (const link of links) {
    const route = findRoute(link.split('?')[0]);
    if (route && canAccessRoute(user, route, can)) return link;
  }
  return null;
}

export async function createNotification({
  companyId,
  storeId = null,
  audience,
  actorId = null,
  title,
  message,
  type = 'SYSTEM_ALERT',
  link,
  recipients: given,
  orderId,
}: {
  companyId: string;
  /** The store the news is about; null = company-wide (no store filter). */
  storeId?: string | null;
  audience: Audience;
  /**
   * The audience already resolved, when the caller tells many people about
   * many things in one store: a job announcing two hundred postponed orders
   * resolves the store's supervisors ONCE instead of two hundred times.
   * When given, `audience` is not resolved again.
   */
  recipients?: readonly SessionUser[];
  /** Who caused it — left out of the audience. */
  actorId?: string | null;
  title: string;
  message: string;
  type?: NotificationType;
  /** Where a click goes; a list is tried in order, per recipient (see linkFor). */
  link?: string | readonly string[];
  /**
   * The order this news is about. When given, only the recipients the order sheet would OPEN for are told
   * (`whoMayOpenOrder`): a notice whose order answers «غير موجود» is not news, it is a dead link.
   */
  orderId?: string;
}): Promise<number> {
  try {
    const recipients = given
      ? [...new Map(given.filter((u) => u.id !== actorId).map((u) => [u.id, u])).values()]
      : await resolveAudience({ companyId, storeId, audience, actorId });
    if (recipients.length === 0) return 0;
    // Loaded here, not at the top: rbac.ts reads authorization.ts as it loads, and the route tests that stub authorization.ts
    // reach this module through the doors they test — a top-level import made every one of them fail to load.
    const told = orderId
      ? await (await import('./rbac')).whoMayOpenOrder(recipients, { id: orderId, companyId, storeId })
      : recipients;
    if (told.length === 0) return 0;

    const links = link == null ? [] : typeof link === 'string' ? [link] : link;
    const { count } = await db.notification.createMany({
      data: told.map((user) => ({
        companyId,
        storeId,
        userId: user.id,
        title,
        message,
        type,
        link: linkFor(user, links),
      })),
    });
    return count;
  } catch (error) {
    console.error('Failed to create notification:', error);
    return 0;
  }
}
