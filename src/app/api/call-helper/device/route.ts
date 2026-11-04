import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireCompanyTenant } from '@/lib/auth';
import { apiErrorResponse } from '@/lib/api-error';

/**
 * «مساعد الاتصال» — HER OWN PAIRED PHONE, for the card on «طلباتي».
 *
 * GET → `{ paired, deviceName, pairedAt }`. DELETE («افصل») stamps it revoked — never deletes it, so who paired what and
 * when survives the unpairing; the phone's next reading is a 401 and it forgets the pairing. Only ever the caller's own:
 * there is no id in the request.
 */

export async function GET() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    const device = await db.callHelperDevice.findFirst({
      where: { companyId, userId: user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { deviceName: true, createdAt: true },
    });
    return NextResponse.json(
      device
        ? { paired: true, deviceName: device.deviceName, pairedAt: device.createdAt.toISOString() }
        : { paired: false, deviceName: null, pairedAt: null }
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE() {
  try {
    const { user, companyId } = await requireCompanyTenant();
    await db.callHelperDevice.updateMany({
      where: { companyId, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
