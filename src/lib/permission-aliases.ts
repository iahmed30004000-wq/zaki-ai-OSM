/**
 * Legacy key -> canonical new key. Transitional: routes still enforce legacy
 * keys until PHASE 3 migrates them; the engine resolves both to the same grant.
 *
 * In its own file, with no imports, so the browser's `userCan` reads the SAME
 * table the server's `can()` reads — a screen that resolved keys differently
 * from the server hid buttons the server allowed, and showed ones it refused.
 */
export const LEGACY_ALIAS: Readonly<Record<string, string>> = {
  'orders.update': 'orders.edit',
  'orders.update_own': 'orders.edit',
  'orders.confirmation_status': 'orders.confirm',
  'orders.shipping_status': 'orders.change_status',
  'orders.reassign': 'orders.assign',
  'orders.view_assigned': 'orders.view',
  'orders.view_own': 'orders.view',
  'customers.update': 'customers.edit',
  'customers.freeze': 'customers.edit',
  'customers.unfreeze': 'customers.edit',
  'products.update': 'products.edit',
  'products.manage': 'products.edit',
  'users.update': 'users.edit',
  /*
   * NOT HERE EITHER: 'analytics.view' → 'reports.view'.
   *
   * «عرض التحليلات» was a second name for «عرض التقارير»: a check of the one
   * passed for a holder of the other, so the dashboard's API, the performance
   * board and the campaigns all answered to two boxes at once, and a «منع» on
   * the one did nothing while the other stood. The key is retired (see
   * RETIRED_KEYS); the dashboard's numbers, every report and every growth door
   * ask `reports.view` alone. The migration
   * 20261029130000_analytics_view_becomes_reports_view gave `reports.view` to
   * every role and person who held it, so nobody lost a door on the day. Only a catalog key that is NOT a real box may stand on
   * the left of this table.
   */
  /*
   * NOT HERE ANY MORE: 'settings.manage' → 'settings.edit'.
   *
   * «الإعدادات الحسّاسة» is its own box (the owner's ruling, 27/10, RV149).
   * Aliased, every holder of «تعديل إعدادات النظام» also read and changed
   * the courier credentials, the ad-account tokens and the AI provider's key,
   * and a «منع» on the sensitive box did nothing. The migration
   * 20261027000000_sensitive_settings_own_key gave settings.manage to every
   * role and person who held settings.edit, so nobody lost a door on the day.
   * Only a catalog key that is NOT a real box may stand on the left here.
   */
};
