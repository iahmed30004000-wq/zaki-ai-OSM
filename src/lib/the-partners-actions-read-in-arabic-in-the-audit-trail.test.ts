import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeAction, entityLabel } from './audit-view';
import { stripComments } from './guard-source';

/**
 * WHAT THE PARTNERS' DOORS WRITE TO THE AUDIT TRAIL READS IN ARABIC (13/11).
 *
 * Saving the partners and recording a partner's draw are money events, and the audit screen is where the owner reads who did them.
 * `describeAction` falls back to the raw code when it has no words — «PARTNER_DRAW_RECORDED» in capitals on an Arabic screen — and the
 * entity column does the same with «Partner». A deliberate break that deleted both labels went unnoticed by the older audit guard, so
 * the words are pinned here, and every action the partners' doors write is swept for having them.
 */

const root = process.cwd();
const DOORS = [
  'src/app/api/finance/partners/route.ts',
  'src/app/api/finance/partners/draws/route.ts',
];
const ARABIC = /[؀-ۿ]/;

describe('the partners’ actions are said in Arabic', () => {
  it('saving the partners and their shares', () => {
    expect(describeAction('PARTNERS_SAVED', 'Partner')).toBe('حفظ الشركاء ونسبهم');
  });

  it('recording a partner’s draw', () => {
    expect(describeAction('PARTNER_DRAW_RECORDED', 'WalletMovement')).toBe('تسجيل سحب شريك');
  });

  it('taking one back is the wallet’s own reversal, which already has its words', () => {
    expect(describeAction('WALLET_MOVEMENT_REVERSED', 'WalletMovement')).toBe('عكس حركة محفظة');
  });

  it('the record kind of the shares’ row is «شريك», not the English name', () => {
    expect(entityLabel('Partner')).toBe('شريك');
    expect(entityLabel('WalletMovement')).toBe('حركة محفظة');
  });

  it('SWEEP: every action a partners’ door writes has Arabic words of its own — none falls back to its code', () => {
    const written = DOORS.flatMap((file) =>
      [...stripComments(readFileSync(join(root, file), 'utf8')).matchAll(/action:\s*'([A-Z_]+)'/g)].map((m) => ({ file, action: m[1] }))
    );
    expect(written.map((w) => w.action).sort(), 'the sweep found the two actions').toEqual(['PARTNERS_SAVED', 'PARTNER_DRAW_RECORDED']);
    for (const { file, action } of written) {
      const said = describeAction(action, 'Partner');
      expect(said, `${file}: ${action}`).not.toBe(action);
      expect(said, `${file}: ${action}`).toMatch(ARABIC);
      expect(said, `${file}: ${action}`).not.toMatch(/[A-Za-z]{2,}/);
    }
  });
});
