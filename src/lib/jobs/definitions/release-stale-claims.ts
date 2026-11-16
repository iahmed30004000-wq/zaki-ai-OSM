import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { readReturnsMode, releaseNoAnswerRounds, releaseStaleClaims } from '../../confirmation-queue';
import { ROUNDS_OFF, roundsOn } from '../../no-answer-rounds';
import { roundsSwitch } from '../../no-answer-rounds-switch';
import { cadenceSince } from '../../no-answer-cadence-switch';
import { activeStores } from './shared';

/**
 * Claims held with no contact attempt past the business-minute cap go back
 * to the pool. Business-hours aware, so a claim taken at 4pm is not released
 * overnight for sitting through hours nobody was working.
 */
export const releaseClaims: JobDefinition = {
  name: 'release-stale-claims',
  everySeconds: 300,
  description: 'إعادة الطلبات المحجوزة بلا محاولة اتصال إلى المخزن المشترك',
  async run({ now }): Promise<JobResult> {
    let released = 0;
    for (const store of await activeStores()) {
      const scope = { companyId: store.companyId, storeId: store.id };
      const cal = {
        workHoursStart: store.country.workHoursStart,
        workHoursEnd: store.country.workHoursEnd,
        weekendDays: store.country.weekendDays,
        timezone: store.country.timezone,
      };
      // «نظام الجولات»: read once per store (cached). OFF, the job is the one transaction it always was.
      const rounds = await roundsSwitch(db, store.companyId);
      const count = await db.$transaction((tx) => releaseStaleClaims(tx, scope, cal, now, { rounds: ROUNDS_OFF }));
      released += count;
      // ON: the rounds release in a transaction of its own, so a pass that runs out of time cannot roll back the one above.
      if (roundsOn(rounds)) {
        released += await db.$transaction((tx) => releaseNoAnswerRounds(tx, scope, cal, now, { rounds }));
      } else if (await cadenceSince(db, store.companyId)) {
        // The five-attempt cadence (step B) brings «الطلب يرجع للطابور فوراً» with it, so ITS idle release runs without «نظام الجولات» — in a transaction of its own, like the rounds'.
        // The cadence is asked FIRST: with it off nothing else is read and no second transaction opens.
        const returns = await readReturnsMode(db, store.companyId, { now, calendar: () => cal, rounds });
        released += await db.$transaction((tx) => releaseNoAnswerRounds(tx, scope, cal, now, { rounds, returns }));
      }
    }
    return { processed: released, detail: released ? `حُرِّر ${released} طلباً` : 'لا طلبات متأخرة' };
  },
};
