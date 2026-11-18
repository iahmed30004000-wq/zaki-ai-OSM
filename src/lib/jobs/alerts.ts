import { sendMessage } from '../telegram/send';
import { getAppUrl } from '../telegram/config';
import { getSetting } from '../integration-settings';
import { readSystemSetting, updateSystemSetting } from '../system-settings';
import { ALERT_AFTER_FAILURES } from './runner';

/**
 * WHEN A SCHEDULED JOB STOPS WORKING, SOMEBODY HAS TO BE TOLD.
 *
 * ── WHAT WAS ACTUALLY THERE BEFORE THIS FILE ──
 *
 * `scripts/worker.ts` already counted consecutive failures, already knew
 * about `ALERT_AFTER_FAILURES`, and already had a branch that said the job
 * "needs intervention". That branch called `console.log`.
 *
 * A `console.log` in a detached worker process is not an alert. On this
 * deployment the worker runs under pm2 or systemd, so that line lands in a
 * file on the server that nobody opens unless they already suspect
 * something — which is the one thing an alert exists to replace. The
 * commission accrual could fail every hour for a week and the only trace a
 * human would ever see is the jobs screen, if a human happened to open it.
 *
 * So the alert was MISSING, not broken: everything up to the last inch was
 * built, and the last inch went to a log file.
 *
 * ── THE LINK IS NOT DECORATION ──
 *
 * The brief requires a link, and the reason is the difference between being
 * woken up and being able to act. "accrue-commission failed" at 03:00 on a
 * phone, with no link, means finding a laptop, remembering the hostname,
 * logging in, and hunting for the screen. With the link it is one tap to
 * /admin/jobs, where the run log, the error and the "try again" button are.
 *
 * ── WHY TELEGRAM AND NOT AN IN-APP NOTIFICATION ──
 *
 * `src/lib/notify.ts` writes notifications for employees to see when they
 * next open the app. That is useless for this: the failure that matters
 * most is the one that happens while nobody is in the app, and an in-app
 * notification about the system being broken may need the broken system to
 * be read at all.
 */

/**
 * The chat the alert goes to.
 *
 * ── BLOCKED ON THE OWNER ──
 *
 * This cannot be invented. Telegram will not let a bot start a
 * conversation: the owner must message the bot first, and only then does a
 * chat id exist. So two values are the owner's to supply and nobody
 * else's:
 *
 *   TELEGRAM_BOT_TOKEN       (already read by src/lib/telegram/config.ts)
 *   TELEGRAM_ALERT_CHAT_ID   (this — the chat or group the alerts land in)
 *
 * Neither is in `.env` today. Everything below is built and tested; with
 * those two set it sends, and without them it FAILS CLOSED AND SAYS SO
 * rather than pretending. A silent no-op here would be the same fault as
 * the `console.log` it replaces, one layer deeper and harder to find.
 *
 * It is ENTERED ON THE SITE now («الإعدادات ← الربط», `integration-settings.ts`), with the environment variable of the same name as the fallback. The old
 * reason for reading only the environment — the alert must work when the database is the thing that is broken — is kept: a failed read serves the LAST value
 * the process knew (remembered 30 s, and kept through an outage) and then the environment, so a saved chat id does not vanish at the one moment it is needed.
 */
export async function alertChatId(): Promise<string | null> {
  const id = await getSetting('TELEGRAM_ALERT_CHAT_ID');
  return id && id.trim() ? id.trim() : null;
}

/** The jobs screen, absolute — a relative path is not tappable in Telegram. */
export function jobsScreenLink(): string | null {
  const base = getAppUrl();
  return base ? `${base}/admin/jobs` : null;
}

export type AlertKind =
  /** It ran and threw, repeatedly. */
  | 'failing'
  /** Its hour or its interval passed and it never ran at all. */
  | 'overdue'
  /** It failed so many times the runner stopped trying (see PARK_AFTER_FAILURES). */
  | 'parked';

export interface AlertSubject {
  jobName: string;
  kind: AlertKind;
  /** Consecutive failures, for 'failing' and 'parked'. */
  failures?: number;
  /** How late it is, in seconds, for 'overdue'. */
  overdueSeconds?: number;
  /** The last error, for 'failing' and 'parked'. */
  error?: string;
}

export type AlertOutcome =
  | { sent: true }
  /** No bot token, or no chat id. The owner's to supply; see `alertChatId`. */
  | { sent: false; reason: 'NOT_CONFIGURED' }
  /** Already shouted about recently. See `REALERT_AFTER_MINUTES`. */
  | { sent: false; reason: 'DUPLICATE' }
  /** Telegram refused or was unreachable. */
  | { sent: false; reason: 'SEND_FAILED' };

/**
 * The same job must not alert again for this long.
 *
 * THE FAILURE THIS PREVENTS: a job on a 60-second schedule that has broken
 * stays broken. Alerting on every cycle is 1,440 identical messages a day.
 * The owner mutes the chat by message thirty, and the next alert — a
 * different job, a real emergency — arrives in a muted chat. An alerting
 * channel's credibility is a finite resource and repetition spends it.
 *
 * Three hours: long enough that an unattended failure overnight is four
 * messages rather than hundreds, short enough that a failure nobody got to
 * is raised again in the same working day.
 */
export const REALERT_AFTER_MINUTES = 180;

/**
 * Where "we already said this" is remembered.
 *
 * In the settings table rather than in memory because the worker restarts —
 * and a deploy at the wrong moment would otherwise re-send every alert it
 * had already sent, which teaches people that the alerts repeat themselves
 * and can be ignored.
 *
 * One row, one small JSON document: `{ "<jobName>": { at, kind } }`.
 */
export const JOB_ALERTS_SETTING = 'jobs.alerts';

type AlertLog = Record<string, { at: string; kind: AlertKind }>;

/**
 * Is this failure count one to shout about?
 *
 * Stateless, answered from the count alone, so it needs no memory and
 * survives a restart: the count itself comes from the run log.
 *
 *   - Below the threshold: no. A courier API that times out once and works
 *     on the retry is not an incident, and alerting on it is how an alert
 *     channel becomes noise.
 *   - Exactly at the threshold: yes. This is the first alert.
 *   - Above it: only every tenth, as a second brake on top of the time
 *     window below — a job failing every second would otherwise cross the
 *     window's three hours and send again while plainly still mid-incident.
 */
export const REALERT_EVERY_FAILURES = 10;

export function shouldAlertOnFailure(failures: number): boolean {
  if (failures < ALERT_AFTER_FAILURES) return false;
  if (failures === ALERT_AFTER_FAILURES) return true;
  return (failures - ALERT_AFTER_FAILURES) % REALERT_EVERY_FAILURES === 0;
}

/**
 * What a human reads, in Arabic, on a phone, possibly at 3am.
 *
 * NO EMOJI, DELIBERATELY. The first draft opened each message with 🔴 or
 * ⛔ and `one-icon-family.test.ts` caught it — rightly. Its rule is that an
 * emoji is drawn by whatever operating system is reading it, so the same
 * character is a flat outline on a desk and a coloured sticker on the
 * warehouse phone. The temptation was to claim an exception because this
 * text leaves for Telegram rather than a screen, but that makes the rule
 * worse, not the message better: the Arabic word already says which of the
 * three faults this is, and a line of prose is the same on every device.
 */
export function formatAlert(subject: AlertSubject, link: string | null): string {
  const head =
    subject.kind === 'overdue'
      ? 'تنبيه: مهمة مجدولة لم تعمل'
      : subject.kind === 'parked'
        ? 'تنبيه: مهمة مجدولة توقَّفت نهائياً'
        : 'تنبيه: مهمة مجدولة تفشل';

  const lines = [head, '', `المهمة: ${subject.jobName}`];

  if (subject.kind === 'overdue') {
    const minutes = Math.max(1, Math.round((subject.overdueSeconds ?? 0) / 60));
    lines.push(`متأخّرة: ${minutes} دقيقة عن موعدها`);
    lines.push('لم تُسجَّل لها أي محاولة — تحقَّق أن المجدول يعمل.');
  } else {
    lines.push(`فشلت ${subject.failures ?? 0} مرة متتالية`);
    if (subject.kind === 'parked') {
      lines.push('لن تُحاول مرة أخرى حتى يُعاد تفعيلها يدوياً.');
    }
    // The error text goes in: this chat is the owner's own, and without it
    // the message says only "something broke" — which is a page, not an
    // alert. Capped because Telegram truncates at 4096 and a stack trace
    // would push the LINK off the end of the message, and the link is the
    // part that lets them act.
    if (subject.error) lines.push('', `السبب: ${subject.error.slice(0, 300)}`);
  }

  // Last, and always: the whole point is that it is tappable.
  if (link) lines.push('', `شاشة المهام: ${link}`);

  return lines.join('\n');
}

async function recentlyAlerted(jobName: string, kind: AlertKind, now: Date): Promise<boolean> {
  let log: AlertLog | undefined;
  try {
    log = await readSystemSetting<AlertLog>(JOB_ALERTS_SETTING);
  } catch {
    // The de-duplication store being unreadable must not swallow the
    // alert. Erring towards sending twice is the right side of this: a
    // duplicate message is a nuisance, a suppressed one is an outage
    // nobody heard about.
    return false;
  }

  const last = log?.[jobName];
  if (!last) return false;
  // A job that was failing and is now PARKED is a new fact, not a repeat —
  // "it stopped trying" needs to arrive even if "it is failing" went out
  // ten minutes ago.
  if (last.kind !== kind) return false;

  const at = new Date(last.at).getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < REALERT_AFTER_MINUTES * 60_000;
}

async function rememberAlert(jobName: string, kind: AlertKind, now: Date): Promise<void> {
  try {
    await updateSystemSetting<AlertLog>(JOB_ALERTS_SETTING, (current) => ({
      ...(current ?? {}),
      [jobName]: { at: now.toISOString(), kind },
    }));
  } catch {
    // Already sent. Failing to write it down means the next cycle may send
    // again; throwing here would turn a successful alert into a job
    // failure, which would then alert about itself.
  }
}

/**
 * Send one alert about one job, de-duplicated.
 *
 * NEVER THROWS. Called from the worker's failure path and from the watchdog
 * job: an alert that throws would be counted as the job failing, which
 * would raise another alert, which would throw. The outcome is returned so
 * the caller can log what happened instead.
 */
export async function alertAboutJob(
  subject: AlertSubject,
  now: Date = new Date()
): Promise<AlertOutcome> {
  const chatId = await alertChatId();
  // Checked before the de-duplication read: with nothing configured there
  // is no point paying for a query, and — more importantly — nothing must
  // be written to the "already alerted" log, or the day the owner finally
  // sets the chat id the first three hours of alerts would be suppressed
  // as duplicates of messages that were never sent.
  if (!chatId) return { sent: false, reason: 'NOT_CONFIGURED' };

  if (await recentlyAlerted(subject.jobName, subject.kind, now)) {
    return { sent: false, reason: 'DUPLICATE' };
  }

  // `sendMessage` already swallows timeouts and network faults into an
  // `ok: false` result — but it is wrapped anyway, because this function
  // promises not to throw and that promise must not depend on another
  // module keeping its own. A DNS failure or an out-of-memory inside the
  // fetch would otherwise escape into the worker's catch block and be
  // counted as the JOB failing: the alert would become the incident.
  let res: Awaited<ReturnType<typeof sendMessage>>;
  try {
    res = await sendMessage(chatId, formatAlert(subject, jobsScreenLink()));
  } catch {
    return { sent: false, reason: 'SEND_FAILED' };
  }

  // NO_TOKEN is reported as not-configured rather than as a send failure:
  // it is the owner's missing value, not Telegram being down, and the two
  // call for completely different responses from whoever reads the log.
  if (!res.ok) {
    return { sent: false, reason: res.errorCode === 'NO_TOKEN' ? 'NOT_CONFIGURED' : 'SEND_FAILED' };
  }

  await rememberAlert(subject.jobName, subject.kind, now);
  return { sent: true };
}
