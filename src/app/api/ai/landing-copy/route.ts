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
import { DIALECTS, type Dialect } from '@/lib/landing-structure';
import { LANDING_STRUCTURES } from '@/lib/landing-structures';
import { landingCopyBrief, parseProposal, proposalNoteAr, readProposal } from '@/lib/landing-copy-brief';

/**
 * POST /api/ai/landing-copy — the page's words, proposed.
 *
 * «مولّد صفحة الهبوط بالذكاء الاصطناعيّ». It fills the slots of one of the
 * ten structures and RETURNS them. It writes nothing at all — not the page,
 * not its draft, not a log — because `ai-proposal-only.test.ts` holds «كلّ
 * إجراء ذكاءٍ اصطناعيٍّ اقتراحٌ فقط» as an invariant with a sweep behind it,
 * and because a seller must see the words before a visitor does.
 *
 * The seller saves what comes back through the draft path that already
 * exists, where it lands in `contentDraft` and stays invisible until they
 * press «نشر التعديلات».
 *
 * ── WHAT IT IS GIVEN, AND NOTHING ELSE ──
 *
 * The product's own name, description, price and attributes. The assistant
 * is declared with `scopes: []` and `pii: false`: there is no order in the
 * payload, no customer, no phone, no address, and no money beyond the price
 * that is printed on the page anyway.
 *
 * ── AND THE STRUCTURE IS READ HERE, NOT SENT ──
 *
 * The browser names a structure by id and this looks it up in
 * `LANDING_STRUCTURES`. A caller who could POST a structure could POST its
 * SLOTS — which are the instructions the model follows — and that is a
 * prompt somebody else wrote, running under this shop's key.
 */

const bodySchema = z.object({
  structureId: z.string().trim().min(1).max(60),
  productId: z.string().uuid(),
  dialect: z.enum(DIALECTS).optional(),
});

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const assistant = assistantByKey('landing_copy')!;
    await requireAssistant(assistant);
    const limited = tooManyAiCalls('landing-copy', companyId, user.id);
    if (limited) return limited;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }

    const structure = LANDING_STRUCTURES.find((s) => s.id === parsed.data.structureId);
    if (!structure) {
      return NextResponse.json({ error: 'بنية غير معروفة' }, { status: 404 });
    }

    /*
     * THE PRODUCT, SCOPED TO THIS COMPANY. A product id from another
     * company must not become a brief about that company's product — and
     * «not found» is the same answer for absent and for somebody else's,
     * because telling them apart is the leak.
     */
    const product = await db.product.findFirst({
      // This store's product, as the products screen reads it — not any id in the company.
      where: { id: parsed.data.productId, ...inStore(companyId, storeId) },
      select: { name: true, description: true, basePrice: true, attributes: true },
    });
    if (!product) {
      return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    }

    /*
     * THE SHOP'S ATTRIBUTES, as strings, and only the ones with something
     * in them. `attributes` is free-form JSON the seller fills in; a null
     * or an empty answer in the brief teaches the model that the field is
     * a thing to invent.
     */
    const attributes: Record<string, string> = {};
    const raw = product.attributes;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim() !== '') attributes[k] = v.trim();
        else if (typeof v === 'number' && Number.isFinite(v)) attributes[k] = String(v);
      }
    }

    /*
     * THE DIALECT IS THE CALLER'S, AND LEVANTINE WHEN THEY SAY NOTHING.
     *
     * A structure does not carry one: `DIALECT_LABEL` exists because the
     * SAME structure is written in several dialects — that is the whole
     * «بنية × لهجة» half of the brief — so defaulting to the structure's
     * own would be defaulting to a field it does not have.
     */
    const dialect: Dialect = parsed.data.dialect ?? 'levantine';
    const brief = landingCopyBrief({
      structure,
      dialect,
      product: {
        name: product.name,
        description: product.description,
        price: Number(product.basePrice ?? 0),
        currency: country.currencyCode,
        attributes,
      },
    });

    try {
      const answer = await aiChat({
        companyId,
        job: assistant.promptJob,
        user: brief,
        // Nine to twelve Arabic paragraphs is a longer answer than any other
        // assistant asks for, and a model cut off mid-JSON answers nothing
        // at all rather than answering partly.
        timeoutMs: 60_000,
      });

      const reading = readProposal(structure, parseProposal(answer));
      if (Object.keys(reading.copy).length === 0) {
        return NextResponse.json(
          {
            error: 'لم يُفهم جواب الذكاء الاصطناعي — أعد المحاولة، أو اكتب الخانات بنفسك.',
            code: 'UNREADABLE',
          },
          { status: 422 }
        );
      }

      return NextResponse.json({
        structureId: structure.id,
        dialect,
        copy: reading.copy,
        missing: reading.missing,
        blank: reading.blank,
        unknown: reading.unknown,
        cut: reading.cut,
        note: proposalNoteAr(reading, structure),
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
