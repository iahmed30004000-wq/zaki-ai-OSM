import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Reversing a wallet movement — the only correction this system has.
 *
 * The handler checks that the WALLET in the path belongs to the current store,
 * and then takes a `movementId` out of the request body. If it does not carry
 * the wallet through to the lookup, the check is on nothing: naming one of your
 * own wallets in the path reverses a movement sitting in another store's.
 */

const { db, TX, can, requireContext, requirePermission, logAudit, reverseMovement, walletBalance } = vi.hoisted(() => {
  // The transaction client the route hands the reversal: a sentinel, so a test can tell it from `db`.
  const TX = { sentinel: 'transaction-client' };
  return {
    db: {
      wallet: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(TX)),
    },
    TX,
    can: vi.fn(() => true),
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
    reverseMovement: vi.fn(),
    walletBalance: vi.fn(),
  };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: (...a: unknown[]) => can(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  reverseMovement: (...a: unknown[]) => reverseMovement(...a),
  walletBalance: (...a: unknown[]) => walletBalance(...a),
}));

import { PATCH } from './route';
import { ExpenseRefused } from '@/lib/wallets';

const WALLET = '22222222-2222-4222-8222-222222222222';
const MOVEMENT = '33333333-3333-4333-8333-333333333333';
const params = { params: Promise.resolve({ id: WALLET }) };
const body = (b: unknown) =>
  new Request('http://localhost/x', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({
    user: { id: 'u1', name: 'Accountant' },
    companyId: 'c1',
    storeId: 's1',
    country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  requirePermission.mockResolvedValue({});
  db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'الصندوق', isActive: true, country: { minorUnit: 3 } });
  can.mockReturnValue(true);
  reverseMovement.mockResolvedValue({ id: 'rev1' });
  walletBalance.mockResolvedValue({ balance: 0 });
});

describe('reversing a movement', () => {
  it('reverses it, and says which wallet it was authorised for', async () => {
    const res = await PATCH(body({ movementId: MOVEMENT, reason: 'سُجِّل المبلغ مرتين' }), params);
    expect(res.status).toBe(201);
    expect(reverseMovement).toHaveBeenCalledTimes(1);
    expect(reverseMovement.mock.calls[0][1]).toMatchObject({
      companyId: 'c1',
      // THE GUARD: the wallet from the PATH, which was checked against the
      // store — never one implied by the movement the body names.
      walletId: WALLET,
      movementId: MOVEMENT,
    });
  });

  it('refuses when the wallet in the path is not this store’s', async () => {
    db.wallet.findFirst.mockResolvedValue(null);
    const res = await PATCH(body({ movementId: MOVEMENT, reason: 'سُجِّل المبلغ مرتين' }), params);
    expect(res.status).toBe(404);
    expect(reverseMovement).not.toHaveBeenCalled();
  });

  it('refuses a reversal with no written reason', async () => {
    const res = await PATCH(body({ movementId: MOVEMENT, reason: 'قصير' }), params);
    expect(res.status).toBe(400);
    expect(reverseMovement).not.toHaveBeenCalled();
  });

  it('answers 409 rather than 500 when the service refuses', async () => {
    reverseMovement.mockRejectedValue(new Error('Movement not found'));
    const res = await PATCH(body({ movementId: MOVEMENT, reason: 'سُجِّل المبلغ مرتين' }), params);
    expect(res.status).toBe(409);
  });
});

describe('reversing the movement of an EXPENSE', () => {
  const reason = 'سُجِّل المبلغ مرتين';

  it('runs the reversal inside ONE transaction, so the cancelled mark and the reversing entry are one fact', async () => {
    await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // The client the service gets is the transaction's, not the pool's.
    expect(reverseMovement.mock.calls[0][0]).toBe(TX);
  });

  it('says whether the person may edit finance — it is the door that knows', async () => {
    await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(can).toHaveBeenCalledWith(expect.anything(), 'finance.update');
    expect(reverseMovement.mock.calls[0][1]).toMatchObject({ mayCancelExpense: true });

    vi.clearAllMocks();
    can.mockReturnValue(false);
    reverseMovement.mockResolvedValue({ id: 'rev2' });
    db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'الصندوق', isActive: true, country: { minorUnit: 3 } });
    walletBalance.mockResolvedValue({ balance: 0 });
    await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(reverseMovement.mock.calls[0][1]).toMatchObject({ mayCancelExpense: false });
  });

  it('a person without «تعديل المالية» is told so (403), not given a 500 or a silent success', async () => {
    reverseMovement.mockRejectedValue(new ExpenseRefused('NOT_ALLOWED'));
    const res = await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ALLOWED');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('an expense already cancelled is a 409 with its own code', async () => {
    reverseMovement.mockRejectedValue(new ExpenseRefused('ALREADY_VOID'));
    const res = await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_VOID');
  });

  it('writes «إلغاء مصروف» to the audit trail only when the movement was an expense’s', async () => {
    reverseMovement.mockResolvedValue({ id: 'rev3', referenceType: 'EXPENSE', referenceId: 'e1' });
    await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(logAudit.mock.calls.map((c) => c[0].action)).toEqual(['WALLET_MOVEMENT_REVERSED', 'EXPENSE_VOIDED']);
    expect(logAudit.mock.calls[1][0]).toMatchObject({ entity: 'Expense', entityId: 'e1' });

    vi.clearAllMocks();
    db.wallet.findFirst.mockResolvedValue({ id: WALLET, name: 'الصندوق', isActive: true, country: { minorUnit: 3 } });
    reverseMovement.mockResolvedValue({ id: 'rev4', referenceType: null, referenceId: null });
    walletBalance.mockResolvedValue({ balance: 0 });
    await PATCH(body({ movementId: MOVEMENT, reason }), params);
    expect(logAudit.mock.calls.map((c) => c[0].action)).toEqual(['WALLET_MOVEMENT_REVERSED']);
  });
});
