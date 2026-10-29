import { describe, expect, it, vi } from 'vitest';
import { OpeningCountRefused, recordOpeningCount } from './wallet-opening-count';
import { ALL_CATALOG_KEYS } from './permission-catalog';
import { repoFile, stripComments } from './guard-source';

/**
 * THE MONEY A WALLET STARTED WITH, AND WHO COUNTED IT.
 *
 * `Wallet.openingBalance` already existed, is already a term in
 * `walletBalance` (opening + IN − OUT) and therefore in every daily closing,
 * and is ALREADY immutable after creation — the wallet PATCH schema accepts
 * `name` and `isActive` and nothing else. None of that is rebuilt here.
 *
 * What the cutover asks for and the system could not answer: the opening
 * balance comes from a physical count taken at the switch time, SIGNED BY THE
 * PERSON COUNTING. The audit log records who CREATED the wallet, which is the
 * person who typed the number — not the two people who counted a drawer.
 */

const WALLET = {
  id: 'w1',
  name: 'صندوق سوريا النقدي',
  currencyCode: 'USD',
  openingBalance: 0,
  _count: { movements: 0 },
  openingCount: null as null | { id: string; countedByName: string; countedAt: Date },
};

function fakeTx(wallet: Partial<typeof WALLET> = {}) {
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  return {
    tx: {
      wallet: {
        findFirst: vi.fn(async () => ({ ...WALLET, ...wallet })),
        update: vi.fn(async (a: Record<string, unknown>) => {
          updated.push(a);
          return {};
        }),
      },
      walletOpeningCount: {
        create: vi.fn(async (a: { data: Record<string, unknown> }) => {
          created.push(a.data);
          return { id: 'c1', ...a.data, countedAt: a.data.countedAt };
        }),
      },
    } as never,
    created,
    updated,
  };
}

const base = {
  companyId: 'co1',
  walletId: 'w1',
  countedAmount: 4350,
  countedByName: 'أبو محمّد',
  countedAt: new Date('2026-10-01T07:00:00Z'),
  recordedById: 'u1',
  minorUnit: 2,
  now: new Date('2026-10-01T09:00:00Z'),
};

describe('a signed opening count', () => {
  it('records who counted, when, and what it replaced — and sets the balance', async () => {
    const { tx, created, updated } = fakeTx({ openingBalance: 0 });
    const out = await recordOpeningCount(tx, base);

    expect(created[0]).toMatchObject({
      walletId: 'w1',
      countedAmount: 4350,
      currencyCode: 'USD',
      countedByName: 'أبو محمّد',
      previousOpening: 0,
      recordedById: 'u1',
    });
    // The count IS the opening balance, written in the same transaction so
    // there is no instant where the money was counted and the wallet disagrees.
    expect(updated[0]).toMatchObject({ where: { id: 'w1' }, data: { openingBalance: 4350 } });
    expect(out.previousOpening).toBe(0);
  });

  /**
   * THE COUNTER'S NAME IS NOT THE TYPIST'S NAME.
   *
   * `recordedById` is the logged-in user; `countedByName` is free text because
   * the person holding the drawer may have no login at all. Storing a user id
   * would quietly turn «who counted» into «who typed», which is the exact
   * thing this row exists to stop.
   */
  it('keeps the counter and the recorder apart', async () => {
    const { tx, created } = fakeTx();
    await recordOpeningCount(tx, { ...base, countedByName: 'أبو محمّد', recordedById: 'u1' });
    expect(created[0].countedByName).toBe('أبو محمّد');
    expect(created[0].recordedById).toBe('u1');
    expect(created[0].countedByName).not.toBe(created[0].recordedById);
  });

  it('rounds to the currency the wallet is actually in, not a global rule', async () => {
    const { tx, created } = fakeTx();
    // Syria is 2 minor units, Jordan is 3 — an invariant.
    await recordOpeningCount(tx, { ...base, countedAmount: 12.3456, minorUnit: 2 });
    expect(created[0].countedAmount).toBe(12.35);
  });

  it('replaces a typed opening balance and keeps what it replaced', async () => {
    const { tx, created } = fakeTx({ openingBalance: 999 });
    const out = await recordOpeningCount(tx, base);
    expect(created[0].previousOpening).toBe(999);
    expect(out.previousOpening).toBe(999);
  });
});

describe('and it is refused', () => {
  const refusal = async (patch: Partial<typeof WALLET>, input: Partial<typeof base> = {}) => {
    const { tx } = fakeTx(patch);
    return recordOpeningCount(tx, { ...base, ...input }).then(
      () => null,
      (e: unknown) => e as OpeningCountRefused
    );
  };

  it('a second time, naming who counted the first time', async () => {
    const e = await refusal({
      openingCount: { id: 'c0', countedByName: 'سامر', countedAt: new Date('2026-09-30T06:00:00Z') },
    });
    expect(e).toBeInstanceOf(OpeningCountRefused);
    expect(e!.code).toBe('ALREADY_COUNTED');
    expect(e!.message).toContain('سامر');
    expect(e!.message).toContain('2026-09-30');
  });

  /**
   * AND THIS IS THE ONE THAT MATTERS.
   *
   * A wallet that has started moving is reconciled by the DAILY CLOSING,
   * which already compares the book balance against a counted one and makes
   * somebody explain the gap in writing. Posting an ADJUSTMENT movement for
   * the difference instead would be wrong twice: it would make «opening
   * balance» mean «balance at some later moment», and it would be a second
   * mechanism for reconciling live money — which is how two numbers for the
   * same money come to exist.
   */
  it('on a wallet that has started moving, and it says where to go instead', async () => {
    const e = await refusal({ _count: { movements: 12 } });
    expect(e!.code).toBe('WALLET_HAS_MOVEMENTS');
    expect(e!.message).toContain('12');
    expect(e!.message, 'لا يقول إلى أين يذهب').toContain('الإغلاق اليوميّ');
  });

  it('without a counter — an unsigned count is not a count', async () => {
    const e = await refusal({}, { countedByName: 'أ' });
    expect(e!.code).toBe('NO_COUNTER');
  });

  it('with a count time in the future', async () => {
    const e = await refusal({}, { countedAt: new Date('2026-10-02T09:00:00Z') });
    expect(e!.code).toBe('COUNT_IN_FUTURE');
  });

  it('with an amount outside the range', async () => {
    const e = await refusal({}, { countedAmount: 5_000_000_000 });
    expect(e!.code).toBe('AMOUNT_OUT_OF_RANGE');
  });

  it('for a wallet belonging to another company', async () => {
    const tx = {
      wallet: { findFirst: vi.fn(async () => null), update: vi.fn() },
      walletOpeningCount: { create: vi.fn() },
    } as never;
    const e = await recordOpeningCount(tx, base).then(
      () => null,
      (x: unknown) => x as OpeningCountRefused
    );
    expect(e).toBeInstanceOf(OpeningCountRefused);
    expect(e!.code).toBe('NOT_FOUND');
  });

  it('and nothing is written on any refusal', async () => {
    const { tx, created, updated } = fakeTx({ _count: { movements: 3 } });
    await recordOpeningCount(tx, base).catch(() => null);
    expect(created, 'كُتب عدٌّ مرفوض').toEqual([]);
    expect(updated, 'تغيّر الرصيد رغم الرفض').toEqual([]);
  });
});

describe('the door', () => {
  /**
   * GUARDED BY A PERMISSION THAT ALREADY EXISTS.
   *
   * `finance.cashbox` governs creating and retiring a wallet. Naming the money
   * a wallet starts with is part of managing the wallet, and a new permission
   * key would be one more grant somebody has to remember before the cutover
   * works at all — which is how a feature arrives already broken for everyone
   * except whoever thought to tick it.
   */
  it('is the permission that already guards a wallet, and no new key', () => {
    const route = stripComments(repoFile('src/app/api/finance/wallets/[id]/opening-count/route.ts'));
    expect(route).toContain("requirePermission('finance.cashbox')");
    const keys = [...ALL_CATALOG_KEYS].filter((k) => k.startsWith('finance.'));
    // PR-9 split the cash box on purpose (migration 20261030150000_finance_split_keys grants each new key): the view, the
    // wallets' management and the closing's approval. The opening count itself still asks the one it always asked.
    expect(keys.sort(), 'مفتاح صلاحية جديد يحتاج منحاً').toEqual([
      'finance.cashbox', 'finance.cashbox_view', 'finance.closing_approve', 'finance.create', 'finance.update', 'finance.view',
      'finance.wallets_manage',
    ]);
  });

  /** Enforced in the service, so a script or a second screen meets the same rules. */
  it('runs every rule inside the transaction that writes', () => {
    const route = stripComments(repoFile('src/app/api/finance/wallets/[id]/opening-count/route.ts'));
    expect(route).toMatch(/db\.\$transaction\(\(tx\) =>\s*recordOpeningCount\(tx, \{/);
    expect(route, 'الرفض لا يُترجم إلى ردّ').toContain('OpeningCountRefused');
  });

  /** A refusal a person can read, with the right status. */
  it('answers 409 for a wallet that cannot be counted, not 500', () => {
    const route = stripComments(repoFile('src/app/api/finance/wallets/[id]/opening-count/route.ts'));
    expect(route).toMatch(/'ALREADY_COUNTED' \|\| e\.code === 'WALLET_HAS_MOVEMENTS' \? 409/);
  });

  /**
   * And the screen does not offer what the server refuses.
   *
   * A button that can only end in a red error teaches people the screen is
   * unreliable.
   */
  it('and the screen offers it only while it is still possible', () => {
    const screen = stripComments(repoFile('src/components/screens/finance/WalletsScreen.tsx'));
    expect(screen).toMatch(/wallet\.movements === 0 && !wallet\.openingCount/);
    expect(screen, 'لا يقول من عدَّ').toContain('عُدَّ بمعرفة');
  });
});
