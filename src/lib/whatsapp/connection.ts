/**
 * WHATSAPP CONNECTION — server-side helpers for loading/serializing the
 * company's shared WhatsApp connection. The access token (env or encrypted
 * DB blob) is NEVER included in serialized output.
 */
import { db } from '../db';
import { envConfigured } from './config';

export type WhatsAppConnectionRow = {
  id: string;
  companyId: string;
  wabaId: string;
  phoneNumberId: string;
  phoneNumber: string | null;
  displayName: string | null;
  status: string;
  accessTokenEncrypted: string | null;
  lastWebhookAt: Date | null;
  lastMessageAt: Date | null;
  lastError: string | null;
};

export async function getActiveConnection(companyId: string): Promise<WhatsAppConnectionRow | null> {
  const conn = await db.whatsAppConnection.findFirst({
    where: { companyId, status: { not: 'DISCONNECTED' } },
    orderBy: { createdAt: 'asc' },
  });
  return conn as WhatsAppConnectionRow | null;
}

/** Effective connection status shown in the UI. Async: «configured» is asked of the site's saved settings first, then the environment (`integration-settings.ts`). */
export async function effectiveStatus(conn: WhatsAppConnectionRow | null): Promise<'CONNECTED' | 'NEEDS_SETUP'> {
  if (!conn) return 'NEEDS_SETUP';
  if (conn.status === 'CONNECTED' && (await envConfigured())) return 'CONNECTED';
  if (conn.status === 'CONNECTED') return 'NEEDS_SETUP';
  return 'NEEDS_SETUP';
}

/** Safe serialization — never includes accessTokenEncrypted or env token. */
export async function serializeConnection(conn: WhatsAppConnectionRow | null) {
  if (!conn) return null;
  return {
    id: conn.id,
    wabaId: conn.wabaId,
    phoneNumberId: conn.phoneNumberId,
    phoneNumber: conn.phoneNumber,
    displayName: conn.displayName,
    status: await effectiveStatus(conn),
    dbStatus: conn.status,
    lastWebhookAt: conn.lastWebhookAt,
    lastMessageAt: conn.lastMessageAt,
    lastError: conn.lastError,
  };
}
