import { describe, expect, it } from 'vitest';
import { trackingAlert, ALERT_AR, DEAD_CONFIRMATION, TRACKING_ACK_ACTION } from './alert';
import { repoFile, stripComments } from '../guard-source';

/**
 * WHAT THE PERSON CHASING A PARCEL MUST BE TOLD.
 *
 * The tracking list said where every parcel was and not the two things
 * that make chasing one pointless or wrong: the order was cancelled while
 * the parcel is still moving, or an approved change was written onto it
 * after it left. Asked for as «بيضوي أحمر إذا ملغي، وبرتقالي إذا في تعديل
 * بالبيانات» with «زر، وبالزر يطلع Pop إنها أدركت الإجراء».
 */

const T = (iso: string) => new Date(iso);
const BASE = {
  confirmationStatus: 'CONFIRMED',
  cancelledAt: null,
  changeAppliedAt: null,
  acknowledgedAt: null,
};

describe('what a row announces', () => {
  it('nothing, when nothing happened', () => {
    expect(trackingAlert(BASE)).toBeNull();
  });

  it('red when the order died and the parcel did not', () => {
    for (const confirmationStatus of DEAD_CONFIRMATION) {
      const a = trackingAlert({ ...BASE, confirmationStatus, cancelledAt: T('2026-09-20T10:00:00Z') });
      expect(a?.kind, confirmationStatus).toBe('CANCELLED');
    }
  });

  it('orange when its data changed after it left', () => {
    const a = trackingAlert({ ...BASE, changeAppliedAt: T('2026-09-20T10:00:00Z') });
    expect(a?.kind).toBe('CHANGED');
  });

  /**
   * TWO COLOURS ON ONE ROW IS A ROW NOBODY READS. If the order is dead,
   * what its address says no longer matters.
   */
  it('and a cancelled order does not also announce its edits', () => {
    const a = trackingAlert({
      ...BASE,
      confirmationStatus: 'CANCELLED',
      cancelledAt: T('2026-09-20T10:00:00Z'),
      changeAppliedAt: T('2026-09-21T10:00:00Z'),
    });
    expect(a?.kind).toBe('CANCELLED');
  });
});

describe('acknowledged, not dismissed', () => {
  it('an acknowledgement after the event silences it', () => {
    const a = trackingAlert({
      ...BASE,
      changeAppliedAt: T('2026-09-20T10:00:00Z'),
      acknowledgedAt: T('2026-09-20T11:00:00Z'),
    });
    expect(a?.acknowledged).toBe(true);
  });

  /**
   * THE ONE THAT MATTERS. Acknowledging Monday's change must not silence
   * Tuesday's — otherwise the second edit reaches nobody, which is the
   * whole failure this exists to prevent.
   */
  it('and an older acknowledgement does not silence a newer event', () => {
    const a = trackingAlert({
      ...BASE,
      changeAppliedAt: T('2026-09-21T10:00:00Z'),
      acknowledgedAt: T('2026-09-20T11:00:00Z'),
    });
    expect(a?.acknowledged).toBe(false);
  });

  it('and a cancellation with no surviving log still announces itself', () => {
    const a = trackingAlert({ ...BASE, confirmationStatus: 'CANCELLED', cancelledAt: null });
    expect(a?.kind).toBe('CANCELLED');
    expect(a?.acknowledged).toBe(false);
  });

  it('every kind has words a person reads', () => {
    for (const kind of ['CANCELLED', 'CHANGED'] as const) {
      expect(ALERT_AR[kind]).toBeTruthy();
    }
  });
});

describe('the wiring', () => {
  it('the list computes the alert from the shared rule', () => {
    const route = stripComments(repoFile('src/app/api/ops/tracking/route.ts'));
    expect(route).toMatch(/alert: trackingAlert\(\{/);
    // Read from the status log rather than guessed from the order's own
    // last write — `updatedAt` moves for any reason at all.
    expect(route).toMatch(/newValue: \{ in: \[\.\.\.DEAD_CONFIRMATION\] \}/);
    expect(route).toMatch(/appliedAt: \{ not: null \}/);
  });

  it('and acknowledging writes who saw it, and moves nothing', () => {
    const route = stripComments(repoFile('src/app/api/ops/tracking/acknowledge/route.ts'));
    // THE CONSTANT, not the string it happens to equal today. The reader
    // and the writer sharing one name is the point; a literal here would
    // pass while the two drifted apart.
    expect(route).toMatch(/action: TRACKING_ACK_ACTION/);
    expect(TRACKING_ACK_ACTION).toBe('TRACKING_ALERT_ACKNOWLEDGED');
    expect(route).toMatch(/userId: user\.id/);
    // It is a note about a person's attention, not a decision about an
    // order: no status, no money, no stock.
    for (const forbidden of ['order.update', 'shippingStatus', 'collectedAmount', 'settlementStatus']) {
      expect(route, `الإقرار يحرّك «${forbidden}»`).not.toContain(forbidden);
    }
  });

  it('and the screen asks before it records', () => {
    const src = stripComments(repoFile('src/components/screens/TrackingScreen.tsx'));
    expect(src).toMatch(/const ok = await confirm\(\{[\s\S]{0,200}ALERT_CONFIRM_AR\[o\.alert\.kind\]/);
    // The button is gone once it has been pressed for THIS event.
    expect(src).toMatch(/o\.alert && !o\.alert\.acknowledged &&/);
  });
});
