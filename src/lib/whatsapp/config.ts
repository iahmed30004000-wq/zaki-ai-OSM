/**
 * WHATSAPP CONFIG — server-only access to the connection's settings. This module must NEVER be
 * imported by client code and must never return the raw token to callers
 * (only booleans/derived values to anything that reaches a screen). Fail closed: missing
 * values are reported as "not configured" — no secrets and no silent fallbacks.
 *
 * Every value comes from `integration-settings.ts`: what was saved on «الإعدادات ← الربط» wins, and the
 * environment variable of the same name answers when nothing was saved (PR-C of the media buyer's doors; the
 * owner's rule: connection settings are entered on the site, never in Coolify). The names did not change,
 * so a deployment that has them in its environment keeps working untouched.
 */
import { getSetting } from '../integration-settings';

export const getAccessToken = (): Promise<string | null> => getSetting('WHATSAPP_ACCESS_TOKEN');
export const getWabaId = (): Promise<string | null> => getSetting('WHATSAPP_BUSINESS_ACCOUNT_ID');
export const getPhoneNumberId = (): Promise<string | null> => getSetting('WHATSAPP_PHONE_NUMBER_ID');
export const getVerifyToken = (): Promise<string | null> => getSetting('WHATSAPP_VERIFY_TOKEN');
export const getAppSecret = (): Promise<string | null> => getSetting('WHATSAPP_APP_SECRET');

/** True when every value required for sending/receiving is present (saved on the site or in the environment). */
export async function envConfigured(): Promise<boolean> {
  const [token, waba, phone, secret] = await Promise.all([getAccessToken(), getWabaId(), getPhoneNumberId(), getAppSecret()]);
  return Boolean(token && waba && phone && secret);
}

/** True when the webhook can be verified (verify token + app secret). */
export async function webhookConfigured(): Promise<boolean> {
  const [verify, secret] = await Promise.all([getVerifyToken(), getAppSecret()]);
  return Boolean(verify && secret);
}

export const GRAPH_BASE = 'https://graph.facebook.com';
export const GRAPH_VERSION = 'v21.0';
