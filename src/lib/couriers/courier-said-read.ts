import { SHIPPING_STATUS_AR } from '../shipping-workflow';
import { courierSaidWord, isSaidStatus, type SaidStatus } from './courier-said';
import { LOGESTECHS_STATUS, LOGESTECHS_STATUS_AR } from './logestechs';
import { normalizePhrase } from './words';

/**
 * WHAT THE COMPANY SAID ABOUT A PARCEL, READ BACK FOR THE FOLLOW-UP LIST.
 *
 * The poll asks the company every two minutes and keeps its word on the order's timeline as a COURIER_SAID line
 * (`apply-event`, RV144): «تم التوصيل» for a parcel our own state still shows on the road. The timeline showed it; the
 * list of parcels under follow-up did not, so the people chasing a parcel could not see that the company had already
 * said it arrived. This turns one such line into the small finished object the list draws.
 *
 * ── THE LABEL IS NEVER THE FREE TEXT ──
 *
 * `courierSaid` in the stored line is the company's free-text `notes` when it wrote one (cut to eighty characters), and
 * only otherwise its own Arabic name for the code. A badge whose words were whatever a driver typed — «العميل طلب
 * يأجّلها» next to a green «تم التوصيل» tone — would say two opposite things. So the LABEL comes from the code
 * (`rawStatus`, through the company's own table of names) or, for a code that table does not hold or whose meaning is
 * not the state the line carries, from OUR name for that state. The free text is kept apart as `note`, and only when it
 * says more than the label does.
 *
 * ── AND IT IS ONLY A FIELD OF THE LIST ──
 *
 * Nothing here changes a status, a date or an amount: the word is shown, never applied (the feed still never writes
 * «تم التسليم», «رجع» or «ألغي»). Pure — no database, no clock of its own: the moment of reading is handed in.
 */

/** The three columns of a COURIER_SAID line the reading needs. */
export interface CourierSaidRow {
  newStatus: string | null;
  metadata: string | null;
  createdAt: Date;
}

export interface CourierSaid {
  /** OUR state the word maps to — one of the five a line can carry. It decides the tone and the filter. */
  status: SaidStatus;
  /** The company's name for it, from its code. Never the free text. */
  label: string;
  /** The company's free text, only when it says more than the label; else null. */
  note: string | null;
  /** When the poll wrote the line down. */
  at: Date;
  /** Whole minutes between `at` and the moment of reading, by the server's clock; never below zero. */
  ageMinutes: number;
}

function metadataOf(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One COURIER_SAID line as the list draws it — or null when the line cannot be trusted to say anything: its state is not
 * one of the five, its metadata is missing or malformed, or it carries no date. Nothing is guessed from a damaged line.
 */
export function readCourierSaid(row: CourierSaidRow, now: Date): CourierSaid | null {
  const status = row.newStatus;
  if (!isSaidStatus(status)) return null;
  const meta = metadataOf(row.metadata);
  if (!meta) return null;
  const at = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
  if (Number.isNaN(at.getTime())) return null;

  // The code is normalised the way the adapter's own map reads it (`mapStatus`: trimmed, upper-cased).
  const code = typeof meta.rawStatus === 'string' ? meta.rawStatus.trim().toUpperCase() : '';
  // The company's name for its code — but only while that code means the state this line carries.
  const named = LOGESTECHS_STATUS[code] === status ? LOGESTECHS_STATUS_AR[code] : undefined;
  const label = named ?? SHIPPING_STATUS_AR[status];

  const written = typeof meta.courierSaid === 'string' ? courierSaidWord(meta.courierSaid.replace(/\s+/g, ' '), '') : '';
  const note = written && normalizePhrase(written) !== normalizePhrase(label) ? written : null;

  return { status, label, note, at, ageMinutes: Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60_000)) };
}

/**
 * THE WORD THE LIST SHOWS FOR ONE PARCEL: the company's NEWEST line, and only while it disagrees with the parcel's own
 * state.
 *
 * It is the newest line — not the newest one that happens to differ: an older «تم التوصيل» followed by a newer «مؤجلة»
 * that our state now equals has been taken back by the company itself, and showing the older one would be showing a
 * word it no longer says. A line that agrees with the state says nothing new, and a parcel with no line has nothing to
 * show: both are null.
 */
export function courierSaidAgainst(currentStatus: string, newestLine: CourierSaidRow | undefined, now: Date): CourierSaid | null {
  if (!newestLine || newestLine.newStatus === currentStatus) return null;
  return readCourierSaid(newestLine, now);
}
