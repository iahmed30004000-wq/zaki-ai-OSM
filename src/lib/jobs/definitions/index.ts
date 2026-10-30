import type { JobDefinition } from '../runner';
import { watchdog } from './watchdog';
import { dailyBackup } from './daily-backup';
import { syncCourierStatus, POLL_BATCH, forgetCourierPollCursor } from './sync-courier-status';
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

export {
  releaseClaims,
  accrueCommission,
  POLL_BATCH,
  forgetCourierPollCursor,
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
];

export function jobByName(name: string): JobDefinition | undefined {
  return JOBS.find((j) => j.name === name);
}
