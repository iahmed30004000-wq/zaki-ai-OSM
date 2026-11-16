import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { cartStoreWhere, cartVisibilityWhere } from '@/lib/abandoned-carts';

/**
 * GET /api/abandoned-carts/summary — the number on «السلات المهجورة» in the menu: the NEW carts this person may see in
 * this store. One count, no row and no contact detail, so the menu can ask it every minute.
 */
export async function GET() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const visible = cartVisibilityWhere(user);
    if (!visible) {
      return NextResponse.json({ error: 'لا تملك صلاحية عرض الطلبات.' }, { status: 403 });
    }
    const fresh = await db.abandonedCart.count({
      where: { companyId, status: 'NEW', AND: [visible, cartStoreWhere(storeId, country.code)] },
    });
    return NextResponse.json({ new: fresh });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
