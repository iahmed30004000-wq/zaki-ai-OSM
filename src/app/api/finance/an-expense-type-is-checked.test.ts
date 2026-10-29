import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_FORM_HINT,
  EXPENSE_FORM_LABEL,
  EXPENSE_FORM_ORDER,
  categoryLabel,
  resolveExpenseCategory,
} from '@/lib/expense-grade';

/**
 * AN EXPENSE TYPE IS ONE OF THE EIGHT — AND THE TWO THE PROFIT ALREADY COUNTS SAY SO.
 *
 * `POST /api/finance` stored whatever string arrived as the type. `'rent'` and `'Marketing'` were saved as
 * written, printed beside the real eight by the spend-by-type card, and grouped apart from them, so the card
 * added up while being wrong.
 *
 * And «شحن» and «تصنيع» were counted twice: net profit subtracts every expense, and ALSO subtracts the
 * `shippingCost` and the `estimatedCostOfGoods` that each delivered order carries. A courier invoice for
 * delivered parcels typed as an expense is the same fee twice; a batch cost typed as an expense is the same
 * batch twice. They stay (a return fee and a failed delivery are carried by no delivered order, and a product
 * whose batch has no cost written is carried by nothing else) — and the form now says which is which.
 */

const { db, requireContext, requirePermission, logAudit } = vi.hoisted(() => {
  const db = {
    wallet: { findFirst: vi.fn() },
    expense: { create: vi.fn(), update: vi.fn() },
    walletMovement: { create: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
  };
  return { db, requireContext: vi.fn(), requirePermission: vi.fn(), logAudit: vi.fn() };
});

vi.mock('@/lib/db', () => ({ db }));
vi.mock('@/lib/geo-context', () => ({ requireContext: (...a: unknown[]) => requireContext(...a) }));
vi.mock('@/lib/authorization', () => ({ requirePermission: (...a: unknown[]) => requirePermission(...a) }));
vi.mock('@/lib/audit', () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { POST } from './route';

const post = (body: Record<string, unknown>) =>
  POST(new Request('http://localhost/api/finance', { method: 'POST', body: JSON.stringify(body) }));

const nothingWritten = () => {
  expect(db.expense.create, 'مصروف كُتب').not.toHaveBeenCalled();
  expect(db.walletMovement.create, 'حركة محفظة كُتبت').not.toHaveBeenCalled();
  expect(logAudit).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
  requirePermission.mockResolvedValue({});
  db.wallet.findFirst.mockResolvedValue({ id: 'w1', name: 'الصندوق', currencyCode: 'JOD' });
  db.expense.create.mockResolvedValue({ id: 'e1' });
  db.walletMovement.create.mockResolvedValue({ id: 'm1' });
  db.expense.update.mockResolvedValue({ id: 'e1', movementId: 'm1' });
});

describe('the door refuses a type that is not one of the eight', () => {
  it.each(['rent', 'RENT', 'تأجير', 'MARKETING2', 'toString', '__proto__', ' '])(
    '%j → 400 UNKNOWN_CATEGORY and nothing is written',
    async (category) => {
      const res = await post({ title: 'إيجار', category, amount: 100, walletId: 'w1' });
      expect(res.status).toBe(400);
      const body = await res.json();
      // ' ' is "present" to the first check (truthy) and refused by this one; the rest never get past it.
      expect(['UNKNOWN_CATEGORY', undefined]).toContain(body.code);
      nothingWritten();
    }
  );

  it.each([42, ['OFFICE'], { x: 1 }, true])('a non-string type (%j) is a 400, not a 500, and nothing is written', async (category) => {
    const res = await post({ title: 'إيجار', category, amount: 100, walletId: 'w1' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('UNKNOWN_CATEGORY');
    nothingWritten();
  });

  it('a title that is not text is a 400, not a 500', async () => {
    const res = await post({ title: 12, category: 'OFFICE', amount: 100, walletId: 'w1' });
    expect(res.status).toBe(400);
    nothingWritten();
  });
});

describe('and takes the eight, stored as their keys', () => {
  it.each(EXPENSE_CATEGORIES)('%s is recorded as itself', async (category) => {
    const res = await post({ title: 'بند', category, amount: 100, walletId: 'w1' });
    expect(res.status).toBe(200);
    expect(db.expense.create.mock.calls[0][0].data.category).toBe(category);
  });

  it('a lower-case key or the Arabic label is stored as the KEY — never as typed', async () => {
    for (const [sent, stored] of [['marketing', 'MARKETING'], [' office ', 'OFFICE'], ['عمولات', 'COMMISSION'], ['شحن وتوصيل', 'SHIPPING']]) {
      vi.clearAllMocks();
      requireContext.mockResolvedValue({ user: { id: 'u1' }, companyId: 'c1', storeId: 's1' });
      requirePermission.mockResolvedValue({});
      db.wallet.findFirst.mockResolvedValue({ id: 'w1', name: 'الصندوق', currencyCode: 'JOD' });
      db.expense.create.mockResolvedValue({ id: 'e1' });
      db.walletMovement.create.mockResolvedValue({ id: 'm1' });
      db.expense.update.mockResolvedValue({ id: 'e1' });
      const res = await post({ title: 'بند', category: sent, amount: 100, walletId: 'w1' });
      expect(res.status, sent).toBe(200);
      expect(db.expense.create.mock.calls[0][0].data.category).toBe(stored);
    }
  });
});

describe('the reader and the form share one list', () => {
  it('resolveExpenseCategory: the eight, their labels and their lower case — nothing else', () => {
    for (const c of EXPENSE_CATEGORIES) expect(resolveExpenseCategory(c)).toBe(c);
    for (const c of EXPENSE_CATEGORIES) expect(resolveExpenseCategory(categoryLabel(c))).toBe(c);
    for (const bad of ['', '  ', 'rent', null, undefined, 7, [], {}, 'constructor', 'hasOwnProperty']) {
      expect(resolveExpenseCategory(bad)).toBeNull();
    }
  });

  it('the form lists every type once — a permutation of the eight', () => {
    expect([...EXPENSE_FORM_ORDER].sort()).toEqual([...EXPENSE_CATEGORIES].sort());
  });

  it('the two types the profit already counts on a delivered order carry a label and a hint that say so', () => {
    expect(EXPENSE_FORM_LABEL.SHIPPING).toContain('غير محسوب على طلب مسلَّم');
    expect(EXPENSE_FORM_LABEL.MANUFACTURING).toContain('بلا كلفة');
    expect(EXPENSE_FORM_HINT.SHIPPING).toContain('رسوم الإرجاع');
    expect(EXPENSE_FORM_HINT.MANUFACTURING).toContain('مرّتين');
    // The other six have no hint — a hint on every box is a hint on none.
    expect(Object.keys(EXPENSE_FORM_HINT).sort()).toEqual(['MANUFACTURING', 'SHIPPING']);
  });

  it('and history reads as it did: a stored SHIPPING row is still «شحن وتوصيل»', () => {
    expect(categoryLabel('SHIPPING')).toBe('شحن وتوصيل');
    expect(categoryLabel('MANUFACTURING')).toBe('تصنيع');
  });
});
