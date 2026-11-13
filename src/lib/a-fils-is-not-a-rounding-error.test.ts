import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A FILS IS NOT A ROUNDING ERROR.
 *
 * Twenty-seven money columns were stored with TWO decimal places while this
 * product serves Jordan, whose dinar has THREE (`countries.minorUnit = 3`).
 *
 * PROVED IN POSTGRES ITSELF, not reasoned about:
 *
 *     select 2.555::numeric(12,2), 2.555::numeric(14,3);
 *      →         2.56                     2.555
 *
 * Five fils lost on the way INTO the column, every time, silently.
 *
 * AND THE SCREENS WERE ALREADY RIGHT, which made it worse rather than
 * better. `money-decimals.test.ts` holds every screen to the currency's own
 * decimals, so a JOD figure was printed with three confident digits — the
 * last of them invented by a rounding nobody chose. The screen said
 * `2.560`; the truth had been `2.555`; and the figure it would be
 * reconciled against was rounded before anybody could see it.
 *
 * ── WHY THIS GUARD IS A WALK AND NOT A LIST ──
 *
 * The twenty-seventh column is the whole lesson. A sweep over
 * `Decimal(12, 2)` found twenty-six and passed straight over
 * `campaigns.spend`, which was `Decimal(14, 2)` — fourteen digits and two
 * decimals is still two decimals. A list of column names would have had
 * the same hole and kept it.
 *
 * So this reads the SCHEMA and holds every money column to the rule, and
 * the next one is covered on the day it is written.
 */

const root = process.cwd();
const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');

/**
 * THE WIDEST CURRENCY THE PRODUCT SERVES.
 *
 * Measured on this database: الأردن JOD 3, سوريا USD 2, ليبيا LYB 2. A
 * column shared by all three must hold the widest, because one column
 * stores every country's money.
 *
 * Three and not «the maximum of whatever is in the countries table»: a
 * column cannot be widened per row, and a test that read the live data
 * would pass on a database that happened to have no Jordanian store today
 * and fail the morning one was added.
 */
const WIDEST_MINOR_UNIT = 3;

interface Column {
  model: string;
  field: string;
  precision: number;
  scale: number;
  line: number;
}

function decimalColumns(): Column[] {
  const out: Column[] = [];
  let model = '';
  const lines = schema.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const m = /^model (\w+) \{/.exec(line);
    if (m) model = m[1];
    const d = /@db\.Decimal\((\d+),\s*(\d+)\)/.exec(line);
    if (d) {
      const field = line.trim().split(/\s+/)[0];
      out.push({ model, field, precision: Number(d[1]), scale: Number(d[2]), line: i + 1 });
    }
  }
  return out;
}

/**
 * A RATE IS NOT AN AMOUNT.
 *
 * `exchangeRate` is a ratio, not money: it needs MORE decimals than any
 * currency (six), and asking it to be «at least three» is already true.
 * It is named here so the rule below is about AMOUNTS, and so that a
 * future rate cannot be waved through by being vaguely numeric.
 */
const RATES = new Set(['exchangeRate']);

/**
 * A PERCENT IS NOT AN AMOUNT EITHER (13/11).
 *
 * `Partner.sharePercent` is a partner's share of the net profit — 15, 55, 33.33 — a ratio of a hundred, not a quantity of any
 * currency. It needs two decimals and three digits, not a fils and eleven integer digits, and `Decimal(5,2)` is exactly that: the
 * door refuses a third decimal and the migration holds 0 < x ≤ 100 with a CHECK. Named here, by model AND field so no future column
 * is waved through by a vague name, and held to what a percent needs by its own test below. It is exempt from the three rules that
 * are about AMOUNTS (the fils, the integer digits, and the migration walk), and from nothing else.
 */
const PERCENTS = new Set(['Partner.sharePercent']);
const isPercent = (c: { model: string; field: string }) => PERCENTS.has(`${c.model}.${c.field}`);

describe('every money column holds a fils', () => {
  const columns = decimalColumns();

  it('finds them — a sweep over nothing proves nothing', () => {
    expect(columns.length, 'لا عمودَ عشريٍّ في المخطَّط — المسحُ عمي').toBeGreaterThanOrEqual(40);
    // And it really is reading the shape, not just counting lines.
    expect(columns.some((c) => c.model === 'Order' && c.field === 'collectedAmount')).toBe(true);
  });

  it('and not one of them stores fewer decimals than the dinar has', () => {
    /*
     * THE RULE, AND IT IS ABOUT THE COLUMN RATHER THAN THE SCREEN. A screen
     * can print three decimals of a value that only ever had two; the
     * column is where the third one is lost.
     */
    const thin = columns
      .filter((c) => !RATES.has(c.field) && !isPercent(c))
      .filter((c) => c.scale < WIDEST_MINOR_UNIT)
      .map((c) => `${c.model}.${c.field}  (${c.precision},${c.scale})  schema.prisma:${c.line}`);
    expect(
      thin,
      `عمودُ مالٍ بمنازلَ أقلَّ من الدينار — الفلسُ يُفقَدُ عند الكتابة:\n${thin.join('\n')}`
    ).toEqual([]);
  });

  it('and the precision leaves room for the scale', () => {
    // `numeric(3,3)` can hold nothing but a fraction. Not a real risk, and
    // a floor worth stating once: eleven integer digits is a hundred
    // billion, which is past any currency this product will meet.
    for (const c of columns.filter((x) => !isPercent(x))) {
      expect(c.precision - c.scale, `${c.model}.${c.field}`).toBeGreaterThanOrEqual(8);
    }
  });

  it('and a PERCENT is held to what a percent needs: two decimals, room for a hundred — and it is really a column', () => {
    const percents = columns.filter(isPercent);
    expect(percents.length, 'no percent column in the schema — the list above is dead').toBe(PERCENTS.size);
    for (const c of percents) {
      expect(c.scale, `${c.model}.${c.field}`).toBeGreaterThanOrEqual(2);
      // three integer digits hold 100.00; fewer would not
      expect(c.precision - c.scale, `${c.model}.${c.field}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('and a RATE is allowed more, because a ratio is not an amount', () => {
    const rates = columns.filter((c) => RATES.has(c.field));
    expect(rates.length, 'لا سعرَ صرفٍ في المخطَّط — القائمةُ أعلاه ميتة').toBeGreaterThan(0);
    for (const r of rates) {
      expect(r.scale, `${r.model}.${r.field}`).toBeGreaterThanOrEqual(WIDEST_MINOR_UNIT);
    }
  });
});

describe('and the migration that widened them cannot lose a value', () => {
  const dir = 'prisma/migrations/20261011030000_money_holds_three_decimals';
  const sql = readFileSync(join(root, dir, 'migration.sql'), 'utf8');
  const statements = sql.replace(/^\s*--.*$/gm, '');

  it('only ever widens — never narrows, never drops', () => {
    /*
     * Widening is not a conversion: every value in `numeric(12,2)` is
     * exactly representable in `numeric(14,3)`. The reverse would round,
     * and rounding on a migration is a loss nobody can find afterwards.
     */
    expect(statements).toMatch(/TYPE numeric\(14,3\)/);
    expect(statements, 'الترحيلُ يُضيِّقُ عموداً').not.toMatch(/numeric\(\d+,[012]\)/);
    expect(statements, 'الترحيلُ يَحذِف').not.toMatch(/\bDROP\b|\bDELETE\b|TRUNCATE|\bNOT NULL\b/i);
  });

  it('and names every column the DATABASE uses, not every field Prisma shows', () => {
    /*
     * THE MISTAKE THIS CAUGHT. `payslips` is snake_case in the database —
     * `penalty_total`, `net_amount`, `carried_over` — and the first draft
     * wrote the Prisma FIELD names. The migration would have failed on the
     * first of them.
     *
     * Found by asking `information_schema.columns`, which is a question
     * about the thing itself rather than about the file describing it.
     */
    for (const col of ['penalty_total', 'net_amount', 'carried_over', 'salary_amount', 'period_cap']) {
      expect(statements, `الترحيلُ لا يَذكُرُ ${col}`).toContain(`"${col}"`);
    }
    for (const wrong of ['penaltyTotal', 'netAmount', 'carriedOver', 'salaryAmount', 'periodCap']) {
      expect(statements, `الترحيلُ يَستعمِلُ اسمَ حقلِ Prisma: ${wrong}`).not.toContain(`"${wrong}"`);
    }
  });

  it('and includes the twenty-seventh column the sweep almost missed', () => {
    // `campaigns.spend` was `Decimal(14, 2)`. Fourteen digits and two
    // decimals is still two decimals, and a search for `(12, 2)` passed
    // straight over it.
    expect(statements).toMatch(/ALTER TABLE "campaigns"[\s\S]{0,120}"spend" TYPE numeric\(14,3\)/);
  });

  it('and groups one ALTER per table, so each is rewritten once', () => {
    // Postgres rewrites a table per statement, not per column. Twelve
    // statements against `orders` would be twelve rewrites.
    const tables = [...statements.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(tables).size, 'جدولٌ يُعاد بناؤُه أكثرَ من مرّة').toBe(tables.length);
  });
});

describe('and no migration after this one may narrow money again', () => {
  /**
   * A WALK OVER THE MIGRATIONS, so the rule survives the next hand.
   *
   * The schema is what the code reads, and a migration is what the database
   * obeys — and they can disagree for exactly as long as nobody looks. A
   * migration that writes `numeric(x,2)` onto a money column would leave
   * the schema saying three and the column storing two, which is the
   * silent state this whole item was about.
   */
  const dir = join(root, 'prisma/migrations');
  const files = readdirSync(dir)
    .filter((d) => /^\d{14}_/.test(d))
    .map((d) => ({ name: d, sql: (() => { try { return readFileSync(join(dir, d, 'migration.sql'), 'utf8'); } catch { return ''; } })() }));

  it('walks every migration', () => {
    expect(files.length, 'لا ترحيلاتٍ — المسحُ عمي').toBeGreaterThan(90);
  });

  it('and none AFTER the widening sets a money column to two decimals', () => {
    const CUTOFF = '20261011030000_money_holds_three_decimals';
    const after = files.filter((f) => f.name > CUTOFF);
    const offenders: string[] = [];
    for (const f of after) {
      const code = f.sql.replace(/^\s*--.*$/gm, '');
      // The column a type is written for: the quoted name just before it. A PERCENT column is named in PERCENTS (by model.field) and
      // is not money — the one place a two-decimal type is right, and only for the names listed there.
      const columnOf = (at: number) => /"(\w+)"\s*$/.exec(code.slice(Math.max(0, at - 80), at))?.[1];
      const isAPercent = (at: number) => {
        const col = columnOf(at);
        return !!col && [...PERCENTS].some((p) => p.endsWith(`.${col}`));
      };
      for (const m of code.matchAll(/numeric\((\d+),\s*([012])\)/g)) {
        if (!isAPercent(m.index!)) offenders.push(`${f.name}: numeric(${m[1]},${m[2]})`);
      }
      for (const m of code.matchAll(/DECIMAL\((\d+),\s*([012])\)/gi)) {
        if (!isAPercent(m.index!)) offenders.push(`${f.name}: DECIMAL(${m[1]},${m[2]})`);
      }
    }
    expect(
      offenders,
      `ترحيلٌ بعدَ التوسيعِ يُعيدُ عمودَ مالٍ إلى منزلتَين:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
