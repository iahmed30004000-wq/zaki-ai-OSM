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
 * May matching run again on this statement?
 *
 * Re-running it on an unapproved statement is normal and wanted: the operator
 * fixes a barcode and asks again. On an APPROVED one it is refused, because
 * matching rewrites the match rows that decide which orders were settled and
 * whose commission became payable — and it used to reopen the approval itself.
 */
export function rematchRefusal(s: { status: string; approvedAt?: Date | string | null }): Refusal | null {
  if (isApproved(s)) {
    return {
      code: 'ALREADY_APPROVED',
      error: 'الكشف معتمد — لا تُعاد مطابقته. أيّ تصحيح بعد الاعتماد يكون بقيد عكسي.',
    };
  }
  return null;
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
  return null;
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
  if (isApproved(s)) {
    return { code: 'ALREADY_APPROVED', error: 'الكشف معتمد — لا يُلغى. أيّ تصحيح بعد الاعتماد يكون بقيد عكسي.' };
  }
  return null;
}

/**
 * May a statement's receipts still be changed — added, their proof replaced, or one removed?
 *
 * Until it is APPROVED, and for the same reason as the undo: before approval a receipt is a record of what
 * arrived and nothing has been written from it. After it the wallet holds that money, and a correction is a
 * reversing entry. One sentence for all three doors, so the receipt, its proof and its removal refuse alike.
 */
export function receiptEditRefusal(s: { status: string; approvedAt?: Date | string | null }): Refusal | null {
  if (isApproved(s)) {
    return { code: 'ALREADY_APPROVED', error: 'الكشف معتمد — أي تصحيح يكون بقيد عكسي' };
  }
  return null;
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
}

/**
 * A line a person tied to an order by hand («اربطه بطلب»). It carries NEITHER of the order's references — that
 * is why it was tied by hand — so the order is found through the match row that holds the link.
 */
export interface LinkedLine {
  orderId: string | null;
  statement: NamingLine['statement'];
}

/**
 * Does any statement already speak for these orders? Then «استلمت منه» must not book their money again.
 *
 * A line names an order by our reference (that names one order whoever carries it) or by the courier's
 * barcode WITHIN THAT COURIER (a barcode is only unique per company that issued it). On an unapproved
 * statement the money will be written when it is approved; on an approved one it already was — a
 * MISMATCHED line included, whose difference is settled by the statement and not by a second collection.
 * A sweep row «MISSING_IN_STATEMENT» is not a line and never reaches here. A line tied to the order by a person
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
          (!!o.merchantRef && l.merchantRef === o.merchantRef) ||
          (!!o.trackingNumber && l.barcode === o.trackingNumber && l.statement.deliveryProviderId === o.deliveryProviderId)
      ),
      ...links.filter((l) => !!o.id && l.orderId === o.id),
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
