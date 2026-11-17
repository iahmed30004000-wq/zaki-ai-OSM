import { z } from 'zod';
import { db } from '../db';
import { sendMessage } from '../telegram/cloud-api';
import { resolveTelegramTarget } from '../telegram/targets';
import { V1_CODE, V1Fault } from './door';
import { claimIdempotency, releaseIdempotency, rememberIdempotency, requestFingerprint } from './idempotency';

/**
 * ONE TELEGRAM GATEWAY FOR EVERY SYSTEM — `POST /api/v1/notify` (the media buyer's doors, PR-B, O4).
 *
 * The OMS owns the bot and the webhook, so another system does not hold a bot token: it asks this door to deliver a message and the OMS decides the
 * transport. The scope is its own (`notify.send`) and it is a MESSAGE — it writes no order, no note and no lookup of a customer.
 *
 * ── NOT ONE BYTE ABOUT A CUSTOMER LEAVES BY THIS DOOR ──
 *
 * A text that looks like a phone number or an address is REFUSED (422 `CONTAINS_CUSTOMER_DATA`), never sent and never echoed back: the refusal names no
 * part of the text. The check is a heuristic on purpose weighed towards letting an ad's own numbers through (an ad id is 15 digits or more, a count of
 * impressions does not start like a number the country dials) — it is a second lock behind the asking system's own rule, not the only one.
 *
 * ── THE SAME KEY SENDS ONCE, FOR 24 HOURS ──
 *
 * `key` is the idempotency key, in the body (the contract's shape). The same key with the same message answers the first answer again, with
 * `duplicate: true` and no second message; the same key with another text is 409 `IDEMPOTENCY_CONFLICT`. A key older than 24 hours is free again. The record lives
 * in the door's own `idempotency_records` under a `notify:` prefix, so a key can never meet an order's. A message Telegram did not accept GIVES THE KEY BACK
 * (502 `TELEGRAM_UNAVAILABLE`): retrying with the same key is exactly what the caller is told to do.
 */

export const NOTIFY_KEY_HOURS = 24;

const targetSchema = z.union([
  z.literal('owner'),
  z.object({ person: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/) }).strict(),
  z
    .object({
      chat_id: z.union([z.number().int(), z.string().regex(/^-?\d{1,20}$/)]),
      topic_id: z.number().int().min(1).optional(),
    })
    .strict(),
]);

export const notifySchema = z
  .object({
    target: targetSchema,
    text: z.string().min(1).max(4096),
    key: z.string().min(8).max(120),
    link: z.string().max(300).optional(),
  })
  .strict();
export type NotifyInput = z.infer<typeof notifySchema>;

/** Arabic-Indic and Persian digits written as the digits a phone number is checked in. */
const toAscii = (s: string) =>
  s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));

/** Words that introduce where somebody lives. «عنوان» alone is the title of an ad; these are not. */
const ADDRESS_WORDS = /(?:^|[\s:،,.(])(?:شارع|عمارة|بناية|طابق|عنوان التوصيل|عنوان الزبون|العنوان|street|building|floor|apartment|apt\.?)(?=[\s:،,.)]|$)/i;

/**
 * Does this text carry a phone number or an address? Phone shapes: a number with a `+` or `00` or a trunk `0`, 8–13 digits; a bare run of 9–12 digits starting with the
 * dial prefixes of Syria and Jordan (9…, 7…, 963…, 962…); and any number written in groups (`0936 654 998`, `093-665-4998`) of 8 to 13 digits. A run of 14 digits or more is
 * an id and passes; so does a short count.
 */
export function containsCustomerData(text: string): boolean {
  const t = toAscii(text);
  if (ADDRESS_WORDS.test(t)) return true;
  // numbers written with spaces, dashes, dots or brackets between groups
  for (const m of t.matchAll(/\+?\(?\d[\d\s().-]{6,}\d/g)) {
    const digits = m[0].replace(/\D/g, '');
    const grouped = /[\s().-]/.test(m[0]);
    if (digits.length >= 8 && digits.length <= 13 && (grouped || m[0].startsWith('+') || /^(0|00)/.test(digits))) return true;
  }
  // bare runs
  for (const m of t.matchAll(/\d{7,}/g)) {
    const run = m[0];
    if (run.length >= 14) continue;
    if (/^0\d{7,12}$/.test(run) || /^00\d{8,12}$/.test(run)) return true;
    if (/^(9|7)\d{8}$/.test(run) || /^96[23]\d{9}$/.test(run)) return true;
  }
  return false;
}

export interface NotifyAnswer {
  ok: true;
  delivered: boolean;
  duplicate: boolean;
  message_id: number | null;
}

/** Telegram's own words for «that chat is not one this bot can write to». */
const UNKNOWN_CHAT = /chat not found|bot was kicked|bot was blocked|user is deactivated|have no rights|not enough rights|group chat was upgraded|PEER_ID_INVALID/i;

const fault = (status: number, code: (typeof V1_CODE)[keyof typeof V1_CODE], message: string, details: Record<string, unknown> | null = null) =>
  new V1Fault(status, code, message, details);

/** Validates, refuses customer data, resolves the target, sends once. Throws a `V1Fault` for every refusal. */
export async function sendNotification(companyId: string, raw: unknown, path: string, now: Date = new Date()): Promise<NotifyAnswer> {
  const parsed = notifySchema.safeParse(raw);
  if (!parsed.success) {
    // Field names only: the text itself is never repeated back.
    throw fault(422, V1_CODE.VALIDATION_FAILED, 'The body does not fit the schema', {
      fields: [...new Set(parsed.error.issues.map((i) => i.path.join('.') || 'body'))].slice(0, 10),
    });
  }
  const input = parsed.data;

  if (containsCustomerData(input.text) || (input.link !== undefined && containsCustomerData(input.link))) {
    throw fault(422, V1_CODE.CONTAINS_CUSTOMER_DATA, 'The text looks like a phone number or an address and was not sent');
  }

  const target = await resolveTelegramTarget(input.target);
  if (!target) throw fault(404, V1_CODE.TARGET_UNKNOWN, 'This system does not know that target');

  // The key lives in its own space, and a key older than a day is free again.
  const key = `notify:${input.key}`;
  await db.idempotencyRecord.deleteMany({ where: { companyId, key, createdAt: { lt: new Date(now.getTime() - NOTIFY_KEY_HOURS * 3_600_000) } } });
  const fingerprint = requestFingerprint('POST', path, JSON.stringify({ target: input.target, text: input.text, link: input.link ?? null }));
  const replay = await claimIdempotency(companyId, key, fingerprint);
  if (replay) return { ...(replay.body as NotifyAnswer), duplicate: true };

  const text = (input.link ? `${input.text}\n${input.link}` : input.text).slice(0, 4096);
  let sent;
  try {
    sent = await sendMessage(target.chatId, text, undefined, target.topicId);
  } catch {
    sent = { ok: false as const, errorCode: 'NETWORK' as const, description: undefined };
  }

  if (!sent.ok) {
    // Nothing was delivered, so nothing is remembered: the same key may try again.
    await releaseIdempotency(companyId, key);
    if (sent.errorCode === 'API_ERROR' && sent.description && UNKNOWN_CHAT.test(sent.description)) {
      throw fault(404, V1_CODE.TARGET_UNKNOWN, 'The bot cannot write to that chat');
    }
    throw fault(502, V1_CODE.TELEGRAM_UNAVAILABLE, 'Telegram did not accept the message; retry with the same key');
  }

  const answer: NotifyAnswer = { ok: true, delivered: true, duplicate: false, message_id: sent.result?.message_id ?? null };
  await rememberIdempotency(companyId, key, 200, answer);
  return answer;
}
