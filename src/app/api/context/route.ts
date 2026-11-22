import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { requireCompanyTenant } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';
import {
  CONTEXT_COOKIE,
  contextCookieOptions,
  readSelection,
  resolveEntry,
  signSelection,
  validateSelection,
} from '@/lib/geo-context';
import { contextSelectSchema, firstIssue } from '@/lib/geo-schemas';
import { isAppRequest } from '@/lib/app-bearer';

/**
 * Country / store entry.
 *   GET  /api/context  — accessible countries, stores of the selected country,
 *                        the current selection and the next step. Skip rules
 *                        (one country / one store) are applied and persisted here.
 *   POST /api/context  — { countryId, storeId? }. Omitting storeId clears the store.
 */

export async function GET(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    const jar = await cookies();
    const current = await readSelection(user.id, jar.get(CONTEXT_COOKIE)?.value);
    const entry = await resolveEntry(user, companyId, current);

    // The app keeps the selection itself and sends it back as `X-Zaki-Context` (app-bearer.ts), so it gets the signed
    // selection in the body — always, not only when it changed: the phone may have lost it.
    const app = isAppRequest(req.headers, '/api/context');
    const res = NextResponse.json(
      app && entry.selection ? { ...entry, context: await signSelection(user.id, entry.selection) } : entry
    );
    const changed =
      entry.selection?.countryId !== current?.countryId || entry.selection?.storeId !== current?.storeId;
    if (changed) {
      if (entry.selection) {
        res.cookies.set(CONTEXT_COOKIE, await signSelection(user.id, entry.selection), contextCookieOptions());
      } else {
        res.cookies.delete(CONTEXT_COOKIE);
      }
    }
    return res;
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireCompanyTenant();
    const parsed = contextSelectSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });

    const selection = await validateSelection(user, companyId, parsed.data.countryId, parsed.data.storeId ?? null);
    const signed = await signSelection(user.id, selection);
    const res = NextResponse.json(isAppRequest(req.headers, '/api/context') ? { selection, context: signed } : { selection });
    res.cookies.set(CONTEXT_COOKIE, signed, contextCookieOptions());
    return res;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
