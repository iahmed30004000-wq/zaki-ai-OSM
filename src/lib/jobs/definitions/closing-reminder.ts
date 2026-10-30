import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { blockingClosing } from '../../wallets';
import { createNotification } from '../../notification';

/**
 * Reminds that a wallet's day has not been counted, and says plainly when an
 * earlier unexplained difference is blocking today's close.
 */
export const closingReminder: JobDefinition = {
  name: 'closing-reminder',
  everySeconds: 86_400,
  // Before people leave. A reminder to count the drawer that arrives
  // after everyone has gone home is a reminder about tomorrow.
  at: '16:45',
  description: 'تذكير بالإغلاق اليومي لكل محفظة',
  async run({ now }): Promise<JobResult> {
    const day = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    let pending = 0;

    // Only wallets that belong to a store. The closing screen lists the
    // wallets of the store you are in, so a reminder about a wallet with no
    // store is one nobody can act on — and it reached every cash-holder in
    // the company, in every country.
    const wallets = await db.wallet.findMany({
      where: { isActive: true, storeId: { not: null } },
      select: { id: true, name: true, companyId: true, storeId: true },
    });

    for (const wallet of wallets) {
      const closing = await db.dailyClosing.findUnique({
        where: { walletId_date: { walletId: wallet.id, date: day } },
        select: { id: true, status: true },
      });
      if (closing?.status === 'APPROVED') continue;

      const blocker = await blockingClosing(db, wallet.id, day);
      pending++;

      // Once per WALLET per day, keyed on the wallet's id carried in the
      // link. Keying on the name failed twice over: «نقد» matched the
      // message of «نقد: فرع», and two wallets may share a name.
      const link = `/finance/closing?wallet=${wallet.id}`;
      const already = await db.notification.findFirst({
        where: {
          companyId: wallet.companyId,
          storeId: wallet.storeId,
          type: 'CLOSING_DUE',
          link,
          createdAt: { gte: day },
        },
        select: { id: true },
      });
      if (already) continue;

      // To whoever counts the cash (finance.cashbox, the closing screen's
      // own gate) and can enter the wallet's store.
      await createNotification({
        companyId: wallet.companyId,
        storeId: wallet.storeId,
        audience: { permission: 'finance.cashbox' },
        title: 'الإغلاق اليومي',
        message: blocker
          ? `${wallet.name}: إغلاق سابق بفرق غير مفسَّر يمنع إغلاق اليوم`
          : `${wallet.name}: لم يُسجَّل جرد اليوم بعد`,
        type: 'CLOSING_DUE',
        link,
      });
    }

    return { processed: pending, detail: pending ? `${pending} محفظة بانتظار الإغلاق` : 'كل المحافظ مغلقة' };
  },
};
