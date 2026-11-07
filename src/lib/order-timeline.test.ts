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

describe('a status the courier moved reads in Arabic, with no English key or value (RV146 follow-up)', () => {
  /** Exactly what couriers/apply-event writes: a JSON string whose `source` is POLL or WEBHOOK. */
  const synced = (source: 'POLL' | 'WEBHOOK') =>
    JSON.stringify({ courier: 'الباشا', rawStatus: 'SCANNED_BY_DRIVER_AND_IN_CAR', note: 'مع السائق', source });

  it('POLL and WEBHOOK are words, and the raw courier code and the keys stay hidden', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a1', createdAt: at('2026-09-02T10:00:00Z'), action: 'COURIER_STATUS_SYNCED', userId: null, metadata: synced('POLL') },
      { id: 'a2', createdAt: at('2026-09-02T11:00:00Z'), action: 'COURIER_STATUS_SYNCED', userId: null, metadata: synced('WEBHOOK') },
    ]);
    const events = await orderTimeline(db as never, 'o1');
    expect(events.map((e) => e.detail)).toEqual(['المصدر: استعلام من الشركة', 'المصدر: إشعار من الشركة']);
    for (const e of events) {
      expect(e.detail).not.toMatch(/POLL|WEBHOOK|rawStatus|SCANNED|courier/);
      expect(e.title).toBe('الشركة حدّثت حالة الطرد');
    }
  });

  it('NEGATIVE: a source value nobody translated is still shown as written, never blanked', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a3', createdAt: at('2026-09-02T10:00:00Z'), action: 'COURIER_STATUS_SYNCED', userId: null, metadata: synced('POLL').replace('POLL', 'متجر الورد') },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('المصدر: متجر الورد');
  });

  it('a stored OBJECT (an older row) reads the same as the JSON string', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a4', createdAt: at('2026-09-02T10:00:00Z'), action: 'COURIER_STATUS_SYNCED', userId: null, metadata: { courier: 'الباشا', rawStatus: 'X', source: 'POLL' } },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.detail).toBe('المصدر: استعلام من الشركة');
  });
});

describe('«طلب تاني فعلاً» — the history says she knew (the confirm guard, 2/11)', () => {
  const stored = (obj: unknown) => JSON.stringify(obj);

  it('reads as a sentence with the orders she was told about, never as the constant or the JSON', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      {
        id: 'a1', createdAt: at('2026-11-02T10:00:00Z'), action: 'TWIN_CONFIRM_ACKNOWLEDGED', userId: 'u1',
        metadata: stored({ twins: ['ORD-2026-1711', 'ORD-2026-1701'] }),
      },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('أُكِّد الطلب مع العلم بوجود طلب مؤكَّد لنفس الزبون بنفس المنتج');
    expect(event.detail).toBe('الطلبات المؤكَّدة المشابهة: ORD-2026-1711، ORD-2026-1701');
    expect(event.actorName).toBe('سارة');
    expect(`${event.title} ${event.detail}`).not.toMatch(/TWIN_CONFIRM|\{|\[|"/);
  });

  it('NEGATIVE: a row with no numbers still has its Arabic title and no details', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      { id: 'a2', createdAt: at('2026-11-02T10:00:00Z'), action: 'TWIN_CONFIRM_ACKNOWLEDGED', userId: 'u1', metadata: null },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).not.toContain('TWIN_CONFIRM');
    expect(event.detail).toBeNull();
  });
});

describe('«زبون واحد، موظفة وحدة» — the history says why the order waits for her (the pull, 2/11)', () => {
  it('reads as a sentence naming the order she pulled — never the agent id, the order id, the constant or the JSON', async () => {
    db.orderActivity.findMany.mockResolvedValue([
      {
        id: 'h1', createdAt: at('2026-11-02T10:00:00Z'), action: 'HELD_WITH_HIS_OTHER_ORDER', userId: null,
        metadata: JSON.stringify({ agentId: 'u-sara', pulledOrderId: 'cuid-123', withOrder: 'ORD-2026-1896' }),
      },
    ]);
    const [event] = await orderTimeline(db as never, 'o1');
    expect(event.title).toBe('حُجز للموظفة اللي سحبت طلباً تانياً لنفس الزبون');
    expect(event.detail).toBe('مع الطلب: ORD-2026-1896');
    expect(`${event.title} ${event.detail}`).not.toMatch(/HELD_WITH|u-sara|cuid-123|\{|"/);
  });
});

describe('«الزبون على الخط» — an order taken from a colleague names both of them (the owner, 7/11)', () => {
  const PEOPLE = [{ id: 'u1', name: 'سارة' }, { id: 'u2', name: 'هند' }];
  const claim = (over: Record<string, unknown>) => ({
    id: 'c1', createdAt: at('2026-11-07T10:00:00Z'), action: 'CLAIMED', userId: 'u1', reason: null, metadata: null, ...over,
  });
  beforeEach(() => {
    // The lookup answers only the ids it is asked for — a name nobody asked for is not found.
    db.user.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => PEOPLE.filter((u) => where.id.in.includes(u.id)));
  });

  it('the CLAIMED line says who it was taken from, by name', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ reason: 'CUSTOMER_CALLED_BACK', metadata: JSON.stringify({ role: 'CONFIRMATION_AGENT', fromUserId: 'u2' }) }),
    ]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.title).toBe('استلام الطلب');
    expect(line.detail).toBe('الزبون اتصل — أخدته على الخط من هند');
    expect(line.actorName).toBe('سارة');
    // Her name had to be asked for: the line's own user is Sara, and Hind is named only in its metadata.
    expect(db.user.findMany.mock.calls[0][0].where.id.in).toEqual(expect.arrayContaining(['u1', 'u2']));
  });

  it('the RELEASED line is the taker’s act, not the colleague’s and not the system’s — and names the colleague', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ id: 'c0', action: 'RELEASED', userId: 'u2', reason: 'TAKEN_ON_THE_LINE', metadata: JSON.stringify({ automatic: false, takenBy: 'u1' }) }),
    ]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.title).toBe('تحرير الطلب');
    expect(line.detail).toBe('اتسحب من هند على الخط — الزبون اتصل وما كانت اتصلت فيه');
    expect(line.actorName, 'كأنو هند حرّرته').toBe('سارة');
    expect(line.actorId).toBe('u1');
    expect(line.actorName).not.toBe('النظام');
  });

  it('read together, the two lines come out in the order they were written, in words and with no code', async () => {
    const t = at('2026-11-07T10:00:00Z');
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ id: 'c0', createdAt: t, action: 'RELEASED', userId: 'u2', reason: 'TAKEN_ON_THE_LINE', metadata: JSON.stringify({ automatic: false, takenBy: 'u1' }) }),
      claim({ id: 'c1', createdAt: t, reason: 'CUSTOMER_CALLED_BACK', metadata: JSON.stringify({ role: 'CONFIRMATION_AGENT', fromUserId: 'u2' }) }),
    ]);
    const lines = await orderTimeline(db as never, 'o1');
    expect(lines.map((l) => l.title)).toEqual(['تحرير الطلب', 'استلام الطلب']);
    expect(JSON.stringify(lines)).not.toMatch(/TAKEN_ON_THE_LINE|CUSTOMER_CALLED_BACK|takenBy|fromUserId|automatic/);
  });

  it('NEGATIVE: a line written before this rule (no fromUserId) keeps its static words', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ reason: 'CUSTOMER_CALLED_BACK', metadata: JSON.stringify({ role: 'CONFIRMATION_AGENT' }) }),
      claim({ id: 'c2', reason: 'CUSTOMER_CALLED_BACK', metadata: null }),
    ]);
    const lines = await orderTimeline(db as never, 'o1');
    expect(lines.map((l) => l.detail)).toEqual(['الزبون اتصل — أخدته على الخط', 'الزبون اتصل — أخدته على الخط']);
  });

  it('NEGATIVE: metadata that is not JSON, or names a person who is gone, breaks nothing and keeps the static words', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ reason: 'CUSTOMER_CALLED_BACK', metadata: '{not json' }),
      claim({ id: 'c2', reason: 'CUSTOMER_CALLED_BACK', metadata: JSON.stringify({ fromUserId: 'u-deleted' }) }),
    ]);
    const lines = await orderTimeline(db as never, 'o1');
    expect(lines.map((l) => l.detail)).toEqual(['الزبون اتصل — أخدته على الخط', 'الزبون اتصل — أخدته على الخط']);
    expect(JSON.stringify(lines)).not.toMatch(/undefined|u-deleted/);
  });

  it('NEGATIVE: a RELEASED line that does not say who took it keeps the colleague as its actor and the static words', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ action: 'RELEASED', userId: 'u2', reason: 'TAKEN_ON_THE_LINE', metadata: null }),
    ]);
    const [line] = await orderTimeline(db as never, 'o1');
    expect(line.detail).toBe('اتسحب منها على الخط — الزبون اتصل وما كانت اتصلت فيه');
    expect(line.actorName).toBe('هند');
  });

  it('NEGATIVE: the new reasons change no other line — her own release is still hers, a pull is still a pull', async () => {
    db.orderClaimHistory.findMany.mockResolvedValue([
      claim({ action: 'RELEASED', userId: 'u2', reason: 'MANUAL_RELEASE', metadata: JSON.stringify({ takenBy: 'u1', fromUserId: 'u1' }) }),
      claim({ id: 'c2', reason: 'PULL_NEXT', metadata: JSON.stringify({ role: 'CONFIRMATION_AGENT', fromUserId: 'u2' }) }),
    ]);
    const lines = await orderTimeline(db as never, 'o1');
    expect(lines.map((l) => [l.actorName, l.detail])).toEqual([['هند', 'MANUAL_RELEASE'], ['سارة', 'سحب من الطابور']]);
  });
});
