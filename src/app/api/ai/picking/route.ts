import { NextResponse } from 'next/server';
import { tooManyAiCalls } from '@/lib/ai-rate';
import { AiCapReached } from '@/lib/ai-spend';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requireAssistant } from '@/lib/require-assistant';
import { apiErrorResponse } from '@/lib/api-error';
import { AiNotConfigured, aiChat } from '@/lib/ai-provider';
import { preparationGroups } from '@/lib/operations';
import { assistantByKey } from '@/lib/ai-assistants';
import { pickingPayload } from '@/lib/ai-scope';

/**
 * POST /api/ai/picking — what to pick now, and what is short.
 *
 * It reads the same preparation list the screen reads, through the same
 * function, so the assistant and the screen can never disagree about how
 * many are on the shelf. What it does NOT get is the customer: the payload
 * is built by `pickingPayload`, which keeps the product totals and drops
 * the lines that carry a name and a town.
 *
 * It picks nothing. It reserves nothing. It moves no stock.
 */
export async function POST() {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const assistant = assistantByKey('picking')!;
    await requireAssistant(assistant);
    const limited = tooManyAiCalls('picking', companyId, user.id);
    if (limited) return limited;

    const groups = await preparationGroups(db, { companyId, storeId });
    if (groups.length === 0) {
      return NextResponse.json({ suggestion: null, picklist: [], empty: true });
    }

    const shelf = new Map(
      (
        await db.product.findMany({
          where: { companyId, id: { in: groups.map((g) => g.productId) } },
          select: { id: true, sku: true, category: { select: { name: true } } },
        })
      ).map((p) => [p.id, { sku: p.sku, category: p.category?.name ?? null }])
    );

    const picklist = pickingPayload(groups, shelf);

    try {
      const suggestion = await aiChat({
        companyId,
        job: assistant.promptJob,
        user: JSON.stringify(
          {
            picklist,
            // A shortage does not stop a shipment everywhere: some countries
            // are run with negative stock allowed on purpose, and the answer
            // reads differently in each.
            allowNegativeStock: country.allowNegativeStock,
          },
          null,
          2
        ),
        timeoutMs: 20_000,
      });
      return NextResponse.json({ suggestion, picklist });
    } catch (e) {
      const error =
        e instanceof AiNotConfigured
          ? 'لم يُضبط مزوّد الذكاء بعد.'
          : e instanceof AiCapReached
            ? e.messageAr
            : 'تعذّر الوصول إلى المزوّد.';
      // The picklist stands on its own; a model that did not answer must not
      // take the warehouse's numbers down with it.
      return NextResponse.json({ suggestion: null, picklist, error });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
