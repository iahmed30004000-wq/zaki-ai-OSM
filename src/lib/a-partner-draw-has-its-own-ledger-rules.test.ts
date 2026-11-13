import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A PARTNER'S DRAW, AT THE ONE PLACE EVERY WALLET MOVEMENT PASSES (13/11) — `recordMovement` and `reverseMovement`.
 *
 * «السحوبات لازم تنضاف بند». The draws door states its rules first and answers in Arabic; these are the same rules where every writer
 * has to pass. A draw goes OUT, names its partner and what it is worth in the store's currency, and says which ledger it belongs to;
 * those two fields mean nothing on any other kind of movement, so they are refused there. A draw is taken back only by someone who holds
 * the partners' key, and its reversing entry stays the partner's and worth the same, so the statement counts the pair as nothing.
 * And every OTHER kind of movement is written exactly as it was before: no new key reaches the row.
 */

const { db } = vi.hoisted(() => ({
  db: {
    wallet: { findUnique: vi.fn(), findFirst: vi.fn() },
    walletMovement: { aggregate: vi.fn(), count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn() },
    expense: { updateMany: vi.fn(), findFirst: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { PartnerDrawRefused, recordMovement, reverseMovement } from './wallets';

const P = '11111111-1111-4111-8111-111111111111';
const base = { companyId: 'c1', walletId: 'w1', direction: 'OUT' as const, amount: 100, party: 'شريك د', note: 'سحب', createdById: 'u1' };
const draw = (over: Record<string, unknown> = {}) => ({
  ...base, category: 'PARTNER_DRAW' as const, referenceType: 'PARTNER_DRAW', referenceId: P, partnerId: P, valueInStoreCurrency: 100, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  db.wallet.findFirst.mockResolvedValue({ id: 'w1', currencyCode: 'USD' });
  db.walletMovement.create.mockImplementation(async ({ data }: any) => ({ id: 'm-new', ...data }));
});

describe('recordMovement writes a partner draw only when it is whole', () => {
  it('a whole draw is written with its partner and its store value, in the wallet’s own currency', async () => {
    const m = await recordMovement(db as never, draw());
    expect(m).toMatchObject({
      category: 'PARTNER_DRAW', direction: 'OUT', amount: 100, currencyCode: 'USD', partnerId: P, valueInStoreCurrency: 100,
      referenceType: 'PARTNER_DRAW', referenceId: P,
    });
  });

  it('a draw is never IN: a draw coming back is a reversal, which has its own door', async () => {
    await expect(recordMovement(db as never, draw({ direction: 'IN' }))).rejects.toThrow(/only goes out/);
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('a draw with no partner, a partner that is not its reference, or no reference, is refused', async () => {
    await expect(recordMovement(db as never, draw({ partnerId: undefined }))).rejects.toThrow(/name its partner/);
    await expect(recordMovement(db as never, draw({ referenceId: 'other' }))).rejects.toThrow(/name its partner/);
    await expect(recordMovement(db as never, draw({ referenceType: undefined }))).rejects.toThrow(/name its partner/);
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('a draw with no store value, a zero one, or a negative one, is refused — it could not be added to a ledger', async () => {
    for (const bad of [undefined, 0, -3, Number.NaN]) {
      await expect(recordMovement(db as never, draw({ valueInStoreCurrency: bad })), String(bad)).rejects.toThrow(/store currency/);
    }
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('a partner or a store value on any OTHER kind of movement is refused — nothing stores them beside a category that never reads them', async () => {
    for (const category of ['OTHER', 'ADJUSTMENT', 'COURIER_SETTLEMENT'] as const) {
      await expect(recordMovement(db as never, { ...base, category, partnerId: P }), category).rejects.toThrow(/Only a partner draw/);
      await expect(recordMovement(db as never, { ...base, category, valueInStoreCurrency: 5 }), category).rejects.toThrow(/Only a partner draw/);
    }
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('EVERY OTHER KIND is written exactly as before: the row carries neither new key', async () => {
    await recordMovement(db as never, { ...base, category: 'OTHER', note: 'تسوية' });
    const data = db.walletMovement.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      'amount', 'category', 'companyId', 'createdById', 'currencyCode', 'direction', 'note', 'party', 'referenceId', 'referenceType', 'walletId',
    ]);
    expect(data).not.toHaveProperty('partnerId');
    expect(data).not.toHaveProperty('valueInStoreCurrency');
  });
});

describe('reverseMovement and a partner draw', () => {
  const original = (over: Record<string, unknown> = {}) => ({
    id: 'orig', companyId: 'c1', walletId: 'w1', direction: 'OUT', amount: 100, currencyCode: 'USD', party: 'شريك د', category: 'PARTNER_DRAW',
    note: 'سحب', referenceType: 'PARTNER_DRAW', referenceId: P, reversalOfId: null, partnerId: P, valueInStoreCurrency: 98.7, ...over,
  });
  const params = (over: Record<string, unknown> = {}) => ({ companyId: 'c1', walletId: 'w1', movementId: 'orig', reason: 'سُجِّل بالغلط', createdById: 'u1', ...over });

  beforeEach(() => {
    db.walletMovement.findFirst.mockResolvedValue(original());
    db.walletMovement.findUnique.mockResolvedValue(null);
  });

  it('without the partners’ key it is refused FIRST — 403 in the door’s words — and nothing is read about the draw or written', async () => {
    await expect(reverseMovement(db as never, params())).rejects.toBeInstanceOf(PartnerDrawRefused);
    await expect(reverseMovement(db as never, params({ mayReversePartnerDraw: false }))).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
    expect(db.walletMovement.findUnique).not.toHaveBeenCalled();
    expect(db.walletMovement.create).not.toHaveBeenCalled();
  });

  it('the refusal is a sentence that names the key by its Arabic name', async () => {
    await expect(reverseMovement(db as never, params())).rejects.toThrow('«الشركاء والسحوبات»');
  });

  it('even a draw already reversed is refused on the key before anything else — whoever lacks it learns nothing about the draw', async () => {
    db.walletMovement.findUnique.mockResolvedValue({ id: 'rev' });
    await expect(reverseMovement(db as never, params())).rejects.toBeInstanceOf(PartnerDrawRefused);
  });

  it('with the key it writes the opposite entry, the same amount, the same partner, the same store value — and links it', async () => {
    const rev = await reverseMovement(db as never, params({ mayReversePartnerDraw: true }));
    expect(rev).toMatchObject({
      direction: 'IN', amount: 100, category: 'PARTNER_DRAW', partnerId: P, valueInStoreCurrency: 98.7, reversalOfId: 'orig',
      reversalReason: 'سُجِّل بالغلط', referenceType: 'PARTNER_DRAW', referenceId: P,
    });
  });

  it('it cannot be reversed twice, and a reversing entry cannot be reversed', async () => {
    db.walletMovement.findUnique.mockResolvedValue({ id: 'rev' });
    await expect(reverseMovement(db as never, params({ mayReversePartnerDraw: true }))).rejects.toThrow(/already reversed/);
    db.walletMovement.findUnique.mockResolvedValue(null);
    db.walletMovement.findFirst.mockResolvedValue(original({ reversalOfId: 'earlier', direction: 'IN' }));
    await expect(reverseMovement(db as never, params({ mayReversePartnerDraw: true }))).rejects.toThrow(/cannot be reversed/);
  });

  it('a movement of ANY OTHER kind is reversed as it always was, with no key about partners and no partner on the reversal', async () => {
    db.walletMovement.findFirst.mockResolvedValue(original({ category: 'OTHER', referenceType: null, referenceId: null, partnerId: null, valueInStoreCurrency: null }));
    const rev = await reverseMovement(db as never, params());
    expect(rev).toMatchObject({ direction: 'IN', category: 'OTHER', reversalOfId: 'orig' });
    expect(Object.keys(db.walletMovement.create.mock.calls[0][0].data)).not.toContain('partnerId');
    expect(Object.keys(db.walletMovement.create.mock.calls[0][0].data)).not.toContain('valueInStoreCurrency');
  });
});
