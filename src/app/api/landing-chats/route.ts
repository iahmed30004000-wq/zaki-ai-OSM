/**
 * GET /api/landing-chats — «رسائل اللاندينج»: the landing chat threads Zaki pages relayed (contract oms-lp.v1 §11),
 * newest first. Filters: filter (all / unread / staff = the bot is paused), q (phone, name, order, page, product).
 * `whatsapp.view`, the conversations' own permission. Polled every few seconds, so the user is read once.
 */
import { NextResponse } from 'next/server';
import { requirePermission, tenantOf } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import { noteCustomersHandedOut } from '@/lib/pii-alert';
import { listLandingThreads, unreadLandingThreads, type ThreadFilter } from '@/lib/inbox/landing-threads';

const FILTERS: ThreadFilter[] = ['all', 'unread', 'staff'];

export async function GET(req: Request) {
  try {
    const user = await requirePermission('whatsapp.view');
    const { companyId } = await tenantOf(user);
    const { searchParams } = new URL(req.url);
    const f = searchParams.get('filter') as ThreadFilter | null;
    const filter = f && FILTERS.includes(f) ? f : 'all';
    const [list, unread] = await Promise.all([
      listLandingThreads(companyId, {
        filter,
        q: searchParams.get('q')?.slice(0, 100) ?? '',
        cursor: searchParams.get('cursor')?.trim() || undefined,
      }),
      unreadLandingThreads(companyId),
    ]);
    // A phone the customer gave in the chat is a contact detail handed out: it adds to the reader's tally, as every list does.
    await noteCustomersHandedOut({
      companyId,
      storeId: null,
      user,
      where: 'رسائل اللاندينج',
      rows: list.threads.filter((t) => t.customerPhone).map((t) => ({ phone: t.customerPhone })),
    });
    return NextResponse.json({ ...list, unreadThreads: unread }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
