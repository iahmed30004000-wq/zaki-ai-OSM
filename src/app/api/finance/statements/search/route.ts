import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { can, requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { readQuery } from '@/lib/statement-search-rules';
import { searchAllStatements } from '@/lib/statement-search';

/**
 * /api/finance/statements/search — «بحث بكل الكشوف».
 *
 *   GET ?q=…          the lines of EVERY statement of the store that mention what was typed (our order number, the
 *                     courier's barcode, the company's reference — and, for who may read customers' numbers, the
 *                     customer's name or phone): which statement, what the matching made of the line, the answer, the
 *                     figures. Newest statement first, at most 50, with the true count beside them.
 *   GET ?q=…&scan=1   the same, for a whole barcode the camera read: the three-character minimum is waived, nothing else.
 *
 * ── WHO MAY ──
 *
 * `settlement.view`: the key every read of the matching screen already asks (`GET /api/finance/statements`, `…/:id`). It
 * is asked FIRST — a refusal reads nothing, not even the question. A name or a phone is searched only by a holder of
 * `customers.view`; for anybody else those clauses are not in the query at all (`statement-search`), and the answer carries
 * no customer's name or phone in any case.
 *
 * ── WHOSE ──
 *
 * The company and the store come from the session, never from the request, and every query and sub-query carries both. A
 * statement of another store cannot be listed, and cannot be reached through an order either.
 *
 * ── IT WRITES NOTHING ──
 *
 * Read-only, no figure is worked out here, no audit row: the three figures of a line are the stored ones.
 */
export async function GET(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('settlement.view');

    const read = readQuery(new URL(req.url).searchParams);
    if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

    const answer = await searchAllStatements(db, {
      scope: { companyId, storeId },
      q: read.q,
      // The address-book key: the customer's name and phone are searched only by somebody who is shown them elsewhere.
      maySeeContact: can(user, 'customers.view'),
    });
    return NextResponse.json(answer);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
