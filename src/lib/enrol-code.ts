import bcrypt from 'bcryptjs';
import { randomInt } from 'node:crypto';
import { normaliseRecovery } from './two-factor';
import { enrolCodeRequired } from './auth-switches';
import { peekRateLimit, rateLimit } from './rate-limit';

/**
 * «رمز التفعيل» — THE OWNER VOUCHES FOR THE FIRST SETUP OF A SECOND FACTOR. (A2, D7)
 *
 * Today whoever knows an account's password and has no authenticator yet is handed the setup screen at sign-in: the
 * first person to get there enrols THEIR phone. For an account whose password leaked, or still is the one the owner
 * typed on the first day, that is the whole second factor handed to the thief. With `AUTH_ENROL_CODE_REQUIRED=on` the
 * setup also asks for a code that the holder of `users.security` issued for THAT account: one use, one day, shown to the
 * owner once, kept only as a hash.
 *
 * OFF BY DEFAULT, and that is a decision, not a gap: with it on, every account that has not enrolled yet is stuck at the
 * setup screen until somebody issues it a code. The owner turns it on when he has issued the codes.
 */

export const ENROL_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** Readable aloud over a phone: no 0/O, no 1/I. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newEnrolCode(): string {
  let out = '';
  for (let i = 0; i < 10; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** What goes into the two columns for a fresh code. The code itself leaves with the caller and is not kept. */
export async function sealEnrolCode(code: string, now: Date = new Date()): Promise<{ enrolCodeHash: string; enrolCodeExpiresAt: Date }> {
  return {
    enrolCodeHash: await bcrypt.hash(normaliseRecovery(code), 10),
    enrolCodeExpiresAt: new Date(now.getTime() + ENROL_CODE_TTL_MS),
  };
}

/** The two columns, possibly not read at all (the switch is off), which reads as «no code issued». */
export type EnrolCodeColumns = { enrolCodeHash?: string | null; enrolCodeExpiresAt?: Date | null };

/**
 * WHAT TO ASK THE DATABASE FOR. The columns are named in a query only while the switch is on, so with it off (the default)
 * the sign-in and the setup never touch them: a database that does not have them yet, or a client generated before them,
 * changes nothing about who can sign in.
 */
export function enrolCodeSelect(): { enrolCodeHash: true; enrolCodeExpiresAt: true } | Record<string, never> {
  return enrolCodeRequired() ? { enrolCodeHash: true, enrolCodeExpiresAt: true } : {};
}

/**
 * THE TWO COLUMNS OF A ROW READ WITH `enrolCodeSelect()`, in the shape the gate asks for. The row's type is a union (with the
 * columns when the switch is on, without when off), and a type with none of the gate's properties is refused as an argument
 * for an all-optional one, so the narrowing is written here once instead of at each door.
 */
export function enrolColumnsOf(row: object): EnrolCodeColumns {
  const r = row as EnrolCodeColumns;
  return { enrolCodeHash: r.enrolCodeHash ?? null, enrolCodeExpiresAt: r.enrolCodeExpiresAt ?? null };
}

export type EnrolCodeVerdict = 'ok' | 'missing' | 'wrong' | 'expired' | 'none-issued';

/** Judges what the person typed against what the owner issued. Never says which digit was wrong. */
export async function judgeEnrolCode(
  row: EnrolCodeColumns,
  typed: unknown,
  now: Date = new Date()
): Promise<EnrolCodeVerdict> {
  const text = typeof typed === 'string' ? normaliseRecovery(typed) : '';
  if (!text) return 'missing';
  if (!row.enrolCodeHash || !row.enrolCodeExpiresAt) return 'none-issued';
  if (row.enrolCodeExpiresAt.getTime() <= now.getTime()) return 'expired';
  return (await bcrypt.compare(text, row.enrolCodeHash)) ? 'ok' : 'wrong';
}

export const ENROL_CODE_REFUSAL: Record<Exclude<EnrolCodeVerdict, 'ok'>, string> = {
  missing: 'اكتب رمز التفعيل الذي أعطاك إياه المدير',
  'none-issued': 'لم يُصدر المدير رمز تفعيل لحسابك بعد — اطلبه منه',
  expired: 'انتهت صلاحية رمز التفعيل — اطلب من المدير رمزاً جديداً',
  wrong: 'رمز التفعيل غير صحيح',
};

export type EnrolGate = { ok: true } | { ok: false; status: number; code: string; error: string };

const WRONG_GUESSES = 10;
const GUESS_WINDOW_MS = 15 * 60 * 1000;

/**
 * THE QUESTION BOTH SETUP DOORS ASK (`/2fa/start` and `/2fa/enrol`): MAY THIS PERSON SET UP NOW?
 *
 * Yes without a question while the switch is off. With it on, the code must be there, issued, unexpired and right. Wrong
 * guesses are counted per ACCOUNT (ten in a quarter of an hour, then a pause that ends by itself), so a thief holding the
 * password cannot walk the 50 bits of a code, and the owner is never locked out for longer than the window.
 */
export async function gateEnrolment(
  userId: string,
  row: EnrolCodeColumns,
  typed: unknown
): Promise<EnrolGate> {
  if (!enrolCodeRequired()) return { ok: true };

  const key = `2fa:enrolcode:${userId}`;
  const held = peekRateLimit(key, WRONG_GUESSES);
  if (held.blocked) {
    return { ok: false, status: 429, code: 'ENROL_CODE_PAUSED', error: `محاولات خاطئة كثيرة. أعد المحاولة بعد ${held.retryAfterSec} ثانية` };
  }

  const verdict = await judgeEnrolCode(row, typed);
  if (verdict === 'ok') return { ok: true };
  if (verdict === 'wrong') rateLimit(key, WRONG_GUESSES, GUESS_WINDOW_MS);
  return {
    ok: false,
    status: verdict === 'wrong' ? 403 : 400,
    code: verdict === 'missing' ? 'ENROL_CODE_REQUIRED' : 'ENROL_CODE_REFUSED',
    error: ENROL_CODE_REFUSAL[verdict],
  };
}
