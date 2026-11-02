import { NextResponse } from 'next/server';

/**
 * THE COURIERS' STATUS WEBHOOK IS CANCELLED — EVERY METHOD ANSWERS 410, AND NOTHING ELSE HAPPENS.
 *
 * The owner, 2/11: «الغي الويب هوك». This was the one courier endpoint reachable without a session: a courier's server
 * posted a status to a link minted on the settings screen, the token in the path was the credential, and the status went
 * through `applyCourierEvent`. Statuses now come from the courier's own API, which the polling job asks
 * (`jobs/definitions/sync-courier-status`) — faster, and it needs no link to keep secret.
 *
 * So the address stays only to answer a courier that was given the old link and still posts to it: 410 Gone, in words,
 * rather than a bare 404 that reads as a fault on our side. It answers the same to a good token, a wrong one and none —
 * it does not look at the token, the body or the caller — and it touches no table, no audit trail and no rate limiter.
 *
 * The three `DeliveryProvider.webhook*` columns are still in the schema (no migration with this change) and nothing reads
 * or writes them any more. A link someone minted before stays dead because this route no longer looks anything up.
 */

export const dynamic = 'force-dynamic';

const GONE =
  'تم إلغاء رابط الويب هوك ولم يعد يستقبل شيئاً. حالات الشحنات بتنسحب من API شركة الشحن نفسه تلقائياً، فما في داعي لإرسالها لعندنا.';

function gone(): NextResponse {
  return NextResponse.json({ ok: false, gone: true, error: GONE, errorAr: GONE }, { status: 410 });
}

export async function GET() {
  return gone();
}

export async function POST() {
  return gone();
}

export async function PUT() {
  return gone();
}

export async function PATCH() {
  return gone();
}

export async function DELETE() {
  return gone();
}

// HEAD and OPTIONS would otherwise be answered by Next on its own (200 and 204): a cancelled address says 410 to all of them.
export async function HEAD() {
  return new NextResponse(null, { status: 410 });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 410 });
}
