import { NextResponse } from 'next/server';
import { apiErrorResponse } from '@/lib/api-error';
import { requireContext } from '@/lib/geo-context';
import { can, getPermissionScope } from '@/lib/authorization';
import { manageableUsersWhere } from '@/lib/manageable-user';
import { creatablesFor } from '@/lib/palette-create';
import { paletteProducts } from '@/lib/palette-products';
import { paletteCounts, paletteSummary, readsTheWholeStore } from '@/lib/palette-intel';
import { typed } from '@/lib/text-search';
import { rateLimit } from '@/lib/rate-limit';
import { db } from '@/lib/db';
import { ROLE_LABELS, type UserRole } from '@/types/auth';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE PALETTE'S ONE DOOR — AND WHY IT IS TWO METHODS.
 *
 * GET  — the summary an open palette shows. Takes nothing.
 * POST — the counters a typed word asks for. Takes `{ q }` IN THE BODY.
 *
 * The body is the whole reason POST exists for a read. One of the things a
 * person types here is a customer's phone number, and a query string is
 * the one part of a request that is written down everywhere by default:
 * the proxy's access log, the server's own request log, the browser's
 * history, any error report that carries a URL. «الهاتف لا يخرج من
 * الخادم» cannot be true of a value that was in the URL on the way in.
 *
 * The existing record search above this one is `GET /api/orders?q=` and
 * stays that way — it is the owner's alone and it is the orders list's own
 * door. This is a new door, and a new door may be built right.
 *
 * ── SCOPE IS DECIDED HERE, NOT ASKED FOR ──
 *
 * There is no `scope`, no `wide`, no `storeWide` parameter. The client
 * cannot ask for the store's numbers, so a staff account cannot be talked
 * into being handed them: `paletteSummary` reads the role's own
 * `orders.view` scope and counts by `orderListWhere`.
 * ═══════════════════════════════════════════════════════════════════════
 */

/** Everything the palette may do, decided on the server and sent as facts. */
async function capabilities(user: Parameters<typeof readsTheWholeStore>[0]) {
  return {
    /** «اسحب» — the same permission the pull screen's own button is behind. */
    pull: can(user, 'confirmation.pull'),
    /** A staff member's name opens their page only for who may open it. */
    people: can(user, 'users.view'),
    /** The whole store's numbers, or this desk's. */
    wide: readsTheWholeStore(user),
    /**
     * «لخّصلي اليوم» — the same two keys its door asks (`/api/palette/today`: the numbers on `orders.view`, the sentence on
     * `ai.assist`), so the box offers it to exactly the people it will answer.
     */
    today: !!getPermissionScope(user, 'orders.view') && can(user, 'ai.assist'),
    /**
     * «+ أنشئ» — the forms this account may be taken to, drawn here and not in the box: the screen must be one it may open AND the
     * permission must be the one the form's own button is behind (`palette-create.ts`). The box carries no list of its own.
     */
    create: creatablesFor(user, can),
  };
}

export async function GET() {
  try {
    const { user, companyId, storeId } = await requireContext();

    // No `requirePermission`: the summary IS the role's own scope, and an
    // account with no `orders.view` grant at all gets an envelope of
    // `{ id: '__no_access__' }` from `orderListWhere` — five honest zeroes
    // rather than a 403 on a box that is also the only way to reach a
    // screen. Measured, not assumed: see the PENDING_USER case in the test.
    if (!getPermissionScope(user, 'orders.view')) {
      return NextResponse.json({ facts: [], may: await capabilities(user) });
    }

    const rl = rateLimit(`palette:${companyId}:${user.id}`, 60, 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { errorAr: `طلبات كثيرة جداً. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    return NextResponse.json({
      facts: await paletteSummary({ companyId, storeId }, user),
      may: await capabilities(user),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();

    const body = (await req.json().catch(() => null)) as { q?: unknown } | null;
    const term = typeof body?.q === 'string' ? body.q.trim().slice(0, 80) : '';
    if (term.length < 2) return NextResponse.json({ facts: [], people: [], products: [] });

    const rl = rateLimit(`palette:${companyId}:${user.id}`, 60, 60 * 1000);
    if (!rl.allowed) {
      return NextResponse.json(
        { errorAr: `طلبات كثيرة جداً. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429 }
      );
    }

    /*
     * PRODUCTS, ON THEIR OWN GRANT. A catalogue keeper with no `orders.view` still finds a product
     * here — the box is also how they reach their screen. The orders-shaped answers below stay
     * behind `orders.view`, exactly as they were.
     */
    const products = await paletteProducts(user, { companyId, storeId }, term);

    if (!getPermissionScope(user, 'orders.view')) {
      return NextResponse.json({ facts: [], people: [], products });
    }

    /*
     * A STAFF MEMBER'S NAME, FOR WHOEVER MAY ALREADY READ THE LIST.
     *
     * `users.view` is the grant the «الموظفين» screen is behind, and
     * `manageableUsersWhere` is the tenant envelope that screen's own
     * route applies. Both, so this cannot become a way to learn that an
     * account exists in another company.
     *
     * A colleague's name is not customer data — but it is also not
     * everyone's to search, which is why the whole branch is skipped
     * rather than filtered afterwards.
     */
    const people = can(user, 'users.view')
      ? await db.user
          .findMany({
            where: { AND: [manageableUsersWhere(user), { name: typed(term) }] },
            orderBy: { name: 'asc' },
            take: 4,
            select: { id: true, name: true, role: true },
          })
          .then((rows) =>
            rows.map((row) => ({
              id: row.id,
              name: row.name,
              roleAr: ROLE_LABELS[row.role as UserRole]?.ar ?? row.role,
            }))
          )
      : [];

    return NextResponse.json({
      facts: await paletteCounts({ companyId, storeId }, user, term),
      people,
      products,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
