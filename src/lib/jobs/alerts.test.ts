import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE MISSED-JOB ALERT — PROVING IT FIRES.
 *
 * What was there before: `scripts/worker.ts` counted consecutive failures,
 * knew about ALERT_AFTER_FAILURES, and had a branch saying the job "needs
 * intervention". That branch called `console.log`. In a detached pm2 or
 * systemd worker that is a file nobody opens unless they already suspect
 * something — which is the one job an alert has. So the alert did not exist.
 *
 * It exists now, and every guard on it has a failing case here: the
 * threshold, the repetition brake, the de-duplication window, the
 * unconfigured chat id, a Telegram refusal, and the link.
 */

const { sendMessage, readSystemSetting, updateSystemSetting } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  readSystemSetting: vi.fn(),
  updateSystemSetting: vi.fn(),
}));

vi.mock('../telegram/send', () => ({ sendMessage: (...a: unknown[]) => sendMessage(...a) }));
vi.mock('../system-settings', () => ({
  readSystemSetting: (...a: unknown[]) => readSystemSetting(...a),
  updateSystemSetting: (...a: unknown[]) => updateSystemSetting(...a),
}));

import { ALERT_AFTER_FAILURES } from './runner';
import {
  JOB_ALERTS_SETTING,
  REALERT_AFTER_MINUTES,
  REALERT_EVERY_FAILURES,
  alertAboutJob,
  alertChatId,
  formatAlert,
  jobsScreenLink,
  shouldAlertOnFailure,
} from './alerts';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const sentText = () => sendMessage.mock.calls.at(-1)![1] as string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('TELEGRAM_ALERT_CHAT_ID', '-1001234567890');
  vi.stubEnv('APP_URL', 'https://zaki.example.com');
  readSystemSetting.mockResolvedValue(undefined);
  updateSystemSetting.mockResolvedValue(undefined);
  sendMessage.mockResolvedValue({ ok: true, result: { message_id: 1 } });
});

afterEach(() => vi.unstubAllEnvs());

// ─────────────────────────────────────────────────────
// The threshold, and the brake above it
// ─────────────────────────────────────────────────────

describe('deciding whether a failure count is worth shouting about', () => {
  it('says nothing below the threshold', async () => {
    // A courier API that times out once and works on the retry is not an
    // incident. Alerting on it is how the channel becomes noise, and a
    // noisy channel is a muted channel.
    for (let n = 0; n < ALERT_AFTER_FAILURES; n++) {
      expect(shouldAlertOnFailure(n), `${n}`).toBe(false);
    }
  });

  it('shouts exactly once at the threshold', async () => {
    expect(shouldAlertOnFailure(ALERT_AFTER_FAILURES)).toBe(true);
    expect(shouldAlertOnFailure(ALERT_AFTER_FAILURES + 1)).toBe(false);
  });

  it('does not shout on every failure after the threshold', async () => {
    // THE FAILURE THIS PREVENTS: a 60-second job that is broken stays
    // broken. One message per cycle is 1,440 a day; the owner mutes the
    // chat, and the next alert — a different job, a real emergency —
    // arrives in a muted chat.
    const shouts = [];
    for (let n = ALERT_AFTER_FAILURES; n <= ALERT_AFTER_FAILURES + 30; n++) {
      if (shouldAlertOnFailure(n)) shouts.push(n);
    }
    expect(shouts).toEqual([
      ALERT_AFTER_FAILURES,
      ALERT_AFTER_FAILURES + REALERT_EVERY_FAILURES,
      ALERT_AFTER_FAILURES + REALERT_EVERY_FAILURES * 2,
      ALERT_AFTER_FAILURES + REALERT_EVERY_FAILURES * 3,
    ]);
  });
});

// ─────────────────────────────────────────────────────
// The message itself — and the link, which is the point
// ─────────────────────────────────────────────────────

describe('what the message says', () => {
  it('carries a tappable absolute link to the jobs screen', async () => {
    // Per the brief. Without it, "accrue-commission failed" on a phone at
    // 3am means finding a laptop and remembering the hostname. With it, it
    // is one tap to the run log, the error and the "try again" button.
    await alertAboutJob({ jobName: 'accrue-commission', kind: 'failing', failures: 3 }, NOW);
    expect(sentText()).toContain('https://zaki.example.com/admin/jobs');
  });

  it('names the job and the fault in Arabic', async () => {
    await alertAboutJob(
      { jobName: 'sync-courier-status', kind: 'failing', failures: 3, error: 'ETIMEDOUT' },
      NOW
    );
    const text = sentText();
    expect(text).toContain('sync-courier-status');
    expect(text).toContain('فشلت 3 مرة متتالية');
    expect(text).toContain('ETIMEDOUT');
  });

  it('says a missed job never ran, not that it failed', async () => {
    // These are different faults needing different actions: a failing job
    // has an error to read, a missed job means the scheduler never called
    // it. A message that conflates them sends the reader to the wrong place.
    await alertAboutJob({ jobName: 'closing-reminder', kind: 'overdue', overdueSeconds: 5400 }, NOW);
    const text = sentText();
    expect(text).toContain('لم تعمل');
    expect(text).toContain('90 دقيقة');
    expect(text).not.toContain('فشلت');
  });

  it('says a parked job will not retry itself', async () => {
    // Otherwise the reader waits for a retry that is never coming.
    await alertAboutJob({ jobName: 'daily-backup', kind: 'parked', failures: 12 }, NOW);
    expect(sentText()).toContain('يدوياً');
  });

  it('truncates a long error so it cannot push the link off the message', async () => {
    // Telegram cuts at 4096 characters. A stack trace would take the link
    // with it, and the link is the part that lets them act.
    const text = formatAlert(
      { jobName: 'j', kind: 'failing', failures: 3, error: 'x'.repeat(5000) },
      'https://host/admin/jobs'
    );
    expect(text.length).toBeLessThan(900);
    expect(text).toContain('https://host/admin/jobs');
  });

  it('still sends something useful when no app URL is configured', async () => {
    // A missing APP_URL must not suppress the alert — a message without a
    // link beats silence.
    vi.stubEnv('APP_URL', '');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
    vi.stubEnv('VERCEL_URL', '');
    expect(jobsScreenLink()).toBeNull();
    await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sentText()).toContain('j');
  });
});

// ─────────────────────────────────────────────────────
// Every guard, from its failing side
// ─────────────────────────────────────────────────────

describe('the guards', () => {
  it('fails closed, and says why, when no chat id is configured', async () => {
    // The chat id is the owner's to supply — Telegram will not let a bot
    // open a conversation. A silent no-op here would be the same fault as
    // the console.log this replaces, one layer deeper.
    vi.stubEnv('TELEGRAM_ALERT_CHAT_ID', '');
    expect(await alertChatId()).toBeNull();

    const res = await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW);
    expect(res).toEqual({ sent: false, reason: 'NOT_CONFIGURED' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('writes nothing to the de-duplication log when it could not send', async () => {
    // Otherwise the day the owner finally sets the chat id, the first three
    // hours of alerts are suppressed as duplicates of messages that were
    // never sent.
    vi.stubEnv('TELEGRAM_ALERT_CHAT_ID', '');
    await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW);
    expect(updateSystemSetting).not.toHaveBeenCalled();
    expect(readSystemSetting).not.toHaveBeenCalled();
  });

  it('reports a missing bot token as unconfigured, not as a send failure', async () => {
    // Different responses: one is a value to set, the other is Telegram
    // being down. A log that calls them the same thing sends somebody to
    // check the wrong thing.
    sendMessage.mockResolvedValue({ ok: false, errorCode: 'NO_TOKEN' });
    const res = await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW);
    expect(res).toEqual({ sent: false, reason: 'NOT_CONFIGURED' });
  });

  it('reports a Telegram refusal as a send failure and remembers nothing', async () => {
    sendMessage.mockResolvedValue({ ok: false, errorCode: 'TIMEOUT' });
    const res = await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW);
    expect(res).toEqual({ sent: false, reason: 'SEND_FAILED' });
    // Not written down: a failed send must be retried on the next cycle,
    // not suppressed for three hours as though it had arrived.
    expect(updateSystemSetting).not.toHaveBeenCalled();
  });

  it('does not repeat itself inside the window', async () => {
    readSystemSetting.mockResolvedValue({ j: { at: minutesAgo(10), kind: 'failing' } });
    const res = await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 13 }, NOW);
    expect(res).toEqual({ sent: false, reason: 'DUPLICATE' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('raises it again once the window has passed', async () => {
    readSystemSetting.mockResolvedValue({
      j: { at: minutesAgo(REALERT_AFTER_MINUTES + 1), kind: 'failing' },
    });
    expect(await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 13 }, NOW)).toEqual({
      sent: true,
    });
  });

  it('does not let one job silence another', async () => {
    readSystemSetting.mockResolvedValue({ other: { at: minutesAgo(1), kind: 'failing' } });
    expect(await alertAboutJob({ jobName: 'j', kind: 'overdue', overdueSeconds: 600 }, NOW)).toEqual(
      { sent: true }
    );
  });

  it('lets a new KIND of fault through inside the window', async () => {
    // "it is failing" went out ten minutes ago; "it has stopped trying" is
    // a new fact and must arrive.
    readSystemSetting.mockResolvedValue({ j: { at: minutesAgo(10), kind: 'failing' } });
    expect(await alertAboutJob({ jobName: 'j', kind: 'parked', failures: 12 }, NOW)).toEqual({
      sent: true,
    });
  });

  it('sends when the de-duplication store itself cannot be read', async () => {
    // Erring towards a duplicate is the right side of this: a duplicate is
    // a nuisance, a suppressed alert is an outage nobody heard about.
    readSystemSetting.mockRejectedValue(new Error('relation does not exist'));
    expect(await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW)).toEqual({
      sent: true,
    });
  });

  it('ignores an unparseable timestamp rather than suppressing for ever', async () => {
    // A corrupt row must not become a permanent mute.
    readSystemSetting.mockResolvedValue({ j: { at: 'not a date', kind: 'failing' } });
    expect(await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW)).toEqual({
      sent: true,
    });
  });

  it('still reports success when it cannot write the alert down', async () => {
    // The message DID arrive. Throwing here would turn a delivered alert
    // into a job failure, which would then alert about itself.
    updateSystemSetting.mockRejectedValue(new Error('read only transaction'));
    expect(await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW)).toEqual({
      sent: true,
    });
  });

  it('records the alert under the one settings key, merging rather than replacing', async () => {
    await alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW);
    const [key, change] = updateSystemSetting.mock.calls[0];
    expect(key).toBe(JOB_ALERTS_SETTING);
    // A `change` that returned only this job would wipe every other job's
    // de-duplication state, and the next cycle would re-send all of them.
    expect(change({ other: { at: minutesAgo(1), kind: 'overdue' } })).toEqual({
      other: { at: minutesAgo(1), kind: 'overdue' },
      j: { at: NOW.toISOString(), kind: 'failing' },
    });
  });

  it('never throws, whatever Telegram does', async () => {
    // It is called from the worker's failure path and from the watchdog.
    // An alert that threw would be caught as the job failing and would
    // alert about itself — so a raw rejection from the send layer must come
    // back as an outcome, not as an exception.
    sendMessage.mockRejectedValue(new Error('socket hang up'));
    await expect(
      alertAboutJob({ jobName: 'j', kind: 'failing', failures: 3 }, NOW)
    ).resolves.toEqual({ sent: false, reason: 'SEND_FAILED' });
  });
});
