/**
 * TELEGRAM BOT API CLIENT — server-side fetch wrapper with timeout.
 * The bot token is never logged, never returned, and never included in
 * errors surfaced to callers. All calls fail closed with a safe error.
 */
import { getApiBaseUrl, getBotToken } from './config';

const API_TIMEOUT_MS = 10_000;

export interface TelegramApiResult<T = any> {
  ok: boolean;
  result?: T;
  /** Safe error code — never contains raw Telegram API payloads. */
  errorCode?: 'NO_TOKEN' | 'TIMEOUT' | 'NETWORK' | 'API_ERROR';
  /** Short description_code for internal logging only. */
  description?: string;
}

async function call<T = any>(method: string, payload?: Record<string, unknown>): Promise<TelegramApiResult<T>> {
  const token = await getBotToken();
  if (!token) return { ok: false, errorCode: 'NO_TOKEN' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(`${getApiBaseUrl()}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    const data: any = await res.json().catch(() => null);
    if (res.ok && data?.ok) {
      return { ok: true, result: data.result };
    }
    // Store only a short description (no raw response body leakage)
    const description = typeof data?.description === 'string' ? data.description.slice(0, 120) : 'unknown';
    return { ok: false, errorCode: 'API_ERROR', description };
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    return { ok: false, errorCode: aborted ? 'TIMEOUT' : 'NETWORK' };
  } finally {
    clearTimeout(timer);
  }
}

export function getMe() {
  return call<{ id: number; username?: string; first_name?: string; can_join_groups?: boolean }>('getMe');
}

export function getWebhookInfo() {
  return call<{
    url?: string;
    pending_update_count?: number;
    last_error_message?: string;
    last_error_date?: number;
  }>('getWebhookInfo');
}

/** Registers the webhook with the secret token header Telegram will echo back. */
export function setWebhook(url: string, secret: string) {
  return call('setWebhook', { url, secret_token: secret, allowed_updates: ['message', 'edited_message', 'channel_post', 'edited_channel_post'], drop_pending_updates: false });
}

export function deleteWebhook() {
  return call('deleteWebhook', { drop_pending_updates: false });
}

/** Outbound message send (reserved for later phases; RBAC-guarded at the route). */
export function sendMessage(chatId: string | number, text: string, replyToMessageId?: number, threadId?: number) {
  const payload: Record<string, unknown> = { chat_id: chatId, text: text.slice(0, 4096) };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  // One topic of a forum group.
  if (threadId) payload.message_thread_id = threadId;
  return call<{ message_id: number }>('sendMessage', payload);
}
