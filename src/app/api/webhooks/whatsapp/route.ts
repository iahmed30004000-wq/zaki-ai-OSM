/**
 * WHATSAPP WEBHOOK — the only public WhatsApp endpoint (Meta must reach it).
 *
 * GET  → Meta subscription verification (hub.mode/hub.verify_token/hub.challenge).
 * POST → raw-body signature verification (X-Hub-Signature-256) + safe payload
 *        processing with idempotency. Always answers 200 for well-signed
 *        payloads (Meta retries on non-2xx); malformed/unauthorized → 4xx.
 * No secrets are ever returned or logged.
 */
import { NextResponse, after } from 'next/server';
import { getVerifyToken } from '@/lib/whatsapp/config';
import { verifyMetaSignature } from '@/lib/whatsapp/signature';
import { processWebhookPayload } from '@/lib/whatsapp/inbound';
import { prefetchMedia } from '@/lib/whatsapp/media';
import { rateLimit, getClientIp } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const expected = await getVerifyToken();
  if (mode === 'subscribe' && expected && token) {
    // Timing-safe comparison without exposing which half failed
    const a = Buffer.from(expected);
    const b = Buffer.from(token);
    if (a.length === b.length && a.equals(b)) {
      return new NextResponse(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

export async function POST(req: Request) {
  const rl = rateLimit(`wa-webhook:${getClientIp(req)}`, 600, 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  if (!await verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }

  try {
    const result = await processWebhookPayload(payload);
    // The files of this delivery (photos, voice notes…) are fetched from Meta AFTER the 200 has gone, so a slow download never
    // makes Meta retry. Best-effort: the media door fetches on first view whatever this did not.
    const ids = result?.mediaMessageIds ?? [];
    if (ids.length > 0) {
      try {
        after(() => prefetchMedia(ids));
      } catch {
        /* outside a request scope (tests, scripts): the first view fetches instead */
      }
    }
  } catch (e) {
    // Never expose internals; Meta will retry on 500 anyway
    console.error('[whatsapp] webhook processing failed:', (e as Error)?.name || 'unknown');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }

  return NextResponse.json({ received: true }, { status: 200 });
}
