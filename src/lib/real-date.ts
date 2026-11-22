/**
 * THE REAL DATE OF A MOVEMENT OR A TRANSFER (22/11) — «مرات بيصير حركة بيوم 19 وبسجلها بيوم 20. المفروض تاريخ الحركة وتاريخ
 * التسجيل برّا وجوّا».
 *
 * Two moments, and they are kept apart:
 *
 *   `createdAt`   the moment the row was REGISTERED. Automatic, never typed, never changed. Every balance, every daily closing,
 *                 the matching, the profit to date and the partners' statement read THIS one, exactly as before this change.
 *   `occurredAt`  the moment the money really moved, as the person typed it. NULL = the same as the registration (every row
 *                 written before this change, and every row whose door was not given one). It is shown and sorted by; it is
 *                 never added up.
 *
 * Pure: no database, no clock of its own (the caller hands `now`). The doors and `recordMovement` ask `readOccurredAt`; the
 * lists ask `realDateOf` and `registeredOnAnotherDay`.
 */

/**
 * HOW FAR AHEAD OF THE SERVER'S CLOCK A TYPED MOMENT MAY BE: five minutes.
 *
 * The box is filled with «now» from the person's own device, and a phone's clock can run a minute or two ahead of the server's.
 * Five minutes lets that through and still refuses a typed tomorrow, or a typed «later today».
 */
export const OCCURRED_AT_SKEW_MS = 5 * 60 * 1000;

/** The earliest moment accepted: before it is a typing slip (a year of 0202), not a late registration. */
export const OCCURRED_AT_FLOOR = new Date('2020-01-01T00:00:00.000Z');

export type OccurredAtRefusal = 'OCCURRED_AT_MALFORMED' | 'OCCURRED_AT_FUTURE' | 'OCCURRED_AT_TOO_OLD';

export const OCCURRED_AT_REFUSAL_AR: Record<OccurredAtRefusal, string> = {
  OCCURRED_AT_MALFORMED: 'تاريخ الحركة الفعلي مش مفهوم — اختار يوم وساعة من الخانة',
  OCCURRED_AT_FUTURE: 'تاريخ الحركة الفعلي بالمستقبل — الحركة بتنسجّل بعد ما تصير، مش قبل',
  OCCURRED_AT_TOO_OLD: 'تاريخ الحركة الفعلي قديم كتير — راجع السنة',
};

export class OccurredAtRefused extends Error {
  constructor(public readonly code: OccurredAtRefusal) {
    super(OCCURRED_AT_REFUSAL_AR[code]);
    this.name = 'OccurredAtRefused';
  }
}

/** An ISO moment with at least the minute: «2026-11-19T14:30», with seconds, a fraction and a zone optional. */
const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

export type OccurredAtReading =
  | { ok: true; value: Date | null }
  | { ok: false; code: OccurredAtRefusal; errorAr: string };

/**
 * What a door was sent as the real date. Absent (`undefined`, `null`, an empty string) = none: the row's real date is its
 * registration. Anything else must be an ISO moment, not in the future beyond the skew, and not before the floor.
 */
export function readOccurredAt(raw: unknown, now: Date): OccurredAtReading {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  const refuse = (code: OccurredAtRefusal): OccurredAtReading => ({ ok: false, code, errorAr: OCCURRED_AT_REFUSAL_AR[code] });
  let at: Date;
  if (raw instanceof Date) at = raw;
  else if (typeof raw === 'string' && ISO_MOMENT.test(raw.trim())) at = new Date(raw.trim());
  else return refuse('OCCURRED_AT_MALFORMED');
  if (Number.isNaN(at.getTime())) return refuse('OCCURRED_AT_MALFORMED');
  if (at.getTime() > now.getTime() + OCCURRED_AT_SKEW_MS) return refuse('OCCURRED_AT_FUTURE');
  if (at.getTime() < OCCURRED_AT_FLOOR.getTime()) return refuse('OCCURRED_AT_TOO_OLD');
  return { ok: true, value: at };
}

/** The same rule where a writer passes a `Date` itself: a refusal is thrown, with its Arabic sentence and its code. */
export function assertOccurredAt(value: Date | null | undefined, now: Date): Date | null {
  const reading = readOccurredAt(value ?? null, now);
  if (!reading.ok) throw new OccurredAtRefused(reading.code);
  return reading.value;
}

/** The moment a row is shown and sorted by: the real one, or the registration when none was typed. */
export function realDateOf(row: { occurredAt?: Date | string | null; createdAt: Date | string }): Date {
  return new Date(row.occurredAt ?? row.createdAt);
}

/** The calendar day of a moment in a timezone, as «yyyy-mm-dd» — the STORE's day, not the server's or the browser's. */
export function dayIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Was the row registered on ANOTHER calendar day than the one it really happened on, in the store's timezone? Only then does the
 * row say «سُجّلت …» under its date: a movement typed at 14:10 for 14:00 the same day is one date, not two.
 */
export function registeredOnAnotherDay(
  row: { occurredAt?: Date | string | null; createdAt: Date | string },
  timeZone: string
): boolean {
  if (!row.occurredAt) return false;
  return dayIn(new Date(row.occurredAt), timeZone) !== dayIn(new Date(row.createdAt), timeZone);
}

/**
 * A moment as a `datetime-local` box holds it — the person's own clock, to the minute. `toISOString` is UTC and would show
 * yesterday after midnight in Damascus; the box is read back with `new Date(text)`, which reads the same local clock.
 */
export function boxMoment(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** What a `datetime-local` box sends: the ISO moment of what it holds, or nothing when it is empty or unreadable. */
export function fromBox(text: string): string | undefined {
  if (!text) return undefined;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

/** The order of a list: the real date, newest first, then the registration, newest first. */
export function byRealDateDesc(
  a: { occurredAt?: Date | string | null; createdAt: Date | string },
  b: { occurredAt?: Date | string | null; createdAt: Date | string }
): number {
  return (
    realDateOf(b).getTime() - realDateOf(a).getTime() ||
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}
