import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { rateLimit, getClientIp } from '@/lib/rate-limit';
import { verifyPagesSignature } from '@/lib/leads/pages-signature';
import { leadSchema, takeLead } from '@/lib/leads/lead-intake';
import { leadsV2Switch } from '@/lib/leads/leads-v2-switch';

/**
 * POST /api/webhooks/pages/leads — A LEAD FROM THE PAGES SYSTEM (pages.zakiai.io), step E1 of Confirmation Center v2. PUBLIC by design: nothing reaches it that is not signed.
 *
 * The order of the checks is the order of what it costs an attacker, as the Telegram door does it: the rate limit; the SIGNATURE (\`X-Zaki-Timestamp\` within five minutes and
 * \`X-Zaki-Signature = sha256=HMAC(PAGES_WEBHOOK_SECRET, "<ts>.<raw body>")\`, fail closed without the secret) before the body is parsed; the size cap; then the strict payload. A wrong, stale or
 * missing signature is one and the same 401 — it says nothing about which. The product (an id of THIS catalogue) says whose lead it is; one that is unknown is a 422.
 *
 * The owner's switch (\`leadsV2\`) decides whether the lead is KEPT: off, the answer is the same «received» and nothing is stored. Kept once per \`id\` (a retry answers \`duplicate\`), and flagged — never refused —
 * when the same number ordered the same product in the last 24 hours. It creates no order and no customer, prices nothing and messages nobody; no value of the lead is ever echoed in an answer.
 */
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 64 * 1024;

const refuse = (status: number, code: string) => NextResponse.json({ ok: false, code }, { status });

export async function POST(req: Request) {
  const rl = rateLimit(`pages-leads:${getClientIp(req)}`, 600, 60_000);
  if (!rl.allowed) return refuse(429, 'RATE_LIMITED');

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return refuse(400, 'BAD_REQUEST');
  }
  if (raw.length > MAX_BODY_BYTES) return refuse(413, 'PAYLOAD_TOO_LARGE');

  // the signature is judged on the raw bytes BEFORE anything is parsed; no reason is given for a refusal
  const verdict = verifyPagesSignature({ timestamp: req.headers.get('x-zaki-timestamp'), signature: req.headers.get('x-zaki-signature'), rawBody: raw });
  if (verdict === 'NOT_CONFIGURED') return refuse(503, 'NOT_CONFIGURED');
  if (verdict !== 'OK') return refuse(401, 'UNAUTHORIZED');

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return refuse(400, 'BAD_REQUEST');
  }
  const parsed = leadSchema.safeParse(payload);
  if (!parsed.success) return refuse(422, 'INVALID_LEAD');

  // whose lead it is comes from the catalogue; the owner's switch of THAT company decides if it is kept
  const product = await db.product.findUnique({ where: { id: parsed.data.product_id }, select: { companyId: true } });
  if (!product) return refuse(422, 'UNKNOWN_PRODUCT');
  if (!(await leadsV2Switch(db, product.companyId)).enabled) return NextResponse.json({ ok: true, stored: false });

  const result = await takeLead(db, parsed.data);
  if (!result.ok) return refuse(result.status, result.code);
  return NextResponse.json({ ok: true, stored: true, duplicate: !result.created, recentOrder: result.recentOrder }, { status: result.created ? 201 : 200 });
}
