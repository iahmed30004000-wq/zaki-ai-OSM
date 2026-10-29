/**
 * WHO IS THE RESPONSIBLE MODERATOR OF AN ORDER THE MOMENT IT IS TYPED (perm-plan PR-6, decision D10 / RV150).
 *
 * The owner's words, 28/10: «اي قرار بعد الان اتخذو دون الرجوع الي». The recommended answer to D10 was «the responsible
 * moderator = whoever created the order, if they do not hold `orders.assign`», and this is that rule, in one place, for
 * the two doors that create an order by hand (`POST /api/orders` and the AI intake's confirm step).
 *
 * WHAT IT REPLACES. Both doors wrote
 *
 *     moderatorId || (user.role === 'MODERATOR' ? user.id : null)
 *
 * — a ROLE NAME deciding who earns the commission, and `moderatorId` taken from the body whoever sent it: anybody holding
 * `orders.create` could name any colleague as the moderator of the order they typed, and with them the commission.
 *
 *   · NAMING SOMEBODY ELSE needs `orders.assign` (the key «إسناد الطلبات»). Naming yourself needs nothing.
 *   · NAMING NOBODY: whoever does not hold `orders.assign` owns what they type; whoever does is a person who hands orders
 *     out, so the order stays unowned until they do.
 *
 * WHAT IT DOES NOT TOUCH: nothing here reads or writes a price, a quantity, a gift, a total or the stock. It decides one
 * column and one refusal. The stock `MODERATOR` role does not hold `orders.assign`, so for it nothing changes at all; the
 * people it changes are the roles the owner built himself.
 *
 * Pure: the caller passes the answers (`can(user, 'orders.assign')`), so the rule is testable without a session.
 */
export interface ResponsibleModeratorInput {
  /** `moderatorId` as the request carried it (a string, or nothing). */
  requestedId: string | null | undefined;
  /** Who is typing the order. `null` for an order that has no person behind it. */
  creatorId: string | null;
  /** Does the creator hold `orders.assign`? */
  mayAssign: boolean;
}

export type ResponsibleModerator =
  | { ok: true; moderatorId: string | null }
  | { ok: false; code: 'MODERATOR_FORBIDDEN' };

export function responsibleModerator(input: ResponsibleModeratorInput): ResponsibleModerator {
  const requested = typeof input.requestedId === 'string' && input.requestedId.trim() !== '' ? input.requestedId : null;
  if (requested) {
    if (requested === input.creatorId) return { ok: true, moderatorId: requested };
    if (!input.mayAssign) return { ok: false, code: 'MODERATOR_FORBIDDEN' };
    return { ok: true, moderatorId: requested };
  }
  // Nobody named: the order belongs to the person who typed it unless they are the one who hands orders out.
  if (!input.mayAssign && input.creatorId) return { ok: true, moderatorId: input.creatorId };
  return { ok: true, moderatorId: null };
}

/** The one sentence the refusal says — Arabic only, the screen shows it as it is. */
export const MODERATOR_FORBIDDEN_AR = 'تسمية موظف مسؤول غيرك بدها صلاحية «إسناد الطلبات».';
