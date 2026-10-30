import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { proposePenalties, recordProposals } from '../../penalty-service';
import { activeStores } from './shared';

/**
 * Yesterday's days, read and PROPOSED as deductions. Never applied.
 *
 * Deliberately yesterday and not today: a day still being worked has no
 * departure time, so "left early" would be true of everybody at noon. And
 * deliberately proposals only — this job can be wrong about a funeral, a
 * closed road or a shift swapped by phone, and a human is the part of the
 * system that knows about those.
 */
export const proposePenaltiesJob: JobDefinition = {
  name: 'propose-penalties',
  everySeconds: 86_400,
  // Early, and about YESTERDAY — a day still being worked has no
  // departure time, so everybody would read as having left early.
  at: '07:00',
  description: 'اقتراح خصومات الأمس على التأخير والغياب — بلا اعتماد',
  async run({ now }): Promise<JobResult> {
    let proposed = 0;
    const skipped: string[] = [];

    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - 1);

    for (const store of await activeStores()) {
      if (!store.country) continue;

      const rules = await db.penaltyRule.count({ where: { companyId: store.companyId, isActive: true } });
      if (rules === 0) {
        skipped.push(`${store.id}: لا قواعد`);
        continue;
      }

      const people = await db.user.findMany({
        where: {
          companyId: store.companyId,
          status: 'ACTIVE',
          OR: [{ storeAccess: { some: { storeId: store.id } } }, { storeAccess: { none: {} } }],
        },
        select: { id: true, role: true, shiftStart: true, shiftEnd: true, restDays: true },
      });

      const scope = {
        companyId: store.companyId,
        storeId: store.id,
        start,
        end,
        calendar: {
          workHoursStart: store.country.workHoursStart,
          workHoursEnd: store.country.workHoursEnd,
          weekendDays: store.country.weekendDays,
          timezone: store.country.timezone,
        },
      };

      const proposals = await proposePenalties(
        db,
        scope,
        people.map((p) => ({
          id: p.id,
          role: p.role,
          shift: { shiftStart: p.shiftStart, shiftEnd: p.shiftEnd, restDays: p.restDays },
        }))
      );
      proposed += await recordProposals(db, scope, proposals);
    }

    return {
      processed: proposed,
      detail:
        proposed > 0
          ? `${proposed} خصماً مقترحاً بانتظار القرار — لم يُعتمد شيء`
          : skipped.join(' · ') || 'لا شيء يُقترح',
    };
  },
};
