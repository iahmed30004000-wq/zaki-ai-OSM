/**
 * «طلبات لم يذكرها أي كشف» — WHAT A PERSON CAN DO ABOUT A PARCEL WE DELIVERED THAT NO STATEMENT NAMES.
 *
 * The group used to be called «مسلَّم عندنا وليس في الكشف» and offered the same two buttons as a difference
 * in money — «اعتُمد رقم الشركة» / «رقمنا هو المعتمد» — which answer a question this row does not ask. There
 * is no company figure here to accept, and ours is not in dispute. The question is «where is the money for
 * this parcel», and it has three honest answers, each ABOUT THE ORDER:
 *
 *   WAIT_LATER_STATEMENT  the company issues statements every day or two, over overlapping windows; this
 *                         parcel may simply be on the next one. Look again later.
 *   CHASE_COURIER         the company has delivered it by its own record and has not paid or listed it:
 *                         ask the company for it.
 *   NOT_DELIVERED         the parcel never arrived, so «delivered» on our side is the mistake. The status
 *                         is corrected at the order — the door that already exists for it, which asks for
 *                         the «orders.unlock» permission and a written reason — never from here.
 *
 * ── WHAT IS STORED, AND WHAT IS NOT ──
 *
 * Each answer is one `OrderActivity` on the ORDER (so the order's own timeline shows it and the next
 * person who opens it knows it was looked at), written by `POST …/matches/:matchId/order-action`. None of
 * them changes a status, a figure, a wallet or a settlement: they are records of a decision, and the third
 * is a record that the status needs correcting, followed by a link to where it is corrected.
 *
 * Pure: the table the route, the screen and the tests all read.
 */

export const NOT_MENTIONED_ACTIONS = ['WAIT_LATER_STATEMENT', 'CHASE_COURIER', 'NOT_DELIVERED'] as const;
export type NotMentionedAction = (typeof NOT_MENTIONED_ACTIONS)[number];

/** The words on the buttons. */
export const NOT_MENTIONED_AR: Record<NotMentionedAction, string> = {
  WAIT_LATER_STATEMENT: 'انتظر كشفاً لاحقاً',
  CHASE_COURIER: 'طالِب الشركة به',
  NOT_DELIVERED: 'لم يُسلَّم — صحّح الحالة',
};

/** What each press means, for the tooltip. */
export const NOT_MENTIONED_MEANING: Record<NotMentionedAction, string> = {
  WAIT_LATER_STATEMENT: 'قد يكون على كشف قادم من الشركة. يُسجَّل على الطلب أنك رأيته وقرّرت الانتظار.',
  CHASE_COURIER: 'الشركة سلّمته ولم تذكره. يُسجَّل على الطلب أنك طالبتها به.',
  NOT_DELIVERED: 'الطرد لم يصل فعلاً. يُسجَّل على الطلب، ثم تُصحَّح الحالة من صفحة الطلب نفسه.',
};

/** The `OrderActivity.action` each one is stored under. */
export const NOT_MENTIONED_ACTIVITY: Record<NotMentionedAction, string> = {
  WAIT_LATER_STATEMENT: 'STATEMENT_AWAIT_LATER',
  CHASE_COURIER: 'STATEMENT_CHASE_COURIER',
  NOT_DELIVERED: 'STATEMENT_NOT_DELIVERED',
};

/** Which answer a stored activity code is — for the chip that says what was last recorded. */
export function actionOfActivity(code: string | null | undefined): NotMentionedAction | null {
  return NOT_MENTIONED_ACTIONS.find((a) => NOT_MENTIONED_ACTIVITY[a] === code) ?? null;
}

/** The same codes in the order's timeline, in words. */
export const NOT_MENTIONED_ACTIVITY_AR: Record<string, string> = {
  STATEMENT_AWAIT_LATER: 'لم يذكره كشف — انتظار كشف لاحق',
  STATEMENT_CHASE_COURIER: 'لم يذكره كشف — طُولبت الشركة به',
  STATEMENT_NOT_DELIVERED: 'لم يذكره كشف — الطرد لم يُسلَّم، تُصحَّح الحالة',
};

/**
 * Is there a door that can correct this order's status? Only the shipping door's override, and only for
 * somebody who may use it, on an order that is delivered (a delivered order is terminal: nothing else
 * moves it). Where there is no door, the third action is not offered — it would be a button with nowhere
 * to go.
 */
export function mayCorrectStatus(args: { holdsUnlock: boolean; shippingStatus: string }): boolean {
  return args.holdsUnlock && ['DELIVERED', 'PARTIALLY_DELIVERED'].includes(args.shippingStatus);
}
