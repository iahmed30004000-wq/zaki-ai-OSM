import { manualAddRefusal, type ManualOrderFacts } from './manual-statement-rules';

/**
 * CAN THE HANDOVER (THE MANUAL STATEMENT) TAKE THIS ORDER AT ALL? — asked of the statement's own rule, never restated.
 *
 * `manualAddRefusal` refuses for two kinds of reason:
 *
 *   about the ORDER ITSELF — it can never enter a manual statement, however long one waits:
 *     · NO_COURIER         no courier named (a statement is a courier's);
 *     · NO_REFERENCE       no merchant reference (the statement line is tied to the order by it, and by nothing else);
 *     · CURRENCY_MISMATCH  the order's currency is not the statement's (the country's);
 *   about its STATE — it may enter later, or was paid already, and the old hand door refuses the same states:
 *     · NOT_DELIVERED · ALREADY_SETTLED;
 *   about the SELECTION, not one order: MIXED_COURIERS.
 *
 * So the order is asked ALONE, with its state set to «delivered, unsettled»: only the first kind can answer. An order the
 * handover cannot take keeps the old hand door («استلمت منه» as on main), so no order is left with no door at all
 * (F9 review, 23/11: a courier's order with no reference was refused by both).
 *
 * Server-only: `manual-statement-rules` imports `node:crypto`. The screens read the answer from the follow-up list (`handover`
 * on each row), never this module.
 */
export const ORDER_ITSELF_REFUSALS = ['NO_COURIER', 'NO_REFERENCE', 'CURRENCY_MISMATCH'] as const;

type Facts = Pick<ManualOrderFacts, 'orderNumber' | 'merchantRef' | 'currency' | 'deliveryProviderId'>;

export function handoverTakes(order: Facts, countryCurrency: string): boolean {
  const why = manualAddRefusal(
    [{ ...order, shippingStatus: 'DELIVERED', settlementStatus: null }],
    countryCurrency
  );
  return !why || !(ORDER_ITSELF_REFUSALS as readonly string[]).includes(why.code);
}
