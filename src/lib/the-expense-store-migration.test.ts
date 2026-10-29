import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE EXPENSE MIGRATION ONLY ADDS — AND THE BACKFILL IS THE OWNER'S PRESS, NEVER THE CONTAINER'S.
 *
 * `prisma migrate deploy` runs every folder under prisma/migrations/ on every container start. The migration for
 * «an expense belongs to a store, and can be cancelled» therefore adds four nullable columns, one foreign key
 * and one index, and writes NO data: filling `store_id` of the old rows would move every store's profit the moment
 * the image deploys, which is a production write the owner has not pressed.
 *
 * ⚠️ There is no database here, so the files are read as text and the backfill's three rules are run over fixture
 * rows by a small model of the same rules. The model is not the SQL; the text checks tie the two together — every
 * predicate the model uses is asserted to be in the file. CI applies the migration itself on Postgres 16; the
 * backfill is the owner's step, after the counts it prints.
 */

const ROOT = process.cwd();
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');
const FOLDER = readdirSync(MIGRATIONS).find((n) => n.endsWith('_expense_store_and_cancel'))!;
const sql = readFileSync(path.join(MIGRATIONS, FOLDER, 'migration.sql'), 'utf8');
const rollback = readFileSync(path.join(MIGRATIONS, FOLDER, 'rollback.sql'), 'utf8');
const code = (text: string) =>
  text
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
const run = code(sql);

describe('the migration', () => {
  it('exists, and sorts after the newest one that was on main when it was written', () => {
    expect(FOLDER).toBeTruthy();
    expect(FOLDER > '20261029120000_shortfall_penalty').toBe(true);
    expect(existsSync(path.join(MIGRATIONS, FOLDER, 'rollback.sql'))).toBe(true);
  });

  it('adds exactly four nullable columns to expenses, each guarded so a second run changes nothing', () => {
    const adds = [...run.matchAll(/ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "(\w+)" ([A-Z0-9()]+)/g)].map((m) => [m[1], m[2]]);
    expect(adds).toEqual([
      ['store_id', 'TEXT'],
      ['voided_at', 'TIMESTAMP(3)'],
      ['void_reason', 'TEXT'],
      ['voided_by_id', 'TEXT'],
    ]);
  });

  it('NEGATIVE: writes no data and removes nothing — no UPDATE, INSERT, DELETE, DROP, TRUNCATE; no DEFAULT, no NOT NULL', () => {
    // «ON DELETE RESTRICT ON UPDATE CASCADE» is the foreign key's own rule, not a statement that deletes or updates.
    const statementsOnly = run.replace('ON DELETE RESTRICT ON UPDATE CASCADE', '');
    for (const word of ['UPDATE', 'INSERT', 'DELETE', 'DROP', 'TRUNCATE', 'DEFAULT', 'NOT NULL', 'ALTER COLUMN', 'RENAME']) {
      expect(statementsOnly, word).not.toMatch(new RegExp(`\\b${word}\\b`, 'i'));
    }
  });

  it('the foreign key restricts (a store with expenses cannot vanish under them), and is created once', () => {
    expect(run).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'expenses_store_id_fkey'\)/);
    expect(run).toMatch(/FOREIGN KEY \("store_id"\) REFERENCES "stores"\("id"\) ON DELETE RESTRICT/);
  });

  it('the index is the one Prisma names for @@index([companyId, storeId, expenseDate])', () => {
    expect(run).toContain('CREATE INDEX IF NOT EXISTS "expenses_companyId_store_id_expenseDate_idx"');
    const schema = readFileSync(path.join(ROOT, 'prisma', 'schema.prisma'), 'utf8');
    const model = schema.slice(schema.indexOf('model Expense {'), schema.indexOf('@@map("expenses")'));
    expect(model).toMatch(/storeId\s+String\?\s+@map\("store_id"\)/);
    expect(model).toMatch(/voidedAt\s+DateTime\?\s+@map\("voided_at"\)/);
    expect(model).toMatch(/voidReason\s+String\?\s+@map\("void_reason"\)/);
    expect(model).toMatch(/voidedById\s+String\?\s+@map\("voided_by_id"\)/);
    expect(model).toContain('@@index([companyId, storeId, expenseDate])');
  });

  it('its rollback drops what it added, in one transaction, and takes its own row back', () => {
    const r = code(rollback);
    expect(r).toMatch(/^\s*BEGIN;/);
    expect(r).toMatch(/COMMIT;\s*$/);
    for (const col of ['store_id', 'voided_at', 'void_reason', 'voided_by_id']) {
      expect(r).toContain(`DROP COLUMN IF EXISTS "${col}"`);
    }
    expect(r).toContain('DROP CONSTRAINT IF EXISTS "expenses_store_id_fkey"');
    expect(r).toContain(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${FOLDER}'`);
    // The previous image goes out first — the order is said where the person running it reads it.
    expect(rollback).toMatch(/deploy the PREVIOUS image first/);
  });
});

// ─────────────────────────────── the backfill ───────────────────────────────

const DIR = path.join(ROOT, 'scripts', 'backfills');
const SCRIPT = '20261029-expenses-get-their-store.sql';
const UNDO = '20261029-expenses-get-their-store.rollback.sql';
const backfillRaw = readFileSync(path.join(DIR, SCRIPT), 'utf8');
const backfill = code(backfillRaw);
const statements = backfill.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
const withUpdate = statements.filter((s) => /UPDATE "expenses"/.test(s));

describe('the backfill is a script the owner runs, never a migration the container runs', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it('lives under scripts/backfills/ with its undo beside it, and says how to run it', () => {
    expect(existsSync(path.join(DIR, SCRIPT))).toBe(true);
    expect(existsSync(path.join(DIR, UNDO))).toBe(true);
    expect(backfillRaw).toContain('THIS IS A MANUAL SCRIPT, NOT A MIGRATION');
    expect(backfillRaw).toContain(`npx prisma db execute --file scripts/backfills/${SCRIPT}`);
    expect(backfillRaw).toContain('READ-ONLY COUNTS (run these first)');
  });

  it('NEGATIVE: nothing in prisma/migrations/ fills store_id — the migration folder never writes data', () => {
    const all = files(MIGRATIONS);
    expect(all.length).toBeGreaterThan(10);
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain('expense_store_backfill_log');
      expect(code(text), f).not.toMatch(/UPDATE\s+"expenses"/i);
    }
  });

  it('three placements, every one of them touching NULL rows only', () => {
    expect(withUpdate).toHaveLength(3);
    for (const s of withUpdate) expect(s, s.slice(0, 60)).toMatch(/e\."store_id" IS NULL/);
  });

  it('NEGATIVE: nothing is deleted, dropped or truncated — only the log is created and written', () => {
    for (const s of statements) expect(s).not.toMatch(/\b(DELETE|DROP|TRUNCATE)\b/i);
    expect(statements.filter((s) => /^CREATE TABLE IF NOT EXISTS "expense_store_backfill_log"/.test(s))).toHaveLength(1);
  });

  it('every placement logs the ids it set, so the undo touches those and no expense typed since', () => {
    for (const s of withUpdate) {
      expect(s).toMatch(/RETURNING e\."id"/);
      expect(s).toMatch(/INSERT INTO "expense_store_backfill_log" \("expense_id"\) SELECT "id" FROM placed ON CONFLICT DO NOTHING$/);
    }
    const undo = code(readFileSync(path.join(DIR, UNDO), 'utf8'));
    expect(undo).toMatch(/UPDATE "expenses" SET "store_id" = NULL\s+WHERE "id" IN \(SELECT "expense_id" FROM "expense_store_backfill_log"\)/);
    expect(undo).not.toMatch(/WHERE\s+"store_id" IS NOT NULL\s*;/);
    expect(undo).not.toContain('_prisma_migrations');
  });

  it('the rules in the file are the rules modelled below', () => {
    expect(withUpdate[0]).toMatch(/w\."store_id" IS NOT NULL/);
    expect(withUpdate[1]).toMatch(/w\."store_id" IS NULL/);
    expect(withUpdate[1]).toMatch(/s\."countryId" = w\."countryId"/);
    for (const s of withUpdate.slice(1)) {
      expect(s).toMatch(/s\."is_test" = false/);
      expect(s).toMatch(/NOT EXISTS/);
      expect(s).toMatch(/o\."is_test" = false AND o\."id" <> s\."id"/);
    }
  });
});

// A model of the three rules, over fixtures. The text checks above keep it honest.
interface Store { id: string; companyId: string; countryId: string; isTest: boolean }
interface Wallet { id: string; companyId: string; countryId: string; storeId: string | null }
interface Exp { id: string; companyId: string; walletId: string | null; storeId: string | null }

function place(e: Exp, wallets: Wallet[], stores: Store[]): string | null {
  if (e.storeId) return e.storeId;
  const real = stores.filter((s) => s.companyId === e.companyId && !s.isTest);
  const w = wallets.find((x) => x.id === e.walletId && x.companyId === e.companyId);
  // 1. the wallet the money left belongs to a store
  if (w?.storeId) return w.storeId;
  // 2. an unplaced wallet whose country has exactly one real store
  if (w) {
    const inCountry = real.filter((s) => s.countryId === w.countryId);
    if (inCountry.length === 1) return inCountry[0].id;
  }
  // 3. a company with exactly one real store
  if (real.length === 1) return real[0].id;
  return null;
}

describe('the three placements, on fixtures', () => {
  const stores: Store[] = [
    { id: 'a', companyId: 'one', countryId: 'jo', isTest: false },
    { id: 'a-bench', companyId: 'one', countryId: 'jo', isTest: true },
    { id: 'b1', companyId: 'two', countryId: 'jo', isTest: false },
    { id: 'b2', companyId: 'two', countryId: 'sy', isTest: false },
    { id: 'b3', companyId: 'two', countryId: 'sy', isTest: false },
  ];
  const wallets: Wallet[] = [
    { id: 'w-placed', companyId: 'two', countryId: 'sy', storeId: 'b3' },
    { id: 'w-jo', companyId: 'two', countryId: 'jo', storeId: null },
    { id: 'w-sy', companyId: 'two', countryId: 'sy', storeId: null },
    { id: 'w-one', companyId: 'one', countryId: 'jo', storeId: null },
  ];
  const exp = (over: Partial<Exp>): Exp => ({ id: 'e', companyId: 'two', walletId: null, storeId: null, ...over });

  it('1 · the wallet knows its store — even in a company with several', () => {
    expect(place(exp({ walletId: 'w-placed' }), wallets, stores)).toBe('b3');
  });

  it('2 · an unplaced wallet whose country has exactly one real store', () => {
    expect(place(exp({ walletId: 'w-jo' }), wallets, stores)).toBe('b1');
  });

  it('NEGATIVE: an unplaced wallet in a country with TWO real stores is left alone — no guessing', () => {
    expect(place(exp({ walletId: 'w-sy' }), wallets, stores)).toBeNull();
  });

  it('3 · a company with one real store (a bench store does not make it two) owns every expense left', () => {
    expect(place(exp({ companyId: 'one', walletId: null }), wallets, stores)).toBe('a');
    expect(place(exp({ companyId: 'one', walletId: 'w-one' }), wallets, stores)).toBe('a');
  });

  it('NEGATIVE: with several real stores and no wallet to say, it stays unplaced', () => {
    expect(place(exp({ walletId: null }), wallets, stores)).toBeNull();
  });

  it('NEGATIVE: an expense that already has a store is never moved', () => {
    expect(place(exp({ storeId: 'b2', walletId: 'w-placed' }), wallets, stores)).toBe('b2');
  });

  it('NEGATIVE: a wallet of another company is not read', () => {
    expect(place(exp({ companyId: 'one', walletId: 'w-placed' }), wallets, stores)).toBe('a');
  });
});
