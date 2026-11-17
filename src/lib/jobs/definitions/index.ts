import type { JobDefinition } from '../runner';
import { watchdog } from './watchdog';
import { dailyBackup } from './daily-backup';
import { syncCourierStatus, POLL_BATCH } from './sync-courier-status';
import { releaseClaims } from './release-stale-claims';
import { surfacePostponed } from './surface-postponed';
import { staleReturns } from './stale-returns';
import { closingReminder } from './closing-reminder';
import { accrueCommission } from './accrue-commission';
import { accruePeriodCommission } from './accrue-period-commission';
import { deliverAppEvents } from './deliver-app-events';
import { deliverConversions } from './deliver-conversions';
import { proposePenaltiesJob } from './propose-penalties';
import { escalateChangeRequests } from './escalate-change-requests';
import { pullAdSpend } from './pull-ad-spend';
import { reserveReturning } from './reserve-returning-customers';
import { pruneAbandonedCarts } from './prune-abandoned-carts';
import { intakeFilter } from './intake-filter';
import { queueHealthJob } from './queue-health';

export {
  queueHealthJob,
  intakeFilter,
  pruneAbandonedCarts,
  releaseClaims,
  accrueCommission,
  POLL_BATCH,
  syncCourierStatus,
  surfacePostponed,
  staleReturns,
  closingReminder,
  deliverAppEvents,
  deliverConversions,
  accruePeriodCommission,
  proposePenaltiesJob,
  escalateChangeRequests,
  pullAdSpend,
  reserveReturning,
  watchdog,
};

/**
 * The scheduled jobs.
 *
 * Each one calls the service that already owns the rule — releaseStaleClaims,
 * accrueForOrder, the courier adapter — rather than restating it. The job's
 * own job is to find the work, hand it over, and count what happened. A rule
 * implemented twice is a rule that will disagree with itself.
 *
 * Every job is idempotent: running it twice does the work once.
 *
 * One file per job in this folder; this file only gathers them. The names,
 * the intervals and the ORDER of `JOBS` are the contract with the run log —
 * never rename, retime or reorder one here.
 */

export const JOBS: JobDefinition[] = [
  watchdog,
  dailyBackup,
  syncCourierStatus,
  releaseClaims,
  surfacePostponed,
  staleReturns,
  closingReminder,
  accrueCommission,
  accruePeriodCommission,
  deliverAppEvents,
  deliverConversions,
  proposePenaltiesJob,
  escalateChangeRequests,
  pullAdSpend,
  // Appended, never inserted: the order of this list is the contract with the run log.
  reserveReturning,
  // «السلات المهجورة» (contract oms-lp.v1 §9): a finished cart is deleted after the company's retention days.
  pruneAbandonedCarts,
  // «فلتر الاستقبال» (Confirmation Center v2, step C1): a flag on a repeated or oddly-shaped new order. Behind its own company switch.
  intakeFilter,
  // «صحة الطابور» (Confirmation Center v2, step D2): alerts the supervisors and the company admin. Behind the queue-priority key; writes notifications only.
  queueHealthJob,
];

export function jobByName(name: string): JobDefinition | undefined {
  return JOBS.find((j) => j.name === name);
}
