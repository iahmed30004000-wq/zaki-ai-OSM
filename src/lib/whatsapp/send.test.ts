import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE SEND DOORS: THE 24-HOUR WINDOW, A FILE JUDGED BEFORE META SEES IT, A REACTION ON OUR OWN MESSAGE.
 *
 * Meta's client is mocked — no Graph call is made here. What is held:
 *  · outside the window a text, a photo and a reaction are refused with `WINDOW_CLOSED` and Meta is never called;
 *  · the template is the way out, and it is refused in Arabic when no template is named;
 *  · a file of the wrong type is refused before it is uploaded; a good one is uploaded, sent by its id and kept;
 *  · a reaction names OUR message id and is sent to Meta with that message's wamid, within the same conversation only.
 */

const h = vi.hoisted(() => ({
  db: {
    whatsAppConversation: { findFirst: vi.fn(), update: vi.fn() },
    whatsAppMessage: { findFirst: vi.fn(), create: vi.fn() },
    whatsAppConnection: { update: vi.fn() },
    order: { findFirst: vi.fn() },
  },
  meta: {
    sendTextMessage: vi.fn(),
    sendMediaMessage: vi.fn(),
    sendReaction: vi.fn(),
    sendTemplateMessage: vi.fn(),
    uploadMedia: vi.fn(),
  },
  afterNoAnswer: vi.fn(),
  keep: vi.fn(),
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
vi.mock('./after-no-answer', async (orig) => {
  const real = await orig<typeof import('./after-no-answer')>();
  return { ...real, afterNoAnswer: h.afterNoAnswer };
});
vi.mock('./media', async (orig) => {
  const real = await orig<typeof import('./media')>();
  return { ...real, keepOutboundFile: h.keep };
});

import { sendOutboundMedia, sendOutboundMessage, sendOutboundReaction, sendWindowTemplate } from './send';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
const open = { id: 'cv1', customerPhone: '962790000000', customerName: 'سارة', customerId: 'cu1', connectionId: 'cn1', lastInboundAt: new Date(Date.now() - 3600_000) };
const closed = { ...open, lastInboundAt: new Date(Date.now() - 25 * 3600_000) };

beforeEach(() => {
  vi.clearAllMocks();
  h.db.whatsAppConversation.findFirst.mockResolvedValue(open);
  h.db.whatsAppConversation.update.mockResolvedValue({});
  h.db.whatsAppConnection.update.mockResolvedValue({});
  h.db.whatsAppMessage.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id ?? 'm-new', createdAt: new Date(), updatedAt: new Date(), ...data }));
  h.meta.sendTextMessage.mockResolvedValue({ ok: true, wamid: 'w-text' });
  h.meta.uploadMedia.mockResolvedValue({ ok: true, mediaId: 'MEDIA-1' });
  h.meta.sendMediaMessage.mockResolvedValue({ ok: true, wamid: 'w-media' });
  h.meta.sendReaction.mockResolvedValue({ ok: true, wamid: 'w-react' });
  h.meta.sendTemplateMessage.mockResolvedValue({ ok: true, wamid: 'w-tpl' });
  h.afterNoAnswer.mockResolvedValue({ byDialCode: {}, templateName: 'order_follow_up', templateLang: 'ar', templateParams: 'name' });
  h.keep.mockResolvedValue('companies/co1/whatsapp/x.jpg');
});

describe('the 24-hour window', () => {
  it('open: a text leaves and is recorded with its preview', async () => {
    const r = await sendOutboundMessage('cv1', 'أهلا 😊');
    expect(r.ok).toBe(true);
    expect(h.meta.sendTextMessage).toHaveBeenCalledWith({ phoneNumberId: 'pn', token: 'tok', to: '962790000000', text: 'أهلا 😊' });
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data).toMatchObject({ lastMessagePreview: 'أهلا 😊', lastMessageType: 'TEXT' });
  });

  it('NEGATIVE: closed — a text, a photo and a reaction are refused with WINDOW_CLOSED and Meta is never called', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue(closed);
    for (const r of [
      await sendOutboundMessage('cv1', 'أهلا'),
      await sendOutboundMedia('cv1', { bytes: JPEG, declaredMime: 'image/jpeg', fileName: 'a.jpg', want: 'image' }),
      await sendOutboundReaction('cv1', 'm1', '👍'),
    ]) {
      expect(r).toMatchObject({ ok: false, status: 409, code: 'WINDOW_CLOSED' });
    }
    expect(h.meta.sendTextMessage).not.toHaveBeenCalled();
    expect(h.meta.uploadMedia).not.toHaveBeenCalled();
    expect(h.meta.sendReaction).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a conversation the customer never wrote in is closed too', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue({ ...open, lastInboundAt: null });
    expect(await sendOutboundMessage('cv1', 'x')).toMatchObject({ ok: false, code: 'WINDOW_CLOSED' });
  });

  it('the template is the way out of a closed window, filled with the customer\'s name', async () => {
    h.db.whatsAppConversation.findFirst.mockResolvedValue(closed);
    const r = await sendWindowTemplate('cv1');
    expect(r.ok).toBe(true);
    expect(h.meta.sendTemplateMessage).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'order_follow_up', templateLang: 'ar', bodyValues: ['سارة'], to: '962790000000' })
    );
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data).toMatchObject({ messageType: 'TEMPLATE', status: 'SENT' });
  });

  it('NEGATIVE: no template named — refused in Arabic, nothing sent', async () => {
    h.afterNoAnswer.mockResolvedValue({ byDialCode: {}, templateName: '', templateLang: 'ar', templateParams: 'none' });
    expect(await sendWindowTemplate('cv1')).toMatchObject({ ok: false, code: 'NO_TEMPLATE' });
    expect(h.meta.sendTemplateMessage).not.toHaveBeenCalled();
  });
});

describe('a photo or a file', () => {
  it('a JPEG is uploaded, sent by its media id with the caption, kept on disk and recorded as IMAGE', async () => {
    const r = await sendOutboundMedia('cv1', { bytes: JPEG, declaredMime: 'image/jpeg', fileName: 'a.jpg', caption: 'المقاس L', want: 'image' });
    expect(r.ok).toBe(true);
    expect(h.meta.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'image/jpeg', phoneNumberId: 'pn' }));
    expect(h.meta.sendMediaMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', mediaId: 'MEDIA-1', caption: 'المقاس L' }));
    const data = h.db.whatsAppMessage.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ messageType: 'IMAGE', text: 'المقاس L', mediaId: 'MEDIA-1', mimeType: 'image/jpeg', mediaStatus: 'STORED', direction: 'OUTBOUND' });
    expect(h.keep).toHaveBeenCalledWith('co1', data.id, 'image/jpeg', JPEG);
  });

  it('NEGATIVE: a program renamed .jpg is refused before Meta sees a byte', async () => {
    const r = await sendOutboundMedia('cv1', { bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(40)]), declaredMime: 'image/jpeg', fileName: 'x.jpg', want: 'image' });
    expect(r).toMatchObject({ ok: false, status: 400, code: 'BAD_FILE' });
    expect(h.meta.uploadMedia).not.toHaveBeenCalled();
  });

  it('Meta refusing the upload is said, and nothing is recorded', async () => {
    h.meta.uploadMedia.mockResolvedValue({ ok: false, error: 'تعذر الاتصال بواتساب', code: 'META_ERROR' });
    const r = await sendOutboundMedia('cv1', { bytes: JPEG, declaredMime: 'image/jpeg', fileName: 'a.jpg', want: 'image' });
    expect(r).toMatchObject({ ok: false, status: 502 });
    expect(h.db.whatsAppMessage.create).not.toHaveBeenCalled();
  });
});

describe('a reaction', () => {
  it('names our message; Meta is sent that message\'s wamid; the preview does not move', async () => {
    h.db.whatsAppMessage.findFirst.mockResolvedValue({ externalMessageId: 'wamid.CUSTOMER' });
    const r = await sendOutboundReaction('cv1', 'm1', '❤️');
    expect(r.ok).toBe(true);
    expect(h.db.whatsAppMessage.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'm1', conversationId: 'cv1', companyId: 'co1' });
    expect(h.meta.sendReaction).toHaveBeenCalledWith(expect.objectContaining({ targetWamid: 'wamid.CUSTOMER', emoji: '❤️' }));
    expect(h.db.whatsAppMessage.create.mock.calls[0][0].data).toMatchObject({ messageType: 'REACTION', text: '❤️', reactionToExternalId: 'wamid.CUSTOMER' });
    expect(h.db.whatsAppConversation.update.mock.calls[0][0].data).not.toHaveProperty('lastMessagePreview');
  });

  it('NEGATIVE: a message of another conversation is not found, and nothing is sent', async () => {
    h.db.whatsAppMessage.findFirst.mockResolvedValue(null);
    expect(await sendOutboundReaction('cv1', 'm-elsewhere', '👍')).toMatchObject({ ok: false, status: 404 });
    expect(h.meta.sendReaction).not.toHaveBeenCalled();
  });
});
