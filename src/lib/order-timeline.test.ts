import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One merged history: every event table in one chronological list, written
 * in the language the person reading it speaks. This history is shown to
 * staff, so a line of it is never a raw enum and never the metadata JSON.
 */

const { db } = vi.hoisted(() => ({
  db: {
    orderStatusLog: { findMany: vi.fn() },
    orderClaimHistory: { findMany: vi.fn() },
    orderContactAttempt: { findMany: vi.fn() },
    callLog: { findMany: vi.fn() },
    deliveryAttempt: { findMany: vi.fn() },
    orderNote: { findMany: vi.fn() },
    orderActivity: { findMany: vi.fn() },
    orderChangeRequest: { findMany: vi.fn() },
    orderIssue: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock('./db', () => ({ db }));

import { orderTimeline } from './order-timeline';

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.clearAllMocks();
  for (const table of [
    db.orderStatusLog, db.orderClaimHistory, db.orderContactAttempt, db.deliveryAttempt,
    db.orderNote, db.orderActivity, db.orderChangeRequest, db.orderIssue, db.callLog,
  ]) {
    table.findMany.mockResolvedValue([]);
  }
  db.user.findMany.mockResolvedValue([{ id: 'u1', name: 'سارة' }]);
});

describe('orderTimeline', () => {
  it('merges every source and sorts oldest first', async () => {
    db.orderStatusLog.findMany.mockResolvedValue([
      { id: 's1', createdAt: at('2026-09-02T10:00:00Z'), statusType: 'CONFIRMATION', previousValue: 'NEW', newValue: 'CONFIRMED', changedById: 'u1', note: null },
    ]);
    db.orderClaimHistory.findMany.mockResolvedValue([
      { id: 'c1', createdAt: at('2026-09-01T10:00:00Z'), action: 'CLAIMED', userId: 'u1', reason: 'PULL_NEXT' },
    ]);
    db.orderContactAttempt.findMany.mockResolvedValue([
      { id: 't1', createdAt: at('2026-09-01T11:00:00Z'), attemptNumber: 1, contactMethod: 'PHONE', result: 'ANSWERED', employeeId: 'u1', note: null },
    ]);
    db.orderNote.findMany.mockResolvedValue([
      { id: 'n1', createdAt: at('2026-09-03T09:00:00Z'), kind: 'follow_up', body: 'العميل طلب التأجيل', authorId: 'u1' },
    ]);

    const events = await orderTimeline(db as never, 'o1');
    expect(events.map((e) => e.kind)).toEqual(['OWNERSHIP', 'CONTACT', 'STATUS', 'NOTE']);
    expect(events[0].actorName).toBe('سارة');
    expect(events[2].title).toBe('التأكيد: جديد ← مؤكد');
  });

  it('does not repeat a status change that the activity log also holds', async () => {
    db.orderStatusLog.findMany.mockResolvedValue([
      { id: 's1', createdAt: at('2026-09-02T10:00:00Z'), statusType: 'SHIPPING', previousValue: 'NOT_READY', newValue: 'SHIPPED', changedById: 'u1', note: null },
    ]);
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a1', createdAt: at('2026-09-02T10:00:00Z'), action: 'STATUS_CHANGED', userId: 'u1', metadata: null },
      { id: 'a2', createdAt: at('2026-09-02T10:05:00Z'), action: 'ORDER_UPDATED', userId: 'u1', metadata: null },
    ]);

    const events = await orderTimeline(db as never, 'o1');
    expect(events.filter((e) => e.kind === 'STATUS')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'ACTIVITY').map((e) => e.title)).toEqual(['تعديل بيانات الطلب']);
  });

  it('never shows the metadata JSON to whoever opens the order', async () => {
    // This is what the order history actually displayed: the raw object.
    db.orderActivity.findMany.mockResolvedValue([
      {
        id: 'a1', createdAt: at('2026-09-02T10:00:00Z'), action: 'ORDER_CREATED', userId: 'u1',
        metadata: { source: 'اسرار الجمال', intakeMethod: 'AI_PASTE', createdBy: 'مودريتور' },
      },
    ]);

    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('إنشاء الطلب');
    expect(event.detail).toBe('المصدر: اسرار الجمال · طريقة الإدخال: لصق نص بالذكاء · أدخله: مودريتور');
    expect(event.detail).not.toContain('{');
    expect(event.detail).not.toContain('"');
  });

  it('drops a metadata key nobody wrote a label for rather than dumping it', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      {
        id: 'a1', createdAt: at('2026-09-02T10:00:00Z'), action: 'ORDER_UPDATED', userId: 'u1',
        metadata: { updatedBy: 'سارة', someInternalFlag: true, __v: 7 },
      },
    ]);

    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('عدّله: سارة');
  });

  it('names the changed fields instead of their column names', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      {
        id: 'a1', createdAt: at('2026-09-02T10:00:00Z'), action: 'ORDER_UPDATED', userId: 'u1',
        metadata: { fields: ['customerName', 'customerPhone'] },
      },
    ]);

    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('الحقول: اسم العميل، رقم الهاتف');
  });

  it('reads an entry issue as a sentence, not as two enum values', async () => {
    db.orderIssue.findMany.mockResolvedValue([
      { id: 'i1', createdAt: at('2026-09-02T10:00:00Z'), reason: 'WRONG_PHONE', status: 'CORRECTED', note: 'رقم الهاتف: 0932 ← 0944', raisedById: 'u1' },
    ]);

    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('إشكال إدخال: رقم خاطئ — تم التصحيح');
  });

  it('reads a call attempt in Arabic, method and outcome both', async () => {
    db.orderContactAttempt.findMany.mockResolvedValue([
      { id: 't1', createdAt: at('2026-09-01T11:00:00Z'), attemptNumber: 2, contactMethod: 'WHATSAPP', result: 'NO_ANSWER', employeeId: 'u1', note: null },
    ]);

    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('محاولة اتصال 2 عبر واتساب — لم يرد');
  });

  it('keeps an unknown value visible rather than blanking it', async () => {
    // A status the label table has not caught up with must still be readable;
    // showing nothing would hide that the change happened at all.
    db.orderStatusLog.findMany.mockResolvedValue([
      { id: 's1', createdAt: at('2026-09-02T10:00:00Z'), statusType: 'CONFIRMATION', previousValue: 'NEW', newValue: 'SOMETHING_NEW', changedById: 'u1', note: null },
    ]);

    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('التأكيد: جديد ← SOMETHING_NEW');
  });

  it('is empty, not broken, for an order with no events', async () => {
    await expect(orderTimeline(db as never, 'o1')).resolves.toEqual([]);
  });
});

describe('ط25 — what the customer added after ordering is on the history, in words', () => {
  /** The column is TEXT: every real row arrives as a JSON string, not as an object. */
  const stored = (obj: unknown) => JSON.stringify(obj);

  it('the entry has an Arabic title and says what, how many, how much and from which offer', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      {
        id: 'a1', createdAt: at('2026-09-02T10:00:00Z'), action: 'UPSELL_ADDED', userId: null,
        metadata: stored({ source: 'post-order offer', addOnId: 'x', offerName: 'علبة كمان', product: 'شامبو', quantity: 1, total: 15, windowMinutes: 15 }),
      },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('زيادة بعد الطلب');
    expect(event.detail).toBe('المصدر: عرض بعد الطلب · العرض: علبة كمان · المنتج: شامبو · الكمية: 1 · المجموع: 15');
    // Nothing internal leaks: the add-on id and the window have no label, so they are dropped.
    expect(event.detail).not.toContain('addOnId');
    expect(event.detail).not.toContain('windowMinutes');
  });

  it('an add-on from the recommendation list reads in Arabic too (its source was English)', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a2', createdAt: at('2026-09-02T10:00:00Z'), action: 'UPSELL_ADDED', userId: null,
        metadata: stored({ source: 'Landing Page', product: 'شامبو', quantity: 1, price: 11, landingPage: 'صفحة الصيف' }) },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('المصدر: صفحة هبوط · المنتج: شامبو · الكمية: 1 · الصفحة: صفحة الصيف');
  });

  it('a call outcome is a word, not a code, and the caller and notes show', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a3', createdAt: at('2026-09-02T10:00:00Z'), action: 'CALL_MADE', userId: 'u1',
        metadata: stored({ callResult: 'NO_ANSWER', notes: 'مشغول', caller: 'سارة' }) },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('نتيجة الاتصال: لم يرد · ملاحظات: مشغول · المتصل: سارة');
  });

  it('NEGATIVE: JSON that is broken shows no details and breaks nothing', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a4', createdAt: at('2026-09-02T10:00:00Z'), action: 'ORDER_UPDATED', userId: 'u1', metadata: '{not json' },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('تعديل بيانات الطلب');
    expect(event.detail).toBeNull();
  });

  it('NEGATIVE: a key nobody wrote a label for is not shown, and an unknown value is shown as it is', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a5', createdAt: at('2026-09-02T10:00:00Z'), action: 'ORDER_CREATED', userId: null,
        metadata: stored({ source: 'متجر الورد', secretFlag: 'x', lines: [{ product: 'a' }], createdBy: 'public visitor' }) },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('المصدر: متجر الورد · أدخله: زائر');
  });

  it('NEGATIVE: an activity with no metadata at all has no details', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a6', createdAt: at('2026-09-02T10:00:00Z'), action: 'UPSELL_ADDED', userId: null, metadata: null },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('زيادة بعد الطلب');
    expect(event.detail).toBeNull();
  });
});
