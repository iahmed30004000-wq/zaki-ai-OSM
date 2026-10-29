import { afterEach, describe, expect, it } from 'vitest';
import { MIN_ENCRYPTION_KEY_LENGTH, bootAlarms } from './boot-alarms';
import { encryptionAvailable } from './secrets';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A MISSING ENCRYPTION KEY LOCKS EVERYONE OUT — SO IT MUST BE SAID AT START.
 *
 * With the second factor on every role, no key means no 2FA secret can be
 * read and nobody signs in, while the sign-in page only shows a refusal.
 * These feed the check a deployment that is wrong, and one that is right,
 * and tie it to the rule `secrets.ts` really applies so the two cannot
 * drift apart.
 * ═══════════════════════════════════════════════════════════════════════
 */

const SAVED = { app: process.env.APP_ENCRYPTION_KEY, wa: process.env.WHATSAPP_ENCRYPTION_KEY };
afterEach(() => {
  if (SAVED.app === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = SAVED.app;
  if (SAVED.wa === undefined) delete process.env.WHATSAPP_ENCRYPTION_KEY;
  else process.env.WHATSAPP_ENCRYPTION_KEY = SAVED.wa;
});

describe('bootAlarms', () => {
  it('is silent for a real key (64 hex characters) and for a passphrase of the minimum length', () => {
    expect(bootAlarms({ APP_ENCRYPTION_KEY: 'a'.repeat(64) })).toEqual([]);
    expect(bootAlarms({ APP_ENCRYPTION_KEY: 'p'.repeat(MIN_ENCRYPTION_KEY_LENGTH) })).toEqual([]);
  });

  it('speaks when the key is absent or empty', () => {
    for (const env of [{}, { APP_ENCRYPTION_KEY: '' }, { APP_ENCRYPTION_KEY: undefined }]) {
      const alarms = bootAlarms(env);
      expect(alarms, JSON.stringify(env)).toHaveLength(1);
      expect(alarms[0]).toContain('APP_ENCRYPTION_KEY');
      expect(alarms[0]).toContain('تسجيل الدخول');
    }
  });

  it('speaks when the key is one character short', () => {
    const alarms = bootAlarms({ APP_ENCRYPTION_KEY: 'p'.repeat(MIN_ENCRYPTION_KEY_LENGTH - 1) });
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toContain(String(MIN_ENCRYPTION_KEY_LENGTH - 1));
  });

  it('accepts the old WhatsApp name, because secrets.ts still honours it', () => {
    expect(bootAlarms({ WHATSAPP_ENCRYPTION_KEY: 'w'.repeat(64) })).toEqual([]);
  });

  it('never prints the key', () => {
    const key = 'short-secret-value';
    expect(bootAlarms({ APP_ENCRYPTION_KEY: key }).join(' ')).not.toContain(key);
  });

  it('agrees with the rule the app really applies, for every length around the line', () => {
    delete process.env.WHATSAPP_ENCRYPTION_KEY;
    for (const n of [0, 1, 31, 32, 33, 64]) {
      const key = 'k'.repeat(n);
      process.env.APP_ENCRYPTION_KEY = key;
      expect(bootAlarms({ APP_ENCRYPTION_KEY: key }).length === 0, `length ${n}`).toBe(encryptionAvailable());
    }
  });
});

describe('and the worker really asks', () => {
  it('scripts/worker.ts calls bootAlarms on the continuous run', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync('scripts/worker.ts', 'utf8');
    expect(text).toMatch(/import \{ bootAlarms \} from '..\/src\/lib\/boot-alarms'/);
    expect(text).toMatch(/for \(const alarm of bootAlarms\(process\.env\)\)/);
  });
});
