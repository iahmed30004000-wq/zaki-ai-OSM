import { describe, expect, it, vi } from 'vitest';

/**
 * «سعر الصرف التلقائي» (23/11, F8) — `recordMovement`, where every writer passes: a rate is stored ONLY beside the value it filled,
 * only on a partner's draw, and a movement without one is written exactly as before (no rate key at all).
 */
vi.mock('./db', () => ({ db: {} }));
import { recordMovement } from './wallets';

const tx = () => {
  const created: Record<string, unknown>[] = [];
  return {
    created,
    wallet: { findFirst: vi.fn(async () => ({ id: 'w1', currencyCode: 'JOD' })) },
    walletMovement: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => (created.push(data), { id: 'm1', ...data })) },
  };
};
const DRAW = {
  companyId: 'c1', walletId: 'w1', direction: 'OUT' as const, amount: 100, party: 'شريك', category: 'PARTNER_DRAW', note: 'سحب',
  referenceType: 'PARTNER_DRAW', referenceId: 'p1', partnerId: 'p1', createdById: 'u1',
};
const RATE = { rate: 1.41, kind: 'AUTO' as const, source: 'open.er-api.com', at: new Date('2026-11-23T00:00:00Z') };

describe('a rate beside its value', () => {
  it('written as four columns beside the value', async () => {
    const t = tx();
    await recordMovement(t as never, { ...DRAW, valueInStoreCurrency: 141, equivalentRate: RATE });
    expect(t.created[0]).toMatchObject({ valueInStoreCurrency: 141, equivalentRate: 1.41, equivalentRateKind: 'AUTO', equivalentRateSource: 'open.er-api.com', equivalentRateAt: RATE.at });
  });

  it('without one: no rate key at all — byte for byte as before', async () => {
    const t = tx();
    await recordMovement(t as never, { ...DRAW, valueInStoreCurrency: 141 });
    expect(Object.keys(t.created[0]).filter((k) => k.startsWith('equivalentRate'))).toEqual([]);
  });

  it('NEGATIVE: a rate with no value, a rate of zero, or a rate on another kind of movement is refused — nothing written', async () => {
    const t = tx();
    await expect(recordMovement(t as never, { ...DRAW, equivalentRate: RATE })).rejects.toThrow('A rate is stored only beside the value it filled');
    await expect(recordMovement(t as never, { ...DRAW, valueInStoreCurrency: 1, equivalentRate: { ...RATE, rate: 0 } })).rejects.toThrow();
    await expect(
      recordMovement(t as never, { companyId: 'c1', walletId: 'w1', direction: 'OUT', amount: 5, party: 'x', category: 'OTHER', note: 'n', createdById: 'u1', equivalentRate: RATE })
    ).rejects.toThrow('Only a partner draw carries a partner or a store value');
    expect(t.created).toHaveLength(0);
  });
});
