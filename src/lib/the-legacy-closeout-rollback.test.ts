import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LEGACY_CLOSE_ACTION } from './legacy-closeout-words';

/**
 * «أقفل القديمة بلا باركود» — THE FILE THAT UNDOES A PRESS, read as text (there is no database in CI).
 *
 * The press is a button, not a migration: nothing may write production data at deploy time (the container runs `prisma migrate
 * deploy` on every start). The rollback is for the day the owner regrets a press. What is held to here: it only moves orders back
 * and logs it, it never deletes, it never touches money, and it stops the mark from counting WITHOUT erasing it.
 */

const DIR = path.join(process.cwd(), 'scripts', 'backfills');
const FILE = '20261112-legacy-closeout.rollback.sql';
const raw = readFileSync(path.join(DIR, FILE), 'utf8');
const code = raw
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n');
const statements = code
  .split(/;\s*\n/)
  .map((s) => s.trim())
  .filter(Boolean);

describe('it is a script the owner runs, never a migration the container runs', () => {
  it('lives under scripts/backfills/', () => {
    expect(existsSync(path.join(DIR, FILE))).toBe(true);
  });

  it('NEGATIVE: nothing in prisma/migrations/ names the mark — `migrate deploy` runs that folder on every start, and the press is never to be one of them', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const root = path.join(process.cwd(), 'prisma', 'migrations');
    const files = walk(root);
    expect(files.length).toBeGreaterThan(10); // the walk is not vacuous
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toContain('LEGACY_CLOSED_NO_MONEY');
  });

  it('says so in its own head, and tells the owner how to run it and how many it will touch', () => {
    expect(raw).toContain('NOT A MIGRATION');
    expect(raw).toContain('npx prisma db execute --file scripts/backfills/20261112-legacy-closeout.rollback.sql');
    expect(raw).toContain('HOW MANY ORDERS IT WILL PUT BACK (read-only; run it first)');
  });
});

describe('it only moves orders back and writes a line saying so', () => {
  it('is one update of the orders, one insert on the settlement log, one update of the marks — in that order', () => {
    expect(statements).toHaveLength(3);
    expect(statements[0]).toMatch(/^UPDATE "orders" o\s+SET "settlementStatus" = a\."previousStatus"/);
    expect(statements[1]).toMatch(/^INSERT INTO "order_status_logs"/);
    expect(statements[2]).toMatch(/^UPDATE "order_activities" a/);
  });

  it('NEGATIVE: nothing is deleted, dropped, truncated or altered, and not one money table is named', () => {
    expect(code).not.toMatch(/\b(DELETE|DROP|TRUNCATE|ALTER)\b/i);
    for (const table of ['wallet_movements', 'wallets', 'commission', 'return_receipts', 'stock', 'inventory', 'financial_transactions', 'collectedAmount']) {
      expect(code, table).not.toContain(table);
    }
  });

  it('moves an order back only while it is STILL «SETTLED» — one that moved on since (refunded) stays as it is', () => {
    expect(statements[0]).toContain(`o."settlementStatus" = 'SETTLED'`);
  });

  it('reads the very mark the press writes, and the state the press recorded', () => {
    expect(statements[0]).toContain(`a."action" = '${LEGACY_CLOSE_ACTION}'`);
    expect(statements[0]).toContain('a."previousStatus" IS NOT NULL');
  });

  it('the mark is RENAMED, not erased — and the new name is not the one the commission rule reads', () => {
    const renamed = /SET "action" = '([A-Z_]+)'/.exec(statements[2])?.[1];
    expect(renamed).toBe('LEGACY_CLOSED_NO_MONEY_UNDONE');
    expect(renamed).not.toBe(LEGACY_CLOSE_ACTION);
  });
});
