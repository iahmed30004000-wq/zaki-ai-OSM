import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { stripComments } from './guard-source';

/**
 * A CANCELLED EXPENSE COSTS NOTHING, A STORE PAYS ONLY ITS OWN, AND THE MONEY AND THE MARK TRAVEL TOGETHER.
 *
 * Three facts that are cheap to break by adding one more query:
 *
 *   1. every read of the expenses table says which expenses count — through `expensesOf`, the one definition
 *      (this store's, the old store-less ones, never a cancelled one) — or is on a closed list with its reason;
 *   2. every caller of the two functions that cancel an expense runs them inside a transaction, because the
 *      cancelled mark and the reversing wallet entry are one fact;
 *   3. inside `reverseMovement` the expense is marked BEFORE the reversing entry is written, so a refused mark
 *      leaves the wallet untouched even for a caller that forgot the transaction.
 */

const SRC = join(process.cwd(), 'src');
const rel = (p: string) => relative(SRC, p).split(sep).join('/');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const all = filesUnder(SRC).map((p) => ({ file: rel(p), src: stripComments(readFileSync(p, 'utf8')) }));

/** The arguments of a call, brace-counted from its opening bracket. */
function argsAt(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

const READ = /\bexpense\.(findMany|findFirst|aggregate|groupBy|count)\(/g;

/** Reads that do not subtract anything from a profit — each with the reason, and the number of sites it covers. */
const NOT_A_PROFIT_READ: Record<string, { reason: string; sites: number }> = {
  'app/api/finance/wallets/[id]/route.ts': { reason: 'يعدّ المصاريف المربوطة بمحفظة ليقرّر هل تُحذف — مفتاحٌ أجنبي لا رقمٌ يُعرض', sites: 1 },
  'lib/expense-void.ts': { reason: 'يقرأ المصروف ليرفضه بسببه الصحيح (غير موجود، ملغى من قبل) قبل أن يلغيه', sites: 1 },
  'lib/wallets.ts': { reason: 'يقرأ صفَّ المصروف بعد فشل التعليم ليقول هل هو ملغى أم ليس لهذه الحركة', sites: 1 },
};

describe('every read of the expenses table says which expenses count', () => {
  const sites = all.flatMap(({ file, src }) =>
    [...src.matchAll(READ)].map((m) => ({ file, call: m[1], args: argsAt(src, m.index! + m[0].length - 1) }))
  );

  it('finds them — a sweep that counts nothing proves nothing', () => {
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('NEGATIVE: each one goes through expensesOf, or is on the closed list', () => {
    const stray = sites.filter((s) => !(s.file in NOT_A_PROFIT_READ) && !/\bexpensesOf\(/.test(s.args));
    expect(stray.map((s) => `${s.file}  expense.${s.call}`), 'قراءةُ مصاريفَ لا تقول أيَّها يُحسب').toEqual([]);
  });

  it('and no excused file grew another read under cover of its excuse', () => {
    const counted = new Map<string, number>();
    for (const s of sites) counted.set(s.file, (counted.get(s.file) ?? 0) + 1);
    for (const [file, excuse] of Object.entries(NOT_A_PROFIT_READ)) {
      expect(counted.get(file) ?? 0, file).toBe(excuse.sites);
      expect(excuse.reason.length, file).toBeGreaterThan(20);
    }
  });

  it('only the expense LIST asks for the cancelled ones', () => {
    const asking = all.filter(({ src }) => /withCancelled:\s*true/.test(src)).map((f) => f.file);
    expect(asking).toEqual(['app/api/finance/route.ts']);
    const route = all.find((f) => f.file === 'app/api/finance/route.ts')!.src;
    // …and the total beside the list is summed from the live rows only.
    expect(route).toMatch(/const liveExpenses = expenses\.filter\(\(e\) => !e\.voidedAt\)/);
    expect(route).toMatch(/const totalOperationalExpenses = liveExpenses\.reduce/);
  });

  it('no raw SQL reads the expenses table without leaving the cancelled out', () => {
    const raw = all.filter(({ src }) => /\$queryRaw|\$executeRaw/.test(src) && /\bFROM\s+"?expenses"?/i.test(src));
    for (const f of raw) expect(f.src, f.file).toMatch(/voided_at IS NULL/);
  });

  it('every expense is WRITTEN with the store it was recorded in', () => {
    const creates = all.filter(({ src }) => /\bexpense\.create\(/.test(src));
    expect(creates.map((c) => c.file)).toEqual(['app/api/finance/route.ts']);
    const src = creates[0].src;
    const at = src.indexOf('expense.create(');
    expect(argsAt(src, src.indexOf('(', at))).toMatch(/\bstoreId\b/);
  });
});

describe('the cancelled mark and the reversing entry are one fact', () => {
  const callers = (name: string) =>
    all
      .filter(({ file }) => !['lib/wallets.ts', 'lib/expense-void.ts'].includes(file))
      .flatMap(({ file, src }) => [...src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map((m) => ({ file, src, at: m.index! })));

  it.each(['reverseMovement', 'cancelExpense'])('every caller of %s runs it on the transaction client', (name) => {
    const found = callers(name);
    expect(found.length, `لا مُستدعٍ لـ${name}`).toBeGreaterThan(0);
    for (const c of found) {
      const before = c.src.slice(Math.max(0, c.at - 120), c.at + name.length + 6);
      expect(before, `${c.file}: ${name} خارج معاملة`).toMatch(
        new RegExp(`\\$transaction\\(\\s*(?:async\\s*)?\\(tx\\)\\s*=>\\s*(?:\\{\\s*(?:return\\s+)?)?${name}\\(tx\\b`)
      );
    }
  });

  it('inside reverseMovement the expense is marked before the reversing entry is created', () => {
    const wallets = all.find((f) => f.file === 'lib/wallets.ts')!.src;
    const fn = wallets.slice(wallets.indexOf('export async function reverseMovement('));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    const mark = body.indexOf('markExpenseVoided(');
    const create = body.indexOf('walletMovement.create(');
    expect(mark).toBeGreaterThan(-1);
    expect(mark).toBeLessThan(create);
    // …and an expense’s movement cannot be reversed by a caller that did not say it may cancel the expense.
    expect(body).toMatch(/if \(!params\.mayCancelExpense\) throw new ExpenseRefused\('NOT_ALLOWED'\)/);
  });

  it('the mark is ONE conditional write: this expense, this movement, not yet cancelled', () => {
    const wallets = all.find((f) => f.file === 'lib/wallets.ts')!.src;
    expect(wallets).toMatch(/expense\.updateMany\(\{\s*where: \{ id: p\.expenseId, companyId: p\.companyId, movementId: p\.movementId, voidedAt: null \}/);
  });

  it('and nothing ever deletes an expense', () => {
    for (const { file, src } of all) expect(src, file).not.toMatch(/\bexpense\.(delete|deleteMany)\(/);
  });
});
