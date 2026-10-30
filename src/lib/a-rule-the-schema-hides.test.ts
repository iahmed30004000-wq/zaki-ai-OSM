import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * تشطيب ٢ — PASS 3: «run a scheduled job twice → no duplicate side effect».
 *
 * THE RULE THIS FILE HOLDS: a constraint the DATABASE enforces must be
 * findable in the schema, by name.
 *
 * Six of this system's cascade guarantees are PARTIAL unique indexes — «one
 * period commission per person, per rule, per span», «one live penalty per
 * person, per kind, per day», «a hostname belongs to whoever proved it». A
 * partial unique index is the right tool and Prisma cannot express one, so
 * each lives in raw SQL inside a migration.
 *
 * WHICH MEANS NONE OF THEM APPEARS IN `schema.prisma`, and the model is what
 * a person reads. Auditing the commission job, I read `CommissionEntry`, saw
 * `@@unique([orderId, userId, status])`, noted that a period entry has
 * `orderId` NULL and that Postgres counts every NULL as distinct, and
 * concluded the hourly accrual could pay a person twice. I wrote the
 * migration. The index already existed, under a name the schema never
 * mentions, and was stricter than mine.
 *
 * A second constraint doing one job is the defect this audit hunts, and I
 * came one command from shipping it. So the names are in the schema now, and
 * this keeps them there.
 */

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');

/** Every `CREATE UNIQUE INDEX … WHERE …` this repository has ever written. */
function partialUniqueIndexes(): { name: string; migration: string }[] {
  /*
   * THE MIGRATIONS ARE A HISTORY, NOT A SET.
   *
   * `nav_arrangements_role_key` was created in one migration and dropped
   * in a later one, when the arrangement gained a surface and the key had
   * to include it. It exists in no database that has run both — so
   * demanding the schema still name it would be demanding a comment about
   * a rule nothing enforces, and the only way to pass would be to describe
   * an index that is gone.
   *
   * Read in directory order, which is timestamp order, and a `DROP INDEX`
   * removes what an earlier one added.
   */
  const live = new Map<string, string>();
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue; // migration_lock.toml and the like
    }
    /*
     * IN THE ORDER THE FILE SAYS THEM. A migration may drop an index and create it again under the same name
     * (a partial index cannot be altered, only replaced — `20261029120000_shortfall_penalty` narrows
     * `penalties_one_live_per_day` that way), so all the creates first and all the drops after would delete
     * the very index the file just made.
     */
    const events: { at: number; name: string; create: boolean; partial: boolean }[] = [];
    const re = /CREATE UNIQUE INDEX(?:\s+IF NOT EXISTS)?\s+"([^"]+)"([\s\S]{0,400}?);/g;
    for (const m of sql.matchAll(re)) {
      events.push({ at: m.index ?? 0, name: m[1], create: true, partial: /\bWHERE\b/i.test(m[2]) });
    }
    for (const m of sql.matchAll(/DROP INDEX(?:\s+IF EXISTS)?\s+"([^"]+)"/g)) {
      events.push({ at: m.index ?? 0, name: m[1], create: false, partial: false });
    }
    for (const e of events.sort((a, b) => a.at - b.at)) {
      if (!e.create) live.delete(e.name);
      else if (e.partial) live.set(e.name, dir);
    }
  }
  return [...live].map(([name, migration]) => ({ name, migration }));
}

describe('a rule the database keeps, the schema names', () => {
  const indexes = partialUniqueIndexes();

  it('finds the partial unique indexes at all', () => {
    // A sweep over nothing passes every assertion inside it. These six are
    // the ones that existed when this was written; the number may grow.
    expect(indexes.length).toBeGreaterThanOrEqual(6);
    const names = indexes.map((i) => i.name);
    for (const must of [
      'commission_entries_period_key',
      'penalties_one_live_per_day',
      'telegram_sources_chatId_group_unique',
    ]) {
      expect(names, must).toContain(must);
    }
  });

  it('every one of them is named in schema.prisma', () => {
    const missing = indexes.filter((i) => !schema.includes(i.name));
    expect(
      missing.map((m) => `${m.name} — ${m.migration}`),
      'قيدٌ تحفظه قاعدة البيانات ولا يذكره المخطّط'
    ).toEqual([]);
  });

  it('and the two that guard a job running twice say what they guard', () => {
    // Not just the name: the reason, beside the model, because the reason is
    // what stops the next person reasoning their way to a duplicate.
    const commission = schema.slice(schema.indexOf('model CommissionEntry'));
    const block = commission.slice(0, commission.indexOf('\nmodel '));
    expect(block).toContain('commission_entries_period_key');
    /*
     * THE EXACT TRAP, NOT THE WORD «NULL».
     *
     * This asked only that the block matched /NULL/, and the model mentions
     * NULL elsewhere — so a mutation that deleted the whole explanation and
     * left «It stops a double accrual.» passed. The sentence has to say the
     * two things that mislead a reader: that `@@unique` does NOT cover this
     * case, and why — a period entry's `orderId` is null.
     */
    expect(block).toMatch(/@@unique above[\s\S]{0,80}does NOT cover/);
    expect(block).toMatch(/orderId` NULL/);

    const penalty = schema.slice(schema.indexOf('/// ALSO HELD BY THE DATABASE: `penalties_one_live_per_day`'));
    expect(penalty.slice(0, penalty.indexOf('model Penalty'))).toMatch(/twice/);
  });
});

describe('the jobs that may run twice', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

  it('the per-order accrual skips what it has already accrued', () => {
    // Idempotent by its QUERY, not by a constraint — and that is enough here,
    // because it asks for orders that have no commission at all.
    const defs = read('src/lib/jobs/definitions/accrue-commission.ts');
    const job = defs.slice(defs.indexOf("name: 'accrue-commission'"));
    expect(job.slice(0, job.indexOf('\n};'))).toContain('commissions: { none: {} }');
  });

  it('the per-order accrual never takes imported history into its batch', () => {
    // A legacy order never accrues (no moderator, no confirmer), so without
    // this it stays «no commission» forever and crowds the 500-row batch.
    const defs = read('src/lib/jobs/definitions/accrue-commission.ts');
    const job = defs.slice(defs.indexOf("name: 'accrue-commission'"));
    expect(job.slice(0, job.indexOf('\n};'))).toContain("source: { not: 'Legacy import' }");
    // the mark the job excludes is the mark the import writes
    expect(read('scripts/migration/run.mjs')).toContain("source: 'Legacy import'");
  });

  it('the period accrual checks before it writes, AND the database refuses a race', () => {
    // The check alone is a read followed by a write. The job runs hourly over
    // the same closed span, and a forced manual run bypasses the runner's
    // lock — so two could read «no entry» in the same second. The index is
    // what makes that a loud failure instead of a double payment.
    const period = read('src/lib/commission-period.ts');
    expect(period).toContain('status: { in: [');
    /*
     * BOTH OCCURRENCES, AND THAT IS THE POINT.
     *
     * `periodStart: params.start` appears twice — once in the WHERE that asks
     * «have I accrued this span already», once in the row that records which
     * span was accrued. They have to be the same span or the check asks about
     * one thing and the write records another. A `toMatch` was satisfied by
     * either, so breaking one went unnoticed.
     */
    expect(period.match(/periodStart: params\.start/g) ?? []).toHaveLength(2);
    expect(schema).toContain('commission_entries_period_key');
  });

  it('and the penalty proposer lets the database refuse, rather than asking first', () => {
    const service = read('src/lib/penalty-service.ts');
    const fn = service.slice(service.indexOf('export async function recordProposals'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    // No read-before-write at all: it writes and swallows the violation.
    expect(body).toContain('catch');
    expect(body).not.toMatch(/findFirst|findMany/);
  });
});
