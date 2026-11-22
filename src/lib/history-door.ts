import { NextResponse } from 'next/server';
import { db } from './db';
import { runInHeavyLane } from './heavy-lane';
import { buildXlsx, XLSX_CONTENT_TYPE } from './xlsx-writer';
import { readHistoryFilters, sheetCells, storeMoment, type HistoryFilters } from './history-export-core';
import { movementHistory, transferHistory, withdrawalHistory, type HistoryAnswer } from './history-export';
import { renderHistoryPage, renderHistoryRefusal } from './history-print';
import type { HistoryList } from './history-export-url';

/**
 * THE HISTORY DOOR'S ANSWER, once for the three lists (22/11, F5). The route asks its list's key FIRST (`finance.cashbox_view` for
 * the movements and the transfers, `finance.partners` for the withdrawals — the lists' own keys) and hands over the session's
 * company, store and day; this reads the filters, builds the rows and answers an .xlsx (`format=xlsx`, the default) or the page
 * ready to print (`format=print`).
 *
 * IN THE REPORTS LANE, NOT `heavyOnce`. One press is one file for one person, so there is no crowd of the same question to share —
 * and a file pressed a second after a movement was written must hold that movement, which a minute-old shared answer would not.
 * The lane keeps up to 5,000 rows' reads off the pool the desk and the pull wait on.
 */

const BUILDERS: Record<HistoryList, (scope: { companyId: string; storeId: string; timeZone: string }, f: HistoryFilters) => Promise<HistoryAnswer>> = {
  movements: movementHistory,
  transfers: transferHistory,
  withdrawals: withdrawalHistory,
};

/** ASCII file names: a header cannot carry Arabic bytes. */
const FILE_NAME: Record<HistoryList, string> = {
  movements: 'wallet-movements',
  transfers: 'wallet-transfers',
  withdrawals: 'partner-withdrawals',
};

export async function answerHistory(
  req: Request,
  list: HistoryList,
  ctx: { companyId: string; storeId: string; timeZone: string }
): Promise<Response> {
  const url = new URL(req.url);
  const print = url.searchParams.get('format') === 'print';
  const refuse = (r: { status: number; code: string; errorAr: string }) =>
    print
      ? new NextResponse(renderHistoryRefusal(r.errorAr), { status: r.status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
      : NextResponse.json({ error: r.errorAr, errorAr: r.errorAr, code: r.code }, { status: r.status });

  const read = readHistoryFilters(url.searchParams);
  if (!read.ok) return refuse(read.refusal);

  const answer = await runInHeavyLane(() => BUILDERS[list](ctx, read.value));
  if (!answer.ok) return refuse(answer.refusal);

  const today = storeMoment(new Date(), ctx.timeZone);
  if (print) {
    const [company, store] = await Promise.all([
      db.company.findUnique({ where: { id: ctx.companyId }, select: { name: true } }),
      db.store.findFirst({ where: { id: ctx.storeId, companyId: ctx.companyId }, select: { name: true } }),
    ]);
    const html = renderHistoryPage(answer.sheet, {
      companyName: company?.name ?? '',
      storeName: list === 'transfers' ? null : (store?.name ?? null),
      filtersAr: answer.filtersAr,
      printedAt: today,
    });
    return new NextResponse(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  const file = buildXlsx({ name: answer.sheet.title, header: answer.sheet.header, rows: sheetCells(answer.sheet) });
  const name = `${FILE_NAME[list]}-${today.slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': XLSX_CONTENT_TYPE,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
