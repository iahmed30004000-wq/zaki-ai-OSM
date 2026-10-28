import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOVEMENT_CATEGORIES } from '@/lib/wallets';
import { handCategoriesFor } from '@/lib/hand-movement-rules';

/**
 * THE HAND DOOR — «حركة جديدة».
 *
 * 27/10: a courier collection (1543.9) was typed here, as an «مصروف» coming IN. 28/10: its statement was
 * approved and wrote the same 1543.9 a second time. The door now refuses a courier collection, a transfer and
 * a direction a category cannot honestly have — and still takes every pair a person genuinely writes down.
 *
 * Driven through the real POST, with the wallet module's `recordMovement` as the only thing mocked: a refusal
 * is proved by the money NOT being written.
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, walletBalance } = vi.hoisted(() => ({
  db: { wallet: { findFirst: vi.fn() } },
  requireContext: vi.fn(),
  requirePermission: vi.fn(),
  logAudit: vi.fn(),
  recordMovement: vi.fn(),
  walletBalance: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...a),
  walletBalance: (...a: unknown[]) => walletBalance(...a),
}));

import { POST } from './route';

const WALLET = '22222222-2222-4222-8222-222222222222';
const params = { params: Promise.resolve({ id: WALLET }) };
const post = (b: unknown) =>
  POST(
    new Request('http://localhost/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }),
    params
  );
const entry = (category: string, direction: string) => ({
  direction, category, amount: 1543.9, party: 'الباشا 27-10-2026', note: 'Qabas',
});

function arm() {
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'شام كاش دولار', isActive: true, country: { minorUnit: 2 } });
  recordMovement.mockResolvedValue({ id: 'm1' });
  walletBalance.mockResolvedValue({ balance: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  arm();
});

describe('what is refused', () => {
  it('a courier collection, in either direction', async () => {
    for (const direction of ['IN', 'OUT']) {
      const res = await post(entry('COURIER_SETTLEMENT', direction));
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('COURIER_NOT_BY_HAND');
      expect(body.error).toContain('ما بينكتب باليد');
    }
    expect(recordMovement).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('an «مصروف» coming IN — what the 27/10 row actually was', async () => {
    const res = await post(entry('EXPENSE', 'IN'));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('المصروف صادر بس');
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('a commission coming IN', async () => {
    expect((await post(entry('COMMISSION', 'IN'))).status).toBe(409);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('a transfer, in either direction, in either category', async () => {
    for (const category of ['TRANSFER_IN', 'TRANSFER_OUT']) {
      for (const direction of ['IN', 'OUT']) {
        const res = await post(entry(category, direction));
        expect(res.status).toBe(409);
        expect((await res.json()).code).toBe('TRANSFER_NOT_BY_HAND');
      }
    }
    expect(recordMovement).not.toHaveBeenCalled();
  });
});

describe('what is still taken', () => {
  const ACCEPTED: [string, 'IN' | 'OUT'][] = [
    ['EXPENSE', 'OUT'], ['COMMISSION', 'OUT'], ['ADJUSTMENT', 'IN'], ['ADJUSTMENT', 'OUT'], ['OTHER', 'IN'], ['OTHER', 'OUT'],
  ];

  it.each(ACCEPTED)('%s %s is written', async (category, direction) => {
    const res = await post(entry(category, direction));
    expect(res.status).toBe(201);
    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement.mock.calls[0][1]).toMatchObject({ category, direction, walletId: WALLET });
    expect(logAudit).toHaveBeenCalledTimes(1);
  });

  it('and the dialog offers nothing the door would refuse', async () => {
    for (const direction of ['IN', 'OUT'] as const) {
      for (const category of handCategoriesFor(direction)) {
        vi.clearAllMocks();
        arm();
        expect((await post(entry(category, direction))).status, `${category} ${direction}`).toBe(201);
      }
    }
  });

  it('and every category the schema knows is accounted for above', () => {
    expect([...MOVEMENT_CATEGORIES].sort()).toEqual(
      ['ADJUSTMENT', 'COMMISSION', 'COURIER_SETTLEMENT', 'EXPENSE', 'OTHER', 'TRANSFER_IN', 'TRANSFER_OUT']
    );
  });
});
