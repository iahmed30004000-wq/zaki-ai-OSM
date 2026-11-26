import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MEDIA DOOR IS NEVER PUBLIC.
 *
 * `GET /api/whatsapp/messages/[id]/media` serves a customer's photo, voice note or file. What it must hold:
 *  · no `whatsapp.view`, nothing is read;
 *  · the lookup is one query scoped to the company AND to the conversations her view reaches (ASSIGNED);
 *  · another company's message, a text message and a missing one all answer the same 404;
 *  · a picture is inline as itself, a document is an attachment, anything else is octet-stream — always nosniff;
 *  · a voice note can be sought (Range → 206);
 *  · a file not yet on our disk is fetched on first view, and one Meta no longer has answers 410.
 */

const h = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  tenantOf: vi.fn(),
  db: { whatsAppMessage: { findFirst: vi.fn() } },
  readMediaFile: vi.fn(),
  ensureMediaStored: vi.fn(),
  scope: { current: null as null | Record<string, unknown> },
}));
vi.mock('@/lib/db', () => ({ db: h.db }));
vi.mock('@/lib/auth', () => ({ requirePermission: h.requirePermission, tenantOf: h.tenantOf }));
vi.mock('@/lib/whatsapp/inbox-scope', () => ({ inboxScopeWhere: () => h.scope.current }));
vi.mock('@/lib/whatsapp/media', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp/media')>();
  return { ...real, readMediaFile: h.readMediaFile, ensureMediaStored: h.ensureMediaStored };
});

import { GET } from './route';

const BYTES = Buffer.from('0123456789');
const call = (id = 'm1', headers: Record<string, string> = {}, q = '') =>
  GET(new Request(`http://x/api/whatsapp/messages/${id}/media${q}`, { headers }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.scope.current = null;
  h.requirePermission.mockResolvedValue({ id: 'u1', companyId: 'co1' });
  h.tenantOf.mockImplementation(async (user: { companyId: string }) => ({ user, companyId: user.companyId }));
  h.db.whatsAppMessage.findFirst.mockResolvedValue({
    id: 'm1', messageType: 'IMAGE', mediaId: 'MID', mediaKey: 'companies/co1/whatsapp/m1.jpg', mimeType: 'image/jpeg', fileName: null, mediaStatus: 'STORED',
  });
  h.readMediaFile.mockResolvedValue(BYTES);
});

describe('who may ask', () => {
  it('NEGATIVE: without `whatsapp.view` nothing is read', async () => {
    h.requirePermission.mockRejectedValue(new Error('Forbidden: missing required permission whatsapp.view'));
    const res = await call();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.requirePermission).toHaveBeenCalledWith('whatsapp.view');
    expect(h.db.whatsAppMessage.findFirst).not.toHaveBeenCalled();
    expect(h.readMediaFile).not.toHaveBeenCalled();
  });

  it('the lookup is scoped to the company', async () => {
    await call();
    expect(h.db.whatsAppMessage.findFirst.mock.calls[0][0].where).toEqual({ id: 'm1', companyId: 'co1' });
  });

  it('a person limited to «المسندة إليه» reaches only the conversations her view reaches', async () => {
    h.scope.current = { OR: [{ assignedUserId: 'u1' }, { assignedUserId: null }] };
    await call();
    expect(h.db.whatsAppMessage.findFirst.mock.calls[0][0].where).toEqual({
      id: 'm1',
      companyId: 'co1',
      conversation: { OR: [{ assignedUserId: 'u1' }, { assignedUserId: null }] },
    });
  });

  it('NEGATIVE: another company\'s message (or one outside her reach) is a 404, and no file is read', async () => {
    h.db.whatsAppMessage.findFirst.mockResolvedValue(null);
    const res = await call('m-of-someone-else');
    expect(res.status).toBe(404);
    expect(h.readMediaFile).not.toHaveBeenCalled();
  });

  it('NEGATIVE: a text message has no file — the same 404', async () => {
    h.db.whatsAppMessage.findFirst.mockResolvedValue({ id: 'm1', messageType: 'TEXT', mediaId: null, mediaKey: null, mimeType: null, fileName: null, mediaStatus: null });
    expect((await call()).status).toBe(404);
  });
});

describe('what is served', () => {
  it('a photo: inline, as itself, nosniff, private', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(res.headers.get('content-disposition')).toMatch(/^inline;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toMatch(/private/);
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it('a PDF is an attachment with its own name; an unknown type is octet-stream', async () => {
    h.db.whatsAppMessage.findFirst.mockResolvedValue({ id: 'm1', messageType: 'DOCUMENT', mediaId: 'D', mediaKey: 'k', mimeType: 'application/pdf', fileName: 'فاتورة.pdf', mediaStatus: 'STORED' });
    let res = await call();
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;.*filename\*=UTF-8''%D9%81/);
    h.db.whatsAppMessage.findFirst.mockResolvedValue({ id: 'm1', messageType: 'DOCUMENT', mediaId: 'D', mediaKey: 'k', mimeType: 'text/html', fileName: 'x.html', mediaStatus: 'STORED' });
    res = await call();
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('a voice note can be sought: Range answers 206 with the part', async () => {
    h.db.whatsAppMessage.findFirst.mockResolvedValue({ id: 'm1', messageType: 'AUDIO', mediaId: 'A', mediaKey: 'k', mimeType: 'audio/ogg; codecs=opus', fileName: null, mediaStatus: 'STORED' });
    const res = await call('m1', { range: 'bytes=2-5' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('2345');
  });

  it('not on our disk yet: fetched on first view, then served', async () => {
    h.readMediaFile.mockResolvedValueOnce(null).mockResolvedValueOnce(BYTES);
    h.ensureMediaStored.mockResolvedValue({ mediaKey: 'companies/co1/whatsapp/m1.jpg', mediaStatus: 'STORED', mimeType: 'image/jpeg' });
    const res = await call();
    expect(h.ensureMediaStored).toHaveBeenCalledWith('m1');
    expect(res.status).toBe(200);
  });

  it('Meta no longer has it: 410, said in Arabic', async () => {
    h.readMediaFile.mockResolvedValue(null);
    h.ensureMediaStored.mockResolvedValue({ mediaKey: null, mediaStatus: 'FAILED', mimeType: 'image/jpeg' });
    const res = await call();
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/واتساب/);
  });
});
