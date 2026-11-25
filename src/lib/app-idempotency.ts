import { NextResponse } from 'next/server';
import { requireCompanyTenant } from './auth';
import { apiError } from './api-error';
import { V1Fault, V1_CODE } from './v1/door';
import { claimIdempotency, releaseIdempotency, rememberIdempotency, requestFingerprint } from './v1/idempotency';

/**
 * THE SAME ORDER, SENT TWICE BY A PHONE THAT LOST ITS SIGNAL, IS ONE ORDER (22/11, «Zaki Orders»).
 *
 * The app queues a hand-typed order when there is no network and sends it when there is; a send whose answer was lost
 * is sent again. The dashboard's order door (`POST /api/orders`) made an order per call, so that retry was a second
 * order. Now, WHEN the request carries `Idempotency-Key`, it goes through the very ledger the system API uses
 * (`v1/idempotency.ts`: a claim on a unique index, never a look-before-write): the same key and the same body get the
 * first answer back (`Idempotent-Replay: true`), a different body under the same key is refused, and one still being
 * written is «try again».
 *
 * WITHOUT THE HEADER NOTHING CHANGES — the browser's form sends none and is answered exactly as before.
 *
 * The key is kept per PERSON (`app:<userId>:<key>`) inside the company's ledger, so one person's key can never replay
 * somebody else's order, and it can never meet a system's `zk1_` key of the same spelling.
 * Only a 2xx answer is kept: a refusal (a bad phone, a blocked number) is not an order, and the corrected retry must not
 * be answered with it.
 */

const IN_PROGRESS_AR = 'نفس الطلب لسا عم ينحفظ — أعد المحاولة بعد لحظات';
const CONFLICT_AR = 'هذا المفتاح استُعمل لطلب مختلف';

export const REPLAY_HEADER = 'Idempotent-Replay';

export async function withAppIdempotency(
  req: Request,
  rawKey: string,
  handler: (req: Request) => Promise<Response>
): Promise<Response> {
  const key = rawKey.trim();
  if (key.length > 200) {
    return NextResponse.json({ error: 'مفتاح الطلب طويل أكثر من اللازم', errorAr: 'مفتاح الطلب طويل أكثر من اللازم' }, { status: 400 });
  }
  let companyId: string;
  let ledgerKey: string;
  try {
    const tenant = await requireCompanyTenant();
    companyId = tenant.companyId;
    ledgerKey = `app:${tenant.user.id}:${key}`;
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }

  const text = await req.text();
  const hash = requestFingerprint(req.method, new URL(req.url).pathname, text);

  try {
    const replay = await claimIdempotency(companyId, ledgerKey, hash);
    if (replay) {
      return NextResponse.json(replay.body, { status: replay.status, headers: { [REPLAY_HEADER]: 'true' } });
    }
  } catch (e) {
    if (e instanceof V1Fault) {
      const errorAr = e.code === V1_CODE.IDEMPOTENCY_CONFLICT ? CONFLICT_AR : IN_PROGRESS_AR;
      return NextResponse.json({ error: e.message, errorAr, code: e.code }, { status: e.status });
    }
    throw e;
  }

  try {
    const res = await handler(new Request(req.url, { method: req.method, headers: req.headers, body: text }));
    if (res.status >= 200 && res.status < 300) {
      await rememberIdempotency(companyId, ledgerKey, res.status, await res.clone().json().catch(() => null));
    } else {
      await releaseIdempotency(companyId, ledgerKey);
    }
    return res;
  } catch (e) {
    await releaseIdempotency(companyId, ledgerKey);
    throw e;
  }
}
