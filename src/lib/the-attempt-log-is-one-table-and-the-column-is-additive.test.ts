import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * DEFINITION OF DONE — ONE ATTEMPT LOG, AND AN ADDITIVE COLUMN (Confirmation Center v2, step A; the planner’s rulings, 15/11/2026)
 *
 *  1. `OrderContactAttempt` is the live attempt log. `CallLog` is marked LEGACY where it is declared, and nothing but its one old door
 *     (`/api/orders/[id]/call-logs`) writes it — step A, and every step after it, never fills it.
 *  2. The new column `durationSeconds` is one NULLABLE integer on `order_contact_attempts`: no default, no backfill, nothing dropped, an idempotent ALTER, and a rollback beside it.
 *  3. The switch lives in `Company.settings` (no column): the migration touches no other table.
 *
 * Read from the files themselves, so a later edit that breaks the promise breaks this test.
 * ═══════════════════════════════════════════════════════════════════════
 */

const root = path.resolve(__dirname, '..', '..');
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = ['prisma', 'migrations', '20261115120000_contact_attempt_duration'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('CallLog is legacy', () => {
  it('is declared under a LEGACY block that names the live table', () => {
    const schema = read('prisma', 'schema.prisma');
    const at = schema.indexOf('model CallLog {');
    expect(at).toBeGreaterThan(0);
    const above = schema.slice(Math.max(0, at - 700), at);
    expect(above).toContain('/// LEGACY');
    expect(above).toContain('OrderContactAttempt');
  });

  it('is written by exactly one door: the old call-logs route (tests and the schema aside)', () => {
    const writers = walk(path.join(root, 'src'))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .filter((f) => /\bcallLog\.(create|createMany|upsert|update|updateMany)\b/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(root, f).replace(/\\/g, '/'));
    expect(writers).toEqual(['src/app/api/orders/[id]/call-logs/route.ts']);
  });
});

describe('the duration column', () => {
  it('is one nullable integer on the attempt, described as a record and not a rule', () => {
    const schema = read('prisma', 'schema.prisma');
    const model = schema.slice(schema.indexOf('model OrderContactAttempt {'), schema.indexOf('@@map("order_contact_attempts")'));
    expect(model).toMatch(/\n {2}durationSeconds Int\?\n/);
    expect(model).toContain('NULL means «not measured», never zero');
  });

  it('is added by one idempotent ALTER — nullable, no default, no backfill, nothing dropped, no other table', () => {
    const sql = read(...MIGRATION, 'migration.sql')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(sql.replace(/\s+/g, ' ').trim()).toBe('ALTER TABLE "order_contact_attempts" ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER;');
    expect(sql).not.toMatch(/NOT NULL|DEFAULT|DROP|UPDATE|DELETE|INSERT/i);
  });

  it('has a rollback beside it that drops only that column and forgets only that migration', () => {
    const sql = read(...MIGRATION, 'rollback.sql')
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .replace(/\s+/g, ' ')
      .trim();
    expect(sql).toBe(
      'ALTER TABLE "order_contact_attempts" DROP COLUMN IF EXISTS "durationSeconds"; DELETE FROM "_prisma_migrations" WHERE "migration_name" = \'20261115120000_contact_attempt_duration\';'
    );
  });
});
