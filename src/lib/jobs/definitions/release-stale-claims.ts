import { db } from '../../db';
import type { JobDefinition, JobResult } from '../runner';
import { readReturnsMode, releaseNoAnswerRounds, releaseStaleClaims } from '../../confirmation-queue';
import { ROUNDS_OFF, roundsOn } from '../../no-answer-rounds';
import { roundsSwitch } from '../../no-answer-rounds-switch';
import { cadenceSince } from '../../no-answer-cadence-switch';
import { confirmationRuleOnce } from '../../confirmation-rule-settings';
import { confirmationRulesOnce } from '../../employee-numbers';
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
      // REQUEST C2 (18/11): the plan is asked FIRST. With «إثبات المكالمات وجدول المحاولات» on, ONLY its idle release runs — the rounds' three releases do not, even with
      // «نظام الجولات» stored on (the mode handed in carries `cadence`, so `releaseNoAnswerRounds` never reaches `releaseByRounds`). In a transaction of its own, as before.
      if (await cadenceSince(db, store.companyId)) {
        // Request Q3b: the rule in force, read ONCE for this store's pass (cached, before the transaction): the idle cut and the notice's figure are the same rule's.
        // An edit never reaches back: the pass judges only how long an order has sat untouched NOW against the minutes in force — it closes nothing and rewrites no due.
        const rule = confirmationRuleOnce(db, store.companyId, now.getTime());
        const returns = await readReturnsMode(db, store.companyId, { now, calendar: () => cal, rounds, rule });
        // Request Q4b: the owner's rules, read the same way (cached, before the transaction): the idle release judges EACH holder by her own minutes — never a colleague
        // by another's. With no rule this is the pass above, query for query.
        const rules = confirmationRulesOnce(db, store.companyId, now.getTime());
        await rules();
        released += await db.$transaction((tx) => releaseNoAnswerRounds(tx, scope, cal, now, { rounds, returns, rule, rules }));
      } else if (roundsOn(rounds)) {
        // The plan off, the rounds on: the rounds release in a transaction of its own, so a pass that runs out of time cannot roll back the one above — as on main.
        // Q4b: the rules are read inside the pass here (`releaseNoAnswerRounds` asks them itself, cached) — the fifth argument stays main's.
        released += await db.$transaction((tx) => releaseNoAnswerRounds(tx, scope, cal, now, { rounds }));
      }
    }
    return { processed: released, detail: released ? `حُرِّر ${released} طلباً` : 'لا طلبات متأخرة' };
  },
};
