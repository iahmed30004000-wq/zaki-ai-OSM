import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE WEBHOOK KEEPS EVERY KIND, AND A TICK ONLY MOVES FORWARD.
 *
 * `processWebhookPayload` with the database mocked: a photo is stored with its media id and PENDING (its file is fetched after
 * the 200), a reaction moves the preview without adding an unread, the customer's message opens the 24-hour window
 * (`lastInboundAt`), and a status update can never take a tick back.
 */

const h = vi.hoisted(() => ({
  db: {
    whatsAppConnection: { findFirst: vi.fn(), update: vi.fn() },
    whatsAppMessage: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    whatsAppConversation: { upsert: vi.fn(), update: vi.fn() },
    customer: { findFirst: vi.fn() },
  },
}));
vi.mock('../db', () => ({ db: h.db }));

import { processWebhookPayload, statusesBelow } from './inbound';

const payload = (value: Record<string, unknown>) => ({
  entry: [{ changes: [{ value: { metadata: { phone_number_id: 'PN1' }, ...value } }] }],
});

beforeEach(() => {
  vi.clearAllMocks();
  h.db.whatsAppConnection.findFirst.mockResolvedValue({ id: 'cn1', companyId: 'co1', phoneNumberId: 'PN1' });
  h.db.whatsAppConnection.update.mockResolvedValue({});
  h.db.whatsAppMessage.findUnique.mockResolvedValue(null);
  h.db.whatsAppMessage.create.mockImplementation(async () => ({ id: 'm-new' }));
  h.db.whatsAppMessage.updateMany.mockResolvedValue({ count: 1 });
  h.db.whatsAppConversation.upsert.mockResolvedValue({ id: 'cv1', customerName: null, customerId: null });
  h.db.whatsAppConversation.update.mockResolvedValue({});
  h.db.customer.findFirst.mockResolvedValue(null);
});

describe('inbound messages', () => {
  it('a photo is kept with its media id, caption and PENDING — and named for the background fetch', async () => {
    const r = await processWebhookPayload(
      payload({ messages: [{ from: '962790000000', id: 'wamid.1', timestamp: '1764150000', type: 'image', image: { id: 'MID', mime_type: 'image/jpeg', sha256: 'S', caption: 'هذا؟' } }] })
    );
    expect(r.processed).toBe(1);
    expect(r.mediaMessageIds).toEqual(['m-new']);
    const data = h.db.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ messageType: 'IMAGE', text: 'هذا؟', mediaId: 'MID', mimeType: 'image/jpeg', mediaSha256: 'S', mediaStatus: 'PENDING', direction: 'INBOUND' });
    const conv = h.db.whatsAppConversation.update.mock.calls[0][0].data;
    expect(conv).toMatchObject({ lastMessagePreview: 'صورة: هذا؟', lastMessageType: 'IMAGE', unreadCount: { increment: 1 } });
    expect(conv.lastInboundAt).toEqual(new Date(1764150000 * 1000));
  });

  it('a voice note is AUDIO with the voice mark, previewed as «رسالة صوتية»', async () => {
    await processWebhookPayload(payload({ messages: [{ from: '962790000000', id: 'wamid.2', type: 'audio', audio: { id: 'A', mime_type: 'audio/ogg; codecs=opus', voice: true } }] }));
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data).toMatchObject({ messageType: 'AUDIO', meta: { voice: true }, mediaStatus: 'PENDING' });
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data.lastMessagePreview).toBe('رسالة صوتية');
  });

  it('a reaction marks its target and adds nothing unread; it is not fetched (no media)', async () => {
    const r = await processWebhookPayload(payload({ messages: [{ from: '962790000000', id: 'wamid.3', type: 'reaction', reaction: { message_id: 'wamid.OUT', emoji: '👍' } }] }));
    expect(r.mediaMessageIds).toEqual([]);
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data).toMatchObject({ messageType: 'REACTION', text: '👍', reactionToExternalId: 'wamid.OUT', mediaStatus: null });
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data).not.toHaveProperty('unreadCount');
  });

  it('a location keeps its coordinates; a duplicate delivery is skipped', async () => {
    await processWebhookPayload(payload({ messages: [{ from: '962790000000', id: 'wamid.4', type: 'location', location: { latitude: 31.9, longitude: 35.9 } }] }));
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data).toMatchObject({ messageType: 'LOCATION', latitude: 31.9, longitude: 35.9 });
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ id: 'old' });
    const again = await processWebhookPayload(payload({ messages: [{ from: '962790000000', id: 'wamid.4', type: 'location', location: { latitude: 31.9, longitude: 35.9 } }] }));
    expect(again).toMatchObject({ processed: 0, skipped: 1 });
  });
});

describe('delivery statuses', () => {
  it('a tick only moves forward: «delivered» may replace «sent», never «read»', () => {
    expect(statusesBelow('SENT')).toEqual([]);
    expect(statusesBelow('DELIVERED')).toEqual(['SENT']);
    expect(statusesBelow('READ').sort()).toEqual(['DELIVERED', 'SENT']);
    expect(statusesBelow('FAILED').sort()).toEqual(['DELIVERED', 'SENT']);
  });

  it('read is written only over a lower status, and only on our own outbound message of this company', async () => {
    const r = await processWebhookPayload(payload({ statuses: [{ id: 'wamid.OUT', status: 'read', recipient_id: '9627' }] }));
    expect(r.statuses).toBe(1);
    const call = h.db.whatsAppMessage.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ externalMessageId: 'wamid.OUT', companyId: 'co1', direction: 'OUTBOUND' });
    expect(call.where.status.in.sort()).toEqual(['DELIVERED', 'SENT']);
    expect(call.data).toEqual({ status: 'READ' });
  });

  it('a failure keeps Meta\'s reason', async () => {
    await processWebhookPayload(payload({ statuses: [{ id: 'wamid.OUT', status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }] }));
    expect(h.db.whatsAppMessage.updateMany.mock.calls[0][0].data).toEqual({ status: 'FAILED', statusError: 'Re-engagement message' });
  });

  it('an unknown connection is skipped', async () => {
    h.db.whatsAppConnection.findFirst.mockResolvedValue(null);
    expect(await processWebhookPayload(payload({ statuses: [{ id: 'w', status: 'read' }] }))).toMatchObject({ skipped: 1, statuses: 0 });
  });
});
