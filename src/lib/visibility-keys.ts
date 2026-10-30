/**
 * THE KEYS THAT DECIDE WHAT A SCREEN SHOWS INSIDE ITSELF (perm-plan PR-10), AND THE KEYS EACH ONE WAS READ FROM BEFORE.
 *
 * Two NEW keys and one that already existed but was not what its doors asked:
 *
 *   costs.view     ← inventory.view · inventory.adjust · production.view · production.manage · finance.view
 *                    «what a thing cost us»: the unit cost, the batch's cost, the value of the stock. `maySeeCost` was an OR of
 *                    these five; the owner could not take the cost away from the warehouse and keep the shelf.
 *   insights.view  ← products.view · inventory.view · reports.view · dashboard.view · confirmation.work · orders.confirm ·
 *                    customers.view · orders.view · landing_pages.view
 *                    «the smart cards»: a product's grade, the dashboard's rankings and loss reasons, a channel's score, the
 *                    return risk of an order and of a customer, a campaign's best and worst, a page's verdict, the palette's
 *                    live counts. Each sat behind the key of the screen it was drawn on; now it asks that key AND this one.
 *   team.monitor   ← users.view · and the role NAMES COMPANY_ADMIN / MANAGER
 *                    the two team tables on the confirmation desk (`orders/confirmation/team`, `orders/confirmation/performance`)
 *                    read `users.view` OR a role name. The key already existed (the team scoreboard asks it); those two doors
 *                    now ask it too.
 *
 * NOT HERE, ON PURPOSE: `payroll.view`. The payslip preview (`GET /api/payroll/payslip`) now asks `payroll.pay` AND
 * `payroll.view` (a visibility key rides beside the key of the door, never instead of it). Granting `payroll.view` to every
 * `payroll.pay` holder would open the profile's pay, the audit log's pay and a colleague's owed commission to people who do
 * not see them today — a door gained — so the migration writes nothing for it. The catalogue already says `payroll.pay`
 * requires `payroll.view`; a holder who has the first without the second is listed by the pre-deploy report.
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 * `byRole` is the part of the old door that was a role NAME. No key here carries a scope: the old doors never evaluated one.
 *
 * `analytics.view` is not in the list for the smart cards: it was retired on 29/10 (migration
 * 20261029130000_analytics_view_becomes_reports_view gave reports.view to every holder), so every door that read it reads
 * `reports.view` now, and `reports.view` is in the list.
 *
 * The migration 20261030170000_costs_insights_keys writes it into the database from the same list (a test reads the SQL and
 * this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 */
export interface VisibilityKey {
  readonly key: string;
  readonly from: readonly string[];
  /** A door that was a role NAME: `users.role` equal to one of these passed yesterday. */
  readonly byRole?: readonly string[];
}

/** The role names the confirmation team tables read BY NAME (SUPER_ADMIN passes everything by the engine anyway). */
export const TEAM_TABLE_ROLE_NAMES = ['COMPANY_ADMIN', 'MANAGER'] as const;

/** The five keys `maySeeCost` was an OR of. */
export const COST_SOURCE_KEYS = ['inventory.view', 'inventory.adjust', 'production.view', 'production.manage', 'finance.view'] as const;

/** The nine keys of the screens a smart card is drawn on. */
export const INSIGHT_SOURCE_KEYS = [
  'products.view',
  'inventory.view',
  'reports.view',
  'dashboard.view',
  'confirmation.work',
  'orders.confirm',
  'customers.view',
  'orders.view',
  'landing_pages.view',
] as const;

export const VISIBILITY_KEYS_FROM: readonly VisibilityKey[] = [
  { key: 'costs.view', from: COST_SOURCE_KEYS },
  { key: 'insights.view', from: INSIGHT_SOURCE_KEYS },
  { key: 'team.monitor', from: ['users.view'], byRole: TEAM_TABLE_ROLE_NAMES },
];
