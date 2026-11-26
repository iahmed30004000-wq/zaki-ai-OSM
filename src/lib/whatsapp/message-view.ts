/**
 * WHAT A BROWSER IS TOLD ABOUT ONE WHATSAPP MESSAGE — the row's safe subset, shaped for drawing.
 *
 * The row keeps things a screen must never hold: Meta's media id, the storage key, Meta's wamids. The view gives a media
 * ADDRESS on our own authenticated door instead, and resolves a reply's quote and a reaction's target to OUR ids.
 */
import { db } from '../db';
import type { ContactCard, MessageMeta } from './message-kinds';
import { isMediaKind } from './message-kinds';

export interface MessageView {
  id: string;
  direction: string;
  messageType: string;
  text: string | null;
  status: string;
  statusError: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  media: {
    url: string;
    mimeType: string | null;
    fileName: string | null;
    size: number | null;
    /** READY = on our disk; PENDING = still on Meta's side (the door fetches it on first view); FAILED; TOO_LARGE. */
    state: 'READY' | 'PENDING' | 'FAILED' | 'TOO_LARGE';
    voice: boolean;
  } | null;
  location: { latitude: number; longitude: number; name: string | null; address: string | null } | null;
  contacts: ContactCard[] | null;
  replyTo: { id: string; direction: string; messageType: string; text: string | null } | null;
  /** For a REACTION row: the message it marks (our id), or null when that message is not ours to show. */
  reactionToId: string | null;
  /** Written by the order bot, not by a person: the thread labels it with the bot's name. */
  byBot: boolean;
}

type Row = {
  id: string;
  direction: string;
  messageType: string;
  text: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  statusError?: string | null;
  mediaId?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  mediaKey?: string | null;
  mediaSize?: number | null;
  mediaStatus?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  replyToExternalId?: string | null;
  reactionToExternalId?: string | null;
  meta?: unknown;
  sentByBot?: boolean | null;
};

const mediaState = (r: Row): NonNullable<MessageView['media']>['state'] => {
  if (r.mediaStatus === 'TOO_LARGE') return 'TOO_LARGE';
  if (r.mediaKey && r.mediaStatus === 'STORED') return 'READY';
  if (r.mediaStatus === 'FAILED') return 'FAILED';
  return r.mediaId ? 'PENDING' : 'FAILED';
};

export function viewOf(r: Row, refs: Map<string, { id: string; direction: string; messageType: string; text: string | null }> = new Map()): MessageView {
  const meta = (r.meta && typeof r.meta === 'object' ? r.meta : {}) as MessageMeta;
  const hasMedia = isMediaKind(r.messageType) && Boolean(r.mediaId || r.mediaKey);
  const reply = r.replyToExternalId ? refs.get(r.replyToExternalId) ?? null : null;
  const target = r.reactionToExternalId ? refs.get(r.reactionToExternalId) ?? null : null;
  return {
    id: r.id,
    direction: r.direction,
    messageType: r.messageType,
    text: r.text,
    status: r.status,
    statusError: r.statusError ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    media: hasMedia
      ? {
          url: `/api/whatsapp/messages/${r.id}/media`,
          mimeType: r.mimeType ?? null,
          fileName: r.fileName ?? null,
          size: r.mediaSize ?? null,
          state: mediaState(r),
          voice: meta.voice === true,
        }
      : null,
    location:
      r.messageType === 'LOCATION' && typeof r.latitude === 'number' && typeof r.longitude === 'number'
        ? { latitude: r.latitude, longitude: r.longitude, name: meta.placeName ?? null, address: meta.placeAddress ?? null }
        : null,
    contacts: r.messageType === 'CONTACTS' && Array.isArray(meta.contacts) ? meta.contacts : null,
    replyTo: reply ? { id: reply.id, direction: reply.direction, messageType: reply.messageType, text: reply.text ? reply.text.slice(0, 160) : null } : null,
    reactionToId: target?.id ?? null,
    byBot: r.sentByBot === true,
  };
}

/** The views of a page of rows, with the replied-to and reacted-to messages looked up in ONE query (same conversation only). */
export async function viewsOf(rows: Row[], scope: { companyId: string; conversationId: string }): Promise<MessageView[]> {
  const wanted = new Set<string>();
  for (const r of rows) {
    if (r.replyToExternalId) wanted.add(r.replyToExternalId);
    if (r.reactionToExternalId) wanted.add(r.reactionToExternalId);
  }
  const refs = new Map<string, { id: string; direction: string; messageType: string; text: string | null }>();
  if (wanted.size > 0) {
    const found = await db.whatsAppMessage.findMany({
      where: { companyId: scope.companyId, conversationId: scope.conversationId, externalMessageId: { in: [...wanted] } },
      select: { id: true, externalMessageId: true, direction: true, messageType: true, text: true },
    });
    for (const f of found) refs.set(f.externalMessageId, { id: f.id, direction: f.direction, messageType: f.messageType, text: f.text });
  }
  return rows.map((r) => viewOf(r, refs));
}
