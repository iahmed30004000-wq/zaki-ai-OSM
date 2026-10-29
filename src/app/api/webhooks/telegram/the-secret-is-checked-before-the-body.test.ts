import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * THE TELEGRAM DOOR: THE SECRET FIRST, THE BODY NEVER FOR A STRANGER.
 *
 * Telegram proves a call is its own with the header
 * `X-Telegram-Bot-Api-Secret-Token`. The route checks it BEFORE it reads
 * the body, so a caller without the secret costs us one comparison — not
 * a 256 KB read, a JSON parse and a database write. Nothing tested that
 * order, so moving the check below the parse would have stayed green.
 * ═══════════════════════════════════════════════════════════════════════
 */

const { processTelegramUpdate } = vi.hoisted(() => ({ processTelegramUpdate: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('@/lib/telegram/inbound', () => ({ processTelegramUpdate }));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: () => ({ allowed: true, remaining: 1, retryAfterSec: 0 }),
  getClientIp: () => '203.0.113.7',
}));

import { POST } from './route';
import { verifyTelegramSecret } from '@/lib/telegram/signature';

const SECRET = 'test-telegram-webhook-secret-0123456789';

function call(headers: Record<string, string>, body: string) {
  const req = new Request('http://localhost/api/webhooks/telegram', { method: 'POST', headers, body });
  const text = vi.spyOn(req, 'text');
  return { req, text };
}

beforeEach(() => {
  processTelegramUpdate.mockClear();
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
});

describe('verifyTelegramSecret', () => {
  it('accepts the configured secret and nothing else', () => {
    expect(verifyTelegramSecret(SECRET)).toBe(true);
    expect(verifyTelegramSecret(`${SECRET}x`)).toBe(false);
    expect(verifyTelegramSecret(SECRET.slice(0, -1))).toBe(false);
    expect(verifyTelegramSecret(SECRET.toUpperCase())).toBe(false);
    expect(verifyTelegramSecret('')).toBe(false);
    expect(verifyTelegramSecret(null)).toBe(false);
  });

  it('fails closed when no secret is configured, even for an empty header', () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    expect(verifyTelegramSecret('')).toBe(false);
    expect(verifyTelegramSecret(null)).toBe(false);
    expect(verifyTelegramSecret('anything')).toBe(false);
    process.env.TELEGRAM_WEBHOOK_SECRET = '   ';
    expect(verifyTelegramSecret('   ')).toBe(false);
  });
});

describe('POST /api/webhooks/telegram', () => {
  const update = JSON.stringify({ update_id: 1, message: { text: 'hi' } });

  it('a wrong secret is refused and the body is never read', async () => {
    const { req, text } = call({ 'x-telegram-bot-api-secret-token': 'wrong' }, update);
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(processTelegramUpdate).not.toHaveBeenCalled();
  });

  it('a missing header is refused the same way', async () => {
    const { req, text } = call({}, update);
    expect((await POST(req)).status).toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(processTelegramUpdate).not.toHaveBeenCalled();
  });

  it('with no secret configured the door is shut to everyone, including a caller who sends none', async () => {
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    const { req, text } = call({ 'x-telegram-bot-api-secret-token': '' }, update);
    expect((await POST(req)).status).toBe(403);
    expect(text).not.toHaveBeenCalled();
    expect(processTelegramUpdate).not.toHaveBeenCalled();
  });

  it('a stranger sending garbage is told 403, not 400 — the secret outranks the parse', async () => {
    const { req } = call({ 'x-telegram-bot-api-secret-token': 'wrong' }, '{not json');
    expect((await POST(req)).status).toBe(403);
  });

  it('a stranger sending an oversized body is told 403, not 413', async () => {
    const { req, text } = call({ 'x-telegram-bot-api-secret-token': 'wrong' }, 'x'.repeat(300 * 1024));
    expect((await POST(req)).status).toBe(403);
    expect(text).not.toHaveBeenCalled();
  });

  it('the right secret reads the body and processes the update once', async () => {
    const { req, text } = call({ 'x-telegram-bot-api-secret-token': SECRET }, update);
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(text).toHaveBeenCalledTimes(1);
    expect(processTelegramUpdate).toHaveBeenCalledTimes(1);
    expect(processTelegramUpdate).toHaveBeenCalledWith({ update_id: 1, message: { text: 'hi' } });
  });

  it('with the secret, the body checks still apply', async () => {
    const big = call({ 'x-telegram-bot-api-secret-token': SECRET }, 'x'.repeat(300 * 1024));
    expect((await POST(big.req)).status).toBe(413);
    const bad = call({ 'x-telegram-bot-api-secret-token': SECRET }, '{not json');
    expect((await POST(bad.req)).status).toBe(400);
    expect(processTelegramUpdate).not.toHaveBeenCalled();
  });

  it('the same update delivered twice is answered 2xx both times, so Telegram stops retrying', async () => {
    const first = await POST(call({ 'x-telegram-bot-api-secret-token': SECRET }, update).req);
    const second = await POST(call({ 'x-telegram-bot-api-secret-token': SECRET }, update).req);
    expect([first.status, second.status]).toEqual([200, 200]);
  });

  it('a failure inside processing is a 500 that leaks nothing', async () => {
    processTelegramUpdate.mockRejectedValueOnce(new Error('secret detail: db password'));
    const res = await POST(call({ 'x-telegram-bot-api-secret-token': SECRET }, update).req);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('db password');
  });
});
