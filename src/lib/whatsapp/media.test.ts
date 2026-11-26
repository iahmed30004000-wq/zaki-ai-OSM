import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * WHATSAPP MEDIA — what a staff upload may be, where the token may go, and what is kept.
 *
 * No real Graph call is made: `fetch` is replaced, and the «Meta» answers below are the documented shapes
 * (GET /{media-id} → { url, mime_type, sha256, file_size }; GET url → the bytes).
 */

const h = vi.hoisted(() => ({
  db: { whatsAppMessage: { findUnique: vi.fn(), update: vi.fn() } },
  dir: '',
}));
vi.mock('../db', () => ({ db: h.db }));
vi.mock('./config', () => ({ getAccessToken: async () => 'TEST-TOKEN', GRAPH_BASE: 'https://graph.facebook.com', GRAPH_VERSION: 'v21.0' }));
vi.mock('../storage', async (orig) => {
  const real = await orig<typeof import('../storage')>();
  const osm = await import('os');
  const pathm = await import('path');
  const fsm = await import('fs');
  h.dir = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'wa-media-'));
  return {
    ...real,
    LOCAL_STORAGE_DIR: h.dir,
    STORAGE_PROVIDER: 'local',
    isSafeStorageKey: (k: string) => !k.includes('..') && !k.includes('\\') && !k.startsWith('/'),
  };
});

import { ensureMediaStored, isMetaMediaUrl, servedAs, sniffOutbound, validateOutboundFile } from './media';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(60, 2)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(60, 3)]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(60, 4)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(60, 5)]);
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 6)]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(60, 7)]);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('outbound: the type comes from the bytes, the size from Meta\'s limits', () => {
  it('sniffs pictures, PDF, voice, video and Office files; a renamed program is refused', () => {
    expect(sniffOutbound(JPEG, 'image/png')).toBe('image/jpeg');
    expect(sniffOutbound(PNG, '')).toBe('image/png');
    expect(sniffOutbound(PDF, 'image/jpeg')).toBe('application/pdf');
    expect(sniffOutbound(OGG, 'audio/ogg')).toBe('audio/ogg');
    expect(sniffOutbound(MP4, 'video/mp4')).toBe('video/mp4');
    expect(sniffOutbound(ZIP, DOCX)).toBe(DOCX);
    expect(sniffOutbound(ZIP, 'application/zip')).toBeNull();
    expect(sniffOutbound(EXE, 'image/jpeg')).toBeNull();
  });

  it('«صورة» must be a JPEG or PNG; a PDF sent as «صورة» is refused in Arabic', () => {
    expect(validateOutboundFile({ bytes: JPEG, declaredMime: 'image/jpeg', fileName: 'a.jpg', want: 'image' })).toMatchObject({ ok: true, kind: 'image', mime: 'image/jpeg' });
    const r = validateOutboundFile({ bytes: PDF, declaredMime: 'application/pdf', fileName: 'a.pdf', want: 'image' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JPG/);
  });

  it('«ملف» sends a PDF as a document, a voice file as audio, an MP4 as video, a photo as a document', () => {
    expect(validateOutboundFile({ bytes: PDF, declaredMime: 'application/pdf', fileName: 'x/فاتورة.pdf', want: 'file' })).toMatchObject({ ok: true, kind: 'document', fileName: 'فاتورة.pdf' });
    expect(validateOutboundFile({ bytes: OGG, declaredMime: 'audio/ogg', fileName: 'v.ogg', want: 'file' })).toMatchObject({ ok: true, kind: 'audio' });
    expect(validateOutboundFile({ bytes: MP4, declaredMime: 'video/mp4', fileName: 'v.mp4', want: 'file' })).toMatchObject({ ok: true, kind: 'video' });
    expect(validateOutboundFile({ bytes: PNG, declaredMime: 'image/png', fileName: 'p.png', want: 'file' })).toMatchObject({ ok: true, kind: 'document' });
  });

  it('a photo over 5 MB and a file over 9 MB are refused before anything reaches Meta; an empty file too', () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    expect(validateOutboundFile({ bytes: big, declaredMime: 'image/jpeg', fileName: 'b.jpg', want: 'image' }).ok).toBe(false);
    const bigPdf = Buffer.concat([PDF, Buffer.alloc(9 * 1024 * 1024)]);
    expect(validateOutboundFile({ bytes: bigPdf, declaredMime: 'application/pdf', fileName: 'b.pdf', want: 'file' }).ok).toBe(false);
    expect(validateOutboundFile({ bytes: Buffer.alloc(0), declaredMime: 'image/jpeg', fileName: 'e.jpg', want: 'image' }).ok).toBe(false);
  });
});

describe('serving: what the door declares', () => {
  it('pictures, sound and video inline as themselves; documents as attachments; anything else as octet-stream', () => {
    expect(servedAs('image/jpeg')).toEqual({ contentType: 'image/jpeg', inline: true });
    expect(servedAs('audio/ogg; codecs=opus')).toEqual({ contentType: 'audio/ogg', inline: true });
    expect(servedAs('application/pdf')).toEqual({ contentType: 'application/pdf', inline: false });
    expect(servedAs('text/html')).toEqual({ contentType: 'application/octet-stream', inline: false });
    expect(servedAs('image/svg+xml')).toEqual({ contentType: 'application/octet-stream', inline: false });
  });
});

describe('the token goes only to Meta', () => {
  it('only https Meta hosts are trusted with it', () => {
    expect(isMetaMediaUrl('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1')).toBe(true);
    expect(isMetaMediaUrl('https://scontent.whatsapp.net/v/t1')).toBe(true);
    expect(isMetaMediaUrl('http://lookaside.fbsbx.com/x')).toBe(false);
    expect(isMetaMediaUrl('https://evil.example/fbsbx.com')).toBe(false);
    expect(isMetaMediaUrl('https://fbsbx.com.evil.example/x')).toBe(false);
    expect(isMetaMediaUrl('https://user:pw@lookaside.fbsbx.com/x')).toBe(false);
  });
});

describe('ensureMediaStored — fetched once, checked, kept', () => {
  const row = { id: 'm1', companyId: 'co1', messageType: 'IMAGE', mediaId: 'MID1', mimeType: 'image/jpeg', mediaKey: null, mediaStatus: 'PENDING', mediaSha256: null as string | null };
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    h.db.whatsAppMessage.update.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllGlobals());

  const graphInfo = (over: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1', mime_type: 'image/jpeg', file_size: JPEG.length, sha256: crypto.createHash('sha256').update(JPEG).digest('hex'), ...over }), { status: 200 });

  it('asks Graph for the URL, downloads with the token, checks the sha256 and writes companies/{co}/whatsapp/{id}.jpg', async () => {
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ ...row });
    fetchMock.mockResolvedValueOnce(graphInfo()).mockResolvedValueOnce(new Response(JPEG, { status: 200 }));
    const out = await ensureMediaStored('m1');
    expect(out).toMatchObject({ mediaStatus: 'STORED', mediaKey: 'companies/co1/whatsapp/m1.jpg' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://graph.facebook.com/v21.0/MID1');
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer TEST-TOKEN');
    expect(fs.readFileSync(path.join(h.dir, 'companies/co1/whatsapp/m1.jpg')).equals(JPEG)).toBe(true);
    expect(h.db.whatsAppMessage.update.mock.calls[0][0].data).toMatchObject({ mediaStatus: 'STORED', mediaSize: JPEG.length });
  });

  it('a URL that is not Meta\'s is never sent the token — the fetch is marked FAILED', async () => {
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ ...row, id: 'm2' });
    fetchMock.mockResolvedValueOnce(graphInfo({ url: 'https://attacker.example/steal' }));
    const out = await ensureMediaStored('m2');
    expect(out?.mediaStatus).toBe('FAILED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a file whose bytes do not match Meta\'s sha256 is not kept', async () => {
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ ...row, id: 'm3' });
    fetchMock.mockResolvedValueOnce(graphInfo({ sha256: 'f'.repeat(64) })).mockResolvedValueOnce(new Response(JPEG, { status: 200 }));
    expect((await ensureMediaStored('m3'))?.mediaStatus).toBe('FAILED');
    expect(fs.existsSync(path.join(h.dir, 'companies/co1/whatsapp/m3.jpg'))).toBe(false);
  });

  it('a file Meta says is larger than we keep is TOO_LARGE and never downloaded', async () => {
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ ...row, id: 'm4', messageType: 'DOCUMENT' });
    fetchMock.mockResolvedValueOnce(graphInfo({ file_size: 80 * 1024 * 1024 }));
    expect((await ensureMediaStored('m4'))?.mediaStatus).toBe('TOO_LARGE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a row already on disk is not fetched again', async () => {
    fs.mkdirSync(path.join(h.dir, 'companies/co1/whatsapp'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'companies/co1/whatsapp/m5.jpg'), JPEG);
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ ...row, id: 'm5', mediaKey: 'companies/co1/whatsapp/m5.jpg', mediaStatus: 'STORED' });
    await ensureMediaStored('m5');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a text message has no file to fetch', async () => {
    h.db.whatsAppMessage.findUnique.mockResolvedValue({ ...row, id: 'm6', messageType: 'TEXT', mediaId: null });
    await ensureMediaStored('m6');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

afterAll(() => {
  if (h.dir && h.dir.startsWith(os.tmpdir())) fs.rmSync(h.dir, { recursive: true, force: true });
});
