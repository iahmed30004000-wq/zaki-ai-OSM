import { db } from '@/lib/db';

/**
 * THE PUBLIC VERDICT, AND NOTHING ELSE.
 *
 * `/verify/[id]` and its API are reached by anybody with the link — no
 * sign-in, no session, no company context from a cookie. The only thing a
 * caller may ever learn through this path is `{ genuine: boolean }`: never
 * the matched row, never which product or batch a code was printed for,
 * never whether the STORE id itself is real (a 404 there is no different
 * from a wrong one — see the route). Every other field on `AuthenticityCode`
 * (`note`, `productId`, `scanCount`, `lastScanAt`, `createdById`) is for the
 * owner's own screen, `/settings/authenticity`, and is read nowhere else.
 *
 * A code stays «أصلي» every time it is scanned — there is no "used" state
 * and the lookup never writes anything that could change a future verdict.
 * `scanCount`/`lastScanAt` are bumped best-effort, after the verdict is
 * already decided, purely for the owner's own visibility.
 */

/**
 * The longest code, in characters. 19/11 (owner): was 64 — the owner's codes run to about 300 characters, and the
 * add form refused them («Too big: expected string to have <=64 characters»). The public check and the add form read
 * this one number, so a code that can be added can always be checked. The column is TEXT; the public body cap
 * (2,000 bytes) holds a code this long with room to spare.
 */
export const AUTHENTICITY_CODE_MAX = 300;

/** The query parameter a printed QR carries its code in: `/verify/<storeId>?code=…`. */
export const VERIFY_CODE_PARAM = 'code';

/** Letters, digits and dashes: a plain barcode. Kept upper-cased, as every code was before links were allowed. */
const PLAIN = /^[A-Za-z0-9-]+$/;
/**
 * The only characters refused: invisible control characters (a stray tab, a line break, a NUL from a broken
 * scanner). 19/11 (owner): «يقبل الحروف والأرقام والرموز وكل شيء» — Arabic, symbols, spaces and links are all codes.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const VERIFY_PATH = /^\/verify\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;

/**
 * The code inside a link to a verify page (`https://…/verify/<storeId>?code=XYZ`), or null when the text is not
 * such a link or the link carries no code. 19/11 (owner): the QR printed on a piece holds that link, so a phone's own
 * camera opens the page and the page checks by itself; the page's own scanner and the owner's add form read the same
 * link, and all three land on the same code.
 */
export function codeFromVerifyLink(text: string): string | null {
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!VERIFY_PATH.test(url.pathname)) return null;
  return url.searchParams.get(VERIFY_CODE_PARAM);
}

/**
 * A scanned/typed string, before it may even be compared to a stored code. Same shape the stored codes are kept in.
 *
 * - A link to a verify page with a code → that code (then the rules below).
 * - A plain code (letters, digits, dashes) → upper-cased, exactly as before.
 * - Anything else — a link, Arabic, symbols, spaces inside → kept exactly as written (case matters in a link).
 * - Control characters, under 3 or over AUTHENTICITY_CODE_MAX characters → refused.
 */
export function normalizeAuthenticityCode(raw: string): string | null {
  let text = raw.trim();
  const inner = codeFromVerifyLink(text);
  if (inner !== null) text = inner.trim();
  if (text.length < 3 || text.length > AUTHENTICITY_CODE_MAX) return null;
  if (CONTROL.test(text)) return null;
  return PLAIN.test(text) ? text.toUpperCase() : text;
}

/** The company a `/verify/[id]` link belongs to, or null (store missing, paused, or id malformed). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveCompanyByStoreId(storeId: string): Promise<{ companyId: string } | null> {
  if (!UUID.test(storeId)) return null;
  const store = await db.store.findFirst({
    where: { id: storeId, status: 'ACTIVE' },
    select: { companyId: true },
  });
  return store ? { companyId: store.companyId } : null;
}

/**
 * The verdict a scan gets. `code` must already be run through
 * `normalizeAuthenticityCode` — an invalid shape is simply not genuine,
 * never a 400: a bent label and a counterfeit one say the same thing here.
 */
export async function checkAuthenticityCode(companyId: string, code: string | null): Promise<boolean> {
  if (!code) return false;
  const row = await db.authenticityCode.findUnique({
    where: { companyId_code: { companyId, code } },
    select: { id: true },
  });
  if (!row) return false;
  // Best-effort, after the verdict: never lets a write failure turn «أصلي» into an error.
  db.authenticityCode
    .update({ where: { id: row.id }, data: { scanCount: { increment: 1 }, lastScanAt: new Date() } })
    .catch(() => undefined);
  return true;
}
