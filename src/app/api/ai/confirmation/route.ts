import { NextResponse } from 'next/server';
import { tooManyAiCalls } from '@/lib/ai-rate';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requireAssistant } from '@/lib/require-assistant';
import { orderWorkWhere } from '@/lib/rbac';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { AiNotConfigured, aiChat, describeRoute } from '@/lib/ai-provider';
import { customerHistory, customerRisk } from '@/lib/customer-risk';
import { mayReadInsights } from '@/lib/insights-key';
import { assistantByKey } from '@/lib/ai-assistants';
import { deriveCoreState, STATE_LABEL_AR, type StateSource } from '@/lib/order-state';

/**
 * POST /api/ai/confirmation — help with the call that is happening now.
 *
 * It sees ONE order and the history of the person on the phone. Not the
 * queue, not the company's money, not another customer: an agent asking
 * for help with a call has no business being handed the business.
 *
 * And it changes nothing. It drafts a first sentence, names a risk worth
 * knowing, and writes a message to send — the decisions (confirm, reject,
 * postpone, discount, quantity) stay with the person who is accountable
 * for them, which is the one holding the phone.
 */

const schema = z.object({ orderId: z.string().uuid() });

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId } = await requireContext();
    const assistant = assistantByKey('confirmation')!;
    await requireAssistant(assistant);
    const limited = tooManyAiCalls('confirmation', companyId, user.id);
    if (limited) return limited;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    // This store's order. An agent assigned to one store is not shown
    // another's customers by asking for an id.
    //
    // AND ONE THIS PERSON MAY OPEN — the same envelope the order window
    // reads it through. An agent whose orders are «المسندة إليّ» sent the id
    // of an order that had moved to a colleague, and got its customer's
    // history and risk from here while the window answered «not found».
    //
    // The window reads through the WORK door now (order-work-door.ts), so this
    // does too: the order she holds, without «عرض الطلبات» — and still not a
    // colleague's. The payload below is the same either way.
    const order = await db.order.findFirst({
      where: { id: parsed.data.orderId, companyId, storeId, AND: [orderWorkWhere(user)] },
      select: {
        id: true, orderNumber: true, totalAmount: true, currency: true,
        confirmationStatus: true, shippingStatus: true, claimedById: true,
        shippedAt: true, labelPrintedAt: true,
        customerNotes: true,
        // Read only to know whether an address EXISTS (below); its text is never put in the payload.
        deliveryAddress: true,
        customer: { select: { id: true, fullName: true, address: true, city: true } },
        items: { select: { productName: true, quantity: true, freeQuantity: true } },
      },
    });
    if (!order) return NextResponse.json({ error: 'الطلب غير موجود' }, { status: 404 });

    // The return-risk tier is a smart card (PR-10): without `insights.view` it is neither looked up nor handed to the model or
    // back to the screen — absent, not «SAFE».
    const showRisk = mayReadInsights(user);
    const risk = order.customer && showRisk ? await customerRisk(db, companyId, order.customer.id) : null;

    /*
     * The previous orders of THIS PERSON, as facts rather than prose: what
     * happened to each, so a risk the agent should know is visible and a clean
     * history is visibly clean instead of silently absent.
     *
     * Asked of `customerHistory` rather than built here, because the question
     * «which orders are the same person's» is answered by the PHONE — and this
     * route must not select a phone. It sends text to a model, and a test says
     * so. So the one module that already has to read the number answers it,
     * and the number never enters this process.
     */
    const history = order.customer
      ? await customerHistory(db, companyId, order.customer.id, { exceptOrderId: order.id })
      : [];

    /**
     * ── WHERE THIS WOULD GO, BEFORE DECIDING WHAT TO PUT IN IT ──
     *
     * The owner's rule: a customer's name, phone or address reaches a
     * model running on his own machine and no other. This assistant is
     * declared `pii: true` and was sending the name and the seller's
     * free-text notes to whatever vendor the route resolved to.
     *
     * Asking first is what makes the two payloads possible: on the
     * owner's own server the assistant gets everything, because nothing
     * leaves the building; on anybody else's it gets the same facts with
     * the person taken out.
     *
     * NOT a refusal. Refusing would have left the one assistant that
     * reads a customer unusable for every company that has not stood up a
     * local model — which is every company today.
     */
    const route = await describeRoute(companyId, assistant.promptJob);
    const local = route.provider === 'LOCAL';

    const context = {
      order: {
        number: order.orderNumber,
        total: Number(order.totalAmount),
        currency: order.currency,
        // The screen shows the city; the model gets it only on a local route (below).
        city: order.customer?.city ?? null,
        hasCity: !!order.customer?.city?.trim(),
        // The address itself is not sent: what the agent needs to know is
        // whether one is missing, and an address in the payload is customer
        // data travelling for no reason.
        hasAddress: !!(order.deliveryAddress ?? order.customer?.address)?.trim(),
        /*
         * The notes are the seller's own words about this order, and the
         * person is often in them — «البيت جنب مدرسة فلان» is an address
         * written as a sentence. Off the local server the model is told
         * only that there ARE notes, and the agent reads them on screen,
         * where they already are.
         */
        notes: local ? order.customerNotes ?? null : null,
        hasNotes: !!order.customerNotes?.trim(),
        items: order.items.map((i) => ({ name: i.productName, quantity: i.quantity + i.freeQuantity })),
      },
      customer: order.customer
        ? {
            /*
             * The placeholder is filled in by the screen, which is already
             * showing the order it belongs to. So the suggestion reads as
             * a sentence addressed to a person without the person's name
             * ever leaving this machine.
             */
            name: local ? order.customer.fullName : '{الاسم}',
            ...(showRisk
              ? {
                  orders: risk?.orders ?? 0,
                  returns: risk?.returns ?? 0,
                  returnRate: risk?.returnRate ?? 0,
                  tier: risk?.tier ?? 'SAFE',
                  requiresPrepaymentOrApproval: risk?.requiresPrepaymentOrApproval ?? false,
                }
              : {}),
            previous: history.map((h) => ({
              number: h.orderNumber,
              state: STATE_LABEL_AR[deriveCoreState(h as StateSource)],
              total: Number(h.totalAmount),
              at: h.createdAt.toISOString().slice(0, 10),
            })),
          }
        : null,
    };

    /*
     * What the MODEL reads. The city is where the person lives: with the name
     * and the notes it identifies them, so off a local route it is a boolean
     * like the notes. The screen still gets the city in `context` — it is the
     * agent's own browser, already showing the order.
     */
    const forModel = local
      ? context
      : { ...context, order: { ...context.order, city: null } };

    try {
      const suggestion = await aiChat({
        companyId,
        job: assistant.promptJob,
        // The promise this route keeps above: off a local route the name
        // is a placeholder and the notes are a boolean. `aiChat` refuses a
        // `pii: true` assistant on a vendor without it.
        ...(local ? {} : { piiSafe: true as const }),
        user: JSON.stringify(forModel, null, 2),
        timeoutMs: 20_000,
      });
      // The facts go back too: the agent should be able to check the
      // suggestion against them rather than take it on trust.
      return NextResponse.json({ suggestion, context });
    } catch (e) {
      if (e instanceof AiNotConfigured) {
        return NextResponse.json({ suggestion: null, context, error: 'لم يُضبط مزوّد الذكاء بعد.' });
      }
      // The facts are useful on their own; a model that did not answer must
      // not take the customer's history down with it.
      return NextResponse.json({ suggestion: null, context, error: 'تعذّر الوصول إلى المزوّد.' });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
