import { SHIPPING_STATUS_AR } from '../shipping-workflow';
import { courierSaidWord } from './courier-said';
import { LOGESTECHS_STATUS, LOGESTECHS_STATUS_AR, LogesTechsAdapter } from './logestechs';
import type { CourierEvent } from './types';

/**
 * WHAT THE COMPANY SAYS, AND THE LINE THE FEED KEEPS OF IT — for the tests that read the company's word back.
 *
 * A hand-keyed line (`{ courierSaid: 'تم التوصيل' }`) skips the real shape: a free-text note next to a status code, the
 * company's code beside OUR state, the eighty-character cut. Two builders here, each made from the real parts:
 *
 *   · `theCompanySends` — the event the REAL LogesTechs adapter makes of a response in the shape their documentation
 *     gives (`{ status, notes }`), so a test can hand it to the real gate (`applyCourierEvent`) and read what the gate
 *     writes;
 *   · `wordLine` — the line the gate writes, built from the writer's own parts (the company's two tables of codes and
 *     `courierSaidWord`, the very function `apply-event` calls), for a test that wants a line without a database.
 *
 * `courier-said-read.test.ts` holds `wordLine` to the real chain for every code, so it cannot drift from what the
 * database really holds. `notes` is what the company wrote in its `notes` field; without it the adapter falls back to the
 * code's own Arabic name (`note: res.notes || LOGESTECHS_STATUS_AR[rawStatus] || null`), and so does `wordLine`.
 */

const ACCOUNT = {
  email: 'a@b.c',
  password: 'x',
  serviceTypeId: 1,
  vehicleTypeId: 0,
  sender: { name: 'صحة بلس', phone: '0790000000', businessName: 'صحة بلس' },
  origin: { addressLine1: 'Main Street', cityId: 36237 },
};

let accounts = 0;

/** The event the real adapter reads out of the company's answer. A new account each time: its own pacing window, so no test waits on the company's two-a-second limit. */
export async function theCompanySends(code: string, notes = '', barcode = 'KSA1'): Promise<CourierEvent> {
  const fetchImpl = (async () => new Response(JSON.stringify({ status: code, cod: 20, cost: 3, notes }), { status: 200 })) as unknown as typeof fetch;
  const adapter = new LogesTechsAdapter({ ...ACCOUNT, companyId: 9000 + ++accounts, fetchImpl });
  const [event] = await adapter.fetchEvents([barcode]);
  return event;
}

export function wordLine(input: { orderId: string; code: string; at: Date; notes?: string | null; id?: string; courier?: string }) {
  const status = LOGESTECHS_STATUS[input.code];
  if (!status) throw new Error(`the company's code ${input.code} is not one the feed keeps as a word`);
  return {
    id: input.id ?? `${input.orderId}@${input.at.getTime()}`,
    orderId: input.orderId,
    newStatus: status as string,
    metadata: JSON.stringify({
      courier: input.courier ?? 'الباشا',
      rawStatus: input.code,
      courierSaid: courierSaidWord(input.notes || LOGESTECHS_STATUS_AR[input.code] || null, SHIPPING_STATUS_AR[status]),
      via: 'POLL',
    }),
    createdAt: input.at,
  };
}
