import crypto from 'crypto';
import { toLatinDigits } from '../latin-digits';

/**
 * «مساعد الاتصال» — THE CONTRACT WITH THE ANDROID APP, ON THE SERVER'S SIDE.
 *
 * The contract is fixed (docs/call-helper/CONTRACT.md, v1 + v1.1, on PR #198) and the app is built on it to the letter:
 * its link parser (Links.kt), its signature check (CallSig.kt), its pairing screen (PairActivity.kt) and its outbox
 * (Outbox.kt). Everything here is written to what THOSE files accept, not to what would be nicer — a link the app
 * refuses is a button that does nothing on her phone.
 *
 * Pure: no database, no request. The doors (pair, reading) and the desk («طلباتي») use it; the tests hold it against the
 * contract's own formula computed with node's crypto.
 */

/** The app's package and its link scheme. */
export const APP_PACKAGE = 'io.zakiai.callhelper';
export const APP_SCHEME = 'zakicall';

/** A pairing code lives ten minutes and is spent once. */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000;
/** A signed call link on the desk is good for twelve hours (the app accepts up to 24). */
export const CALL_LINK_TTL_S = 12 * 60 * 60;

/** Exactly 32 of `A-Z a-z 0-9 _ -` (Links.kt `CODE`). */
const CODE = /^[A-Za-z0-9_-]{32}$/;
/** 1–64 of `A-Z a-z 0-9 _ -` (Links.kt `ORDER`). */
const ORDER = /^[A-Za-z0-9_-]{1,64}$/;
/** 6–15 digits, international, no `+` (Links.kt `PHONE`). */
const PHONE = /^[0-9]{6,15}$/;

export const isPairCode = (v: unknown): v is string => typeof v === 'string' && CODE.test(v);
export const isLinkOrderId = (v: unknown): v is string => typeof v === 'string' && ORDER.test(v);
export const isLinkPhone = (v: unknown): v is string => typeof v === 'string' && PHONE.test(v);

/** 24 random bytes, base64url — exactly 32 url-safe characters, which is what the app accepts as a code. */
export function newPairCode(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * 32 random bytes, base64url, no padding — 43 characters. The token and the callKey are both this: the app keeps a
 * callKey only when it is 43+ characters of base64url (CallSig.kt `KEY`), otherwise every link asks.
 */
export function newSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** What is stored in place of a token or a code. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * THE SIGNATURE ON A CALL LINK (contract v1.1):
 *   lowercase hex( HMAC-SHA256( key = UTF-8 of the callKey string as given, message = "<orderId>.<phone>.<exp>" ) )
 */
export function signCall(callKey: string, orderId: string, phone: string, exp: number): string {
  return crypto.createHmac('sha256', Buffer.from(callKey, 'utf8')).update(`${orderId}.${phone}.${exp}`, 'utf8').digest('hex');
}

/**
 * AN ANDROID INTENT URL FOR A `zakicall://` LINK — how Chrome opens an app, with somewhere to go when the app is not there.
 *
 *   intent://<host-and-query>#Intent;scheme=zakicall;package=io.zakiai.callhelper;S.browser_fallback_url=<encoded>;end
 */
export function intentUrl(zakicall: string, fallback: string): string {
  const rest = zakicall.slice(`${APP_SCHEME}://`.length);
  return `intent://${rest}#Intent;scheme=${APP_SCHEME};package=${APP_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/** `zakicall://pair?base=<origin, url-encoded>&code=<code>` */
export function pairLink(base: string, code: string): string {
  return `${APP_SCHEME}://pair?base=${encodeURIComponent(base)}&code=${encodeURIComponent(code)}`;
}

/** `zakicall://call?order=…&phone=…&exp=…&sig=…` — signed. */
export function callLink(callKey: string, orderId: string, phone: string, exp: number): string {
  const sig = signCall(callKey, orderId, phone, exp);
  return `${APP_SCHEME}://call?order=${orderId}&phone=${phone}&exp=${exp}&sig=${sig}`;
}

/**
 * THE LINK «اتصل» OPENS ON HER DESK — or null when the app would refuse it (an order id or a number outside the
 * contract's shape), in which case the desk keeps today's `tel:` link. The fallback, when the app is not installed, is
 * the same number in the phone's own dialler.
 */
export function deskCallIntent(callKey: string, orderId: string, phone: string, nowMs: number): string | null {
  if (!isLinkOrderId(orderId) || !isLinkPhone(phone)) return null;
  const exp = Math.floor(nowMs / 1000) + CALL_LINK_TTL_S;
  return intentUrl(callLink(callKey, orderId, phone, exp), `tel:+${phone}`);
}

/** The last eight digits of a number — what the app matches the call log on, and what the reading door compares. */
export function last8(number: string | null | undefined): string {
  return toLatinDigits(number ?? '').replace(/\D/g, '').slice(-8);
}

/** Is the number the app dialled this customer's? Fewer than six digits is never a match (Reading.kt `sameNumber`). */
export function samePhone(sent: string, customer: string | null | undefined): boolean {
  const a = last8(sent);
  const b = last8(customer);
  return a.length >= 6 && a === b;
}

/** One reading, as the app posts it (Outbox.kt `readingBody`). */
export interface ReadingBody {
  orderId: string;
  phone: string;
  startedAt: number;
  answered: boolean;
  talkSeconds: number;
  ringSeconds: number;
}

export const MAX_TALK_S = 4 * 60 * 60;
export const MAX_RING_S = 10 * 60;
/** The app keeps an unsent reading for a day (QueueRules.MAX_AGE_MS); older is not a reading of a call she is on. */
export const MAX_READING_AGE_MS = 24 * 60 * 60 * 1000;
/** A phone's clock a little ahead of ours is a phone; far ahead is not a reading. */
export const MAX_AHEAD_MS = 5 * 60 * 1000;

const wholeIn = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/** The body read and checked, or null — every field present, of its type, and the numbers within reason. */
export function readReading(raw: unknown, nowMs: number): ReadingBody | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (!isLinkOrderId(b.orderId) || !isLinkPhone(b.phone)) return null;
  if (typeof b.answered !== 'boolean') return null;
  if (!wholeIn(b.talkSeconds, MAX_TALK_S) || !wholeIn(b.ringSeconds, MAX_RING_S)) return null;
  if (typeof b.startedAt !== 'number' || !Number.isInteger(b.startedAt)) return null;
  if (b.startedAt < nowMs - MAX_READING_AGE_MS || b.startedAt > nowMs + MAX_AHEAD_MS) return null;
  return {
    orderId: b.orderId,
    phone: b.phone,
    startedAt: b.startedAt,
    answered: b.answered,
    talkSeconds: b.talkSeconds,
    ringSeconds: b.ringSeconds,
  };
}

/** The bearer token of a request, or null. */
export function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m ? m[1] : null;
}
