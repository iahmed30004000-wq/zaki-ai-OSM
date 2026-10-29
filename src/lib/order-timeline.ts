import type { Prisma } from '@prisma/client';
import { db } from './db';
import { STATE_LABEL_AR } from './order-state';
import { SHIPPING_STATUS_AR } from './shipping-workflow';
import { CONFIRMATION_STATUS_AR } from './confirmation-workflow';
import { NOT_MENTIONED_ACTIVITY_AR } from './not-mentioned';
import { SWAP_ACTION } from './superseded';
import { POST_ORDER_ADDITION_AR } from './post-order-offer-copy';

type Tx = Prisma.TransactionClient | typeof db;

/**
 * ORDER TIMELINE — one merged, chronological history of an order.
 *
 * The repository writes events into five separate tables (status logs,
 * claim history, contact attempts, delivery attempts, activities) plus the
 * notes. Reading only one of them is how a screen ends up showing a history
 * that disagrees with the order's actual state, so the timeline merges all
 * of them and sorts once.
 */

export type TimelineKind =
  | 'STATUS'
  | 'OWNERSHIP'
  | 'CONTACT'
  | 'DELIVERY'
  | 'NOTE'
  | 'ACTIVITY'
  | 'CHANGE_REQUEST'
  | 'ISSUE';

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  at: Date;
  /** Short Arabic line for the panel. */
  title: string;
  detail?: string | null;
  actorId?: string | null;
  actorName?: string | null;
}

/**
 * The history is read by people, so it is written in their words.
 *
 * Every line here used to leak whatever the database happened to store: a
 * note headed "ملاحظة (internal)", a contact attempt reading
 * "محاولة اتصال 1 (PHONE): CONFIRMED", and — worst — an activity whose
 * entire detail was the raw metadata JSON, so the order history showed
 * {"source":"...","intakeMethod":"AI_PASTE"} to whoever opened it.
 */

/**
 * EVERY STORED STATUS VALUE AS A WORD.
 *
 * Exported because routes need it too: an Arabic sentence with
 * FOLLOW_UP_REQUIRED inside it is not an Arabic sentence, and
 * `arabic-refusals.test.ts` says so. Four other copies of this
 * vocabulary exist (OrderDetailModal, TrackingScreen, and the
 * confirmation route's own CONFIRMATION_AR) and they do not all agree —
 * IN_PROGRESS is «قيد التأكيد» here and «قيد المعالجة» there. That is a
 * terminology defect for the consistency pass, recorded not hidden.
 */
export const STATUS_VALUE_AR: Record<string, string> = {
  /*
   * THE TWO AXES' OWN WORDS, NOT A THIRD COPY OF THEM.
   *
   * This map used to re-list every core state and every shipping status by
   * hand, and one of them had drifted: `READY_FOR_PICKUP` read «جاهز
   * للاستلام» here while `SHIPPING_STATUS_AR` — which chose deliberately
   * between the two spellings it found in the wild — reads «بانتظار
   * الاستلام». So the same parcel was «جاهز للاستلام» in the order
   * dialog's timeline and «بانتظار الاستلام» on the tracking screen,
   * which is the whole defect `one-word-per-state` exists to prevent. It
   * could not catch this one: «جاهز للاستلام» was never added to its list
   * of retired spellings.
   *
   * The two owners agree wherever they overlap — that guard's first test
   * asserts it — so the spread order does not matter.
   */
  ...STATE_LABEL_AR,
  ...SHIPPING_STATUS_AR,

  // And the values neither axis names: the confirmation column, the
  // settlement column, and the words a change request carries.
  ...CONFIRMATION_STATUS_AR,
  PENDING: 'معلّق',
  PENDING_COLLECTION: 'لم يُحصَّل',
  COLLECTED: 'محصَّل',
  PARTIALLY_SETTLED: 'مسوّى جزئياً',
  SETTLED: 'مسوّى',
  UNSETTLED: 'غير مسوّى',
  REFUNDED: 'مُسترد',
  APPROVED: 'موافَق عليه',
  OPEN: 'مفتوح',
  CORRECTED: 'تم التصحيح',
};

const CLAIM_REASON_AR: Record<string, string> = {
  PULL_NEXT: 'سحب من الطابور',
  MANUAL_CLAIM: 'استلام يدوي',
  ADMIN_OVERRIDE: 'تجاوز إداري',
  AUTO_RELEASE: 'تحرير تلقائي',
  LOCK_EXPIRED: 'انتهت مدة القفل',
  REASSIGNED: 'إعادة إسناد',
};

const CONTACT_METHOD_AR: Record<string, string> = {
  PHONE: 'هاتف', WHATSAPP: 'واتساب', TELEGRAM: 'تلجرام', SMS: 'رسالة نصية', OTHER: 'أخرى',
};

const CONTACT_RESULT_AR: Record<string, string> = {
  CONFIRMED: 'وافق على الطلب', POSTPONED: 'طلب التأجيل', NO_ANSWER: 'لم يرد',
  REJECTED: 'رفض الطلب', CALLBACK_REQUESTED: 'طلب معاودة الاتصال',
  WRONG_NUMBER: 'الرقم خاطئ', BUSY: 'مشغول', UNREACHABLE: 'تعذّر الوصول',
};

const NOTE_KIND_AR: Record<string, string> = {
  internal: 'ملاحظة داخلية', customer: 'ملاحظة من العميل', system: 'ملاحظة النظام',
};

const ISSUE_REASON_AR: Record<string, string> = {
  WRONG_PHONE: 'رقم خاطئ', WRONG_ADDRESS: 'عنوان خاطئ', WRONG_PRODUCT: 'منتج خاطئ',
  MISSING_DATA: 'بيانات ناقصة', DUPLICATE: 'طلب مكرر', OTHER: 'أخرى',
};

const ACTIVITY_AR: Record<string, string> = {
  ORDER_CREATED: 'إنشاء الطلب',
  ORDER_UPDATED: 'تعديل بيانات الطلب',
  // What the customer added on the thank-you screen: the same words the order dialog and the confirmation card use.
  UPSELL_ADDED: POST_ORDER_ADDITION_AR,
  CUSTOMER_UPDATED: 'تعديل بيانات العميل',
  MODERATOR_ASSIGNED: 'إسناد مودريتور',
  CALL_MADE: 'اتصال بالعميل',
  NOTE_ADDED: 'إضافة ملاحظة',
  SHIPPING_UPDATED: 'تحديث الشحن',
  DELIVERY_FEE_CHANGED: 'تغيير أجرة التوصيل',
  PARTIAL_DELIVERY: 'تسليم جزئي',
  COURIER_ASSIGNED: 'إسناد شركة شحن',
  COURIER_TRANSFERRED: 'تحويل بين شركات الشحن',
  COURIER_SEND_CLEARED: 'فكّ إرسال عالق للشركة',
  COURIER_TOLD_TO_CANCEL: 'إبلاغ الشركة بإلغاء الطرد',
  TAKEN_OFF_BATCH: 'أُخرج من الدفعة',
  LABEL_STALE_REPRINT: 'بوليصة الطرد لم تعد تطابق الطلب — تُطبع من جديد',
  PARCEL_ATTESTED_IN_HAND: 'أكّد أن الطرد بين يديه',
  COURIER_CANCELLED_ORDER_MOVED: 'ألغت الشركة الطرد وتغيّر الطلب قبل الحفظ',
  // «كان من طرد طلب آخر»: the courier gave a box to another customer; both orders and the box's order say so.
  [SWAP_ACTION]: 'تبديل طرد عند الشركة',
  SWAP_BOX_GIVEN: 'بضاعة هذا الطرد سُلِّمت لزبون طلب آخر',
  // «فرق في المبلغ»: what the approval did with the answer a person gave, in that person's name.
  SETTLEMENT_DECISION_APPLIED: 'سُوّي الطلب برقم الشركة بعد بتّ مكتوب',
  SETTLEMENT_CLAIM_OPENED: 'بقي الطلب مطالبة على الشركة بالباقي',
  // «فرق تحصيل»: the company paid less than expected and the approval accepted its figure.
  SHORTFALL_PROPOSED: 'دفعت الشركة أقل من المتوقَّع — فرق تحصيل بانتظار قرار المالك أو المحاسب',
  SHORTFALL_ON_COMPANY: 'دفعت الشركة أقل من المتوقَّع — الفرق على الشركة',
  // «طلبات لم يذكرها أي كشف»: what a person decided about it, on the order itself.
  ...NOT_MENTIONED_ACTIVITY_AR,
};

const ar = (table: Record<string, string>, key: string | null | undefined): string =>
  (key && table[key]) || key || '—';

/** The fields of an activity's metadata worth showing, in words. */
const METADATA_AR: Record<string, string> = {
  source: 'المصدر', intakeMethod: 'طريقة الإدخال', createdBy: 'أدخله',
  updatedBy: 'عدّله', callResult: 'نتيجة الاتصال', notes: 'ملاحظات',
  caller: 'المتصل', role: 'الدور', fields: 'الحقول',
  feeBefore: 'الأجرة قبل', feeAfter: 'الأجرة بعد', feeReason: 'السبب',
  // The addition after the order: what was added, how many, for how much, from which offer.
  product: 'المنتج', quantity: 'الكمية', total: 'المجموع', offerName: 'العرض', landingPage: 'الصفحة',
};

/**
 * The stored VALUES that are English words or codes, in Arabic. A value nobody wrote a word for is shown as it is
 * (a store's own name is a source too), never blanked: a change that happened must stay visible.
 */
const VALUE_AR: Record<string, Record<string, string>> = {
  source: { 'Landing Page': 'صفحة هبوط', 'post-order offer': 'عرض بعد الطلب', 'public visitor': 'زائر' },
  intakeMethod: { AI_PASTE: 'لصق نص بالذكاء', MANUAL: 'يدوي', IMPORT: 'استيراد' },
  createdBy: { 'public visitor': 'زائر' },
};

const FIELD_AR: Record<string, string> = {
  customerName: 'اسم العميل', customerPhone: 'رقم الهاتف', customerAddress: 'العنوان',
  regionId: 'المحافظة', sellingPrice: 'السعر', quantity: 'الكمية',
  discountAmount: 'الخصم', shippingCost: 'أجرة الشحن', productId: 'المنتج',
};

/**
 * Metadata as a sentence, never as JSON. Anything the tables above do not
 * name is dropped rather than dumped: a key nobody wrote a label for is a
 * key nobody meant to show.
 */
function readableMetadata(metadata: unknown): string | null {
  /*
   * THE COLUMN IS TEXT. `OrderActivity.metadata` is a JSON string, and this read only an object — so every real
   * row (all of them strings) came out as «no details» and the whole table above was dead code. Parsed here, inside
   * a try: a row that is not JSON shows no details and breaks nothing.
   */
  let data: unknown = metadata;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    const label = METADATA_AR[key];
    if (!label || raw === null || raw === undefined || raw === '') continue;
    // An object under a labelled key (a nested record) is not a sentence: dropped rather than printed as [object Object].
    if (typeof raw === 'object' && !Array.isArray(raw)) continue;
    const value = Array.isArray(raw)
      ? raw.map((v) => (typeof v === 'string' ? ar(FIELD_AR, v) : String(v))).join('، ')
      : typeof raw === 'boolean'
        ? (raw ? 'نعم' : 'لا')
        : key === 'callResult'
          ? ar(CONTACT_RESULT_AR, String(raw))
          : (VALUE_AR[key]?.[String(raw)] ?? String(raw));
    if (value.trim()) parts.push(`${label}: ${value}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

export async function orderTimeline(tx: Tx, orderId: string): Promise<TimelineEvent[]> {
  const [statusLogs, claims, contacts, callLogs, deliveries, notes, activities, changeRequests, issues] = await Promise.all([
    tx.orderStatusLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.orderClaimHistory.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.orderContactAttempt.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.callLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.deliveryAttempt.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.orderNote.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.orderActivity.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.orderChangeRequest.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    tx.orderIssue.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
  ]);

  const actorIds = new Set<string>();
  for (const row of statusLogs) actorIds.add(row.changedById);
  for (const row of claims) actorIds.add(row.userId);
  for (const row of contacts) actorIds.add(row.employeeId);
  for (const row of callLogs) if (row.moderatorId) actorIds.add(row.moderatorId);
  for (const row of notes) if (row.authorId) actorIds.add(row.authorId);
  for (const row of activities) if (row.userId) actorIds.add(row.userId);
  for (const row of changeRequests) actorIds.add(row.requestedById);
  for (const row of issues) actorIds.add(row.raisedById);

  const users = actorIds.size
    ? await tx.user.findMany({ where: { id: { in: [...actorIds] } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));

  const CLAIM_LABEL: Record<string, string> = {
    CLAIMED: 'استلام الطلب',
    RELEASED: 'تحرير الطلب',
    TRANSFERRED: 'نقل الطلب',
    OVERRIDDEN: 'تجاوز الملكية',
    UNLOCKED: 'فك القفل',
  };
  const STATUS_TYPE: Record<string, string> = {
    CONFIRMATION: 'التأكيد',
    SHIPPING: 'الشحن',
    SETTLEMENT: 'التسوية',
    LEGACY: 'الحالة',
  };

  const events: TimelineEvent[] = [
    ...statusLogs.map((row) => ({
      id: `st_${row.id}`,
      kind: 'STATUS' as const,
      at: row.createdAt,
      title: `${STATUS_TYPE[row.statusType] ?? row.statusType}: ${ar(STATUS_VALUE_AR, row.previousValue)} ← ${ar(STATUS_VALUE_AR, row.newValue)}`,
      detail: row.note,
      actorId: row.changedById,
      actorName: nameOf.get(row.changedById) ?? null,
    })),
    ...claims.map((row) => ({
      id: `cl_${row.id}`,
      kind: 'OWNERSHIP' as const,
      at: row.createdAt,
      title: CLAIM_LABEL[row.action] ?? row.action,
      detail: row.reason ? ar(CLAIM_REASON_AR, row.reason) : null,
      actorId: row.userId,
      actorName: nameOf.get(row.userId) ?? null,
    })),
    ...contacts.map((row) => ({
      id: `ct_${row.id}`,
      kind: 'CONTACT' as const,
      at: row.createdAt,
      title: `محاولة اتصال ${row.attemptNumber} عبر ${ar(CONTACT_METHOD_AR, row.contactMethod)} — ${ar(CONTACT_RESULT_AR, row.result)}`,
      detail: row.note,
      actorId: row.employeeId,
      actorName: nameOf.get(row.employeeId) ?? null,
    })),
    ...callLogs.map((row) => ({
      id: `cg_${row.id}`,
      kind: 'CONTACT' as const,
      at: row.callDate ?? row.createdAt,
      title: `مكالمة — ${ar(CONTACT_RESULT_AR, row.result)}`,
      detail: row.notes,
      actorId: row.moderatorId,
      actorName: row.moderatorId ? nameOf.get(row.moderatorId) ?? null : null,
    })),
    ...deliveries.map((row) => ({
      id: `dl_${row.id}`,
      kind: 'DELIVERY' as const,
      at: row.createdAt,
      title: `محاولة توصيل ${row.attemptNumber} — ${ar(STATUS_VALUE_AR, row.result)}`,
      detail: row.failureReason ?? row.note,
      actorId: row.deliveryAgentId,
      actorName: null,
    })),
    ...notes.map((row) => ({
      id: `nt_${row.id}`,
      kind: 'NOTE' as const,
      at: row.createdAt,
      title: ar(NOTE_KIND_AR, row.kind),
      detail: row.body,
      actorId: row.authorId,
      actorName: row.authorId ? nameOf.get(row.authorId) ?? null : null,
    })),
    ...changeRequests.map((row) => ({
      id: `cr_${row.id}`,
      kind: 'CHANGE_REQUEST' as const,
      at: row.createdAt,
      title: `طلب تعديل — ${ar(STATUS_VALUE_AR, row.status)}`,
      detail: row.reason,
      actorId: row.requestedById,
      actorName: nameOf.get(row.requestedById) ?? null,
    })),
    ...issues.map((row) => ({
      id: `is_${row.id}`,
      kind: 'ISSUE' as const,
      at: row.createdAt,
      title: `إشكال إدخال: ${ar(ISSUE_REASON_AR, row.reason)} — ${ar(STATUS_VALUE_AR, row.status)}`,
      detail: row.note,
      actorId: row.raisedById,
      actorName: nameOf.get(row.raisedById) ?? null,
    })),
    // Activities repeat some of the above; keep only the ones nothing else covers.
    ...activities
      .filter((row) => row.action !== 'STATUS_CHANGED')
      .map((row) => ({
        id: `ac_${row.id}`,
        kind: 'ACTIVITY' as const,
        at: row.createdAt,
        title: ar(ACTIVITY_AR, row.action),
        detail: readableMetadata(row.metadata),
        actorId: row.userId,
        actorName: row.userId ? nameOf.get(row.userId) ?? null : null,
      })),
  ];

  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}
