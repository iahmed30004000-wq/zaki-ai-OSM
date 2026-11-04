import { NextResponse } from 'next/server';
import { getClientIp, rateLimit } from '@/lib/rate-limit';
import { encryptionAvailable } from '@/lib/secrets';
import { isPairCode, sha256Hex } from '@/lib/call-helper/core';
import { PAIR_CODE_DEAD, redeemPairCode } from '@/lib/call-helper/door';

/**
 * POST /api/call-helper/pair — the Android app exchanges the one-time code for a token (contract v1 + v1.1).
 *
 * Body `{ code, deviceName }` → 200 `{ token, userName, callKey }`, or 4xx `{ error }` in Arabic, which the app shows as
 * it came. No session: the code IS the credential — ten minutes, spent once, for a person who is ACTIVE (see
 * `redeemPairCode`). Limited by address and by code, so neither a flood nor a guessed code gets far (a code is 192
 * random bits; the limit is for the flood). Pairing revokes her previous phone.
 */

const IP_LIMIT = 20;
const CODE_LIMIT = 5;
const WINDOW_MS = 10 * 60 * 1000;

const refuse = (status: number, error: string) => NextResponse.json({ error }, { status });

/** «Samsung SM-A515F» — kept short and printable; a phone that sends nothing is «تلفون أندرويد». */
function cleanDeviceName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  return s || 'تلفون أندرويد';
}

export async function POST(req: Request) {
  try {
    if (!rateLimit(`call-helper-pair:ip:${getClientIp(req)}`, IP_LIMIT, WINDOW_MS).allowed) {
      return refuse(429, 'محاولات ربط كتير — جرّبي بعد شوي.');
    }
    const body = (await req.json().catch(() => null)) as { code?: unknown; deviceName?: unknown } | null;
    const code = body?.code;
    if (!isPairCode(code)) return refuse(400, PAIR_CODE_DEAD);
    if (!rateLimit(`call-helper-pair:code:${sha256Hex(code)}`, CODE_LIMIT, WINDOW_MS).allowed) {
      return refuse(429, 'محاولات ربط كتير بهالرمز — افتحي «طلباتي» واضغطي «اربط هذا التلفون» من جديد.');
    }
    if (!encryptionAvailable()) {
      return refuse(503, 'الربط مش متاح هلق: مفتاح التشفير مش مضبوط على السيرفر — راجعي المسؤول.');
    }

    const result = await redeemPairCode(code, cleanDeviceName(body?.deviceName));
    if (!result.ok) return refuse(result.status, result.error);
    return NextResponse.json({ token: result.token, userName: result.userName, callKey: result.callKey });
  } catch (error) {
    console.error('[call-helper] pair failed:', (error as Error)?.message ?? '');
    return refuse(500, 'صار خطأ بالسيرفر — جرّبي كمان مرة.');
  }
}
