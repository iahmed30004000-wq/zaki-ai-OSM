import { NextResponse } from 'next/server';
import { tooManyAiCalls } from '@/lib/ai-rate';
import { capReachedResponse } from '@/lib/ai-spend';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { inStore } from '@/lib/store-filter';
import { requireAssistant } from '@/lib/require-assistant';
import { apiErrorResponse } from '@/lib/api-error';
import { zodMessage } from '@/lib/zod-message';
import { AiNotConfigured, aiChat } from '@/lib/ai-provider';
import { assistantByKey } from '@/lib/ai-assistants';
import { parseProposal } from '@/lib/landing-copy-brief';
import { parseCategoryAttributes, parseProductAttributes } from '@/lib/product-attributes';
import { activeOffersFor } from '@/lib/offers';
import {
  COUNTED_NOT_RECORDED,
  countedCombinations,
  fiveAttributes,
  matchNoteAr,
  matcherBrief,
  readMatchProposal,
} from '@/lib/landing-matcher';

/**
 * POST /api/ai/landing-match — «اقتراح لكل منتج»: three choices, each with
 * its reason.
 *
 * S3 / O3 · 2c: the `landing_copy` assistant grows `structure ·
 * structureWhy · family · familyWhy` beside `copy`. This is that half; the
 * words are still `/api/ai/landing-copy`, which is asked for the structure
 * THE OWNER picked — because a model that chose the structure and wrote
 * its slots in one answer gives nobody a choice to change.
 *
 * ── IT WRITES NOTHING ──
 *
 * Not the page, not a draft, not a log. `ai-proposal-only.test.ts` sweeps
 * the whole tree for exactly this and allows `/api/ai/*` nothing but the
 * daily summary's own cached answer.
 *
 * ── AND IT IS GIVEN THE SIX THINGS THE BRIEF NAMES ──
 *
 * «name, description, category, category attributes (need · skin · ml ·
 * made · ingredients), basePrice, live offers — nothing else.» No counts:
 * `viewsCount` and `ordersCount` are the shop's own results and they are
 * not parameters of `matcherBrief` at all. No customer, ever — there is no
 * order in this payload to carry one.
 */

const bodySchema = z.object({
  productId: z.string().uuid(),
  /** How many to ask for; three by default, and never more. */
  picks: z.number().int().min(1).max(3).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const assistant = assistantByKey('landing_copy')!;
    await requireAssistant(assistant);
    const limited = tooManyAiCalls('landing-match', companyId, user.id);
    if (limited) return limited;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    /*
     * THE PRODUCT, SCOPED TO THIS COMPANY — and «not found» is the answer
     * for absent and for somebody else's alike, because telling those two
     * apart is the leak.
     */
    const product = await db.product.findFirst({
      // This store's product, as the products screen reads it — not any id in the company.
      where: { id: parsed.data.productId, ...inStore(companyId, storeId) },
      select: {
        id: true,
        name: true,
        description: true,
        basePrice: true,
        attributes: true,
        category: { select: { name: true, attributeSchema: true } },
      },
    });
    if (!product) {
      return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    }

    const fields = parseCategoryAttributes(product.category?.attributeSchema);
    const { labelled } = fiveAttributes(fields, parseProductAttributes(product.attributes, fields));

    /*
     * THE LIVE OFFERS, THROUGH THE ONE FUNCTION THAT KNOWS WHAT «LIVE»
     * MEANS. A date comparison written here would be a second definition of
     * an offer's window, and the storefront's would be the one that counts.
     * Only the three fields the brief names leave this: no ids, no columns.
     */
    const offers = (await activeOffersFor(db, companyId, product.id, country.minorUnit)).map((o) => ({
      name: o.name,
      quantity: o.quantity,
      price: o.price,
    }));

    const brief = matcherBrief({
      name: product.name,
      description: product.description,
      category: product.category?.name ?? null,
      attributes: labelled,
      price: Number(product.basePrice ?? 0),
      currency: country.currencyCode,
      offers,
      picks: parsed.data.picks,
    });

    /*
     * THE COUNTED HALF IS READ BESIDE THE PROPOSAL AND NEVER SENT INTO IT.
     *
     * It is also empty, and says why: the schema records a page's views and
     * orders but not the structure or the family it wore, so a combination
     * cannot be grouped — see `COUNTED_NOT_RECORDED`. The engine is fed the
     * rows it would be fed, which today is none; the floor it enforces is
     * tested against real rows in `the-matcher-proposes-and-says-why`.
     */
    const counted = countedCombinations([]);

    try {
      const answer = await aiChat({
        companyId,
        job: assistant.promptJob,
        user: brief,
        timeoutMs: 45_000,
      });

      const reading = readMatchProposal(parseProposal(answer));
      if (reading.picks.length === 0) {
        return NextResponse.json(
          {
            error: 'لم يُفهم جواب الذكاء الاصطناعي — أعد المحاولة، أو اختر البنية بنفسك.',
            code: 'UNREADABLE',
            dropped: reading.dropped,
          },
          { status: 422 }
        );
      }

      return NextResponse.json({
        picks: reading.picks.map((p) => ({
          structure: p.structure.id,
          structureName: p.structure.name,
          structureWhy: p.structureWhy,
          family: p.family.id,
          familyName: p.family.name,
          familyWhy: p.familyWhy,
        })),
        dropped: reading.dropped,
        note: matchNoteAr(reading),
        counted: counted.ready,
        countedNote: counted.note,
        countedWhy: COUNTED_NOT_RECORDED,
        // What the shop sees of itself, so the owner can check the inputs
        // were the inputs — and nothing else was.
        gave: {
          name: product.name,
          category: product.category?.name ?? null,
          attributes: labelled,
          price: Number(product.basePrice ?? 0),
          offers: offers.length,
        },
      });
    } catch (e) {
      if (e instanceof AiNotConfigured) {
        return NextResponse.json({ error: e.message, code: 'AI_NOT_CONFIGURED' }, { status: 409 });
      }
      // The company is over its daily or monthly ceiling: a sentence, not a 500.
      const capped = capReachedResponse(e);
      if (capped) return capped;
      throw e;
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
