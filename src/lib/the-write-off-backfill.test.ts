import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expectedBackTotal } from './partial-delivery';
import { LOSS_RECEIPT_NOTE, SETTLEMENT_WITH_MONEY, nothingCameBack } from './written-off';

/**
 * THE BACKFILL FOR THE WRITE-OFFS ALREADY ON RECORD — additive, safe to run twice, and not run by this change.
 *
 * ⚠️ There is no database in CI, so the file is read as text (the way the settings migration is) and its rules
 * are then run over fixture rows by a small model of the same rules. The model is not the SQL; the text checks
 * are what tie the two together: every predicate the model uses is asserted to be in the file. The stronger
 * evidence — the file run inside a rolled-back transaction on a copy — is the owner's step before he applies it.
 */

const DIR = path.join(process.cwd(), 'prisma', 'migrations', '20261029010000_write_off_closes_with_a_receipt');
const raw = readFileSync(path.join(DIR, 'migration.sql'), 'utf8');
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
const statements = code(raw)
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);
const insert = statements.find((s) => s.startsWith('INSERT INTO "return_receipts"'))!;
const updates = statements.filter((s) => s.startsWith('UPDATE "orders"'));

describe('the file only adds, and says so', () => {
  it('is one insert and two updates — nothing is deleted, dropped, truncated or altered', () => {
    expect(statements).toHaveLength(3);
    expect(insert).toBeTruthy();
    expect(updates).toHaveLength(2);
    for (const s of statements) expect(s).not.toMatch(/\b(DELETE|DROP|TRUNCATE|ALTER)\b/i);
  });

  it('the insert steps aside for an order that already has a receipt — so a second run adds nothing', () => {
    expect(insert).toMatch(/ON CONFLICT \("orderId"\) DO NOTHING$/);
  });

  it('every receipt it writes is tagged, so the rollback finds those and nothing else', () => {
    expect(insert).toContain(`'wo-backfill-' || gen_random_uuid()::text`);
    const rollback = code(readFileSync(path.join(DIR, 'rollback.sql'), 'utf8'));
    expect(rollback.match(/'wo-backfill-%'/g)!.length).toBe(2);
    // it only removes a receipt that still says nothing came back: one the desk completed holds real units and stays
    expect(rollback).toMatch(/DELETE FROM "return_receipts"\s+WHERE "id" LIKE 'wo-backfill-%' AND "receivedQty" = 0 AND "damagedQty" = 0;/);
    expect(rollback).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261029010000_write_off_closes_with_a_receipt'`);
  });

  it('writes the receipt the door writes: received 0, damaged 0, missing = expected, no fee, the loss note', () => {
    expect(insert).toContain(`w."expectedQty", 0, 0, w."expectedQty"`);
    expect(insert).toContain('false, 0, w."userId"');
    expect(insert).toContain(`'${LOSS_RECEIPT_NOTE}'`);
    expect(insert).toMatch(/, false, now\(\)\s*FROM/);
  });

  it('reads the write-offs from the record the door has always written, and only parcels that are RETURNED', () => {
    expect(insert).toContain(`x."action" = 'WRITTEN_OFF_AS_LOSS'`);
    expect(insert).toContain(`o."shippingStatus" = 'RETURNED'`);
    expect(insert).toContain('ORDER BY x."createdAt" ASC LIMIT 1');
  });

  it('leaves alone a write-off with no person on record, and one that expected nothing back', () => {
    expect(insert).toContain('a."userId" IS NOT NULL');
    expect(insert).toContain('WHERE w."expectedQty" > 0');
  });

  it('counts the units back the way the desk does', () => {
    expect(insert).toContain('GREATEST(0, i."quantity" + i."freeQuantity" - COALESCE(i."deliveredQty", 0))');
  });

  it('the two updates look only at receipts this file wrote, that still say nothing came back', () => {
    for (const u of updates) {
      expect(u).toContain(`r."id" LIKE 'wo-backfill-%'`);
      expect(u).toContain('r."receivedQty" = 0 AND r."damagedQty" = 0');
    }
  });

  it('returnedAt is only FILLED, and a settlement that holds money is never rewritten', () => {
    const [returnedAt, settlement] = updates;
    expect(returnedAt).toContain('o."returnedAt" IS NULL');
    for (const s of SETTLEMENT_WITH_MONEY) expect(settlement, s).toContain(`'${s}'`);
    expect(settlement).toContain(`SET "settlementStatus" = 'NOT_APPLICABLE'`);
    expect(settlement).toContain('NOT IN (');
  });

  it('does not touch stock, version or updatedAt — no age-based alert is reset by it', () => {
    expect(code(raw)).not.toMatch(/inventory|"version"|"updatedAt"|batch/i);
  });
});

/** The same rules, over rows. */
interface Item { quantity: number; freeQuantity: number; deliveredQty: number | null }
interface Order {
  id: string;
  shippingStatus: string;
  settlementStatus: string;
  returnedAt: string | null;
  items: Item[];
  /** The write-off activity records, oldest first; the door writes one per order. */
  writeOffs: { userId: string | null; at: string }[];
  receipt: { id: string; expectedQty: number; receivedQty: number; damagedQty: number; missingQty: number; inspectedById: string; inspectedAt: string; note: string } | null;
}

function backfill(orders: Order[]): number {
  let written = 0;
  for (const o of orders) {
    const first = [...o.writeOffs].sort((a, b) => a.at.localeCompare(b.at))[0];
    const expected = o.items.reduce((n, i) => n + Math.max(0, i.quantity + i.freeQuantity - (i.deliveredQty ?? 0)), 0);
    if (o.shippingStatus === 'RETURNED' && first && first.userId !== null && expected > 0 && o.receipt === null) {
      o.receipt = {
        id: `wo-backfill-${o.id}`, expectedQty: expected, receivedQty: 0, damagedQty: 0, missingQty: expected,
        inspectedById: first.userId, inspectedAt: first.at, note: LOSS_RECEIPT_NOTE,
      };
      written++;
    }
  }
  for (const o of orders) {
    const r = o.receipt;
    if (!r || !r.id.startsWith('wo-backfill-') || r.receivedQty !== 0 || r.damagedQty !== 0) continue;
    if (o.returnedAt === null) o.returnedAt = r.inspectedAt;
    if (!['NOT_APPLICABLE', ...SETTLEMENT_WITH_MONEY].includes(o.settlementStatus)) o.settlementStatus = 'NOT_APPLICABLE';
  }
  return written;
}

const order = (id: string, over: Partial<Order> = {}): Order => ({
  id,
  shippingStatus: 'RETURNED',
  settlementStatus: 'PENDING',
  returnedAt: null,
  items: [{ quantity: 2, freeQuantity: 1, deliveredQty: null }, { quantity: 1, freeQuantity: 0, deliveredQty: null }],
  writeOffs: [{ userId: 'u-fin', at: '2026-09-10T08:00:00Z' }],
  receipt: null,
  ...over,
});

const fixture = (): Order[] => [
  order('plain'),
  order('already-counted', { receipt: { id: 'desk-1', expectedQty: 4, receivedQty: 4, damagedQty: 0, missingQty: 0, inspectedById: 'u-desk', inspectedAt: '2026-09-12T08:00:00Z', note: 'x' } }),
  order('not-a-write-off', { writeOffs: [] }),
  order('still-waiting', { shippingStatus: 'RETURN_REQUESTED' }),
  order('nobody-on-record', { writeOffs: [{ userId: null, at: '2026-09-10T08:00:00Z' }] }),
  order('expected-nothing', { items: [{ quantity: 2, freeQuantity: 0, deliveredQty: 2 }] }),
  order('money-recorded', { settlementStatus: 'SETTLED', returnedAt: null }),
  order('has-a-moment', { returnedAt: '2026-09-11T00:00:00Z' }),
  order('written-off-twice', { writeOffs: [{ userId: 'u-second', at: '2026-09-20T08:00:00Z' }, { userId: 'u-first', at: '2026-09-10T08:00:00Z' }] }),
  order('partly-delivered-before', { items: [{ quantity: 3, freeQuantity: 0, deliveredQty: 1 }] }),
];
const byId = (os: Order[], id: string) => os.find((o) => o.id === id)!;

describe('what the rules do to fixture orders', () => {
  it('writes a loss receipt for exactly the write-offs that qualify', () => {
    const os = fixture();
    expect(backfill(os)).toBe(5);
    const got = os.filter((o) => o.receipt?.id.startsWith('wo-backfill-')).map((o) => o.id).sort();
    expect(got).toEqual(['has-a-moment', 'money-recorded', 'partly-delivered-before', 'plain', 'written-off-twice']);
    for (const id of got) expect(nothingCameBack(byId(os, id).receipt!), id).toBe(true);
  });

  it('counts the units back as the desk does, and credits the FIRST write-off\'s person and day', () => {
    const os = fixture();
    backfill(os);
    expect(byId(os, 'plain').receipt).toMatchObject({ expectedQty: 4, missingQty: 4, inspectedById: 'u-fin', inspectedAt: '2026-09-10T08:00:00Z' });
    expect(byId(os, 'partly-delivered-before').receipt).toMatchObject({ expectedQty: 2, missingQty: 2 });
    expect(byId(os, 'written-off-twice').receipt).toMatchObject({ inspectedById: 'u-first' });
    for (const o of fixture()) {
      // the formula in the file and the one the desk uses are the same sum
      expect(o.items.reduce((n, i) => n + Math.max(0, i.quantity + i.freeQuantity - (i.deliveredQty ?? 0)), 0)).toBe(
        expectedBackTotal(o.items.map((i, k) => ({ id: String(k), productId: 'p', productName: 'n', ...i })))
      );
    }
  });

  it('NEGATIVE: leaves alone a counted order, a non-write-off, a parcel still waiting, nobody-on-record and expected-nothing', () => {
    const os = fixture();
    const before = JSON.stringify(os);
    backfill(os);
    for (const id of ['already-counted', 'not-a-write-off', 'still-waiting', 'nobody-on-record', 'expected-nothing']) {
      const was = JSON.parse(before).find((o: Order) => o.id === id);
      expect(byId(os, id), id).toEqual(was);
    }
  });

  it('fills returnedAt where empty and keeps one that is there', () => {
    const os = fixture();
    backfill(os);
    expect(byId(os, 'plain').returnedAt).toBe('2026-09-10T08:00:00Z');
    expect(byId(os, 'has-a-moment').returnedAt).toBe('2026-09-11T00:00:00Z');
  });

  it('owes no settlement on the lost, and NEVER rewrites one that holds money', () => {
    const os = fixture();
    backfill(os);
    expect(byId(os, 'plain').settlementStatus).toBe('NOT_APPLICABLE');
    expect(byId(os, 'money-recorded').settlementStatus).toBe('SETTLED');
  });

  it('IDEMPOTENT: a second run changes nothing and writes nothing', () => {
    const os = fixture();
    expect(backfill(os)).toBe(5);
    const afterFirst = JSON.stringify(os);
    expect(backfill(os)).toBe(0);
    expect(JSON.stringify(os)).toBe(afterFirst);
  });

  it('ADDITIVE: no order is removed, no receipt that stood is changed', () => {
    const os = fixture();
    const counted = JSON.stringify(byId(os, 'already-counted'));
    const n = os.length;
    backfill(os);
    expect(os).toHaveLength(n);
    expect(JSON.stringify(byId(os, 'already-counted'))).toBe(counted);
  });

  it('a parcel that turned up after the backfill, and was completed at the desk, is not touched by a re-run', () => {
    const os = fixture();
    backfill(os);
    const o = byId(os, 'plain');
    // the desk completes the same receipt in place (same id): 3 came back
    o.receipt = { ...o.receipt!, receivedQty: 3, missingQty: 1, inspectedAt: '2026-10-05T08:00:00Z' };
    o.settlementStatus = 'PENDING';
    const snapshot = JSON.stringify(o);
    backfill(os);
    expect(JSON.stringify(o)).toBe(snapshot);
  });
});
