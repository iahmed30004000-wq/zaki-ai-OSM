/**
 * THE KEY OF THE HOLDER'S OWN WINDOW (2/11).
 *
 * `orders.edit_confirmed` — «تعديل وتأجيل وإلغاء طلب مؤكَّد قبل دخوله دفعة شحن». With it the agent who HOLDS a confirmed order
 * edits, postpones or cancels it herself, at once, until it enters a shipping batch (the predicate is in
 * edit-confirmed-window.ts); without it she raises a request somebody else decides, exactly as before.
 *
 * NOBODY RECEIVES IT ON THE DAY IT SHIPS. The owner's standing rule is that no change grants a permission to anybody: the box
 * sits in the catalogue unticked, and he ticks it himself on «الصلاحيات» for the role or the person he means. No migration
 * writes it, and the in-code fallback (permissions-core) derives it for nobody. SUPER_ADMIN holds it the way it holds every key.
 * `the-edit-confirmed-key-goes-to-its-holders-only.test.ts` measures that with the real engine.
 */

/** The key the owner ticks. */
export const EDIT_CONFIRMED_KEY = 'orders.edit_confirmed';
