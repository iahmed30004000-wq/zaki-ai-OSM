import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';

/**
 * GET /api/orders/form-options — WHAT THE ORDER FORM OFFERS, FOR WHOEVER MAY TYPE AN ORDER (perm-plan PR-6).
 *
 * The «new order» form filled its two pickers from two doors that were never about order entry:
 *
 *   · the channels, from `GET /api/settings/channels` (a settings route that anyone with `orders.view` could also read);
 *   · the moderators, from `GET /api/moderators` — behind `users.view`, and carrying each moderator's sales, rate and
 *     commission, so a person who needed a NAME in a picker was handed the team's money to get it, and a person with
 *     `orders.create` and no `users.view` saw an empty picker that still accepted a typed id.
 *
 * This door answers exactly what the form needs and nothing else, to exactly who the form is for:
 *
 *   · the active channels — id and name;
 *   · the moderators — id and name only, AND ONLY FOR SOMEBODY WHO HOLDS `orders.assign`. Naming a responsible moderator
 *     other than yourself needs that key at the order door (`POST /api/orders`, RV150), so offering the list to anyone
 *     else is a picker whose every choice would be refused. `mayAssign` says which case this is, and the form draws the
 *     picker only when it is true.
 *
 * Nothing about a person's money leaves here. The old doors stay as they are for the screens that read them.
 */
export async function GET() {
  try {
    const { user, companyId } = await requireContext();
    await requirePermission('orders.create');

    const mayAssign = can(user, 'orders.assign');

    const [channels, moderators] = await Promise.all([
      db.orderChannel.findMany({
        where: { companyId, isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true },
      }),
      mayAssign
        ? db.user.findMany({
            where: { companyId, role: 'MODERATOR', status: 'ACTIVE' },
            orderBy: { name: 'asc' },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);

    return NextResponse.json({ channels, moderators, mayAssign });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
