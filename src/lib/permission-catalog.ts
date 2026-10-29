// ─── PERMISSION CATALOG for the Roles & Permissions UI ───
// Canonical engine keys only (legacy-only keys such as orders.update are
// excluded; never-granted keys are excluded — see AGENTS phase notes).
// Arabic labels mirror PERMISSION_LABELS from types/auth where available.
// This module is client-safe (no server imports).

export type ScopeValue = 'ALL_COMPANY' | 'OWN' | 'ASSIGNED' | 'CATEGORY' | 'SPECIFIC';

export interface CatalogItem {
  key: string;
  ar: string;
  en: string;
  /** Scopes selectable in the matrix for this key (omit = ALL_COMPANY only). */
  scopes?: ScopeValue[];
}

export interface CatalogModule {
  module: string; // stable module id (English)
  items: CatalogItem[];
}

export const PERMISSION_MODULES: CatalogModule[] = [
  {
    module: 'dashboard',
    items: [{ key: 'dashboard.view', ar: 'عرض لوحة التحكم', en: 'View dashboard' }],
  },
  {
    module: 'orders',
    items: [
      { key: 'orders.view', ar: 'عرض الطلبات', en: 'View orders', scopes: ['ALL_COMPANY', 'OWN', 'ASSIGNED'] },
      { key: 'orders.edit', ar: 'تعديل الطلبات', en: 'Edit orders', scopes: ['ALL_COMPANY', 'OWN', 'ASSIGNED'] },
      { key: 'orders.create', ar: 'إنشاء طلبات', en: 'Create orders' },
      /**
       * SEPARATE FROM `orders.create`, BECAUSE A FILE IS NOT A ROW.
       *
       * The import dialog posts its rows to the same door a single entry
       * uses, one call each. So whoever could type ONE order could feed a
       * spreadsheet of three hundred through the same permission — and the
       * owner's rule is that a confirmation agent types orders by hand and
       * does not import.
       */
      { key: 'orders.import', ar: 'استيراد طلبات', en: 'Import orders' },
      /**
       * Recording what happened on a call had no permission of its own: the
       * contact-attempts door took `orders.edit` OR `orders.claim`, and the
       * `contact_result` action rode on `orders.confirm`. Three different
       * permissions, none of them about the telephone.
       */
      { key: 'orders.contact_log', ar: 'تسجيل نتيجة الاتصال', en: 'Log contact result' },
      /**
       * The arrows in the order window. They had no permission at all, and
       * they walked the READ envelope — which carries the unclaimed queue.
       * So one order opened was a door onto the whole pool, the pool C2 had
       * just taken out of the agent's list.
       */
      { key: 'orders.navigate', ar: 'التنقّل بين الطلبات (السابق واللاحق)', en: 'Navigate between orders' },
      { key: 'orders.assign', ar: 'إسناد الطلبات', en: 'Assign orders' },
      { key: 'orders.claim', ar: 'استلام الطلبات', en: 'Claim orders' },
      { key: 'orders.release', ar: 'تحرير الطلبات', en: 'Release orders' },
      { key: 'orders.unlock', ar: 'تجاوز أقفال التحرير', en: 'Override edit locks' },
      { key: 'orders.confirm', ar: 'تغيير حالة التأكيد', en: 'Change confirmation status' },
      { key: 'orders.change_status', ar: 'تغيير حالة الشحن', en: 'Change shipping status' },
    ],
  },
  {
    module: 'customers',
    items: [
      { key: 'customers.view', ar: 'عرض العملاء', en: 'View customers', scopes: ['ALL_COMPANY', 'OWN'] },
      { key: 'customers.view_basic', ar: 'عرض بيانات العميل الأساسية', en: 'View basic customer info', scopes: ['ALL_COMPANY', 'OWN'] },
      { key: 'customers.create', ar: 'إنشاء عملاء', en: 'Create customers' },
    ],
  },
  {
    module: 'products',
    items: [
      { key: 'products.view', ar: 'عرض المنتجات', en: 'View products', scopes: ['ALL_COMPANY', 'CATEGORY', 'SPECIFIC'] },
      { key: 'products.edit', ar: 'تعديل المنتجات', en: 'Edit products', scopes: ['ALL_COMPANY', 'CATEGORY', 'SPECIFIC'] },
      { key: 'products.create', ar: 'إنشاء منتجات', en: 'Create products' },
      { key: 'products.delete', ar: 'حذف منتجات', en: 'Delete products' },
      { key: 'products.change_price', ar: 'تغيير أسعار المنتجات', en: 'Change product prices' },
      { key: 'products.upload_images', ar: 'رفع صور المنتجات', en: 'Upload product images' },
      // Reading the category list, which the permission scope pickers need.
      { key: 'categories.view', ar: 'عرض التصنيفات', en: 'View categories' },
    ],
  },
  {
    module: 'offers',
    items: [
      { key: 'offers.view', ar: 'عرض العروض', en: 'View offers' },
      { key: 'offers.manage', ar: 'إدارة العروض', en: 'Manage offers' },
    ],
  },
  {
    module: 'inventory',
    items: [
      { key: 'inventory.view', ar: 'عرض المخزون', en: 'View inventory' },
      { key: 'inventory.adjust', ar: 'تعديل المخزون', en: 'Adjust inventory' },
    ],
  },
  {
    module: 'production',
    items: [
      { key: 'production.view', ar: 'عرض الإنتاج', en: 'View production' },
      { key: 'production.manage', ar: 'إدارة الإنتاج', en: 'Manage production' },
    ],
  },
  {
    module: 'finance',
    items: [
      { key: 'finance.view', ar: 'عرض المالية', en: 'View finance' },
      { key: 'finance.create', ar: 'إنشاء معاملات مالية', en: 'Create financial transactions' },
      { key: 'finance.update', ar: 'تعديل السجلات المالية', en: 'Update financial records' },
      { key: 'finance.cashbox', ar: 'إدارة الصناديق النقدية', en: 'Manage cashboxes' },
    ],
  },
  {
    module: 'settlement',
    items: [
      { key: 'settlement.view', ar: 'عرض التسويات (وصفوف التحصيل ومبالغها في المتابعة)', en: 'View settlements (and the collection rows and their figures in tracking)' },
      { key: 'settlement.upload', ar: 'رفع تقارير الشحن', en: 'Upload shipping reports' },
      { key: 'settlement.review', ar: 'مراجعة المطابقات', en: 'Review reconciliations' },
    ],
  },
  {
    module: 'reports',
    items: [
      { key: 'reports.view', ar: 'عرض التقارير', en: 'View reports' },
      { key: 'reports.export', ar: 'تصدير التقارير', en: 'Export reports' },
      { key: 'analytics.view', ar: 'عرض التحليلات', en: 'View analytics' },
      // Says what it opens: the in-screen assistants (confirmation, picking,
      // landing pages, AI order entry) answer to the key of the work they sit
      // in, so «منع» on this one turns off the bubble, the assistant page and
      // «اسأل الذكاء» — not those.
      { key: 'ai.use', ar: 'المساعد العام — الفقاعة وصفحة المساعد وسؤال الأرقام', en: 'General assistant — bubble, assistant page, ask the numbers' },
    ],
  },
  {
    module: 'users',
    items: [
      { key: 'users.view', ar: 'عرض المستخدمين', en: 'View users' },
      { key: 'users.create', ar: 'إنشاء مستخدمين', en: 'Create users' },
      { key: 'users.edit', ar: 'تعديل المستخدمين', en: 'Edit users' },
    ],
  },
  {
    module: 'roles',
    items: [
      { key: 'roles.view', ar: 'عرض الأدوار والصلاحيات', en: 'View roles & permissions' },
      { key: 'roles.create', ar: 'إنشاء أدوار', en: 'Create roles' },
      { key: 'roles.edit', ar: 'تعديل الأدوار والصلاحيات', en: 'Edit roles & permissions' },
      { key: 'roles.delete', ar: 'حذف أدوار', en: 'Delete roles' },
    ],
  },
  {
    module: 'settings',
    items: [
      { key: 'settings.view', ar: 'عرض الإعدادات', en: 'View settings' },
      { key: 'settings.edit', ar: 'تعديل إعدادات النظام', en: 'Edit system settings' },
      /*
       * THE LABEL IS WHAT SOMEBODY GRANTS BY, so it has to name the whole
       * authority — not the first door it was written for.
       *
       * It said «تشغيل المهام المجدولة» / «Run scheduled jobs», which is one
       * of ELEVEN routes it gates. The other ten include the ones that
       * matter most: a courier's API credentials (read and test), the ad
       * accounts, and the AI provider settings — all of them keys. A manager
       * handing an operations person what the screen calls "run scheduled
       * jobs" was handing them the company's courier and ad-account
       * credentials, and nothing on the screen said so.
       *
       * Found on 2026-10-02 while auditing the launch-flag work, which uses
       * `settings.edit` for its own flip precisely because this one did not
       * read like what it is. Guarded in `permission-labels.test.ts`: the
       * label must still name the keys for as long as it gates them.
       */
      {
        key: 'settings.manage',
        ar: 'إعدادات النظام الحسّاسة — مفاتيح شركات الشحن والإعلانات والذكاء، وتشغيل المهام المجدولة',
        en: 'Sensitive system settings — courier, ad-account and AI credentials, and running scheduled jobs',
      },
    ],
  },
  {
    module: 'confirmation',
    items: [
      { key: 'confirmation.pull', ar: 'سحب الطلب التالي', en: 'Pull next order' },
      { key: 'confirmation.work', ar: 'العمل على طلباتي والمؤجلة', en: 'Work own and postponed orders' },
      { key: 'confirmation.supervise', ar: 'الإشراف على التأكيد (عرض القائمة)', en: 'Supervise confirmation (list view)' },
      { key: 'confirmation.issues', ar: 'إشكالات الإدخال', en: 'Entry issues' },
    ],
  },
  {
    module: 'ops',
    items: [
      { key: 'ops.prepare', ar: 'التجهيز', en: 'Preparation' },
      { key: 'ops.ship', ar: 'إنشاء الشحنات', en: 'Create shipments' },
      { key: 'ops.labels', ar: 'البوالص', en: 'Labels' },
      { key: 'ops.track', ar: 'متابعة الشحن', en: 'Tracking' },
      { key: 'ops.returns', ar: 'المرتجعات', en: 'Returns' },
      // Seeing the return rows on «متابعة الشحن» — NOT receiving the stock, which stays «المرتجعات» above.
      { key: 'ops.returns_view', ar: 'عرض المرتجعات في المتابعة (بلا استلام)', en: 'See return rows in tracking (no receiving)' },
    ],
  },
  {
    module: 'control',
    items: [
      { key: 'control.change_requests', ar: 'طلبات التعديل', en: 'Change requests' },
      { key: 'control.discount_alerts', ar: 'تنبيهات الخصم', en: 'Discount alerts' },
      { key: 'control.blacklist', ar: 'القائمة السوداء', en: 'Blacklist' },
    ],
  },
  {
    module: 'team',
    items: [
      // Seeing your OWN card needs nothing: they are your numbers. This is
      // the key that lets somebody see their TEAM's — a different decision,
      // and one the owner grants deliberately.
      { key: 'team.monitor', ar: 'متابعة أداء الفريق', en: 'Monitor team performance' },

    ],
  },
  {
    module: 'payroll',
    items: [
      // A salary is not covered by `users.view`. That key exists so people
      // can find a colleague and see who does what; it would hand every
      // supervisor who holds it the whole company's pay.
      { key: 'payroll.view', ar: 'عرض الرواتب', en: 'View salaries' },
      // Setting a salary and paying it are one authority, because the
      // payslip snapshots the salary AT payment: whoever can hand the money
      // over can already decide the amount at the moment of handing it.
      { key: 'payroll.pay', ar: 'تحديد الرواتب وصرفها', en: 'Set and pay salaries' },
    ],
  },
  {
    module: 'penalties',
    items: [
      // Seeing what the system PROPOSED is not deciding it. Two keys,
      // because reading a list of other people's lateness and taking money
      // off somebody are not the same authority — and one key for both
      // would hand the second to everybody who needed the first.
      { key: 'penalties.view', ar: 'عرض الخصومات المقترحة', en: 'View proposed deductions' },
      { key: 'penalties.decide', ar: 'اعتماد الخصومات أو إلغاؤها', en: 'Apply or waive deductions' },
    ],
  },
  {
    module: 'growth',
    items: [{ key: 'growth.intelligence', ar: 'مركز الذكاء', en: 'Business intelligence' }],
  },
  {
    module: 'apps',
    items: [
      { key: 'apps.view', ar: 'عرض التطبيقات', en: 'View apps' },
      // Installing an app connects the company to something outside it, and
      // registering one hands out a signing secret. Both are a separate
      // authority from looking at the shelf.
      { key: 'apps.manage', ar: 'تثبيت وتسجيل التطبيقات', en: 'Install & register apps' },
    ],
  },
  {
    module: 'geo',
    items: [
      { key: 'geo.view', ar: 'عرض البلدان والمتاجر', en: 'View countries & stores' },
      { key: 'geo.manage', ar: 'إدارة البلدان والمتاجر والمناطق', en: 'Manage countries, stores & regions' },
    ],
  },
  {
    // The shop's own face: how it looks, what it says, and the address it
    // answers on. Separate from geo.manage, which is about which countries
    // and stores EXIST — a designer may lay out the storefront without
    // being able to open or close a store.
    module: 'storefront',
    items: [
      { key: 'storefront.view', ar: 'عرض واجهة المتجر', en: 'View storefront' },
      { key: 'storefront.manage', ar: 'تصميم واجهة المتجر ومحتواها', en: 'Design storefront & content' },
      // Releasing to customers is a different authority from designing: a
      // shop can have somebody who prepares and somebody who decides it goes
      // out. Saving a draft never needs this.
      { key: 'storefront.publish', ar: 'نشر واجهة المتجر', en: 'Publish the storefront' },
      // A domain points the outside world at this shop, and a wrong one
      // takes the shop off the air. Its own authority, like apps.manage.
      { key: 'storefront.domain', ar: 'ربط نطاق المتجر', en: 'Connect the store domain' },
    ],
  },
  {
    module: 'landing_pages',
    items: [
      { key: 'landing_pages.view', ar: 'عرض صفحات الهبوط', en: 'View landing pages' },
      { key: 'landing_pages.create', ar: 'إنشاء صفحات هبوط', en: 'Create landing pages' },
      { key: 'landing_pages.edit', ar: 'تعديل صفحات الهبوط', en: 'Edit landing pages' },
      { key: 'landing_pages.delete', ar: 'حذف صفحات هبوط', en: 'Delete landing pages' },
      { key: 'landing_pages.publish', ar: 'نشر / إلغاء نشر صفحات الهبوط', en: 'Publish / unpublish landing pages' },
    ],
  },
  {
    module: 'whatsapp',
    items: [
      { key: 'whatsapp.view', ar: 'عرض صندوق واتساب', en: 'View WhatsApp inbox' },
      { key: 'whatsapp.send', ar: 'إرسال رسائل واتساب', en: 'Send WhatsApp messages' },
      { key: 'whatsapp.manage', ar: 'إدارة إعدادات واتساب', en: 'Manage WhatsApp settings' },
      { key: 'whatsapp.assign', ar: 'إسناد محادثات واتساب', en: 'Assign WhatsApp conversations' },
    ],
  },
  {
    module: 'telegram',
    items: [
      { key: 'telegram.view', ar: 'عرض طلبات تيليجرام', en: 'View Telegram integration' },
      { key: 'telegram.manage', ar: 'إدارة ربط تيليجرام', en: 'Manage Telegram integration' },
    ],
  },
  {
    module: 'audit',
    items: [{ key: 'audit.view', ar: 'عرض سجل التدقيق', en: 'View audit logs' }],
  },
];

/** Flat set of all canonical keys accepted by the roles API. */
export const ALL_CATALOG_KEYS: Set<string> = new Set(
  PERMISSION_MODULES.flatMap((m) => m.items.map((i) => i.key))
);

/** Catalog item for a key. */
export function catalogItem(key: string): CatalogItem | undefined {
  for (const m of PERMISSION_MODULES) {
    const item = m.items.find((i) => i.key === key);
    if (item) return item;
  }
  return undefined;
}

/** Module display labels (ar/en) used in the permission matrix. */
export const MODULE_LABELS: Record<string, { ar: string; en: string }> = {
  dashboard: { ar: 'لوحة التحكم', en: 'Dashboard' },
  orders: { ar: 'الطلبات', en: 'Orders' },
  customers: { ar: 'العملاء', en: 'Customers' },
  products: { ar: 'المنتجات', en: 'Products' },
  categories: { ar: 'الفئات', en: 'Categories' },
  offers: { ar: 'العروض', en: 'Offers' },
  inventory: { ar: 'المخزون', en: 'Inventory' },
  production: { ar: 'الإنتاج', en: 'Production' },
  finance: { ar: 'المالية', en: 'Finance' },
  settlement: { ar: 'التسويات', en: 'Settlements' },
  reports: { ar: 'التقارير والتحليلات', en: 'Reports & Analytics' },
  users: { ar: 'المستخدمون', en: 'Users' },
  roles: { ar: 'الأدوار والصلاحيات', en: 'Roles & Permissions' },
  settings: { ar: 'الإعدادات', en: 'Settings' },
  geo: { ar: 'البلدان والمتاجر', en: 'Countries & Stores' },
  confirmation: { ar: 'مركز التأكيد', en: 'Confirmation' },
  ops: { ar: 'التشغيل', en: 'Operations' },
  control: { ar: 'الرقابة', en: 'Control' },
  team: { ar: 'الفريق', en: 'Team' },
  payroll: { ar: 'الرواتب', en: 'Payroll' },
  penalties: { ar: 'الخصومات', en: 'Deductions' },
  growth: { ar: 'النمو', en: 'Growth' },
  apps: { ar: 'التطبيقات', en: 'Apps' },
  audit: { ar: 'سجل التدقيق', en: 'Audit Logs' },
  whatsapp: { ar: 'واتساب', en: 'WhatsApp' },
  telegram: { ar: 'تيليجرام', en: 'Telegram' },
  landing_pages: { ar: 'صفحات الهبوط', en: 'Landing Pages' },
  storefront: { ar: 'واجهة المتجر', en: 'Storefront' },
};

/** Scope display labels (ar/en). */
export const SCOPE_LABELS: Record<ScopeValue, { ar: string; en: string }> = {
  ALL_COMPANY: { ar: 'كل الشركة', en: 'Whole company' },
  OWN: { ar: 'طلباتي المنشأة', en: 'Own created' },
  ASSIGNED: { ar: 'المسندة إليه', en: 'Assigned to self' },
  CATEGORY: { ar: 'فئات محددة', en: 'Specific categories' },
  SPECIFIC: { ar: 'منتجات محددة', en: 'Specific products' },
};
