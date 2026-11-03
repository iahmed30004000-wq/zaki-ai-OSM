// ─── SALESFLOW RBAC — Roles, Permissions & Role Matrix ───
// Extended architecture: preserves legacy roles, adds specialized
// operational roles. All enforcement is server-side (src/lib/rbac.ts).

export type UserRole =
  // Legacy roles (preserved for backward compatibility)
  | 'SUPER_ADMIN'
  | 'COMPANY_ADMIN'
  | 'MANAGER'
  | 'MODERATOR'
  | 'ACCOUNTANT'
  | 'DELIVERY_MANAGER'
  | 'PENDING_USER'
  // Specialized operational roles
  | 'CONFIRMATION_AGENT'
  | 'FOLLOW_UP_AGENT'
  | 'SETTLEMENT_OFFICER'
  // Contract roles (Stage 2). Grants live only in the DB system templates.
  | 'WAREHOUSE'
  | 'CONFIRMATION_SUPERVISOR';

export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

/**
 * Permission catalog — hierarchical: group.entity.action
 * Enforced server-side via src/lib/rbac.ts. Frontend checks are UX only.
 */
export type Permission =
  // Users & roles
  | 'users.view'
  | 'users.create'
  | 'users.update'
  | 'users.delete'
  | 'users.manage_roles'
  // Orders
  | 'orders.view'
  | 'orders.view_assigned'      // visibility limited to orders assigned to self
  | 'orders.view_own'           // visibility limited to orders created by self
  | 'orders.create'
  | 'orders.update'
  | 'orders.update_own'         // may update only orders assigned/claimed by self
  | 'orders.assign'
  | 'orders.reassign'
  | 'orders.claim'
  | 'orders.release'
  | 'orders.unlock'             // SUPER_ADMIN override
  | 'orders.delete'
  // Confirmation workflow statuses
  | 'orders.confirmation_status'
  // Shipping workflow statuses
  | 'orders.shipping_status'
  // Customers
  | 'customers.view'
  | 'customers.view_basic'      // read-only, limited fields (agents)
  | 'customers.create'
  | 'customers.update'
  | 'customers.freeze'
  | 'customers.unfreeze'
  // Products & offers
  | 'products.view'
  | 'products.create'
  | 'products.update'
  | 'products.delete'
  | 'products.manage'      // legacy alias = create+update+delete
  | 'moderators.manage'    // legacy alias = users.manage (moderator mgmt)
  | 'offers.manage'
  // Finance — strictly separated
  | 'finance.view'
  | 'finance.create'
  | 'finance.update'
  | 'finance.cashbox'
  // Settlement — strictly separated from finance
  | 'settlement.view'
  | 'settlement.upload'
  | 'settlement.review'
  // Operations
  | 'production.manage'
  | 'inventory.manage'
  | 'reports.view'
  | 'analytics.view'
  | 'ai.use'
  // Administration
  | 'users.manage'
  | 'moderators.manage'
  // CRM module
  | 'crm.view'
  | 'crm.manage'
  // Permission Engine catalog (canonical keys — Phase 3)
  | 'dashboard.view'
  | 'orders.cancel'
  | 'orders.export'
  | 'customers.delete'
  | 'customers.export'
  | 'products.change_stock'
  | 'products.export'
  | 'categories.view'
  | 'categories.create'
  | 'categories.edit'
  | 'categories.delete'
  | 'offers.view'
  | 'inventory.view'
  | 'production.view'
  | 'reports.export'
  | 'roles.view'
  | 'roles.create'
  | 'roles.edit'
  | 'roles.delete'
  | 'settings.edit'
  | 'audit.export'
  | 'crm.contacts.delete'
  | 'crm.companies.delete'
  | 'crm.leads.delete'
  | 'crm.deals.delete'
  | 'crm.tasks.delete'
  | 'crm.invoices.delete'
  | 'crm.notes.view'
  | 'crm.notes.create'
  | 'crm.notes.edit'
  | 'crm.notes.delete'
  | 'crm.activities.view'
  | 'crm.activities.create'
  | 'crm.activities.delete'
  | 'settings.view'
  | 'settings.manage'
  | 'whatsapp.view'
  | 'whatsapp.send'
  | 'whatsapp.manage'
  | 'whatsapp.assign'
  | 'telegram.view'
  | 'telegram.manage'
  | 'telegram.receive_orders'
  | 'audit.view';

export const ALL_PERMISSIONS: Permission[] = [
  'users.view', 'users.create', 'users.update', 'users.manage_roles', 'users.manage', 'moderators.manage',
  'orders.view', 'orders.view_assigned', 'orders.create', 'orders.update', 'orders.update_own',
  'orders.assign', 'orders.reassign', 'orders.claim', 'orders.release', 'orders.unlock', 'orders.delete',
  'orders.confirmation_status', 'orders.shipping_status',
  'customers.view', 'customers.view_basic', 'customers.create', 'customers.update', 'customers.freeze', 'customers.unfreeze',
  'products.view', 'products.create', 'products.update', 'products.delete', 'products.manage',
  'finance.view', 'finance.create', 'finance.update', 'finance.cashbox',
  'settlement.view', 'settlement.upload', 'settlement.review',
  'inventory.manage', 'production.manage', 'offers.manage',
  'reports.view', 'analytics.view', 'ai.use',
  'crm.view', 'crm.manage',
  'settings.view', 'settings.manage', 'audit.view',
  'whatsapp.view', 'whatsapp.send', 'whatsapp.manage', 'whatsapp.assign',
  'telegram.view', 'telegram.manage', 'telegram.receive_orders',
];

// Re-export grouped aliases for readability
export type PermissionGroup =
  | 'USERS' | 'ORDERS' | 'CUSTOMERS' | 'PRODUCTS' | 'FINANCE'
  | 'SETTLEMENT' | 'INVENTORY' | 'PRODUCTION' | 'ANALYTICS' | 'SETTINGS' | 'AUDIT' | 'CRM' | 'WHATSAPP' | 'TELEGRAM';

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  // ─── Full system administration ───
  SUPER_ADMIN: [
    'users.view', 'users.create', 'users.update', 'users.manage_roles', 'users.manage',
    'orders.view', 'orders.create', 'orders.update', 'orders.assign', 'orders.reassign',
    'orders.claim', 'orders.release', 'orders.unlock', 'orders.delete',
    'orders.confirmation_status', 'orders.shipping_status',
    'customers.view', 'customers.create', 'customers.update', 'customers.freeze', 'customers.unfreeze',
    'products.view', 'products.create', 'products.update', 'products.delete',
    'finance.view', 'finance.create', 'finance.update', 'finance.cashbox',
    'settlement.view', 'settlement.upload', 'settlement.review',
    'inventory.manage', 'production.manage', 'offers.manage',
    'reports.view', 'analytics.view', 'ai.use',
    'crm.view', 'crm.manage',
    'settings.view', 'settings.manage', 'audit.view',
  ],

  // ─── Legacy company admin (full company scope, no platform-level user mgmt) ───
  COMPANY_ADMIN: [
    'users.view', 'users.create', 'users.update', 'users.manage_roles', 'users.manage',
    'orders.view', 'orders.create', 'orders.update', 'orders.assign', 'orders.reassign',
    'orders.claim', 'orders.release', 'orders.unlock',
    'orders.confirmation_status', 'orders.shipping_status',
    'customers.view', 'customers.create', 'customers.update', 'customers.freeze', 'customers.unfreeze',
    'products.view', 'products.create', 'products.update', 'products.delete',
    'finance.view', 'finance.create', 'finance.update', 'finance.cashbox',
    'settlement.view', 'settlement.upload', 'settlement.review',
    'inventory.manage', 'production.manage', 'offers.manage',
    'reports.view', 'analytics.view', 'ai.use',
    'crm.view', 'crm.manage',
    'settings.view', 'settings.manage', 'audit.view',
    'whatsapp.view', 'whatsapp.send', 'whatsapp.manage', 'whatsapp.assign',
    'telegram.view', 'telegram.manage', 'telegram.receive_orders',
  ],

  // ─── Legacy manager — broad operational oversight, no finance writes ───
  MANAGER: [
    'users.view',
    'orders.view', 'orders.create', 'orders.update', 'orders.assign', 'orders.reassign',
    'orders.claim', 'orders.release', 'orders.unlock',
    'orders.confirmation_status', 'orders.shipping_status',
    'customers.view', 'customers.create', 'customers.update',
    'products.view', 'products.create', 'products.update',
    'offers.manage', 'inventory.manage', 'production.manage',
    'reports.view', 'analytics.view', 'ai.use',
    'crm.view', 'crm.manage',
    'settings.view',
    'whatsapp.view', 'whatsapp.send', 'whatsapp.assign',
    'telegram.view',
  ],

  // ─── Order intake only — NO finance, NO settings, NO user roles ───
  MODERATOR: [
    'orders.view', 'orders.create', 'orders.update_own', 'orders.claim', 'orders.release',
    'orders.confirmation_status',
    'customers.view', 'customers.create', 'customers.update',
    'products.view', 'offers.manage',
    'reports.view', 'ai.use',
    'crm.view', 'crm.manage',
    'whatsapp.view', 'whatsapp.send',
  ],

  // ─── Confirmation only on OWN assigned orders — NO finance ───
  CONFIRMATION_AGENT: [
    'orders.view_assigned', 'orders.update_own', 'orders.claim', 'orders.release',
    'orders.confirmation_status',
    'customers.view_basic',
    'products.view',
    'ai.use',
  ],

  // ─── Follow-up on assigned cases — cannot reverse confirmation decisions ───
  FOLLOW_UP_AGENT: [
    'orders.view_assigned', 'orders.update_own', 'orders.claim', 'orders.release',
    'customers.view_basic',
    'products.view',
  ],

  // ─── Shipping/delivery workflow (legacy role kept, now focused) ───
  DELIVERY_MANAGER: [
    'orders.view', 'orders.shipping_status',
    'customers.view', 'customers.update',
    'products.view',
    'inventory.manage',
    'reports.view', 'analytics.view',
  ],

  // ─── Shipping settlements & reconciliation — NO cashbox, NO order status ───
  SETTLEMENT_OFFICER: [
    'settlement.view', 'settlement.upload', 'settlement.review',
    'orders.view',
    'reports.view',
  ],

  // ─── Money only — cannot touch operational order statuses ───
  ACCOUNTANT: [
    'finance.view', 'finance.create', 'finance.update', 'finance.cashbox',
    'orders.view',
    'reports.view', 'analytics.view',
  ],

  // Grants come from the DB system role templates (migration stage2_store_scope_roles).
  WAREHOUSE: [],
  CONFIRMATION_SUPERVISOR: [],

  PENDING_USER: [],
};

/** Roles an administrator may assign. PENDING_USER included for reversion. */
export const ASSIGNABLE_ROLES: UserRole[] = [
  'PENDING_USER',
  'MODERATOR',
  'CONFIRMATION_AGENT',
  'FOLLOW_UP_AGENT',
  'CONFIRMATION_SUPERVISOR',
  'SETTLEMENT_OFFICER',
  'ACCOUNTANT',
  'DELIVERY_MANAGER',
  'WAREHOUSE',
  'MANAGER',
  'COMPANY_ADMIN',
  'SUPER_ADMIN',
];

export const USER_STATUSES: UserStatus[] = ['PENDING', 'ACTIVE', 'SUSPENDED', 'DISABLED'];

/** Display labels — Arabic & English (RTL/LTR support) */
export const ROLE_LABELS: Record<UserRole, { ar: string; en: string }> = {
  SUPER_ADMIN: { ar: 'مدير النظام', en: 'Super Administrator' },
  COMPANY_ADMIN: { ar: 'مدير الشركة', en: 'Company Admin' },
  MANAGER: { ar: 'مدير', en: 'Manager' },
  MODERATOR: { ar: 'موديريتور', en: 'Moderator' },
  CONFIRMATION_AGENT: { ar: 'موظف التأكيد', en: 'Confirmation Agent' },
  FOLLOW_UP_AGENT: { ar: 'موظف المتابعة', en: 'Follow-Up Agent' },
  SETTLEMENT_OFFICER: { ar: 'مدقق التسويات', en: 'Settlement Officer' },
  ACCOUNTANT: { ar: 'المحاسب', en: 'Accountant' },
  DELIVERY_MANAGER: { ar: 'مدير التوصيل', en: 'Delivery Manager' },
  WAREHOUSE: { ar: 'المستودع', en: 'Warehouse' },
  CONFIRMATION_SUPERVISOR: { ar: 'مشرف التأكيد', en: 'Confirmation Supervisor' },
  PENDING_USER: { ar: 'حساب معلق', en: 'Pending User' },
};

export const STATUS_LABELS: Record<UserStatus, { ar: string; en: string }> = {
  PENDING: { ar: 'بانتظار الموافقة', en: 'Pending' },
  ACTIVE: { ar: 'نشط', en: 'Active' },
  SUSPENDED: { ar: 'موقوف', en: 'Suspended' },
  DISABLED: { ar: 'معطّل', en: 'Disabled' },
};

/** Human-readable permission labels for the /permissions matrix page */
export const PERMISSION_LABELS: Record<Permission, { ar: string; en: string; group: string }> = {
  'telegram.view': { ar: 'عرض طلبات تيليجرام', en: 'View Telegram integration', group: 'TELEGRAM' },
  'telegram.manage': { ar: 'معالجة رسائل تيليجرام (إعادة المعالجة · التجاهل · التعديل والترحيل)', en: 'Handle Telegram messages (retry · ignore · correct)', group: 'TELEGRAM' },
  'telegram.receive_orders': { ar: 'استقبال طلبات تيليجرام', en: 'Receive Telegram orders', group: 'TELEGRAM' },
  'whatsapp.view': { ar: 'عرض صندوق واتساب', en: 'View WhatsApp inbox', group: 'WHATSAPP' },
  'whatsapp.send': { ar: 'إرسال رسائل واتساب', en: 'Send WhatsApp messages', group: 'WHATSAPP' },
  'whatsapp.manage': { ar: 'إدارة إعدادات واتساب', en: 'Manage WhatsApp settings', group: 'WHATSAPP' },
  'whatsapp.assign': { ar: 'إسناد محادثات واتساب', en: 'Assign WhatsApp conversations', group: 'WHATSAPP' },
  'users.view': { ar: 'عرض المستخدمين', en: 'View users', group: 'USERS' },
  'users.create': { ar: 'إنشاء مستخدمين', en: 'Create users', group: 'USERS' },
  'users.update': { ar: 'تعديل المستخدمين', en: 'Update users', group: 'USERS' },
  'users.manage_roles': { ar: 'إدارة الأدوار', en: 'Manage roles', group: 'USERS' },
  'users.manage': { ar: 'إدارة كاملة للمستخدمين', en: 'Full user management', group: 'USERS' },
  'users.delete': { ar: 'حذف المستخدمين', en: 'Delete users', group: 'USERS' },
  'orders.view': { ar: 'عرض كل الطلبات', en: 'View all orders', group: 'ORDERS' },
  'orders.view_assigned': { ar: 'عرض الطلبات المسندة فقط', en: 'View assigned orders only', group: 'ORDERS' },
  'orders.view_own': { ar: 'عرض طلباتي المنشأة فقط', en: 'View own created orders only', group: 'ORDERS' },
  'orders.create': { ar: 'إنشاء طلبات', en: 'Create orders', group: 'ORDERS' },
  'orders.update': { ar: 'تحديث أي طلب', en: 'Update any order', group: 'ORDERS' },
  'orders.update_own': { ar: 'تحديث طلباتي فقط', en: 'Update own orders only', group: 'ORDERS' },
  'orders.assign': { ar: 'إسناد الطلبات', en: 'Assign orders', group: 'ORDERS' },
  'orders.reassign': { ar: 'إعادة إسناد الطلبات', en: 'Reassign orders', group: 'ORDERS' },
  'orders.claim': { ar: 'استلام الطلبات', en: 'Claim orders', group: 'ORDERS' },
  'orders.release': { ar: 'تحرير الطلبات', en: 'Release orders', group: 'ORDERS' },
  'orders.unlock': { ar: 'تجاوز أقفال التحرير', en: 'Override edit locks', group: 'ORDERS' },
  'orders.delete': { ar: 'حذف الطلبات', en: 'Delete orders', group: 'ORDERS' },
  'orders.confirmation_status': { ar: 'تغيير حالة التأكيد', en: 'Change confirmation status', group: 'ORDERS' },
  'orders.shipping_status': { ar: 'تغيير حالة الشحن', en: 'Change shipping status', group: 'ORDERS' },
  'customers.view': { ar: 'عرض العملاء', en: 'View customers', group: 'CUSTOMERS' },
  'customers.view_basic': { ar: 'عرض بيانات العميل الأساسية', en: 'View basic customer info', group: 'CUSTOMERS' },
  'customers.create': { ar: 'إنشاء عملاء', en: 'Create customers', group: 'CUSTOMERS' },
  'customers.update': { ar: 'تحديث عملاء', en: 'Update customers', group: 'CUSTOMERS' },
  'customers.freeze': { ar: 'تجميد عملاء', en: 'Freeze customers', group: 'CUSTOMERS' },
  'customers.unfreeze': { ar: 'فك تجميد العملاء', en: 'Unfreeze customers', group: 'CUSTOMERS' },
  'products.view': { ar: 'عرض المنتجات', en: 'View products', group: 'PRODUCTS' },
  'products.create': { ar: 'إنشاء منتجات', en: 'Create products', group: 'PRODUCTS' },
  'products.update': { ar: 'تحديث منتجات', en: 'Update products', group: 'PRODUCTS' },
  'products.delete': { ar: 'حذف منتجات', en: 'Delete products', group: 'PRODUCTS' },
  'offers.manage': { ar: 'إدارة العروض', en: 'Manage offers', group: 'PRODUCTS' },
  'products.manage': { ar: 'إدارة المنتجات (كاملة)', en: 'Manage products (full)', group: 'PRODUCTS' },
  'moderators.manage': { ar: 'إدارة الموديريتورز', en: 'Manage moderators', group: 'USERS' },
  'finance.view': { ar: 'عرض المالية', en: 'View finance', group: 'FINANCE' },
  'finance.create': { ar: 'إنشاء معاملات مالية', en: 'Create financial transactions', group: 'FINANCE' },
  'finance.update': { ar: 'تعديل السجلات المالية', en: 'Update financial records', group: 'FINANCE' },
  'finance.cashbox': { ar: 'إدارة الصناديق النقدية', en: 'Manage cashboxes', group: 'FINANCE' },
  'settlement.view': { ar: 'عرض التسويات', en: 'View settlements', group: 'SETTLEMENT' },
  'settlement.upload': { ar: 'رفع تقارير الشحن', en: 'Upload shipping reports', group: 'SETTLEMENT' },
  'settlement.review': { ar: 'مراجعة المطابقات', en: 'Review reconciliations', group: 'SETTLEMENT' },
  'inventory.manage': { ar: 'إدارة المخزون', en: 'Manage inventory', group: 'OPERATIONS' },
  'production.manage': { ar: 'إدارة الإنتاج', en: 'Manage production', group: 'OPERATIONS' },
  'reports.view': { ar: 'عرض التقارير', en: 'View reports', group: 'ANALYTICS' },
  'analytics.view': { ar: 'عرض التحليلات', en: 'View analytics', group: 'ANALYTICS' },
  'ai.use': { ar: 'المساعد العام — الفقاعة وصفحة المساعد وسؤال الأرقام', en: 'General assistant — bubble, assistant page, ask the numbers', group: 'ANALYTICS' },
  'settings.view': { ar: 'عرض الإعدادات', en: 'View settings', group: 'SETTINGS' },
  'settings.manage': { ar: 'تعديل إعدادات النظام', en: 'Manage system settings', group: 'SETTINGS' },
  'audit.view': { ar: 'عرض سجل التدقيق', en: 'View audit logs', group: 'SETTINGS' },
  'crm.view': { ar: 'عرض وحدة CRM', en: 'View CRM module', group: 'CRM' },
  'crm.manage': { ar: 'إدارة CRM (إنشاء/تعديل/حذف)', en: 'Manage CRM (create/update/delete)', group: 'CRM' },
  // Permission Engine catalog (canonical keys — Phase 3)
  'dashboard.view': { ar: 'عرض لوحة التحكم', en: 'View dashboard', group: 'CRM' },
  'orders.cancel': { ar: 'إلغاء الطلبات', en: 'Cancel orders', group: 'ORDERS' },
  'orders.export': { ar: 'تصدير الطلبات', en: 'Export orders', group: 'ORDERS' },
  'customers.delete': { ar: 'حذف العملاء', en: 'Delete customers', group: 'CUSTOMERS' },
  'customers.export': { ar: 'تصدير العملاء', en: 'Export customers', group: 'CUSTOMERS' },
  'products.change_stock': { ar: 'تغيير مخزون المنتجات', en: 'Change product stock', group: 'PRODUCTS' },
  'products.export': { ar: 'تصدير المنتجات', en: 'Export products', group: 'PRODUCTS' },
  'categories.view': { ar: 'عرض الفئات', en: 'View categories', group: 'PRODUCTS' },
  'categories.create': { ar: 'إنشاء فئات', en: 'Create categories', group: 'PRODUCTS' },
  'categories.edit': { ar: 'تعديل الفئات', en: 'Edit categories', group: 'PRODUCTS' },
  'categories.delete': { ar: 'حذف الفئات', en: 'Delete categories', group: 'PRODUCTS' },
  'offers.view': { ar: 'عرض العروض', en: 'View offers', group: 'PRODUCTS' },
  'inventory.view': { ar: 'عرض المخزون', en: 'View inventory', group: 'OPERATIONS' },
  'production.view': { ar: 'عرض الإنتاج', en: 'View production', group: 'OPERATIONS' },
  'reports.export': { ar: 'تصدير التقارير', en: 'Export reports', group: 'ANALYTICS' },
  'roles.view': { ar: 'عرض الأدوار والصلاحيات', en: 'View roles & permissions', group: 'USERS' },
  'roles.create': { ar: 'إنشاء أدوار', en: 'Create roles', group: 'USERS' },
  'roles.edit': { ar: 'تعديل الأدوار والصلاحيات', en: 'Edit roles & permissions', group: 'USERS' },
  'roles.delete': { ar: 'حذف أدوار', en: 'Delete roles', group: 'USERS' },
  'settings.edit': { ar: 'تعديل إعدادات النظام', en: 'Edit system settings', group: 'SETTINGS' },
  'audit.export': { ar: 'تصدير سجل التدقيق', en: 'Export audit logs', group: 'SETTINGS' },
  'crm.contacts.delete': { ar: 'حذف جهات الاتصال', en: 'Delete CRM contacts', group: 'CRM' },
  'crm.companies.delete': { ar: 'حذف الشركات', en: 'Delete CRM companies', group: 'CRM' },
  'crm.leads.delete': { ar: 'حذف العملاء المحتملين', en: 'Delete CRM leads', group: 'CRM' },
  'crm.deals.delete': { ar: 'حذف الصفقات', en: 'Delete CRM deals', group: 'CRM' },
  'crm.tasks.delete': { ar: 'حذف مهام CRM', en: 'Delete CRM tasks', group: 'CRM' },
  'crm.invoices.delete': { ar: 'حذف فواتير CRM', en: 'Delete CRM invoices', group: 'CRM' },
  'crm.notes.view': { ar: 'عرض ملاحظات CRM', en: 'View CRM notes', group: 'CRM' },
  'crm.notes.create': { ar: 'إنشاء ملاحظات CRM', en: 'Create CRM notes', group: 'CRM' },
  'crm.notes.edit': { ar: 'تعديل ملاحظات CRM', en: 'Edit CRM notes', group: 'CRM' },
  'crm.notes.delete': { ar: 'حذف ملاحظات CRM', en: 'Delete CRM notes', group: 'CRM' },
  'crm.activities.view': { ar: 'عرض أنشطة CRM', en: 'View CRM activities', group: 'CRM' },
  'crm.activities.create': { ar: 'إنشاء أنشطة CRM', en: 'Create CRM activities', group: 'CRM' },
  'crm.activities.delete': { ar: 'حذف أنشطة CRM', en: 'Delete CRM activities', group: 'CRM' },
};

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  avatar?: string | null;
  companyId: string | null;
  companyName?: string;
  commissionRate?: number;
  /** Which of the system's looks they chose. Null = the default. */
  systemTheme?: string | null;
  /** When the one-time first-run tour was dismissed for good. Null = it has not run. */
  tourDoneAt?: string | null;
  /**
   * The look this person's ROLE opens on — a base, not a choice.
   *
   * Consulted only when `systemTheme` is null. The owner sets one for a
   * role so a new agent's first morning is not the default grey; the
   * moment that person picks their own, this stops being read for them.
   */
  roleTheme?: string | null;
  /** Effective permission KEYS from the Permission Engine (role + overrides). */
  permissions: string[];
  /** Attached by getCurrentUser — engine scope data (never sent to client). */
  effectiveGrants?: { fullAccess: boolean; grants: Record<string, { scope: string; scopeIds?: unknown[] | null }> };
  /** Set when grants came from the legacy fallback (user without roleId). */
  legacyPermissions?: boolean;
  /**
   * Set ONLY while the owner previews this person («عاين كـ», src/lib/preview-mode.ts): who is really looking, and
   * until when. Every key above is HERS; nothing can be written while this is set (the proxy refuses it).
   */
  preview?: { ownerId: string; ownerName: string; roleName: string; expiresAt: string } | null;
}
