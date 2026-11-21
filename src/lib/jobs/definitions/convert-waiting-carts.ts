import type { JobDefinition, JobResult } from '../runner';
import { convertWaitingCarts } from '../../abandoned-cart-orders';
import { closeOrderedCarts } from '../../cart-has-order';

/**
 * «السلات المهجورة» → «الطلبات»: THE CARTS THAT WAITED BECOME ORDERS TOO (the owner, 17/11).
 *
 * A cart with a name and a phone becomes an order the moment the landing door receives it (`upsertLandingCart`). This
 * job is the same step for the carts that did not: those already waiting when this release went out, those sent while a
 * company's switch was off, and a try that was given back because the engine failed before saving anything. The rule,
 * the claim and the engine are `abandoned-cart-orders.ts`; this is the clock.
 *
 * FIRST, since 21/11 (the owner): the NEW carts whose customer already has an order for the same product close themselves
 * as «طلب لحاله», pointing at that order (`cart-has-order.ts`) — in every company, whatever its switch, because that makes
 * no order. So the carts already sitting in the list with «له طلب» stop being rung, and none of them is then tried as an
 * order.
 *
 * Safe by construction: at most twenty carts a run, only companies whose switch is on, only carts seen in the last seven
 * days, and each cart is claimed before its order is made — so a cart the door is converting in the same second, or one
 * already tried, is never made twice. Idempotent: a second run finds nothing it did not already decide.
 */
export const convertWaitingCartsJob: JobDefinition = {
  name: 'convert-waiting-carts',
  // Not 60: the heartbeat watches exactly the 60-second jobs (heartbeat.ts), and a cart that waits five more minutes costs nothing.
  everySeconds: 300,
  description: 'تحويل السلات المهجورة اللي فيها اسم ورقم لطلبات (اللي استنّت قبل التفعيل)',
  async run({ now }): Promise<JobResult> {
    const { closed } = await closeOrderedCarts(now);
    const { converted, skipped } = await convertWaitingCarts(now);
    const said = [
      closed ? `${closed} سلة تسكّرت لأن الزبون عنده طلب` : '',
      converted ? `صارت ${converted} سلة طلبات` : '',
      skipped ? `${skipped} ضلّت سلات (السبب بسجلها)` : '',
    ]
      .filter(Boolean)
      .join('، ');
    return { processed: converted + closed, detail: said || 'لا سلات تستنّى' };
  },
};
