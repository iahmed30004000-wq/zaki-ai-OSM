import { beforeEach, describe, expect, it, vi } from 'vitest';
import { importedSentence } from '@/lib/statement-import-message';

/**
 * AN IMPORT TELLS THE PERSON WHAT IT KEPT AS ZERO AND WHICH WORDS IT DID NOT KNOW.
 *
 * Nothing is dropped and nothing is refused for an empty cell, so the answer says how many lines had no
 * money (they are the ones to look at) and lists the status words nobody has met, as the company wrote them.
 */

const { db, requireContext, requirePermission, logAudit, written } = vi.hoisted(() => {
  const written: { lines: Record<string, unknown>[] } = { lines: [] };
  return {
    written,
    db: {
      deliveryProvider: { findFirst: vi.fn() },
      courierStatement: { findFirst: vi.fn() },
      $transaction: vi.fn(),
    },
    requireContext: vi.fn(),
    requirePermission: vi.fn(),
    logAudit: vi.fn(),
  };
});
vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));
vi.mock('@/lib/api-error', () => ({ apiErrorResponse: (e: unknown) => new Response(String(e), { status: 500 }) }));

import { POST } from './route';

const PROVIDER = '11111111-1111-4111-8111-111111111111';
const FILE = ['المرجع,الصافي,الحالة', 'R1,9,تم توصيلها', 'R2,,مؤجل', 'R3,-,مؤجلة', 'R4,لا يوجد,حالة جديدة'].join('\n');

const post = (content: string) =>
  POST(
    new Request('http://x/api/finance/statements', {
      method: 'POST',
      body: JSON.stringify({ deliveryProviderId: PROVIDER, reference: 'ST-1', fileName: 's.csv', content }),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  written.lines = [];
  requireContext.mockResolvedValue({
    user: { id: 'u1' }, companyId: 'co', storeId: 'st', country: { minorUnit: 3, currencyCode: 'JOD' },
  });
  db.deliveryProvider.findFirst.mockResolvedValue({ id: PROVIDER, name: 'Basha' });
  db.courierStatement.findFirst.mockResolvedValue(null);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn({
      courierStatement: { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 's1', ...data }) },
      statementLine: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => ((written.lines = data), { count: data.length }) },
    })
  );
});

describe('the answer to an import', () => {
  it('keeps all four lines, writes the blank ones at 0, and says how many they were', async () => {
    const body = await (await post(FILE)).json();
    expect(body).toMatchObject({ rows: 4, total: 9, blankLines: 3 });
    expect(written.lines.map((l) => [l.merchantRef, Number(l.amount)])).toEqual([['R1', 9], ['R2', 0], ['R3', 0], ['R4', 0]]);
  });

  it('lists the words the table does not hold — and not «مؤجل» or «مؤجلة»', async () => {
    const body = await (await post(FILE)).json();
    expect(body.unknownWords).toEqual(['حالة جديدة']);
  });

  it('and the audit row carries the same two facts', async () => {
    await post(FILE);
    expect(logAudit.mock.calls[0][0].newData).toMatchObject({ rows: 4, blankLines: 3, unknownWords: ['حالة جديدة'] });
  });

  it('an ordinary file says neither, and is told as it always was', async () => {
    const body = await (await post(['المرجع,الصافي,الحالة', 'R1,9,تم توصيلها'].join('\n'))).json();
    expect(body).toMatchObject({ rows: 1, blankLines: 0, unknownWords: [] });
    expect(importedSentence(body)).toBe('تم استيراد 1 سطراً بإجمالي 9.000 JOD');
  });
});

describe('the sentence the seller reads', () => {
  it('names the lines kept at zero, and the unknown words, in the same breath', () => {
    expect(
      importedSentence({ rows: 4, total: 9, currencyCode: 'JOD', minorUnit: 3, blankLines: 3, unknownWords: ['حالة جديدة'] })
    ).toBe('تم استيراد 4 سطراً بإجمالي 9.000 JOD — منها 3 سطراً بلا مبلغ حُفظت صفراً — كلمات من الشركة لا نعرفها بعد: «حالة جديدة»');
  });

  it('and an answer from an older server (no such fields) reads exactly as before', () => {
    expect(importedSentence({ rows: 2, total: 12.5, currencyCode: 'JOD', minorUnit: 3 })).toBe('تم استيراد 2 سطراً بإجمالي 12.500 JOD');
  });
});
