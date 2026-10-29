/**
 * WHAT A COURIER SAID THAT WE DO NOT WRITE (RV144).
 *
 * A courier's feed may not move an order to «تم التسليم», «رجع» or «ألغي» — those decide whether money is owed, and
 * only the door (the person who stood there) or the courier's statement writes them. But the word itself used to vanish:
 * the poll counted it in the job's detail and nothing reached the order. Here it is kept as a plain line on the order's
 * timeline — «قالت الشركة: تم التوصيل — لم تتغيّر حالة الطلب» — so the person looking at a parcel that is «still on the
 * road» can see that the company already says it arrived. It changes no status and no amount.
 *
 * Pure: no database, so the timeline can read it without pulling the courier layer in.
 */
export const COURIER_SAID = 'COURIER_SAID';

/** Longest word kept: the company's own note can be a long free sentence. */
const MOST_CHARACTERS = 80;

/** The line a timeline shows for a COURIER_SAID row, from its stored metadata (a JSON string, or already an object). */
export function courierSaidTitle(metadata: unknown): string {
  let said = '';
  try {
    const parsed = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const value = parsed && typeof parsed === 'object' ? (parsed as { courierSaid?: unknown }).courierSaid : undefined;
    if (typeof value === 'string') said = value.trim().slice(0, MOST_CHARACTERS);
  } catch {
    /* not JSON: the plain line below */
  }
  return said
    ? `قالت الشركة: «${said}» — لم تتغيّر حالة الطلب، الكشف أو من سلّم الطرد هو من يكتبها`
    : 'قالت الشركة كلمة لا تغيّر حالة الطلب — الكشف أو من سلّم الطرد هو من يكتبها';
}

/** The stored word, cut to the length the timeline shows. */
export function courierSaidWord(note: string | null | undefined, fallback: string): string {
  const word = (note ?? '').trim();
  return (word || fallback).slice(0, MOST_CHARACTERS);
}
