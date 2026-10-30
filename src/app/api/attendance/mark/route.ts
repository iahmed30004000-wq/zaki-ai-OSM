import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { apiErrorResponse } from '@/lib/api-error';
import { markAttendance } from '@/lib/attendance';

/**
 * POST /api/attendance/mark — "استلمت" / "سلّمت".
 *
 * Only ever for yourself. Marking somebody else's arrival is the one thing
 * an attendance system must not allow, so there is no userId in the body to
 * forge: the mark is written for whoever is holding the session.
 *
 * The login already records an automatic arrival. This button exists for
 * the hours that leave no trace in the order records — a meeting, a
 * training, a shift spent waiting for a queue that stayed empty — and for
 * saying plainly "I have finished for today".
 */

const schema = z.object({
  kind: z.enum(['CHECK_IN', 'CHECK_OUT']),
  note: z.string().trim().max(200).optional().nullable(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId } = await requireContext();

    const parsed = schema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة' }, { status: 400 });
    }
    const { kind, note } = parsed.data;

    // Pressing the same button twice in a row is a slip, not a second
    // arrival. The earlier mark stands; a day must not gain minutes because
    // somebody double-tapped.
    const since = new Date(Date.now() - 60 * 1000);
    const recent = await db.attendanceMark.findFirst({
      where: { userId: user.id, kind, at: { gte: since } },
      select: { id: true, at: true },
    });
    if (recent) {
      return NextResponse.json({ ok: true, at: recent.at, duplicate: true });
    }

    const written = await markAttendance({
      companyId,
      userId: user.id,
      kind,
      source: 'MANUAL',
      note: note ?? null,
    });

    return NextResponse.json({ ok: true, at: written.at, kind });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * GET /api/attendance/mark — where today stands for the person asking, so
 * the button can say "استلمت" or "سلّمت" rather than guessing.
 */
/**
 * Whose day is measured by a shift: whoever HAS one entered (D11, PR-13) — or, for the eight jobs below, whoever has not had
 * one entered yet.
 *
 * The chip used to be drawn for these eight role NAMES and nobody else, so a custom role that works shifts never saw it and
 * the owner could not give it to anyone. Now the SHIFT decides: `users.shift` is the key that sets it, and a person with a
 * start time, a hand-over time or rest days on file sees the chip whatever their role is called. The eight names stay as the
 * default for people whose shift has not been entered — dropping them would take the arrival button away from every agent
 * on the day, and the hours it counts are what lateness and the deduction are measured from. The owner's own day is still
 * not measured: no shift on file and not one of these jobs.
 */
const SHIFT_ROLES = [
  'CONFIRMATION_AGENT',
  'CONFIRMATION_SUPERVISOR',
  'MODERATOR',
  'WAREHOUSE',
  'DELIVERY_AGENT',
  'SETTLEMENT_OFFICER',
  'ACCOUNTANT',
  'MANAGER',
];

/**
 * The last thing this person did that their job is counted by.
 *
 * A confirmation agent is counted by what she pulls from the pool; a
 * moderator by what he brings in. Same question, two records, so the chip
 * in the header says the right sentence without the browser knowing any
 * rule about roles.
 */
async function lastOwnAction(role: string, userId: string, companyId: string, storeId: string) {
  if (role === 'MODERATOR') {
    const order = await db.order.findFirst({
      where: { companyId, storeId, moderatorId: userId },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return order ? { at: order.createdAt, label: 'آخر طلب رفعته منذ', empty: 'لم ترفع طلباً بعد' } : null;
  }
  if (role === 'CONFIRMATION_AGENT' || role === 'CONFIRMATION_SUPERVISOR') {
    const claim = await db.orderClaimHistory.findFirst({
      where: { companyId, userId, action: 'CLAIMED', order: { storeId } },
      select: { createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return claim ? { at: claim.createdAt, label: 'آخر طلب سحبته منذ', empty: 'لم تسحب طلباً بعد' } : null;
  }
  return null;
}

export async function GET() {
  try {
    const { user, companyId, storeId, country } = await requireContext();

    // The owner does not clock in. Showing a shift button to the person who
    // sets the shift is noise, and it is the fastest way to teach everybody
    // that the control is decorative.
    if (!SHIFT_ROLES.includes(user.role)) {
      const entered = await db.user.findUnique({
        where: { id: user.id },
        select: { shiftStart: true, shiftEnd: true, restDays: true },
      });
      if (!(entered && (entered.shiftStart || entered.shiftEnd || entered.restDays))) {
        return NextResponse.json({ shift: false });
      }
    }

    // Midnight in the country's own day, not the server's.
    const now = new Date();
    const dayStart = new Date(now.getTime() - 26 * 60 * 60 * 1000);

    const marks = await db.attendanceMark.findMany({
      where: { userId: user.id, at: { gte: dayStart } },
      select: { kind: true, at: true, source: true },
      orderBy: { at: 'asc' },
    });

    const local = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: country.timezone });
    const today = local(now);
    const todays = marks.filter((m) => local(m.at) === today);

    const arrivals = todays.filter((m) => m.kind !== 'CHECK_OUT');
    const departures = todays.filter((m) => m.kind === 'CHECK_OUT');

    const last = await lastOwnAction(user.role, user.id, companyId, storeId);

    return NextResponse.json({
      shift: true,
      arrivedAt: arrivals[0]?.at ?? null,
      leftAt: departures[departures.length - 1]?.at ?? null,
      checkedIn: todays.some((m) => m.kind === 'CHECK_IN'),
      hours: { start: country.workHoursStart, end: country.workHoursEnd },
      // The server's own clock, so a wrong clock on their machine cannot
      // make the counter lie.
      serverNow: new Date().toISOString(),
      lastAction: last,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
