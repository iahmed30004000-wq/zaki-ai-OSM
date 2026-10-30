import { db } from '../../db';

/** Why an order earned nobody anything, in words. */
export const SKIP_AR: Record<string, string> = {
  NO_RULE: 'بلا قاعدة عمولة تغطّيها',
  RETURNED: 'مرتجعة',
  NOT_DELIVERED: 'غير مسلَّمة',
  ALREADY_ACCRUED: 'محتسَبة مسبقاً',
  BELOW_MINIMUM: 'دون الحد الأدنى لعدد الطلبات',
  NO_TIER: 'خارج شرائح القاعدة',
  NOTHING_EARNED: 'لم تستحق شيئاً',
};

/** Every active store, with the country facts its rules depend on. */
export async function activeStores() {
  return db.store.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      companyId: true,
      countryId: true,
      country: {
        select: {
          id: true, name: true, code: true, minorUnit: true, currencyCode: true,
          workHoursStart: true, workHoursEnd: true, weekendDays: true, timezone: true,
        },
      },
    },
  });
}
