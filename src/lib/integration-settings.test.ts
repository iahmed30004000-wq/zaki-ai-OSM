import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BOTS' CONNECTION SETTINGS, ENTERED ON THE SITE (the media buyer's doors, PR-C) — what `getSetting` answers, what `settingsStatus` may say, and what a save refuses.
 * The table is a double (in memory); the sealing is the real one.
 */

const h = vi.hoisted(() => ({
  rows: new Map<string, { key: string; valueEncrypted: string; hint: string; updatedById: string | null }>(),
  db: {
    integrationSecret: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db: h.db }));

import {
  CACHE_MS,
  INTEGRATION_KEYS,
  clearSetting,
  forgetIntegrationSettings,
  getSetting,
  hintOf,
  integrationKeyInfo,
  saveSetting,
  settingsStatus,
} from './integration-settings';
import { verifyMetaSignature } from './whatsapp/signature';
import { verifyTelegramSecret } from './telegram/signature';
import { getAccessToken, envConfigured, webhookConfigured } from './whatsapp/config';
import { botConfigured } from './telegram/config';
import { encryptSecret } from './secrets';
import { createHmac } from 'node:crypto';

const ENV = { ...process.env };
const KEY64 = 'cd'.repeat(32);

beforeEach(() => {
  vi.clearAllMocks();
  forgetIntegrationSettings();
  h.rows.clear();
  process.env = { ...ENV, APP_ENCRYPTION_KEY: KEY64 };
  for (const k of INTEGRATION_KEYS) delete process.env[k.key];
  h.db.integrationSecret.findUnique.mockImplementation(async ({ where }: { where: { key: string } }) => h.rows.get(where.key) ?? null);
  h.db.integrationSecret.findMany.mockImplementation(async () => [...h.rows.values()]);
  h.db.integrationSecret.upsert.mockImplementation(async ({ where, create, update }: { where: { key: string }; create: never; update: never }) => {
    const prev = h.rows.get(where.key);
    h.rows.set(where.key, { ...(prev ?? (create as object)), ...(prev ? (update as object) : {}) } as never);
    return {};
  });
  h.db.integrationSecret.deleteMany.mockImplementation(async ({ where }: { where: { key: string } }) => ({ count: h.rows.delete(where.key) ? 1 : 0 }));
});

afterEach(() => {
  process.env = { ...ENV };
});

const site = (key: string, value: string) => h.rows.set(key, { key, valueEncrypted: encryptSecret(value), hint: hintOf(value), updatedById: 'u1' });

describe('what a setting is right now', () => {
  it('what was saved on the site wins over the environment', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = 'from-the-environment-0001';
    site('WHATSAPP_ACCESS_TOKEN', 'from-the-site-0002');
    expect(await getAccessToken()).toBe('from-the-site-0002');
  });

  it('with nothing saved the environment answers, exactly as before — so shipping this changes nothing that works today', async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = '  from-the-environment-0001  ';
    expect(await getAccessToken()).toBe('from-the-environment-0001');
    expect(await botConfigured()).toBe(false);
    process.env.TELEGRAM_BOT_TOKEN = '123456:ABCDEFGH';
    expect(await botConfigured()).toBe(true);
  });

  it('with neither, it is not configured: null, never a guess', async () => {
    expect(await getSetting('WHATSAPP_ACCESS_TOKEN')).toBeNull();
    expect(await envConfigured()).toBe(false);
    expect(await webhookConfigured()).toBe(false);
  });

  it('«configured» counts the site’s values: all four on the site is configured with an empty environment', async () => {
    site('WHATSAPP_ACCESS_TOKEN', 'token-token-0001');
    site('WHATSAPP_BUSINESS_ACCOUNT_ID', '123456789');
    site('WHATSAPP_PHONE_NUMBER_ID', '987654321');
    site('WHATSAPP_APP_SECRET', 'secret-secret-01');
    expect(await envConfigured()).toBe(true);
    expect(await webhookConfigured()).toBe(false); // no verify token yet
    site('WHATSAPP_VERIFY_TOKEN', 'verify-verify-01');
    forgetIntegrationSettings(); // the row went in behind the module's back; a real save forgets by itself
    expect(await webhookConfigured()).toBe(true);
  });

  it('the site’s value is remembered for 30 seconds — a webhook is not a query per request — and a save forgets it at once', async () => {
    site('TELEGRAM_BOT_TOKEN', 'bot-token-0001');
    const t0 = 1_000_000;
    await getSetting('TELEGRAM_BOT_TOKEN', t0);
    await getSetting('TELEGRAM_BOT_TOKEN', t0 + CACHE_MS - 1);
    expect(h.db.integrationSecret.findUnique).toHaveBeenCalledTimes(1);
    await getSetting('TELEGRAM_BOT_TOKEN', t0 + CACHE_MS + 1);
    expect(h.db.integrationSecret.findUnique).toHaveBeenCalledTimes(2);
    expect((await saveSetting('TELEGRAM_BOT_TOKEN', 'bot-token-0002', 'u1')).ok).toBe(true);
    expect(await getSetting('TELEGRAM_BOT_TOKEN', t0 + CACHE_MS + 2)).toBe('bot-token-0002');
  });

  it('only the SITE’s value is remembered: the environment is read fresh, so it can never be stale', async () => {
    expect(await getSetting('TELEGRAM_BOT_TOKEN', 1)).toBeNull();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token-from-env';
    expect(await getSetting('TELEGRAM_BOT_TOKEN', 2)).toBe('bot-token-from-env');
  });
});

describe('a database that cannot be read, a seal that cannot be opened', () => {
  it('a failed read falls back to the environment — the webhooks keep answering — and logs the error’s code, never a value', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.TELEGRAM_WEBHOOK_SECRET = 'env-webhook-secret';
    h.db.integrationSecret.findUnique.mockRejectedValue(Object.assign(new Error('could not connect with secret env-webhook-secret'), { code: 'P1001' }));
    expect(await getSetting('TELEGRAM_WEBHOOK_SECRET')).toBe('env-webhook-secret');
    expect(JSON.stringify(log.mock.calls)).toContain('P1001');
    expect(JSON.stringify(log.mock.calls)).not.toContain('env-webhook-secret');
    log.mockRestore();
  });

  it('and through an outage the LAST value the process knew is kept — the alert about a broken system must still find its chat', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    site('TELEGRAM_ALERT_CHAT_ID', '-100555');
    expect(await getSetting('TELEGRAM_ALERT_CHAT_ID', 1_000)).toBe('-100555');
    h.db.integrationSecret.findUnique.mockRejectedValue(new Error('db down'));
    expect(await getSetting('TELEGRAM_ALERT_CHAT_ID', 1_000 + CACHE_MS + 5_000)).toBe('-100555');
    log.mockRestore();
  });

  it('a value sealed with another key cannot be opened: the environment answers, and the status says so', async () => {
    h.rows.set('WHATSAPP_APP_SECRET', { key: 'WHATSAPP_APP_SECRET', valueEncrypted: 'v1:not-a-real-seal', hint: 'cret', updatedById: null });
    process.env.WHATSAPP_APP_SECRET = 'env-app-secret-1';
    expect(await getSetting('WHATSAPP_APP_SECRET')).toBe('env-app-secret-1');
    const s = (await settingsStatus()).find((x) => x.key === 'WHATSAPP_APP_SECRET')!;
    expect(s).toMatchObject({ source: 'env', unreadable: true, envSet: true });
  });
});

describe('what the screen may be told — never a value', () => {
  it('says where each setting comes from and, for a saved one, its last four characters — and nothing else', async () => {
    site('WHATSAPP_ACCESS_TOKEN', 'EAAGsecrettoken1234');
    process.env.TELEGRAM_BOT_TOKEN = '123456:SECRETSECRET';
    const all = await settingsStatus();
    expect(all).toHaveLength(INTEGRATION_KEYS.length);
    const wa = all.find((s) => s.key === 'WHATSAPP_ACCESS_TOKEN')!;
    expect(wa).toMatchObject({ source: 'site', hint: '1234', envSet: false, unreadable: false });
    expect(all.find((s) => s.key === 'TELEGRAM_BOT_TOKEN')).toMatchObject({ source: 'env', hint: null, envSet: true });
    expect(all.find((s) => s.key === 'WHATSAPP_VERIFY_TOKEN')).toMatchObject({ source: 'none', hint: null, envSet: false });
    const text = JSON.stringify(all);
    expect(text).not.toContain('EAAGsecrettoken1234');
    expect(text).not.toContain('SECRETSECRET');
    expect(text).not.toContain('valueEncrypted');
  });

  it('every setting names the permission of its own card: WhatsApp’s need whatsapp.manage, Telegram’s telegram.connect', () => {
    for (const k of INTEGRATION_KEYS) expect(k.permission).toBe(k.group === 'whatsapp' ? 'whatsapp.manage' : 'telegram.connect');
    expect(INTEGRATION_KEYS.map((k) => k.key)).toEqual([
      'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_BUSINESS_ACCOUNT_ID', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET',
      'TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'TELEGRAM_OWNER_CHAT_ID', 'TELEGRAM_ALERT_CHAT_ID', 'TELEGRAM_PEOPLE_CHATS',
    ]);
  });
});

describe('saving', () => {
  it('seals the value: what reaches the table is not the value, only its last four characters are kept in the clear', async () => {
    const out = await saveSetting('WHATSAPP_ACCESS_TOKEN', '  EAAGsecrettoken1234  ', 'u7');
    expect(out).toEqual({ ok: true, hint: '1234' });
    const row = h.rows.get('WHATSAPP_ACCESS_TOKEN')!;
    expect(row.valueEncrypted).not.toContain('EAAGsecrettoken1234');
    expect(row.hint).toBe('1234');
    expect(row.updatedById).toBe('u7');
    expect(await getSetting('WHATSAPP_ACCESS_TOKEN')).toBe('EAAGsecrettoken1234');
  });

  it('a second save replaces the first (one row per name)', async () => {
    await saveSetting('TELEGRAM_BOT_TOKEN', 'first-token-0001', 'u1');
    await saveSetting('TELEGRAM_BOT_TOKEN', 'second-token-0002', 'u1');
    expect(h.rows.size).toBe(1);
    expect(h.rows.get('TELEGRAM_BOT_TOKEN')!.hint).toBe('0002');
  });

  it('a value of the wrong shape, or an unknown name, is refused — and nothing is written, nothing is echoed', async () => {
    for (const [key, value] of [
      ['WHATSAPP_PHONE_NUMBER_ID', 'not-digits'],
      ['TELEGRAM_OWNER_CHAT_ID', 'abc'],
      ['TELEGRAM_BOT_TOKEN', 'has a space inside it 123'],
      ['WHATSAPP_ACCESS_TOKEN', 'short'],
      ['TELEGRAM_WEBHOOK_SECRET', 'bad!chars#here'],
      ['TELEGRAM_PEOPLE_CHATS', 'Sara:12'],
    ] as const) {
      const out = await saveSetting(key, value, 'u1');
      expect(out.ok, `${key}=${value}`).toBe(false);
      if (!out.ok) expect(out.message).not.toContain(value);
    }
    const unknown = await saveSetting('DATABASE_URL', 'postgres://whatever-1234', 'u1');
    expect(unknown).toMatchObject({ ok: false, code: 'UNKNOWN_KEY' });
    expect(h.db.integrationSecret.upsert).not.toHaveBeenCalled();
  });

  it('without the application’s encryption key a value is REFUSED, never stored in the clear under a name that says encrypted', async () => {
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.WHATSAPP_ENCRYPTION_KEY;
    const out = await saveSetting('WHATSAPP_ACCESS_TOKEN', 'EAAGsecrettoken1234', 'u1');
    expect(out).toMatchObject({ ok: false, code: 'NO_ENCRYPTION_KEY' });
    expect(h.db.integrationSecret.upsert).not.toHaveBeenCalled();
  });

  it('accepts the shapes of the real values: ids, chat ids (a group’s is negative), the team list, a forum chat', async () => {
    for (const [key, value] of [
      ['WHATSAPP_PHONE_NUMBER_ID', '109876543210987'],
      ['WHATSAPP_BUSINESS_ACCOUNT_ID', '123456789012345'],
      ['TELEGRAM_OWNER_CHAT_ID', '111222333'],
      ['TELEGRAM_ALERT_CHAT_ID', '-1001234567890'],
      ['TELEGRAM_PEOPLE_CHATS', 'sara:123456,ahmad:-100789'],
      ['TELEGRAM_WEBHOOK_SECRET', 'My_Secret-Token_123'],
      ['TELEGRAM_BOT_TOKEN', '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'],
    ] as const) {
      expect((await saveSetting(key, value, 'u1')).ok, key).toBe(true);
    }
  });
});

describe('clearing', () => {
  it('removes what the site holds, and the environment answers again', async () => {
    process.env.TELEGRAM_BOT_TOKEN = 'env-bot-token-1';
    await saveSetting('TELEGRAM_BOT_TOKEN', 'site-bot-token-1', 'u1');
    expect(await getSetting('TELEGRAM_BOT_TOKEN')).toBe('site-bot-token-1');
    expect(await clearSetting('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(await getSetting('TELEGRAM_BOT_TOKEN')).toBe('env-bot-token-1');
    expect(await clearSetting('TELEGRAM_BOT_TOKEN')).toBe(false);
  });

  it('an unknown name clears nothing', async () => {
    expect(await clearSetting('DATABASE_URL')).toBe(false);
    expect(h.db.integrationSecret.deleteMany).not.toHaveBeenCalled();
    expect(integrationKeyInfo('DATABASE_URL')).toBeUndefined();
  });
});

describe('the webhooks verify with what the site holds', () => {
  it('Meta’s signature is checked against the app secret saved on the site, with the environment empty', async () => {
    site('WHATSAPP_APP_SECRET', 'site-app-secret-12345');
    const body = '{"entry":[]}';
    const good = 'sha256=' + createHmac('sha256', 'site-app-secret-12345').update(body, 'utf8').digest('hex');
    expect(await verifyMetaSignature(body, good)).toBe(true);
    expect(await verifyMetaSignature(body, good.replace(/.$/, '0'))).toBe(false);
    expect(await verifyMetaSignature(`${body} `, good)).toBe(false);
  });

  it('Telegram’s secret token is checked against the one saved on the site', async () => {
    site('TELEGRAM_WEBHOOK_SECRET', 'site-hook-secret-1');
    expect(await verifyTelegramSecret('site-hook-secret-1')).toBe(true);
    expect(await verifyTelegramSecret('site-hook-secret-2')).toBe(false);
    expect(await verifyTelegramSecret(null)).toBe(false);
  });

  it('and with nothing anywhere both FAIL CLOSED', async () => {
    expect(await verifyMetaSignature('{}', 'sha256=' + createHmac('sha256', '').update('{}').digest('hex'))).toBe(false);
    expect(await verifyTelegramSecret('')).toBe(false);
    expect(await verifyTelegramSecret('anything')).toBe(false);
  });
});
