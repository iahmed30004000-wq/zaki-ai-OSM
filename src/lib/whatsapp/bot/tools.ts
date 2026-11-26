/**
 * THE BOT'S TOOLS — where a model's proposal is checked in code before anything happens.
 *
 * The model asks; this file decides. Arguments are validated, the order must be the customer's own (the door answers
 * «not found» otherwise), and the two decisions the bot may never guess are gated here, not only by the prompt:
 *
 *   a CONFIRMATION needs the customer's latest message to be a clear yes (`explicitYes`) holding the words the model
 *   quotes (`said`), and a bot message since the last change that stated the order's current amount payable
 *   (`mentionsAmount`) — the customer agreed to a figure they read;
 *   a CHANGE is one of the four the owner allowed, through the door's OMS services.
 *
 * Nothing here talks to a model, and nothing here writes an order itself: the door does.
 */
import { z } from 'zod';
import type { BotDoor, BotOrderView } from './door';
import { STATUS_AR } from './door';
import { explicitYes, said } from './words';

export interface ToolContext {
  door: BotDoor;
  /** Everything the customer wrote this turn (the debounced messages, in order). */
  customerText: string;
  /** The last of them: the one a «yes» must be. */
  lastCustomerText: string;
  /** Whether a bot message since the last change in this chat stated this amount. */
  amountSaid: (amount: number) => Promise<boolean>;
  /** The bot changed an order: what was said before is about the old one. */
  onChanged: () => Promise<void>;
  onHandoff: (reason: string) => Promise<void>;
  /** The owner's practice chat: nothing is real. */
  sandbox?: boolean;
}

export type ToolOut = { data?: unknown; error?: string };

const ORDER = z.string().trim().min(1).max(40);
const SCHEMAS = {
  get_customer_orders: z.object({}).passthrough(),
  get_order_details: z.object({ order_number: ORDER }),
  get_product_information: z.object({ order_number: ORDER }),
  update_customer_details: z.object({
    order_number: ORDER,
    name: z.string().trim().min(2).max(80).optional(),
    city: z.string().trim().min(2).max(60).optional(),
    address: z.string().trim().min(3).max(200).optional(),
    notes: z.string().trim().max(500).optional(),
  }),
  change_order_offer: z.object({ order_number: ORDER, offer_id: z.string().trim().min(1).max(64) }),
  confirm_order: z.object({ order_number: ORDER, customer_words: z.string().trim().min(1).max(1000) }),
  transfer_to_human: z.object({ reason: z.string().trim().min(1).max(300) }),
} as const;

type ToolName = keyof typeof SCHEMAS;

/** The order for the model: its status in words beside the code. */
const forModel = (o: BotOrderView) => ({ ...o, statusAr: STATUS_AR[o.status] ?? o.status });

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOut> {
  const schema = SCHEMAS[name as ToolName];
  if (!schema) return { error: `unknown tool ${name}` };
  const p = schema.safeParse(input);
  if (!p.success) return { error: `invalid input: ${p.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  const v = p.data as Record<string, string | undefined>;
  const { door } = ctx;

  switch (name as ToolName) {
    case 'get_customer_orders': {
      const orders = await door.orders();
      if (orders.length === 0) return { data: { orders: [], note: 'No order on this WhatsApp number. You cannot look up another number; offer transfer_to_human.' } };
      return { data: { orders: orders.map(forModel) } };
    }
    case 'get_order_details': {
      const o = await door.order(v.order_number!);
      return o ? { data: { order: forModel(o) } } : { error: 'No such order for this customer. Use only order numbers from get_customer_orders.' };
    }
    case 'get_product_information': {
      const info = await door.product(v.order_number!);
      return info ? { data: info } : { error: 'No such order for this customer. Use only order numbers from get_customer_orders.' };
    }
    case 'update_customer_details': {
      const change = { name: v.name, city: v.city, address: v.address, notes: v.notes };
      if (!change.name && !change.city && !change.address && change.notes === undefined) return { error: 'Nothing to change: pass at least one field.' };
      const r = await door.amend(v.order_number!, change);
      if (!r.ok) return { error: r.error };
      await ctx.onChanged();
      return { data: { ok: true, order: forModel(r.order), note: 'Tell the customer what changed and the current amount payable on delivery (cod).' } };
    }
    case 'change_order_offer': {
      const r = await door.changeOffer(v.order_number!, v.offer_id!);
      if (!r.ok) return { error: r.error };
      if (!r.already) await ctx.onChanged();
      return { data: { ok: true, already: !!r.already, order: forModel(r.order), note: 'Tell the customer the new offer and the new amount payable on delivery (cod).' } };
    }
    case 'confirm_order': {
      const o = await door.order(v.order_number!);
      if (!o) return { error: 'No such order for this customer. Use only order numbers from get_customer_orders.' };
      if (o.status === 'CONFIRMED') return { data: { ok: true, already: true, order: forModel(o) } };
      // The customer must have read the amount they will pay, as it stands now.
      if (!(await ctx.amountSaid(o.cod))) {
        return { error: 'Not yet: the customer has not been told the current amount payable on delivery since the last change. Summarise the order (items, amount payable on delivery, delivery fee, city and address) and ask for confirmation again.' };
      }
      if (!said(ctx.customerText, v.customer_words!) || !explicitYes(ctx.lastCustomerText)) {
        return { error: "Not confirmed: the customer's latest message is not a clear, unconditional yes to confirming. Ask them plainly whether to confirm the order." };
      }
      const r = await door.confirm(v.order_number!);
      if (!r.ok) return { error: r.error };
      if (r.order.status !== 'CONFIRMED') return { error: 'The order system did not confirm the order. Do not say it is confirmed; tell them a colleague will help.' };
      return { data: { ok: true, already: !!r.already, order: forModel(r.order), note: ctx.sandbox ? 'Practice chat: nothing was written.' : 'Confirmed. Thank the customer and say the team will prepare it for delivery.' } };
    }
    case 'transfer_to_human': {
      await ctx.onHandoff(v.reason!);
      return { data: { ok: true, note: 'A colleague will continue this conversation. Tell the customer that in one short line; you will not answer here again until the team gives the chat back.' } };
    }
  }
  return { error: `unknown tool ${name}` };
}
