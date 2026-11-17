/**
 * TELEGRAM WEBHOOK — the only public Telegram endpoint.
 *
 * Telegram sends X-Telegram-Bot-Api-Secret-Token (set at setWebhook time).
 * Verification is timing-safe; a wrong/missing secret → 403 with no info.
 * Duplicate deliveries are absorbed by the DB unique constraint
 * (companyId + chatId + messageId) — never a duplicate order.
 */
import { NextResponse } from 'next/server';
import { verifyTelegramSecret } from '@/lib/telegram/signature';
import { processTelegramUpdate } from '@/lib/telegram/inbound';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 256 * 1024;

export async function POST(req: Request) {
  const rl = rateLimit(`tg-webhook:${getClientIp(req)}`, 1200, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  // Secret verification FIRST (before reading/parsing the body)
  if (!await verifyTelegramSecret(req.headers.get('x-telegram-bot-api-secret-token'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  try {
    await processTelegramUpdate(payload);
  } catch (e) {
    // Never expose internals; Telegram retries on 5xx (idempotency protects us)
    console.error('[telegram] webhook processing failed:', (e as Error)?.name || 'unknown');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
