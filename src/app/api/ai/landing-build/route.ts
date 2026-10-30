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
import { AiNotConfigured, aiChat, describeRoute, type AiImage } from '@/lib/ai-provider';
import { assistantByKey } from '@/lib/ai-assistants';
import { modelReadsImages, visionReasonAr } from '@/lib/ai-vision';
import { parseProposal } from '@/lib/landing-copy-brief';
import { parseCategoryAttributes, parseProductAttributes } from '@/lib/product-attributes';
import { fiveAttributes } from '@/lib/landing-matcher';
import {
  ANSWER_MAX,
  BUILD_QUESTIONS,
  answersRefusal,
  buildNoteAr,
  buildPageBrief,
  readBuildAnswer,
  type BuildAnswers,
} from '@/lib/landing-build';
import { readStoredFile } from '@/lib/storage';

/**
 * POST /api/ai/landing-build — «ابنيلي صفحة الهبوط».
 *
 * The owner picks a product, presses once, and gets a PROPOSAL built from
 * the product page this system already holds: its written specs, its own
 * photograph, and his five answers. `S3-BUILD-MY-LANDING-PAGE.md` in full,
 * and the five rules it is held to are in `landing-build.ts` beside the
 * code that enforces each one.
 *
 * ── THREE THINGS THIS DOOR DOES AND NOTHING ELSE ──
 *
 *   IT WRITES NOTHING. «النتيجة contentDraft لا أكتر… ولا إشي بينشر
 *   لحاله.» So nothing is created here at all: the fields come back, the
 *   owner edits them on the screen, and the page is created — unpublished —
 *   by his own press on the door that already creates pages. The repo-wide
 *   sweep (`ai-proposal-only.test.ts`) holds this for every `/api/ai/*`.
 *
 *   IT SENDS NO NUMBER AND NO PERSON. «الأرقام: المشاهدات والطلبات.
 *   وبيانات الزباين: ولا اسم ولا رقم ولا عنوان.» There is no order and no
 *   customer in this payload — and the owner's own answers are refused
 *   when they carry a long digit run, because a free-text box is where a
 *   phone number gets pasted by habit.
 *
 *   AND IT CHOOSES NO COLOUR. «الألوان بالكود، مش بالموديل»: the palette
 *   is derived from the photograph by `landing-world-colors.ts` in the
 *   browser that is already showing it, and a colour key in the model's
 *   answer is dropped and named.
 *
 * ── THE PHOTOGRAPH, AND WHEN IT IS NOT SENT ──
 *
 * A product photograph is not customer data — S3 says so outright — so it
 * goes to whichever provider the owner chose in O8 rather than being
 * pinned to LOCAL. It is left out, with a line saying why, when the
 * product has none or when the chosen model does not read images
 * (`ai-vision.ts`). Sending it to a text model is worse than not sending
 * it: some of them invent a box, and an invented box text would pass the
 * «من العلبة» check and launder a guess into evidence.
 */

const answerShape = z.string().trim().max(ANSWER_MAX).optional();

const bodySchema = z.object({
  productId: z.string().uuid(),
  answers: z
    .object(Object.fromEntries(BUILD_QUESTIONS.map((q) => [q.key, answerShape])))
    .partial()
    .optional(),
});

/** A picture this big is a label nobody needs more of — and a slow call. */
const MAX_IMAGE_BYTES = 1_500_000;

export async function POST(req: Request) {
  try {
    const { user, companyId, storeId, country } = await requireContext();
    const assistant = assistantByKey('landing_copy')!;
    await requireAssistant(assistant);
    const limited = tooManyAiCalls('landing-build', companyId, user.id, 3);
    if (limited) return limited;

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
    }
    const answers = (parsed.data.answers ?? {}) as BuildAnswers;

    /*
     * THE REFUSAL COMES BEFORE THE PRODUCT READ, NOT AFTER THE MODEL CALL.
     *
     * It is about what would LEAVE, so the only correct place for it is
     * before anything is assembled. A check after the brief is built is a
     * check that can be skipped by a future reordering.
     */
    const refusal = answersRefusal(answers);
    if (refusal) {
      return NextResponse.json({ error: refusal, code: 'ANSWER_REFUSED' }, { status: 400 });
    }

    const product = await db.product.findFirst({
      // This store's product, as the products screen reads it — not any id in the company.
      where: { id: parsed.data.productId, ...inStore(companyId, storeId) },
      select: {
        id: true,
        name: true,
        nameEn: true,
        description: true,
        attributes: true,
        category: { select: { name: true, attributeSchema: true } },
        images: {
          select: { storageKey: true, mimeType: true, isPrimary: true, url: true },
          orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
          take: 1,
        },
      },
    });
    if (!product) {
      return NextResponse.json({ error: 'المنتج غير موجود' }, { status: 404 });
    }

    const fields = parseCategoryAttributes(product.category?.attributeSchema);
    const { byKey } = fiveAttributes(fields, parseProductAttributes(product.attributes, fields));
    const specs = {
      name: product.name,
      nameLatin: product.nameEn,
      description: product.description,
      category: product.category?.name ?? null,
      attributes: byKey,
    };

    const route = await describeRoute(companyId, assistant.promptJob);
    const vision = modelReadsImages(route.provider, route.model);

    /*
     * THE BYTES, ONLY IF ALL THREE ARE TRUE: there is a primary image, the
     * model reads images, and the file is actually there and small enough.
     * Every «no» ends with a sentence on the screen rather than a silent
     * text-only build.
     */
    const stored = product.images[0];
    let image: AiImage | null = null;
    let imageWhy = visionReasonAr(route, { image: Boolean(stored) });
    if (stored && vision) {
      const file = await readStoredFile(stored.storageKey);
      if (!file) {
        imageWhy = 'ما قدرنا نقرا ملف الصورة من التخزين — انبنى من المواصفات المكتوبة وحدها.';
      } else if (file.size > MAX_IMAGE_BYTES) {
        imageWhy = `الصورة أكبر من ${Math.round(MAX_IMAGE_BYTES / 1000)} كيلوبايت — انبنى من المواصفات المكتوبة وحدها.`;
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const mediaType =
          file.mimeType === 'image/png'
            ? 'image/png'
            : file.mimeType === 'image/webp'
              ? 'image/webp'
              : 'image/jpeg';
        image = { mediaType, base64: bytes.toString('base64') };
        imageWhy = null;
      }
    }

    const brief = buildPageBrief({ specs, answers, hasImage: image !== null });

    try {
      const answer = await aiChat({
        companyId,
        job: assistant.promptJob,
        user: brief,
        ...(image ? { images: [image] } : {}),
        // A box's text plus seven fields plus three promises is a long
        // answer, and a model cut off mid-JSON has answered nothing.
        timeoutMs: 60_000,
      });

      const reading = readBuildAnswer(parseProposal(answer), specs);
      if (reading.fields.length === 0) {
        return NextResponse.json(
          {
            error: 'لم يُفهم جواب الذكاء الاصطناعي — أعد المحاولة، أو اكتب الحقول بنفسك.',
            code: 'UNREADABLE',
          },
          { status: 422 }
        );
      }

      return NextResponse.json({
        fields: reading.fields,
        promises: reading.promises,
        packageText: reading.packageText,
        notices: reading.notices,
        missing: reading.missing,
        dropped: reading.dropped,
        notes: buildNoteAr(reading),
        /*
         * WHERE IT WENT AND WHETHER IT COULD SEE — the owner's own
         * sentence. `describeRoute` carries no key, which is why it exists.
         */
        route: { provider: route.provider, model: route.model, readsImages: vision },
        imageWhy,
        /** What the browser derives the colours from. No colour from here. */
        imageUrl: stored?.url ?? null,
        currency: country.currencyCode,
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
