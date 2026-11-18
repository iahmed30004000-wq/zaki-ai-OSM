/**
 * TELEGRAM CONFIG — server-only access (mirrors whatsapp/config.ts).
 * Never imported by client code; never returns the raw token to callers
 * (only booleans / derived non-secret values to anything that reaches a screen). Fail closed.
 *
 * The bot token and the webhook secret come from `integration-settings.ts`: what was saved on «الإعدادات ← الربط» wins, and the
 * environment variable of the same name answers when nothing was saved (PR-C of the media buyer's doors). The base URLs are not secrets and stay in the environment.
 */
import { getSetting } from '../integration-settings';

export const getBotToken = (): Promise<string | null> => getSetting('TELEGRAM_BOT_TOKEN');

export const getWebhookSecret = (): Promise<string | null> => getSetting('TELEGRAM_WEBHOOK_SECRET');

export function getApiBaseUrl(): string {
  const base = process.env.TELEGRAM_API_BASE_URL;
  return base && base.trim() ? base.trim().replace(/\/+$/, '') : 'https://api.telegram.org';
}

/** Public app URL used to build the webhook URL (never hardcoded). */
export function getAppUrl(): string | null {
  const u =
    process.env.APP_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  return u && u.trim() ? u.trim().replace(/\/+$/, '') : null;
}

/** True when the bot token is present (sending + webhook registration possible). */
export async function botConfigured(): Promise<boolean> {
  return Boolean(await getBotToken());
}

/** True when the webhook secret is present (webhook verification possible). */
export async function webhookSecretConfigured(): Promise<boolean> {
  return Boolean(await getWebhookSecret());
}

export const WEBHOOK_PATH = '/api/webhooks/telegram';
