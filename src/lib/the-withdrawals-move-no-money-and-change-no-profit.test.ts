import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './guard-source';

/**
 * «المسحوبات» (22/11) IS A RECORD — read off the source.
 *
 *   · the new modules import nothing that moves a wallet or writes an expense, and write only their own two tables;
 *   · the profit and the partners' statement do not read them: their figures are what they were (the golden and statement tests
 *     beside them are unchanged, and none of their files is edited by this work);
 *   · a withdrawal is never edited or deleted — only created; a standing amount may be cleared (it is a setting, not money).
 *
 * 23/11 (F7): a withdrawal is now a wallet movement, written ONLY by the draws door (`/api/finance/partners/draws`, lib/wallets
 * `recordMovement`). These modules still move no money themselves: the dashboard reads the movements, the tab's press asks the draws
 * door over the network, and the lib writes nothing but the standing amounts.
 */

const root = process.cwd();
const src = (rel: string) => stripComments(readFileSync(join(root, rel), 'utf8'));
const NEW = [
  'src/lib/partner-withdrawals.ts',
  'src/lib/partner-withdrawals-core.ts',
  'src/app/api/finance/partners/withdrawals/route.ts',
  'src/components/screens/finance/WithdrawalsSection.tsx',
];
const PROFIT_AND_STATEMENT = [
  'src/lib/profit-to-date.ts',
  'src/lib/profit-summary.ts',
  'src/lib/partner-statement.ts',
  'src/lib/partner-statement-core.ts',
  'src/app/api/finance/route.ts',
  'src/app/api/finance/partners/statement/route.ts',
];

describe('a withdrawal moves no money', () => {
  it.each(NEW)('%s imports nothing of the wallets, the expenses or the profit', (file) => {
    const s = src(file);
    const imports = [...s.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const i of imports) {
      expect(i, `${file} → ${i}`).not.toMatch(/wallet|pay-from-wallet|expense|profit|partner-statement|commission|settlement/i);
    }
    expect(s).not.toMatch(/\b(walletMovement|wallet|expense|walletTransfer)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(s).not.toMatch(/recordMovement|reverseMovement/);
  });

  /*
   * 23/11 (F7) — UPDATED. Old: the lib wrote `partnerWithdrawal.create` (the record) and the standing amounts. New: the lib writes
   * ONLY the standing amounts — a withdrawal is a wallet movement written by the draws door, and the old record is never written
   * again (its two doors are retired). Why: «والحركات تكون من المحافظ … خلص مكان واحد».
   */
  it('the new modules write only the standing amounts — the old record is never written again', () => {
    const lib = src('src/lib/partner-withdrawals.ts');
    const writes = [...lib.matchAll(/\b(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(w).toMatch(/^partnerStandingAmount\.(upsert|deleteMany)$/);
    expect(lib).not.toMatch(/partnerWithdrawal\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(src('src/app/api/finance/partners/withdrawals/route.ts')).not.toMatch(/partnerWithdrawal/);
    expect(lib).not.toMatch(/\$executeRaw/);
  });

  it('NEGATIVE: the sweep would see a delete of a withdrawal — the check itself can see one', () => {
    const wrong = 'await tx.partnerWithdrawal.delete({ where: { id } });';
    expect(wrong).toMatch(/partnerWithdrawal\.(update|updateMany|upsert|delete|deleteMany)\(/);
  });

  it('the door writes through the lib only', () => {
    const route = src('src/app/api/finance/partners/withdrawals/route.ts');
    expect(route).not.toMatch(/\bdb\./);
    expect(route).not.toMatch(/\.(create|update|upsert|delete)\(/);
  });
});

describe('the profit and the partners’ statement do not read the withdrawals', () => {
  it.each(PROFIT_AND_STATEMENT)('%s never names the new tables', (file) => {
    const s = src(file);
    expect(s).not.toMatch(/partnerWithdrawal|partnerStandingAmount|partner_withdrawals|partner-withdrawals/);
  });
});
