import { describe, expect, it } from 'vitest';
import { readTransferReversals, TRANSFER_STATE_AR, type TransferLeg } from './transfer-reversal';

/**
 * «القيد العكسي ما بيسمع بالتحويلات» — what the history says of a transfer is READ FROM ITS LEGS.
 *
 * A reversing entry is one more movement carrying the transfer's reference and pointing at the leg it undoes, so the
 * state of a transfer is a question about its legs: nothing reversed (ساري), one leg (معكوس جزئياً), both (معكوس). Read
 * from the movements, the list can never disagree with the ledger — whoever reversed a leg, from whichever screen.
 */

const at = (minute: number) => new Date(2026, 10, 14, 21, minute, 0);
const leg = (id: string, referenceId: string, walletId: string): TransferLeg => ({
  id, referenceId, walletId, reversalOfId: null, reversalReason: null, createdAt: at(27), createdById: 'u1',
});
const undo = (id: string, of: string, referenceId: string, walletId: string, reason: string, minute: number, by = 'u2'): TransferLeg => ({
  id, referenceId, walletId, reversalOfId: of, reversalReason: reason, createdAt: at(minute), createdById: by,
});

const OUT = leg('out', 't1', 'sham');
const IN = leg('in', 't1', 'binance');

describe('the state of a transfer', () => {
  it('is «ساري» while none of its legs is reversed', () => {
    const r = readTransferReversals([OUT, IN]).get('t1');
    expect(r).toMatchObject({ state: 'ACTIVE', reason: null, at: null, byId: null, reversedWalletIds: [] });
  });

  it('is «معكوس جزئياً» when one leg was reversed and the other still stands', () => {
    const r = readTransferReversals([OUT, IN, undo('r-in', 'in', 't1', 'binance', 'خطأ من البنت', 28)]).get('t1');
    expect(r).toMatchObject({ state: 'PARTLY_REVERSED', reason: 'خطأ من البنت', byId: 'u2', reversedWalletIds: ['binance'] });
    expect(r?.at).toEqual(at(28));
  });

  it('is «معكوس» when both legs are reversed — in whichever order, by whichever door', () => {
    const rows = [OUT, IN, undo('r-out', 'out', 't1', 'sham', 'تصحيح', 30), undo('r-in', 'in', 't1', 'binance', 'خطأ من البنت', 28)];
    const r = readTransferReversals(rows).get('t1');
    expect(r?.state).toBe('REVERSED');
    expect([...(r?.reversedWalletIds ?? [])].sort()).toEqual(['binance', 'sham']);
  });

  it('says the LATEST reversing entry’s reason, time and writer', () => {
    const rows = [OUT, IN, undo('r-in', 'in', 't1', 'binance', 'الأولى', 28, 'u2'), undo('r-out', 'out', 't1', 'sham', 'الأخيرة', 31, 'u3')];
    expect(readTransferReversals(rows).get('t1')).toMatchObject({ reason: 'الأخيرة', byId: 'u3' });
  });

  it('keeps one transfer’s legs apart from another’s', () => {
    const rows = [OUT, IN, leg('out2', 't2', 'sham'), leg('in2', 't2', 'binance'), undo('r2', 'in2', 't2', 'binance', 'x', 29)];
    const read = readTransferReversals(rows);
    expect(read.get('t1')?.state).toBe('ACTIVE');
    expect(read.get('t2')?.state).toBe('PARTLY_REVERSED');
  });

  it('knows nothing of a transfer with no movement — the caller reads it as standing', () => {
    expect(readTransferReversals([]).get('t9')).toBeUndefined();
    expect(readTransferReversals([{ ...OUT, referenceId: null }]).size).toBe(0);
  });

  it('says each state in Arabic only', () => {
    expect(TRANSFER_STATE_AR).toEqual({ ACTIVE: 'ساري', PARTLY_REVERSED: 'معكوس جزئياً', REVERSED: 'معكوس' });
  });
});
