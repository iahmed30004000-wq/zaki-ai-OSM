import crypto from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE WHATSAPP DOOR: AN HMAC OVER THE BYTES META SENT.
 *
 * Meta signs the RAW request body with the app secret and sends the result
 * in `X-Hub-Signature-256`. A server that re-serialises the JSON before
 * checking would reject real calls (whitespace, key order, unicode
 * escapes differ) — or, worse, be talked into accepting a body that is not
 * the one that was signed. So the check runs on the text exactly as it
 * arrived, and a delivery Meta retries must be answered 2xx or it never
 * stops retrying.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { processWebhookPayload } = vi.hoisted(() => ({ processWebhookPayload: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/lib/whatsapp/inbound', () => ({ processWebhookPayload }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ allowed: true, remaining: 1, retryAfterSec: 0 }),
  getClientIp: () => '203.0.113.7',
}));

import { POST } from './route';
import { verifyMetaSignature } from '@/lib/whatsapp/signature';

const APP_SECRET = 'test-meta-app-secret-for-hmac-0123456789';

const sign = (body: string, secret = APP_SECRET) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

// Pretty-printed with Arabic text on purpose: re-serialising it changes the bytes.
const RAW = '{\n  "object": "whatsapp_business_account",\n  "entry": [ { "id": "1", "text": "مرحبا" } ]\n}';

function call(headers: Record<string, string>, body: string) {
  return new Request('http://localhost/api/webhooks/whatsapp', { method: 'POST', headers, body });
}

beforeEach(() => {
  processWebhookPayload.mockClear();
  process.env.WHATSAPP_APP_SECRET = APP_SECRET;
});

describe('verifyMetaSignature', () => {
  it('accepts an HMAC-SHA256 of the raw body with the app secret', () => {
    expect(verifyMetaSignature(RAW, sign(RAW))).toBe(true);
  });

  it('refuses a body that differs by one byte', () => {
    expect(verifyMetaSignature(`${RAW} `, sign(RAW))).toBe(false);
    expect(verifyMetaSignature(RAW.replace('1', '2'), sign(RAW))).toBe(false);
  });

  it('is computed over the raw text, not over the parsed-and-re-serialised JSON', () => {
    const compact = JSON.stringify(JSON.parse(RAW));
    expect(compact).not.toBe(RAW);
    expect(verifyMetaSignature(RAW, sign(compact))).toBe(false);
    expect(verifyMetaSignature(compact, sign(compact))).toBe(true);
  });

  it('refuses another secret, a missing header, a missing prefix and a short one', () => {
    expect(verifyMetaSignature(RAW, sign(RAW, 'a-different-secret'))).toBe(false);
    expect(verifyMetaSignature(RAW, null)).toBe(false);
    expect(verifyMetaSignature(RAW, '')).toBe(false);
    expect(verifyMetaSignature(RAW, sign(RAW).slice('sha256='.length))).toBe(false);
    expect(verifyMetaSignature(RAW, 'sha256=abc')).toBe(false);
    expect(verifyMetaSignature(RAW, sign(RAW).toUpperCase())).toBe(false);
  });

  it('fails closed with no app secret: a signature made with an empty key is not accepted', () => {
    delete process.env.WHATSAPP_APP_SECRET;
    expect(verifyMetaSignature(RAW, sign(RAW, ''))).toBe(false);
    expect(verifyMetaSignature(RAW, sign(RAW, APP_SECRET))).toBe(false);
  });
});

describe('POST /api/webhooks/whatsapp', () => {
  it('a correctly signed body is processed and answered 200', async () => {
    const res = await POST(call({ 'x-hub-signature-256': sign(RAW) }, RAW));
    expect(res.status).toBe(200);
    expect(processWebhookPayload).toHaveBeenCalledTimes(1);
    expect(processWebhookPayload).toHaveBeenCalledWith(JSON.parse(RAW));
  });

  it('a wrong or missing signature is refused and nothing is processed', async () => {
    expect((await POST(call({ 'x-hub-signature-256': sign(RAW, 'nope') }, RAW))).status).toBe(403);
    expect((await POST(call({}, RAW))).status).toBe(403);
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it('a signature made over the compact JSON does not pass for the pretty body Meta did not sign', async () => {
    const res = await POST(call({ 'x-hub-signature-256': sign(JSON.stringify(JSON.parse(RAW))) }, RAW));
    expect(res.status).toBe(403);
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it('with no app secret configured the door is shut', async () => {
    delete process.env.WHATSAPP_APP_SECRET;
    const res = await POST(call({ 'x-hub-signature-256': sign(RAW, '') }, RAW));
    expect(res.status).toBe(403);
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it('a signed body that is not JSON is a 400, after the signature, not before it', async () => {
    const bad = '{not json';
    expect((await POST(call({ 'x-hub-signature-256': sign(bad) }, bad))).status).toBe(400);
    expect((await POST(call({ 'x-hub-signature-256': 'sha256=00' }, bad))).status).toBe(403);
    expect(processWebhookPayload).not.toHaveBeenCalled();
  });

  it('the same signed delivery sent twice is answered 2xx both times', async () => {
    const headers = { 'x-hub-signature-256': sign(RAW) };
    const first = await POST(call(headers, RAW));
    const second = await POST(call(headers, RAW));
    expect([first.status, second.status]).toEqual([200, 200]);
  });

  it('a failure inside processing is a 500 that leaks nothing', async () => {
    processWebhookPayload.mockRejectedValueOnce(new Error('connection string with password'));
    const res = await POST(call({ 'x-hub-signature-256': sign(RAW) }, RAW));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('password');
  });
});
