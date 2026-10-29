import type { Prisma } from '@prisma/client';

/**
 * WHAT THE APPROVAL WAITS FOR — «السطر اللي لسا ما انبتّ فيه»، written once.
 *
 * After the approval a statement is closed for good (see `settlement-gates` — `closedStatementRefusal`), and the only
 * road back is a settlement statement. So whatever is still a question when the button is pressed would stay a
 * question for ever. The approval therefore waits for the lines that ARE a question, and for no other:
 *
 *   · a difference in money (MISMATCHED) that nobody answered — «رقمهم / رقمنا / قيد المراجعة»;
 *   · a line the company wrote that no order of ours carries (MISSING_IN_SYSTEM) and nobody linked to one or parked.
 *
 * A zero line has no rule of its own: a line at 0 against a parcel that was delivered is a MISMATCHED row, and a
 * line at 0 that names no order is a MISSING_IN_SYSTEM one — both are counted here as what they are. A line at 0
 * against a parcel that came back is MATCHED and is nobody's question. (The test holds this to `judgeLine`.)
 *
 * What is NOT a question and is never counted: a row that was answered (a decision of any of the three sayings) or
 * tied to an order by a person — that is an answer, and it does not hold the approval back; and the sweep's
 * MISSING_IN_STATEMENT row, a parcel no statement names, which is a list to chase on the ORDER and not a line of
 * this statement.
 *
 * The same rule is read three ways, and the test holds the three to one another: `isOpenLine` for rows already
 * read, `openLineWhere` for the database (the list's counter), and the approval, which counts the rows it read
 * inside its own transaction.
 */

export interface LineAnswer {
  result: string;
  resolution?: string | null;
  orderId?: string | null;
}

/** Is this row a question nobody has answered yet? */
export function isOpenLine(m: LineAnswer): boolean {
  if (m.resolution) return false;
  if (m.result === 'MISMATCHED') return true;
  if (m.result === 'MISSING_IN_SYSTEM') return !m.orderId;
  return false;
}

/** How many of these rows hold the approval back. */
export function countOpenLines(rows: LineAnswer[]): number {
  return rows.reduce((n, m) => n + (isOpenLine(m) ? 1 : 0), 0);
}

/** The same rule as a filter, for the counter beside each statement. */
export function openLineWhere(): Prisma.SettlementMatchWhereInput {
  return {
    resolution: null,
    OR: [{ result: 'MISMATCHED' }, { result: 'MISSING_IN_SYSTEM', orderId: null }],
  };
}

/**
 * A line with no order of ours cannot be answered with a figure — there is no second figure. The one thing a
 * person may say about it, besides tying it to an order, is «قيد المراجعة» with the reason written: the line is
 * not ours (another company's statement, a misspelled reference), and the statement may be approved without it.
 * Without this the approval would wait for ever on a line no order will ever carry.
 */
export function mayOnlyBeParked(m: LineAnswer): boolean {
  return m.result === 'MISSING_IN_SYSTEM' && !m.orderId;
}
