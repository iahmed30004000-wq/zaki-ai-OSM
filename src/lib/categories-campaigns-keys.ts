/**
 * THE CATEGORIES AND THE CAMPAIGNS GOT KEYS OF THEIR OWN (perm-plan PR-11), AND THE KEY EACH DOOR ASKED BEFORE.
 *
 * Three keys:
 *
 *   categories.manage   ← products.edit   (naming, renaming, deleting a shelf; the sorter making a shelf) — D1m, see below
 *   campaigns.view      ← reports.view    (the campaigns screen and its list)
 *   campaigns.manage    ← reports.view    (typing one in, editing, deleting, ordering, merging duplicates, bulk, and the two
 *                                          pulls from the ad platforms: «اسحب الإنفاق» and «اسحب الحملات»)
 *
 * Until now the categories' writes asked `products.edit` and ignored its scope, and every campaign door — the list, the eight
 * writes and the two pulls — asked `reports.view`, the key of the reports board. `analytics.view` no longer stands behind
 * either (retired by 20261029130000_analytics_view_becomes_reports_view), so `reports.view` is the ONLY key that opened them.
 *
 * `from` is OR: whoever held ANY of them yesterday passed the door, so whoever held any of them holds the new key today.
 *
 * `allCompanyOnly` is D1m, the ONE deliberate narrowing in this change (decided under the owner's rule, 28/10, «اي قرار بعد
 * الان اتخذو دون الرجوع الي»): a `products.edit` held for CERTAIN CATEGORIES or CERTAIN PRODUCTS used to be enough to name,
 * rename and delete the COMPANY's shelves, because the door never read the scope. That is a leak — someone who may edit only
 * the skincare line could delete «العناية بالبشرة» for everybody. The migration gives `categories.manage` only to those whose
 * `products.edit` is «كل الشركة». Nothing else here takes a door from anybody.
 *
 * The migration 20261030180000_categories_campaign_keys writes it into the database from the same list (a test reads the SQL
 * and this table side by side), and the in-code fallback in permissions-core applies it to a person with no stored role.
 */
export interface CategoriesCampaignsKey {
  readonly key: string;
  readonly from: readonly string[];
  /** D1m: the source counts only when it is held «كل الشركة». */
  readonly allCompanyOnly: boolean;
}

export const CATEGORIES_CAMPAIGNS_KEYS_FROM: readonly CategoriesCampaignsKey[] = [
  { key: 'categories.manage', from: ['products.edit'], allCompanyOnly: true },
  { key: 'campaigns.view', from: ['reports.view'], allCompanyOnly: false },
  { key: 'campaigns.manage', from: ['reports.view'], allCompanyOnly: false },
];
