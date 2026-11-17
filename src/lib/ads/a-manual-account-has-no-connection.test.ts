import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../guard-source';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * A MANUAL AD ACCOUNT HAS NO TOKEN, AND NOTHING EVER ASKS IT FOR ONE.
 *
 * The owner, 21/10: «اوتوماتيك او ادخال يدوي بالكامل. اريد الخيارين». The
 * second way is an ad account with NO connection: a name, a platform,
 * optionally the platform's own id. What can go wrong with it is not that it
 * fails to save — it is that something treats it as the first kind:
 *
 *   • the nightly sync decrypts a token it does not have and throws inside a
 *     loop whose whole point is that one account must not stop the others;
 *   • the import calls a platform that is not there;
 *   • a row ends up holding a token AND saying it is manual, which is a
 *     secret nobody will ever remember to rotate;
 *   • or the reverse — «connected» with nothing to connect with, which is the
 *     state the sync will try to read at 3am.
 *
 * So the claims are about the PAIRING (a database CHECK, modelled here and
 * read from the migration), about what is allowed to touch a manual account
 * (nothing that calls out), and about the closed list of places that decrypt
 * a token — a new caller fails this file until somebody has decided what it
 * does with a manual account.
 * ═══════════════════════════════════════════════════════════════════════
 */

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), 'utf8');

import {
  DISCONNECTED,
  MANUAL_ID_PREFIX,
  MANUAL_STATUS,
  WITH_A_PLATFORM,
  isMadeUpAccountId,
  isManualAccount,
  newManualAccountId,
  switchedToManualMessage,
} from './manual';

// ───────────────────────── the helpers ─────────────────────────

describe('what a manual account is, written once', () => {
  it('— is the status MANUAL and nothing else', () => {
    expect(MANUAL_STATUS).toBe('MANUAL');
    expect(isManualAccount({ status: 'MANUAL' })).toBe(true);
    for (const s of ['CONNECTED', 'ERROR', '', 'manual']) {
      expect(isManualAccount({ status: s }), s).toBe(false);
    }
  });

  it('and the fragment a sync may use asks for everything that is NOT manual', () => {
    expect(WITH_A_PLATFORM).toEqual({ status: { not: 'MANUAL' } });
  });

  it('and an account that stops being connected loses its token, its hint and its error', () => {
    expect(DISCONNECTED).toEqual({ tokenEncrypted: null, tokenHint: null, status: 'MANUAL', lastError: null });
  });

  it('and an id made for an account without one says what it is and does not repeat', () => {
    const ids = Array.from({ length: 300 }, () => newManualAccountId());
    for (const id of ids) {
      expect(id).toMatch(new RegExp(`^${MANUAL_ID_PREFIX}[0-9a-f]{8}$`));
      expect(isMadeUpAccountId(id)).toBe(true);
    }
    expect(new Set(ids).size, 'رقمان متطابقان').toBe(ids.length);
    // …and it never looks like a platform's own, which somebody could paste into Ads Manager.
    expect(ids.some((i) => /^act_/.test(i))).toBe(false);
    expect(isMadeUpAccountId('act_1234567890')).toBe(false);
  });

  it('and the sentence after switching says what happened to the campaigns and to the money', () => {
    expect(switchedToManualMessage(0)).toBe('صار الحساب يدوياً: حُذف الرمز.');
    const three = switchedToManualMessage(3);
    expect(three).toContain('3 حملة');
    expect(three, 'الأرقام المسحوبة هي مصروف حقيقي').toContain('مصروف حقيقي');
  });

  it('and the module has no `node:` import, because a client component asks it the same question', () => {
    const src = stripComments(read('src/lib/ads/manual.ts'));
    expect(src).not.toMatch(/from\s+['"]node:/);
    expect(src).not.toMatch(/\brequire\(/);
  });
});

// ───────────────────────── the pairing the database holds ─────────────────────────

/** The CHECK in the migration, as a function: manual ⟺ no token. */
const checkHolds = (row: { status: string; tokenEncrypted: string | null }) =>
  (row.status === 'MANUAL') === (row.tokenEncrypted === null);

describe('the status and the token cannot disagree', () => {
  it('— the whole truth table: only «manual, no token» and «not manual, a token» are rows', () => {
    const table: [string, string | null, boolean][] = [
      ['MANUAL', null, true],
      ['MANUAL', 'enc', false],
      ['CONNECTED', 'enc', true],
      ['CONNECTED', null, false],
      ['ERROR', 'enc', true],
      ['ERROR', null, false],
    ];
    for (const [status, tokenEncrypted, ok] of table) {
      expect(checkHolds({ status, tokenEncrypted }), `${status} / ${tokenEncrypted}`).toBe(ok);
    }
  });

  it('and what a switch writes is a row the CHECK accepts', () => {
    expect(checkHolds(DISCONNECTED)).toBe(true);
  });

  it('and the migration really says so, and writes nothing', () => {
    const sql = read('prisma/migrations/20261021100000_ad_account_can_be_manual/migration.sql');
    const code = sql
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(code).toContain('ALTER COLUMN "token_encrypted" DROP NOT NULL');
    expect(code.replace(/\s+/g, ' ')).toContain(`CHECK (("status" = 'MANUAL') = ("token_encrypted" IS NULL))`);
    // A relaxation and a constraint — no row is written, none is removed.
    expect(code, 'الهجرة تكتب بيانات').not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(code, 'الهجرة تحذف').not.toMatch(/\bDROP\s+(COLUMN|TABLE)\b/i);
  });

  it('and the schema lets the token be empty, and says when', () => {
    const schema = read('prisma/schema.prisma');
    const model = schema.slice(schema.indexOf('model AdAccount {'), schema.indexOf('@@map("ad_accounts")'));
    expect(model).toMatch(/tokenEncrypted\s+String\?\s+@map\("token_encrypted"\)/);
    expect(model).toContain('CONNECTED | ERROR | MANUAL');
  });
});

// ───────────────────────── nothing that calls out may touch one ─────────────────────────

const { db, fetchSpend, listCampaigns, readCredentials } = vi.hoisted(() => ({
  db: {
    adAccount: { findMany: vi.fn(), update: vi.fn() },
    campaign: { findMany: vi.fn(), update: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
  },
  fetchSpend: vi.fn(),
  listCampaigns: vi.fn(),
  readCredentials: vi.fn(),
}));

vi.mock('../db', () => ({ db }));
vi.mock('./index', async (original) => {
  const real = await original<typeof import('./index')>();
  return {
    ...real,
    readCredentials: (...a: unknown[]) => readCredentials(...a),
    adapterFor: () => ({
      platform: 'META',
      fetchSpend: (...a: unknown[]) => fetchSpend(...a),
      listCampaigns: (...a: unknown[]) => listCampaigns(...a),
      explainError: (e: unknown) => String(e),
    }),
  };
});

import { syncAdSpend } from './sync';
import { importRemoteCampaigns } from './import';

beforeEach(() => {
  vi.resetAllMocks();
  db.adAccount.findMany.mockResolvedValue([]);
});

describe('the nightly sync and the import', () => {
  const scope = { companyId: 'co', storeId: 'st', createdById: 'u' };

  it('— ask only for accounts that have a platform, so a manual one never leaves the database', async () => {
    await syncAdSpend(scope);
    await importRemoteCampaigns(scope);
    expect(db.adAccount.findMany).toHaveBeenCalledTimes(2);
    for (const [arg] of db.adAccount.findMany.mock.calls) {
      expect(arg.where, JSON.stringify(arg.where)).toMatchObject({ status: { not: 'MANUAL' } });
      // …in the shop being synced, as before.
      expect(arg.where).toMatchObject({ companyId: 'co' });
    }
  });

  it('and if a connected account somehow has no token, they say so on the screen and call nobody', async () => {
    // The CHECK makes this impossible; this is the compiler’s half of the same fact.
    const broken = {
      id: 'a1', platform: 'META', accountId: 'act_1', accountName: 'بلا رمز', tokenEncrypted: null, storeId: 'st',
      campaigns: [{ id: 'c1', name: 'x', externalId: 'ext', startDate: new Date('2026-10-01'), endDate: null, spend: 0 }],
    };
    db.adAccount.findMany.mockResolvedValue([broken]);

    const synced = await syncAdSpend(scope);
    expect(synced.accounts).toEqual([{ account: 'بلا رمز', updated: 0, error: expect.stringContaining('لا رمز') }]);

    const imported = await importRemoteCampaigns(scope);
    expect(imported.accounts[0]).toMatchObject({ account: 'بلا رمز', created: [], error: expect.stringContaining('لا رمز') });

    expect(readCredentials, 'فكّ رمز غير موجود').not.toHaveBeenCalled();
    expect(fetchSpend).not.toHaveBeenCalled();
    expect(listCampaigns).not.toHaveBeenCalled();
    // …and a campaign was not touched either.
    expect(db.campaign.update).not.toHaveBeenCalled();
    expect(db.campaign.create).not.toHaveBeenCalled();
  });

  it('and one account without a token does not stop the account after it', async () => {
    const good = {
      id: 'a2', platform: 'META', accountId: 'act_2', accountName: 'سليم', tokenEncrypted: 'enc', storeId: 'st',
      campaigns: [{ id: 'c2', name: 'y', externalId: 'ext2', startDate: new Date('2026-10-01'), endDate: null, spend: 0 }],
    };
    const broken = { ...good, id: 'a1', accountId: 'act_1', accountName: 'بلا رمز', tokenEncrypted: null };
    db.adAccount.findMany.mockResolvedValue([broken, good]);
    readCredentials.mockReturnValue({ token: 't' });
    fetchSpend.mockResolvedValue([{ campaignId: 'ext2', spend: 12.5 }]);

    const result = await syncAdSpend(scope);
    expect(result.accounts.map((a) => a.account)).toEqual(['بلا رمز', 'سليم']);
    expect(result.accounts[0].error).toBeTruthy();
    expect(result.accounts[1]).toMatchObject({ updated: 1, error: null });
    expect(fetchSpend).toHaveBeenCalledTimes(1);
  });
});

// ───────────────────────── the closed list of those who decrypt a token ─────────────────────────

describe('who may decrypt an ad account’s token', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((e) => {
      const full = join(dir, e);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const callers = walk(join(root, 'src'))
    .filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f))
    .filter((f) => /\breadCredentials\(/.test(stripComments(readFileSync(f, 'utf8'))))
    .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'))
    .sort();

  it('— exactly the four that exist, and the definition', () => {
    /*
     * A closed list, like «nothing-unused-ships». A fourth caller is not
     * forbidden — it is a decision: what does it do with a MANUAL account,
     * which has no token to decrypt? Add it here once that has an answer.
     */
    expect(callers).toEqual([
      'src/app/api/settings/ad-accounts/[id]/route.ts',
      // The per-ad, per-day spend pull (PR-A of the media buyer's doors): carries WITH_A_PLATFORM and skips an account with no token.
      'src/lib/ads/daily.ts',
      'src/lib/ads/import.ts',
      'src/lib/ads/index.ts',
      'src/lib/ads/sync.ts',
    ]);
  });

  it('and each caller says what it does with a manual account', () => {
    for (const f of ['src/lib/ads/sync.ts', 'src/lib/ads/import.ts', 'src/lib/ads/daily.ts']) {
      expect(stripComments(read(f)), f).toContain('...WITH_A_PLATFORM');
    }
    const route = stripComments(read('src/app/api/settings/ad-accounts/[id]/route.ts'));
    // The listing refuses a manual account BEFORE the adapter is looked up and
    // before the token is read: the guard comes first in the source.
    const guard = route.indexOf('isManualAccount(account) || !account.tokenEncrypted');
    const read1 = route.indexOf('readCredentials(account.tokenEncrypted)');
    expect(guard, 'ما في حارس').toBeGreaterThan(-1);
    expect(read1, 'ما في فكّ للرمز').toBeGreaterThan(-1);
    expect(guard, 'الحارس بعد فكّ الرمز').toBeLessThan(read1);
  });
});
