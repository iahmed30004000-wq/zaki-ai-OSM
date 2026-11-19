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

/** A scanned/typed string, before it may even be compared to a stored code. Same shape the stored codes are kept in. */
export function normalizeAuthenticityCode(raw: string): string | null {
  const text = raw.trim();
  if (text.length < 3 || text.length > AUTHENTICITY_CODE_MAX) return null;
  // Letters, digits and dashes — a barcode or QR payload, never a URL, a phone number or a JSON blob.
  if (!/^[A-Za-z0-9-]+$/.test(text)) return null;
  return text.toUpperCase();
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
