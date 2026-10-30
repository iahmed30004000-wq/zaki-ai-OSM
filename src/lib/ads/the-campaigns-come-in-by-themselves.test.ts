import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '../guard-source';
import { adTime } from './types';

/**
 * «ما بقدر اربط الحساب الاعلاني … يسحب منو الداتا تبع الحملات»
 *
 * BEFORE THIS, THE SYNC COULD ONLY SEE WHAT SOMEBODY HAD ALREADY TYPED.
 * `syncAdSpend` reads `account.campaigns` filtered to
 * `externalId: { not: null }` — campaigns created HERE by hand and then
 * matched to a remote one by pasting its id. A shop running fourteen
 * campaigns typed fourteen rows and pasted fourteen ids before one figure
 * arrived, and the fifteenth — made in Ads Manager on a Tuesday — was
 * invisible until somebody remembered it.
 *
 * ── THE DECISION THAT MATTERS MOST, AND IT IS A RESTRAINT ──
 *
 * The importer CREATES what is missing and touches nothing that exists. An
 * importer that "kept things in step" would rename a seller's campaign
 * overnight because somebody edited it in Ads Manager, overwrite a product
 * they chose, and replace a spend they typed. Running it twice must change
 * nothing the second time, and that is tested rather than asserted.
 *
 * ── AND THE DATE IS NOT DECORATION ──
 *
 * `syncAdSpend` asks each platform for spend over the campaign's OWN
 * window, so the start date decides which money is attributed. Importing
 * everything as «today» would show a campaign that has run for a month
 * costing one day — and the profit beside it computed from that. So
 * `RemoteCampaign` gained `startedAt`, and all three adapters now ask the
 * platform for it.
 */

const root = process.cwd();
const read = (f: string) => readFileSync(join(root, f), 'utf8');

/* ── a database that remembers, and an adapter that never leaves the room ── */

interface Row {
  id: string;
  companyId: string;
  storeId: string;
  name: string;
  code: string;
  externalId: string | null;
  adAccountId: string | null;
  startDate: Date;
  status: string;
  spend: number;
  spendSource: string;
  productId: string | null;
  landingPageId: string | null;
}

const ACCOUNT = {
  id: 'acc-1',
  platform: 'META',
  accountId: 'act_1',
  accountName: 'حساب ميتا',
  tokenEncrypted: 'enc',
  storeId: 'store-1',
};

let rows: Row[] = [];
let accounts: (typeof ACCOUNT)[] = [];
let remote: { id: string; name: string; status: string; startedAt: Date | null }[] = [];
let listCalls = 0;
let accountPatches: { id: string; data: Record<string, unknown> }[] = [];
let listThrows: Error | null = null;

vi.mock('../db', () => ({
  db: {
    adAccount: {
      findMany: vi.fn(async () => accounts),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        accountPatches.push({ id: where.id, data });
        return {};
      }),
    },
    campaign: {
      findMany: vi.fn(async ({ where }: { where: { externalId?: { in: string[] }; storeId?: string } }) =>
        rows.filter(
          (r) =>
            (!where.storeId || r.storeId === where.storeId) &&
            (!where.externalId || (r.externalId !== null && where.externalId.in.includes(r.externalId)))
        )
      ),
      findFirst: vi.fn(async ({ where }: { where: { code?: string; companyId?: string; storeId?: string } }) =>
        rows.find(
          (r) => r.code === where.code && r.companyId === where.companyId && r.storeId === where.storeId
        ) ?? null
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `new-${rows.length + 1}`, ...data } as unknown as Row;
        rows.push(row);
        return row;
      }),
    },
  },
}));

vi.mock('./index', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readCredentials: () => ({ token: 't' }),
    adapterFor: (platform: string) =>
      platform === 'META'
        ? {
            platform: 'META',
            listCampaigns: async () => {
              listCalls++;
              if (listThrows) throw listThrows;
              return remote;
            },
            explainError: (e: unknown) => (e instanceof Error ? e.message : 'خطأ'),
          }
        : null,
  };
});

const { importRemoteCampaigns } = await import('./import');

const run = () =>
  importRemoteCampaigns({ companyId: 'co-1', storeId: 'store-1', createdById: 'user-1' });

beforeEach(() => {
  rows = [];
  accounts = [ACCOUNT];
  remote = [];
  listCalls = 0;
  accountPatches = [];
  listThrows = null;
});
afterEach(() => vi.clearAllMocks());

describe('Ⅰ · the campaigns arrive', () => {
  it('creates a row for every live remote campaign', async () => {
    remote = [
      { id: 'r1', name: 'كريم الشتاء', status: 'ACTIVE', startedAt: new Date('2026-09-01') },
      { id: 'r2', name: 'سيروم', status: 'PAUSED', startedAt: new Date('2026-09-20') },
    ];
    const result = await run();
    expect(result.created).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(['كريم الشتاء', 'سيروم']);
    expect(rows.map((r) => r.externalId)).toEqual(['r1', 'r2']);
  });

  it('and links each one to the account, so the next spend sync finds it', async () => {
    /*
     * The whole reason this matters: `syncAdSpend` reads
     * `account.campaigns` filtered to `externalId: { not: null }`. An
     * imported campaign with no `adAccountId` or no `externalId` would be
     * exactly as invisible as before.
     */
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: new Date('2026-09-01') }];
    await run();
    expect(rows[0].adAccountId).toBe('acc-1');
    expect(rows[0].externalId).toBe('r1');
    expect(rows[0].spendSource).toBe('SYNCED');
  });

  it('and claims nothing about the money', async () => {
    // The spend sync is what WITNESSES the cost. A figure invented here
    // would be a figure nobody measured.
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: null }];
    await run();
    expect(rows[0].spend).toBe(0);
  });

  it('and leaves the product unstated rather than guessed', async () => {
    /*
     * The platform cannot know which of OUR products an ad is for, and
     * guessing from a name would be a figure that looks measured and is
     * not. `campaignProductId` already treats null as a real answer.
     */
    remote = [{ id: 'r1', name: 'كريم الشتاء ٥٠ مل', status: 'ACTIVE', startedAt: null }];
    await run();
    expect(rows[0].productId).toBeNull();
    expect(rows[0].landingPageId).toBeNull();
  });

  it('and gives each one a code, because a code is stamped on its orders', async () => {
    remote = [
      { id: 'r1', name: 'أ', status: 'ACTIVE', startedAt: null },
      { id: 'r2', name: 'ب', status: 'ACTIVE', startedAt: null },
    ];
    await run();
    expect(rows[0].code).toMatch(/^[A-Z0-9]{6}$/);
    expect(rows[1].code).not.toBe(rows[0].code);
  });

  it('and truncates a name longer than the column', async () => {
    remote = [{ id: 'r1', name: 'ط'.repeat(200), status: 'ACTIVE', startedAt: null }];
    await run();
    expect(rows[0].name.length).toBe(80);
  });
});

describe('Ⅱ · running it twice changes nothing the second time', () => {
  it('skips what is already here, by external id', async () => {
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: new Date('2026-09-01') }];
    const first = await run();
    expect(first.created).toBe(1);

    const second = await run();
    expect(second.created, 'الاستيرادُ الثاني أنشأ صفّاً ثانياً').toBe(0);
    expect(rows.length).toBe(1);
    expect(second.accounts[0].existing).toBe(1);
  });

  it('and does not touch what it skipped', async () => {
    /*
     * THE RESTRAINT THIS WHOLE FEATURE TURNS ON. A seller renames the
     * campaign, picks a product, types a spend. The platform still calls it
     * something else. An importer that "kept things in step" would undo all
     * three overnight.
     */
    remote = [{ id: 'r1', name: 'اسم المنصّة', status: 'ACTIVE', startedAt: new Date('2026-09-01') }];
    await run();

    rows[0].name = 'الاسم الذي كتبه البائع';
    rows[0].productId = 'prod-7';
    rows[0].spend = 1250;
    rows[0].status = 'ENDED';

    remote = [{ id: 'r1', name: 'اسم المنصّة الجديد', status: 'PAUSED', startedAt: new Date('2026-10-01') }];
    await run();

    expect(rows[0].name).toBe('الاسم الذي كتبه البائع');
    expect(rows[0].productId).toBe('prod-7');
    expect(rows[0].spend).toBe(1250);
    expect(rows[0].status).toBe('ENDED');
  });

  it('and the lookup is by STORE, not by account — so a hand-matched row is not duplicated', async () => {
    /*
     * A campaign typed in by hand and matched to this remote id is already
     * ours even if it was never linked to the account. Asking per account
     * would import a duplicate of it.
     */
    rows.push({
      id: 'hand-1', companyId: 'co-1', storeId: 'store-1', name: 'كُتبت بيد',
      code: 'AAAAAA', externalId: 'r1', adAccountId: null,
      startDate: new Date('2026-08-01'), status: 'ACTIVE', spend: 500,
      spendSource: 'MANUAL', productId: null, landingPageId: null,
    });
    remote = [{ id: 'r1', name: 'نفسها على المنصّة', status: 'ACTIVE', startedAt: null }];

    const result = await run();
    expect(result.created).toBe(0);
    expect(rows.length).toBe(1);
  });
});

describe('Ⅲ · an account three years old does not bury the four that are running', () => {
  it('leaves anything that is not ACTIVE or PAUSED', async () => {
    /*
     * Ads Manager keeps deleted and archived campaigns forever. Importing
     * them would bury the live ones, and each would carry a code stamped
     * into our order numbering for a campaign that can never bring an
     * order. The adapters normalise to ACTIVE / PAUSED, so anything else
     * is a status none of them claims to produce.
     */
    remote = [
      { id: 'r1', name: 'حيّة', status: 'ACTIVE', startedAt: null },
      { id: 'r2', name: 'محذوفة', status: 'DELETED', startedAt: null },
      { id: 'r3', name: 'مؤرشفة', status: 'ARCHIVED', startedAt: null },
    ];
    const result = await run();
    expect(result.created).toBe(1);
    expect(result.accounts[0].skipped).toBe(2);
    expect(rows[0].name).toBe('حيّة');
  });

  it('and maps the two it keeps into our own vocabulary', async () => {
    remote = [
      { id: 'r1', name: 'أ', status: 'ACTIVE', startedAt: null },
      { id: 'r2', name: 'ب', status: 'PAUSED', startedAt: null },
    ];
    await run();
    expect(rows.map((r) => r.status)).toEqual(['ACTIVE', 'PAUSED']);
  });
});

describe('Ⅳ · the start date decides which money is attributed', () => {
  it('uses the platform’s own start time', async () => {
    const when = new Date('2026-09-01T10:00:00.000Z');
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: when }];
    await run();
    expect(rows[0].startDate).toEqual(when);
  });

  it('and falls back to today when the platform has none', async () => {
    /*
     * A draft that was never scheduled has spent nothing, so a window
     * beginning now reports nothing — which is correct. The WRONG fallback
     * would be an arbitrary date in the past, reporting the account's whole
     * history against one row.
     */
    const before = Date.now();
    remote = [{ id: 'r1', name: 'مسوّدة', status: 'PAUSED', startedAt: null }];
    await run();
    expect(rows[0].startDate.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('and `adTime` refuses a date it cannot read rather than writing an Invalid Date', () => {
    /*
     * An `Invalid Date` reaching a `DateTime` column is a write that throws
     * halfway through an import — some campaigns created, some not, and
     * nothing to say which without reading the rows. Same reason `money()`
     * returns 0 rather than NaN.
     */
    expect(adTime('2026-09-01T10:00:00+0300')?.toISOString()).toBe('2026-09-01T07:00:00.000Z');
    expect(adTime('2026-09-01T10:00:00.000Z')?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    // TikTok's shape: a space instead of a T.
    expect(adTime('2026-09-01 10:00:00')).toBeInstanceOf(Date);
    for (const bad of ['', '   ', 'not a date', null, undefined, 0, {}]) {
      expect(adTime(bad), String(bad)).toBeNull();
    }
  });
});

describe('Ⅴ · one account failing does not take the others down', () => {
  it('reports the platform’s own sentence and marks the account', async () => {
    listThrows = new Error('انتهت صلاحية الرمز');
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: null }];
    const result = await run();
    expect(result.created).toBe(0);
    expect(result.accounts[0].error).toBe('انتهت صلاحية الرمز');
    expect(accountPatches.at(-1)?.data.status).toBe('ERROR');
  });

  it('and a working account still imports when another fails', async () => {
    accounts = [ACCOUNT, { ...ACCOUNT, id: 'acc-2', platform: 'TIKTOK', accountName: 'تيك توك' }];
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: null }];
    const result = await run();
    // META works; TIKTOK has no adapter in this fake, which is its own
    // error line rather than the end of the loop.
    expect(result.created).toBe(1);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[1].error).toMatch(/منصة غير مدعومة/);
  });

  it('and marks a working account CONNECTED', async () => {
    remote = [{ id: 'r1', name: 'حملة', status: 'ACTIVE', startedAt: null }];
    await run();
    expect(accountPatches.at(-1)?.data).toEqual({ status: 'CONNECTED', lastError: null });
  });

  it('and says so plainly when no account is connected at all', async () => {
    accounts = [];
    const result = await run();
    expect(result.created).toBe(0);
    expect(result.message).toContain('لا حساب إعلاني مربوط');
    expect(listCalls, 'نادى المنصّةَ بلا حساب').toBe(0);
  });
});

describe('Ⅵ · all three adapters ask the platform for the start time', () => {
  /**
   * A WALK OVER THE ADAPTERS, not a list — the contract has the field, so
   * every adapter must fill it. An adapter returning `startedAt: undefined`
   * would compile (the field is `Date | null`, and `undefined` is not
   * assignable — so the compiler catches that one) but one returning a
   * hard-coded `null` while the platform offers the date would not, and
   * that is what this reads for.
   */
  /**
   * AND THE THREE APIS ASK DIFFERENTLY, so the assertion does too.
   *
   * MY FIRST VERSION HERE WAS A HOLE, and a mutation found it: it checked
   * that the file CONTAINED `start_time` anywhere. Removing `start_time`
   * from Meta's `fields` parameter left the word in the response type and
   * in `adTime(c.start_time)`, so the test stayed green while Meta stopped
   * sending the date at all — and every imported Meta campaign would have
   * started «today».
   *
   * Meta takes an explicit `fields` list, so the assertion is on THAT
   * string. TikTok and Snapchat return their campaign objects whole with no
   * field selection, so for those the honest check is that the response
   * type declares it and `adTime` reads it.
   */
  const ADAPTERS: { file: string; requested: RegExp; read: RegExp }[] = [
    {
      file: 'src/lib/ads/meta.ts',
      // The `fields` parameter itself — nothing else makes Meta send it.
      requested: /fields: '[^']*\bstart_time\b[^']*'/,
      read: /startedAt: adTime\(c\.start_time\)/,
    },
    {
      file: 'src/lib/ads/tiktok.ts',
      requested: /schedule_start_time\?: string;/,
      read: /startedAt: adTime\(c\.schedule_start_time\) \?\? adTime\(c\.create_time\)/,
    },
    {
      file: 'src/lib/ads/snapchat.ts',
      requested: /start_time\?: string/,
      read: /startedAt: adTime\(c\.campaign\.start_time\)/,
    },
  ];

  for (const { file, requested, read: reads } of ADAPTERS) {
    it(`${file.split('/').pop()} asks the platform for the start time and parses it`, () => {
      const src = stripComments(read(file));
      expect(src, `${file}: لا يَطلُبُ وقتَ البدءِ من المنصّة`).toMatch(requested);
      expect(src, `${file}: لا يَقرأُ وقتَ البدءِ عبر adTime`).toMatch(reads);
    });
  }

  it('and the contract requires it, so a fourth platform cannot forget', () => {
    const types = stripComments(read('src/lib/ads/types.ts'));
    expect(types).toMatch(/startedAt: Date \| null;/);
    // Not optional: a `startedAt?:` would let an adapter omit it and mean
    // «today» for every campaign in that account.
    expect(types, 'الحقلُ اختياريٌّ فيُنسى').not.toMatch(/startedAt\?:/);
  });
});

describe('Ⅶ · the door', () => {
  const route = stripComments(read('src/app/api/growth/campaigns/import/route.ts'));

  it('asks for exactly what the create form asks for', () => {
    /*
     * This creates rows carrying codes stamped into order numbering, so a stricter gate than the create form's
     * would be inventing policy. Since PR-11 both ask the campaigns' own key, «إدارة الحملات»: the old comment here
     * said no such key existed, and the reports key was borrowed for the whole screen.
     */
    const create = stripComments(read('src/app/api/growth/campaigns/route.ts'));
    // was: requirePermission('reports.view') on both doors — the campaigns left the reports key (PR-11).
    const gate = /requirePermission\('campaigns\.manage'\);/;
    expect(route, 'بوّابةٌ تختلفُ عن بابِ الإنشاء').toMatch(gate);
    expect(create).toMatch(gate);
    for (const src of [route, create]) {
      expect(src).not.toContain('analytics.view');
      expect(src).not.toContain('.catch(async () => requirePermission');
    }
    // NEGATIVE: the reports key opens neither of them any more.
    expect(route).not.toContain("requirePermission('reports.view')");
    expect(create.slice(create.indexOf('export async function POST'))).not.toContain("requirePermission('reports.view')");
  });

  it('and is rate limited, because it talks to three third parties', () => {
    // A held button would be a queue of `listCampaigns` calls against a
    // rate limit the seller does not control — losing the account to an
    // `ERROR` status for everyone.
    expect(route).toMatch(/rateLimit\(`campaigns:import:/);
    expect(route).toMatch(/status: 429/);
  });

  it('and the audit row carries every code, not a count', () => {
    // A code is stamped on orders from now on, and «created 14» is not
    // something anybody can check afterwards.
    expect(route).toMatch(/campaigns: result\.accounts\.flatMap/);
    expect(route).toMatch(/code: c\.code/);
  });
});

describe('Ⅷ · and the screen keeps the two pulls apart', () => {
  const screen = read('src/components/screens/CampaignsScreen.tsx');

  it('two buttons, because they do different things', () => {
    // One button doing both would mean a seller who wanted today's spend
    // also got nine archived campaigns they had deliberately not typed in.
    expect(screen).toContain('اسحب الحملات');
    expect(screen).toContain('اسحب الإنفاق');
    expect(screen).toMatch(/campaigns\/import/);
    expect(screen).toMatch(/campaigns\/sync/);
  });

  it('and «nothing new» is said out loud with what was looked at', () => {
    // It is the common answer, and read as a failure if it is silent.
    expect(screen).toContain('لا حملات جديدة');
    expect(screen).toContain('موجودة أصلاً');
  });

  it('and names what arrived rather than counting it', () => {
    // «أُضيفت ٣ حملات» cannot be checked by anybody; the names can.
    expect(screen).toMatch(/names\.slice\(0, 4\)\.join/);
    // And it says what is still missing from each new row.
    expect(screen).toContain('حدِّد منتج كل حملة');
  });
});
