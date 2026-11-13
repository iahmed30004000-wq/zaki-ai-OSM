import type { db as Db } from '../db';
import { COURIER_OUTCOME_AR, readCourierWord } from '../couriers/words';
import { claimOf, decisionMatrix, loadDecisionFacts } from '../settlement-decisions';
import { shortfall } from '../settlement-difference';
import { isMatchingClosed } from '../settlement-gates';
import type { DifferenceLine, DifferenceOnTheRow } from './difference-words';

/**
 * WHICH PARCELS CARRY A DIFFERENCE — «واذا المطابقة رجعت في فرق حط جنبو علامة» (the owner, 13/11).
 *
 * A statement line that does not agree with our figure is a `SettlementMatch` row whose result is `MISMATCHED`. The
 * follow-up screen draws a mark on its parcel, counts the parcels that carry one (a chip beside the others) and lets the
 * person who may answer it do so from the row — through the matching screen's own door; nothing is written from here.
 *
 * ── WHICH ROW IS «THE» DIFFERENCE OF A PARCEL ──
 *
 * A parcel can be named by more than one statement, and a statement by more than one line. The rule, said once:
 *
 *   1. ONLY A LINE THAT SPOKE ABOUT THE MONEY COUNTS — `MATCHED` and `MISMATCHED`. The sweep's «no statement names it»
 *      row, the company's zero line for a parcel it says came back or waits, and a line no order carries are not a
 *      figure that agrees or disagrees with ours: they never supersede a difference and never are one. (A later statement
 *      that does not list a still-unsettled parcel would otherwise hide the very difference that is waiting for an answer.)
 *   2. THE NEWEST LINE DECIDES WHETHER THERE IS ONE. If the newest is a clean `MATCHED` the parcel has none: the company's
 *      later, right line settled what the earlier one disagreed about. A tie in time never hides a disagreement behind a
 *      clean line.
 *   3. OF THE DIFFERENCES THAT STAND (newer than the newest clean line) THE ONE STILL A QUESTION COMES FIRST: an
 *      unanswered line on a statement whose matching is still open is where an answer can still be written, and it holds
 *      that statement's close — so it is the parcel's difference even when a newer statement's line was answered or its
 *      matching closed. Without such a line, the newest one: answered, or closed and read-only.
 *
 * «Newest» is the match row's own time. A re-run of an older statement's matching rebuilds its unanswered rows, so such a
 * row can become the newest — and an unanswered question on an open statement is the one rule 3 puts first anyway.
 */

export const DIFFERENCE_RESULT = 'MISMATCHED' as const;
const CLEAN_RESULT = 'MATCHED' as const;

/** What the rule needs of one match row. */
export interface DifferenceRow {
  id: string;
  orderId: string;
  result: string;
  resolution: string | null;
  createdAt: Date;
  /** The statement's MATCHING is closed (`matchingClosedAt`): no answer is taken on it any more. */
  closed: boolean;
}

/** What the list needs of a parcel's difference: which row, whether it is answered, whether it is read-only. */
export interface DifferenceLean {
  matchId: string;
  answered: boolean;
  closed: boolean;
}

/** A question still to be answered: nobody did, and the statement still takes an answer. */
const isWaiting = (r: Pick<DifferenceRow, 'resolution' | 'closed'>): boolean => !r.resolution && !r.closed;

/** Newest first; at the same moment a disagreement comes before a clean line, and the id ends a tie. */
function newestFirst(a: DifferenceRow, b: DifferenceRow): number {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() ||
    Number(b.result === DIFFERENCE_RESULT) - Number(a.result === DIFFERENCE_RESULT) ||
    b.id.localeCompare(a.id)
  );
}

/** THE DIFFERENCE OF ONE PARCEL, from every match row it has — in any order — or null when it has none. Pure. */
export function currentDifference(rows: readonly DifferenceRow[]): DifferenceRow | null {
  const lines = rows.filter((r) => r.result === DIFFERENCE_RESULT || r.result === CLEAN_RESULT).sort(newestFirst);
  const clean = lines.findIndex((r) => r.result === CLEAN_RESULT);
  const standing = clean < 0 ? lines : lines.slice(0, clean);
  return standing.find(isWaiting) ?? standing[0] ?? null;
}

/** The lean read: the match row's own facts and the one fact of its statement that says whether it still takes an answer. */
const LEAN = {
  id: true,
  orderId: true,
  result: true,
  resolution: true,
  createdAt: true,
  statement: { select: { matchingClosedAt: true } },
} as const;

const toRow = (m: {
  id: string;
  orderId: string | null;
  result: string;
  resolution: string | null;
  createdAt: Date;
  statement: { matchingClosedAt: Date | null };
}): DifferenceRow[] =>
  m.orderId
    ? [{ id: m.id, orderId: m.orderId, result: m.result, resolution: m.resolution, createdAt: m.createdAt, closed: isMatchingClosed({ matchingClosedAt: m.statement.matchingClosedAt }) }]
    : [];

/**
 * THE DIFFERENCE OF EVERY PARCEL IN A LIST — two reads, however many parcels there are.
 *
 * First the lines that disagreed (a small set: a parcel that is not in it has no difference, so no more is read for it),
 * then — only for the parcels that are in it — the lines that agreed, because a clean line newer than a disagreement ends
 * it. Both name the company and the statement's own store: an order id belongs to one company, so nothing the unscoped
 * read would have returned is lost, and another company's or another store's statement is never a difference here.
 */
export async function readDifferences(
  db: Pick<typeof Db, 'settlementMatch'>,
  p: { companyId: string; storeId: string; orderIds: string[] }
): Promise<Map<string, DifferenceLean>> {
  const out = new Map<string, DifferenceLean>();
  if (p.orderIds.length === 0) return out;
  const scope = { companyId: p.companyId, statement: { storeId: p.storeId } };

  const disagreed = (await db.settlementMatch.findMany({
    where: { ...scope, orderId: { in: p.orderIds }, result: DIFFERENCE_RESULT },
    select: LEAN,
  })).flatMap(toRow);
  if (disagreed.length === 0) return out;

  const named = [...new Set(disagreed.map((r) => r.orderId))];
  const agreed = (await db.settlementMatch.findMany({
    where: { ...scope, orderId: { in: named }, result: CLEAN_RESULT },
    select: LEAN,
  })).flatMap(toRow);

  const byOrder = new Map<string, DifferenceRow[]>();
  for (const r of [...disagreed, ...agreed]) byOrder.set(r.orderId, [...(byOrder.get(r.orderId) ?? []), r]);
  for (const [orderId, rows] of byOrder) {
    const row = currentDifference(rows);
    if (row) out.set(orderId, { matchId: row.id, answered: !!row.resolution, closed: row.closed });
  }
  return out;
}

/** What the dialog reads of a match row, and of the line it came from — the matching screen's own selection. */
const RICH = {
  id: true,
  statementId: true,
  orderId: true,
  result: true,
  resolution: true,
  // «طلب تبديل» (the owner, 13/11): the qualifier beside «اعتُمد رقم الشركة» — the answer's own word on the mark and in the dialog.
  // Read here, with the rest of the line, and sent as it is: it is not decided or counted from this screen.
  resolutionKind: true,
  resolutionNote: true,
  expectedAmount: true,
  statementAmount: true,
  difference: true,
  note: true,
  statement: { select: { reference: true, matchingClosedAt: true } },
  statementLine: {
    select: {
      merchantRef: true, barcode: true, amount: true, collected: true, fee: true, status: true, rawRow: true,
      receiverName: true, receiverPhone: true, receiverAddress: true, receiverCity: true, receiverArea: true,
    },
  },
} as const;

type Num = { toString(): string } | number | string | null | undefined;
const num = (v: Num): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * THE DIFFERENCE OF EACH PARCEL ON THE PAGE, WHOLE — one read of the rows the list chose, however many there are.
 *
 * The same figures the matching screen shows, from the same functions: `shortfall` for the gap (signed as the shop reads
 * it), `claimOf` for what the company still owes after «رقمنا», `readCourierWord` for the company's word. And — only for
 * whoever may decide — the matrix of `settlement-decisions`, asked of every row's order as it is NOW (three reads in all),
 * so a greyed answer carries the sentence the door would answer with. The door still decides: this only says.
 *
 * THE COMPANY'S OWN LINE (its word, its cells, the whole row it wrote) is the statement's CONTENT, which the matching
 * screen shows to whoever may open a statement (`settlement.view`). A person who holds the money sight through the cash box
 * alone sees the figures — the courier's money, as everywhere on the follow-up screen — but not what the company wrote:
 * `lines` says whether this person may read it, and without it the row carries neither the word nor the cells.
 */
export async function readDifferenceRows(
  db: typeof Db,
  p: {
    companyId: string;
    storeId: string;
    minorUnit: number;
    chosen: ReadonlyMap<string, DifferenceLean>;
    decide: boolean;
    /** May read what the company wrote on the line (`settlement.view`). */
    lines: boolean;
  }
): Promise<Map<string, DifferenceOnTheRow>> {
  const out = new Map<string, DifferenceOnTheRow>();
  const ids = [...p.chosen.values()].map((c) => c.matchId);
  if (ids.length === 0) return out;

  const rows = await db.settlementMatch.findMany({
    where: { id: { in: ids }, companyId: p.companyId, statement: { storeId: p.storeId } },
    select: RICH,
  });
  const facts = p.decide
    ? await loadDecisionFacts(db, {
        companyId: p.companyId,
        storeId: p.storeId,
        minorUnit: p.minorUnit,
        rows: rows.map((m) => ({
          id: m.id,
          orderId: m.orderId,
          expectedAmount: num(m.expectedAmount),
          statementAmount: num(m.statementAmount),
          // A row takes an answer until the statement's MATCHING is closed — the money may already be in the wallet.
          approvedAt: m.statement.matchingClosedAt,
          status: m.statementLine?.status ?? null,
        })),
      })
    : null;

  for (const m of rows) {
    if (!m.orderId) continue;
    const ours = num(m.expectedAmount);
    const theirs = num(m.statementAmount);
    const reading = readCourierWord(m.statementLine?.status);
    const f = facts?.get(m.id);
    const line = m.statementLine;
    const statementLine: DifferenceLine | null = p.lines && line ? {
      merchantRef: line.merchantRef,
      barcode: line.barcode,
      amount: Number(line.amount),
      collected: num(line.collected),
      fee: num(line.fee),
      status: line.status,
      rawRow: line.rawRow,
      receiverName: line.receiverName,
      receiverPhone: line.receiverPhone,
      receiverAddress: line.receiverAddress,
      receiverCity: line.receiverCity,
      receiverArea: line.receiverArea,
    } : null;
    out.set(m.orderId, {
      matchId: m.id,
      statementId: m.statementId,
      statement: m.statement.reference,
      ours,
      theirs,
      gap: shortfall({ expectedAmount: ours, statementAmount: theirs, difference: num(m.difference) }, p.minorUnit),
      answered: !!m.resolution,
      resolution: m.resolution,
      // `EXCHANGE` beside «اعتُمد رقم الشركة» is «طلب تبديل»; null for every other answer and for a row from before the column existed.
      resolutionKind: m.resolutionKind ?? null,
      resolutionNote: m.resolutionNote,
      claim: m.resolution === 'OURS_STANDS' ? claimOf({ expectedAmount: ours, statementAmount: theirs }, p.minorUnit) : null,
      closed: isMatchingClosed({ matchingClosedAt: m.statement.matchingClosedAt }),
      note: m.note,
      decisions: f ? decisionMatrix(f) : null,
      courierWord: p.lines && reading ? { ...reading, label: COURIER_OUTCOME_AR[reading.outcome] } : null,
      statementLine,
    });
  }
  return out;
}
