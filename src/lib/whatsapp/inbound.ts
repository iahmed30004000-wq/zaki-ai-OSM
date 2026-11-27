/**
 * WHATSAPP WEBHOOK PROCESSOR — inbound messages & delivery statuses.
 *
 * Pipeline: Meta → webhook route → signature verification → this module:
 *   find connection (by phoneNumberId) → find/create conversation (tenant +
 *   phone unique) → link Customer when phone matches → insert message
 *   (externalMessageId UNIQUE = idempotency for duplicate deliveries) →
 *   update conversation (preview / lastMessageAt / unreadCount).
 *
 * Unknown events are ignored safely. No secrets are ever logged.
 */
import type { Prisma } from '@prisma/client';
import { db } from '../db';
import { normalizePhoneNumber } from '../phone';
import { isMediaKind, parseInboundMessage, previewOf } from './message-kinds';

export interface InboundProcessingResult {
  processed: number;
  statuses: number;
  skipped: number;
  /** Rows whose file is still on Meta's side: the webhook fetches them after it has answered (`prefetchMedia`). */
  mediaMessageIds: string[];
  /** The customer messages that arrived (reactions aside): the order bot answers them after the webhook has answered. */
  botInbound?: Array<{ conversationId: string; messageId: string }>;
}

/**
 * A TICK ONLY MOVES FORWARD. Meta does not promise the order of status deliveries: a «delivered» that arrives after «read» must
 * not take the blue ticks away. FAILED wins from anything but READ (a message the customer read did not fail).
 */
const STATUS_RANK: Record<string, number> = { SENT: 1, DELIVERED: 2, READ: 3 };
export function statusesBelow(next: string): string[] {
  if (next === 'FAILED') return ['SENT', 'DELIVERED'];
  const r = STATUS_RANK[next] ?? 0;
  return Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s] < r);
}

/** Match an existing CRM customer by phone (exact wa_id or normalized). */
async function findCustomer(companyId: string, waId: string) {
  const candidates = [waId, normalizePhoneNumber('+' + waId)].filter(Boolean);
  for (const phone of candidates) {
    const c = await db.customer.findFirst({ where: { companyId, phone } });
    if (c) return c;
  }
  return null;
}

/**
 * The webhook's own word for the business number (`metadata.display_phone_number`), digits only, or null. Kept on the
 * connection while it has none, so the store's «زر واتساب» in API mode knows which number to open (`store-whatsapp.ts`)
 * without anybody typing it.
 */
export function displayNumberOf(value: unknown): string | null {
  const raw = (value as { metadata?: { display_phone_number?: unknown } } | null)?.metadata?.display_phone_number;
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

async function ensureConnectionWebhookTs(connectionId: string, display: string | null = null, known: string | null = null) {
  try {
    await db.whatsAppConnection.update({
      where: { id: connectionId },
      data: { lastWebhookAt: new Date(), ...(display && !known ? { phoneNumber: display } : {}) },
    });
  } catch {
    /* non-fatal */
  }
}

/** Process one parsed webhook body. Errors never leak; result is counters. */
export async function processWebhookPayload(
  payload: any,
  /** limit processing to a known connection id (defense in depth) */
  allowedConnectionIds?: Set<string>
): Promise<InboundProcessingResult> {
  const result: InboundProcessingResult = { processed: 0, statuses: 0, skipped: 0, mediaMessageIds: [] };
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const conn = await db.whatsAppConnection.findFirst({
        where: { phoneNumberId, status: { not: 'DISCONNECTED' } },
      });
      if (!conn || (allowedConnectionIds && !allowedConnectionIds.has(conn.id))) {
        result.skipped++;
        continue;
      }
      await ensureConnectionWebhookTs(conn.id, displayNumberOf(value), conn.phoneNumber);

      // ── Inbound messages ──
      const messages = Array.isArray(value?.messages) ? value.messages : [];
      for (const msg of messages) {
        const wamid = typeof msg?.id === 'string' ? msg.id : null;
        const from = typeof msg?.from === 'string' ? msg.from : null;
        if (!wamid || !from) {
          result.skipped++;
          continue;
        }
        const parsed = parseInboundMessage(msg);
        const type = parsed.messageType;
        const text = parsed.text;
        const ts = typeof msg?.timestamp === 'string' && /^\d+$/.test(msg.timestamp)
          ? new Date(Number(msg.timestamp) * 1000)
          : new Date();

        // Idempotency: the unique externalMessageId makes duplicate webhook
        // deliveries a no-op.
        const existing = await db.whatsAppMessage.findUnique({ where: { externalMessageId: wamid } });
        if (existing) {
          result.skipped++;
          continue;
        }

        const customer = await findCustomer(conn.companyId, from);
        const conv = await db.whatsAppConversation.upsert({
          where: {
            companyId_connectionId_customerPhone: {
              companyId: conn.companyId,
              connectionId: conn.id,
              customerPhone: from,
            },
          },
          create: {
            companyId: conn.companyId,
            connectionId: conn.id,
            customerId: customer?.id ?? null,
            customerPhone: from,
            customerName: customer?.fullName ?? null,
            status: 'OPEN',
          },
          update: {},
        });

        const hasMedia = isMediaKind(type) && Boolean(parsed.mediaId);
        let createdId: string;
        try {
          const created = await db.whatsAppMessage.create({
            data: {
              companyId: conn.companyId,
              conversationId: conv.id,
              connectionId: conn.id,
              externalMessageId: wamid,
              direction: 'INBOUND',
              messageType: type,
              text,
              status: 'RECEIVED',
              senderPhone: from,
              recipientPhone: conn.phoneNumberId,
              mediaId: parsed.mediaId,
              mimeType: parsed.mimeType,
              fileName: parsed.fileName,
              mediaSha256: parsed.mediaSha256,
              mediaStatus: hasMedia ? 'PENDING' : null,
              latitude: parsed.latitude,
              longitude: parsed.longitude,
              replyToExternalId: parsed.replyToExternalId,
              reactionToExternalId: parsed.reactionToExternalId,
              meta: (parsed.meta ?? undefined) as Prisma.InputJsonObject | undefined,
            },
            select: { id: true },
          });
          createdId = created.id;
        } catch {
          // Unique violation race → duplicate webhook delivery, safe to skip
          result.skipped++;
          continue;
        }
        if (hasMedia) result.mediaMessageIds.push(createdId);

        // A reaction is a mark on another message, not a new one to answer: it moves the preview but adds nothing unread.
        const isReaction = type === 'REACTION';
        await db.whatsAppConversation.update({
          where: { id: conv.id },
          data: {
            lastMessageAt: ts,
            lastMessagePreview: previewOf(type, text, parsed.meta),
            lastMessageType: type,
            lastInboundAt: ts,
            ...(isReaction ? {} : { unreadCount: { increment: 1 } }),
            customerName: customer?.fullName ?? conv.customerName,
            customerId: customer?.id ?? conv.customerId,
          },
        });
        await db.whatsAppConnection.update({
          where: { id: conn.id },
          data: { lastMessageAt: ts },
        });
        if (!isReaction) (result.botInbound ??= []).push({ conversationId: conv.id, messageId: createdId });
        result.processed++;
      }

      // ── Delivery statuses ──
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const st of statuses) {
        const wamid = typeof st?.id === 'string' ? st.id : null;
        const status = typeof st?.status === 'string' ? st.status.toUpperCase() : null;
        if (!wamid || !status) {
          result.skipped++;
          continue;
        }
        const mapped =
          status === 'SENT' ? 'SENT' : status === 'DELIVERED' ? 'DELIVERED' : status === 'READ' ? 'READ' : status === 'FAILED' ? 'FAILED' : null;
        if (!mapped) {
          result.skipped++;
          continue;
        }
        const reason =
          mapped === 'FAILED' && Array.isArray(st?.errors) && st.errors[0]
            ? String(st.errors[0].title || st.errors[0].message || st.errors[0].code || '').slice(0, 200) || null
            : null;
        const updated = await db.whatsAppMessage.updateMany({
          where: { externalMessageId: wamid, companyId: conn.companyId, direction: 'OUTBOUND', status: { in: statusesBelow(mapped) } },
          data: { status: mapped, ...(mapped === 'FAILED' ? { statusError: reason } : {}) },
        });
        if (updated.count === 0) result.skipped++;
        else result.statuses++;
      }
    }
  }
  return result;
}
