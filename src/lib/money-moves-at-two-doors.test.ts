import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { MOVEMENT_CATEGORIES } from './wallets';
import { stripComments } from './guard-source';

/**
 * تشطيب ٢ — PASS 3: «approve a settlement → wallet movement created ONLY
 * now?» — and the contract's own hard stop, «no fund movement before
 * settlement approval».
 *
 * The approval path is already tested thoroughly (finance-gates.test.ts): it
 * refuses an unmatched statement, an unexplained gap, a second approval, and
 * a status reset after the money moved. What none of that proves is the other
 * half of the sentence — that there is no SECOND path. A test of one door
 * says nothing about a door somebody adds beside it.
 *
 * So this sweeps instead of sampling: every row in `wallet_movements` is born
 * in one of four files, each named here with the reason it is allowed to
 * exist. A fifth fails this test, which is the point — a wallet movement is
 * money, and a new way to create one should be a decision, not a diff.
 */

const SRC = join(process.cwd(), 'src');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.tsx?$/.test(p) && !p.includes('.test.')) out.push(p);
  }
  return out;
}

const rel = (p: string) => `/${relative(process.cwd(), p).split('\\').join('/')}`;

/**
 * THE FOUR, AND WHY EACH IS ONE.
 *
 * `wallets.ts` owns the write — `recordMovement` is the function every other
 * door calls, and `reverseMovement` is the only way a movement is ever
 * undone (a new opposite row, never an edit to the original).
 *
 * The two routes write a movement directly rather than through
 * `recordMovement`, and that is worth knowing about rather than hiding:
 * `finance/route.ts` records an expense and the money leaving for it in one
 * transaction, and `pay-from-wallet.ts` pays a commission out.
 */
const ALLOWED = [
  '/src/lib/wallets.ts',
  '/src/lib/pay-from-wallet.ts',
  '/src/app/api/finance/route.ts',
];

describe('a wallet movement is born in a known place', () => {
  const writers = filesUnder(SRC)
    .filter((p) => /walletMovement\.create/.test(stripComments(readFileSync(p, 'utf8'))))
    .map(rel);

  it('finds the writers at all', () => {
    // A sweep over nothing passes everything inside it.
    expect(writers.length).toBeGreaterThanOrEqual(2);
    expect(writers).toContain('/src/lib/wallets.ts');
  });

  it('and every one of them is one of the four', () => {
    const strangers = writers.filter((w) => !ALLOWED.includes(w));
    expect(strangers, 'بابٌ جديدٌ يُنشئ حركةَ محفظة').toEqual([]);
  });
});

/**
 * «COURIER_SETTLEMENT» IS THE CATEGORY THE CONTRACT'S HARD STOP IS ABOUT.
 *
 * An EXPENSE movement is money leaving for a cost and has nothing to do with
 * a courier's cash; a TRANSFER moves money the company already holds. The
 * money a courier owes us becomes ours in exactly two circumstances, and
 * both are deliberate.
 */
const SETTLEMENT_DOORS = [
  // The statement, approved: the money moves inside the approval transaction
  // and after every gate in `approvalRefusal`.
  '/src/app/api/finance/statements/[id]/route.ts',
  // Cash handed over without a statement — a small courier, or our own agent.
  // Gated: delivered orders only, none already SETTLED, one currency, and a
  // wallet in that currency.
  '/src/app/api/ops/tracking/collect/route.ts',
];

describe('courier money becomes ours at two doors, and both are deliberate', () => {
  const doors = filesUnder(SRC)
    .filter((p) => stripComments(readFileSync(p, 'utf8')).includes("category: 'COURIER_SETTLEMENT'"))
    .map(rel);

  it('finds them', () => {
    expect(doors.sort()).toEqual([...SETTLEMENT_DOORS].sort());
  });

  it('the statement door moves the money only inside the approval', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/finance/statements/[id]/route.ts'), 'utf8'));
    // The gate comes first and returns on refusal …
    const refusal = src.indexOf('approvalRefusal(');
    const moved = src.indexOf("category: 'COURIER_SETTLEMENT'");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(moved);
    expect(src).toMatch(/if \(refusal\) return/);
    // … and the write is inside the same transaction that marks it APPROVED.
    const tx = src.indexOf('db.$transaction');
    expect(tx).toBeLessThan(moved);
    expect(src.slice(tx, moved)).toContain("status: 'APPROVED'");
  });

  it('the manual door refuses what is not delivered, and what is already settled', () => {
    const src = stripComments(readFileSync(join(process.cwd(), 'src/app/api/ops/tracking/collect/route.ts'), 'utf8'));
    const moved = src.indexOf("category: 'COURIER_SETTLEMENT'");
    const head = src.slice(0, moved);
    expect(head).toContain("settlementStatus === 'SETTLED'");
    expect(head).toContain("'NOT_DELIVERED'");
    expect(head).toContain('MIXED_CURRENCY');
  });
});

describe('a movement is undone by another movement', () => {
  const wallets = stripComments(readFileSync(join(process.cwd(), 'src/lib/wallets.ts'), 'utf8'));

  it('the original row is never updated or deleted', () => {
    // «VOID and reversing entries only» — nothing in the owner may edit a
    // movement that has been written.
    expect(wallets).not.toMatch(/walletMovement\.update/);
    expect(wallets).not.toMatch(/walletMovement\.delete/);
    expect(wallets).not.toMatch(/walletMovement\.updateMany/);
  });

  it('and the reversal is the opposite direction, linked, and refused twice', () => {
    const fn = wallets.slice(wallets.indexOf('export async function reverseMovement('));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toContain("direction: original.direction === 'IN' ? 'OUT' : 'IN'");
    expect(body).toContain('reversalOfId');
    // A reversing entry cannot itself be reversed, and nothing is reversed
    // twice — the second is held by a unique column as well as by this check.
    expect(body).toMatch(/original\.reversalOfId/);
    expect(body).toMatch(/already/);
  });

  it('and the amount is the original’s, not one the caller chose', () => {
    const fn = wallets.slice(wallets.indexOf('export async function reverseMovement('));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    expect(body).toContain('amount: original.amount');
    // Net effect zero depends on it: a reversal for a different amount is a
    // correction wearing the word «عكس».
    expect(body).not.toMatch(/amount: params\./);
  });
});

describe('the categories are a closed list', () => {
  it('so a movement cannot be filed under a word somebody invented', () => {
    expect([...MOVEMENT_CATEGORIES]).toContain('COURIER_SETTLEMENT');
    // 7 -> 8 on 13/11: `PARTNER_DRAW`, a partner's withdrawal («السحوبات لازم تنضاف بند»), written by its own door through `recordMovement`.
    expect([...MOVEMENT_CATEGORIES]).toHaveLength(8);
  });

  it('and every category a door actually writes is in the list', () => {
    const used = new Set<string>();
    for (const p of filesUnder(SRC)) {
      const src = stripComments(readFileSync(p, 'utf8'));
      for (const m of src.matchAll(/category: '([A-Z_]+)'/g)) {
        // Movement categories live beside a wallet write; other `category:`
        // fields (an expense's, a product's) are not this list.
        if (/walletMovement|recordMovement|MovementInput/.test(src)) used.add(m[1]);
      }
    }
    const strangers = [...used].filter((c) => !(MOVEMENT_CATEGORIES as readonly string[]).includes(c));
    expect(strangers, 'تصنيفُ حركةٍ خارج القائمة').toEqual([]);
    expect(used.size).toBeGreaterThan(0);
  });
});
