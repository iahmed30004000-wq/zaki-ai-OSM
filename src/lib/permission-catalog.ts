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
  /**
   * THE KEY THAT OPENS THE SCREEN THIS ONE'S CONTROL SITS ON.
   *
   * An action without it is a box that is ticked and does nothing: the person
   * cannot reach the button. Ticking the action ticks this too; unticking
   * this unticks the action; and the server refuses to SAVE the combination
   * (`ORPHAN_ACTION`). `null` = standalone on purpose (has its own form or
   * door, shows no list) and says so in `note`. Absent = nothing is required
   * (a view, or a visibility key).
   */
  requires?: string | null;
  /** The Arabic line printed under the checkbox (a standalone action says why it needs nothing). */
  note?: string;
  /** The screens this key opens, by their menu names. Printed as a hint under the checkbox. */
  opens?: string[];
}

export interface CatalogModule {
  module: string; // stable module id (English)
  items: CatalogItem[];
}

export const PERMISSION_MODULES: CatalogModule[] = [
  {
    module: 'dashboard',
    items: [{ key: 'dashboard.view', opens: ['لوحة التحكم'], ar: 'عرض لوحة التحكم', en: 'View dashboard' }],
  },
  {
    module: 'orders',
    items: [
      { key: 'orders.view', opens: ['الطلبات'], ar: 'عرض الطلبات', en: 'View orders', scopes: ['ALL_COMPANY', 'OWN', 'ASSIGNED'] },
      { key: 'orders.edit', requires: 'orders.view', ar: 'تعديل الطلبات', en: 'Edit orders', scopes: ['ALL_COMPANY', 'OWN', 'ASSIGNED'] },
      { key: 'orders.create', requires: null, note: 'إنشاء الطلب له نموذجه الخاص — ما بيحتاج «عرض الطلبات».', ar: 'إنشاء طلبات', en: 'Create orders' },
      /**
       * SEPARATE FROM `orders.create`, BECAUSE A FILE IS NOT A ROW.
       *
       * The import dialog posts its rows to the same door a single entry
       * uses, one call each. So whoever could type ONE order could feed a
       * spreadsheet of three hundred through the same permission — and the
       * owner's rule is that a confirmation agent types orders by hand and
       * does not import.
       */
      { key: 'orders.import', requires: 'orders.create', ar: 'استيراد طلبات', en: 'Import orders' },
      /*
       * The door that writes CONFIRMED, SHIPPED orders with a date in the past. It asked for orders.import AND the
       * sensitive-settings box — a key that has nothing to do with orders — so it is its own box now. It needs
       * the import button it sits behind, and it is meant for the owner.
       */
      { key: 'orders.migrate', requires: 'orders.import', ar: 'ترحيل طلبات سابقة من ملفات (للمالك)', en: 'Migrate past orders from files (owner)' },
      /**
       * Recording what happened on a call had no permission of its own: the
       * contact-attempts door took `orders.edit` OR `orders.claim`, and the
       * `contact_result` action rode on `orders.confirm`. Three different
       * permissions, none of them about the telephone.
       */
      { key: 'orders.contact_log', requires: 'orders.view', ar: 'تسجيل نتيجة الاتصال', en: 'Log contact result' },
      /**
       * The arrows in the order window. They had no permission at all, and
       * they walked the READ envelope — which carries the unclaimed queue.
       * So one order opened was a door onto the whole pool, the pool C2 had
       * just taken out of the agent's list.
       */
      { key: 'orders.navigate', requires: 'orders.view', ar: 'التنقّل بين الطلبات (السابق واللاحق)', en: 'Navigate between orders' },
      { key: 'orders.assign', requires: 'orders.view', ar: 'إسناد الطلبات', en: 'Assign orders' },
      { key: 'orders.claim', requires: 'orders.view', ar: 'استلام الطلبات', en: 'Claim orders' },
      { key: 'orders.release', requires: 'orders.view', ar: 'تحرير الطلبات', en: 'Release orders' },
      { key: 'orders.unlock', requires: 'orders.view', ar: 'تجاوز أقفال التحرير', en: 'Override edit locks' },
      { key: 'orders.confirm', requires: 'orders.view', ar: 'تغيير حالة التأكيد', en: 'Change confirmation status' },
      { key: 'orders.change_status', requires: 'orders.view', ar: 'تغيير حالة الشحن', en: 'Change shipping status' },
      /*
       * THE ORDER ACTIONS THAT GOT A BOX EACH (perm-plan PR-6, migration 20261030130000_order_action_keys).
       *
       * Each used to ride on a wider key, so the owner could not give a person the order and keep the price, the fee, the
       * cancel, the note or the review link away from her. The migration gave every box to exactly the people who passed
       * that door before; from then on one tick moves one door.
       */
      { key: 'orders.change_price', requires: 'orders.edit', ar: 'تغيير سعر الطلب أو الخصم أو سعر السطر', en: 'Change an order price, discount or line price', scopes: ['ALL_COMPANY', 'OWN', 'ASSIGNED'] },
      { key: 'orders.change_fee', requires: 'orders.change_status', ar: 'تغيير أجرة التوصيل', en: 'Change the delivery fee' },
      { key: 'orders.cancel', requires: 'orders.view', ar: 'إلغاء الطلب أو إبطاله', en: 'Cancel or void an order' },
      { key: 'orders.note', requires: 'orders.view', ar: 'كتابة ملاحظة على الطلب', en: 'Write a note on an order' },
      { key: 'orders.request_change', requires: 'orders.view', ar: 'رفع طلب تعديل على طلب مؤكّد', en: 'Raise a change request on a confirmed order' },
      { key: 'orders.rating_link', requires: 'orders.view', ar: 'نسخ رابط تقييم الطلب', en: 'Copy the order review link' },
    ],
  },
  {
    module: 'customers',
    items: [
      { key: 'customers.view', requires: 'customers.view_basic', ar: 'عرض العملاء', en: 'View customers', scopes: ['ALL_COMPANY', 'OWN'] },
      { key: 'customers.view_basic', opens: ['العملاء'], ar: 'عرض بيانات العميل الأساسية', en: 'View basic customer info', scopes: ['ALL_COMPANY', 'OWN'] },
      { key: 'customers.create', requires: null, note: 'إضافة العميل لها نموذجها الخاص — ما بتحتاج «عرض العملاء».', ar: 'إنشاء عملاء', en: 'Create customers' },
    ],
  },
  {
    module: 'products',
    items: [
      { key: 'products.view', opens: ['المنتجات'], ar: 'عرض المنتجات', en: 'View products', scopes: ['ALL_COMPANY', 'CATEGORY', 'SPECIFIC'] },
      { key: 'products.edit', requires: 'products.view', ar: 'تعديل المنتجات', en: 'Edit products', scopes: ['ALL_COMPANY', 'CATEGORY', 'SPECIFIC'] },
      { key: 'products.create', requires: 'products.view', ar: 'إنشاء منتجات', en: 'Create products' },
      { key: 'products.delete', requires: 'products.view', ar: 'حذف منتجات', en: 'Delete products' },
      { key: 'products.change_price', requires: 'products.view', ar: 'تغيير أسعار المنتجات', en: 'Change product prices' },
      { key: 'products.upload_images', requires: 'products.view', ar: 'رفع صور المنتجات', en: 'Upload product images' },
      // Reading the category list, which the permission scope pickers need.
      { key: 'categories.view', ar: 'عرض التصنيفات', en: 'View categories' },
    ],
  },
  {
    module: 'offers',
    items: [
      { key: 'offers.view', ar: 'عرض العروض', en: 'View offers' },
      { key: 'offers.manage', requires: 'offers.view', ar: 'إدارة العروض', en: 'Manage offers' },
      // The two rules that decide how much a discount may give away: the window after an order, and who may be won back.
      { key: 'offers.rules', requires: 'settings.view', ar: 'تعديل قواعد العروض — نافذة ما بعد الطلب وقاعدة استعادة العملاء', en: 'Edit offer rules — the post-order window and the win-back rule' },
    ],
  },
  {
    module: 'inventory',
    items: [
      { key: 'inventory.view', opens: ['أرصدة المخزون', 'حركات المخزون'], ar: 'عرض المخزون', en: 'View inventory' },
      { key: 'inventory.adjust', requires: 'inventory.view', ar: 'تعديل المخزون', en: 'Adjust inventory' },
    ],
  },
  {
    module: 'production',
    items: [
      { key: 'production.view', opens: ['تشغيلات الإنتاج'], ar: 'عرض الإنتاج', en: 'View production' },
      { key: 'production.manage', requires: 'production.view', ar: 'إدارة الإنتاج', en: 'Manage production' },
    ],
  },
  {
    module: 'finance',
    items: [
      { key: 'finance.view', opens: ['الأرباح'], ar: 'عرض المالية', en: 'View finance' },
      /*
       * WHAT A THING COST US, ON ONE KEY (perm-plan PR-10, D3, migration 20261030170000_costs_insights_keys).
       *
       * The unit cost of a product, a batch's cost, the value of the stock and the cost and profit on an order were each
       * shown to whoever held ANY of five keys (the stock, the production or the finance screen). It is a visibility key:
       * it opens no screen and it is ticked beside the screen's own key, never instead of it. The migration gave it to
       * everybody who held one of the five, so nobody lost a figure on the day; from then on one tick takes it away.
       * An order's cost and profit need this AND «عرض المالية».
       */
      {
        key: 'costs.view',
        requires: null,
        note: 'بتشتغل مع مفتاح الشاشة نفسه — بدونها بتضل الشاشة تشتغل وبتختفي الكلفة والهامش منها.',
        ar: 'عرض التكلفة والهامش — كلفة المنتج والدفعة وقيمة المخزون وكلفة الطلب وربحه',
        en: 'See costs and margin — product and batch cost, stock value, order cost and profit',
      },
      // D12 (PR-9): the expense and the withdrawal from a wallet stay on this one key. Only the NAME says so now.
      { key: 'finance.create', requires: 'finance.view', ar: 'تسجيل المصروفات وسحبها من المحفظة ودفع العمولات', en: 'Record expenses (withdrawn from a wallet) and pay commissions' },
      { key: 'finance.update', requires: 'finance.view', ar: 'تعديل السجلات المالية', en: 'Update financial records' },
      /*
       * THE CASH BOX, IN FOUR KEYS (perm-plan PR-9, migration 20261030150000_finance_split_keys).
       *
       * «إدارة الصناديق النقدية» opened the three screens AND created, renamed and deleted wallets AND approved a daily
       * closing. The owner could not give a cashier the movements and keep the wallets and the closing's approval away
       * from her. The migration gave the view, the wallets and the closing's approval to every role and person who held
       * the old key, so nobody lost a door on the day. From then on one tick moves one door.
       */
      { key: 'finance.cashbox_view', opens: ['الإغلاق اليومي', 'المحافظ والحركات', 'التحويلات'], ar: 'عرض الصناديق والمحافظ والحركات والإغلاق', en: 'See the wallets, the movements, the transfers and the closings' },
      { key: 'finance.cashbox', requires: 'finance.cashbox_view', ar: 'تسجيل حركات الصندوق والتحويلات وعدّ الإغلاق واستلام نقد المندوب', en: 'Record cash movements, transfers, closing counts and take a courier’s cash' },
      { key: 'finance.wallets_manage', requires: 'finance.cashbox_view', ar: 'إنشاء المحافظ وتعديل أسمائها وإيقافها وحذفها', en: 'Create, rename, stop and delete wallets' },
      { key: 'finance.closing_approve', requires: 'finance.cashbox_view', ar: 'اعتماد الإغلاق اليومي', en: 'Approve a daily closing' },
    ],
  },
  {
    module: 'settlement',
    items: [
      { key: 'settlement.view', opens: ['عهدة المندوبين', 'التحصيل والكشوف'], ar: 'عرض التسويات (وصفوف التحصيل ومبالغها في المتابعة)', en: 'View settlements (and the collection rows and their figures in tracking)' },
      { key: 'settlement.upload', requires: 'settlement.view', ar: 'رفع تقارير الشحن', en: 'Upload shipping reports' },
      { key: 'settlement.review', opens: ['المطابقة'], requires: 'settlement.view', ar: 'مراجعة المطابقات', en: 'Review reconciliations' },
      // PR-9: the approval — the press that moves a courier's money into a wallet — left «مراجعة المطابقات» for a box of its own.
      { key: 'settlement.approve', requires: 'settlement.view', ar: 'اعتماد كشف شركة الشحن (يُدخل المال إلى المحفظة)', en: 'Approve a courier statement (moves the money into a wallet)' },
    ],
  },
  {
    module: 'reports',
    items: [
      { key: 'reports.view', ar: 'عرض التقارير', en: 'View reports' },
      /*
       * THE SMART CARDS, ON ONE KEY (perm-plan PR-10, D2, migration 20261030170000_costs_insights_keys).
       *
       * A product's grade, the dashboard's rankings and loss reasons, a channel's score, an order's and a customer's return
       * risk, a campaign's best and worst, a landing page's verdict and the live counts in the search box each sat behind
       * the key of the screen they are drawn on, so a person who could open the screen could not be kept from the verdicts.
       * A visibility key: the screen still opens on its own key, and loses only the cards when this one is taken. The
       * migration gave it to everybody who held one of those screen keys, so nobody lost a card on the day.
       */
      {
        key: 'insights.view',
        requires: null,
        note: 'بتشتغل مع مفتاح الشاشة نفسه — بدونها بتضل الشاشة تشتغل وبتختفي البطاقات الذكية منها.',
        ar: 'عرض البطاقات الذكية — تقييم المنتجات، ترتيب لوحة التحكم، أسباب الخسارة، درجة القنوات، خطر الإرجاع، بطاقات الحملات وأرقام البحث الفورية',
        en: 'See the smart cards — product grades, dashboard rankings, loss reasons, channel scores, return risk, campaign cards and live search counts',
      },
      { key: 'reports.export', requires: 'orders.view', ar: 'تصدير التقارير', en: 'Export reports' },
      // Says what it opens: the bubble, the assistant page and «اسأل الذكاء». The helpers INSIDE the screens are the next
      // box, so «منع» on this one does not turn them off, and the other way round.
      { key: 'ai.use', ar: 'المساعد العام — الفقاعة وصفحة المساعد وسؤال الأرقام', en: 'General assistant — bubble, assistant page, ask the numbers' },
      /*
       * THE HELPERS INSIDE THE SCREENS, ON A BOX OF THEIR OWN (perm-plan PR-5).
       *
       * Confirmation, picking, the landing-page writer, the AI step of order entry and «لخّصلي اليوم» used to answer to the
       * key of the work they sit in, so the owner could not give a person the work and keep her away from the model.
       * Each now asks that key AND this one. It opens nothing alone (standalone on purpose: it has no screen and no
       * list), and the migration 20261030120000_ai_assist_key gave it to everybody who passed one of those doors.
       */
      {
        key: 'ai.assist',
        requires: null,
        note: 'المساعدين داخل الشاشات بتشتغل لمن عنده هذا المفتاح ومفتاح الشغل نفسه — بدونه بتضل الشاشة تشتغل بلا ذكاء.',
        ar: 'المساعدون الأذكياء داخل الشاشات — التأكيد والتجهيز وكتابة صفحات الهبوط والإدخال بالذكاء و«لخّصلي اليوم»',
        en: 'In-screen smart assistants — confirmation, picking, landing-page writer, AI order entry and "summarise my day"',
      },
    ],
  },
  {
    module: 'users',
    items: [
      { key: 'users.view', opens: ['الموظفين'], ar: 'عرض المستخدمين', en: 'View users' },
      { key: 'users.create', requires: 'users.view', ar: 'إنشاء مستخدمين', en: 'Create users' },
      { key: 'users.edit', requires: 'users.view', ar: 'تعديل المستخدمين', en: 'Edit users' },
    ],
  },
  {
    module: 'roles',
    items: [
      { key: 'roles.view', opens: ['الصلاحيات'], ar: 'عرض الأدوار والصلاحيات', en: 'View roles & permissions' },
      { key: 'roles.create', requires: 'roles.view', ar: 'إنشاء أدوار', en: 'Create roles' },
      { key: 'roles.edit', requires: 'roles.view', ar: 'تعديل الأدوار والصلاحيات', en: 'Edit roles & permissions' },
      { key: 'roles.delete', requires: 'roles.view', ar: 'حذف أدوار', en: 'Delete roles' },
    ],
  },
  {
    module: 'settings',
    items: [
      { key: 'settings.view', ar: 'عرض الإعدادات', en: 'View settings' },
      { key: 'settings.edit', requires: 'settings.view', ar: 'تعديل إعدادات النظام', en: 'Edit system settings' },
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
        requires: 'settings.view',
        ar: 'إعدادات النظام الحسّاسة — مفاتيح شركات الشحن وحسابات الإعلانات ومزوّد الذكاء',
        en: 'Sensitive system settings — courier, ad-account and AI credentials',
      },
      /*
       * THE DOORS THAT USED TO HIDE BEHIND settings.manage / settings.edit, EACH WITH ITS OWN BOX.
       *
       * Nobody who passed yesterday is stopped on the deploy: the migration
       * 20261029150000_settings_split_keys gave each box to exactly the roles and people who passed that door,
       * and carried every «منع». From then on the owner unticks one box without touching the others.
       */
      { key: 'settings.jobs', requires: 'settings.view', ar: 'تشغيل المهام المجدولة وإعادة تفعيلها', en: 'Run and re-enable scheduled jobs' },
      { key: 'settings.messages', requires: 'settings.view', ar: 'تعديل قوالب الرسائل ومعاينتها على طلب حقيقي', en: 'Edit message templates and preview them on a real order' },
      { key: 'settings.delivery_fees', requires: 'settings.view', ar: 'تعديل أجور التوصيل لكل شركة ومحافظة', en: 'Edit delivery fees per courier and region' },
      { key: 'settings.tracking', requires: 'settings.view', ar: 'تعديل بكسلات الإعلانات وتحويلاتها ورمز الربط من الخادم', en: 'Edit ad pixels, their conversions and the server-side token' },
    ],
  },
  {
    module: 'confirmation',
    items: [
      { key: 'confirmation.pull', requires: 'confirmation.work', ar: 'سحب الطلب التالي', en: 'Pull next order' },
      { key: 'confirmation.work', opens: ['طلباتي'], ar: 'العمل على طلباتي والمؤجلة', en: 'Work own and postponed orders' },
      { key: 'confirmation.supervise', opens: ['الطلبات الجديدة', 'المتابعة'], ar: 'الإشراف على التأكيد (عرض القائمة)', en: 'Supervise confirmation (list view)' },
      { key: 'confirmation.issues', opens: ['الإشكالات'], ar: 'إشكالات الإدخال', en: 'Entry issues' },
      /*
       * THE CONFIRMATION DOORS THAT GOT A BOX EACH (perm-plan PR-7, migration 20261030140000_confirmation_split_keys).
       *
       * The win-back offer and the hand-back of a colleague's order rode on the supervisors' list; raising and closing an
       * entry issue rode on seeing the issues list. The migration gave each box to exactly the people who passed that door
       * before (the one deliberate gain: the agent's own «إدخال إشكال», which never worked for her), so from then on one
       * tick moves one door.
       */
      { key: 'confirmation.winback', requires: 'confirmation.supervise', ar: 'عرض خصم لاسترجاع طلب ملغى', en: 'Offer a discount to win back a lost order' },
      { key: 'confirmation.reassign', requires: 'confirmation.supervise', ar: 'إرجاع طلب مؤجَّل عند موظف آخر إلى الطابور', en: 'Hand a colleague’s postponed order back to the pool' },
      { key: 'confirmation.issues_correct', requires: 'confirmation.issues', ar: 'تصحيح إشكال إدخال وإغلاقه', en: 'Correct and close an entry issue' },
      { key: 'confirmation.raise_issue', requires: null, note: 'رفع الإشكال له زره على بطاقة الطلب، وما بيعرض قائمة الإشكالات — فما بيحتاج «إشكالات الإدخال».', ar: 'رفع إشكال إدخال على طلب', en: 'Raise an entry issue on an order' },
    ],
  },
  {
    module: 'ops',
    items: [
      { key: 'ops.prepare', opens: ['التجهيز'], ar: 'التجهيز', en: 'Preparation' },
      { key: 'ops.ship', opens: ['إنشاء شحنة', 'دفعات الشحن'], ar: 'إنشاء الشحنات', en: 'Create shipments' },
      { key: 'ops.labels', ar: 'البوالص', en: 'Labels' },
      { key: 'ops.track', opens: ['متابعة الشحن', 'دفعات الشحن'], ar: 'متابعة الشحن', en: 'Tracking' },
      { key: 'ops.returns', opens: ['المرتجعات'], ar: 'المرتجعات', en: 'Returns' },
      // Seeing the return rows on «متابعة الشحن» — NOT receiving the stock, which stays «المرتجعات» above.
      { key: 'ops.returns_view', ar: 'عرض المرتجعات في المتابعة (بلا استلام)', en: 'See return rows in tracking (no receiving)' },
      { key: 'ops.decide_changes', requires: null, note: 'البتّ بطلب تعديل على طلب مؤكَّد ما زال بالمستودع (طلبات غيرك) — بلا شاشة وبلا قائمة.', ar: 'البتّ في طلبات التعديل وهي بالمستودع', en: 'Decide change requests while the order is in the warehouse' },
    ],
  },
  {
    module: 'control',
    items: [
      { key: 'control.change_requests_view', ar: 'عرض كل طلبات التعديل', en: 'See every change request' },
      { key: 'control.change_requests', requires: 'control.change_requests_view', opens: ['طلبات التعديل'], ar: 'طلبات التعديل', en: 'Change requests' },
      { key: 'control.discount_alerts', opens: ['تنبيهات الخصم'], ar: 'تنبيهات الخصم', en: 'Discount alerts' },
      { key: 'control.blacklist', opens: ['القائمة السوداء'], ar: 'القائمة السوداء', en: 'Blacklist' },
      { key: 'control.blacklist_manage', requires: 'control.blacklist', ar: 'حظر رقم أو رفع الحظر عنه', en: 'Block a number or lift the block' },
    ],
  },
  {
    module: 'team',
    items: [
      // Seeing your OWN card needs nothing: they are your numbers. This is
      // the key that lets somebody see their TEAM's — a different decision,
      // and one the owner grants deliberately.
      { key: 'team.monitor', ar: 'متابعة أداء الفريق', en: 'Monitor team performance' },
      // The thresholds the team's scores are judged by — reading the scores is team.monitor.
      { key: 'team.settings', requires: 'settings.view', ar: 'تعديل عتبات أداء الفريق', en: 'Edit team performance thresholds' },
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
      { key: 'payroll.pay', requires: 'payroll.view', ar: 'تحديد الرواتب وصرفها', en: 'Set and pay salaries' },
    ],
  },
  {
    module: 'commission',
    items: [
      // Reading the rules AND where every agent stands in the running period: the second is other people's numbers.
      { key: 'commission.view', opens: ['العمولات'], ar: 'عرض قواعد العمولة وتقدّم الفريق في الفترة الجارية', en: 'View commission rules and the team progress in the running period' },
      { key: 'commission.manage', requires: 'commission.view', ar: 'إضافة قواعد العمولة وإنهاؤها', en: 'Add and end commission rules' },
    ],
  },
  {
    module: 'penalties',
    items: [
      // Seeing what the system PROPOSED is not deciding it. Two keys,
      // because reading a list of other people's lateness and taking money
      // off somebody are not the same authority — and one key for both
      // would hand the second to everybody who needed the first.
      { key: 'penalties.view', opens: ['خصومات الموظفين'], ar: 'عرض الخصومات المقترحة', en: 'View proposed deductions' },
      { key: 'penalties.decide', requires: 'penalties.view', ar: 'اعتماد الخصومات أو إلغاؤها', en: 'Apply or waive deductions' },
      // The rule that PROPOSES a deduction (how much per minute late, the cap) — not the decision on one person's.
      { key: 'penalties.rules', requires: 'settings.view', ar: 'تعديل قواعد الخصومات', en: 'Edit deduction rules' },
    ],
  },
  {
    module: 'growth',
    items: [{ key: 'growth.intelligence', opens: ['مركز الذكاء', 'منصّة التجريب'], ar: 'مركز الذكاء', en: 'Business intelligence' }],
  },
  {
    module: 'apps',
    items: [
      { key: 'apps.view', opens: ['متجر التطبيقات', 'التطبيقات المثبتة'], ar: 'عرض التطبيقات', en: 'View apps' },
      // Installing an app connects the company to something outside it, and
      // registering one hands out a signing secret. Both are a separate
      // authority from looking at the shelf.
      { key: 'apps.manage', requires: 'apps.view', ar: 'تثبيت وتسجيل التطبيقات', en: 'Install & register apps' },
    ],
  },
  {
    module: 'geo',
    items: [
      { key: 'geo.view', opens: ['البلدان والمتاجر'], ar: 'عرض البلدان والمتاجر', en: 'View countries & stores' },
      { key: 'geo.manage', requires: 'geo.view', ar: 'إدارة البلدان والمتاجر والمناطق', en: 'Manage countries, stores & regions' },
    ],
  },
  {
    // The shop's own face: how it looks, what it says, and the address it
    // answers on. Separate from geo.manage, which is about which countries
    // and stores EXIST — a designer may lay out the storefront without
    // being able to open or close a store.
    module: 'storefront',
    items: [
      { key: 'storefront.view', opens: ['المتجر'], ar: 'عرض واجهة المتجر', en: 'View storefront' },
      { key: 'storefront.manage', requires: 'storefront.view', ar: 'تصميم واجهة المتجر ومحتواها', en: 'Design storefront & content' },
      // Releasing to customers is a different authority from designing: a
      // shop can have somebody who prepares and somebody who decides it goes
      // out. Saving a draft never needs this.
      { key: 'storefront.publish', requires: 'storefront.view', ar: 'نشر واجهة المتجر', en: 'Publish the storefront' },
      // A domain points the outside world at this shop, and a wrong one
      // takes the shop off the air. Its own authority, like apps.manage.
      { key: 'storefront.domain', requires: 'storefront.view', ar: 'ربط نطاق المتجر', en: 'Connect the store domain' },
    ],
  },
  {
    module: 'landing_pages',
    items: [
      { key: 'landing_pages.view', opens: ['صفحات الهبوط'], ar: 'عرض صفحات الهبوط', en: 'View landing pages' },
      { key: 'landing_pages.create', requires: 'landing_pages.view', ar: 'إنشاء صفحات هبوط', en: 'Create landing pages' },
      { key: 'landing_pages.edit', requires: 'landing_pages.view', ar: 'تعديل صفحات الهبوط', en: 'Edit landing pages' },
      { key: 'landing_pages.delete', requires: 'landing_pages.view', ar: 'حذف صفحات هبوط', en: 'Delete landing pages' },
      { key: 'landing_pages.publish', requires: 'landing_pages.view', ar: 'نشر / إلغاء نشر صفحات الهبوط', en: 'Publish / unpublish landing pages' },
    ],
  },
  {
    module: 'whatsapp',
    items: [
      { key: 'whatsapp.view', opens: ['صندوق الواتساب'], ar: 'عرض صندوق واتساب', en: 'View WhatsApp inbox' },
      { key: 'whatsapp.send', requires: 'whatsapp.view', ar: 'إرسال رسائل واتساب', en: 'Send WhatsApp messages' },
      { key: 'whatsapp.manage', requires: 'whatsapp.view', ar: 'إدارة إعدادات واتساب', en: 'Manage WhatsApp settings' },
      { key: 'whatsapp.assign', requires: 'whatsapp.view', ar: 'إسناد محادثات واتساب', en: 'Assign WhatsApp conversations' },
    ],
  },
  {
    module: 'telegram',
    items: [
      { key: 'telegram.view', opens: ['طلبات تلجرام'], ar: 'عرض طلبات تيليجرام', en: 'View Telegram integration' },
      { key: 'telegram.manage', requires: 'telegram.view', ar: 'إدارة ربط تيليجرام', en: 'Manage Telegram integration' },
    ],
  },
  {
    module: 'audit',
    items: [{ key: 'audit.view', opens: ['سجل التدقيق'], ar: 'عرض سجل التدقيق', en: 'View audit logs' }],
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

/**
 * KEYS THE CATALOG HAS STOPPED OFFERING.
 *
 * A key listed here is stripped from every role and every exception list on
 * its next save (`withoutRetired`, at every door). A key joins this list in
 * the SAME change that removes the last check of it, and leaves
 * `PERMISSION_MODULES` in that change too — naming one early would delete the
 * row from the first role the owner saves, and everybody on that role would
 * lose a working door without anything saying so.
 *
 * `analytics.view` («عرض التحليلات») joined on 29/10: nothing asks it any more
 * (the dashboard's numbers, the reports and the growth doors ask
 * `reports.view`), and the migration 20261029130000_analytics_view_becomes_
 * reports_view gave its holders that one. Its old rows stay in the database,
 * inert, and go the next time the owner saves that role. `categories.view`
 * will retire one day, but a route still asks it.
 */
export const RETIRED_KEYS: readonly string[] = ['analytics.view'];

export function isRetiredKey(key: string): boolean {
  return RETIRED_KEYS.includes(key);
}

/**
 * The rows without the retired keys. A row that is not even an object with a
 * string `permission` is KEPT, so the validation behind it still refuses it:
 * stripping must never turn a malformed save into a silent one.
 */
export function withoutRetired<T>(rows: readonly T[], retired: readonly string[] = RETIRED_KEYS): T[] {
  if (retired.length === 0) return [...rows];
  return rows.filter((r) => {
    const p = (r as { permission?: unknown } | null | undefined)?.permission;
    return !(typeof p === 'string' && retired.includes(p));
  });
}

/** The keys a key needs, nearest first: orders.import -> [orders.create]. A cycle ends the walk. */
export function requiredChain(key: string): string[] {
  const out: string[] = [];
  let at = catalogItem(key)?.requires ?? null;
  while (at && !out.includes(at) && at !== key) {
    out.push(at);
    at = catalogItem(at)?.requires ?? null;
  }
  return out;
}

/** Every key that needs this one, directly or through another: unticking it takes all of them off. */
export function dependentsOf(key: string): string[] {
  const out: string[] = [];
  for (const m of PERMISSION_MODULES) {
    for (const i of m.items) {
      if (i.key !== key && requiredChain(i.key).includes(key)) out.push(i.key);
    }
  }
  return out;
}

export interface OrphanPair {
  action: string;
  view: string;
}

/**
 * Held actions whose screen key is not held. PRESENCE ONLY: the scope is not
 * compared, because actions with no scopes of their own sit at «كل الشركة»
 * next to a view that is «طلباتي» or «المسندة» in the shipped templates.
 */
export function orphanPairs(held: Iterable<string>): OrphanPair[] {
  const has = new Set(held);
  const out: OrphanPair[] = [];
  for (const m of PERMISSION_MODULES) {
    for (const i of m.items) {
      if (i.requires && has.has(i.key) && !has.has(i.requires)) out.push({ action: i.key, view: i.requires });
    }
  }
  return out;
}

/** The orphans `after` has that `before` did not: the ones a save would ADD. */
export function newOrphans(before: Iterable<string>, after: Iterable<string>): OrphanPair[] {
  const was = new Set(orphanPairs(before).map((p) => `${p.action}>${p.view}`));
  return orphanPairs(after).filter((p) => !was.has(`${p.action}>${p.view}`));
}

/**
 * The grant a required key gets when ticking an action pulls it in: the
 * action's own scope if the key offers it (with its ids), otherwise «كل
 * الشركة» — which every action works with and needs no ids.
 */
export function viewGrantFor(
  viewKey: string,
  from: { scope: ScopeValue; scopeIds: string[] }
): { scope: ScopeValue; scopeIds: string[] } {
  const offered = catalogItem(viewKey)?.scopes;
  if (offered && offered.includes(from.scope)) return { scope: from.scope, scopeIds: [...from.scopeIds] };
  return { scope: 'ALL_COMPANY', scopeIds: [] };
}

/**
 * Visibility-tier coverage: holding the broader view tier covers the narrower one
 * (customers.view ⊇ customers.view_basic). Here, with no imports, so the server's
 * granting doors and the browser's exceptions editor read the SAME table.
 */
export const TIER_COVERAGE: Readonly<Record<string, string>> = { 'customers.view_basic': 'customers.view' };

/** Module display labels (ar/en) used in the permission matrix. */
export const MODULE_LABELS: Record<string, { ar: string; en: string }> = {
  dashboard: { ar: 'لوحة التحكم', en: 'Dashboard' },
  orders: { ar: 'الطلبات', en: 'Orders' },
  customers: { ar: 'العملاء', en: 'Customers' },
  products: { ar: 'المنتجات', en: 'Products' },
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
  commission: { ar: 'العمولات', en: 'Commission' },
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
  CATEGORY: { ar: 'تصنيفات محددة', en: 'Specific categories' },
  SPECIFIC: { ar: 'منتجات محددة', en: 'Specific products' },
};
