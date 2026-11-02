/**
 * THE KEY OF THE HOLDER'S OWN WINDOW, AND WHO RECEIVED IT ON THE DAY IT SHIPPED (2/11).
 *
 * `orders.edit_confirmed` — «تعديل وتأجيل وإلغاء طلب مؤكَّد قبل دخوله دفعة شحن». With it the agent who HOLDS a confirmed order
 * edits, postpones or cancels it herself, at once, until it enters a shipping batch (the predicate is in
 * edit-confirmed-window.ts); without it she raises a request somebody else decides, exactly as before.
 *
 * It is a NEW box, so the day it ships it must go to somebody or it opens nothing for anyone. The owner's words for who: «البنات»
 * — the confirmation agents — and the supervisors and the follow-up role beside them. The rule that says it in data is:
 * every role that holds BOTH of these keys. `confirmation.work` is what makes a person an agent who can hold an order at all;
 * `orders.request_change` is the key the box sits behind in the catalogue (the change is still a request, decided on the spot).
 * Nobody else receives it on the day; SUPER_ADMIN holds every key already.
 *
 * The migration 20261102120000_edit_confirmed_before_batch writes it into the database from the same pair (a test reads the SQL
 * and this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 *
 * Not a table like its siblings (`order-action-keys.ts`): those are «ANY of these keys passed the door yesterday»; this is
 * «ALL of these keys», because it is not a door that was split off a wider key — it is a power that did not exist.
 */

/** The key the owner ticks. */
export const EDIT_CONFIRMED_KEY = 'orders.edit_confirmed';

/** A role receives the key on the day if it holds ALL of these. */
export const EDIT_CONFIRMED_NEEDS = ['confirmation.work', 'orders.request_change'] as const;
