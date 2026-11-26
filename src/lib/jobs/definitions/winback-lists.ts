import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { autoMoveIdleLists, expireLists } from '../../winback-private-list';
import { bulkAgents } from '../../winback-bulk';
import { activeStores } from './shared';

/**
 * «قوايم الاسترجاع» (F12, the owner's ruling 25/11): for each store, (1) what a private win-back list held untouched for three days goes
 * back to the win-back pool, marked «انعرض من قبل»; (2) a list nobody touched for one full shift moves its untouched rows to the active
 * agent with the fewest open rows. Store by store, idempotent (a second pass finds nothing to do), and it reads only orders carrying a
 * list mark — no other order is touched (the 165 handed out by hand on 25/11 carry none).
 */
export const winbackLists: JobDefinition = {
  name: 'winback-lists',
  everySeconds: 900,
  description: 'قوايم الاسترجاع: يرجّع اللي ما انلمس بعد 3 أيام، وينقل قايمة ما انلمست شفت كامل لموظفة شغّالة',
  async run({ now }): Promise<JobResult> {
    let expired = 0;
    let moved = 0;
    for (const store of await activeStores()) {
      const scope = { companyId: store.companyId, storeId: store.id };
      expired += await expireLists(db, scope, now);
      const has = await db.order.count({ where: { ...scope, winbackListUserId: { not: null } } });
      if (has === 0) continue;
      const cal = {
        workHoursStart: store.country.workHoursStart,
        workHoursEnd: store.country.workHoursEnd,
        weekendDays: store.country.weekendDays,
        timezone: store.country.timezone,
      };
      const eligible = (await bulkAgents(scope)).map((a) => a.id);
      moved += await autoMoveIdleLists(db, scope, cal, now, eligible);
    }
    return { processed: expired + moved, detail: expired + moved ? `رجع ${expired} — انتقل ${moved}` : 'ما في شي' };
  },
};
