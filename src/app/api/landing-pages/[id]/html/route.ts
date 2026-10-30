import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireContext } from '@/lib/geo-context';
import { requirePermission } from '@/lib/authorization';
import { apiError } from '@/lib/api-error';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { validateHtmlUpload } from '@/lib/landing-pages';
import { sanitizeLandingHtmlStrict } from '@/lib/landing-html-sanitize';
import { saveContent } from '@/lib/landing-draft';

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { user, companyId, storeId } = await requireContext();
    await requirePermission('landing_pages.edit');
    const { id } = await ctx.params;

    // Rate limit uploads (in-memory, consistent with the rest of the app)
    const rl = rateLimit(`lp_html_upload:${companyId}`, 30, 10 * 60_000);
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `محاولات رفع كثيرة. أعد المحاولة بعد ${rl.retryAfterSec} ثانية` },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } }
      );
    }

    const lp = await db.landingPage.findFirst({ where: { id, companyId, storeId } });
    if (!lp) return NextResponse.json({ error: 'صفحة الهبوط غير موجودة' }, { status: 404 });

    const contentType = req.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return NextResponse.json({ error: 'يجب رفع الملف باستخدام multipart/form-data' }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get('file');
    if (!file || typeof file === 'string') {
      return NextResponse.json({ error: 'ملف HTML مطلوب' }, { status: 400 });
    }

    // Server-side validation — filename & content-type from the client are NOT trusted
    const buffer = Buffer.from(await (file as File).arrayBuffer());
    const check = validateHtmlUpload({
      fileName: (file as File).name || 'index.html',
      size: buffer.length,
      buffer,
    });
    if (!check.valid) return NextResponse.json({ error: check.error }, { status: 400 });

    /*
     * AN UPLOAD IS A SAVE, NOT A PUBLISH — and it is cleaned on the way in.
     *
     * This wrote the file straight into the live column, unsanitised, on a
     * page visitors were reading: a seller picking a file to look at put it
     * in front of every click the advert was paying for, and the stored row
     * carried whatever the file carried (the raw route re-cleans at serve
     * time, but other doors read the row).
     *
     * `saveContent` is the door every other edit goes through: a live page
     * takes the file into its DRAFT and the seller publishes it from the
     * editor with the button that already exists; a page nobody can see yet
     * is written straight, as before.
     *
     * Decision (owner: «اي قرار بعد الان اتخذو دون الرجوع الي»): the
     * safer reading — a draft. No published contract changes: the response
     * keeps its shape and gains one optional field.
     */
    const htmlContent = sanitizeLandingHtmlStrict(buffer.toString('utf8'));
    // Refused is not empty: a file the cleaner gave up on must not be saved as
    // a blank page and reported as done.
    if (htmlContent === null) {
      return NextResponse.json({ error: 'الملف معقّد أكثر من اللازم' }, { status: 400 });
    }
    await saveContent(lp.id, { htmlContent }, lp.isPublished);
    const updated = await db.landingPage.findUniqueOrThrow({
      where: { id: lp.id },
      select: { id: true, name: true, slug: true, isPublished: true, updatedAt: true },
    });

    await logAudit({
      companyId,
      userId: user.id,
      action: 'LANDING_PAGE_HTML_UPLOADED',
      entity: 'LandingPage',
      entityId: lp.id,
      newData: { fileName: (file as File).name, size: buffer.length, into: lp.isPublished ? 'draft' : 'live' },
    });

    // The screen can say «حُفظ كمسودة» from this instead of guessing.
    return NextResponse.json({ success: true, landingPage: updated, hasUnpublished: lp.isPublished });
  } catch (error) {
    const { body, status } = apiError(error);
    return NextResponse.json(body, { status });
  }
}