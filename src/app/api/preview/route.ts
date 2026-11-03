import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { z } from 'zod';
import { db } from '@/lib/db';
import { logAudit } from '@/lib/audit';
import { apiErrorResponse } from '@/lib/api-error';
import {
  currentPreviewClaims,
  getCurrentUser,
  issuePreviewToken,
  previewCookieOptions,
  previewableTarget,
} from '@/lib/auth';
import { CONTEXT_COOKIE, contextCookieOptions, readSelection, signSelection, validateSelection } from '@/lib/geo-context';
import { PREVIEW_COOKIE, PREVIEW_TTL_SECONDS } from '@/lib/preview-mode';
import { ROLE_LABELS, type SessionUser, type UserRole } from '@/types/auth';

/**
 * «عاين كـ» — THE OWNER'S DOOR TO THE PREVIEW (src/lib/preview-mode.ts).
 *
 *   GET    /api/preview   the people he may preview, by role, and the preview that is on (if any)
 *   POST   /api/preview   { userId } — start (or switch to) a preview of that person
 *   DELETE /api/preview   leave it: he is himself again on the next request
 *
 * EVERY HANDLER ASKS WHO IS REALLY SIGNED IN (`preview: 'ignore'`): while a preview is on, `getCurrentUser()` answers
 * the person being looked at, and she must never be the one who starts, lists or ends anything here. Only an ACTIVE
 * SUPER_ADMIN gets past the first line — COMPANY_ADMIN does not: the preview reads every screen of anybody, which is
 * the owner's alone. Everybody else is «not found», so the door says nothing about itself.
 *
 * Start and end are written to the audit trail under the OWNER's name, with the person he looked at.
 */

const NOT_HERE = () => NextResponse.json({ error: 'غير موجود' }, { status: 404 });

async function theOwner(): Promise<SessionUser | null> {
  const user = await getCurrentUser({ preview: 'ignore' });
  return user && user.role === 'SUPER_ADMIN' && user.status === 'ACTIVE' ? user : null;
}

async function companyOf(owner: SessionUser): Promise<string | null> {
  return owner.companyId ?? (await db.company.findFirst({ select: { id: true } }))?.id ?? null;
}

function roleNameOf(u: { role: string; roleRef?: { name: string } | null }): string {
  return u.roleRef?.name ?? ROLE_LABELS[u.role as UserRole]?.ar ?? u.role;
}

export async function GET() {
  try {
    const owner = await theOwner();
    if (!owner) return NOT_HERE();
    const companyId = await companyOf(owner);
    if (!companyId) return NextResponse.json({ people: [], active: null });

    const rows = await db.user.findMany({
      where: { companyId, status: 'ACTIVE', role: { not: 'SUPER_ADMIN' }, id: { not: owner.id } },
      select: { id: true, name: true, role: true, roleRef: { select: { name: true } } },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
    });
    const people = rows.map((r) => ({ id: r.id, name: r.name, roleName: roleNameOf(r) }));

    const claims = await currentPreviewClaims(owner.id);
    const on = claims ? rows.find((r) => r.id === claims.targetId) : undefined;
    const active = claims && on ? { userId: on.id, name: on.name, roleName: roleNameOf(on), expiresAt: claims.expiresAt.toISOString() } : null;
    return NextResponse.json({ people, active });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

const startSchema = z.object({ userId: z.string().trim().min(1).max(64) }).strict();

/**
 * THE STORE GOES WITH HIM WHERE IT CAN. The selection cookie is signed for one person (geo-context.ts), so the owner's
 * would mean nothing for her: it is re-signed for whoever the screens will now be computed as — kept when that person
 * may enter the store, dropped (the store picker asks) when not.
 */
async function carrySelection(res: NextResponse, fromId: string, to: SessionUser, companyId: string) {
  const jar = await cookies();
  const current = await readSelection(fromId, jar.get(CONTEXT_COOKIE)?.value);
  if (!current) {
    res.cookies.delete(CONTEXT_COOKIE);
    return;
  }
  try {
    const kept = await validateSelection(to, companyId, current.countryId, current.storeId);
    res.cookies.set(CONTEXT_COOKIE, await signSelection(to.id, kept), contextCookieOptions());
  } catch {
    res.cookies.delete(CONTEXT_COOKIE);
  }
}

export async function POST(req: Request) {
  try {
    const owner = await theOwner();
    if (!owner) return NOT_HERE();
    const parsed = startSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'اختر الشخص اللي بدك تعاين شاشته' }, { status: 400 });

    const row = await previewableTarget(owner, parsed.data.userId);
    if (!row) return NextResponse.json({ error: 'ما فينا نعاين هالحساب: لازم يكون نشط، من شركتك، ومش مالك' }, { status: 404 });
    const token = await issuePreviewToken(owner.id, row.id);
    const companyId = await companyOf(owner);
    if (!token || !companyId) return NOT_HERE();

    const previous = await currentPreviewClaims(owner.id);
    const res = NextResponse.json({ success: true, name: row.name });
    res.cookies.set(PREVIEW_COOKIE, token, previewCookieOptions(PREVIEW_TTL_SECONDS));
    // The person the screens will be computed as — for her store, the engine needs her keys.
    const { computeEffectiveGrants } = await import('@/lib/permissions-core');
    const { attachGrants } = await import('@/lib/authorization');
    const as: SessionUser = attachGrants(
      { id: row.id, email: row.email, name: row.name, role: row.role as UserRole, status: 'ACTIVE', companyId: row.companyId, permissions: [] },
      await computeEffectiveGrants({ id: row.id, role: row.role, roleId: row.roleId })
    );
    await carrySelection(res, previous?.targetId ?? owner.id, as, companyId);

    await logAudit({
      companyId,
      userId: owner.id,
      action: 'PREVIEW_START',
      entity: 'User',
      entityId: row.id,
      newData: { owner: owner.name, previewed: row.name, role: roleNameOf(row), minutes: PREVIEW_TTL_SECONDS / 60 },
    });
    return res;
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const owner = await theOwner();
    const res = NextResponse.json({ success: true });
    // Whoever asks, the cookie goes: leaving is never refused.
    res.cookies.set(PREVIEW_COOKIE, '', previewCookieOptions(0));
    if (!owner) return res;
    const claims = await currentPreviewClaims(owner.id);
    const companyId = await companyOf(owner);
    if (claims && companyId) {
      await carrySelection(res, claims.targetId, owner, companyId);
      const target = await db.user.findUnique({ where: { id: claims.targetId }, select: { name: true } });
      await logAudit({
        companyId,
        userId: owner.id,
        action: 'PREVIEW_END',
        entity: 'User',
        entityId: claims.targetId,
        newData: { owner: owner.name, previewed: target?.name ?? null },
      });
    }
    return res;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
