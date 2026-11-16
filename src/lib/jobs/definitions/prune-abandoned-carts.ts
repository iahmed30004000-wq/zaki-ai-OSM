import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { PRUNED_STATUSES } from '../../abandoned-cart-rules';
import { cartRetentionDays } from '../../abandoned-carts';

/**
 * «السلات المهجورة» — A FINISHED CART IS NOT KEPT FOR EVER.
 *
 * The brief: «احذف … السلات NOT_INTERESTED وINVALID وRECOVERED بعد 60 يوم». A cart carries a name and a phone of somebody
 * who never became a customer; once the team has closed it, or the customer ordered by himself, there is nothing left to
 * do with it. Each company's own number of days (`abandonedCarts.retentionDays`, 60 by default), counted from the cart's
 * last change, so a cart somebody touched last week is not deleted for being old.
 *
 * CONVERTED is never deleted here: its row is the only record that an order came out of a cart. Nothing else is touched —
 * the cart's history lines go with it (CASCADE), and an order it pointed at is an ordinary order that stays.
 * Idempotent: a second run the same day finds nothing.
 */
export const pruneAbandonedCarts: JobDefinition = {
  name: 'prune-abandoned-carts',
  everySeconds: 86_400,
  at: '04:00',
  description: 'حذف السلات المهجورة المنتهية (غير مهتم، رقم غير صالح، طلب لحاله) بعد مدة الحفظ',
  async run({ now }): Promise<JobResult> {
    const companies = await db.abandonedCart.groupBy({
      by: ['companyId'],
      where: { status: { in: PRUNED_STATUSES } },
    });
    let removed = 0;
    for (const { companyId } of companies) {
      const days = await cartRetentionDays(companyId);
      const before = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const { count } = await db.abandonedCart.deleteMany({
        where: { companyId, status: { in: PRUNED_STATUSES }, updatedAt: { lt: before } },
      });
      removed += count;
    }
    return { processed: removed, detail: removed ? `حُذفت ${removed} سلة منتهية` : 'لا سلات منتهية قديمة' };
  },
};
