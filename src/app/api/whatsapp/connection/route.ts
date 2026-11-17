/**
 * GET /api/whatsapp/connection — safe connection status (never the token).
 * POST handled by /test and /reconnect routes.
 */
import { NextResponse } from 'next/server';
import { requireCompanyTenant } from '@/lib/auth';
import { requirePermission } from '@/lib/auth';
import { getActiveConnection, serializeConnection, effectiveStatus } from '@/lib/whatsapp/connection';
import { envConfigured, webhookConfigured } from '@/lib/whatsapp/config';
import { apiErrorResponse } from '@/lib/api-error';

export async function GET() {
  try {
    await requirePermission('whatsapp.view');
    const { companyId } = await requireCompanyTenant();
    const conn = await getActiveConnection(companyId);
    const status = await effectiveStatus(conn);
    return NextResponse.json({
      connection: await serializeConnection(conn),
      status,
      envConfigured: await envConfigured(),
      webhookConfigured: await webhookConfigured(),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
