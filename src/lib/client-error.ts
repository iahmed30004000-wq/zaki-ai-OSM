/**
 * ONE REPORT FROM THE «ZAKI ORDERS» APP, MADE SAFE TO KEEP (client-errors door, 22/11).
 *
 * Every field is cut to its column's sense, and every run of eight or more digits is blanked: a phone number, an order
 * number or a card number caught in an exception's text must never land in this table. The app sends no customer data
 * by design; this is the second lock. When it happened is the phone's word, but held between thirty days ago and now —
 * a phone with its clock set to 2031 does not sort its crash above everyone else's.
 */
export const CLIENT_ERROR_KINDS = ['CRASH', 'ANR', 'ERROR'] as const;
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number];

const DIGITS = /\d[\d\s-]{6,}\d/g;

export function scrubDigits(text: string): string {
  return text.replace(DIGITS, (run) => (run.replace(/\D/g, '').length >= 8 ? '[رقم]' : run));
}

const cut = (v: string | null | undefined, max: number): string | null => {
  if (v === null || v === undefined) return null;
  const t = scrubDigits(String(v)).trim();
  return t ? t.slice(0, max) : null;
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export function cleanClientError(
  e: {
    kind: ClientErrorKind;
    message: string;
    stack?: string | null;
    screen?: string | null;
    appVersion: string;
    versionCode?: number | null;
    device?: string | null;
    osVersion?: string | null;
    occurredAt: string;
  },
  now: Date
) {
  const said = new Date(e.occurredAt).getTime();
  const at = Number.isFinite(said) ? Math.min(Math.max(said, now.getTime() - MONTH_MS), now.getTime()) : now.getTime();
  return {
    kind: e.kind,
    message: cut(e.message, 2000) ?? '—',
    stack: cut(e.stack, 16_000),
    screen: cut(e.screen, 100),
    appVersion: cut(e.appVersion, 40) ?? '?',
    versionCode: e.versionCode ?? null,
    device: cut(e.device, 120),
    osVersion: cut(e.osVersion, 40),
    occurredAt: new Date(at),
  };
}
