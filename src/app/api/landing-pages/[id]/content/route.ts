import { NextResponse } from 'next/server';
import { refreshLandingPages } from '@/lib/landing-cache';
import { z } from 'zod';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiErrorResponse } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { MAX_LANDING_HTML_BYTES, clampStoredHtml } from '@/lib/landing-pages';
import {
  sanitizeLandingHtml,
  sanitizeLandingCss,
  parseLandingSettings,
  MAX_LANDING_CSS_BYTES,
} from '@/lib/landing-html-sanitize';
import { landingThemeSchema } from '@/lib/landing-theme';
import { offerEndings } from '@/lib/offers';
import { countdownRefusalIn, landingSectionsSchema, stampManualReviews } from '@/lib/landing-sections';
import { sectionsRefusal } from '@/lib/landing-sections-refusal';
import { draftState, publishContent, revertContent, saveContent, type PageContent } from '@/lib/landing-draft';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * PUT /api/landing-pages/[id]/content — save the editor's work.
 * Server-side sanitization happens BEFORE persistence: the stored artifact
 * itself carries no active content (scripts/handlers/js-URLs are stripped).
 * Only slug/product/publish state is untouched — this endpoint never changes
 * them (publish goes through the existing PATCH route).
 *
 * AND ON A PUBLISHED PAGE IT NOW SAVES A DRAFT, WHICH IT DID NOT.
 *
 * This comment said «draft» from the day it was written and the code wrote
 * the live columns: a seller pressing «حفظ كمسودة» on a live page put a
 * half-finished headline in front of every click the advert was paying for.
 * `saveContent` decides where the write lands — the draft for a live page,
 * the row itself for one with no audience — and nothing else in this file
 * had to know. See src/lib/landing-draft.ts.
 */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('landing_pages.edit');
    const { id } = await ctx.params;

    const rl = rateLimit(`lp_content_save:${companyId}`, 120, 10 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `حفظ متكرر جدًا. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const lp = await db.landingPage.findFirst({ where: { id, companyId, storeId } });
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    const schema = z.object({
      html: z.string().max(MAX_LANDING_HTML_BYTES).optional().nullable(),
      css: z.string().max(MAX_LANDING_CSS_BYTES).optional().nullable(),
      settings: z.unknown().optional().nullable(),
      // The block builder saves through this same endpoint: one place where
      // a page's content is written, one permission, one rate limit.
      builderMode: z.enum(['BLOCKS', 'HTML']).optional(),
      theme: landingThemeSchema.optional().nullable(),
      sections: z.unknown().optional().nullable(),
    });
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'بيانات غير صالحة أو حجم يتجاوز الحد المسموح' }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    // How many transcribed reviews this save attributed, for the audit row.
    let manualReviewsStamped = 0;
    if (parsed.data.html !== undefined) {
      const html = clampStoredHtml(parsed.data.html ?? '');
      if (parsed.data.html && html === null) {
        return NextResponse.json({ error: `حجم HTML يتجاوز الحد المسموح` }, { status: 400 });
      }
      data.htmlContent = html ? sanitizeLandingHtml(html) : (html ?? null);
    }
    if (parsed.data.css !== undefined) {
      const css = parsed.data.css ?? '';
      if (Buffer.byteLength(css, 'utf8') > MAX_LANDING_CSS_BYTES) {
        return NextResponse.json({ error: 'حجم CSS يتجاوز الحد المسموح' }, { status: 400 });
      }
      data.cssContent = css.trim() ? sanitizeLandingCss(css) : null;
    }
    if (parsed.data.settings !== undefined) {
      const settings = parseLandingSettings(parsed.data.settings ?? null);
      data.pageSettings = settings ? JSON.stringify(settings) : null;
    }
    if (parsed.data.builderMode !== undefined) {
      data.builderMode = parsed.data.builderMode;
    }
    if (parsed.data.theme !== undefined) {
      data.theme = parsed.data.theme ? JSON.stringify(parsed.data.theme) : null;
    }
    if (parsed.data.sections !== undefined) {
      // Re-validated here, not trusted from the editor: the public renderer
      // reads these blocks straight out of the row, so the row is the last
      // place a malformed block can be stopped.
      const sections = landingSectionsSchema.safeParse(parsed.data.sections ?? []);
      if (!sections.success) {
        // Which section and which field — not «the page is invalid» over forty sections.
        return NextResponse.json({ error: sectionsRefusal(sections.error, parsed.data.sections) }, { status: 400 });
      }

      /**
       * A COUNTDOWN SET TO «تلقائي» NEEDS A REAL ENDING TO READ.
       *
       * Owner decision D8: the clock and the price read one fact. The
       * fact is `Offer.endsAt`, and it lives on the PRODUCT'S offers —
       * which the schema cannot see, so the rule is enforced here, where
       * the page is written and the product is known.
       *
       * Asked only when an offer-bound countdown is actually present:
       * every other save pays no query for it.
       */
      const wantsOfferClock = sections.data.some(
        (s) => s.type === 'urgency' && s.enabled && s.countdown === 'offer'
      );
      // A page attached to no product has no offer and therefore no ending
      // to read — which the refusal below says, instead of this guessing.
      const endsAt =
        wantsOfferClock && lp.productId
          ? await offerEndings(db, companyId, { productId: lp.productId })
          : [];
      const refusal = countdownRefusalIn(sections.data, { endsAt, now: new Date() });
      if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });

      /*
       * AND A MANUAL REVIEW GETS ITS AUTHOR HERE, NOT IN THE BROWSER.
       *
       * A value the editor sends is a value the person at the editor can
       * choose, and «أضافه المالك» typed by somebody else is worse than no
       * attribution. Only items with no stamp are stamped: whoever fixes a
       * typo in a colleague's transcription is not its source.
       */
      const stamp = stampManualReviews(sections.data, { name: user.name || user.email || '' });
      manualReviewsStamped = stamp.stamped;
      data.sections = stamp.sections.length ? JSON.stringify(stamp.sections) : null;
    }

    // Sanitised above, so what reaches the draft is what would reach a
    // visitor — a draft holding unsanitised markup would make «نشر» the
    // moment the stripping happened, and the editor would be previewing
    // something the published page is not.
    await saveContent(lp.id, data as Partial<PageContent>, lp.isPublished);
    const updated = await db.landingPage.findUniqueOrThrow({
      where: { id: lp.id },
      select: { id: true, name: true, slug: true, isPublished: true, updatedAt: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'LANDING_PAGE_CONTENT_SAVED',
      entity: 'LandingPage',
      entityId: lp.id,
      newData: {
        htmlBytes: parsed.data.html ? Buffer.byteLength(parsed.data.html, 'utf8') : 0,
        cssBytes: parsed.data.css ? Buffer.byteLength(parsed.data.css, 'utf8') : 0,
        // Which of the two this save was, in the log that gets read after
        // somebody asks «من غيّر الصفحة المنشورة؟».
        into: lp.isPublished ? 'draft' : 'live',
        // «Who added this manual review, and when» — the editor's fields
        // carry the answer and this is the row that proves it was stamped
        // by the server rather than typed into the browser.
        manualReviewsStamped,
      },
    });

    return NextResponse.json({
      success: true,
      landingPage: updated,
      // The editor draws «تعديلات غير منشورة» from this rather than guessing
      // from its own dirty flag, which cannot know what the server did.
      hasUnpublished: lp.isPublished,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * POST — put the draft in front of visitors. PATCH — one step back.
 *
 * Three acts on one page's content, on one route, which is how
 * `/api/store/theme` already does it. The verbs cannot be the same ones:
 * PUT was taken by the save years before a draft existed, and renaming it
 * would have been a breaking change to buy a symmetry nobody reads. What
 * the two routes share is the three acts and the column names.
 *
 * BOTH NEED `landing_pages.publish`, NOT `edit`. A visitor feels both of
 * them: one changes the page they are reading, the other changes it back.
 * Saving is the act that touches nobody, and it is the one with the weaker
 * permission.
 */
async function pageFor(id: string) {
  const { user, companyId, storeId } = await requireContext();
  // No fallback to `edit`. The paragraph above says a visitor feels both of
  // these acts; falling back would hand them to everyone who may type in the
  // editor, which is the opposite of what it argues for.
  await requirePermission('landing_pages.publish');
  const lp = await db.landingPage.findFirst({
    where: { id, companyId, storeId },
    select: { id: true, name: true, isPublished: true },
  });
  return { user, companyId, lp };
}

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { user, companyId, lp } = await pageFor(id);
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    const before = await draftState(lp.id);
    if (!before.hasUnpublished) {
      // Not an error worth a 500 and not a success worth a cleared editor:
      // the seller pressed «نشر التعديلات» with nothing to publish, which
      // happens after two tabs.
      return NextResponse.json({ error: 'لا تعديلات غير منشورة', code: 'NOTHING_TO_PUBLISH' }, { status: 409 });
    }

    await publishContent(lp.id);
    // What visitors see just changed: the cached page is rebuilt now, not in a minute.
    await refreshLandingPages({ pageId: lp.id });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'LANDING_PAGE_CONTENT_PUBLISHED',
      entity: 'LandingPage',
      entityId: lp.id,
      newData: { name: lp.name },
    });

    const after = await draftState(lp.id);
    return NextResponse.json({
      success: true,
      hasUnpublished: after.hasUnpublished,
      canRevert: after.canRevert,
      publishedAt: after.publishedAt,
      message: 'نُشرت التعديلات — ويمكنك الرجوع للنسخة السابقة بضغطة.',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function PATCH(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { user, companyId, lp } = await pageFor(id);
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    if (!(await revertContent(lp.id))) {
      return NextResponse.json({ error: 'لا نسخة سابقة لهذه الصفحة', code: 'NO_PREVIOUS' }, { status: 409 });
    }
    await refreshLandingPages({ pageId: lp.id });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'LANDING_PAGE_CONTENT_REVERTED',
      entity: 'LandingPage',
      entityId: lp.id,
      newData: { name: lp.name },
    });

    const after = await draftState(lp.id);
    return NextResponse.json({
      success: true,
      hasUnpublished: after.hasUnpublished,
      // True again, and deliberately: the thing just undone is the next step
      // back, so a seller who reverted by mistake presses again.
      canRevert: after.canRevert,
      publishedAt: after.publishedAt,
      message: 'رجعت الصفحة للنسخة السابقة — والنسخة التي سحبتها صارت خطوةَ الرجوع التالية.',
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
