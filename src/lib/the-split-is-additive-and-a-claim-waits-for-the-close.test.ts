import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./db', () => ({ db: {} }));

import { claimsFromRows, openClaimsFor } from './settlement-decisions';
import { runMatching } from './settlement';
import { claimingRowWhere } from './match-integrity';
import { EXCLUDED_RESULT } from './statement-open-lines';
import { recordMovement } from './wallets';

/**
 * THE SPLIT OF THE APPROVAL — what the database gains, and what reads the close instead of the money.
 *
 * «افصل المطابقة عن التحصيل» (the owner, 2/11). The migration only ADDS: two nullable stamps on the statement, one
 * nullable column with a plain unique index on the movement, and a backfill that writes those new columns and nothing
 * else. Its rollback refuses while a statement has its money posted and its matching still open.
 */

const DIR = 'prisma/migrations/20261102120000_statement_matching_closed';
const read = (f: string) => readFileSync(join(process.cwd(), DIR, f), 'utf8');
/** The SQL with its comments taken out, so a word in a comment proves nothing. */
const sql = (f: string) => read(f).split(/\r?\n/).map((l) => l.replace(/--.*$/, '')).join('\n');

describe('the migration is additive', () => {
  const m = sql('migration.sql');

  it('adds the three columns, nullable, and only if they are not there', () => {
    expect(m).toMatch(/ALTER TABLE "courier_statements" ADD COLUMN IF NOT EXISTS "matchingClosedAt"\s+TIMESTAMP\(3\);/);
    expect(m).toMatch(/ALTER TABLE "courier_statements" ADD COLUMN IF NOT EXISTS "matchingClosedById" TEXT;/);
    expect(m).toMatch(/ALTER TABLE "wallet_movements" ADD COLUMN IF NOT EXISTS "statementReceiptId" TEXT;/);
    expect(m).not.toMatch(/ADD COLUMN[^;]*NOT NULL/);
  });

  it('the index is a PLAIN unique index — every NULL is distinct, so no movement written before it can trip it', () => {
    expect(m).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "wallet_movements_statementReceiptId_key"\s+ON "wallet_movements"\("statementReceiptId"\);/);
    // Not partial: Prisma's `@unique` names the same index, so the schema and the database say one thing.
    expect(m).not.toMatch(/statementReceiptId_key"[^;]*WHERE/);
    const schema = readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
    expect(schema).toMatch(/statementReceiptId String\? @unique/);
    expect(schema).toMatch(/matchingClosedAt\s+DateTime\?/);
    expect(schema).toMatch(/matchingClosedById String\?/);
  });

  it('the backfill writes ONLY the new columns, only where they are empty, only for statements already approved', () => {
    const updates = [...m.matchAll(/UPDATE "([a-z_]+)"\s+SET([\s\S]*?)WHERE([\s\S]*?);/g)];
    expect(updates).toHaveLength(1);
    const [, table, set, where] = updates[0];
    expect(table).toBe('courier_statements');
    const written = [...set.matchAll(/"(\w+)"\s*=/g)].map((x) => x[1]).sort();
    expect(written).toEqual(['matchingClosedAt', 'matchingClosedById']);
    expect(where).toMatch(/"matchingClosedAt" IS NULL/);
    expect(where).toMatch(/"approvedAt" IS NOT NULL OR "status" = 'APPROVED'/);
  });

  it('NEGATIVE — nothing is dropped, deleted, retyped or truncated', () => {
    expect(m).not.toMatch(/\b(DROP|DELETE|TRUNCATE|RENAME)\b/i);
    expect(m).not.toMatch(/ALTER COLUMN/i);
  });

  it('the rollback refuses while a statement has its money in and its matching open — before it drops anything', () => {
    const r = sql('rollback.sql');
    const refuse = r.indexOf('RAISE EXCEPTION');
    expect(refuse).toBeGreaterThan(-1);
    expect(r.slice(0, refuse)).toMatch(/"approvedAt" IS NOT NULL AND "matchingClosedAt" IS NULL/);
    expect(r.indexOf('DROP')).toBeGreaterThan(refuse);
  });
});

describe('a claim on the company exists once its statement’s MATCHING is closed — not when its money is posted', () => {
  it('the read asks for the close', async () => {
    const findMany = vi.fn(async () => []);
    await openClaimsFor({ settlementMatch: { findMany } } as never, { companyId: 'c1', orderIds: ['o1'], excludeStatementId: 'st2', minorUnit: 0 });
    const where = (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.statement).toEqual({ matchingClosedAt: { not: null } });
  });

  it('the latest CLOSE wins — a claim answered again on a later statement is judged by its remainder', () => {
    const claims = claimsFromRows(
      [
        { orderId: 'o1', expectedAmount: 20000, statementAmount: 15000, statementFee: 0, statement: { approvedAt: new Date('2026-10-01'), matchingClosedAt: new Date('2026-10-01') } },
        // Its money was posted BEFORE the first, its matching closed AFTER: the close is what counts.
        { orderId: 'o1', expectedAmount: 5000, statementAmount: 3000, statementFee: 0, statement: { approvedAt: new Date('2026-09-30'), matchingClosedAt: new Date('2026-10-05') } },
      ],
      0
    );
    expect(claims.get('o1')!.remaining).toBe(2000);
  });
});

describe('a postponed parcel EXCLUDED on one statement is free for the next one’s line', () => {
  it('the rows that hold an order elsewhere are the clean and the accepted ones — never an EXCLUDED row', () => {
    expect(JSON.stringify(claimingRowWhere())).not.toContain(EXCLUDED_RESULT);
  });

  /** S2's matching of the parcel's delivered line, with S1's row for it as given. */
  async function matchOnS2(s1Result: string) {
    // The rows of OTHER statements, filtered by the matcher's own WHERE: the fake applies the result/resolution test.
    const others = [{ orderId: 'oE', result: s1Result, resolution: null, matchedBy: 'MERCHANT_REF', statement: { reference: 'S1', approvedAt: new Date('2026-10-25') } }];
    const passes = (r: (typeof others)[number], w: Record<string, any>): boolean =>
      (w.OR as Record<string, any>[]).some((alt) => {
        const inner = alt.AND ? alt.AND[0].OR : alt.OR;
        return (inner as Record<string, any>[]).some((c) => (c.result ? r.result === c.result : r.resolution === c.resolution));
      });
    const created: Record<string, any>[] = [];
    const tx = {
      statementLine: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: 'l2', merchantRef: 'REF-oE', barcode: null, amount: 20000, collected: 25000, fee: 5000, status: 'تم توصيلها' }])
          .mockResolvedValue([]),
      },
      courierStatement: {
        findFirst: vi.fn(async () => ({ id: 'st2', deliveryProviderId: 'dp1', periodFrom: null, periodTo: null, createdAt: new Date('2026-11-01'), fileHash: 'cd'.repeat(32) })),
      },
      settlementMatch: {
        deleteMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => created.push(data)),
        findMany: vi.fn(async ({ where }: { where: Record<string, any> }) =>
          where.statementId?.not === 'st2' && where.statementLineId ? others.filter((r) => passes(r, where)) : []
        ),
      },
      orderChangeRequest: { findMany: vi.fn(async () => []) },
      order: {
        findFirst: vi.fn(async () => ({
          id: 'oE', shippingStatus: 'OUT_FOR_DELIVERY', settlementStatus: 'PENDING_COLLECTION', totalAmount: 25000, priceIncludesDelivery: false,
          collectedAmount: null, deliveryFee: 5000, returnReceipt: null, addOns: [],
          items: [{ quantity: 1, freeQuantity: 0, unitPrice: 25000, discountShare: 0, lineTotal: 25000, deliveredQty: null }],
        })),
        findMany: vi.fn(async () => []),
      },
    };

    await runMatching(tx as never, { companyId: 'c1', storeId: 's1', statementId: 'st2', minorUnit: 0 });
    return created;
  }

  it('S2’s line for it is MATCHED, not «held by another statement», when S1’s only row for it is EXCLUDED', async () => {
    expect(await matchOnS2(EXCLUDED_RESULT)).toEqual([expect.objectContaining({ orderId: 'oE', result: 'MATCHED', note: null })]);
  });

  it('NEGATIVE — had S1 MATCHED it (S1 approved), S2’s line is held for a person', async () => {
    expect(await matchOnS2('MATCHED')).toEqual([expect.objectContaining({ orderId: 'oE', result: 'MISMATCHED' })]);
  });
});

describe('the movement keeps the receipt it is for', () => {
  it('the wallet writer stores `statementReceiptId` when it is given, and only then', async () => {
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => data);
    const tx = { wallet: { findFirst: vi.fn(async () => ({ id: 'w1', currencyCode: 'SYP' })) }, walletMovement: { create } };
    const base = { companyId: 'c1', walletId: 'w1', direction: 'IN' as const, amount: 80000, party: 'p', category: 'COURIER_SETTLEMENT' as const, note: 'n', createdById: 'u1' };
    await recordMovement(tx as never, { ...base, referenceType: 'STATEMENT', referenceId: 'st1', statementReceiptId: 'r1' });
    await recordMovement(tx as never, base);
    expect(create.mock.calls[0][0].data.statementReceiptId).toBe('r1');
    expect('statementReceiptId' in create.mock.calls[1][0].data).toBe(false);
  });
});

describe('the two lists that say «open» read the close', () => {
  const code = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
  it('the statements list hands the close to the screens, beside the money', () => {
    expect(code('src/app/api/finance/statements/route.ts')).toMatch(/matchingClosedAt: s\.matchingClosedAt/);
  });
  it('«شغلك اليوم» counts a statement as open until its matching is closed', () => {
    expect(code('src/app/api/me/work/route.ts')).toMatch(/count\('STATEMENTS_OPEN', db\.courierStatement\.count\(\{ where: \{ companyId, storeId, matchingClosedAt: null \} \}\)\)/);
  });
});
