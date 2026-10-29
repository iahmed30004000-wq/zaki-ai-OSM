import { logAudit } from './audit';
import { createNotification } from './notification';
import { BULK_VIEW_RECORDS, BULK_VIEW_WINDOW_MS, noteCustomerAccess } from './pii-access';
import type { SessionUser } from '@/types/auth';

/**
 * THE ONE LINE A HARVEST LEAVES BEHIND.
 *
 * Called only on the crossing (see pii-access.ts), so this writes at most
 * once per person per window. Two things happen, and they are different
 * jobs: the audit row is the RECORD — it outlives the alert, it is
 * append-only at the database, and it is what an investigation reads
 * afterwards. The notification is the ALERT — it is for the people who
 * could act today, and it is allowed to be missed.
 *
 * Told to holders of `users.edit`: whoever can grant and revoke access
 * is who can do something about somebody reading everything, and they are
 * the smallest audience that fits. (It named `users.manage`, a key pruned
 * from the catalog — nobody can be given it, so the alert reached the
 * SUPER_ADMINs alone.) Not `audit.view`, which is a reading
 * permission and would tell people who cannot act.
 *
 * NEVER THROWS, and never blocks the response it is attached to. A person
 * asked to see customers they are allowed to see; failing that request
 * because an alert could not be written would turn a monitoring feature
 * into an outage, and would teach the next person to remove it.
 */
export async function announceBulkCustomerView(input: {
  companyId: string;
  storeId: string | null;
  user: SessionUser;
  records: number;
  /** Which screen the reading came through, for the line a person reads. */
  where: string;
}): Promise<void> {
  const minutes = Math.round(BULK_VIEW_WINDOW_MS / 60_000);
  const message = `${input.user.name || input.user.email} اطّلع على ${input.records} سجلّ عميل خلال ${minutes} دقيقة من ${input.where}`;

  try {
    await logAudit({
      companyId: input.companyId,
      userId: input.user.id,
      action: 'CUSTOMER_BULK_VIEW',
      entity: 'Customer',
      // The event is about a person's reading, not about one customer —
      // and naming a customer here would put a row of the data being
      // protected into the alert about it.
      entityId: input.user.id,
      newData: {
        records: input.records,
        threshold: BULK_VIEW_RECORDS,
        windowMinutes: minutes,
        where: input.where,
        storeId: input.storeId,
      },
    });

    await createNotification({
      companyId: input.companyId,
      storeId: input.storeId,
      // The actor is not told about their own reading: an alert that
      // announces itself to the person it is watching is a tip-off.
      actorId: input.user.id,
      audience: { permission: 'users.edit' },
      title: 'اطّلاعٌ واسعٌ على بيانات العملاء',
      message,
      type: 'SYSTEM_ALERT',
      // `linkFor` drops a link the recipient's own guard would refuse, so
      // someone holding `users.edit` without `audit.view` gets the alert
      // with no link rather than a click into a 403.
      link: '/control/audit',
    });
  } catch (error) {
    console.error('Failed to announce a bulk customer view:', error);
  }
}

/**
 * A ROW THAT CARRIES SOMEBODY'S CONTACT DETAILS, WHATEVER LIST IT CAME FROM.
 *
 * Every shape below is one the routes already return: the customer's own
 * row, an order with its customer attached, or a row that only kept the
 * foreign key.
 */
export interface ContactBearingRow {
  id?: string | null;
  customerId?: string | null;
  customer?: { id?: string | null; phone?: string | null } | null;
  phone?: string | null;
}

/**
 * WHO A ROW IS ABOUT, when the row says. Rows that say nothing cannot be
 * recognised on a second read and are reported separately.
 */
function identityOf(row: ContactBearingRow): string | null {
  return row.customerId ?? row.customer?.id ?? row.customer?.phone ?? row.phone ?? null;
}

/** People, not rows: twenty orders from one customer are one person's details. */
export function distinctCustomers(rows: ReadonlyArray<ContactBearingRow>): number {
  const seen = new Set<string>();
  const { anonymous } = tellApart(rows);
  rows.forEach((row) => {
    const id = identityOf(row);
    if (id !== null) seen.add(id);
  });
  return seen.size + anonymous;
}

/** The people a list names (once each) and how many rows named nobody. */
export function tellApart(rows: ReadonlyArray<ContactBearingRow>): { ids: string[]; anonymous: number } {
  const ids = new Set<string>();
  let anonymous = 0;
  for (const row of rows) {
    const id = identityOf(row);
    if (id === null) anonymous += 1;
    else ids.add(id);
  }
  return { ids: [...ids], anonymous };
}

/**
 * ONE TALLY PER PERSON, WHEREVER THE RECORDS CAME OUT OF.
 *
 * The first version of this counter was keyed `customers:<user id>` and
 * called from the customer list alone. Both halves of that were a hole:
 *
 *   · The orders list hands out the same name, phone and address as the
 *     customer list, plus what the person bought — and up to five hundred
 *     of them in a single request. It counted nothing. So did the labels
 *     list, the returns list, the tracking list, the confirmation queues
 *     and the WhatsApp conversations.
 *   · A key per screen means the alarm is defeated by using two screens.
 *     Four hundred and ninety-nine from one list and four hundred and
 *     ninety-nine from another never crossed anything.
 *
 * The tally is now the person's, and every list that hands out contact
 * details adds to it. `customers-are-counted-once.test.ts` fails if a
 * route selects a customer's phone or address in a list and does not.
 */
export async function noteCustomersHandedOut(input: {
  companyId: string;
  storeId: string | null;
  user: SessionUser;
  /** Which screen the reading came through, for the line a person reads. */
  where: string;
  rows: ReadonlyArray<ContactBearingRow>;
}): Promise<void> {
  const { ids, anonymous } = tellApart(input.rows);
  if (ids.length + anonymous === 0) return;

  // A person read again inside the window is not a new person. The
  // 300-row shipment screen alone reloads after every postponement, and
  // counting it fresh each time pushed an ordinary shift over the line.
  const seen = noteCustomerAccess(`pii:${input.user.id}`, anonymous, { ids });
  if (!seen.crossed) return;

  await announceBulkCustomerView({
    companyId: input.companyId,
    storeId: input.storeId,
    user: input.user,
    records: seen.records,
    where: input.where,
  });
}
