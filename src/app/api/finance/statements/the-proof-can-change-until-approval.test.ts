import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * «الاثبات اقدر اغيرو لغاية قبل ما اضغط زر اعتماد تمام».
 *
 * A saved receipt and its proof used to be fixed: the receipts route had only POST and the proof route only GET,
 * so the only way out of a wrong photo or a wrong amount was undoing the whole statement. Now, until the
 * statement is approved, a proof can be replaced and a wrong receipt removed; after it, neither — and neither
 * ever writes a wallet movement.
 *
 * The claim on the statement is faked as what it is at the database: a conditional update that takes a row only
 * while it is unapproved. "Racing an approval" is that claim answering 0.
 */

const { db, requireContext, requirePermission, logAudit, recordMovement, receiptGap, writeProofFile, removeProofFile, state } =
  vi.hoisted(() => {
    const state = { approved: false };
    const db = {
      statementReceipt: { findFirst: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn(), create: vi.fn() },
      courierStatement: {
        findFirst: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(async ({ where }: { where: { approvedAt?: null } }) =>
          where.approvedAt === null && state.approved ? { count: 0 } : { count: 1 }
        ),
      },
      wallet: { findFirst: vi.fn() },
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    };
    return {
      db, state,
      requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn(), recordMovement: vi.fn(),
      receiptGap: vi.fn(), writeProofFile: vi.fn(), removeProofFile: vi.fn(),
    };
  });

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a), can: () => true }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/settlement', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement')>()),
  receiptGap: (...a: unknown[]) => receiptGap(...a),
}));
vi.mock('@/lib/wallets', async (orig) => ({
  ...(await orig<typeof import('@/lib/wallets')>()),
  recordMovement: (...a: unknown[]) => recordMovement(...a),
}));
// The rules of the file are the real ones; only the disk is faked.
vi.mock('@/lib/settlement-proof', async (orig) => ({
  ...(await orig<typeof import('@/lib/settlement-proof')>()),
  writeProofFile: (...a: unknown[]) => writeProofFile(...a),
  removeProofFile: (...a: unknown[]) => removeProofFile(...a),
}));

import { PUT } from './[id]/receipts/[receiptId]/proof/route';
import { DELETE } from './[id]/receipts/[receiptId]/route';
import { POST as ADD_RECEIPT } from './[id]/receipts/route';

const SID = '88888888-8888-4888-8888-888888888888';
const RID = '77777777-7777-4777-8777-777777777777';
const WID = '11111111-1111-4111-8111-111111111111';
const params = { params: Promise.resolve({ id: SID, receiptId: RID }) };
const sParams = { params: Promise.resolve({ id: SID }) };

const OLD_KEY = `companies/c1/settlement/${SID}/receipts/${RID}.jpg`;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const proofBody = (over: Record<string, unknown> = {}) => ({
  fileName: 'slip.png', content: PNG.toString('base64'), name: 'إيصال أرامكس', ...over,
});

const send = (method: string, body?: unknown) =>
  new Request('http://localhost/x', {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const receiptRow = (over: Record<string, unknown> = {}) => ({
  id: RID, amount: 1543.9, currencyCode: 'USD', exchangeRate: null, receivedAt: new Date('2026-10-27T18:16:00Z'),
  note: null, proofKey: OLD_KEY, proofName: 'old.jpg', proofMime: 'image/jpeg', proofHash: 'oldhash',
  wallet: { name: 'شام كاش دولار' },
  statement: { status: 'RECEIPTED', approvedAt: null },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  state.approved = false;
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1', country: { minorUnit: 2 } });
  requirePermission.mockResolvedValue({});
  db.statementReceipt.findFirst.mockResolvedValue(receiptRow());
  db.statementReceipt.updateMany.mockResolvedValue({ count: 1 });
  db.statementReceipt.deleteMany.mockResolvedValue({ count: 1 });
  db.statementReceipt.count.mockResolvedValue(1);
  db.courierStatement.update.mockResolvedValue({});
  receiptGap.mockResolvedValue({ claimed: 1543.9, received: 0, gap: -1543.9, needsExplanation: true, explained: false, unconvertible: 0 });
  writeProofFile.mockResolvedValue(undefined);
});

describe('replacing a proof before «اعتماد»', () => {
  it('writes a NEW key, all five columns together, keeps the old file, and audits both', async () => {
    const res = await PUT(send('PUT', proofBody()), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    const data = db.statementReceipt.updateMany.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual(['proofHash', 'proofKey', 'proofMime', 'proofName', 'proofSize']);
    expect(data.proofKey).not.toBe(OLD_KEY);
    expect(data.proofKey).toContain(`companies/c1/settlement/${SID}/receipts/${RID}-`);
    expect(data.proofKey.endsWith('.png')).toBe(true);
    expect(data).toMatchObject({ proofMime: 'image/png', proofName: 'إيصال أرامكس.png', proofSize: PNG.length });
    // The row, then the bytes, at exactly that key.
    expect(writeProofFile).toHaveBeenCalledWith(data.proofKey, PNG);
    // The old paper is kept: nothing deletes it.
    expect(removeProofFile).not.toHaveBeenCalled();
    expect(body.receipt.proof).toMatchObject({ name: 'إيصال أرامكس.png', mime: 'image/png' });
    // The audit row names the old file and the new one.
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'STATEMENT_RECEIPT_PROOF_CHANGED',
      entityId: SID,
      previousData: { receiptId: RID, proof: { key: OLD_KEY, hash: 'oldhash' } },
      newData: { receiptId: RID, proof: { key: data.proofKey, mime: 'image/png' } },
    });
    // It is paper: no wallet is touched.
    expect(recordMovement).not.toHaveBeenCalled();
    expect(db.courierStatement.update).not.toHaveBeenCalled();
  });

  it('adds a proof to a receipt that had none — the audit row says there was nothing before', async () => {
    db.statementReceipt.findFirst.mockResolvedValue(
      receiptRow({ proofKey: null, proofName: null, proofMime: null, proofHash: null })
    );
    const res = await PUT(send('PUT', proofBody()), params);
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].previousData).toEqual({ receiptId: RID, proof: null });
  });

  it('two replacements never share a key', async () => {
    await PUT(send('PUT', proofBody()), params);
    await PUT(send('PUT', proofBody()), params);
    const keys = db.statementReceipt.updateMany.mock.calls.map((c) => c[0].data.proofKey);
    expect(new Set(keys).size).toBe(2);
  });

  it('a file that is not an image or a PDF is refused EXACTLY as the receipt route refuses it', async () => {
    const bad = proofBody({ content: Buffer.from('هذا ليس ملفاً').toString('base64'), fileName: 'notes.txt' });
    const res = await PUT(send('PUT', bad), params);
    const mine = await res.json();

    // The very same bytes through the receipt route.
    db.courierStatement.findFirst.mockResolvedValue({ id: SID, status: 'MATCHED', approvedAt: null, currencyCode: 'USD', reference: 'ST-1' });
    db.wallet.findFirst.mockResolvedValue({ id: WID, name: 'w', currencyCode: 'USD' });
    const theirs = await (
      await ADD_RECEIPT(send('POST', { walletId: WID, amount: 5, proof: { fileName: 'notes.txt', content: bad.content } }), sParams)
    ).json();

    expect(res.status).toBe(400);
    expect(mine).toEqual(theirs);
    expect(mine.code).toBe('BAD_PROOF');
    expect(db.statementReceipt.updateMany).not.toHaveBeenCalled();
    expect(writeProofFile).not.toHaveBeenCalled();
  });

  it('a file over the size limit is refused the same way', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
    const res = await PUT(send('PUT', proofBody({ content: big.toString('base64') })), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('حجم الملف يتجاوز الحد المسموح');
    expect(writeProofFile).not.toHaveBeenCalled();
  });

  // (Was «الكشف معتمد — أي تصحيح يكون بقيد عكسي»; the lock gives every door of a closed statement one sentence.)
  it('is refused once the statement is approved — with the one sentence of a closed statement', async () => {
    db.statementReceipt.findFirst.mockResolvedValue(receiptRow({ statement: { status: 'APPROVED', approvedAt: new Date() } }));
    const res = await PUT(send('PUT', proofBody()), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: 'ALREADY_APPROVED', error: 'الكشف مغلق نهائياً — التصحيح بكشف تسوية' });
    expect(db.statementReceipt.updateMany).not.toHaveBeenCalled();
    expect(writeProofFile).not.toHaveBeenCalled();
  });

  it('is refused when it races an approval: the claim answers 0 and nothing is written', async () => {
    state.approved = true; // approved between the read and the write
    const res = await PUT(send('PUT', proofBody()), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(db.courierStatement.updateMany.mock.calls[0][0].where).toMatchObject({ approvedAt: null });
    expect(db.statementReceipt.updateMany).not.toHaveBeenCalled();
    expect(writeProofFile).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('is the same permission as recording a receipt, and another store’s receipt is simply not there', async () => {
    db.statementReceipt.findFirst.mockResolvedValue(null);
    const res = await PUT(send('PUT', proofBody()), params);
    expect(res.status).toBe(404);
    expect(requirePermission).toHaveBeenCalledWith('settlement.upload');
    expect(db.statementReceipt.findFirst.mock.calls[0][0].where).toEqual({
      id: RID, companyId: 'c1', statementId: SID, statement: { companyId: 'c1', storeId: 's1' },
    });
    expect(writeProofFile).not.toHaveBeenCalled();
  });
});

describe('removing a wrong receipt before «اعتماد»', () => {
  it('deletes it, puts the statement back to RECEIPTED while another receipt remains, and returns the new gap', async () => {
    db.statementReceipt.count.mockResolvedValue(1);
    receiptGap.mockResolvedValue({ claimed: 2000, received: 456.1, gap: -1543.9, needsExplanation: true, explained: false, unconvertible: 0 });

    const res = await DELETE(send('DELETE'), params);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(db.statementReceipt.deleteMany).toHaveBeenCalledWith({ where: { id: RID, companyId: 'c1', statementId: SID } });
    expect(db.courierStatement.update).toHaveBeenCalledWith({ where: { id: SID }, data: { status: 'RECEIPTED' } });
    expect(body).toMatchObject({ ok: true, status: 'RECEIPTED', gap: { received: 456.1, gap: -1543.9 } });
    // The gap is recomputed from what is left, the way the receipt route computes it.
    expect(receiptGap).toHaveBeenCalledWith(db, SID, 2);
  });

  it('the last receipt going back leaves the statement IMPORTED', async () => {
    db.statementReceipt.count.mockResolvedValue(0);
    const res = await DELETE(send('DELETE'), params);
    expect((await res.json()).status).toBe('IMPORTED');
    expect(db.courierStatement.update).toHaveBeenCalledWith({ where: { id: SID }, data: { status: 'IMPORTED' } });
  });

  it('writes no wallet movement, keeps the proof file, and the audit row holds everything the receipt held', async () => {
    await DELETE(send('DELETE'), params);

    expect(recordMovement).not.toHaveBeenCalled();
    expect(removeProofFile).not.toHaveBeenCalled();
    expect(logAudit.mock.calls[0][0]).toMatchObject({
      action: 'STATEMENT_RECEIPT_REMOVED',
      entityId: SID,
      previousData: {
        receiptId: RID, wallet: 'شام كاش دولار', amount: 1543.9, currencyCode: 'USD',
        proof: { key: OLD_KEY, name: 'old.jpg', hash: 'oldhash' },
      },
      newData: { status: 'RECEIPTED', receiptsLeft: 1 },
    });
  });

  it('is refused once the statement is approved', async () => {
    db.statementReceipt.findFirst.mockResolvedValue(receiptRow({ statement: { status: 'MATCHED', approvedAt: new Date() } }));
    const res = await DELETE(send('DELETE'), params);
    expect(res.status).toBe(409);
    // (Was «الكشف معتمد — أي تصحيح يكون بقيد عكسي».)
    expect((await res.json()).error).toBe('الكشف مغلق نهائياً — التصحيح بكشف تسوية');
    expect(db.statementReceipt.deleteMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('is refused when it races an approval: the claim answers 0 and the receipt stays', async () => {
    state.approved = true;
    const res = await DELETE(send('DELETE'), params);
    expect(res.status).toBe(409);
    expect(db.courierStatement.updateMany.mock.calls[0][0].where).toMatchObject({ approvedAt: null });
    expect(db.statementReceipt.deleteMany).not.toHaveBeenCalled();
    expect(db.courierStatement.update).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('another company’s or store’s receipt is a 404 and nothing is deleted', async () => {
    db.statementReceipt.findFirst.mockResolvedValue(null);
    const res = await DELETE(send('DELETE'), params);
    expect(res.status).toBe(404);
    expect(db.statementReceipt.findFirst.mock.calls[0][0].where.statement).toEqual({ companyId: 'c1', storeId: 's1' });
    expect(db.statementReceipt.deleteMany).not.toHaveBeenCalled();
  });

  it('a receipt that vanished between the read and the delete is a 404, and the status is not rewritten', async () => {
    db.statementReceipt.deleteMany.mockResolvedValue({ count: 0 });
    const res = await DELETE(send('DELETE'), params);
    expect(res.status).toBe(404);
    expect(db.courierStatement.update).not.toHaveBeenCalled();
  });

  it('asks for the same permission as recording a receipt', async () => {
    await DELETE(send('DELETE'), params);
    expect(requirePermission).toHaveBeenCalledWith('settlement.upload');
  });
});

describe('a new receipt never lands on a statement that is being approved', () => {
  const add = () => ADD_RECEIPT(send('POST', { walletId: WID, amount: 40 }), sParams);

  beforeEach(() => {
    db.courierStatement.findFirst.mockResolvedValue({ id: SID, status: 'MATCHED', approvedAt: null, currencyCode: 'USD', reference: 'ST-1' });
    db.wallet.findFirst.mockResolvedValue({ id: WID, name: 'الصندوق', currencyCode: 'USD' });
    db.statementReceipt.create.mockResolvedValue({ id: RID, amount: 40 });
  });

  it('records it while the statement is open — the claim comes before the row', async () => {
    const res = await add();
    expect(res.status).toBe(201);
    const claim = db.courierStatement.updateMany.mock.invocationCallOrder[0];
    const create = db.statementReceipt.create.mock.invocationCallOrder[0];
    expect(claim).toBeLessThan(create);
  });

  it('is refused when the approval lands between the check and the write: nothing is created', async () => {
    state.approved = true;
    const res = await add();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('ALREADY_APPROVED');
    expect(db.statementReceipt.create).not.toHaveBeenCalled();
  });

  it('is refused on the stamp of the approval, not only on the status word', async () => {
    db.courierStatement.findFirst.mockResolvedValue({ id: SID, status: 'MATCHED', approvedAt: new Date(), currencyCode: 'USD', reference: 'ST-1' });
    const res = await add();
    expect(res.status).toBe(409);
    expect(db.statementReceipt.create).not.toHaveBeenCalled();
    expect(db.courierStatement.updateMany).not.toHaveBeenCalled();
  });
});
