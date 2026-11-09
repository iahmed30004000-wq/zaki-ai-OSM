import { EXCLUDED_RESULT } from './statement-open-lines';

/**
 * THE GATES ROUND A COURIER SETTLEMENT — as a rule, not as a shape of code.
 *
 * Approving a statement is the moment money is written into a wallet. Three
 * things had to be true before it, and one thing had to STAY true after it:
 *
 *   before — a receipt exists, matching has run, and any gap between what
 *            the courier claimed and what arrived carries a written reason;
 *   after  — it is approved, and approving it again is refused.
 *
 * The "after" was the hole. `status` carried both facts — where the statement
 * is in the flow, and whether the money has moved — and re-running matching
 * wrote `status = 'MATCHED'` over an APPROVED one. Every gate then passed a
 * second time and a second IN movement was written for the same receipt:
 * measured on the dev database, 1,889.48 USD posted twice from a button
 * labelled «تشغيل المطابقة».
 *
 * So approval is read from `approvedAt` — the stamp of the act — and never
 * from `status` alone, and the rule lives here, where the route that approves,
 * the route that matches and the screen that offers both buttons all read the
 * same one. Nothing in this file touches the database: it is given the facts
 * and returns the refusal, so a screen can grey a button out for exactly the
 * reason the server would refuse it.
 */

export interface Refusal {
  /** Machine code, for the client. */
  code: string;
  /** Arabic, for the person. */
  error: string;
}

/** What approval needs to know about a statement. */
export interface StatementState {
  status: string;
  /** Set once, when the money moved. The only honest answer to "approved?". */
  approvedAt?: Date | string | null;
  /** How many receipts have been recorded against it. */
  receipts: number;
  /** How many match rows matching produced. */
  matches: number;
  /**
   * The gap between claimed and received, whether it needs a reason, and how
   * many receipts could not be expressed in the statement's currency at all.
   */
  gap: { gap: number; needsExplanation: boolean; unconvertible?: number };
  /** A written explanation of the gap, from the row or from this request. */
  explanation?: string | null;
}

/**
 * Has this statement's money already been written?
 *
 * `approvedAt` first, because it is the record of the act and nothing resets
 * it. `status` second, so a row approved before the stamp existed is still
 * recognised.
 */
export function isApproved(s: { status: string; approvedAt?: Date | string | null }): boolean {
  return s.approvedAt != null || s.status === 'APPROVED';
}

/**
 * ── TWO ACTS, TWO STAMPS ── «افصل المطابقة عن التحصيل… لما اعتمدو ينزل التحصيل تلقائي ولما يتطابق ما يكرر التحصيل»
 *
 * The approval posts the MONEY (`approvedAt`, read by `isApproved`): one IN per receipt, which is cash in hand and
 * never waits on a line. Closing the MATCHING (`matchingClosedAt`, read here) settles the orders and writes no money.
 * The approval closes the matching in the same act when no line is a question — exactly what it always did — and
 * leaves it open otherwise, for «إغلاق المطابقة» once the lines are answered.
 *
 * So the doors split by what they touch: the receipts, the gap, the undo of an import ask `isApproved` (the money
 * moved); a decision, a link, a swap, a new matching ask `isMatchingClosed` (the orders are settled).
 */
export function isMatchingClosed(s: {
  matchingClosedAt?: Date | string | null;
  status?: string;
  approvedAt?: Date | string | null;
}): boolean {
  if (s.matchingClosedAt !== undefined) return s.matchingClosedAt !== null;
  /*
   * A CALLER THAT NEVER READ THE CLOSE. Before the split «approved» was «closed», and an approved statement is still
   * read that way by anyone who did not ask for `matchingClosedAt` — the safe reading: the door refuses rather than
   * answer a line whose orders may already be settled. Every door that should act between the money and the close
   * selects the column, and gets `null`.
   */
  return isApproved({ status: s.status ?? '', approvedAt: s.approvedAt });
}

/**
 * THE ONE SENTENCE A CLOSED STATEMENT ANSWERS WITH — from every door that would change it.
 *
 * Once its money is posted a statement takes no new receipt, proof, gap or removal; once its matching is closed it
 * takes no decision, link, swap or new matching either. Every such door answers with this sentence, said here once.
 * The way back is a settlement statement, which goes through the same approval door as any other (a manual statement
 * with a reference); a wrong MOVEMENT is still reversed from the wallet, as ever.
 */
export const STATEMENT_CLOSED_SENTENCE = 'الكشف مغلق نهائياً — التصحيح بكشف تسوية';

/** The refusal itself. The code stays `ALREADY_APPROVED`: it is what the screens already read. */
export function closedStatementRefusal(): Refusal {
  return { code: 'ALREADY_APPROVED', error: STATEMENT_CLOSED_SENTENCE };
}

/**
 * A ROW THE APPROVAL ALREADY SETTLED TAKES NO ANSWER, NO LINK, NO SWAP AND NO NEW MATCHING — «تسوية السطور النظيفة عند الاعتماد».
 *
 * With that switch on, the approval settles a statement's clean rows while its matching is still open and marks each one
 * `appliedAt`. The order of such a row is settled and delivered: the row is as final as a row of a closed statement, a moment
 * earlier. Every door that writes a match row says it with this one sentence, and repeats it in its write (`appliedAt: null`).
 * The code is its own (not `ALREADY_APPROVED`): the statement itself is still open for the other lines.
 */
export const ROW_APPLIED_SENTENCE = 'هالسطر مطابق وطلبه تسوّى لحظة اعتماد الكشف — ما بينبتّ فيه ولا بيتغيّر';

export function appliedRowRefusal(): Refusal {
  return { code: 'ROW_APPLIED', error: ROW_APPLIED_SENTENCE };
}

/**
 * May this statement's MONEY side still be changed by a door? Not once it is APPROVED. Every such door asks THIS,
 * and then repeats it in the write itself (`approvedAt: null`), so an approval that lands between the two still
 * stops it.
 */
export function editRefusal(s: { status: string; approvedAt?: Date | string | null }): Refusal | null {
  return isApproved(s) ? closedStatementRefusal() : null;
}

/**
 * May this statement's MATCHING still be changed — a decision, a link, a swap? Until it is CLOSED. The money may
 * already be in the wallet: answering a line moves no money, it only decides what the close will settle. Every such
 * door asks THIS, and repeats it in its write (`statement: { matchingClosedAt: null }`), so a close that lands between
 * the two still stops it.
 */
export function matchingEditRefusal(s: Parameters<typeof isMatchingClosed>[0]): Refusal | null {
  return isMatchingClosed(s) ? closedStatementRefusal() : null;
}

/**
 * May matching run again on this statement?
 *
 * Until its matching is CLOSED — the money may already be posted: matching writes match rows and nothing else, no
 * movement and no order. After the close it is refused, because the rows decided which orders were settled and whose
 * commission became payable. (It used to write `status = 'MATCHED'` over an approved statement and reopen the
 * approval itself; the match route now never touches the status of an approved one.)
 */
export function rematchRefusal(s: Parameters<typeof isMatchingClosed>[0]): Refusal | null {
  return matchingEditRefusal(s);
}

/**
 * May this statement be approved? The gates in the order a person meets them.
 *
 * Returns null when it may. Never throws, never reads anything: the route
 * turns the refusal into a 409 and the screen turns it into a disabled button
 * with the same sentence on it.
 */
export function approvalRefusal(s: StatementState): Refusal | null {
  if (isApproved(s)) {
    return { code: 'ALREADY_APPROVED', error: 'الكشف معتمد مسبقاً' };
  }
  if (s.receipts === 0) {
    return { code: 'NO_RECEIPTS', error: 'لا يمكن اعتماد كشف بلا إيصالات استلام' };
  }
  /**
   * A receipt in another currency with no rate stored is money nobody can
   * place. Its amount is in neither «وصل فعلاً» nor the gap, so the gap that
   * follows would be explained away as a shortfall that is really a missing
   * number. It is refused on its own terms, with its own sentence.
   */
  if ((s.gap.unconvertible ?? 0) > 0) {
    return {
      code: 'RECEIPT_RATE_MISSING',
      error: 'إيصالٌ بعملةٍ تختلف عن عملة الكشف بلا سعر صرف — لا يُعرف كم وصل. صحّح الإيصال قبل الاعتماد.',
    };
  }
  if (s.gap.needsExplanation && !s.explanation) {
    return {
      code: 'GAP_REQUIRES_EXPLANATION',
      error: `الفرق ${s.gap.gap} بين ما أقرّته الشركة وما وصل يحتاج تفسيراً مكتوباً قبل الاعتماد`,
    };
  }
  if (s.matches === 0) {
    return { code: 'MATCHING_REQUIRED', error: 'شغّل المطابقة قبل الاعتماد' };
  }
  /*
   * A LINE STILL A QUESTION NO LONGER HOLDS THE MONEY BACK. The money is the receipts — cash that arrived — and no
   * answer to a line changes what arrived. The lines hold back the CLOSE of the matching instead (`closeRefusal`),
   * which is what settles the orders. A statement whose every line is answered is closed by this same press.
   */
  return null;
}

/** What closing the matching needs to know about a statement. */
export interface CloseState {
  approvedAt?: Date | string | null;
  status?: string;
  matchingClosedAt?: Date | string | null;
  /** How many match rows matching produced. */
  matches: number;
  /** How many lines are still a question nobody answered (`statement-open-lines`). */
  openLines: number;
}

/** The money comes first: the orders are never settled — nor their commission made payable — on cash not posted. */
export const MONEY_NOT_POSTED_SENTENCE = 'اعتمد مصاري الكشف أولاً — إغلاق المطابقة بيجي بعد الاعتماد';
export const MATCHING_ALREADY_CLOSED_SENTENCE = 'مطابقة هالكشف مسكّرة من قبل';

/**
 * May the matching of this statement be closed? The gates in the order a person meets them. Pure, like the
 * approval's: the route answers with it and the screen greys the button out with the same sentence.
 */
export function closeRefusal(s: CloseState): Refusal | null {
  if (!isApproved({ status: s.status ?? '', approvedAt: s.approvedAt })) {
    return { code: 'MONEY_NOT_POSTED', error: MONEY_NOT_POSTED_SENTENCE };
  }
  if (isMatchingClosed(s)) {
    return { code: 'MATCHING_ALREADY_CLOSED', error: MATCHING_ALREADY_CLOSED_SENTENCE };
  }
  if (s.matches === 0) {
    return { code: 'MATCHING_REQUIRED', error: 'شغّل المطابقة قبل إغلاقها' };
  }
  /**
   * THE LAST GATE, AND THE ONE THAT MAKES THE CLOSING FAIR: after the close nothing in the statement can be answered
   * any more, so every line that is a question is answered before it. Only those lines count (`statement-open-lines`)
   * — a line decided, tied to an order, or EXCLUDED (the company says it came back or waits, at zero) does not.
   */
  if (s.openLines > 0) {
    return { code: 'OPEN_LINES', error: openLinesSentence(s.openLines) };
  }
  return null;
}

/**
 * MAY THE CLEAN LINES OF THIS STATEMENT BE SETTLED NOW — «سوّي الطلبات النظيفة هلّق»? Only after the money is posted and while the
 * matching is still open. (That the owner's switch is on is the door's own question: it reads the setting, this reads the statement.)
 * Pure, like the others: the route answers with it.
 */
export function settleCleanRefusal(s: Parameters<typeof isMatchingClosed>[0]): Refusal | null {
  if (!isApproved({ status: s.status ?? '', approvedAt: s.approvedAt })) {
    return { code: 'MONEY_NOT_POSTED', error: 'اعتمد الكشف أول — الطلبات النظيفة بتتسوّى بعد ما تدخل المصاري المحفظة' };
  }
  if (isMatchingClosed(s)) {
    return { code: 'MATCHING_ALREADY_CLOSED', error: MATCHING_ALREADY_CLOSED_SENTENCE };
  }
  return null;
}

/** The sentence on the close button, and in the server's answer, while lines are still unanswered. */
export function openLinesSentence(n: number): string {
  return `بقي ${n} سطر بلا بتّ أو ربط — ابتّ فيها قبل إغلاق المطابقة، فالكشف بعده يُغلق نهائياً`;
}

/**
 * May an imported statement still be taken back?
 *
 * Until it is APPROVED. Everything before approval is derived rows — the file's lines, the receipts that
 * recorded what arrived and the match rows — and no wallet movement, no order and no commission has been
 * written from them (that is the whole point of approval being the gate). So a wrong upload can be undone
 * at any step up to it, receipts and matches going with it. After approval the money moved, and every
 * correction is a reversing entry, as it always was.
 */
export function undoImportRefusal(s: { status: string; approvedAt?: Date | string | null }): Refusal | null {
  return editRefusal(s);
}

/**
 * May a statement's receipts still be changed — added, their proof replaced, or one removed?
 *
 * Until it is APPROVED, and for the same reason as the undo: before approval a receipt is a record of what
 * arrived and nothing has been written from it. After it the wallet holds that money, and a correction is a
 * reversing entry. One sentence for all three doors, so the receipt, its proof and its removal refuse alike.
 */
export function receiptEditRefusal(s: { status: string; approvedAt?: Date | string | null }): Refusal | null {
  return editRefusal(s);
}

/** An order of a hand collection, as far as a statement could name it. */
export interface CollectOrderRef {
  /** Needed to find the lines a person tied to this order by hand (they carry no reference of the order's). */
  id?: string;
  orderNumber: string;
  merchantRef?: string | null;
  trackingNumber?: string | null;
  deliveryProviderId?: string | null;
}

/** A statement line that might name one of those orders, with the statement it sits on. */
export interface NamingLine {
  merchantRef: string | null;
  barcode: string | null;
  statement: { reference: string; status: string; approvedAt?: Date | string | null; deliveryProviderId: string };
  /**
   * The match rows of this line, when the read asked for them. A line whose rows are ALL `EXCLUDED` — the company
   * wrote it at zero and said the parcel came back or waits — carries no money for the order, so it does not speak
   * for it. A line not matched yet (no rows) still does: what it will say is not known.
   */
  matches?: { result: string }[];
}

/**
 * A line a person tied to an order by hand («اربطه بطلب»). It carries NEITHER of the order's references — that
 * is why it was tied by hand — so the order is found through the match row that holds the link.
 */
export interface LinkedLine {
  orderId: string | null;
  statement: NamingLine['statement'];
  /** The row's own result, when read: an `EXCLUDED` row carries no money for the order. */
  result?: string;
}

/** Does this line carry no money for its order — every row of it EXCLUDED? */
export function lineCarriesNoMoney(l: { matches?: { result: string }[] }): boolean {
  return (l.matches ?? []).length > 0 && (l.matches ?? []).every((m) => m.result === EXCLUDED_RESULT);
}

/**
 * Does any statement already speak for these orders? Then «استلمت منه» must not book their money again.
 *
 * A line names an order by our reference (that names one order whoever carries it) or by the courier's
 * barcode WITHIN THAT COURIER (a barcode is only unique per company that issued it). On an unapproved
 * statement the money will be written when it is approved; on an approved one it already was — a
 * MISMATCHED line included, whose difference is settled by the statement and not by a second collection.
 * A sweep row «MISSING_IN_STATEMENT» is not a line and never reaches here, and a line the matching EXCLUDED (the
 * company wrote it at zero and said the parcel came back or waits) carries no money for the order and does not
 * speak for it — «تم ارجاعها الي بالكشف… استبعدها». A line tied to the order by a person
 * speaks for it the same way, whatever it says: `links` are those, found by the order's id.
 *
 * Returns null when no statement names any of them; otherwise one sentence per order and the code of the
 * graver case (an approved statement).
 */
export function statementNamingRefusal(
  orders: CollectOrderRef[],
  lines: NamingLine[],
  links: LinkedLine[] = []
): { code: string; error: string; orders: string[] } | null {
  const sentences: string[] = [];
  const named: string[] = [];
  let approved = false;
  for (const o of orders) {
    const hits: { statement: NamingLine['statement'] }[] = [
      ...lines.filter(
        (l) =>
          !lineCarriesNoMoney(l) &&
          ((!!o.merchantRef && l.merchantRef === o.merchantRef) ||
            (!!o.trackingNumber && l.barcode === o.trackingNumber && l.statement.deliveryProviderId === o.deliveryProviderId))
      ),
      ...links.filter((l) => !!o.id && l.orderId === o.id && l.result !== EXCLUDED_RESULT),
    ];
    if (hits.length === 0) continue;
    const done = hits.find((h) => isApproved(h.statement));
    named.push(o.orderNumber);
    if (done) {
      approved = true;
      sentences.push(`مصاري الطلب ${o.orderNumber} دخلت مع كشف ${done.statement.reference}`);
    } else {
      sentences.push(`الطلب ${o.orderNumber} بكشف ما انعتمد بعد — مصاريه بتنسجّل لما ينعتمد الكشف`);
    }
  }
  if (sentences.length === 0) return null;
  return {
    code: approved ? 'IN_APPROVED_STATEMENT' : 'ON_UNAPPROVED_STATEMENT',
    error: sentences.join(' · '),
    orders: named,
  };
}

/**
 * A TOTAL THAT CANNOT BE TAKEN IN — the two sentences «استلمت منه» has always answered with, said once.
 *
 * A collection door can only take money IN. A batch whose net is below zero means the company owes the courier
 * (the return fee is larger than what the customers paid), and a batch whose net is exactly zero leaves nothing
 * to be handed over. The manual statement answers with the same two sentences when its lines add up to either:
 * one rule, one text, whichever door the person came by. `owed` is the negative total turned positive and
 * already rounded by the caller, so this file keeps reading nothing.
 *
 * Returns null when the total is a positive amount.
 */
export function collectTotalRefusal(p: {
  expected: number;
  owed: number;
  currency: string;
  count: number;
}): { code: string; error: string; expected: number; currency: string } | null {
  if (p.expected < 0) {
    return {
      error:
        `لا يوجد مبلغ لقبضه: الحساب معكوس، فنحن ندفع للمندوب ${p.owed} ${p.currency} ` +
        `عن ${p.count} طلب ولا نقبض منه. السبب أن أجرة الإرجاع أكبر مما استلمه العميل. ` +
        `هذا الباب يقبض المال فقط — سجّل الدفعة للمندوب من باب المصروفات، ` +
        `أو صحّح أجرة الإرجاع في سند الإرجاع إن كانت خطأً، ` +
        `أو اجمع هذا الطلب مع طلبات أخرى في تحصيل واحد.`,
      code: 'OWED_TO_COURIER',
      expected: p.expected,
      currency: p.currency,
    };
  }
  if (p.expected === 0) {
    return {
      error:
        `لا يوجد مبلغ لقبضه: المتوقَّع من المندوب 0 ${p.currency} عن ${p.count} طلب. ` +
        `أجرة التوصيل وأجرة الإرجاع تساوي ما استلمه العميل، فلا يبقى شيء يُسلَّم. ` +
        `إن كان قد استلم مبلغاً فعلاً فصحّح الكميات المسلَّمة أو الأجرة، ثم أعد المحاولة.`,
      code: 'NOTHING_TO_COLLECT',
      expected: p.expected,
      currency: p.currency,
    };
  }
  return null;
}
