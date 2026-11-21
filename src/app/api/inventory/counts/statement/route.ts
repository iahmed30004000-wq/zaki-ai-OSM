import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { maySeeCost } from '@/lib/cost-visibility';
import { StockCountRefused, countRefusalBody } from '@/lib/stock-counts';
import { reachFor } from '@/lib/stock-transfer-door';
import { keeperStatementAnswer, keeperStatementShown, resolveStatementPeriod } from '@/lib/keeper-statement';

/**
 * GET /api/inventory/counts/statement?warehouseId=…&period=30|90|all (inventory.count_approve) — «كشف عهدة الأمين»: one
 * warehouse of THIS store, its approved count sheets over the period (the store's days), each product's opening (its previous
 * count) + what the book did meanwhile = the expected figure, against what was counted (`lib/keeper-statement.ts`).
 *
 * Every figure is a book figure, so this asks the approver's key: the keeper who counts blind is refused by key. The warehouse
 * must be one the caller reaches (the count doors' own rule). The answer is a report — computed in the reports lane once per
 * (company, store, warehouse, period) and only then cut to what this person may read (the value at cost for `costs.view`).
 * Reading only; nothing here touches money.
 */
export async function GET(request: NextRequest) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    await requirePermission('inventory.count_approve');

    const url = new URL(request.url);
    const when = resolveStatementPeriod(url.searchParams.get('period'), new Date(), country.timezone);
    if (!when.ok) return NextResponse.json({ error: when.errorAr, errorAr: when.errorAr, code: when.code }, { status: 400 });

    const warehouseId = (url.searchParams.get('warehouseId') ?? '').trim();
    const wh = warehouseId
      ? await db.warehouse.findFirst({ where: { id: warehouseId, companyId }, select: { id: true, companyId: true, countryId: true, name: true } })
      : null;
    if (!wh) {
      const e = new StockCountRefused('WAREHOUSE_NOT_FOUND');
      return NextResponse.json(countRefusalBody(e), { status: e.status });
    }
    if (!(await reachFor(user, companyId)({ id: wh.id, companyId: wh.companyId, countryId: wh.countryId }))) {
      const e = new StockCountRefused('NOT_REACHED');
      return NextResponse.json(countRefusalBody(e), { status: e.status });
    }

    const answer = await keeperStatementAnswer({
      companyId,
      storeId,
      warehouse: { id: wh.id, name: wh.name },
      timeZone: country.timezone,
      minorUnit: country.minorUnit,
      when,
    });
    return NextResponse.json(keeperStatementShown(answer, maySeeCost(user)));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
