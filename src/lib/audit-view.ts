/**
 * WHAT THE AUDIT SCREEN SAYS ABOUT A ROW — IN ARABIC, WITH A WAY TO THE THING IT NAMES.
 *
 * The log writes machine words on purpose (`ORDER_STATUS_CHANGED`, `Wallet`, a uuid):
 * they are stable keys, and nothing here changes what is written. This file is only
 * how the SCREEN reads them. Three rules decide every function below:
 *
 *   · NOTHING IS EVER HIDDEN BY A WORD WE DO NOT KNOW. A code with no Arabic falls back to
 *     the code itself — an audit row that reads blank is worse than one that reads in Latin;
 *   · a link is drawn only to a place that exists and is the record's own (an order, a product) —
 *     the permission to OPEN it is the page's, asked by the screen (`mayOpen`), not here;
 *   · the filter reads what the screen sends, and ignores what it does not understand rather
 *     than guessing — a typo'd date is «no date», not a 500.
 */

import { typed } from './text-search';

/** The record kinds the log carries, as people name them. */
export const ENTITY_AR: Record<string, string> = {
  Order: 'طلب', OrderChangeRequest: 'طلب تعديل', OrderChannel: 'قناة طلبات', Customer: 'عميل', CustomerBlock: 'حظر عميل',
  Product: 'منتج', ProductImage: 'صورة منتج', ProductReview: 'تقييم منتج', ProductionBatch: 'دفعة إنتاج', Category: 'تصنيف',
  Offer: 'عرض', User: 'مستخدم', Role: 'دور', Company: 'الشركة', Store: 'متجر', StorePage: 'صفحة متجر', StoreMenu: 'قائمة المتجر',
  StoreFont: 'خط المتجر', StoreRedirect: 'تحويل رابط', LandingPage: 'صفحة هبوط', Wallet: 'محفظة', WalletMovement: 'حركة محفظة',
  WalletTransfer: 'تحويل بين محافظ', CourierStatement: 'كشف مندوب', SettlementMatch: 'مطابقة كشف', DailyClosing: 'إغلاق يومي',
  Expense: 'مصروف', Payslip: 'قسيمة راتب', CommissionRule: 'قاعدة عمولة', CommissionEntry: 'عمولة', CommissionPayout: 'صرف عمولات',
  PenaltyRule: 'قاعدة غرامة', DeliveryProvider: 'شركة شحن', DeliveryFee: 'أجرة توصيل', ShippingBatch: 'دفعة شحن',
  Region: 'منطقة', Country: 'دولة', AdAccount: 'حساب إعلانات', Campaign: 'حملة', TrackingPixel: 'بكسل تتبّع',
  CustomConversion: 'تحويل مخصّص', TelegramSource: 'مصدر تلجرام', TelegramWebhook: 'ويب هوك تلجرام', WhatsAppConnection: 'ربط واتساب',
  WhatsAppConversation: 'محادثة واتساب', WhatsAppMessage: 'رسالة واتساب', SystemToken: 'مفتاح نظام', SystemSetting: 'إعداد نظام',
  App: 'تطبيق', AppInstall: 'تثبيت تطبيق', JobRun: 'مهمة مجدولة',
};

/** The last word of an action code, as a verb. Applied to the row's own record kind. */
const VERB_AR: Record<string, string> = {
  CREATED: 'إنشاء', UPDATED: 'تعديل', DELETED: 'حذف', RECORDED: 'تسجيل', APPROVED: 'اعتماد', PUBLISHED: 'نشر',
  CHANGED: 'تغيير', SET: 'ضبط', ENDED: 'إنهاء', IMPORTED: 'استيراد', UPLOADED: 'رفع', RENAMED: 'تسمية جديدة',
  REVERTED: 'تراجع', SAVED: 'حفظ', REFUSED: 'رفض', DISABLED: 'تعطيل', ENABLED: 'تفعيل', DUPLICATED: 'نسخ',
  CONNECTED: 'ربط', DISCONNECTED: 'فصل', REMOVED: 'إزالة', RETIRED: 'إيقاف', STOPPED: 'إيقاف', REGISTERED: 'تسجيل',
  CHECKED: 'فحص', SYNCED: 'مزامنة', PAID: 'صرف', ACCRUED: 'استحقاق', COUNTED: 'جرد', RECEIVED: 'استلام',
  RESOLVED: 'تسوية', MATCHED: 'مطابقة', TRANSFERRED: 'نقل', REVERSED: 'عكس', CLEARED: 'مسح',
};

/** Whole codes whose meaning is not their last word — security, orders, money. */
const ACTION_AR: Record<string, string> = {
  USER_LOGGED_IN: 'تسجيل دخول', USER_LOGGED_OUT: 'تسجيل خروج', USER_REGISTERED: 'تسجيل مستخدم جديد',
  INITIAL_SUPER_ADMIN_CREATED: 'إنشاء أوّل مدير', USER_CREATED_BY_ADMIN: 'إنشاء مستخدم من المدير',
  USER_PASSWORD_RESET_BY_ADMIN: 'إعادة تعيين كلمة مرور من المدير', PASSWORD_RESET_REQUESTED: 'طلب استعادة كلمة المرور',
  PASSWORD_RESET_COMPLETED: 'استعادة كلمة المرور', USER_PERMISSION_OVERRIDE_REMOVED: 'إزالة استثناء صلاحية',
  TWO_FACTOR_ENABLED: 'تفعيل التحقّق بخطوتين', TWO_FACTOR_FAILED: 'فشل التحقّق بخطوتين', TWO_FACTOR_RESET: 'إعادة ضبط التحقّق بخطوتين',
  TWO_FACTOR_RECOVERY_USED: 'استعمال رمز استرداد', TWO_FACTOR_DEVICE_TRUSTED: 'الوثوق بجهاز', PASSKEY_FAILED: 'فشل مفتاح المرور',
  PASSKEY_REGISTERED: 'تسجيل مفتاح مرور', PASSKEY_REMOVED: 'حذف مفتاح مرور', SUPER_ADMIN_OVERRIDE: 'تجاوز بصلاحية المدير الأعلى',
  ORDER_CREATED: 'إنشاء طلب', ORDER_CREATED_AI_INTAKE: 'إنشاء طلب من المساعد', ORDER_CREATED_TELEGRAM: 'إنشاء طلب من تلجرام',
  ORDER_UPDATED: 'تعديل طلب', ORDER_UPDATED_BY_CHANGE_REQUEST: 'تعديل طلب بموجب طلب تعديل', ORDER_UPDATED_IN_BATCH: 'تعديل طلب قبل إغلاق الشحنة', ORDER_CONFIRMED: 'تأكيد طلب',
  ORDER_REJECTED: 'رفض طلب', ORDER_STATUS_CHANGED: 'تغيير حالة طلب', ORDER_CLAIMED: 'سحب طلب', ORDER_RELEASED: 'إرجاع طلب للطابور',
  ORDER_TRANSFERRED: 'نقل طلب لموظف آخر', ORDER_LOCKED: 'قفل طلب', ORDER_UNLOCKED: 'فتح قفل طلب', ORDER_ISSUE_RAISED: 'رفع إشكال على طلب',
  ORDER_ISSUE_CORRECTED: 'تصحيح إشكال طلب', ORDER_VOIDED_AFTER_ISSUE: 'إبطال طلب بعد إشكال', ORDER_WRITTEN_OFF: 'شطب طلب',
  ORDERS_EXPORTED: 'تصدير طلبات', SHIPPING_STATUS_CHANGED: 'تغيير حالة الشحن', SHIPPING_INFO_UPDATED: 'تعديل معلومات الشحن', DELIVERY_FEE_CHANGED: 'تغيير أجرة التوصيل',
  COURIER_SEND_CLEARED: 'فكّ إرسال عالق للشركة', SHIPMENT_CANCEL_COURIER_TOLD: 'إبلاغ الشركة بإلغاء طرد', PARCEL_ATTESTED_IN_HAND: 'تأكيد أن الطرد بين يدي المستودع', SHIP_HOLD_SET: 'إيقاف شحن طلب', SHIP_HOLD_RELEASED: 'رفع إيقاف شحن طلب', RETURN_RECEIVED: 'استلام مرتجع', LABELS_PRINTED: 'طباعة بوالص',
  CHANGE_REQUEST_APPROVED: 'اعتماد طلب تعديل', CHANGE_REQUEST_REJECTED: 'رفض طلب تعديل', CHANGE_REQUEST_RAISED: 'رفع طلب تعديل',
  CHANGE_REQUEST_WITHDRAWN: 'سحب طلب تعديل', POSTPONED_RETURNED_TO_QUEUE: 'إرجاع مؤجَّل للطابور',
  WALLET_TRANSFER: 'تحويل بين محافظ', WALLET_MOVEMENT_RECORDED: 'تسجيل حركة محفظة', WALLET_MOVEMENT_REVERSED: 'عكس حركة محفظة',
  WALLET_OPENING_COUNTED: 'جرد افتتاحي لمحفظة', WALLET_STOPPED: 'إيقاف محفظة', DAILY_CLOSING_RECORDED: 'تسجيل إغلاق يومي',
  DAILY_CLOSING_APPROVED: 'اعتماد إغلاق يومي', STATEMENT_APPROVED: 'اعتماد كشف', STATEMENT_IMPORTED: 'استيراد كشف',
  STATEMENT_MATCHED: 'مطابقة كشف', SETTLEMENT_DIFFERENCE_RESOLVED: 'تسوية فرق كشف', SETTLEMENT_DIFFERENCES_RESOLVED_BULK: 'بتّ جماعي في فروق كشف', COMMISSION_PAID: 'صرف عمولات',
  STATEMENT_UNMENTIONED_ORDER_ANSWERED: 'قرار بشأن طلب لم يذكره كشف', STATEMENT_LINE_LINKED_BY_HAND: 'ربط سطر كشف بطلب يدوياً',
  SALARY_PAID: 'صرف راتب', EXPENSE_RECORDED: 'تسجيل مصروف', EXPENSE_VOIDED: 'إلغاء مصروف', STOCK_RECEIVED: 'استلام مخزون', STOCK_RECOUNTED: 'إعادة جرد مخزون',
  STOCK_OPENING_COUNTED: 'جرد افتتاحي للمخزون', SYSTEM_TOKEN_CREATED: 'إنشاء مفتاح نظام', SYSTEM_TOKEN_REVOKED: 'إلغاء مفتاح نظام',
  CUSTOMER_BLOCKED: 'حظر عميل', CUSTOMER_BLOCK_RELEASED: 'رفع حظر عميل', CUSTOMER_BULK_VIEW: 'اطّلاع جماعي على عملاء',
  SETTINGS_UPDATED: 'تعديل إعدادات', JOB_RUN_MANUAL: 'تشغيل مهمة يدوياً', TELEGRAM_MESSAGE_CORRECTED: 'تعديل رسالة تلجرام يدوياً',
};

const looksLikeCode = (s: string) => /^[A-Z][A-Z0-9_]*$/.test(s);

/** One short Arabic phrase for what happened. Falls back to the code itself — never blank. */
export function describeAction(action: string, entity: string): string {
  if (ACTION_AR[action]) return ACTION_AR[action];
  if (looksLikeCode(action)) {
    const verb = VERB_AR[action.split('_').pop() ?? ''];
    const what = ENTITY_AR[entity];
    if (verb && what) return `${verb} ${what}`;
    if (verb) return verb;
  }
  return action;
}

export const entityLabel = (entity: string): string => ENTITY_AR[entity] ?? entity;

/**
 * Where the record named by a row lives, if it has a page of its own. Only the two that do:
 * an order (`/orders/<id>` — the canonical address) and a product (`/products/<id>`).
 * Everything else is plain text; a link that lands on a list is a promise the row cannot keep.
 */
export function entityHref(entity: string, entityId: string): string | null {
  if (!/^[0-9a-f-]{8,}$/i.test(entityId)) return null;
  if (entity === 'Order') return `/orders/${entityId}`;
  if (entity === 'Product') return `/products/${entityId}`;
  return null;
}

export interface AuditQuery {
  user?: string;
  entity?: string;
  q?: string;
  from?: string;
  to?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: string | null): string | undefined => (v && DAY.test(v) && !Number.isNaN(Date.parse(v)) ? v : undefined);
const word = (v: string | null, max = 80): string | undefined => {
  const t = (v ?? '').trim();
  return t && t !== 'all' ? t.slice(0, max) : undefined;
};

/** What the screen asked, read strictly: anything it cannot understand is «not asked». */
export function readAuditQuery(params: URLSearchParams): AuditQuery {
  return {
    user: word(params.get('user')),
    entity: word(params.get('entity')),
    q: word(params.get('q')),
    from: day(params.get('from')),
    to: day(params.get('to')),
  };
}

/**
 * The `where` for `auditLog.findMany`. The company is not optional and not the caller's to widen.
 * `q` finds an action code, the record's id, or the Arabic words of an action or a record kind
 * (typing «حذف» or «طلب» finds the codes that read so).
 * Day bounds follow the orders list: the whole of both days, in UTC.
 */
export function auditWhere(companyId: string, query: AuditQuery) {
  const and: Record<string, unknown>[] = [];
  if (query.user) and.push(query.user === 'system' ? { userId: null } : { userId: query.user });
  if (query.entity) and.push({ entity: query.entity });
  if (query.from || query.to) {
    and.push({
      createdAt: {
        ...(query.from ? { gte: new Date(`${query.from}T00:00:00.000Z`) } : {}),
        ...(query.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
      },
    });
  }
  if (query.q) {
    const needle = query.q;
    const byArabic = Object.entries(ACTION_AR)
      .filter(([, ar]) => ar.includes(needle))
      .map(([code]) => code);
    const byEntity = Object.entries(ENTITY_AR)
      .filter(([, ar]) => ar.includes(needle))
      .map(([e]) => e);
    const byVerb = Object.entries(VERB_AR)
      .filter(([, ar]) => ar.includes(needle))
      .map(([code]) => ({ action: { endsWith: `_${code}` } }));
    and.push({
      OR: [
        { action: typed(needle.replace(/\s+/g, '_')) },
        ...byVerb,
        { entityId: { startsWith: needle, mode: 'insensitive' } },
        ...(byArabic.length ? [{ action: { in: byArabic } }] : []),
        ...(byEntity.length ? [{ entity: { in: byEntity } }] : []),
      ],
    });
  }
  return { companyId, ...(and.length ? { AND: and } : {}) };
}

/**
 * What changed, as a line a person can read: the first few plain fields of the saved JSON as
 * «key: value». The full text stays on the row's tooltip — this is the glance, not the record.
 * Not JSON, or JSON with nothing plain in it, falls back to the text cut short.
 */
export function summariseChange(raw: string | null | undefined, max = 90): string {
  if (!raw) return '—';
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const parts = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && String(v) !== '')
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${String(v)}`);
      if (parts.length) {
        const line = parts.join(' · ');
        return line.length > max ? `${line.slice(0, max)}…` : line;
      }
    }
  } catch {
    /* not JSON — shown as it is */
  }
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}
