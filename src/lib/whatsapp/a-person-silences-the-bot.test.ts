import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ANY MESSAGE A PERSON SENDS SILENCES THE ORDER BOT IN THAT CONVERSATION; THE BOT'S OWN REPLY DOES NOT (the owner, 2026-11-26).
 *
 * Meta's client is mocked — no Graph call is made here. What is held:
 *  · a person's text pauses the bot (STAFF_REPLIED) in the same write as the preview, once;
 *  · the bot's reply is marked `sentByBot`, pauses nothing, and is refused — Meta never called — when the conversation was
 *    paused meanwhile or Meta's 24-hour window is closed. The bot has no template door at all.
 */

const h = vi.hoisted(() => ({
  db: {
    whatsAppConversation: { findFirst: vi.fn(), update: vi.fn() },
    whatsAppMessage: { findFirst: vi.fn(), create: vi.fn() },
    whatsAppConnection: { update: vi.fn() },
  },
  meta: { sendTextMessage: vi.fn(), sendMediaMessage: vi.fn(), sendReaction: vi.fn(), sendTemplateMessage: vi.fn(), uploadMedia: vi.fn(), sendTypingIndicator: vi.fn() },
}));
vi.mock('../db', () => ({ db: h.db }));
vi.mock('../audit', () => ({ logAudit: async () => undefined }));
vi.mock('../auth', () => ({
  requirePermission: async () => ({ id: 'u1', role: 'MODERATOR', permissions: ['whatsapp.send'] }),
  requireCompanyTenant: async () => ({ user: { id: 'u1' }, companyId: 'co1' }),
}));
vi.mock('./inbox-scope', () => ({ inboxScopeWhere: () => null }));
vi.mock('./config', () => ({ getAccessToken: async () => 'tok', getPhoneNumberId: async () => 'pn' }));
vi.mock('./connection', () => ({ getActiveConnection: async () => ({ id: 'cn1' }), effectiveStatus: async () => 'CONNECTED' }));
vi.mock('../rate-limit', () => ({ rateLimit: () => ({ allowed: true }) }));
vi.mock('./cloud-api', () => h.meta);

import * as send from './send';

const open = {
  id: 'cv1',
  companyId: 'co1',
  customerPhone: '962790000000',
  customerName: 'سارة',
  customerId: 'cu1',
  connectionId: 'cn1',
  lastInboundAt: new Date(Date.now() - 3600_000),
  botPaused: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.db.whatsAppConversation.findFirst.mockResolvedValue(open);
  h.db.whatsAppConversation.update.mockResolvedValue({});
  h.db.whatsAppConnection.update.mockResolvedValue({});
  h.db.whatsAppMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm-new', createdAt: new Date(), updatedAt: new Date(), ...data }));
  h.meta.sendTextMessage.mockResolvedValue({ ok: true, wamid: 'w-text' });
});

describe('a person answers', () => {
  it('the bot goes silent here, in the same write as the preview', async () => {
    const r = await send.sendOutboundMessage('cv1', 'أهلين، أنا من الفريق');
    expect(r.ok).toBe(true);
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data).toMatchObject({ botPaused: true, botPausedReason: 'STAFF_REPLIED' });
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data.sentByBot).toBeUndefined();
  });

  it('and a second reply does not move the pause', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue({ ...open, botPaused: true });
    await send.sendOutboundMessage('cv1', 'كمان شي');
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data.botPaused).toBeUndefined();
  });
});

describe('the bot answers', () => {
  it('its line is marked as the bot’s and pauses nothing', async () => {
    const r = await send.sendBotText('co1', 'cv1', 'أهلين فيك');
    expect(r.ok).toBe(true);
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data.sentByBot).toBe(true);
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data.botPaused).toBeUndefined();
  });

  it('NEGATIVE: paused meanwhile — refused, Meta never called', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue({ ...open, botPaused: true });
    const r = await send.sendBotText('co1', 'cv1', 'أهلين');
    expect(r).toMatchObject({ ok: false, code: 'BOT_PAUSED' });
    expect(h.meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: outside the 24-hour window — refused, Meta never called', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue({ ...open, lastInboundAt: new Date(Date.now() - 25 * 3600_000) });
    const r = await send.sendBotText('co1', 'cv1', 'أهلين');
    expect(r).toMatchObject({ ok: false, code: 'WINDOW_CLOSED' });
    expect(h.meta.sendTextMessage).not.toHaveBeenCalled();
  });

  it('NEGATIVE: another company’s conversation is not found', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue(null);
    const r = await send.sendBotText('co2', 'cv1', 'أهلين');
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(h.db.whatsAppConversation.findFirst.mock.calls[0][0].where).toEqual({ id: 'cv1', companyId: 'co2' });
  });

  it('and there is no door for the bot to send a template', () => {
    expect(Object.keys(send).filter((k) => /bot/i.test(k)).sort()).toEqual(['botTyping', 'sendBotText']);
  });
});
