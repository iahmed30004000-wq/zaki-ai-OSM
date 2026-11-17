import { db } from './db';
import { decryptSecret, encryptSecret, encryptionAvailable } from './secrets';

/**
 * THE BOTS' CONNECTION SETTINGS — entered on the site, the environment kept as the fallback (the media buyer's doors, PR-C).
 *
 * The owner's rule (17/11): every connection, token or bot setting is entered from inside the site, never Coolify. WhatsApp's and Telegram's values lived ONLY in the
 * server's environment; this is the one place that answers «what is `WHATSAPP_ACCESS_TOKEN` right now» for the whole codebase, and the answer is:
 *
 *   1. what was saved on «الإعدادات ← الربط» (a row of `integration_secrets`, sealed with the application's key), else
 *   2. the environment variable of the same name — exactly as before, so nothing that works today stops working the day this ships, else
 *   3. nothing: the setting is not configured, and the caller fails closed as it always did.
 *
 * ── WRITE-ONLY ──
 *
 * A value is never returned by any endpoint and never written to an audit row. What the screen gets is `settingsStatus()`: for each setting, WHERE it comes from
 * (the site, the environment, nowhere) and — for a saved one — its last four characters, so a person can tell which token is in there. Saving needs the application's
 * encryption key; without it a value is REFUSED, never stored in the clear under a name that says «encrypted».
 *
 * ── A DATABASE THAT CANNOT BE READ IS NOT A REASON TO STOP ──
 *
 * The webhooks of both bots must keep answering through a database blip, so a failed read falls back to the environment (logging the error's name only — never a
 * value). A row whose seal cannot be opened (the key changed) is the same: the environment answers, and the screen says the saved value is unreadable.
 *
 * ── NOT PER COMPANY ──
 *
 * The secrets that VERIFY a webhook (Meta's app secret, Telegram's secret token) must be known before the request says which company it is for — the same reason
 * they were environment variables. One value per setting name for the installation.
 */

export type IntegrationGroup = 'whatsapp' | 'telegram';

export interface IntegrationKeyInfo {
  key: string;
  group: IntegrationGroup;
  /** The label on the screen, in Arabic. */
  label: string;
  /** What to put in it. */
  help: string;
  /** The shape a value must have — a refusal names no part of it. */
  shape: RegExp;
  /** The words of the refusal when the shape does not fit. */
  shapeHint: string;
  /** The permission needed to save or clear it. */
  permission: 'whatsapp.manage' | 'telegram.connect';
}

/** A token or secret: no spaces, no control characters, not absurdly long. */
const TOKEN = /^[\x21-\x7e]{8,512}$/;
/** An id: digits. */
const ID = /^\d{5,25}$/;
const CHAT = /^-?\d{1,20}$/;

export const INTEGRATION_KEYS: readonly IntegrationKeyInfo[] = [
  { key: 'WHATSAPP_ACCESS_TOKEN', group: 'whatsapp', label: 'رمز الوصول (واتساب)', help: 'الرمز الدائم من Meta', shape: TOKEN, shapeHint: 'رمز بلا فراغات (8 خانات أو أكتر)', permission: 'whatsapp.manage' },
  { key: 'WHATSAPP_BUSINESS_ACCOUNT_ID', group: 'whatsapp', label: 'معرّف حساب واتساب للأعمال', help: 'WABA ID', shape: ID, shapeHint: 'أرقام بس', permission: 'whatsapp.manage' },
  { key: 'WHATSAPP_PHONE_NUMBER_ID', group: 'whatsapp', label: 'معرّف رقم الهاتف', help: 'Phone Number ID', shape: ID, shapeHint: 'أرقام بس', permission: 'whatsapp.manage' },
  { key: 'WHATSAPP_VERIFY_TOKEN', group: 'whatsapp', label: 'رمز التحقق للويبهوك', help: 'أي قيمة سرية من عندك، نفسها بإعدادات Meta', shape: TOKEN, shapeHint: 'رمز بلا فراغات (8 خانات أو أكتر)', permission: 'whatsapp.manage' },
  { key: 'WHATSAPP_APP_SECRET', group: 'whatsapp', label: 'App Secret من Meta', help: 'من إعدادات تطبيق Meta', shape: TOKEN, shapeHint: 'رمز بلا فراغات (8 خانات أو أكتر)', permission: 'whatsapp.manage' },
  { key: 'TELEGRAM_BOT_TOKEN', group: 'telegram', label: 'رمز البوت', help: 'من BotFather', shape: TOKEN, shapeHint: 'رمز بلا فراغات (8 خانات أو أكتر)', permission: 'telegram.connect' },
  { key: 'TELEGRAM_WEBHOOK_SECRET', group: 'telegram', label: 'السرّ السري للويبهوك', help: 'أي قيمة سرية من عندك (حروف وأرقام)', shape: /^[A-Za-z0-9_-]{8,256}$/, shapeHint: 'حروف إنجليزية وأرقام وشرطات (8 خانات أو أكتر)', permission: 'telegram.connect' },
  { key: 'TELEGRAM_OWNER_CHAT_ID', group: 'telegram', label: 'محادثة المالك الخاصة', help: 'رقم محادثتك مع البوت (لـ«اوقف» ولإشعارات المالك) — لازم تبعت للبوت رسالة أول', shape: CHAT, shapeHint: 'رقم المحادثة (أرقام، وممكن شرطة بالأول)', permission: 'telegram.connect' },
  { key: 'TELEGRAM_ALERT_CHAT_ID', group: 'telegram', label: 'محادثة تنبيهات النظام', help: 'المحادثة أو المجموعة اللي بتوصلها تنبيهات المهام', shape: CHAT, shapeHint: 'رقم المحادثة (أرقام، وممكن شرطة بالأول)', permission: 'telegram.connect' },
  { key: 'TELEGRAM_PEOPLE_CHATS', group: 'telegram', label: 'محادثات الفريق بالاسم', help: 'أزواج «اسم:رقم» مفصولة بفاصلة، مثلاً sara:123456,ahmad:-100789', shape: /^[a-z0-9_:,\s-]{3,1000}$/, shapeHint: 'اسم صغير إنجليزي ثم : ثم الرقم، مفصولة بفاصلة', permission: 'telegram.connect' },
] as const;

const BY_KEY = new Map(INTEGRATION_KEYS.map((k) => [k.key, k]));
export const integrationKeyInfo = (k: string): IntegrationKeyInfo | undefined => BY_KEY.get(k);

/**
 * How long what the SITE holds is remembered, so a webhook is not a database query per request. Only the site's value is remembered — the environment is read
 * fresh every time (it costs nothing and cannot go stale). A save or a clear forgets at once (in this process).
 */
export const CACHE_MS = 30_000;
const cache = new Map<string, { site: string | null; unreadable: boolean; at: number }>();
export const forgetIntegrationSettings = (): void => cache.clear();

const envValue = (key: string): string | null => {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : null;
};

/** Where a value is coming from right now. */
export type SettingSource = 'site' | 'env' | 'none';

/** What the site holds for this name (opened), whether a saved value could not be opened, and nothing about the environment. */
async function readSite(key: string, now: number): Promise<{ site: string | null; unreadable: boolean }> {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit;
  let out: { site: string | null; unreadable: boolean } = { site: null, unreadable: false };
  try {
    const row = await db.integrationSecret.findUnique({ where: { key }, select: { valueEncrypted: true } });
    if (row) {
      try {
        out = { site: decryptSecret(row.valueEncrypted), unreadable: false };
      } catch {
        // sealed with another key: the environment answers, and the screen says so
        out = { site: null, unreadable: true };
      }
    }
  } catch (e) {
    console.error('integration settings: could not read the table (the last known value, else the environment, answers):', (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'error');
    // A database that is down must not make a saved chat id or token vanish: the alert about the broken system is the very thing that needs them.
    if (hit) return hit;
  }
  cache.set(key, { ...out, at: now });
  return out;
}

/** The setting's value: the site's, else the environment's, else null. Never throws. */
export async function getSetting(key: string, now: number = Date.now()): Promise<string | null> {
  const { site } = await readSite(key, now);
  return site ?? envValue(key);
}

export interface SettingStatus {
  key: string;
  group: IntegrationGroup;
  label: string;
  help: string;
  source: SettingSource;
  /** The last four characters of a value saved on the site; null otherwise. */
  hint: string | null;
  /** The environment has one too (it answers only when nothing is saved on the site). */
  envSet: boolean;
  /** A value is saved on the site but cannot be opened (the application's key changed). */
  unreadable: boolean;
  /** Who may save or clear it. */
  permission: string;
}

/** Where every setting comes from and which four characters are saved — never a value. */
export async function settingsStatus(): Promise<SettingStatus[]> {
  let rows: { key: string; hint: string; valueEncrypted: string }[] = [];
  try {
    rows = await db.integrationSecret.findMany({ select: { key: true, hint: true, valueEncrypted: true } });
  } catch (e) {
    console.error('integration settings: could not read the table:', (e as { code?: unknown })?.code ?? (e as Error)?.name ?? 'error');
  }
  const saved = new Map(rows.map((r) => [r.key, r]));
  return INTEGRATION_KEYS.map((k) => {
    const row = saved.get(k.key);
    let unreadable = false;
    if (row) {
      try {
        decryptSecret(row.valueEncrypted);
      } catch {
        unreadable = true;
      }
    }
    const env = envValue(k.key);
    const source: SettingSource = row && !unreadable ? 'site' : env ? 'env' : 'none';
    return {
      key: k.key,
      group: k.group,
      label: k.label,
      help: k.help,
      source,
      hint: row ? row.hint : null,
      envSet: env !== null,
      unreadable,
      permission: k.permission,
    };
  });
}

export type SaveResult = { ok: true; hint: string } | { ok: false; code: 'UNKNOWN_KEY' | 'BAD_SHAPE' | 'NO_ENCRYPTION_KEY'; message: string };

/** The last four characters, the only part of a saved value that is ever shown. */
export const hintOf = (value: string): string => value.slice(-4);

/** Save one setting, sealed. A value of the wrong shape, an unknown name, or no encryption key is refused and nothing is written. */
export async function saveSetting(key: string, raw: string, userId: string | null): Promise<SaveResult> {
  const info = BY_KEY.get(key);
  if (!info) return { ok: false, code: 'UNKNOWN_KEY', message: 'إعداد غير معروف' };
  const value = raw.trim();
  if (!info.shape.test(value)) return { ok: false, code: 'BAD_SHAPE', message: `القيمة مش بالشكل المطلوب: ${info.shapeHint}` };
  if (!encryptionAvailable()) {
    return { ok: false, code: 'NO_ENCRYPTION_KEY', message: 'مفتاح التشفير (APP_ENCRYPTION_KEY) غير مُهيّأ على الخادم — ما بنحفظ قيمة بلا تشفير.' };
  }
  const hint = hintOf(value);
  const valueEncrypted = encryptSecret(value);
  await db.integrationSecret.upsert({
    where: { key },
    create: { key, valueEncrypted, hint, updatedById: userId },
    update: { valueEncrypted, hint, updatedById: userId },
  });
  forgetIntegrationSettings();
  return { ok: true, hint };
}

/** Remove what was saved on the site; the environment variable, if any, answers again. Returns whether a row was there. */
export async function clearSetting(key: string): Promise<boolean> {
  if (!BY_KEY.has(key)) return false;
  const done = await db.integrationSecret.deleteMany({ where: { key } });
  forgetIntegrationSettings();
  return done.count > 0;
}
